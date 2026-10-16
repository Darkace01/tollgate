export type Severity = 'error' | 'warning';
export type Stage = 'pre-commit' | 'commit-msg' | 'pre-push';
export type Preset = 'minimal' | 'recommended' | 'strict' | 'none';
export type PackageManager = 'auto' | 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface BaseCheckConfig {
  enabled: boolean;
  severity: Severity;
  /** Globs (relative to repo root) this check should ignore, on top of the global `exclude`. */
  exclude?: string[];
}

export interface PatternRule {
  name?: string;
  pattern: string;
  flags?: string;
  /** Only apply to files matching these globs. */
  glob?: string | string[];
  message?: string;
}

export interface NpmScriptsConfig extends BaseCheckConfig {
  /** Script names to run when present in package.json, in order. */
  scripts: string[];
  /** `root` = repo root package.json only, `affected` = nearest package.json of every staged file. */
  scope: 'root' | 'affected';
  stage: Stage;
  /** Append staged files (filtered by `fileExtensions`) as arguments: `npm run lint -- a.ts b.ts`. */
  passStagedFiles: boolean;
  fileExtensions: string[];
  /** Run even when no staged file matches `fileExtensions`. */
  alwaysRun: boolean;
  timeoutSec: number;
}

export interface LintStagedConfig {
  /** `auto` runs only when a lint-staged config is found. */
  enabled: boolean | 'auto';
  severity: Severity;
  timeoutSec: number;
}

export interface BiomeConfig {
  /** `auto` runs when biome.json(c) or @biomejs/biome is found and no npm script already runs biome. */
  enabled: boolean | 'auto';
  severity: Severity;
  /** `check` = lint + format + import sorting, `lint` = lint only, `format` = formatting only. */
  mode: 'check' | 'lint' | 'format';
  /** Apply safe fixes (--write) and re-stage fully-staged files. */
  applyFixes: boolean;
  extraArgs: string[];
  timeoutSec: number;
}

export interface PrettierConfig {
  /** `auto` runs when a Prettier config or the prettier dependency is found and no npm script already runs prettier. */
  enabled: boolean | 'auto';
  severity: Severity;
  exclude?: string[];
  /** Format fully-staged files with --write and re-stage them instead of only checking. */
  applyFixes: boolean;
  extraArgs: string[];
  timeoutSec: number;
}

export interface SecretsConfig extends BaseCheckConfig {
  extraPatterns: PatternRule[];
  /** Regexes; a matched line that also matches any of these is ignored. */
  allowlist: string[];
}

export interface DebugStatementsConfig extends BaseCheckConfig {
  patterns: PatternRule[];
}

export interface TodoConfig extends BaseCheckConfig {
  keywords: string[];
}

export interface LargeFilesConfig extends BaseCheckConfig {
  maxSizeKB: number;
}

export interface ForbiddenFilesConfig extends BaseCheckConfig {
  patterns: string[];
}

export interface ProtectedBranchesConfig extends BaseCheckConfig {
  branches: string[];
}

export interface BranchNameConfig extends BaseCheckConfig {
  pattern: string;
  /** Branches that never have to match (e.g. main). */
  ignore: string[];
}

export interface CommitMessageConfig extends BaseCheckConfig {
  preset: 'conventional' | 'none';
  pattern?: string;
  types: string[];
  minLength: number;
  /** Maximum subject-line length; 0 = no limit. */
  maxSubjectLength: number;
  requireTicket: boolean;
  ticketPattern: string;
  /** Require a blank line between subject and body. */
  blankLineAfterSubject: boolean;
}

export interface CustomCheck {
  id?: string;
  name: string;
  /** Shell command. Placeholders: {files} {root} {branch} {msgFile} {stagedCount}. */
  command: string;
  glob?: string | string[];
  stage?: Stage;
  severity?: Severity;
  enabled?: boolean;
  cwd?: string;
  timeoutSec?: number;
  env?: Record<string, string>;
  /** Run even if no staged file matches `glob`. */
  alwaysRun?: boolean;
  /** Re-stage files modified by this command (for formatters). */
  restage?: boolean;
}

export interface ChecksConfig {
  npmScripts: NpmScriptsConfig;
  lintStaged: LintStagedConfig;
  biome: BiomeConfig;
  prettier: PrettierConfig;
  secrets: SecretsConfig;
  conflictMarkers: BaseCheckConfig;
  debugStatements: DebugStatementsConfig;
  todoComments: TodoConfig;
  trailingWhitespace: BaseCheckConfig;
  eofNewline: BaseCheckConfig;
  jsonSyntax: BaseCheckConfig;
  largeFiles: LargeFilesConfig;
  forbiddenFiles: ForbiddenFilesConfig;
  protectedBranches: ProtectedBranchesConfig;
  branchName: BranchNameConfig;
  commitMessage: CommitMessageConfig;
}

export type CheckId = keyof ChecksConfig;

export interface GuardConfig {
  enabled: boolean;
  extends: Preset;
  /** Which severity blocks the commit. `warning` blocks on warnings too. */
  failOn: Severity;
  stopOnFirstFailure: boolean;
  concurrency: number;
  /** Globs ignored by every file-based check. */
  exclude: string[];
  packageManager: PackageManager;
  /** Auto-fix trailing whitespace / missing EOF newline in the hook and re-stage fully-staged files. */
  autoFix: boolean;
  /** Git hooks to install. */
  hooks: Stage[];
  checks: ChecksConfig;
  custom: CustomCheck[];
}

export interface Finding {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  rule?: string;
}

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface CheckResult {
  id: string;
  name: string;
  stage: Stage;
  severity: Severity;
  status: CheckStatus;
  summary: string;
  durationMs: number;
  findings: Finding[];
  output?: string;
  command?: string;
  fixable?: boolean;
}

export interface RunReport {
  version: 1;
  repoRoot: string;
  stage: Stage;
  source: 'hook' | 'vscode' | 'cli';
  startedAt: string;
  durationMs: number;
  blocked: boolean;
  results: CheckResult[];
  fixedFiles?: string[];
}
