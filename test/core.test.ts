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

test('secret scanner: detects provider keys, ignores placeholders and env lookups', async () => {
  const { secretsCheck } = await import('../src/core/checks/builtin');
  const cfg = baseDefaults();
  // Fixtures are assembled at runtime so this test file itself never contains a scannable secret.
  const j = (...parts: string[]) => parts.join('');
  const lines = [
    j("const k = 'AKIA", 'IOSFODNN7EXAMPLE', "';"),
    j("stripe = 'sk_", 'test_4eC39HqLyjWDarjtT1zdp7dc', "'"),
    j("rk = 'rk_", 'live_', 'a'.repeat(24), "'"),
    j('token: "gh', 'p_', 'A'.repeat(36), '"'),
    j('-----BEGIN RSA ', 'PRIVATE KEY-----'),
    j("password = 'hunter2", "hunter2'"),
    j('DATABASE_URL=postgres://admin:', 's3cretpw', '@db.example.com/app'),
    j('"Default": "Server=sql.acme.dev;Database=app;User Id=sa;Pass', 'word=Sup3rS3cret!;"'),
    // should be ignored:
    j("password = 'change", "me'"),
    j('password: "${', 'DB_PASSWORD}"'),
    j('apiKey = process.env.', 'API_KEY'),
    j("const sk = 'sk_", "test_short'"),
  ];
  const files = ['src/a.ts'];
  const ctx = {
    root: '/',
    config: cfg,
    stage: 'pre-commit',
    mode: 'staged',
    branch: 'x',
    signal: new AbortController().signal,
    pushFiles: async () => [],
    fileSet: async () => ({
      mode: 'staged',
      root: '/',
      files,
      addedLines: async () => lines.map((text, i) => ({ line: i + 1, text })),
      read: async () => undefined,
      size: async () => 0,
    }),
  } as never;
  const out = await secretsCheck(cfg).run(ctx);
  const hit = new Map((out.findings ?? []).map((f) => [f.line, f.rule]));
  assert.equal(hit.get(1), 'AWS access key ID');
  assert.equal(hit.get(2), 'Stripe key');
  assert.equal(hit.get(3), 'Stripe key');
  assert.equal(hit.get(4), 'GitHub token');
  assert.equal(hit.get(5), 'Private key');
  assert.equal(hit.get(6), 'Hard-coded credential');
  assert.equal(hit.get(7), 'Credentials in URL');
  assert.equal(hit.get(8), 'Connection string password');
  for (const l of [9, 10, 11, 12]) assert.ok(!hit.has(l), `line ${l} should not be flagged`);
  assert.ok((out.findings ?? []).find((f) => f.line === 8)?.message.includes('Sup3…t!'), 'masks the password itself');
  for (const f of out.findings ?? []) assert.ok(!f.message.includes('4eC39HqLyjWDarjtT1zdp7dc'), 'secret is masked');
});

test('commit message length: 500 by default, configurable, 0 = unlimited', () => {
  const cfg = deepMerge(baseDefaults(), { checks: { commitMessage: { enabled: true } } });
  const long = `feat: ${'x'.repeat(114)}`; // 120 chars
  assert.deepEqual(validateCommitMessage(long, cfg), []);
  const limited = deepMerge(cfg, { checks: { commitMessage: { maxSubjectLength: 72 } } });
  const r = validateCommitMessage(long, limited);
  assert.ok(Array.isArray(r) && r.some((f) => /Subject is 120 chars \(max 72\)/.test(f.message)));
  const huge = `feat: ${'x'.repeat(495)}`; // 501 chars
  const d = validateCommitMessage(huge, cfg);
  assert.ok(Array.isArray(d) && d.some((f) => /Subject is 501 chars \(max 500\)/.test(f.message)));
  const unlimited = deepMerge(cfg, { checks: { commitMessage: { maxSubjectLength: 0 } } });
  assert.deepEqual(validateCommitMessage(huge, unlimited), []);
});

test('MSBuild / dotnet format / CSharpier output parsing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ms-'));
  fs.mkdirSync(path.join(dir, 'src', 'App'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'App', 'Greeter.cs'), '');
  const abs = path.join(dir, 'src', 'App', 'Greeter.cs');
  const out = [
    `${abs}(8,16): error CS0103: The name 'mesage' does not exist in the current context [${dir}/src/App/App.csproj]`,
    `${abs}(7,9): error WHITESPACE: Fix whitespace formatting. Delete 2 characters. [.]`,
    `  1>${abs}(3,1,3,5): warning CA1822: Member can be static [${dir}/src/App/App.csproj]`,
    'Error ./src/App/Greeter.cs - Was not formatted.',
    '/usr/lib/dotnet/sdk/8.0/Microsoft.Common.targets(30,3): error MSB4024: outside the repo [x.csproj]',
  ].join('\n');
  const f = parseToolOutput(out, dir, dir);
  assert.deepEqual(f[0], {
    file: 'src/App/Greeter.cs',
    line: 8,
    column: 16,
    rule: 'CS0103',
    message: "The name 'mesage' does not exist in the current context",
  });
  assert.equal(f[1].rule, 'WHITESPACE');
  assert.equal(f[1].message, 'Fix whitespace formatting. Delete 2 characters.');
  assert.equal(f[2].rule, 'CA1822');
  assert.deepEqual(f[3], { file: 'src/App/Greeter.cs', line: 1, rule: 'csharpier', message: 'Was not formatted.' });
  assert.equal(f.length, 4, 'files outside the repo are ignored');
});

test('.NET target resolution and CSharpier detection', async () => {
  const { resolveDotnetTargets, detectCsharpier } = await import('../src/core/checks/dotnet');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dn-'));
  fs.mkdirSync(path.join(dir, 'src', 'Api'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests', 'Api.Tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'Api', 'Api.csproj'), '<Project/>');
  fs.writeFileSync(path.join(dir, 'tests', 'Api.Tests', 'Api.Tests.csproj'), '<Project/>');
  const cfg = baseDefaults();
  // No solution: the projects owning the staged files.
  const t1 = await resolveDotnetTargets(dir, cfg, ['src/Api/Controllers/Home.cs', 'tests/Api.Tests/HomeTests.cs', 'README.md']);
  assert.deepEqual(
    t1.map((t) => t.path),
    ['src/Api/Api.csproj', 'tests/Api.Tests/Api.Tests.csproj'],
  );
  assert.equal(t1[0].dir, 'src/Api');
  // Old-style (non-SDK) projects such as VSIX extensions are skipped: dotnet build can't load them.
  fs.mkdirSync(path.join(dir, 'src', 'Vsix'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'Vsix', 'Vsix.csproj'),
    '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" /></Project>',
  );
  const skipped: string[] = [];
  const t2 = await resolveDotnetTargets(dir, cfg, ['src/Vsix/Package.cs', 'src/Api/A.cs'], skipped);
  assert.deepEqual(
    t2.map((t) => t.path),
    ['src/Api/Api.csproj'],
  );
  assert.deepEqual(skipped, ['src/Vsix/Vsix.csproj']);
  fs.writeFileSync(path.join(dir, 'src', 'Vsix', 'Vsix.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><Import Project="x\\Microsoft.CSharp.targets" /></Project>');
  assert.equal((await resolveDotnetTargets(dir, cfg, ['src/Vsix/Package.cs'])).length, 1);
  fs.rmSync(path.join(dir, 'src', 'Vsix'), { recursive: true });
  // A single root solution wins.
  fs.writeFileSync(path.join(dir, 'Acme.slnx'), '<Solution/>');
  assert.deepEqual(
    (await resolveDotnetTargets(dir, cfg, ['src/Api/A.cs'])).map((t) => t.path),
    ['Acme.slnx'],
  );
  // Explicit target wins over everything.
  const explicit = deepMerge(cfg, { checks: { dotnet: { target: 'src/Api/Api.csproj' } } });
  assert.deepEqual(
    (await resolveDotnetTargets(dir, explicit, [])).map((t) => t.path),
    ['src/Api/Api.csproj'],
  );

  assert.deepEqual(detectCsharpier(dir), { active: false, legacy: false });
  fs.mkdirSync(path.join(dir, '.config'));
  fs.writeFileSync(
    path.join(dir, '.config', 'dotnet-tools.json'),
    JSON.stringify({ version: 1, tools: { csharpier: { version: '0.30.6', commands: ['dotnet-csharpier'] } } }),
  );
  assert.deepEqual(detectCsharpier(dir), { active: true, legacy: true });
  fs.writeFileSync(
    path.join(dir, '.config', 'dotnet-tools.json'),
    JSON.stringify({ version: 1, tools: { csharpier: { version: '1.1.2', commands: ['csharpier'] } } }),
  );
  assert.deepEqual(detectCsharpier(dir), { active: true, legacy: false });
});

test('JSON syntax: comments allowed in .NET/TS config files, strict elsewhere', async () => {
  const { jsonSyntaxCheck } = await import('../src/core/checks/builtin');
  const cfg = baseDefaults();
  const files: Record<string, string> = {
    'src/App/appsettings.Development.json': '{\n  // dev only\n  "A": 1,\n}\n',
    'data/strict.json': '{\n  // not allowed here\n  "A": 1\n}\n',
    'data/ok.json': '{"A": [1, 2]}',
  };
  const ctx = {
    root: '/',
    config: cfg,
    stage: 'pre-commit',
    mode: 'staged',
    branch: 'x',
    signal: new AbortController().signal,
    pushFiles: async () => [],
    fileSet: async () => ({
      mode: 'staged',
      root: '/',
      files: Object.keys(files),
      addedLines: async () => [],
      read: async (f: string) => Buffer.from(files[f]),
      size: async () => 0,
    }),
  } as never;
  const out = await jsonSyntaxCheck(cfg).run(ctx);
  assert.deepEqual(
    (out.findings ?? []).map((f) => f.file),
    ['data/strict.json'],
  );
});

test('toggleCheck / setConfigValue write .tollgaterc.json for every kind of check', async () => {
  const { toggleCheck, setConfigValue, readRc } = await import('../src/core/catalog');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rc-'));
  fs.writeFileSync(path.join(dir, '.tollgaterc.json'), '{\n  // keep working with comments\n  "extends": "recommended",\n}\n');
  const cfg = deepMerge(baseDefaults(), {
    custom: [
      { name: 'Stylelint', command: 'npx stylelint {files}' },
      { id: 'unit', name: 'Unit tests', command: 'npm test' },
    ],
  });
  toggleCheck(dir, cfg, 'secrets', false);
  toggleCheck(dir, cfg, 'dotnet:test', true);
  toggleCheck(dir, cfg, 'npmScripts:typecheck', false);
  toggleCheck(dir, cfg, 'custom:stylelint', false);
  toggleCheck(dir, cfg, 'custom:unit', false);
  setConfigValue(dir, 'checks.dotnet.build.configuration', 'Release');
  setConfigValue(dir, 'failOn', '"warning"');
  // biome-ignore lint/suspicious/noExplicitAny: nested assertions on untyped JSON
  const rc = readRc(dir) as Record<string, any>;
  assert.equal(rc.extends, 'recommended');
  assert.equal(rc.failOn, 'warning');
  assert.equal(rc.checks.secrets.enabled, false);
  assert.equal(rc.checks.dotnet.test.enabled, true);
  assert.equal(rc.checks.dotnet.build.configuration, 'Release');
  assert.ok(!rc.checks.npmScripts.scripts.includes('typecheck') && rc.checks.npmScripts.scripts.includes('lint'));
  assert.deepEqual(rc.custom, [
    { name: 'Stylelint', enabled: false },
    { id: 'unit', enabled: false },
  ]);
  // The overrides merge back onto the original definitions.
  const merged = deepMerge(cfg, rc);
  assert.equal(merged.custom.find((c) => c.name === 'Stylelint')?.command, 'npx stylelint {files}');
  assert.equal(merged.custom.find((c) => c.id === 'unit')?.enabled, false);
  assert.throws(() => toggleCheck(dir, cfg, 'nope', true), /Unknown check/);
});

test('monorepo: .NET targets in sub-folders resolve to the owning solution, else the project', async () => {
  const { resolveDotnetTargets } = await import('../src/core/checks/dotnet');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mono-dn-'));
  const w = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  };
  // backend/Acme.sln includes Api; Tools/Tool.csproj is not in any solution; web/ is a JS app.
  w('backend/src/Api/Api.csproj', '<Project/>');
  w('backend/src/Tools/Tool.csproj', '<Project/>');
  w('backend/Acme.sln', 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api\\Api.csproj", "{A}"\nEndProject\n');
  w('services/orders/Orders.slnx', '<Solution>\n  <Project Path="Orders.Api/Orders.Api.csproj" />\n</Solution>\n');
  w('services/orders/Orders.Api/Orders.Api.csproj', '<Project/>');
  const t = await resolveDotnetTargets(dir, baseDefaults(), [
    'backend/src/Api/Controllers/Home.cs',
    'backend/src/Api/Program.cs',
    'backend/src/Tools/Run.cs',
    'services/orders/Orders.Api/Order.cs',
    'web/src/app.ts',
  ]);
  assert.deepEqual(
    t.map((x) => [x.path, x.dir, x.files]),
    [
      ['backend/Acme.sln', 'backend', ['backend/src/Api/Controllers/Home.cs', 'backend/src/Api/Program.cs']],
      ['backend/src/Tools/Tool.csproj', 'backend/src/Tools', ['backend/src/Tools/Run.cs']],
      ['services/orders/Orders.slnx', 'services/orders', ['services/orders/Orders.Api/Order.cs']],
    ],
  );
});

test('monorepo: tool folders, npm script scope fallback and nested Biome/Prettier/lint-staged/CSharpier detection', async () => {
  const { groupByOwnerDir, relativeTo, resetToolFileCache } = await import('../src/core/checks/workspace');
  const { effectiveNpmScope, npmScriptChecks, biomeCheck, prettierCheck, lintStagedCheck, hasBiome } = await import('../src/core/checks/commands');
  const { csharpierDirs, dotnetChecks } = await import('../src/core/checks/dotnet');
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mono-'));
  const w = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  };
  spawnSync('git', ['init', '-q'], { cwd: dir });
  // No package.json, solution or tool config at the root.
  w('apps/web/package.json', JSON.stringify({ scripts: { lint: 'eslint .' }, devDependencies: { '@biomejs/biome': '2.0.0' } }));
  w('apps/web/src/a.ts', '');
  w('apps/docs/.prettierrc', '{}');
  w('apps/docs/package.json', JSON.stringify({ 'lint-staged': { '*.md': 'prettier --check' } }));
  w('backend/.config/dotnet-tools.json', JSON.stringify({ tools: { csharpier: { version: '1.0.0' } } }));
  w('backend/Api/Api.csproj', '<Project/>');
  spawnSync('git', ['add', '.'], { cwd: dir });
  resetToolFileCache();

  const cfg = baseDefaults();
  assert.equal(effectiveNpmScope(cfg, dir), 'affected', 'no root package.json → packages owning the staged files');
  const staged = ['apps/web/src/a.ts', 'apps/docs/readme.md', 'backend/Api/A.cs'];
  const npm = await npmScriptChecks(cfg, dir, 'pre-commit', async () => staged);
  assert.deepEqual(
    npm.map((d) => d.id),
    ['npmScripts:apps/web:lint'],
  );
  assert.equal(effectiveNpmScope(deepMerge(cfg, { checks: { npmScripts: { scope: 'root' } } }), dir), 'affected');

  assert.ok(!hasBiome(dir));
  // web's lint script doesn't call biome, so the Biome check stays on.
  assert.deepEqual(
    (await biomeCheck(cfg, dir, 'pre-commit')).map((d) => d.id),
    ['biome'],
  );
  assert.deepEqual(
    (await prettierCheck(cfg, dir, 'pre-commit')).map((d) => d.id),
    ['prettier'],
  );
  assert.deepEqual(
    (await lintStagedCheck(cfg, dir, 'pre-commit')).map((d) => d.id),
    ['lintStaged'],
  );
  assert.deepEqual(await csharpierDirs(dir), ['backend']);
  assert.ok((await dotnetChecks(cfg, dir, 'pre-commit')).some((d) => d.id === 'dotnet:csharpier'));

  const groups = groupByOwnerDir(dir, staged, (abs) => fs.existsSync(path.join(abs, 'package.json')));
  assert.deepEqual(
    [...groups],
    [
      ['apps/docs', ['apps/docs/readme.md']],
      ['apps/web', ['apps/web/src/a.ts']],
    ],
  );
  assert.equal(relativeTo('apps/web', 'apps/web/src/a.ts'), 'src/a.ts');
  assert.equal(relativeTo('', 'apps/web/src/a.ts'), 'apps/web/src/a.ts');

  // A root package.json without the configured scripts still falls back to the packages.
  w('package.json', JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }));
  assert.equal(effectiveNpmScope(cfg, dir), 'affected');
  w('package.json', JSON.stringify({ name: 'root', scripts: { lint: 'turbo lint' } }));
  assert.equal(effectiveNpmScope(cfg, dir), 'root');
});
