import * as fs from 'node:fs';
import * as path from 'node:path';
import { customCheckId } from './checks/commands';
import { isDotnetRepo } from './checks/dotnet';
import { stripJsonComments } from './config';
import { collectChecks } from './engine';
import type { ChecksConfig, CustomCheck, GuardConfig, Severity, Stage } from './types';

/**
 * Editor-independent view of every check (enabled and disabled), plus how to toggle it.
 * Used by `runner list --json`, which IDE integrations (e.g. Visual Studio) consume.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  stage: Stage;
  enabled: boolean;
  severity: Severity;
  kind: 'builtin' | 'command' | 'custom';
  /** Built-in config key this entry belongs to (e.g. "secrets", "dotnet", "npmScripts"). */
  group?: keyof ChecksConfig;
  description?: string;
}

const LABELS: Record<keyof ChecksConfig, string> = {
  npmScripts: 'package.json scripts',
  lintStaged: 'lint-staged',
  biome: 'Biome',
  prettier: 'Prettier',
  dotnet: '.NET (C#)',
  secrets: 'Secrets & credentials',
  conflictMarkers: 'Merge conflict markers',
  debugStatements: 'Debug statements',
  todoComments: 'TODO / FIXME comments',
  trailingWhitespace: 'Trailing whitespace',
  eofNewline: 'Newline at end of file',
  jsonSyntax: 'JSON syntax',
  largeFiles: 'Large files',
  forbiddenFiles: 'Forbidden files',
  protectedBranches: 'Protected branches',
  branchName: 'Branch naming',
  commitMessage: 'Commit message format',
};
export const CHECK_LABELS = LABELS;

const DOTNET_PARTS = ['format', 'build', 'test', 'csharpier'] as const;
type DotnetPart = (typeof DOTNET_PARTS)[number];
const DOTNET_LABELS: Record<DotnetPart, string> = { format: 'dotnet format', build: 'dotnet build', test: 'dotnet test', csharpier: 'CSharpier' };

function builtinStage(key: keyof ChecksConfig, config: GuardConfig): Stage {
  if (key === 'commitMessage') return 'commit-msg';
  if (key === 'npmScripts') return config.checks.npmScripts.stage;
  return 'pre-commit';
}

export async function buildCatalog(config: GuardConfig, root: string, getFiles: () => Promise<string[]>): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const stage of ['pre-commit', 'commit-msg', 'pre-push'] as Stage[]) {
    for (const d of await collectChecks(config, root, stage, getFiles)) {
      const prefix = d.id.split(':')[0];
      const group = (d.id in config.checks ? d.id : prefix in config.checks ? prefix : undefined) as keyof ChecksConfig | undefined;
      out.push({ id: d.id, name: d.name, stage, enabled: true, severity: d.severity, kind: d.id.startsWith('custom:') ? 'custom' : d.kind, group });
      seen.add(d.id);
    }
  }
  for (const key of Object.keys(config.checks) as (keyof ChecksConfig)[]) {
    const c = config.checks[key] as { enabled: boolean | 'auto'; severity: Severity };
    if (c.enabled === false && !seen.has(key)) {
      out.push({ id: key, name: LABELS[key], stage: builtinStage(key, config), enabled: false, severity: c.severity, kind: 'builtin', group: key });
    }
  }
  const dn = config.checks.dotnet;
  if (dn.enabled === true || (dn.enabled === 'auto' && (await isDotnetRepo(root)))) {
    const state: Record<DotnetPart, [boolean, Stage]> = {
      format: [dn.format.enabled, 'pre-commit'],
      build: [dn.build.enabled, 'pre-commit'],
      test: [dn.test.enabled, dn.test.stage],
      csharpier: [dn.csharpier.enabled !== false, 'pre-commit'],
    };
    for (const part of DOTNET_PARTS) {
      const [on, stage] = state[part];
      if (!on && !seen.has(`dotnet:${part}`)) {
        out.push({ id: `dotnet:${part}`, name: DOTNET_LABELS[part], stage, enabled: false, severity: dn.severity, kind: 'command', group: 'dotnet' });
      }
    }
  }
  for (const c of config.custom) {
    const id = customCheckId(c);
    if (c.enabled === false && c.command && !seen.has(id)) {
      out.push({ id, name: c.name, stage: c.stage ?? 'pre-commit', enabled: false, severity: c.severity ?? 'error', kind: 'custom' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- .tollgaterc.json editing

export const RC_FILE = '.tollgaterc.json';
export const LOCAL_RC_FILE = '.tollgaterc.local.json';

export function readRc(root: string, file = RC_FILE): Record<string, unknown> {
  const f = path.join(root, file);
  if (!fs.existsSync(f)) return {};
  return JSON.parse(stripJsonComments(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')));
}

export function writeRc(root: string, data: Record<string, unknown>, file = RC_FILE): void {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
}

export function setPath(obj: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cur = obj;
  for (const k of keyPath.slice(0, -1)) {
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keyPath[keyPath.length - 1]] = value;
}

/** `config set checks.secrets.severity '"warning"'` — value is JSON (bare words are treated as strings). */
export function setConfigValue(root: string, dottedPath: string, rawValue: string, file = RC_FILE): void {
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  const data = readRc(root, file);
  setPath(data, dottedPath.split('.').filter(Boolean), value);
  writeRc(root, data, file);
}

/**
 * Enable/disable a check by id, writing to .tollgaterc.json:
 * built-ins → checks.<id>.enabled · dotnet:<part> → checks.dotnet.<part>.enabled ·
 * npmScripts:<script> → checks.npmScripts.scripts · custom:<id> → custom[].enabled (override by id/name).
 */
export function toggleCheck(root: string, config: GuardConfig, id: string, enabled: boolean, file = RC_FILE): string {
  const data = readRc(root, file);
  const [prefix, ...rest] = id.split(':');
  const sub = rest.join(':');
  if (prefix === 'dotnet' && (DOTNET_PARTS as readonly string[]).includes(sub)) {
    setPath(data, ['checks', 'dotnet', sub, 'enabled'], enabled);
  } else if (prefix === 'npmScripts' && sub) {
    const script = sub.split(':').pop()!;
    const scripts = config.checks.npmScripts.scripts.filter((s) => s !== script);
    setPath(data, ['checks', 'npmScripts', 'scripts'], enabled ? [...scripts, script] : scripts);
  } else if (prefix === 'custom' && sub) {
    const c = config.custom.find((x) => customCheckId(x) === id);
    if (!c) throw new Error(`Unknown custom check "${id}"`);
    const key = c.id ?? c.name;
    const list = (Array.isArray(data.custom) ? data.custom : []) as CustomCheck[];
    const i = list.findIndex((x) => (x.id ?? x.name) === key);
    if (i >= 0) list[i] = { ...list[i], enabled };
    else list.push(c.id ? ({ id: c.id, enabled } as CustomCheck) : ({ name: c.name, enabled } as CustomCheck));
    data.custom = list;
  } else if (id in config.checks) {
    setPath(data, ['checks', id, 'enabled'], enabled);
  } else {
    throw new Error(`Unknown check "${id}"`);
  }
  writeRc(root, data, file);
  return file;
}
