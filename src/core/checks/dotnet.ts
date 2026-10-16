import * as fs from 'node:fs';
import * as path from 'node:path';
import { runShell, shellQuote } from '../exec';
import { git, stageFiles, unstagedFiles } from '../git';
import { normalizePath } from '../glob';
import type { Finding, GuardConfig, Stage } from '../types';
import { chunkArgs, commandOutcome } from './commands';
import type { CheckContext, CheckDef, CheckOutcome } from './context';
import { isExcluded } from './context';

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

/** Is this a .NET repository? Root-level solution/project, or any tracked project file. */
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

export interface DotnetTarget {
  /** Repo-relative solution/project path ('' = repo root folder). */
  path: string;
  /** Repo-relative directory the target covers, for filtering --include files. */
  dir: string;
}

/**
 * What to hand to `dotnet build/format/test`:
 *   configured `target` → the single solution at the repo root → the projects owning the staged files.
 */
export async function resolveDotnetTargets(root: string, cfg: GuardConfig, files: string[]): Promise<DotnetTarget[]> {
  const c = cfg.checks.dotnet;
  const toTarget = (p: string): DotnetTarget => ({ path: normalizePath(p), dir: normalizePath(path.dirname(p)) === '.' ? '' : normalizePath(path.dirname(p)) });
  if (c.target) return [toTarget(c.target)];
  const solutions = listDir(root)
    .filter((f) => SOLUTION.test(f))
    .sort();
  if (solutions.length === 1) return [toTarget(solutions[0])];
  if (solutions.length > 1) {
    const named = solutions.find((s) => s.replace(SOLUTION, '').toLowerCase() === path.basename(root).toLowerCase());
    return [toTarget(named ?? solutions[0])];
  }
  const projects = new Set<string>();
  for (const f of files) {
    const p = PROJECT.test(f) ? f : nearestProject(root, f);
    if (p) projects.add(p);
  }
  if (!projects.size) {
    // Nothing staged maps to a project (e.g. "run on all files"): fall back to every tracked project.
    const r = await git(['ls-files', '-z', '--', '*.csproj', '*.vbproj', '*.fsproj'], root);
    for (const p of r.stdout.toString('utf8').split('\0').filter(Boolean)) projects.add(normalizePath(p));
  }
  return [...projects].sort().map(toTarget);
}

const within = (file: string, dir: string) => !dir || file.startsWith(`${dir}/`);

/** CSharpier: configured via a local tool manifest or a .csharpierrc file. Returns the major version family. */
export function detectCsharpier(root: string): { active: boolean; legacy: boolean } {
  let version: string | undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.config', 'dotnet-tools.json'), 'utf8'));
    version = manifest?.tools?.csharpier?.version;
  } catch {
    /* no manifest */
  }
  const configured = listDir(root).some((f) => /^\.csharpierrc(\.(json|ya?ml))?$/.test(f));
  return { active: !!version || configured, legacy: !!version && /^0\./.test(version) };
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
async function runAcrossTargets(rc: RunCtx, jobs: { label: string; args: string }[], okSummary: string): Promise<CheckOutcome> {
  let output = '';
  const findings: Finding[] = [];
  const commands: string[] = [];
  let failure: CheckOutcome | undefined;
  for (const job of jobs) {
    const { outcome, command } = await runDotnet(rc, job.args);
    commands.push(command);
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
const targetArg = (t: DotnetTarget) => (t.path ? ` ${q(t.path)}` : '');

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
      const verify = fix ? '' : ' --verify-no-changes';
      const jobs: { label: string; args: string }[] = [];
      if (mode === 'whitespace') {
        // Whitespace formatting doesn't need MSBuild: format the files directly from the repo root (fast).
        for (const chunk of files.length ? chunkArgs(files) : [[]]) {
          jobs.push({ label: 'whitespace', args: `format whitespace . --folder${verify}${chunk.length ? ` --include ${chunk.map(q).join(' ')}` : ''}` });
        }
      } else {
        const sub = mode === 'all' ? '' : ` ${mode}`;
        for (const t of await resolveDotnetTargets(root, cfg, staged)) {
          const mine = files.filter((f) => within(f, t.dir));
          if (ctx.mode === 'staged' && !mine.length) continue;
          for (const chunk of mine.length ? chunkArgs(mine) : [[]]) {
            jobs.push({ label: t.path, args: `format${sub}${targetArg(t)}${verify}${chunk.length ? ` --include ${chunk.map(q).join(' ')}` : ''}` });
          }
        }
      }
      if (!jobs.length) return { status: 'skipped', summary: 'No .NET project found for the staged files' };
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
      const targets = await resolveDotnetTargets(root, cfg, staged);
      if (!targets.length) return { status: 'skipped', summary: 'No .NET solution or project found' };
      const flags = `-nologo -v q -clp:NoSummary -c ${q(c.build.configuration)}${c.build.warningsAsErrors ? ' -warnaserror' : ''}${
        c.build.extraArgs.length ? ` ${c.build.extraArgs.map(q).join(' ')}` : ''
      }`;
      return runAcrossTargets(
        rc,
        targets.map((t) => ({ label: t.path, args: `build${targetArg(t)} ${flags}` })),
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
      const targets = await resolveDotnetTargets(root, cfg, await stagedDotnetFiles(rc));
      if (!targets.length) return { status: 'skipped', summary: 'No .NET solution or project found' };
      const flags = `--nologo -v q${c.test.filter ? ` --filter ${q(c.test.filter)}` : ''}${c.test.extraArgs.length ? ` ${c.test.extraArgs.map(q).join(' ')}` : ''}`;
      return runAcrossTargets(
        rc,
        targets.map((t) => ({ label: t.path, args: `test${targetArg(t)} ${flags}` })),
        'All tests passed',
      );
    },
  };
}

function csharpierCheck(cfg: GuardConfig, root: string, legacy: boolean): CheckDef {
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
      const toWrite = fix ? staged.filter((f) => !partial.has(f)) : [];
      const toCheck = ctx.mode === 'staged' ? staged.filter((f) => !toWrite.includes(f)) : ['.'];
      const verb = (write: boolean) => (legacy ? (write ? '' : ' --check') : write ? ' format' : ' check');
      const jobs = [
        ...chunkArgs(toWrite).map((ch) => ({ label: 'format', args: `csharpier${verb(true)} ${ch.map(q).join(' ')}` })),
        ...chunkArgs(toCheck).map((ch) => ({ label: 'check', args: `csharpier${verb(false)} ${ch.map(q).join(' ')}` })),
      ];
      const out = await runAcrossTargets(
        rc,
        jobs,
        toWrite.length ? `Formatted & re-staged ${toWrite.length} file(s)` : `${staged.length || 'All'} file(s) formatted`,
      );
      if (fix && out.status === 'passed' && toWrite.length) await stageFiles(root, toWrite);
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
  const csharpier = detectCsharpier(root);
  const csharpierOn = c.csharpier.enabled === true || (c.csharpier.enabled === 'auto' && csharpier.active);
  const defs: CheckDef[] = [];
  if (stage === 'pre-commit') {
    if (c.format.enabled) defs.push(formatCheck(cfg, root, csharpierOn));
    if (csharpierOn) defs.push(csharpierCheck(cfg, root, csharpier.legacy));
    if (c.build.enabled) defs.push(buildCheck(cfg, root));
  }
  if (c.test.enabled && c.test.stage === stage) defs.push(testCheck(cfg, root, stage));
  if (!hasDotnetCli()) {
    // Don't block commits on machines without the SDK — report it instead.
    return defs.map((d) => ({ ...d, run: async () => ({ status: 'skipped' as const, summary: 'dotnet CLI not found on PATH' }) }));
  }
  return defs;
}
