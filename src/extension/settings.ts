import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type PartialConfig, stripJsonComments } from '../core/config';

export const SECTION = 'tollgate';

/** Keys that map 1:1 onto GuardConfig and are shared with the git hook runner. */
const CONFIG_KEYS = [
  'enabled',
  'extends',
  'failOn',
  'stopOnFirstFailure',
  'concurrency',
  'exclude',
  'packageManager',
  'autoFix',
  'hooks',
  'checks',
  'custom',
] as const;

/** Only explicitly-set values, so presets/defaults in the core still apply. */
export function editorSettings(folder?: vscode.Uri): PartialConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION, folder);
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const i = cfg.inspect(key);
    if (!i) continue;
    const layers = [i.globalValue, i.workspaceValue, i.workspaceFolderValue].filter((v) => v !== undefined);
    if (!layers.length) continue;
    // Objects merge across scopes (user → workspace → folder); everything else: most specific wins.
    if (key === 'checks') {
      out[key] = layers.reduce((acc: Record<string, unknown>, v) => {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) acc[k] = { ...(acc[k] as object), ...(val as object) };
        return acc;
      }, {});
    } else out[key] = layers[layers.length - 1];
  }
  return out as PartialConfig;
}

export function uiSetting<T>(key: string, folder?: vscode.Uri): T {
  return vscode.workspace.getConfiguration(SECTION, folder).get<T>(key) as T;
}

export const repoConfigFile = (root: string) => path.join(root, '.tollgaterc.json');

function writeTarget(root: string): 'file' | 'settings' {
  const pref = uiSetting<string>('configTarget');
  if (pref === 'file') return 'file';
  if (pref === 'settings') return 'settings';
  return fs.existsSync(repoConfigFile(root)) ? 'file' : 'settings';
}

function readRc(root: string): Record<string, unknown> {
  const f = repoConfigFile(root);
  if (!fs.existsSync(f)) return {};
  return JSON.parse(stripJsonComments(fs.readFileSync(f, 'utf8')));
}

function writeRc(root: string, data: Record<string, unknown>): void {
  fs.writeFileSync(repoConfigFile(root), JSON.stringify(data, null, 2) + '\n');
}

function setPath(obj: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cur = obj;
  for (const k of keyPath.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keyPath[keyPath.length - 1]] = value;
}

/**
 * Update a config value (e.g. ['checks','secrets','enabled']) in the right place:
 * .tollgaterc.json when it exists (team config), otherwise workspace settings.
 * Returns where it was written.
 */
export async function updateConfigValue(root: string, folder: vscode.Uri | undefined, keyPath: string[], value: unknown): Promise<string> {
  if (writeTarget(root) === 'file') {
    const data = readRc(root);
    setPath(data, keyPath, value);
    writeRc(root, data);
    return '.tollgaterc.json';
  }
  const cfg = vscode.workspace.getConfiguration(SECTION, folder);
  const [top, ...rest] = keyPath;
  const target =
    folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
  if (!rest.length) {
    await cfg.update(top, value, target);
    return 'workspace settings';
  }
  const i = cfg.inspect<Record<string, unknown>>(top);
  const current = structuredClone((target === vscode.ConfigurationTarget.WorkspaceFolder ? i?.workspaceFolderValue : i?.workspaceValue) ?? {}) as Record<
    string,
    unknown
  >;
  setPath(current, rest, value);
  await cfg.update(top, current, target);
  return 'workspace settings';
}

/** Append a custom check to the right place. */
export async function addCustom(root: string, folder: vscode.Uri | undefined, check: Record<string, unknown>): Promise<string> {
  if (writeTarget(root) === 'file') {
    const data = readRc(root);
    data.custom = [...((data.custom as unknown[]) ?? []), check];
    writeRc(root, data);
    return '.tollgaterc.json';
  }
  const cfg = vscode.workspace.getConfiguration(SECTION, folder);
  const existing = cfg.inspect<unknown[]>('custom')?.workspaceValue ?? [];
  await cfg.update('custom', [...existing, check], vscode.ConfigurationTarget.Workspace);
  return 'workspace settings';
}

export async function updateCustom(
  root: string,
  folder: vscode.Uri | undefined,
  check: { id?: string; name: string },
  patch: Record<string, unknown>,
): Promise<string | undefined> {
  const key = check.id ?? check.name;
  const match = (c: Record<string, unknown>) => (c.id ?? c.name) === key;
  const data = readRc(root);
  if (Array.isArray(data.custom) && data.custom.some(match)) {
    data.custom = data.custom.map((c: Record<string, unknown>) => (match(c) ? { ...c, ...patch } : c));
    writeRc(root, data);
    return '.tollgaterc.json';
  }
  const cfg = vscode.workspace.getConfiguration(SECTION, folder);
  const i = cfg.inspect<Record<string, unknown>[]>('custom');
  for (const [value, target] of [
    [i?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [i?.globalValue, vscode.ConfigurationTarget.Global],
  ] as const) {
    if (value?.some(match)) {
      await cfg.update(
        'custom',
        value.map((c) => (match(c) ? { ...c, ...patch } : c)),
        target,
      );
      return target === vscode.ConfigurationTarget.Global ? 'user settings' : 'workspace settings';
    }
  }
  // Defined in package.json#tollgate — override by name in workspace settings.
  const override = check.id ? { id: check.id, ...patch } : { name: check.name, ...patch };
  await cfg.update('custom', [...(i?.workspaceValue ?? []), override], vscode.ConfigurationTarget.Workspace);
  return 'workspace settings';
}
