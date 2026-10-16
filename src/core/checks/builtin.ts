import * as fs from 'node:fs';
import { isBinary, isMergeInProgress } from '../git';
import { matchesAny } from '../glob';
import type { Finding, GuardConfig, PatternRule } from '../types';
import { type CheckContext, type CheckDef, type CheckOutcome, INLINE_IGNORE, isExcluded, outcome } from './context';

const MAX_FINDINGS = 500;

/** Iterate added lines of included text files. */
async function scanAddedLines(
  ctx: CheckContext,
  extraExclude: string[] | undefined,
  visit: (file: string, line: number, text: string, push: (f: Finding) => void) => void,
  fileFilter?: (file: string) => boolean,
): Promise<Finding[]> {
  const fs_ = await ctx.fileSet();
  const findings: Finding[] = [];
  const push = (f: Finding) => {
    if (findings.length < MAX_FINDINGS) findings.push(f);
  };
  for (const file of fs_.files) {
    if (ctx.signal.aborted || findings.length >= MAX_FINDINGS) break;
    if (isExcluded(ctx, file, extraExclude) || (fileFilter && !fileFilter(file))) continue;
    for (const { line, text } of await fs_.addedLines(file)) {
      if (INLINE_IGNORE.test(text)) continue;
      visit(file, line, text, push);
    }
  }
  return findings;
}

function compile(rule: PatternRule): RegExp | undefined {
  try {
    return new RegExp(rule.pattern, rule.flags ?? '');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- secrets

export const SECRET_RULES: PatternRule[] = [
  { name: 'AWS access key ID', pattern: '\\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\\b' },
  { name: 'AWS secret access key', pattern: 'aws.{0,20}(secret|private).{0,20}[\'"][0-9a-zA-Z/+]{40}[\'"]', flags: 'i' },
  { name: 'GitHub token', pattern: '\\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\\b' },
  { name: 'GitLab token', pattern: '\\bglpat-[A-Za-z0-9_-]{20,}\\b' },
  { name: 'Slack token', pattern: '\\bxox[abposr]-[A-Za-z0-9-]{10,}' },
  { name: 'Slack webhook', pattern: 'https://hooks\\.slack\\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+' },
  { name: 'Private key', pattern: '-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----' },
  { name: 'Google API key', pattern: '\\bAIza[0-9A-Za-z_-]{35}\\b' },
  { name: 'Stripe key', pattern: '\\b(sk|rk)_(live|test)_[0-9a-zA-Z]{24,}\\b' },
  { name: 'OpenAI key', pattern: '\\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}' },
  { name: 'Anthropic key', pattern: '\\bsk-ant-[A-Za-z0-9_-]{20,}' },
  { name: 'npm token', pattern: '\\bnpm_[A-Za-z0-9]{36}\\b' },
  { name: 'Azure storage key', pattern: 'AccountKey=[A-Za-z0-9+/=]{80,}' },
  { name: 'SendGrid key', pattern: '\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}\\b' },
  { name: 'Twilio key', pattern: '\\bSK[0-9a-fA-F]{32}\\b' },
  { name: 'JSON Web Token', pattern: '\\beyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}' },
  { name: 'Credentials in URL', pattern: '\\b[a-z][a-z0-9+.-]{1,20}://[^\\s:/@\'"]+:([^\\s:/@\'"$]{3,})@[^\\s/\'"]+', flags: 'i' },
  {
    name: 'Hard-coded credential',
    pattern:
      '\\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\\b["\']?\\s*[:=]\\s*["\']([^"\'\\s]{8,})["\']',
    flags: 'i',
  },
];

const PLACEHOLDER =
  /^(x+|\*+|\.+|<.*>|\$\{.*\}|\{\{.*\}\}|%.*%|changeme|change_me|password|example|your[_-].*|test|dummy|placeholder|redacted|null|undefined|secret)$/i;

function mask(s: string): string {
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

export function secretsCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.secrets;
  const rules = [...SECRET_RULES, ...c.extraPatterns].map((r) => ({ r, re: compile(r) })).filter((x) => x.re);
  const allow = c.allowlist
    .map((a) => {
      try {
        return new RegExp(a);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean) as RegExp[];
  return {
    id: 'secrets',
    name: 'Secrets & credentials',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) =>
      outcome(
        await scanAddedLines(ctx, c.exclude, (file, line, text, push) => {
          if (allow.some((a) => a.test(text))) return;
          for (const { r, re } of rules) {
            const m = re!.exec(text);
            if (!m) continue;
            const value = m[m.length - 1] ?? m[0];
            if (PLACEHOLDER.test(value) || /process\.env|os\.environ|getenv/i.test(text)) continue;
            push({ file, line, column: m.index + 1, rule: r.name, message: `${r.name}: ${mask(m[0])}${r.message ? ` — ${r.message}` : ''}` });
            break;
          }
        }),
        'No secrets found',
        'possible secret',
      ),
  };
}

// ---------------------------------------------------------------- conflict markers

export function conflictMarkersCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.conflictMarkers;
  return {
    id: 'conflictMarkers',
    name: 'Merge conflict markers',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) => {
      const opened = new Set<string>();
      const candidates: Finding[] = [];
      const found = await scanAddedLines(ctx, c.exclude, (file, line, text, push) => {
        if (/^(<{7}|>{7}|\|{7})( |$)/.test(text)) {
          opened.add(file);
          push({ file, line, message: `Conflict marker "${text.slice(0, 7)}"` });
        } else if (/^={7}$/.test(text)) candidates.push({ file, line, message: 'Conflict separator "======="' });
      });
      found.push(...candidates.filter((f) => opened.has(f.file!)));
      found.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : a.line! - b.line!));
      return outcome(found, 'No conflict markers', 'conflict marker');
    },
  };
}

// ---------------------------------------------------------------- debug statements

export function debugStatementsCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.debugStatements;
  const rules = c.patterns.map((r) => ({ r, re: compile(r) })).filter((x) => x.re);
  return {
    id: 'debugStatements',
    name: 'Debug statements',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) =>
      outcome(
        await scanAddedLines(ctx, c.exclude, (file, line, text, push) => {
          for (const { r, re } of rules) {
            if (r.glob && !matchesAny(file, r.glob)) continue;
            const m = re!.exec(text);
            if (m) {
              push({ file, line, column: m.index + 1, rule: r.name, message: r.message ?? `Leftover ${r.name ?? 'debug statement'}` });
              break;
            }
          }
        }),
        'No debug statements',
        'debug statement',
      ),
  };
}

// ---------------------------------------------------------------- TODO comments

export function todoCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.todoComments;
  const re = new RegExp(`\\b(${c.keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
  return {
    id: 'todoComments',
    name: 'TODO / FIXME comments',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) =>
      outcome(
        await scanAddedLines(ctx, c.exclude, (file, line, text, push) => {
          const m = re.exec(text);
          if (m) push({ file, line, column: m.index + 1, rule: m[1], message: text.trim().slice(0, 140) });
        }),
        'No new TODOs',
        'new TODO',
      ),
  };
}

// ---------------------------------------------------------------- whitespace & EOF

export function trailingWhitespaceCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.trailingWhitespace;
  return {
    id: 'trailingWhitespace',
    name: 'Trailing whitespace',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) =>
      outcome(
        await scanAddedLines(ctx, c.exclude, (file, line, text, push) => {
          const m = /[ \t]+$/.exec(text);
          if (m) push({ file, line, column: m.index + 1, message: 'Trailing whitespace' });
        }),
        'No trailing whitespace',
        'line',
        { fixable: true },
      ),
  };
}

export function eofNewlineCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.eofNewline;
  return {
    id: 'eofNewline',
    name: 'Newline at end of file',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) => {
      const set = await ctx.fileSet();
      const findings: Finding[] = [];
      for (const file of set.files) {
        if (isExcluded(ctx, file, c.exclude)) continue;
        const buf = await set.read(file);
        if (!buf || !buf.length || isBinary(buf)) continue;
        if (buf[buf.length - 1] !== 0x0a) {
          findings.push({ file, line: buf.toString('utf8').split('\n').length, message: 'Missing newline at end of file' });
        }
      }
      return outcome(findings, 'All files end with a newline', 'file', { fixable: true });
    },
  };
}

// ---------------------------------------------------------------- JSON syntax

export function jsonSyntaxCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.jsonSyntax;
  return {
    id: 'jsonSyntax',
    name: 'JSON syntax',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) => {
      const set = await ctx.fileSet();
      const findings: Finding[] = [];
      for (const file of set.files) {
        if (!/\.json$/i.test(file) || isExcluded(ctx, file, c.exclude)) continue;
        const buf = await set.read(file);
        if (!buf) continue;
        const text = buf.toString('utf8').replace(/^\uFEFF/, '');
        if (!text.trim()) continue;
        try {
          JSON.parse(text);
        } catch (e) {
          const msg = (e as Error).message;
          let line = 1;
          let column: number | undefined;
          const lc = /line (\d+) column (\d+)/.exec(msg);
          const pos = /position (\d+)/.exec(msg);
          if (lc) {
            line = Number(lc[1]);
            column = Number(lc[2]);
          } else if (pos) {
            const before = text.slice(0, Number(pos[1]));
            line = before.split('\n').length;
            column = before.length - before.lastIndexOf('\n');
          }
          findings.push({ file, line, column, message: `Invalid JSON: ${msg.replace(/ in JSON at position.*$/, '')}` });
        }
      }
      return outcome(findings, 'All JSON files are valid', 'invalid JSON file');
    },
  };
}

// ---------------------------------------------------------------- file hygiene

export function largeFilesCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.largeFiles;
  return {
    id: 'largeFiles',
    name: `Large files (> ${c.maxSizeKB} KB)`,
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) => {
      const set = await ctx.fileSet();
      const findings: Finding[] = [];
      await Promise.all(
        set.files.map(async (file) => {
          if (c.exclude && matchesAny(file, c.exclude)) return;
          const size = await set.size(file);
          if (size > c.maxSizeKB * 1024) {
            findings.push({ file, message: `${(size / 1024).toFixed(0)} KB exceeds the ${c.maxSizeKB} KB limit (consider Git LFS)` });
          }
        }),
      );
      return outcome(findings, 'No oversized files', 'large file');
    },
  };
}

export function forbiddenFilesCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.forbiddenFiles;
  return {
    id: 'forbiddenFiles',
    name: 'Forbidden files',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) => {
      const set = await ctx.fileSet();
      const findings = set.files
        .filter((f) => matchesAny(f, c.patterns) && !(c.exclude && matchesAny(f, c.exclude)))
        .map((file) => ({ file, message: 'This file should not be committed (matches forbiddenFiles patterns)' }));
      return outcome(findings, 'No forbidden files', 'forbidden file');
    },
  };
}

// ---------------------------------------------------------------- branches

export function protectedBranchesCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.protectedBranches;
  return {
    id: 'protectedBranches',
    name: 'Protected branches',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) => {
      if (!ctx.branch) return { status: 'skipped', summary: 'Detached HEAD' };
      if (ctx.mode === 'staged' && (await isMergeInProgress(ctx.root))) return { status: 'skipped', summary: 'Merge/rebase in progress' };
      if (c.branches.some((b) => b === ctx.branch || matchesAny(ctx.branch, `/${b}`))) {
        return {
          status: 'failed',
          summary: `Committing directly to "${ctx.branch}"`,
          findings: [{ message: `"${ctx.branch}" is a protected branch — create a feature branch instead (git switch -c feature/…)` }],
        };
      }
      return { status: 'passed', summary: `On "${ctx.branch}"` };
    },
  };
}

export function branchNameCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.branchName;
  return {
    id: 'branchName',
    name: 'Branch naming',
    stage: 'pre-commit',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx) => {
      if (!ctx.branch) return { status: 'skipped', summary: 'Detached HEAD' };
      if (c.ignore.includes(ctx.branch)) return { status: 'passed', summary: `"${ctx.branch}" is exempt` };
      let re: RegExp;
      try {
        re = new RegExp(c.pattern);
      } catch (e) {
        return { status: 'error', summary: `Invalid pattern: ${(e as Error).message}` };
      }
      return re.test(ctx.branch)
        ? { status: 'passed', summary: `"${ctx.branch}" matches` }
        : {
            status: 'failed',
            summary: `"${ctx.branch}" does not match ${c.pattern}`,
            findings: [{ message: `Branch "${ctx.branch}" does not match ${c.pattern}` }],
          };
    },
  };
}

// ---------------------------------------------------------------- commit message

export function validateCommitMessage(raw: string, cfg: GuardConfig): Finding[] | 'skip' {
  const c = cfg.checks.commitMessage;
  const scissors = raw.indexOf('# ------------------------ >8 ------------------------');
  const lines = (scissors >= 0 ? raw.slice(0, scissors) : raw).split(/\r?\n/).filter((l) => !l.startsWith('#'));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  const subject = lines[0] ?? '';
  if (/^(Merge |Revert "|fixup! |squash! |amend! )/.test(subject)) return 'skip';
  const findings: Finding[] = [];
  const all = lines.join('\n').trim();
  if (!all) return [{ line: 1, message: 'Commit message is empty' }];
  if (all.length < c.minLength) findings.push({ line: 1, message: `Message is too short (${all.length} < ${c.minLength} chars)` });
  if (subject.length > c.maxSubjectLength) findings.push({ line: 1, message: `Subject is ${subject.length} chars (max ${c.maxSubjectLength})` });
  if (c.preset === 'conventional') {
    const re = new RegExp(`^(${c.types.join('|')})(\\([\\w\\-./ ,]+\\))?!?: \\S.*`);
    if (!re.test(subject))
      findings.push({
        line: 1,
        rule: 'conventional',
        message: `Subject must follow Conventional Commits: "<type>(scope)?: description" where type is one of ${c.types.join(', ')}`,
      });
  }
  if (c.pattern) {
    try {
      if (!new RegExp(c.pattern, 'm').test(all)) findings.push({ line: 1, rule: 'pattern', message: `Message must match ${c.pattern}` });
    } catch (e) {
      findings.push({ message: `Invalid commitMessage.pattern: ${(e as Error).message}` });
    }
  }
  if (c.requireTicket) {
    try {
      if (!new RegExp(c.ticketPattern).test(all)) findings.push({ line: 1, rule: 'ticket', message: `Message must reference a ticket (${c.ticketPattern})` });
    } catch (e) {
      findings.push({ message: `Invalid ticketPattern: ${(e as Error).message}` });
    }
  }
  if (c.blankLineAfterSubject && lines.length > 1 && lines[1].trim())
    findings.push({ line: 2, message: 'Leave a blank line between the subject and the body' });
  return findings;
}

export function commitMessageCheck(cfg: GuardConfig): CheckDef {
  const c = cfg.checks.commitMessage;
  return {
    id: 'commitMessage',
    name: 'Commit message format',
    stage: 'commit-msg',
    severity: c.severity,
    kind: 'builtin',
    run: async (ctx): Promise<CheckOutcome> => {
      if (!ctx.msgFile) return { status: 'skipped', summary: 'Runs on commit' };
      const raw = fs.readFileSync(ctx.msgFile, 'utf8');
      const r = validateCommitMessage(raw, cfg);
      if (r === 'skip') return { status: 'skipped', summary: 'Merge/revert/fixup commit' };
      return r.length ? { status: 'failed', summary: r[0].message, findings: r } : { status: 'passed', summary: 'Message format OK' };
    },
  };
}

export function builtinChecks(cfg: GuardConfig): CheckDef[] {
  const k = cfg.checks;
  const list: [boolean, () => CheckDef][] = [
    [k.forbiddenFiles.enabled, () => forbiddenFilesCheck(cfg)],
    [k.largeFiles.enabled, () => largeFilesCheck(cfg)],
    [k.secrets.enabled, () => secretsCheck(cfg)],
    [k.conflictMarkers.enabled, () => conflictMarkersCheck(cfg)],
    [k.jsonSyntax.enabled, () => jsonSyntaxCheck(cfg)],
    [k.debugStatements.enabled, () => debugStatementsCheck(cfg)],
    [k.todoComments.enabled, () => todoCheck(cfg)],
    [k.trailingWhitespace.enabled, () => trailingWhitespaceCheck(cfg)],
    [k.eofNewline.enabled, () => eofNewlineCheck(cfg)],
    [k.protectedBranches.enabled, () => protectedBranchesCheck(cfg)],
    [k.branchName.enabled, () => branchNameCheck(cfg)],
    [k.commitMessage.enabled, () => commitMessageCheck(cfg)],
  ];
  return list.filter(([on]) => on).map(([, make]) => make());
}
