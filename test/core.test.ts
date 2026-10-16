import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { validateCommitMessage } from '../src/core/checks/builtin';
import { parseToolOutput } from '../src/core/checks/commands';
import { baseDefaults, deepMerge, stripJsonComments } from '../src/core/config';
import { parseAddedLines } from '../src/core/git';
import { matchesAny } from '../src/core/glob';

test('glob matching', () => {
  assert.ok(matchesAny('src/a/b.ts', '**/*.{ts,tsx}'));
  assert.ok(matchesAny('b.tsx', '**/*.{ts,tsx}'));
  assert.ok(!matchesAny('src/b.js', '**/*.{ts,tsx}'));
  assert.ok(matchesAny('config/.env', '.env'));
  assert.ok(matchesAny('.env.production', ['.env', '.env.*', '!.env.example']));
  assert.ok(!matchesAny('.env.example', ['.env', '.env.*', '!.env.example']));
  assert.ok(matchesAny('node_modules/x/y.js', '**/node_modules/**'));
  assert.ok(matchesAny('release/1.2', '/release/*'));
  assert.ok(!matchesAny('src/release/1.2', '/release/*'));
});

test('config deep merge: objects merge, arrays replace, custom merges by id', () => {
  const base = baseDefaults();
  const merged = deepMerge(base, {
    checks: { secrets: { severity: 'warning' }, npmScripts: { scripts: ['lint'] } },
    custom: [{ name: 'A', command: 'a' }],
  });
  assert.equal(merged.checks.secrets.severity, 'warning');
  assert.equal(merged.checks.secrets.enabled, true);
  assert.deepEqual(merged.checks.npmScripts.scripts, ['lint']);
  const again = deepMerge(merged, {
    custom: [
      { name: 'A', enabled: false },
      { name: 'B', command: 'b' },
    ],
  });
  assert.equal(again.custom.length, 2);
  assert.equal(again.custom[0].command, 'a');
  assert.equal(again.custom[0].enabled, false);
});

test('JSON with comments and trailing commas', () => {
  const parsed = JSON.parse(stripJsonComments('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }'));
  assert.deepEqual(parsed, { a: 'http://x', b: [1, 2] });
});

test('parse added lines from git diff -U0', () => {
  const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,0 +2,2 @@', '+const a = 1;', '+++i;', '@@ -10 +12 @@', '-old', '+new'].join(
    '\n',
  );
  const m = parseAddedLines(diff);
  assert.deepEqual(m.get('x.ts'), [
    { line: 2, text: 'const a = 1;' },
    { line: 3, text: '++i;' },
    { line: 12, text: 'new' },
  ]);
});

test('commit message validation', () => {
  const cfg = deepMerge(baseDefaults(), { checks: { commitMessage: { enabled: true } } });
  assert.deepEqual(validateCommitMessage('feat(ui): add a button\n', cfg), []);
  assert.equal(validateCommitMessage('Merge branch x', cfg), 'skip');
  const bad = validateCommitMessage('added stuff here\n# comment', cfg);
  assert.ok(Array.isArray(bad) && bad.some((f) => f.rule === 'conventional'));
  const ticket = deepMerge(cfg, { checks: { commitMessage: { requireTicket: true } } });
  const r = validateCommitMessage('fix: handle null user', ticket);
  assert.ok(Array.isArray(r) && r.some((f) => f.rule === 'ticket'));
  assert.deepEqual(validateCommitMessage('fix: handle null user ABC-123', ticket), []);
});

test('tool output parsing: tsc, eslint stylish, biome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), '');
  const out = [
    'src/a.ts(3,5): error TS2322: Type string is not assignable to number.',
    '',
    path.join(dir, 'src', 'a.ts'),
    '  10:2  error  Unexpected console statement  no-console',
    '',
    './src/a.ts:1:7 lint/style/useConst  FIXABLE  ━━━━━━━━━━',
    '',
    '  × This let declares a variable that is only assigned once.',
    'missing/file.ts:1:1 nope',
  ].join('\n');
  const f = parseToolOutput(out, dir, dir);
  assert.equal(f.length, 3);
  assert.deepEqual(f[0], { file: 'src/a.ts', line: 3, column: 5, rule: 'TS2322', message: 'Type string is not assignable to number.' });
  assert.equal(f[1].rule, 'no-console');
  assert.equal(f[1].line, 10);
  assert.equal(f[2].rule, 'lint/style/useConst');
  assert.equal(f[2].message, 'This let declares a variable that is only assigned once.');
});
