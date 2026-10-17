import * as fs from 'node:fs';
import * as path from 'node:path';
import { runShell, shellQuote } from '../exec';
import { git, stageFiles, unstagedFiles } from '../git';
import { normalizePath } from '../glob';
import type { Finding, GuardConfig, Stage } from '../types';
import { chunkArgs, commandOutcome } from './commands';
import type { CheckContext, CheckDef, CheckOutcome } from './context';
import { isExcluded } from './context';
import { absDir, groupByOwnerDir, readJsonFile, relativeTo, trackedDirsWith } from './workspace';

const SOLUTION = /\.(sln|slnx)$/i;
const PROJECT = /\.(csproj|vbproj|fsproj)$/i;
const FORMATTABLE = /\.(cs|csx|vb)$/i;
const CSHARPIER_FILES = /\.(cs|csx)$/i;

/** Quiet, non-interactive, machine-readable dotnet output. */
const DOTNET_ENV = {
  DOTNET_NOLOGO: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  MSBUILDTERMINALLOGGER: 'off',
};

let dotnetOnPath: boolean | undefined;

/** Look for the `dotnet` executable without spawning it (spawning dotnet can take seconds on first run). */
export function hasDotnetCli(): boolean {
  if (dotnetOnPath !== undefined) return dotnetOnPath;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.env.DOTNET_ROOT) dirs.push(process.env.DOTNET_ROOT);
  dotnetOnPath = dirs.some((d) => exts.some((e) => fs.existsSync(path.join(d, `dotnet${e.toLowerCase()}`)) || fs.existsSync(path.join(d, `dotnet${e}`))));
  return dotnetOnPath;
}

/** Testing hook. */
export function resetDotnetCliCache(): void {
  dotnetOnPath = undefined;
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Is this a .NET repository? Root-level solution/project, or any tracked solution/project file (in any folder). */
export async function isDotnetRepo(root: string): Promise<boolean> {
  if (listDir(root).some((f) => SOLUTION.test(f) || PROJECT.test(f))) return true;
  const r = await git(['ls-files', '-z', '--', '*.sln', '*.slnx', '*.csproj', '*.vbproj', '*.fsproj'], root);
  return r.code === 0 && r.stdout.length > 0;
}

/** Nearest project file above `file` (inside the repo), as a repo-relative path. */
function nearestProject(root: string, file: string): string | undefined {
  let dir = path.dirname(path.join(root, file));
  const top = path.resolve(root);
  for (;;) {
    const proj = listDir(dir)
      .filter((f) => PROJECT.test(f))
      .sort()[0];
    if (proj) return normalizePath(path.relative(root, path.join(dir, proj)));
    if (path.resolve(dir) === top || path.dirname(dir) === dir) return undefined;
    dir = path.dirname(dir);
  }
}

/**
 * Old-style (non-SDK) projects, such as .NET Framework apps and VSIX extensions, need Visual Studio's MSBuild:
 * `dotnet build` / `dotnet format` can't load them reliably. SDK-style projects declare an `Sdk`.
 */
export function isLegacyProject(root: string, rel: string): boolean {
  let xml: string;
  try {
    xml = fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return false;
  }
  if (/<Project[^>]*\sSdk\s*=|<Sdk\s|\sSdk\s*=\s*"[^"]+"/i.test(xml)) return false;
  return /schemas\.microsoft\.com\/developer\/msbuild\/2003|Microsoft\.(CSharp|VisualBasic|FSharp)\.targets/i.test(xml);
}

const solutionText = new Map<string, string>();
function readSolution(abs: string): string {
  let t = solutionText.get(abs);
  if (t === undefined) {
    try {
      t = fs.readFileSync(abs, 'utf8').replace(/\\/g, '/').toLowerCase();
    } catch {
      t = '';
    }
    solutionText.set(abs, t);
  }
  return t;
}

/**
 * The solution that builds a project: walk up from the project's folder to the repo root and take the
 * first folder whose .sln/.slnx references the project. Several candidates in one folder: prefer the
 * one named after the folder, then the first alphabetically. Undefined when no solution includes it.
 */
function owningSolution(root: string, project: string): string | undefined {
  const projAbs = path.join(root, project);
  let dir = path.dirname(projAbs);
  const top = path.resolve(root);
  for (;;) {
    const candidates = listDir(dir)
      .filter((f) => SOLUTION.test(f))
      .sort()
      .filter((sln) => {
        const ref = normalizePath(path.relative(dir, projAbs)).toLowerCase();
        const text = readSolution(path.join(dir, sln));
        // .sln: Project(...) = "Api", "src\\Api\\Api.csproj", … — .slnx: <Project Path="src/Api/Api.csproj" />
        return text.includes(`"${ref}"`) || text.includes(`"./${ref}"`);
      });
    if (candidates.length) {
      const named = candidates.find((sln) => sln.replace(SOLUTION, '').toLowerCase() === path.basename(dir).toLowerCase());
      return normalizePath(path.relative(root, path.join(dir, named ?? candidates[0])));
    }
    if (path.resolve(dir) === top || path.dirname(dir) === dir) return undefined;
    dir = path.dirname(dir);
  }
}

export interface DotnetTarget {
  /** Repo-relative solution/project path ('' = repo root folder). */
  path: string;
  /** Repo-relative directory of the target ('' = root). dotnet runs here, so a nested global.json / tool manifest applies. */
  dir: string;
  /** The staged files this target covers (repo-relative). */
  files: string[];
}

/**
 * What to hand to `dotnet build/format/test`:
 *   configured `target` → the single solution at the repo root → for each staged file, the solution
 *   (in its folder or any parent) that includes its project, else the project itself.
 * Works for monorepos where the .sln/.csproj live in sub-folders (e.g. `backend/Api.sln`).
 */
export async function resolveDotnetTargets(root: string, cfg: GuardConfig, files: string[], skippedLegacy: string[] = []): Promise<DotnetTarget[]> {
  solutionText.clear();
  const c = cfg.checks.dotnet;
  const dirOf = (p: string) => {
    const d = normalizePath(path.dirname(normalizePath(p)));
    return d === '.' ? '' : d;
  };
  const whole = (p: string): DotnetTarget => {
    const dir = dirOf(p);
    return { path: normalizePath(p), dir, files: files.filter((f) => !dir || f.startsWith(`${dir}/`)) };
  };
  if (c.target) return [whole(c.target)];
  const solutions = listDir(root)
    .filter((f) => SOLUTION.test(f))
    .sort();
  if (solutions.length === 1) return [{ ...whole(solutions[0]), files: [...files] }];
  if (solutions.length > 1) {
    const named = solutions.find((s) => s.replace(SOLUTION, '').toLowerCase() === path.basename(root).toLowerCase());
    return [{ ...whole(named ?? solutions[0]), files: [...files] }];
  }
  const targets = new Map<string, string[]>();
  const projectTarget = new Map<string, string>();
  const targetFor = (project: string) => {
    let t = projectTarget.get(project);
    if (t === undefined) {
      t = owningSolution(root, project) ?? project;
      projectTarget.set(project, t);
    }
    return t;
  };
  for (const f of files) {
    const p = PROJECT.test(f) ? f : SOLUTION.test(f) ? undefined : nearestProject(root, f);
    const t = SOLUTION.test(f) ? normalizePath(f) : p ? targetFor(p) : undefined;
    if (!t) continue;
    const list = targets.get(t) ?? [];
    list.push(f);
    targets.set(t, list);
  }
  if (!targets.size) {
    // Nothing staged maps to a project (e.g. "run on all files"): fall back to every tracked project.
    const r = await git(['ls-files', '-z', '--', '*.csproj', '*.vbproj', '*.fsproj'], root);
    for (const p of r.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const t = targetFor(normalizePath(p));
      if (!targets.has(t)) targets.set(t, []);
    }
  }
  const result: DotnetTarget[] = [];
  for (const [p, fs] of [...targets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (PROJECT.test(p) && isLegacyProject(root, p)) skippedLegacy.push(p);
    else result.push({ path: p, dir: dirOf(p), files: fs });
  }
  return result;
}

/** Summary for a run where every project was old-style. */
const legacySummary = (skipped: string[]) =>
  `Skipped ${skipped.map((p) => path.basename(p)).join(', ')}: old-style (non-SDK) project${skipped.length === 1 ? '' : 's'} need Visual Studio's MSBuild`;

const CSHARPIER_RC = /^\.csharpierrc(\.(json|ya?ml))?$/;

/** CSharpier in one folder: a local tool manifest (.config/dotnet-tools.json) listing it, or a .csharpierrc file. */
export function detectCsharpier(dir: string): { active: boolean; legacy: boolean } {
  const tools = readJsonFile(path.join(dir, '.config', 'dotnet-tools.json'))?.tools as Record<string, { version?: string }> | undefined;
  const version = tools?.csharpier?.version;
  const configured = listDir(dir).some((f) => CSHARPIER_RC.test(f));
  return { active: !!version || configured, legacy: !!version && /^0\./.test(version) };
}

/** Repo-relative folders where CSharpier is set up (root and/or sub-folders of a monorepo). */
export async function csharpierDirs(root: string): Promise<string[]> {
  const dirs = new Set<string>();
  if (detectCsharpier(root).active) dirs.add('');
  for (const d of await trackedDirsWith(
    root,
    (base, rel) => CSHARPIER_RC.test(base) || (base === 'dotnet-tools.json' && /(^|\/)\.config\/dotnet-tools\.json$/.test(rel)),
  )) {
    const owner = d.endsWith('.config') ? d.slice(0, -'.config'.length).replace(/\/$/, '') : d;
    if (detectCsharpier(absDir(root, owner)).active) dirs.add(owner);
  }
  return [...dirs].sort();
}

/** Legacy (0.x) CSharpier is invoked differently: use the version from the nearest tool manifest. */
function csharpierLegacyAt(root: string, dir: string): boolean {
  let rel = dir;
  for (;;) {
    const tools = readJsonFile(path.join(absDir(root, rel), '.config', 'dotnet-tools.json'))?.tools as Record<string, { version?: string }> | undefined;
    const v = tools?.csharpier?.version;
    if (v) return /^0\./.test(v);
    if (!rel) return false;
    const up = path.posix.dirname(rel);
    rel = up === '.' ? '' : up;
  }
}

interface RunCtx {
  ctx: CheckContext;
  cfg: GuardConfig;
  root: string;
}

async function stagedDotnetFiles({ ctx, cfg }: RunCtx): Promise<string[]> {
  const exts = cfg.checks.dotnet.fileExtensions.map((e) => e.toLowerCase());
  const files = ctx.stage === 'pre-push' ? await ctx.pushFiles() : (await ctx.fileSet()).files;
  return files.filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)) && !isExcluded(ctx, f, cfg.checks.dotnet.exclude));
}

async function runDotnet(rc: RunCtx, args: string, cwd = rc.root): Promise<{ outcome: CheckOutcome; command: string }> {
  const command = `dotnet ${args}`;
  const timeout = rc.cfg.checks.dotnet.timeoutSec;
  const res = await runShell(command, { cwd, timeoutMs: timeout * 1000, signal: rc.ctx.signal, env: DOTNET_ENV });
  return { outcome: commandOutcome(res, command, cwd, rc.root, timeout), command };
}

/** Run one command per target (and per batch of files), merging the results into one outcome. */
interface DotnetJob {
  label: string;
  args: string;
  /** Repo-relative folder to run in ('' = root). */
  dir?: string;
}

async function runAcrossTargets(rc: RunCtx, jobs: DotnetJob[], okSummary: string): Promise<CheckOutcome> {
  let output = '';
  const findings: Finding[] = [];
  const commands: string[] = [];
  let failure: CheckOutcome | undefined;
  for (const job of jobs) {
    const { outcome, command } = await runDotnet(rc, job.args, absDir(rc.root, job.dir ?? ''));
    commands.push(job.dir ? `(cd ${job.dir} && ${command})` : command);
    output += `${jobs.length > 1 ? `── ${job.label}\n` : ''}${outcome.output ?? ''}\n`;
    if (outcome.status !== 'passed') {
      findings.push(...(outcome.findings ?? []));
      failure ??= outcome;
      if (outcome.status === 'skipped') break; // cancelled
    }
  }
  const command = commands.length > 1 ? `${commands[0]} (+${commands.length - 1} more)` : commands[0];
  if (!failure) return { status: 'passed', summary: okSummary, command, output, findings: [] };
  return {
    ...failure,
    command,
    output,
    findings,
    summary: findings.length ? `${findings.length} problem${findings.length === 1 ? '' : 's'} reported` : failure.summary,
  };
}

const q = (s: string) => shellQuote(s);
/** The target as seen from its own folder (dotnet runs there). */
const targetArg = (t: DotnetTarget) => (t.path ? ` ${q(relativeTo(t.dir, t.path))}` : '');

function formatCheck(cfg: GuardConfig, root: string, csharpier: boolean): CheckDef {
  const c = cfg.checks.dotnet;
  const mode = c.format.mode === 'auto' ? (csharpier ? 'style' : 'all') : c.format.mode;
  return {
    id: 'dotnet:format',
    name: `dotnet format${mode === 'all' ? '' : ` (${mode})`}`,
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'command',
    run: async (ctx) => {
      const rc = { ctx, cfg, root };
      const staged = (await stagedDotnetFiles(rc)).filter((f) => FORMATTABLE.test(f));
      if (!staged.length && ctx.mode === 'staged') return { status: 'skipped', summary: 'No staged C#/VB files' };
      const fix = c.format.applyFixes && ctx.mode === 'staged';
      const partial = fix ? new Set(await unstagedFiles(root)) : new Set<string>();
      const files = ctx.mode === 'staged' ? staged.filter((f) => !fix || !partial.has(f)) : [];
      const skipped: string[] = [];
      const verify = fix ? '' : ' --verify-no-changes';
      const jobs: DotnetJob[] = [];
      if (mode === 'whitespace') {
        // Whitespace formatting doesn't need MSBuild: format the files directly from the repo root (fast).
        for (const chunk of files.length ? chunkArgs(files) : [[]]) {
          jobs.push({ label: 'whitespace', args: `format whitespace . --folder${verify}${chunk.length ? ` --include ${chunk.map(q).join(' ')}` : ''}` });
        }
      } else {
        const sub = mode === 'all' ? '' : ` ${mode}`;
        const toFormat = new Set(files);
        for (const t of await resolveDotnetTargets(root, cfg, staged, skipped)) {
          const mine = t.files.filter((f) => toFormat.has(f));
          if (ctx.mode === 'staged' && !mine.length) continue;
          // --include paths are relative to the folder dotnet runs in (the target's folder).
          for (const chunk of mine.length ? chunkArgs(mine.map((f) => relativeTo(t.dir, f))) : [[]]) {
            jobs.push({
              label: t.path,
              dir: t.dir,
              args: `format${sub}${targetArg(t)} --no-restore${verify}${chunk.length ? ` --include ${chunk.map(q).join(' ')}` : ''}`,
            });
          }
        }
      }
      if (!jobs.length) return { status: 'skipped', summary: skipped.length ? legacySummary(skipped) : 'No .NET project found for the staged files' };
      const out = await runAcrossTargets(rc, jobs, fix ? `Formatted ${files.length} file(s)` : `${files.length || 'All'} file(s) formatted correctly`);
      if (fix && out.status === 'passed' && files.length) await stageFiles(root, files);
      if (out.status === 'failed' && !fix) out.summary = `${out.summary} — run "dotnet format" to fix`;
      return out;
    },
  };
}

function buildCheck(cfg: GuardConfig, root: string): CheckDef {
  const c = cfg.checks.dotnet;
  return {
    id: 'dotnet:build',
    name: 'dotnet build',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'command',
    run: async (ctx) => {
      const rc = { ctx, cfg, root };
      const staged = await stagedDotnetFiles(rc);
      if (!staged.length && ctx.mode === 'staged') return { status: 'skipped', summary: 'No staged .NET files' };
      const skipped: string[] = [];
      const targets = await resolveDotnetTargets(root, cfg, staged, skipped);
      if (!targets.length) return { status: 'skipped', summary: skipped.length ? legacySummary(skipped) : 'No .NET solution or project found' };
      const flags = `--no-restore -nologo -v q -clp:NoSummary -c ${q(c.build.configuration)}${c.build.warningsAsErrors ? ' -warnaserror' : ''}${
        c.build.extraArgs.length ? ` ${c.build.extraArgs.map(q).join(' ')}` : ''
      }`;
      return runAcrossTargets(
        rc,
        targets.map((t) => ({ label: t.path, dir: t.dir, args: `build${targetArg(t)} ${flags}` })),
        `Built ${targets.map((t) => path.basename(t.path) || 'repo').join(', ')}`,
      );
    },
  };
}

function testCheck(cfg: GuardConfig, root: string, stage: Stage): CheckDef {
  const c = cfg.checks.dotnet;
  return {
    id: 'dotnet:test',
    name: 'dotnet test',
    stage,
    severity: c.severity,
    kind: 'command',
    run: async (ctx) => {
      const rc = { ctx, cfg, root };
      const skipped: string[] = [];
      const targets = await resolveDotnetTargets(root, cfg, await stagedDotnetFiles(rc), skipped);
      if (!targets.length) return { status: 'skipped', summary: skipped.length ? legacySummary(skipped) : 'No .NET solution or project found' };
      const flags = `--nologo -v q${c.test.filter ? ` --filter ${q(c.test.filter)}` : ''}${c.test.extraArgs.length ? ` ${c.test.extraArgs.map(q).join(' ')}` : ''}`;
      return runAcrossTargets(
        rc,
        targets.map((t) => ({ label: t.path, dir: t.dir, args: `test${targetArg(t)} ${flags}` })),
        'All tests passed',
      );
    },
  };
}

function csharpierCheck(cfg: GuardConfig, root: string, dirs: string[]): CheckDef {
  const c = cfg.checks.dotnet;
  return {
    id: 'dotnet:csharpier',
    name: c.csharpier.applyFixes ? 'CSharpier (format)' : 'CSharpier',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'command',
    run: async (ctx) => {
      const rc = { ctx, cfg, root };
      const staged = (await stagedDotnetFiles(rc)).filter((f) => CSHARPIER_FILES.test(f));
      if (!staged.length && ctx.mode === 'staged') return { status: 'skipped', summary: 'No staged C# files' };
      const fix = c.csharpier.applyFixes && ctx.mode === 'staged';
      const partial = fix ? new Set(await unstagedFiles(root)) : new Set<string>();
      const toWrite = new Set(fix ? staged.filter((f) => !partial.has(f)) : []);
      // Run from the folder CSharpier is set up in (its tool manifest is resolved from there).
      // Files outside every such folder are run from the root.
      const owners = new Set(dirs);
      const groups =
        ctx.mode === 'staged'
          ? groupByOwnerDir(root, staged, (_abs, rel) => !rel || owners.has(rel))
          : new Map((dirs.length ? dirs : ['']).map((d) => [d, [] as string[]]));
      const verb = (legacy: boolean, write: boolean) => (legacy ? (write ? '' : ' --check') : write ? ' format' : ' check');
      const jobs: DotnetJob[] = [];
      for (const [dir, list] of groups) {
        const legacy = csharpierLegacyAt(root, dir);
        const rel = (fs: string[]) => fs.map((f) => relativeTo(dir, f));
        const write = list.filter((f) => toWrite.has(f));
        const check = ctx.mode === 'staged' ? list.filter((f) => !toWrite.has(f)) : [];
        for (const ch of chunkArgs(rel(write)))
          jobs.push({ label: `${dir || '(root)'} format`, dir, args: `csharpier${verb(legacy, true)} ${ch.map(q).join(' ')}` });
        for (const ch of ctx.mode === 'staged' ? chunkArgs(rel(check)) : [['.']])
          jobs.push({ label: `${dir || '(root)'} check`, dir, args: `csharpier${verb(legacy, false)} ${ch.map(q).join(' ')}` });
      }
      const out = await runAcrossTargets(
        rc,
        jobs,
        toWrite.size ? `Formatted & re-staged ${toWrite.size} file(s)` : `${staged.length || 'All'} file(s) formatted`,
      );
      if (fix && out.status === 'passed' && toWrite.size) await stageFiles(root, [...toWrite]);
      if (out.status === 'failed' && /dotnet tool restore|could not execute|not found/i.test(out.output ?? '')) {
        out.summary = 'CSharpier is not installed — run "dotnet tool restore"';
      }
      return out;
    },
  };
}

/** All .NET checks for a stage. Skips silently when the repo isn't a .NET repo (in `auto` mode). */
export async function dotnetChecks(cfg: GuardConfig, root: string, stage: Stage): Promise<CheckDef[]> {
  const c = cfg.checks.dotnet;
  if (c.enabled === false) return [];
  if (c.enabled === 'auto' && !(await isDotnetRepo(root))) return [];
  const csDirs = c.csharpier.enabled === false ? [] : await csharpierDirs(root);
  const csharpierOn = c.csharpier.enabled === true || (c.csharpier.enabled === 'auto' && csDirs.length > 0);
  const defs: CheckDef[] = [];
  if (stage === 'pre-commit') {
    if (c.format.enabled) defs.push(formatCheck(cfg, root, csharpierOn));
    if (csharpierOn) defs.push(csharpierCheck(cfg, root, csDirs));
    if (c.build.enabled) defs.push(buildCheck(cfg, root));
  }
  if (c.test.enabled && c.test.stage === stage) defs.push(testCheck(cfg, root, stage));
  if (!hasDotnetCli()) {
    // Don't block commits on machines without the SDK — report it instead.
    return defs.map((d) => ({ ...d, run: async () => ({ status: 'skipped' as const, summary: 'dotnet CLI not found on PATH' }) }));
  }
  return defs;
}
