import * as fs from 'node:fs';
import * as path from 'node:path';
import { builtinChecks } from './checks/builtin';
import { biomeCheck, customChecks, lintStagedCheck, npmScriptChecks } from './checks/commands';
import type { CheckContext, CheckDef } from './checks/context';
import { type ConfigSources, loadConfig } from './config';
import { type FileSet, currentBranch, git, gitCommonDir, isBinary, stageFiles, stagedFileSet, unstagedFiles, workingTreeFileSet } from './git';
import { matchesAny } from './glob';
import type { CheckResult, GuardConfig, RunReport, Stage } from './types';

export const STATE_DIR = 'precommit-guard';

export interface RunOptions extends ConfigSources {
  root: string;
  stage: Stage;
  source: RunReport['source'];
  /** `staged` = what's in the index (default), `all` = every tracked file in the working tree. */
  mode?: 'staged' | 'all';
  config?: GuardConfig;
  /** Only run these check ids (prefix match, e.g. `npmScripts` matches `npmScripts:lint`). */
  only?: string[];
  /** Skip these check ids (prefix match). Also read from the SKIP env var by the CLI. */
  skip?: string[];
  msgFile?: string;
  signal?: AbortSignal;
  onStart?: (def: { id: string; name: string }) => void;
  onResult?: (result: CheckResult) => void;
  /** Persist the report for the editor UI. Default true. */
  writeReport?: boolean;
}

export async function stateDir(root: string): Promise<string> {
  return path.join(await gitCommonDir(root), STATE_DIR);
}

const idMatches = (id: string, list: string[]) =>
  list.some((p) => id === p || id.startsWith(p + ':') || (p.startsWith('custom:') ? false : id === `custom:${p}`));

export async function collectChecks(config: GuardConfig, root: string, stage: Stage, getFiles: () => Promise<string[]>): Promise<CheckDef[]> {
  const defs = [
    ...builtinChecks(config).filter((d) => d.stage === stage),
    ...lintStagedCheck(config, root, stage),
    ...biomeCheck(config, root, stage),
    ...(await npmScriptChecks(config, root, stage, getFiles)),
    ...customChecks(config, root, stage),
  ];
  return defs;
}

/** Fix trailing whitespace / missing EOF newline in working-tree files. Returns changed files. */
export async function fixFiles(root: string, files: string[], config: GuardConfig, opts: { trailing?: boolean; eof?: boolean } = {}): Promise<string[]> {
  const trailing = opts.trailing ?? true;
  const eof = opts.eof ?? true;
  const changed: string[] = [];
  for (const f of files) {
    if (matchesAny(f, config.exclude)) continue;
    const abs = path.join(root, f);
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(abs);
    } catch {
      continue;
    }
    if (!buf.length || isBinary(buf)) continue;
    let text = buf.toString('utf8');
    const orig = text;
    if (trailing && !matchesAny(f, config.checks.trailingWhitespace.exclude)) text = text.replace(/[ \t]+(\r?\n)/g, '$1').replace(/[ \t]+$/, '');
    if (eof && !matchesAny(f, config.checks.eofNewline.exclude) && !text.endsWith('\n')) text += text.includes('\r\n') ? '\r\n' : '\n';
    if (text !== orig) {
      await fs.promises.writeFile(abs, text);
      changed.push(f);
    }
  }
  return changed;
}

export function isBlocking(r: CheckResult, config: GuardConfig): boolean {
  if (r.status !== 'failed' && r.status !== 'error') return false;
  return r.severity === 'error' || config.failOn === 'warning';
}

export async function runChecks(opts: RunOptions): Promise<RunReport> {
  const started = Date.now();
  const { root, stage } = opts;
  const mode = opts.mode ?? 'staged';
  const config = opts.config ?? loadConfig(root, opts).config;
  const report: RunReport = {
    version: 1,
    repoRoot: root,
    stage,
    source: opts.source,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    blocked: false,
    results: [],
  };
  if (!config.enabled) return finish();

  const controller = new AbortController();
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  // Auto-fix before checking, so the checks see the fixed content.
  if (config.autoFix && stage === 'pre-commit' && mode === 'staged') {
    const staged = (await stagedFileSet(root)).files;
    const partial = new Set(await unstagedFiles(root));
    const fully = staged.filter((f) => !partial.has(f));
    const fixed = await fixFiles(root, fully, config, {
      trailing: config.checks.trailingWhitespace.enabled,
      eof: config.checks.eofNewline.enabled,
    });
    if (fixed.length) {
      await stageFiles(root, fixed);
      report.fixedFiles = fixed;
    }
  }

  let fileSetP: Promise<FileSet> | undefined;
  const fileSet = () => (fileSetP ??= mode === 'staged' ? stagedFileSet(root) : workingTreeFileSet(root));
  const pushFiles = async () => {
    const r = await git(['diff', '--name-only', '-z', '--diff-filter=ACMR', '@{upstream}...HEAD'], root);
    return r.code === 0 ? r.stdout.toString('utf8').split('\0').filter(Boolean) : [];
  };
  const ctx: CheckContext = {
    root,
    config,
    stage,
    mode,
    msgFile: opts.msgFile,
    signal: controller.signal,
    branch: await currentBranch(root),
    fileSet,
    pushFiles,
  };

  let defs = await collectChecks(config, root, stage, async () => (await fileSet()).files);
  if (opts.only?.length) defs = defs.filter((d) => idMatches(d.id, opts.only!));
  const skipped = opts.skip?.length ? defs.filter((d) => idMatches(d.id, opts.skip!)) : [];
  defs = defs.filter((d) => !skipped.includes(d));

  const results = new Map<string, CheckResult>();
  for (const d of skipped) {
    results.set(d.id, { id: d.id, name: d.name, stage, severity: d.severity, status: 'skipped', summary: 'Skipped via SKIP', durationMs: 0, findings: [] });
  }

  const runOne = async (d: CheckDef) => {
    if (controller.signal.aborted) {
      results.set(d.id, {
        id: d.id,
        name: d.name,
        stage,
        severity: d.severity,
        status: 'skipped',
        summary: 'Not run (stopped early)',
        durationMs: 0,
        findings: [],
      });
      return;
    }
    opts.onStart?.(d);
    const t = Date.now();
    let res: CheckResult;
    try {
      const o = await d.run(ctx);
      res = { id: d.id, name: d.name, stage, severity: d.severity, findings: [], ...o, durationMs: Date.now() - t };
    } catch (e) {
      res = { id: d.id, name: d.name, stage, severity: d.severity, status: 'error', summary: (e as Error).message, durationMs: Date.now() - t, findings: [] };
    }
    results.set(d.id, res);
    opts.onResult?.(res);
    if (config.stopOnFirstFailure && isBlocking(res, config)) controller.abort();
  };

  const builtins = defs.filter((d) => d.kind === 'builtin');
  const commands = defs.filter((d) => d.kind === 'command');
  await Promise.all(builtins.map(runOne));

  // Command pool.
  const queue = [...commands];
  const workers = Array.from({ length: Math.max(1, Math.min(config.concurrency, queue.length)) }, async () => {
    while (queue.length) await runOne(queue.shift()!);
  });
  await Promise.all(workers);

  const order = [...skipped, ...builtins, ...commands].map((d) => d.id);
  report.results = order.map((id) => results.get(id)!).filter(Boolean);
  report.blocked = report.results.some((r) => isBlocking(r, config));
  return finish();

  async function finish(): Promise<RunReport> {
    report.durationMs = Date.now() - started;
    if (opts.writeReport !== false) {
      try {
        const dir = await stateDir(root);
        await fs.promises.mkdir(dir, { recursive: true });
        const tmp = path.join(dir, `last-${stage}.${process.pid}.tmp`);
        await fs.promises.writeFile(tmp, JSON.stringify(report, null, 2));
        await fs.promises.rename(tmp, path.join(dir, reportFileName(stage)));
      } catch {
        /* reporting is best-effort */
      }
    }
    return report;
  }
}

export const reportFileName = (stage: Stage) => `last-${stage}.json`;

export async function readLastReport(root: string, stage: Stage): Promise<RunReport | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(await stateDir(root), reportFileName(stage)), 'utf8'));
  } catch {
    return undefined;
  }
}
