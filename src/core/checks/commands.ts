import * as fs from 'node:fs';
import * as path from 'node:path';
import { runShell, shellQuote } from '../exec';
import { stageFiles, unstagedFiles } from '../git';
import { matchesAny, normalizePath } from '../glob';
import type { CustomCheck, Finding, GuardConfig, PackageManager, Severity, Stage } from '../types';
import { type CheckDef, type CheckOutcome, isExcluded } from './context';
import { absDir, findOwnerDir, groupByOwnerDir, hasDependency, readPackageJson, relativeTo, trackedDirsWith } from './workspace';

// ---------------------------------------------------------------- package manager

export function detectPackageManager(dir: string, root: string, preferred: PackageManager): Exclude<PackageManager, 'auto'> {
  if (preferred !== 'auto') return preferred;
  let d = path.resolve(dir);
  const top = path.resolve(root);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
      if (['npm', 'yarn', 'pnpm', 'bun'].includes(pm)) return pm;
    } catch {
      /* no package.json here */
    }
    if (fs.existsSync(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(d, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(d, 'bun.lockb')) || fs.existsSync(path.join(d, 'bun.lock'))) return 'bun';
    if (fs.existsSync(path.join(d, 'package-lock.json'))) return 'npm';
    if (d === top || path.dirname(d) === d) return 'npm';
    d = path.dirname(d);
  }
}

export function runScriptCommand(pm: Exclude<PackageManager, 'auto'>, script: string, args: string[]): string {
  const extra = args.length ? ' ' + args.map(shellQuote).join(' ') : '';
  if (pm === 'npm') return `npm run --silent ${shellQuote(script)}${extra ? ' --' + extra : ''}`;
  return `${pm} run ${shellQuote(script)}${extra}`;
}

function execBin(pm: Exclude<PackageManager, 'auto'>, bin: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm exec ${bin}`;
    case 'yarn':
      return `yarn ${bin}`;
    case 'bun':
      return `bunx ${bin}`;
    default:
      return `npx --no-install ${bin}`;
  }
}

// ---------------------------------------------------------------- output parsing

/** Extract file/line findings from common tool output formats (tsc, eslint stylish/unix, gcc-style). */
export function parseToolOutput(output: string, cwd: string, root: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const exists = new Map<string, boolean>();
  const rel = (file: string): string | undefined => {
    const abs = path.resolve(cwd, file.trim());
    let ok = exists.get(abs);
    if (ok === undefined) {
      ok = fs.existsSync(abs);
      exists.set(abs, ok);
    }
    if (!ok) return undefined;
    const r = normalizePath(path.relative(root, abs));
    return r.startsWith('..') ? undefined : r;
  };
  const add = (f: Finding) => {
    const key = `${f.file}:${f.line}:${f.column}:${f.message}`;
    if (!seen.has(key) && findings.length < 500) {
      seen.add(key);
      findings.push(f);
    }
  };
  let stylishFile: string | undefined;
  let pendingBiome: Finding | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    // Prettier --check: "[warn] src/a.ts" (unformatted) and "[error] src/a.ts: SyntaxError: … (1:5)"
    if ((m = /^\[(warn|error)\] (.+?)(?:: (.*?)(?: \((\d+):(\d+)\))?)?$/.exec(line))) {
      const file = rel(m[2]);
      if (file) {
        add(
          m[1] === 'warn' && !m[3]
            ? { file, line: 1, rule: 'prettier', message: 'File is not formatted with Prettier (run prettier --write)' }
            : { file, line: m[4] ? +m[4] : 1, column: m[5] ? +m[5] : undefined, rule: 'syntax', message: m[3] ?? 'Prettier error' },
        );
        continue;
      }
    }
    // CSharpier: "Error ./src/A.cs - Was not formatted." (1.x prints the same shape for check failures)
    if ((m = /^(?:Error|Warning)\s+(.+?\.(?:cs|csx))\s+-\s+(.*)$/.exec(line))) {
      const file = rel(m[1]);
      if (file) {
        add({ file, line: 1, rule: 'csharpier', message: m[2] || 'Not formatted with CSharpier' });
        continue;
      }
    }
    // tsc and MSBuild/dotnet: "src/a.ts(3,5): error TS2322: …", "C:\x\A.cs(12,7,12,9): error CS0103: … [C:\x\A.csproj]"
    if ((m = /^\s*(?:\d+>)?(.+?)\((\d+),(\d+)(?:,\d+,\d+)?\): (error|warning) ([A-Za-z]+\d+|[A-Z_]+): (.*?)(?: \[[^\]]+\])?$/.exec(line))) {
      const file = rel(m[1]);
      if (file) add({ file, line: +m[2], column: +m[3], rule: m[5], message: m[6] });
      continue;
    }
    if (pendingBiome && (m = /^\s+[×!iℹ✖]\s+(.+)$/.exec(line))) {
      pendingBiome.message = m[1];
      pendingBiome = undefined;
      continue;
    }
    if ((m = /^((?:[A-Za-z]:)?[^:\s][^:]*?):(\d+):(\d+):?\s*(?:-\s*)?(.*)$/.exec(line))) {
      const file = rel(m[1]);
      if (file) {
        // Biome: "src/a.ts:1:7 lint/style/useConst  FIXABLE  ━━━━" — the message is on a following "  × …" line.
        const biome = /^([\w/]+)\s.*━/.exec(m[4]);
        const f: Finding = biome
          ? { file, line: +m[2], column: +m[3], rule: biome[1], message: biome[1] }
          : { file, line: +m[2], column: +m[3], message: m[4] || 'Problem reported' };
        add(f);
        pendingBiome = biome ? f : undefined;
        continue;
      }
    }
    if ((m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([@\w/-]+))?$/.exec(line)) && stylishFile) {
      add({ file: stylishFile, line: +m[1], column: +m[2], rule: m[5], message: m[4] });
      continue;
    }
    if (line && !/^\s/.test(line) && !line.includes(' ')) {
      const file = rel(line);
      stylishFile = file;
    } else if (!line) stylishFile = undefined;
  }
  return findings;
}

export function commandOutcome(res: Awaited<ReturnType<typeof runShell>>, command: string, cwd: string, root: string, timeoutSec: number): CheckOutcome {
  const findings = parseToolOutput(res.output, cwd, root);
  if (res.cancelled) return { status: 'skipped', summary: 'Cancelled', command, output: res.output };
  if (res.timedOut) return { status: 'error', summary: `Timed out after ${timeoutSec}s`, command, output: res.output, findings };
  if (res.code === 0) return { status: 'passed', summary: `Passed in ${(res.durationMs / 1000).toFixed(1)}s`, command, output: res.output, findings: [] };
  const lastLine =
    res.output
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-1)[0] ?? '';
  return {
    status: res.code === 127 && /not found|not recognized/i.test(res.output) ? 'error' : 'failed',
    summary: findings.length
      ? `${findings.length} problem${findings.length === 1 ? '' : 's'} reported`
      : `Exited with code ${res.code}${lastLine ? `: ${lastLine.slice(0, 120)}` : ''}`,
    command,
    output: res.output,
    findings,
  };
}

// ---------------------------------------------------------------- monorepo tool folders

/**
 * Where a tool is set up. In a monorepo the repo root often has no package.json / tool config at all;
 * each tool is then run from the folder that owns the staged file (nearest folder with the config or
 * the dependency), so its own config, node_modules and package manager are used.
 */
interface ToolSpec {
  /** Basenames worth looking at when scanning tracked files. */
  candidates: string[];
  /** Is this (absolute) folder set up for the tool? */
  isDir: (abs: string) => boolean;
}

/** Repo-relative folders ('' = root) set up for the tool, root first. */
async function toolDirs(root: string, spec: ToolSpec): Promise<string[]> {
  const dirs = new Set(await trackedDirsWith(root, (base) => spec.candidates.includes(base)));
  dirs.add('');
  return [...dirs].filter((d) => spec.isDir(absDir(root, d))).sort();
}

const exists = (dir: string, files: string[]) => files.some((f) => fs.existsSync(path.join(dir, f)));

// ---------------------------------------------------------------- package.json scripts

function readScripts(dir: string): Record<string, string> {
  const scripts = readPackageJson(dir)?.scripts;
  return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : {};
}

function nearestPackageDir(root: string, file: string): string | undefined {
  const rel = findOwnerDir(root, file, (abs) => fs.existsSync(path.join(abs, 'package.json')));
  return rel === undefined ? undefined : absDir(root, rel);
}

/**
 * `root` scope only makes sense when the root package.json has one of the configured scripts. When it
 * doesn't (no root package.json, or a workspace root without lint/typecheck scripts), fall back to the
 * packages that own the staged files.
 */
export function effectiveNpmScope(cfg: GuardConfig, root: string): 'root' | 'affected' {
  const c = cfg.checks.npmScripts;
  if (c.scope === 'affected') return 'affected';
  const scripts = readScripts(root);
  return c.scripts.some((s) => scripts[s]) ? 'root' : 'affected';
}

/** Build one check per matching script, per package directory. */
export async function npmScriptChecks(cfg: GuardConfig, root: string, stage: Stage, getFiles: () => Promise<string[]>): Promise<CheckDef[]> {
  const c = cfg.checks.npmScripts;
  if (!c.enabled || c.stage !== stage) return [];
  const hasScript = (dir: string) => {
    const s = readScripts(dir);
    return c.scripts.some((n) => s[n]);
  };
  let dirs: string[] = [];
  if (effectiveNpmScope(cfg, root) === 'root') dirs = [root];
  else if (stage === 'pre-commit') {
    const set = new Set<string>();
    for (const f of await getFiles()) {
      const d = nearestPackageDir(root, f);
      if (d) set.add(d);
    }
    dirs = [...set].sort();
  } else {
    // pre-push / commit-msg: no staged files to go by — every package that has one of the scripts.
    dirs = (await trackedDirsWith(root, (base) => base === 'package.json')).map((d) => absDir(root, d)).filter(hasScript);
  }

  const defs: CheckDef[] = [];
  for (const dir of dirs) {
    const scripts = readScripts(dir);
    const relDir = normalizePath(path.relative(root, dir));
    for (const script of c.scripts) {
      if (!scripts[script]) continue;
      defs.push({
        id: `npmScripts:${relDir ? relDir + ':' : ''}${script}`,
        name: `${relDir ? relDir + ' › ' : ''}${script}`,
        stage,
        severity: c.severity,
        kind: 'command',
        run: async (ctx) => {
          let args: string[] = [];
          if (stage === 'pre-commit') {
            const relevant = (await getFiles()).filter(
              (f) =>
                c.fileExtensions.some((e) => f.toLowerCase().endsWith(e.toLowerCase())) &&
                !isExcluded(ctx, f, c.exclude) &&
                (!relDir || f.startsWith(relDir + '/')),
            );
            if (!relevant.length && !c.alwaysRun && ctx.mode === 'staged') {
              return { status: 'skipped', summary: `No staged ${c.fileExtensions.join('/')} files` };
            }
            if (c.passStagedFiles && ctx.mode === 'staged') {
              args = relevant.map((f) => normalizePath(path.relative(dir, path.join(root, f))));
            }
          }
          const pm = detectPackageManager(dir, root, cfg.packageManager);
          const command = runScriptCommand(pm, script, args);
          const res = await runShell(command, { cwd: dir, timeoutMs: c.timeoutSec * 1000, signal: ctx.signal });
          return commandOutcome(res, command, dir, root, c.timeoutSec);
        },
      });
    }
  }
  return defs;
}

/**
 * True when the package.json scripts check will already run `tool` for files in `dir` (so the
 * dedicated check would run it twice).
 */
function scriptsRunTool(cfg: GuardConfig, root: string, dir: string, tool: string): boolean {
  const c = cfg.checks.npmScripts;
  if (!c.enabled || c.stage !== 'pre-commit') return false;
  const scope = effectiveNpmScope(cfg, root);
  if (dir && scope === 'root') return false;
  const scripts = readScripts(absDir(root, dir));
  return c.scripts.some((s) => new RegExp(`\\b${tool}\\b`).test(scripts[s] ?? ''));
}

/** Run one tool command per owning folder and file chunk, merging the results. */
async function runPerFolder(
  root: string,
  groups: Map<string, string[]>,
  build: (dir: string, chunk: string[]) => string,
  opts: { timeoutSec: number; signal?: AbortSignal; stopOnFailure?: boolean },
): Promise<{ output: string; findings: Finding[]; failed?: CheckOutcome; last?: CheckOutcome }> {
  let output = '';
  const findings: Finding[] = [];
  let failed: CheckOutcome | undefined;
  let last: CheckOutcome | undefined;
  const multi = groups.size > 1;
  for (const [dir, files] of groups) {
    const cwd = absDir(root, dir);
    const rel = files.map((f) => relativeTo(dir, f));
    for (const chunk of rel.length ? chunkArgs(rel) : [[]]) {
      const command = build(dir, chunk);
      const res = await runShell(command, { cwd, timeoutMs: opts.timeoutSec * 1000, signal: opts.signal });
      output += `${multi ? `── ${dir || '(root)'}\n` : ''}${res.output}`;
      last = commandOutcome(res, command, cwd, root, opts.timeoutSec);
      if (last.status !== 'passed') {
        findings.push(...(last.findings ?? []));
        failed ??= last;
        if (opts.stopOnFailure || last.status === 'skipped') return { output, findings, failed, last };
      }
    }
  }
  return { output, findings, failed, last };
}

const folderNote = (groups: Map<string, string[]>) =>
  groups.size > 1 || (groups.size === 1 && !groups.has('')) ? ` in ${[...groups.keys()].map((d) => d || '(root)').join(', ')}` : '';

// ---------------------------------------------------------------- lint-staged

const LINT_STAGED_FILES = [
  '.lintstagedrc',
  '.lintstagedrc.json',
  '.lintstagedrc.yaml',
  '.lintstagedrc.yml',
  '.lintstagedrc.js',
  '.lintstagedrc.cjs',
  '.lintstagedrc.mjs',
  'lint-staged.config.js',
  'lint-staged.config.cjs',
  'lint-staged.config.mjs',
  'lint-staged.config.ts',
];

/** lint-staged config in this folder (a config file, or package.json#lint-staged). */
export function hasLintStagedConfig(dir: string): boolean {
  return exists(dir, LINT_STAGED_FILES) || !!readPackageJson(dir)?.['lint-staged'];
}

const LINT_STAGED: ToolSpec = { candidates: [...LINT_STAGED_FILES, 'package.json'], isDir: hasLintStagedConfig };

export async function lintStagedCheck(cfg: GuardConfig, root: string, stage: Stage): Promise<CheckDef[]> {
  const c = cfg.checks.lintStaged;
  if (stage !== 'pre-commit' || c.enabled === false) return [];
  const rootConfig = hasLintStagedConfig(root);
  if (c.enabled === 'auto' && !rootConfig && !(await toolDirs(root, LINT_STAGED)).length) return [];
  return [
    {
      id: 'lintStaged',
      name: 'lint-staged',
      stage,
      severity: c.severity,
      kind: 'command',
      run: async (ctx) => {
        if (ctx.mode !== 'staged') return { status: 'skipped', summary: 'Only runs on staged changes' };
        // A root config: one run from the root (lint-staged finds nested configs itself).
        // Otherwise: one run per package that has a config and owns staged files.
        let dirs: string[];
        if (rootConfig || c.enabled === true) dirs = [''];
        else {
          const groups = groupByOwnerDir(root, (await ctx.fileSet()).files, hasLintStagedConfig);
          dirs = [...groups.keys()];
          if (!dirs.length) return { status: 'skipped', summary: 'No staged files under a lint-staged config' };
        }
        let output = '';
        let failed: CheckOutcome | undefined;
        const findings: Finding[] = [];
        const commands: string[] = [];
        for (const dir of dirs) {
          const cwd = absDir(root, dir);
          const command = execBin(detectPackageManager(cwd, root, cfg.packageManager), 'lint-staged');
          commands.push(dir ? `(cd ${dir} && ${command})` : command);
          const res = await runShell(command, { cwd, timeoutMs: c.timeoutSec * 1000, signal: ctx.signal });
          output += `${dirs.length > 1 ? `── ${dir || '(root)'}\n` : ''}${res.output}`;
          const o = commandOutcome(res, command, cwd, root, c.timeoutSec);
          if (o.status !== 'passed') {
            findings.push(...(o.findings ?? []));
            failed ??= o;
            break;
          }
        }
        const command = commands.length > 1 ? `${commands[0]} (+${commands.length - 1} more)` : commands[0];
        if (failed) return { ...failed, command, output, findings };
        const where = dirs.length === 1 && !dirs[0] ? '' : ` in ${dirs.map((d) => d || '(root)').join(', ')}`;
        return { status: 'passed', summary: `Passed${where}`, command, output, findings: [] };
      },
    },
  ];
}

// ---------------------------------------------------------------- Biome

const BIOME_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json|jsonc|css|graphql|gql|astro|vue|svelte)$/i;
const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];

/** This folder has a biome.json(c) or a package.json depending on @biomejs/biome. */
export function hasBiome(dir: string): boolean {
  return exists(dir, BIOME_CONFIGS) || hasDependency(readPackageJson(dir), '@biomejs/biome');
}

const BIOME: ToolSpec = { candidates: [...BIOME_CONFIGS, 'package.json'], isDir: hasBiome };

export async function biomeCheck(cfg: GuardConfig, root: string, stage: Stage): Promise<CheckDef[]> {
  const c = cfg.checks.biome;
  if (stage !== 'pre-commit' || c.enabled === false) return [];
  if (c.enabled === 'auto') {
    const dirs = await toolDirs(root, BIOME);
    if (!dirs.length || dirs.every((d) => scriptsRunTool(cfg, root, d, 'biome'))) return [];
  }
  return [
    {
      id: 'biome',
      name: `Biome ${c.mode}`,
      stage,
      severity: c.severity,
      kind: 'command',
      run: async (ctx) => {
        const files = (await ctx.fileSet()).files.filter((f) => BIOME_EXTENSIONS.test(f) && !isExcluded(ctx, f));
        if (!files.length) return { status: 'skipped', summary: 'No staged files Biome can check' };
        // Each file is checked from the nearest folder set up for Biome (the root when nothing nearer is).
        const groups = groupByOwnerDir(root, files, (abs, rel) => !rel || hasBiome(abs));
        if (c.enabled === 'auto') for (const d of [...groups.keys()]) if (scriptsRunTool(cfg, root, d, 'biome') || !hasBiome(absDir(root, d))) groups.delete(d);
        const checked = [...groups.values()].flat();
        if (!checked.length) return { status: 'skipped', summary: 'No staged files under a Biome config' };
        const fix = c.applyFixes && ctx.mode === 'staged' ? ' --write' : '';
        const extra = c.extraArgs.length ? ' ' + c.extraArgs.map(shellQuote).join(' ') : '';
        const base = (dir: string) =>
          `${execBin(detectPackageManager(absDir(root, dir), root, cfg.packageManager), 'biome')} ${c.mode} --no-errors-on-unmatched --files-ignore-unknown=true --colors=off${fix}${extra}`;
        const partial = fix ? new Set(await unstagedFiles(root)) : undefined;
        const r = await runPerFolder(root, groups, (dir, chunk) => `${base(dir)} ${chunk.map(shellQuote).join(' ')}`, {
          timeoutSec: c.timeoutSec,
          signal: ctx.signal,
          stopOnFailure: true,
        });
        if (partial && !r.failed)
          await stageFiles(
            root,
            checked.filter((f) => !partial.has(f)),
          );
        const command = `${base([...groups.keys()][0])} <staged files>${folderNote(groups)}`;
        if (r.failed) return { ...r.failed, command, output: r.output, findings: r.findings };
        return { ...r.last!, command, output: r.output, findings: [], summary: `${checked.length} file(s) clean${folderNote(groups)}` };
      },
    },
  ];
}

// ---------------------------------------------------------------- Prettier

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  '.prettierrc.cts',
  '.prettierrc.mts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
  'prettier.config.cts',
  'prettier.config.mts',
];

/**
 * A Prettier config file always counts. The `prettier` dependency alone only counts when the folder
 * isn't set up for Biome (projects often keep prettier around for tooling while formatting with Biome).
 */
export function hasPrettier(dir: string): boolean {
  if (exists(dir, PRETTIER_CONFIGS)) return true;
  const pkg = readPackageJson(dir);
  if (!pkg) return false;
  if (pkg.prettier) return true;
  return hasDependency(pkg, 'prettier') && !exists(dir, BIOME_CONFIGS);
}

const PRETTIER: ToolSpec = { candidates: [...PRETTIER_CONFIGS, 'package.json'], isDir: hasPrettier };

/**
 * Parse `prettier --check` / `--write` output: "[warn] file" = unformatted, "[error] file: SyntaxError … (l:c)".
 * Paths are relative to `cwd` (the folder Prettier ran in); findings are repo-relative.
 */
export function parsePrettierOutput(output: string, root: string, cwd: string = root): Finding[] {
  const findings: Finding[] = [];
  const rel = (file: string) => {
    const abs = path.resolve(cwd, file);
    const r = normalizePath(path.relative(root, abs));
    return !r.startsWith('..') && fs.existsSync(abs) ? r : undefined;
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^\[error\] (.+?): (.*?)(?: \((\d+):(\d+)\))?$/.exec(line))) {
      const file = rel(m[1]);
      if (file) findings.push({ file, line: m[3] ? +m[3] : 1, column: m[4] ? +m[4] : undefined, rule: 'syntax', message: m[2] });
    } else if ((m = /^\[warn\] (.+)$/.exec(line)) && !/\s(issues?|found|Run Prettier)\b/.test(m[1])) {
      const file = rel(m[1]);
      if (file) findings.push({ file, line: 1, rule: 'prettier', message: 'File is not formatted with Prettier (run prettier --write)' });
    }
  }
  return findings;
}

export async function prettierCheck(cfg: GuardConfig, root: string, stage: Stage): Promise<CheckDef[]> {
  const c = cfg.checks.prettier;
  if (stage !== 'pre-commit' || c.enabled === false) return [];
  if (c.enabled === 'auto') {
    const dirs = await toolDirs(root, PRETTIER);
    if (!dirs.length || dirs.every((d) => scriptsRunTool(cfg, root, d, 'prettier'))) return [];
  }
  return [
    {
      id: 'prettier',
      name: c.applyFixes ? 'Prettier (format)' : 'Prettier',
      stage,
      severity: c.severity,
      kind: 'command',
      run: async (ctx) => {
        const all = (await ctx.fileSet()).files.filter((f) => !isExcluded(ctx, f, c.exclude));
        if (!all.length) return { status: 'skipped', summary: 'No staged files' };
        // Each file is formatted from the nearest folder set up for Prettier (the root when nothing nearer is).
        const groups = groupByOwnerDir(root, all, (abs, rel) => !rel || hasPrettier(abs));
        if (c.enabled === 'auto')
          for (const d of [...groups.keys()]) if (scriptsRunTool(cfg, root, d, 'prettier') || !hasPrettier(absDir(root, d))) groups.delete(d);
        const files = [...groups.values()].flat();
        if (!files.length) return { status: 'skipped', summary: 'No staged files under a Prettier config' };
        const bin = (dir: string) => execBin(detectPackageManager(absDir(root, dir), root, cfg.packageManager), 'prettier');
        const extra = c.extraArgs.length ? ` ${c.extraArgs.map(shellQuote).join(' ')}` : '';
        // With applyFixes, fully-staged files are written + re-staged; partially-staged ones are only checked
        // (writing them would mix unstaged edits into the commit).
        const partial = c.applyFixes && ctx.mode === 'staged' ? new Set(await unstagedFiles(root)) : new Set<string>();
        const toWrite = new Set(c.applyFixes && ctx.mode === 'staged' ? files.filter((f) => !partial.has(f)) : []);
        let output = '';
        const findings: Finding[] = [];
        let failed: CheckOutcome | undefined;
        for (const [mode, keep] of [
          ['--write', (f: string) => toWrite.has(f)],
          ['--check', (f: string) => !toWrite.has(f)],
        ] as const) {
          const sub = new Map([...groups].map(([d, fs]) => [d, fs.filter(keep)] as const).filter(([, fs]) => fs.length));
          for (const [dir, list] of sub) {
            const cwd = absDir(root, dir);
            for (const chunk of chunkArgs(list.map((f) => relativeTo(dir, f)))) {
              const command = `${bin(dir)} ${mode} --ignore-unknown --no-error-on-unmatched-pattern${extra} ${chunk.map(shellQuote).join(' ')}`;
              const res = await runShell(command, { cwd, timeoutMs: c.timeoutSec * 1000, signal: ctx.signal });
              output += `${groups.size > 1 ? `── ${dir || '(root)'}\n` : ''}${res.output}`;
              if (res.code !== 0 || res.timedOut || res.cancelled) {
                const o = commandOutcome(res, command, cwd, root, c.timeoutSec);
                findings.push(...parsePrettierOutput(res.output, root, cwd));
                failed ??= o;
              }
            }
          }
        }
        if (toWrite.size && !failed) await stageFiles(root, [...toWrite]);
        const command = `${bin([...groups.keys()][0])} ${c.applyFixes ? '--write' : '--check'} --ignore-unknown <staged files>${folderNote(groups)}`;
        if (failed) {
          const unformatted = findings.filter((f) => f.rule === 'prettier').length;
          const syntax = findings.filter((f) => f.rule === 'syntax').length;
          const summary = findings.length
            ? [unformatted && `${unformatted} file(s) not formatted`, syntax && `${syntax} syntax error(s)`].filter(Boolean).join(', ')
            : failed.summary;
          return { ...failed, command, output, summary, findings };
        }
        const checkedOnly = files.length - toWrite.size;
        const partialNote = checkedOnly && c.applyFixes ? ` · ${checkedOnly} partially-staged file(s) checked only` : '';
        return {
          status: 'passed',
          summary: toWrite.size ? `Formatted & re-staged ${toWrite.size} file(s)${partialNote}` : `${files.length} file(s) formatted`,
          command,
          output,
          findings: [],
        };
      },
    },
  ];
}

// ---------------------------------------------------------------- custom commands

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'custom'
  );
}

export function customCheckId(c: CustomCheck): string {
  return `custom:${c.id ?? slug(c.name)}`;
}

/** Split file args into chunks so Windows' ~8K command-line limit is never hit. */
export function chunkArgs(files: string[], maxLen = 6000): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const f of files) {
    const q = shellQuote(f);
    if (cur.length && len + q.length + 1 > maxLen) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(f);
    len += q.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function customChecks(cfg: GuardConfig, root: string, stage: Stage): CheckDef[] {
  return cfg.custom
    .filter((c) => c.enabled !== false && (c.stage ?? 'pre-commit') === stage && c.command)
    .map((c): CheckDef => {
      const timeoutSec = c.timeoutSec ?? 300;
      const severity: Severity = c.severity ?? 'error';
      return {
        id: customCheckId(c),
        name: c.name,
        stage,
        severity,
        kind: 'command',
        run: async (ctx) => {
          const cwd = c.cwd ? path.resolve(root, c.cwd) : root;
          let files: string[] = [];
          if (stage === 'pre-commit') files = (await ctx.fileSet()).files;
          else if (stage === 'pre-push') files = await ctx.pushFiles();
          files = files.filter((f) => !isExcluded(ctx, f) && (!c.glob || matchesAny(f, c.glob)));
          const usesFiles = c.command.includes('{files}');
          if (c.glob && !files.length && !c.alwaysRun && stage !== 'commit-msg') {
            return { status: 'skipped', summary: 'No matching files' };
          }
          if (usesFiles && !files.length && !c.alwaysRun && stage === 'pre-commit') {
            return { status: 'skipped', summary: 'No files to check' };
          }
          const relFiles = files.map((f) => normalizePath(path.relative(cwd, path.join(root, f))));
          const before = c.restage && ctx.mode === 'staged' ? new Set(await unstagedFiles(root)) : undefined;
          const expand = (chunk: string[]) =>
            c.command
              .replace(/\{files\}/g, chunk.map(shellQuote).join(' '))
              .replace(/\{root\}/g, shellQuote(root))
              .replace(/\{branch\}/g, shellQuote(ctx.branch))
              .replace(/\{msgFile\}/g, shellQuote(ctx.msgFile ?? ''))
              .replace(/\{stagedCount\}/g, String(files.length));
          const chunks = usesFiles ? chunkArgs(relFiles) : [[]];
          let combined: CheckOutcome | undefined;
          let output = '';
          for (const chunk of chunks) {
            const command = expand(chunk);
            const res = await runShell(command, { cwd, timeoutMs: timeoutSec * 1000, signal: ctx.signal, env: c.env });
            output += res.output;
            const o = commandOutcome(res, command, cwd, root, timeoutSec);
            combined = combined && combined.status !== 'passed' ? { ...combined, findings: [...(combined.findings ?? []), ...(o.findings ?? [])] } : o;
            if (o.status !== 'passed') break;
          }
          combined = { ...combined!, output, command: chunks.length > 1 ? `${expand(chunks[0])} (+${chunks.length - 1} more batches)` : combined!.command };
          if (before && combined.status === 'passed') {
            const fully = files.filter((f) => !before.has(f));
            await stageFiles(root, fully);
            const partial = files.filter((f) => before.has(f));
            if (partial.length) combined.summary += ` · ${partial.length} partially-staged file(s) not re-staged`;
          }
          return combined;
        },
      };
    });
}
