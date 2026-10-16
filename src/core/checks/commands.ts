import * as fs from 'node:fs';
import * as path from 'node:path';
import { runShell, shellQuote } from '../exec';
import { stageFiles, unstagedFiles } from '../git';
import { matchesAny, normalizePath } from '../glob';
import type { CustomCheck, Finding, GuardConfig, PackageManager, Severity, Stage } from '../types';
import { CheckContext, type CheckDef, type CheckOutcome, isExcluded } from './context';

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

// ---------------------------------------------------------------- package.json scripts

function readScripts(dir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return {};
  }
}

function nearestPackageDir(root: string, file: string): string | undefined {
  let d = path.dirname(path.join(root, file));
  const top = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.resolve(d) === top || path.dirname(d) === d) return undefined;
    d = path.dirname(d);
  }
}

/** Build one check per matching script, per package directory. */
export async function npmScriptChecks(cfg: GuardConfig, root: string, stage: Stage, getFiles: () => Promise<string[]>): Promise<CheckDef[]> {
  const c = cfg.checks.npmScripts;
  if (!c.enabled || c.stage !== stage) return [];
  let dirs: string[] = [];
  if (c.scope === 'affected' && stage === 'pre-commit') {
    const set = new Set<string>();
    for (const f of await getFiles()) {
      const d = nearestPackageDir(root, f);
      if (d) set.add(d);
    }
    dirs = [...set];
  } else if (fs.existsSync(path.join(root, 'package.json'))) dirs = [root];

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

export function hasLintStagedConfig(root: string): boolean {
  if (LINT_STAGED_FILES.some((f) => fs.existsSync(path.join(root, f)))) return true;
  try {
    return !!JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))['lint-staged'];
  } catch {
    return false;
  }
}

export function lintStagedCheck(cfg: GuardConfig, root: string, stage: Stage): CheckDef[] {
  const c = cfg.checks.lintStaged;
  if (stage !== 'pre-commit' || c.enabled === false) return [];
  if (c.enabled === 'auto' && !hasLintStagedConfig(root)) return [];
  return [
    {
      id: 'lintStaged',
      name: 'lint-staged',
      stage,
      severity: c.severity,
      kind: 'command',
      run: async (ctx) => {
        if (ctx.mode !== 'staged') return { status: 'skipped', summary: 'Only runs on staged changes' };
        const command = execBin(detectPackageManager(root, root, cfg.packageManager), 'lint-staged');
        const res = await runShell(command, { cwd: root, timeoutMs: c.timeoutSec * 1000, signal: ctx.signal });
        return commandOutcome(res, command, root, root, c.timeoutSec);
      },
    },
  ];
}

// ---------------------------------------------------------------- Biome

const BIOME_EXTENSIONS = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|json|jsonc|css|graphql|gql|astro|vue|svelte)$/i;

export function hasBiome(root: string): boolean {
  if (fs.existsSync(path.join(root, 'biome.json')) || fs.existsSync(path.join(root, 'biome.jsonc'))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return !!(pkg.devDependencies?.['@biomejs/biome'] ?? pkg.dependencies?.['@biomejs/biome']);
  } catch {
    return false;
  }
}

/** True when one of the configured package.json scripts already invokes biome (avoid running it twice). */
function scriptsRunTool(cfg: GuardConfig, root: string, tool: string): boolean {
  if (!cfg.checks.npmScripts.enabled) return false;
  const scripts = readScripts(root);
  return cfg.checks.npmScripts.scripts.some((s) => new RegExp(`\\b${tool}\\b`).test(scripts[s] ?? ''));
}

export function biomeCheck(cfg: GuardConfig, root: string, stage: Stage): CheckDef[] {
  const c = cfg.checks.biome;
  if (stage !== 'pre-commit' || c.enabled === false) return [];
  if (c.enabled === 'auto' && (!hasBiome(root) || scriptsRunTool(cfg, root, 'biome'))) return [];
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
        const fix = c.applyFixes && ctx.mode === 'staged' ? ' --write' : '';
        const base = `${execBin(detectPackageManager(root, root, cfg.packageManager), 'biome')} ${c.mode} --no-errors-on-unmatched --files-ignore-unknown=true --colors=off${fix}${c.extraArgs.length ? ' ' + c.extraArgs.map(shellQuote).join(' ') : ''}`;
        const partial = fix ? new Set(await unstagedFiles(root)) : undefined;
        let last: CheckOutcome | undefined;
        let output = '';
        const findings: Finding[] = [];
        for (const chunk of chunkArgs(files)) {
          const command = `${base} ${chunk.map(shellQuote).join(' ')}`;
          const res = await runShell(command, { cwd: root, timeoutMs: c.timeoutSec * 1000, signal: ctx.signal });
          output += res.output;
          last = commandOutcome(res, command, root, root, c.timeoutSec);
          findings.push(...(last.findings ?? []));
          if (last.status !== 'passed') break;
        }
        if (partial && last?.status === 'passed')
          await stageFiles(
            root,
            files.filter((f) => !partial.has(f)),
          );
        return {
          ...last!,
          command: base + ' <staged files>',
          output,
          findings: last!.status === 'passed' ? [] : findings,
          summary: last!.status === 'passed' ? `${files.length} file(s) clean` : last!.summary,
        };
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
 * A Prettier config file always counts. The `prettier` dependency alone only counts when the project
 * isn't set up for Biome (projects often keep prettier around for tooling while formatting with Biome).
 */
export function hasPrettier(root: string): boolean {
  if (PRETTIER_CONFIGS.some((f) => fs.existsSync(path.join(root, f)))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.prettier) return true;
    const dep = !!(pkg.devDependencies?.prettier || pkg.dependencies?.prettier);
    const biomeConfigured = fs.existsSync(path.join(root, 'biome.json')) || fs.existsSync(path.join(root, 'biome.jsonc'));
    return dep && !biomeConfigured;
  } catch {
    return false;
  }
}

/** Parse `prettier --check` / `--write` output: "[warn] file" = unformatted, "[error] file: SyntaxError … (l:c)". */
export function parsePrettierOutput(output: string, root: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^\[error\] (.+?): (.*?)(?: \((\d+):(\d+)\))?$/.exec(line))) {
      const file = normalizePath(m[1]);
      if (fs.existsSync(path.join(root, file)))
        findings.push({ file, line: m[3] ? +m[3] : 1, column: m[4] ? +m[4] : undefined, rule: 'syntax', message: m[2] });
    } else if ((m = /^\[warn\] (.+)$/.exec(line)) && !/\s(issues?|found|Run Prettier)\b/.test(m[1])) {
      const file = normalizePath(m[1]);
      if (fs.existsSync(path.join(root, file)))
        findings.push({ file, line: 1, rule: 'prettier', message: 'File is not formatted with Prettier (run prettier --write)' });
    }
  }
  return findings;
}

export function prettierCheck(cfg: GuardConfig, root: string, stage: Stage): CheckDef[] {
  const c = cfg.checks.prettier;
  if (stage !== 'pre-commit' || c.enabled === false) return [];
  if (c.enabled === 'auto' && (!hasPrettier(root) || scriptsRunTool(cfg, root, 'prettier'))) return [];
  return [
    {
      id: 'prettier',
      name: c.applyFixes ? 'Prettier (format)' : 'Prettier',
      stage,
      severity: c.severity,
      kind: 'command',
      run: async (ctx) => {
        const files = (await ctx.fileSet()).files.filter((f) => !isExcluded(ctx, f, c.exclude));
        if (!files.length) return { status: 'skipped', summary: 'No staged files' };
        const bin = execBin(detectPackageManager(root, root, cfg.packageManager), 'prettier');
        const extra = c.extraArgs.length ? ` ${c.extraArgs.map(shellQuote).join(' ')}` : '';
        // With applyFixes, fully-staged files are written + re-staged; partially-staged ones are only checked
        // (writing them would mix unstaged edits into the commit).
        const partial = c.applyFixes && ctx.mode === 'staged' ? new Set(await unstagedFiles(root)) : new Set<string>();
        const toWrite = c.applyFixes && ctx.mode === 'staged' ? files.filter((f) => !partial.has(f)) : [];
        const toCheck = files.filter((f) => !toWrite.includes(f));
        let output = '';
        const findings: Finding[] = [];
        let failed: CheckOutcome | undefined;
        for (const [mode, list] of [
          ['--write', toWrite],
          ['--check', toCheck],
        ] as const) {
          for (const chunk of chunkArgs(list)) {
            const command = `${bin} ${mode} --ignore-unknown --no-error-on-unmatched-pattern${extra} ${chunk.map(shellQuote).join(' ')}`;
            const res = await runShell(command, { cwd: root, timeoutMs: c.timeoutSec * 1000, signal: ctx.signal });
            output += res.output;
            if (res.code !== 0 || res.timedOut || res.cancelled) {
              const o = commandOutcome(res, command, root, root, c.timeoutSec);
              findings.push(...parsePrettierOutput(res.output, root));
              failed ??= o;
            }
          }
        }
        if (toWrite.length && !failed) await stageFiles(root, toWrite);
        const command = `${bin} ${c.applyFixes ? '--write' : '--check'} --ignore-unknown <staged files>`;
        if (failed) {
          const unformatted = findings.filter((f) => f.rule === 'prettier').length;
          const syntax = findings.filter((f) => f.rule === 'syntax').length;
          const summary = findings.length
            ? [unformatted && `${unformatted} file(s) not formatted`, syntax && `${syntax} syntax error(s)`].filter(Boolean).join(', ')
            : failed.summary;
          return { ...failed, command, output, summary, findings };
        }
        const partialNote = toCheck.length && c.applyFixes ? ` · ${toCheck.length} partially-staged file(s) checked only` : '';
        return {
          status: 'passed',
          summary: toWrite.length ? `Formatted & re-staged ${toWrite.length} file(s)${partialNote}` : `${files.length} file(s) formatted`,
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
