import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CustomCheck, GuardConfig, Preset } from './types';

export const CONFIG_FILES = ['.tollgaterc.json', '.tollgaterc.local.json'];
export const PACKAGE_JSON_KEY = 'tollgate';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type PartialConfig = DeepPartial<GuardConfig>;

/** Base defaults. Every field is defined here so checks never see undefined. */
export function baseDefaults(): GuardConfig {
  return {
    enabled: true,
    extends: 'recommended',
    failOn: 'error',
    stopOnFirstFailure: false,
    concurrency: 3,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.min.js',
      '**/*.map',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/bun.lock',
    ],
    packageManager: 'auto',
    autoFix: false,
    hooks: ['pre-commit', 'commit-msg', 'pre-push'],
    checks: {
      npmScripts: {
        enabled: true,
        severity: 'error',
        scripts: ['lint', 'lint:check', 'typecheck', 'type-check', 'check-types', 'tsc', 'format:check', 'prettier:check'],
        scope: 'root',
        stage: 'pre-commit',
        passStagedFiles: false,
        fileExtensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte'],
        alwaysRun: false,
        timeoutSec: 300,
      },
      lintStaged: { enabled: 'auto', severity: 'error', timeoutSec: 300 },
      biome: { enabled: 'auto', severity: 'error', mode: 'check', applyFixes: false, extraArgs: [], timeoutSec: 300 },
      prettier: { enabled: 'auto', severity: 'error', applyFixes: false, extraArgs: [], timeoutSec: 300 },
      secrets: { enabled: true, severity: 'error', extraPatterns: [], allowlist: [] },
      conflictMarkers: { enabled: true, severity: 'error' },
      debugStatements: {
        enabled: true,
        severity: 'warning',
        patterns: [
          { name: 'console.log', pattern: '\\bconsole\\.(log|debug|trace)\\s*\\(', glob: ['**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte}'] },
          { name: 'debugger', pattern: '^\\s*debugger\\s*;?\\s*$', glob: ['**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte}'] },
          { name: 'focused test', pattern: '\\b(it|describe|test)\\.only\\s*\\(|\\bf(it|describe)\\s*\\(', glob: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'] },
          { name: 'breakpoint()', pattern: '^\\s*(breakpoint\\(\\)|import pdb|pdb\\.set_trace\\(\\))', glob: ['**/*.py'] },
          { name: 'binding.pry', pattern: '\\bbinding\\.pry\\b', glob: ['**/*.rb'] },
        ],
      },
      todoComments: { enabled: false, severity: 'warning', keywords: ['TODO', 'FIXME', 'XXX', 'HACK'] },
      trailingWhitespace: { enabled: false, severity: 'warning', exclude: ['**/*.md'] },
      eofNewline: { enabled: false, severity: 'warning' },
      jsonSyntax: { enabled: true, severity: 'error', exclude: ['**/tsconfig*.json', '**/.vscode/**', '**/jsconfig*.json', '**/.devcontainer/**'] },
      largeFiles: { enabled: true, severity: 'error', maxSizeKB: 1024 },
      forbiddenFiles: {
        enabled: true,
        severity: 'error',
        patterns: [
          '.env',
          '.env.*',
          '!.env.example',
          '!.env.sample',
          '!.env.template',
          '*.pem',
          '*.key',
          '*.p12',
          '*.pfx',
          'id_rsa',
          'id_ed25519',
          '*.keystore',
          '.npmrc.local',
        ],
      },
      protectedBranches: { enabled: true, severity: 'warning', branches: ['main', 'master'] },
      branchName: {
        enabled: false,
        severity: 'warning',
        pattern: '^(feature|feat|fix|bugfix|hotfix|chore|docs|refactor|test|release)/[a-z0-9._-]+$',
        ignore: ['main', 'master', 'develop', 'dev', 'staging'],
      },
      commitMessage: {
        enabled: false,
        severity: 'error',
        preset: 'conventional',
        types: ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
        minLength: 10,
        maxSubjectLength: 500,
        requireTicket: false,
        ticketPattern: '[A-Z][A-Z0-9]+-\\d+',
        blankLineAfterSubject: true,
      },
    },
    custom: [],
  };
}

export function presetOverrides(preset: Preset): PartialConfig {
  switch (preset) {
    case 'minimal':
      return {
        checks: {
          debugStatements: { enabled: false },
          jsonSyntax: { enabled: false },
          protectedBranches: { enabled: false },
          lintStaged: { enabled: false },
          biome: { mode: 'lint' },
          npmScripts: { scripts: ['lint'] },
        },
      };
    case 'strict':
      return {
        failOn: 'error',
        checks: {
          debugStatements: { severity: 'error' },
          todoComments: { enabled: true, severity: 'warning' },
          trailingWhitespace: { enabled: true, severity: 'error' },
          eofNewline: { enabled: true, severity: 'error' },
          protectedBranches: { severity: 'error' },
          branchName: { enabled: true, severity: 'error' },
          commitMessage: { enabled: true, maxSubjectLength: 100 },
          largeFiles: { maxSizeKB: 500 },
          npmScripts: { scripts: ['lint', 'lint:check', 'typecheck', 'type-check', 'check-types', 'tsc', 'format:check', 'prettier:check', 'test'] },
        },
      };
    case 'none':
      return {
        checks: Object.fromEntries(Object.keys(baseDefaults().checks).map((k) => [k, { enabled: false }])) as PartialConfig['checks'],
      };
    default:
      return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, arrays and scalars replace. `custom` is merged by id/name. */
export function deepMerge<T>(target: T, source: unknown, keyPath = ''): T {
  if (!isPlainObject(source)) return target;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key === '$schema') continue;
    const full = keyPath ? `${keyPath}.${key}` : key;
    if (full === 'custom' && Array.isArray(value)) {
      out.custom = mergeCustom((out.custom as CustomCheck[]) ?? [], value as CustomCheck[]);
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value, full);
    } else {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out as T;
}

function mergeCustom(a: CustomCheck[], b: CustomCheck[]): CustomCheck[] {
  const result = [...a];
  for (const c of b) {
    const key = c.id ?? c.name;
    const i = result.findIndex((x) => (x.id ?? x.name) === key);
    if (i >= 0) result[i] = { ...result[i], ...c };
    else result.push(c);
  }
  return result;
}

function readJson(file: string): unknown | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

/** Allows // and /* *\/ comments and trailing commas in config files. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export interface ConfigSources {
  /** Settings coming from the editor (VS Code). Lowest priority after presets. */
  editorSettings?: PartialConfig;
  /** Path to a JSON snapshot of editor settings (used by the git hook runner). */
  editorSettingsFile?: string;
}

export interface LoadedConfig {
  config: GuardConfig;
  sources: string[];
}

/**
 * Resolution order (later wins):
 *   base defaults → preset (`extends`) → VS Code settings → package.json "tollgate"
 *   → .tollgaterc.json (team, committed) → .tollgaterc.local.json (personal, gitignored)
 */
export function loadConfig(repoRoot: string, sources: ConfigSources = {}): LoadedConfig {
  const used: string[] = ['defaults'];
  const layers: { name: string; data: unknown }[] = [];

  let editor: unknown = sources.editorSettings;
  if (!editor && sources.editorSettingsFile) editor = readJson(sources.editorSettingsFile);
  if (editor) layers.push({ name: 'VS Code settings', data: editor });

  const pkg = readJson(path.join(repoRoot, 'package.json')) as Record<string, unknown> | undefined;
  if (pkg && isPlainObject(pkg[PACKAGE_JSON_KEY])) layers.push({ name: `package.json#${PACKAGE_JSON_KEY}`, data: pkg[PACKAGE_JSON_KEY] });

  for (const f of CONFIG_FILES) {
    const data = readJson(path.join(repoRoot, f));
    if (data) layers.push({ name: f, data });
  }

  // `extends` can be set at any layer; the last one wins, then applied before all layers.
  let preset: Preset = 'recommended';
  for (const l of layers) {
    const ext = (l.data as PartialConfig).extends;
    if (ext) preset = ext as Preset;
  }

  let config = baseDefaults();
  config = deepMerge(config, presetOverrides(preset));
  config.extends = preset;
  if (preset !== 'recommended') used.push(`preset:${preset}`);
  for (const l of layers) {
    config = deepMerge(config, l.data);
    used.push(l.name);
  }
  config.extends = preset;
  return { config, sources: used };
}

export function sampleConfig(): Record<string, unknown> {
  return {
    extends: 'recommended',
    failOn: 'error',
    checks: {
      debugStatements: { severity: 'warning' },
      protectedBranches: { branches: ['main', 'master'] },
      commitMessage: { enabled: false, preset: 'conventional' },
      prettier: { applyFixes: false },
    },
    custom: [
      {
        name: 'Unit tests',
        command: 'npm test',
        stage: 'pre-push',
        severity: 'error',
        enabled: false,
      },
    ],
  };
}
