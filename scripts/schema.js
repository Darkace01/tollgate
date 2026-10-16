// Single source of truth for the configuration schema.
// `node scripts/schema.js` writes schemas/tollgaterc.schema.json and syncs package.json "contributes.configuration".
const fs = require('node:fs');
const path = require('node:path');

const severity = { type: 'string', enum: ['error', 'warning'], description: '`error` blocks the commit, `warning` only reports.' };
const stage = { type: 'string', enum: ['pre-commit', 'commit-msg', 'pre-push'] };
const globs = (description) => ({ type: 'array', items: { type: 'string' }, description });
const base = (desc, extra = {}, defaults = {}) => ({
  type: 'object',
  description: desc,
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', description: 'Turn this check on or off.', default: defaults.enabled },
    severity: { ...severity, default: defaults.severity },
    exclude: globs('Globs (relative to repo root) this check ignores, on top of the global `exclude`.'),
    ...extra,
  },
});
const patternRule = {
  type: 'object',
  required: ['pattern'],
  properties: {
    name: { type: 'string' },
    pattern: { type: 'string', description: 'JavaScript regular expression.' },
    flags: { type: 'string', description: 'RegExp flags, e.g. "i".' },
    glob: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Only apply to matching files.' },
    message: { type: 'string' },
  },
};

const checks = {
  type: 'object',
  description: 'Built-in checks. Each one can be enabled/disabled and tuned. Unset values come from the preset.',
  additionalProperties: false,
  properties: {
    npmScripts: base(
      'Run package.json scripts (lint, typecheck, format:check…) when they exist.',
      {
        scripts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Script names to run, in order, if present in package.json.',
          default: ['lint', 'lint:check', 'typecheck', 'type-check', 'check-types', 'tsc', 'format:check', 'prettier:check'],
        },
        scope: {
          type: 'string',
          enum: ['root', 'affected'],
          description: '`root`: repo-root package.json only. `affected`: nearest package.json of each staged file (monorepos).',
          default: 'root',
        },
        stage: { ...stage, description: 'Which git hook runs the scripts.', default: 'pre-commit' },
        passStagedFiles: { type: 'boolean', description: 'Append staged files as arguments (npm run lint -- a.ts b.ts).', default: false },
        fileExtensions: { type: 'array', items: { type: 'string' }, description: 'Staged files that make scripts relevant.' },
        alwaysRun: { type: 'boolean', description: 'Run even if no staged file matches fileExtensions.', default: false },
        timeoutSec: { type: 'number', minimum: 1, default: 300 },
      },
      { enabled: true, severity: 'error' },
    ),
    lintStaged: {
      type: 'object',
      additionalProperties: false,
      description: 'Run lint-staged.',
      properties: {
        enabled: { oneOf: [{ type: 'boolean' }, { const: 'auto' }], description: '`auto` runs only when a lint-staged config exists.', default: 'auto' },
        severity,
        timeoutSec: { type: 'number', minimum: 1, default: 300 },
      },
    },
    dotnet: {
      type: 'object',
      additionalProperties: false,
      description: 'C# / .NET: dotnet format, dotnet build, CSharpier and dotnet test. `auto` turns on when a .sln/.slnx/.csproj/.vbproj/.fsproj exists.',
      properties: {
        enabled: {
          oneOf: [{ type: 'boolean' }, { const: 'auto' }],
          default: 'auto',
          description: '`auto` runs when the repo contains a .NET solution or project.',
        },
        severity,
        target: {
          type: 'string',
          description:
            'Solution or project to use, relative to the repo root (e.g. "src/Acme.sln"). Auto-detected when empty: the root solution, else the projects owning the staged files.',
        },
        fileExtensions: { type: 'array', items: { type: 'string' }, description: 'Staged files that make the .NET checks relevant.' },
        exclude: globs('Globs to ignore, on top of the global `exclude`.'),
        timeoutSec: { type: 'number', minimum: 1, default: 600 },
        format: {
          type: 'object',
          additionalProperties: false,
          description: '`dotnet format --verify-no-changes` on staged C#/VB files (respects .editorconfig).',
          properties: {
            enabled: { type: 'boolean', default: true },
            mode: {
              type: 'string',
              enum: ['auto', 'all', 'whitespace', 'style', 'analyzers'],
              default: 'auto',
              description: '`auto` = `all`, or `style` when CSharpier handles formatting. `whitespace` is the fastest (no MSBuild).',
            },
            applyFixes: { type: 'boolean', default: false, description: 'Format fully-staged files and re-stage them instead of failing.' },
          },
        },
        build: {
          type: 'object',
          additionalProperties: false,
          description: '`dotnet build` — catches compile errors before they reach the repo.',
          properties: {
            enabled: { type: 'boolean', default: true },
            configuration: { type: 'string', default: 'Debug' },
            warningsAsErrors: { type: 'boolean', default: false, description: 'Pass -warnaserror (on in the strict preset).' },
            extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra arguments, e.g. ["--no-restore"].' },
          },
        },
        test: {
          type: 'object',
          additionalProperties: false,
          description: '`dotnet test` (off by default; on at pre-push in the strict preset).',
          properties: {
            enabled: { type: 'boolean', default: false },
            stage: { ...stage, default: 'pre-push' },
            filter: { type: 'string', description: 'dotnet test --filter expression, e.g. "Category!=Integration".' },
            extraArgs: { type: 'array', items: { type: 'string' } },
          },
        },
        csharpier: {
          type: 'object',
          additionalProperties: false,
          description: 'CSharpier formatting check (https://csharpier.com).',
          properties: {
            enabled: {
              oneOf: [{ type: 'boolean' }, { const: 'auto' }],
              default: 'auto',
              description: '`auto` runs when CSharpier is in .config/dotnet-tools.json or a .csharpierrc file exists.',
            },
            applyFixes: { type: 'boolean', default: false, description: 'Format fully-staged files and re-stage them.' },
          },
        },
      },
    },
    prettier: {
      type: 'object',
      additionalProperties: false,
      description: 'Run Prettier (https://prettier.io) on staged files.',
      properties: {
        enabled: {
          oneOf: [{ type: 'boolean' }, { const: 'auto' }],
          description:
            '`auto` runs when a Prettier config (.prettierrc*, prettier.config.*, package.json "prettier") or the prettier dependency exists, and no package.json script already runs prettier.',
          default: 'auto',
        },
        severity,
        applyFixes: {
          type: 'boolean',
          default: false,
          description: 'Format fully-staged files with --write and re-stage them (partially-staged files are only checked).',
        },
        exclude: globs('Globs Prettier should skip (in addition to .prettierignore).'),
        extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra CLI arguments, e.g. ["--config", "config/.prettierrc"].' },
        timeoutSec: { type: 'number', minimum: 1, default: 300 },
      },
    },
    biome: {
      type: 'object',
      additionalProperties: false,
      description: 'Run Biome (https://biomejs.dev) on staged files.',
      properties: {
        enabled: {
          oneOf: [{ type: 'boolean' }, { const: 'auto' }],
          description: '`auto` runs when biome.json(c) or @biomejs/biome is present and no package.json script already runs biome.',
          default: 'auto',
        },
        severity,
        mode: { type: 'string', enum: ['check', 'lint', 'format'], default: 'check', description: '`check` = lint + format + organise imports.' },
        applyFixes: { type: 'boolean', default: false, description: 'Run with --write and re-stage fully-staged files.' },
        extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra CLI arguments, e.g. ["--diagnostic-level=error"].' },
        timeoutSec: { type: 'number', minimum: 1, default: 300 },
      },
    },
    secrets: base(
      'Detect API keys, tokens, private keys and hard-coded credentials in added lines.',
      {
        extraPatterns: {
          type: 'array',
          items: patternRule,
          description:
            'Additional secret patterns. If a pattern has a capture group, group 1 is treated as the secret value (placeholders such as "changeme" or "${VAR}" are then ignored).',
        },
        allowlist: {
          type: 'array',
          items: { type: 'string' },
          description: 'Regexes; matching lines are ignored. Inline: add `tollgate-ignore` or `pragma: allowlist secret` to a line.',
        },
      },
      { enabled: true, severity: 'error' },
    ),
    conflictMarkers: base('Block unresolved merge conflict markers.', {}, { enabled: true, severity: 'error' }),
    debugStatements: base(
      'Find console.log, debugger, .only tests, pdb, binding.pry…',
      {
        patterns: { type: 'array', items: patternRule, description: 'Replaces the default patterns.' },
      },
      { enabled: true, severity: 'warning' },
    ),
    todoComments: base(
      'Report newly added TODO/FIXME comments.',
      {
        keywords: { type: 'array', items: { type: 'string' }, default: ['TODO', 'FIXME', 'XXX', 'HACK'] },
      },
      { enabled: false, severity: 'warning' },
    ),
    trailingWhitespace: base('Trailing spaces/tabs on added lines (auto-fixable).', {}, { enabled: false, severity: 'warning' }),
    eofNewline: base('Files must end with a newline (auto-fixable).', {}, { enabled: false, severity: 'warning' }),
    jsonSyntax: base(
      'Staged .json files must parse.',
      {
        allowComments: globs(
          'Files parsed as JSON with comments and trailing commas (appsettings.json, launchSettings.json, tsconfig.json, .vscode/**, *.jsonc…).',
        ),
      },
      { enabled: true, severity: 'error' },
    ),
    largeFiles: base('Block files over a size limit.', { maxSizeKB: { type: 'number', minimum: 1, default: 1024 } }, { enabled: true, severity: 'error' }),
    forbiddenFiles: base(
      'Block files that should never be committed (.env, keys…).',
      {
        patterns: globs('Glob patterns; prefix with ! to allow (e.g. "!.env.example").'),
      },
      { enabled: true, severity: 'error' },
    ),
    protectedBranches: base(
      'Warn/block when committing directly to protected branches.',
      {
        branches: { type: 'array', items: { type: 'string' }, description: 'Branch names or globs (release/*).', default: ['main', 'master'] },
      },
      { enabled: true, severity: 'warning' },
    ),
    branchName: base(
      'Branch names must match a pattern.',
      {
        pattern: { type: 'string', description: 'RegExp.' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Exempt branches.' },
      },
      { enabled: false, severity: 'warning' },
    ),
    commitMessage: base(
      'Validate the commit message (commit-msg hook).',
      {
        preset: { type: 'string', enum: ['conventional', 'none'], default: 'conventional', description: '`conventional` = Conventional Commits.' },
        pattern: { type: 'string', description: 'Extra RegExp the whole message must match (multiline).' },
        types: { type: 'array', items: { type: 'string' }, description: 'Allowed Conventional Commit types.' },
        minLength: { type: 'number', default: 10 },
        maxSubjectLength: {
          type: 'number',
          minimum: 0,
          default: 500,
          description: 'Maximum subject-line length (default 500; the strict preset uses 100). 0 = no limit.',
        },
        requireTicket: { type: 'boolean', default: false, description: 'Require a ticket reference such as ABC-123.' },
        ticketPattern: { type: 'string', default: '[A-Z][A-Z0-9]+-\\d+' },
        blankLineAfterSubject: { type: 'boolean', default: true },
      },
      { enabled: false, severity: 'error' },
    ),
  },
};

const custom = {
  type: 'array',
  description: 'Your own checks: any shell command. Placeholders: {files} (matching staged files), {root}, {branch}, {msgFile}, {stagedCount}.',
  items: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Stable id (used by SKIP=). Defaults to a slug of the name.' },
      name: { type: 'string' },
      command: { type: 'string', description: 'Shell command, e.g. "npx eslint --max-warnings 0 {files}".' },
      glob: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Only run when staged files match; {files} is filtered to these.',
      },
      stage: { ...stage, default: 'pre-commit' },
      severity: { ...severity, default: 'error' },
      enabled: { type: 'boolean', default: true },
      cwd: { type: 'string', description: 'Working directory relative to repo root.' },
      timeoutSec: { type: 'number', minimum: 1, default: 300 },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      alwaysRun: { type: 'boolean', description: 'Run even when no staged file matches.' },
      restage: { type: 'boolean', description: 'Re-stage files changed by this command (formatters with --write/--fix).' },
    },
  },
  default: [],
};

const top = {
  enabled: { type: 'boolean', default: true, description: 'Master switch. Set false to pause all checks.' },
  extends: {
    type: 'string',
    enum: ['minimal', 'recommended', 'strict', 'none'],
    default: 'recommended',
    description: 'Preset to start from; everything else overrides it.',
  },
  failOn: { type: 'string', enum: ['error', 'warning'], default: 'error', description: 'Lowest severity that blocks the commit.' },
  stopOnFirstFailure: { type: 'boolean', default: false, description: 'Stop remaining checks after the first blocking failure.' },
  concurrency: { type: 'number', minimum: 1, maximum: 16, default: 3, description: 'How many command checks run in parallel.' },
  exclude: { ...globs('Globs ignored by every file-based check. Replaces the default list.'), default: undefined },
  packageManager: {
    type: 'string',
    enum: ['auto', 'npm', 'yarn', 'pnpm', 'bun'],
    default: 'auto',
    description: 'Used for package.json scripts. `auto` detects from lockfiles / "packageManager".',
  },
  autoFix: {
    type: 'boolean',
    default: false,
    description: 'In the hook, auto-fix trailing whitespace / EOF newlines (when those checks are enabled) and re-stage fully-staged files.',
  },
  hooks: { type: 'array', items: stage, uniqueItems: true, default: ['pre-commit', 'commit-msg', 'pre-push'], description: 'Git hooks to install.' },
  checks,
  custom,
};

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Tollgate configuration',
  type: 'object',
  additionalProperties: false,
  properties: { $schema: { type: 'string' }, ...top },
};

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'schemas'), { recursive: true });
fs.writeFileSync(path.join(root, 'schemas', 'tollgaterc.schema.json'), JSON.stringify(schema, null, 2) + '\n');

// VS Code settings: shared config keys + editor-only UI keys.
const uiOnly = {
  autoInstallHooks: {
    type: 'string',
    enum: ['prompt', 'always', 'never'],
    enumDescriptions: ['Ask once per repository', 'Install silently', 'Never install automatically'],
    default: 'prompt',
    description: 'Install git hooks automatically when a repository is opened.',
  },
  notifyOn: { type: 'string', enum: ['failure', 'all', 'never'], default: 'failure', description: 'When to show a notification after a git hook runs.' },
  showDiagnostics: { type: 'boolean', default: true, description: 'Show findings in the Problems panel.' },
  showStatusBar: { type: 'boolean', default: true, description: 'Show the status bar item.' },
  showDisabledChecks: {
    type: 'boolean',
    default: true,
    description: 'List disabled checks in the Tollgate view so they can be enabled with one click.',
  },
  configTarget: {
    type: 'string',
    enum: ['auto', 'settings', 'file'],
    default: 'auto',
    enumDescriptions: ['.tollgaterc.json if it exists, otherwise workspace settings', 'Always workspace settings', 'Always .tollgaterc.json'],
    description: 'Where changes made from the UI (toggle, add check, preset) are saved.',
  },
};
const properties = {};
let order = 0;
for (const [k, v] of Object.entries({ ...top, ...uiOnly })) {
  const p = { ...v, order: order++ };
  if (k === 'checks') {
    p.markdownDescription =
      'Built-in checks. Edit in settings.json, e.g. `"tollgate.checks": { "todoComments": { "enabled": true } }`. Values in `.tollgaterc.json` take precedence.';
    p.default = {};
  }
  if (k === 'custom')
    p.markdownDescription = 'Custom command checks. Example: `{ "name": "Prettier", "command": "npx prettier --check {files}", "glob": "**/*.{ts,tsx}" }`';
  if (p.default === undefined) p.default = undefined;
  if (['enabled', 'extends', 'failOn', 'hooks', 'checks', 'custom', 'exclude', 'autoFix', 'packageManager', 'stopOnFirstFailure', 'concurrency'].includes(k))
    p.scope = 'resource';
  properties[`tollgate.${k}`] = p;
}
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.contributes.configuration = { title: 'Tollgate', properties };
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
console.log('schema + package.json configuration synced');
