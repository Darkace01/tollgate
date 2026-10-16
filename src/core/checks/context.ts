import type { FileSet } from '../git';
import { matchesAny } from '../glob';
import type { CheckStatus, Finding, GuardConfig, Severity, Stage } from '../types';

export interface CheckContext {
  root: string;
  config: GuardConfig;
  stage: Stage;
  mode: 'staged' | 'all';
  branch: string;
  msgFile?: string;
  signal: AbortSignal;
  fileSet: () => Promise<FileSet>;
  /** Files changed relative to the upstream (pre-push only). */
  pushFiles: () => Promise<string[]>;
}

export interface CheckOutcome {
  status: CheckStatus;
  summary: string;
  findings?: Finding[];
  output?: string;
  command?: string;
  fixable?: boolean;
}

export interface CheckDef {
  id: string;
  name: string;
  stage: Stage;
  severity: Severity;
  /** Built-ins are cheap and run first; commands share the concurrency pool. */
  kind: 'builtin' | 'command';
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export const INLINE_IGNORE = /precommit-guard-ignore|pragma:\s*allowlist secret|gitleaks:allow/;

export function isExcluded(ctx: CheckContext, file: string, extra?: string[]): boolean {
  return matchesAny(file, ctx.config.exclude) || (!!extra && matchesAny(file, extra));
}

export function outcome(findings: Finding[], okSummary: string, failNoun: string, extra: Partial<CheckOutcome> = {}): CheckOutcome {
  if (!findings.length) return { status: 'passed', summary: okSummary, findings: [], ...extra };
  const files = new Set(findings.map((f) => f.file).filter(Boolean)).size;
  return {
    status: 'failed',
    summary: `${findings.length} ${failNoun}${findings.length === 1 ? '' : 's'}${files ? ` in ${files} file${files === 1 ? '' : 's'}` : ''}`,
    findings,
    ...extra,
  };
}
