import type { CheckResult, RunReport } from './types';

export interface FormatOptions {
  color: boolean;
  verbose?: boolean;
  maxFindings?: number;
}

const codes = { red: 31, green: 32, yellow: 33, gray: 90, bold: 1, cyan: 36 } as const;

export function formatReport(report: RunReport, opts: FormatOptions): string {
  const paint = (c: keyof typeof codes, s: string) => (opts.color ? `\u001b[${codes[c]}m${s}\u001b[0m` : s);
  const max = opts.maxFindings ?? 15;
  const lines: string[] = [];
  lines.push(paint('bold', `▸ Pre-Commit Guard · ${report.stage}`));
  if (report.fixedFiles?.length) lines.push(paint('cyan', `  ✎ auto-fixed and re-staged ${report.fixedFiles.length} file(s)`));
  if (!report.results.length) lines.push(paint('gray', '  (no checks configured for this stage)'));

  const icon = (r: CheckResult) => {
    switch (r.status) {
      case 'passed':
        return paint('green', '✔');
      case 'skipped':
        return paint('gray', '○');
      default:
        return r.severity === 'error' ? paint('red', '✖') : paint('yellow', '⚠');
    }
  };
  const width = Math.min(42, Math.max(...report.results.map((r) => r.name.length), 10));
  for (const r of report.results) {
    const dur = r.durationMs >= 100 && !r.summary.startsWith('Passed in') ? paint('gray', ` ${(r.durationMs / 1000).toFixed(1)}s`) : '';
    lines.push(`  ${icon(r)} ${r.name.padEnd(width)}  ${r.status === 'passed' || r.status === 'skipped' ? paint('gray', r.summary) : r.summary}${dur}`);
    if (r.status === 'failed' || r.status === 'error') {
      for (const f of r.findings.slice(0, max)) {
        const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}${f.column ? `:${f.column}` : ''}` : '';
        lines.push(`      ${loc ? paint('cyan', loc) + '  ' : ''}${f.message}`);
      }
      if (r.findings.length > max) lines.push(paint('gray', `      … and ${r.findings.length - max} more`));
      if (!r.findings.length && r.output?.trim()) {
        const out = r.output.trim().split(/\r?\n/);
        const tail = opts.verbose ? out : out.slice(-20);
        if (tail.length < out.length) lines.push(paint('gray', `      … ${out.length - tail.length} earlier lines`));
        for (const l of tail) lines.push('      ' + paint('gray', '│ ') + l);
      }
    }
  }
  const failed = report.results.filter((r) => r.status === 'failed' || r.status === 'error');
  lines.push('');
  if (report.blocked) {
    lines.push(
      paint('red', `✖ ${report.stage} blocked: ${failed.filter((r) => r.severity === 'error').length || failed.length} check(s) failed`) +
        paint('gray', `  (${(report.durationMs / 1000).toFixed(1)}s)`),
    );
    lines.push(paint('gray', '  Skip one check:  SKIP=<id> git commit …   Skip all:  git commit --no-verify'));
    lines.push(paint('gray', `  Failed ids: ${failed.map((r) => r.id).join(', ')}`));
  } else if (failed.length) {
    lines.push(paint('yellow', `⚠ passed with ${failed.length} warning(s)`) + paint('gray', `  (${(report.durationMs / 1000).toFixed(1)}s)`));
  } else {
    lines.push(paint('green', '✔ all checks passed') + paint('gray', `  (${(report.durationMs / 1000).toFixed(1)}s)`));
  }
  return lines.join('\n');
}
