import * as fs from 'node:fs';
import * as path from 'node:path';
import { stateDir } from './engine';
import { getConfigValue, hooksDir } from './git';
import type { Stage } from './types';

export const MARKER = 'tollgate-managed';
export const BACKUP_SUFFIX = '.pre-guard';
export const RUNNER_FILE = 'runner.js';
const HUSKY_MARKER = '# tollgate';

export interface HookStatus {
  hooksDir: string;
  hooksPath?: string;
  /** core.hooksPath is set to a custom dir (husky, lefthook, …). */
  customHooksPath: boolean;
  installed: Stage[];
  foreign: Stage[];
  runnerVersion?: string;
  huskyIntegrated: Stage[];
}

const toShPath = (p: string) => p.replace(/\\/g, '/');

export function hookScript(stage: Stage, nodeFallback?: string): string {
  const passStdin = stage === 'pre-push';
  return `#!/bin/sh
# ${MARKER} — installed by the Tollgate VS Code extension.
# Skip once: git commit --no-verify  ·  skip a check: SKIP=secrets,lint git commit  ·  disable: TOLLGATE=0
[ "$TOLLGATE" = "0" ] && exit 0
HOOK_DIR=$(cd "$(dirname "$0")" && pwd)
${passStdin ? 'STDIN_DATA=$(cat)\n' : ''}if [ -x "$HOOK_DIR/${stage}${BACKUP_SUFFIX}" ]; then
  ${passStdin ? `printf '%s\\n' "$STDIN_DATA" | ` : ''}"$HOOK_DIR/${stage}${BACKUP_SUFFIX}" "$@" || exit $?
fi
RUNNER="$(git rev-parse --git-common-dir)/tollgate/${RUNNER_FILE}"
if [ ! -f "$RUNNER" ]; then
  echo "tollgate: runner not found at $RUNNER — skipping checks. Open the repo in VS Code to repair." >&2
  exit 0
fi
if command -v node >/dev/null 2>&1; then
  exec node "$RUNNER" hook ${stage} "$@"
fi
FALLBACK="${nodeFallback ? toShPath(nodeFallback) : ''}"
if [ -n "$FALLBACK" ] && [ -f "$FALLBACK" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$FALLBACK" "$RUNNER" hook ${stage} "$@"
fi
echo "tollgate: Node.js not found on PATH — skipping checks." >&2
exit 0
`;
}

function readVersion(file: string): string | undefined {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 300);
    return /tollgate-runner v([\w.-]+)/.exec(head)?.[1];
  } catch {
    return undefined;
  }
}

function huskyUserDir(hooksPathAbs: string): string {
  return path.basename(hooksPathAbs) === '_' ? path.dirname(hooksPathAbs) : hooksPathAbs;
}

export async function hookStatus(root: string, stages: Stage[] = ['pre-commit', 'commit-msg', 'pre-push']): Promise<HookStatus> {
  const dir = await hooksDir(root);
  const hooksPath = await getConfigValue(root, 'core.hooksPath');
  const installed: Stage[] = [];
  const foreign: Stage[] = [];
  const huskyIntegrated: Stage[] = [];
  for (const s of stages) {
    const f = path.join(dir, s);
    if (fs.existsSync(f)) (fs.readFileSync(f, 'utf8').includes(MARKER) ? installed : foreign).push(s);
    if (hooksPath) {
      const hf = path.join(huskyUserDir(path.resolve(root, hooksPath)), s);
      if (fs.existsSync(hf) && fs.readFileSync(hf, 'utf8').includes(HUSKY_MARKER)) huskyIntegrated.push(s);
    }
  }
  return {
    hooksDir: dir,
    hooksPath,
    customHooksPath: !!hooksPath,
    installed,
    foreign,
    huskyIntegrated,
    runnerVersion: readVersion(path.join(await stateDir(root), RUNNER_FILE)),
  };
}

/** Copy the self-contained runner into .git/tollgate so hooks work even if the extension moves or updates. */
export async function installRunner(root: string, runnerSource: string, version: string): Promise<string> {
  const dir = await stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, RUNNER_FILE);
  if (readVersion(dest) !== version || !fs.existsSync(dest)) {
    const body = fs.readFileSync(runnerSource, 'utf8').replace(/^#!.*\n/, '');
    fs.writeFileSync(dest, `// tollgate-runner v${version} — generated, do not edit.\n${body}`);
  }
  return dest;
}

export async function writeEditorSettings(root: string, settings: unknown): Promise<void> {
  const dir = await stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'vscode-settings.json'), JSON.stringify(settings ?? {}, null, 2));
}

export async function editorSettingsPath(root: string): Promise<string> {
  return path.join(await stateDir(root), 'vscode-settings.json');
}

export interface InstallOptions {
  stages: Stage[];
  runnerSource: string;
  version: string;
  nodeFallback?: string;
  /** Install into core.hooksPath even when it is custom (husky etc.). */
  force?: boolean;
}

export type InstallResult = { ok: true; installed: Stage[]; backedUp: Stage[]; removed: Stage[] } | { ok: false; reason: 'customHooksPath'; hooksPath: string };

export async function installHooks(root: string, opts: InstallOptions): Promise<InstallResult> {
  const status = await hookStatus(root);
  if (status.customHooksPath && !opts.force) return { ok: false, reason: 'customHooksPath', hooksPath: status.hooksPath! };
  await installRunner(root, opts.runnerSource, opts.version);
  fs.mkdirSync(status.hooksDir, { recursive: true });
  const backedUp: Stage[] = [];
  for (const s of opts.stages) {
    const f = path.join(status.hooksDir, s);
    if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes(MARKER)) {
      const backup = f + BACKUP_SUFFIX;
      if (!fs.existsSync(backup)) {
        fs.renameSync(f, backup);
        backedUp.push(s);
      }
    }
    fs.writeFileSync(f, hookScript(s, opts.nodeFallback), { mode: 0o755 });
    try {
      fs.chmodSync(f, 0o755);
    } catch {
      /* windows */
    }
  }
  // Remove our hooks for stages no longer wanted.
  const removed: Stage[] = [];
  for (const s of status.installed) {
    if (!opts.stages.includes(s)) {
      removeHook(status.hooksDir, s);
      removed.push(s);
    }
  }
  return { ok: true, installed: opts.stages, backedUp, removed };
}

function removeHook(dir: string, s: Stage): void {
  const f = path.join(dir, s);
  if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(MARKER)) {
    fs.unlinkSync(f);
    if (fs.existsSync(f + BACKUP_SUFFIX)) fs.renameSync(f + BACKUP_SUFFIX, f);
  }
}

export async function uninstallHooks(root: string): Promise<Stage[]> {
  const status = await hookStatus(root);
  for (const s of status.installed) removeHook(status.hooksDir, s);
  for (const s of status.huskyIntegrated) {
    const f = path.join(huskyUserDir(path.resolve(root, status.hooksPath!)), s);
    const text = fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !l.includes(HUSKY_MARKER))
      .join('\n');
    fs.writeFileSync(f, text);
  }
  return [...status.installed, ...status.huskyIntegrated];
}

/** Add a guarded call to the runner in husky-style hook files (committed, so it must no-op for teammates without the extension). */
export async function integrateWithHusky(root: string, opts: Omit<InstallOptions, 'force'>): Promise<string[]> {
  const hooksPath = await getConfigValue(root, 'core.hooksPath');
  if (!hooksPath) return [];
  await installRunner(root, opts.runnerSource, opts.version);
  const dir = huskyUserDir(path.resolve(root, hooksPath));
  const touched: string[] = [];
  for (const s of opts.stages) {
    const f = path.join(dir, s);
    const arg = s === 'commit-msg' ? ' "$1"' : '';
    const line = `R="$(git rev-parse --git-common-dir)/tollgate/${RUNNER_FILE}"; [ -f "$R" ] && command -v node >/dev/null 2>&1 && { node "$R" hook ${s}${arg} || exit 1; } ${HUSKY_MARKER}`;
    let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '#!/usr/bin/env sh\n';
    if (text.includes(HUSKY_MARKER)) continue;
    if (!text.endsWith('\n')) text += '\n';
    fs.writeFileSync(f, text + line + '\n', { mode: 0o755 });
    touched.push(path.relative(root, f));
  }
  return touched;
}
