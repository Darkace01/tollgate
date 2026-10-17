/**
 * End-to-end: create a real git repo, install the hooks with the bundled runner, and make commits.
 * Requires `npm run build` first (dist/cli.js).
 */
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, test } from 'node:test';

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');
let repo: string;

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const git = (...args: string[]) => sh('git', args);
const write = (f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), c);
};
// Tests read the hook's report, so ask for full output even though spawnSync isn't a TTY.
const commit = (msg: string, env: Record<string, string> = {}) => sh('git', ['commit', '-m', msg], { TOLLGATE_VERBOSE: '1', ...env });

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-e2e-'));
  git('init', '-q', '-b', 'feature/test');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('package.json', JSON.stringify({ name: 'demo', scripts: { lint: 'node lint.js' } }, null, 2));
  // A fake linter that fails if any .js file contains "var ".
  write(
    'lint.js',
    `const fs=require('fs');let bad=0;for(const f of fs.readdirSync('src')){const t=fs.readFileSync('src/'+f,'utf8');t.split('\\n').forEach((l,i)=>{if(l.includes('var ')){console.log('src/'+f+':'+(i+1)+':1: no-var Unexpected var');bad++;}});}process.exit(bad?1:0);\n`,
  );
  write('src/ok.js', 'const a = 1;\n');
  write('.tollgaterc.json', JSON.stringify({ checks: { commitMessage: { enabled: true } } }, null, 2));
  git('add', '.');
  const install = sh('node', [CLI, 'install']);
  assert.equal(install.code, 0, install.out);
  assert.ok(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')));
  assert.ok(fs.existsSync(path.join(repo, '.git', 'tollgate', 'runner.js')));
});

test('clean commit passes (lint script runs, conventional message)', () => {
  const r = commit('chore: initial commit');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /lint/);
  const report = JSON.parse(fs.readFileSync(path.join(repo, '.git', 'tollgate', 'last-pre-commit.json'), 'utf8'));
  assert.equal(report.blocked, false);
  assert.ok(report.results.some((x: { id: string; status: string }) => x.id === 'npmScripts:lint' && x.status === 'passed'));
});

test('secret blocks the commit and is masked', () => {
  write('src/config.js', "const key = 'AKIAIOSFODNN7EXAMPLE';\n"); // tollgate-ignore (test fixture)
  git('add', '.');
  const r = commit('feat: add config');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /AWS access key ID/);
  assert.doesNotMatch(r.out, /AKIAIOSFODNN7EXAMPLE/); // tollgate-ignore
});

test('inline ignore allows it', () => {
  write('src/config.js', "const key = 'AKIAIOSFODNN7EXAMPLE'; // tollgate-ignore\n");
  git('add', '.');
  const r = commit('feat: add config');
  assert.equal(r.code, 0, r.out);
});

test('failing package.json lint script blocks with file findings', () => {
  write('src/bad.js', 'var x = 1;\n');
  git('add', '.');
  const r = commit('feat: add bad');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /src\/bad\.js:1:1/);
  const ok = commit('feat: add bad', { SKIP: 'npmScripts' });
  assert.equal(ok.code, 0, ok.out);
  write('src/bad.js', 'const x = 1;\n');
  git('add', '.');
});

test('commit-msg hook enforces Conventional Commits', () => {
  write('src/ok2.js', 'const b = 2;\n');
  git('add', '.');
  const r = commit('did some things');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Conventional Commits/);
  assert.equal(commit('feat: ok two').code, 0);
});

test('GUI clients: first output line explains the block; passing stages stay quiet', () => {
  write('src/gui.js', 'const g = 1;\n');
  git('add', '.');
  // No TOLLGATE_VERBOSE and no TTY — like VS Code's commit button.
  const r = sh('git', ['commit', '-m', 'Added CI and release workflows and restored the VS Code configuration files for the project']);
  assert.notEqual(r.code, 0);
  const first = r.out.split(/\r?\n/).find((l) => l.trim());
  assert.match(first ?? '', /^Tollgate blocked the commit: Commit message format \(Subject must follow Conventional Commits/);
  const ok = sh('git', ['commit', '-m', 'feat: add gui fixture file']);
  assert.equal(ok.code, 0, ok.out);
  assert.doesNotMatch(ok.out, /Tollgate/);
});

test('forbidden file, conflict markers and custom command', () => {
  write('.env', 'X=1\n');
  git('add', '.env');
  let r = commit('chore: add env file');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Forbidden files/);
  git('rm', '--cached', '-q', '.env');
  fs.unlinkSync(path.join(repo, '.env'));

  write('src/m.js', '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> other\n');
  git('add', '.');
  r = commit('fix: merge branches');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /conflict marker/);
  write('src/m.js', 'const a = 1;\n');
  git('add', '.');

  const rc = JSON.parse(fs.readFileSync(path.join(repo, '.tollgaterc.json'), 'utf8'));
  rc.custom = [
    {
      name: 'No foo',
      command: "node -e \"process.exit(process.argv.slice(1).some(f=>require('fs').readFileSync(f,'utf8').includes('foo'))?1:0)\" {files}",
      glob: 'src/**/*.js',
    },
  ];
  write('.tollgaterc.json', JSON.stringify(rc, null, 2));
  write('src/foo.js', 'const foo = 1;\n');
  git('add', '.');
  r = commit('feat: add foo module');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /No foo/);
  r = commit('feat: add foo module', { SKIP: 'no-foo' });
  assert.equal(r.code, 0, r.out);
});

test('protected branch warns but does not block by default; autoFix fixes whitespace', () => {
  git('switch', '-q', '-c', 'main');
  const rc = JSON.parse(fs.readFileSync(path.join(repo, '.tollgaterc.json'), 'utf8'));
  rc.autoFix = true;
  rc.checks.trailingWhitespace = { enabled: true, severity: 'error' };
  write('.tollgaterc.json', JSON.stringify(rc, null, 2));
  write('src/ws.js', 'const w = 1;   \n');
  git('add', '.');
  const r = commit('style: whitespace');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /protected branch|Committing directly/);
  assert.match(r.out, /auto-fixed/);
  assert.equal(git('show', 'HEAD:src/ws.js').out, 'const w = 1;\n');
});

test('uninstall restores', () => {
  const r = sh('node', [CLI, 'uninstall']);
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')));
});

test('Biome check auto-detects biome.json and blocks lint errors', () => {
  const biomePkg = path.resolve(__dirname, '..', '..', 'node_modules', '@biomejs');
  if (!fs.existsSync(biomePkg) || process.platform === 'win32') return; // uses file symlinks
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-biome-'));
  git('init', '-q', '-b', 'feature/biome');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(biomePkg, path.join(repo, 'node_modules', '@biomejs'));
  fs.symlinkSync(path.join(biomePkg, 'biome', 'bin', 'biome'), path.join(repo, 'node_modules', '.bin', 'biome'));
  write('.gitignore', 'node_modules\n');
  write('package.json', JSON.stringify({ name: 'b', devDependencies: { '@biomejs/biome': '1.9.4' } }));
  write('biome.json', JSON.stringify({ linter: { enabled: true, rules: { recommended: true } }, formatter: { enabled: false } }));
  write('src/a.ts', 'export function f(a: any) {\n  return a == null;\n}\n');
  git('add', '.');
  assert.equal(sh('node', [CLI, 'install']).code, 0);
  let r = commit('feat: add biome demo');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Biome check/);
  assert.match(r.out, /src\/a\.ts:1:\d+/);
  write('src/a.ts', 'export function f(a: string | null) {\n  return a === null;\n}\n');
  git('add', '.');
  r = commit('feat: add biome demo');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Biome check\s+\d+ file\(s\) clean/);
});

test('Prettier check auto-detects .prettierrc, blocks unformatted files, and applyFixes formats + re-stages', () => {
  const prettierPkg = path.resolve(__dirname, '..', '..', 'node_modules', 'prettier');
  if (!fs.existsSync(prettierPkg) || process.platform === 'win32') return; // uses file symlinks
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prettier-'));
  git('init', '-q', '-b', 'feature/prettier');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(prettierPkg, path.join(repo, 'node_modules', 'prettier'));
  fs.symlinkSync(path.join(prettierPkg, 'bin', 'prettier.cjs'), path.join(repo, 'node_modules', '.bin', 'prettier'));
  write('.gitignore', 'node_modules\n');
  write('.prettierrc', JSON.stringify({ singleQuote: true }));
  write('.prettierignore', '*.json\n.prettierrc\n');
  write('package.json', JSON.stringify({ name: 'p' }));
  write('src/a.ts', 'const  x = {a:1,b:"two"}\nexport default x\n');
  git('add', '.');
  assert.equal(sh('node', [CLI, 'install']).code, 0);

  let r = commit('feat: add prettier demo');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Prettier\s+1 file\(s\) not formatted/);
  assert.match(r.out, /src\/a\.ts/);

  write('.tollgaterc.json', JSON.stringify({ checks: { prettier: { applyFixes: true } } }));
  git('add', '.');
  r = commit('feat: add prettier demo');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Formatted & re-staged/);
  assert.equal(git('show', 'HEAD:src/a.ts').out, "const x = { a: 1, b: 'two' };\nexport default x;\n");

  write('src/b.ts', 'const = ;\n');
  git('add', '.');
  r = commit('feat: add broken file');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /syntax error/);
});

test('.NET: dotnet format + build block a broken C# commit; applyFixes formats and re-stages', () => {
  const v = spawnSync('dotnet', ['--version'], { encoding: 'utf8', env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  if (v.status !== 0) return; // no .NET SDK on this machine
  const tfm = `net${v.stdout.trim().split('.')[0] ?? '8'}.0`;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dotnet-'));
  git('init', '-q', '-b', 'feature/dotnet');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  // Offline-friendly: no package sources needed for a dependency-free library.
  write('nuget.config', '<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSources><clear /></packageSources></configuration>\n');
  write('.gitignore', 'bin/\nobj/\n');
  write(
    'src/Lib/Lib.csproj',
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${tfm}</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>\n`,
  );
  write(
    'src/Lib/Greeter.cs',
    'namespace Lib;\n\npublic class Greeter\n{\n    public string Greet(string name)\n    {\n          var   message = "Hello " + name;\n        return mesage;\n    }\n}\n',
  );
  git('add', '.');
  assert.equal(sh('node', [CLI, 'install']).code, 0);
  // Pre-restore the dependency-free project to create assets.json for later --no-restore builds.
  sh('dotnet', ['restore', 'src/Lib/Lib.csproj'], { DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });

  let r = commit('feat: add greeter');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /dotnet format/);
  assert.match(r.out, /src\/Lib\/Greeter\.cs:7:\d+\s+Fix whitespace formatting/);
  assert.match(r.out, /src\/Lib\/Greeter\.cs:8:16\s+The name 'mesage' does not exist/);

  // Fix the compile error but leave the formatting: applyFixes should format + re-stage it.
  write(
    'src/Lib/Greeter.cs',
    'namespace Lib;\n\npublic class Greeter\n{\n    public string Greet(string name)\n    {\n          var   message = "Hello " + name;\n        return message;\n    }\n}\n',
  );
  write('.tollgaterc.json', JSON.stringify({ checks: { dotnet: { format: { applyFixes: true } } } }));
  git('add', '.');
  r = commit('feat: add greeter');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dotnet build\s+Built Lib\.csproj/);
  assert.match(git('show', 'HEAD:src/Lib/Greeter.cs').out, /\n {8}var message = "Hello " \+ name;\n/);
});

function freshRepo(prefix: string, branch: string) {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
}

test('monorepo without a root package.json: package scripts and Biome run from the owning package', () => {
  freshRepo('tg-mono-js-', 'feature/mono');
  // apps/api: a lint script that fails on "var ". apps/web: Biome, installed in that package only.
  write('apps/api/package.json', JSON.stringify({ name: 'api', scripts: { lint: 'node lint.js' } }));
  write(
    'apps/api/lint.js',
    `const fs=require('fs');let bad=0;for(const f of fs.readdirSync('src')){const t=fs.readFileSync('src/'+f,'utf8');t.split('\\n').forEach((l,i)=>{if(l.includes('var ')){console.log('src/'+f+':'+(i+1)+':1: no-var Unexpected var');bad++;}});}process.exit(bad?1:0);\n`,
  );
  write('apps/api/src/ok.js', 'const a = 1;\n');
  write('README.md', '# mono\n');
  git('add', '.');
  assert.equal(sh('node', [CLI, 'install']).code, 0);
  let r = commit('chore: initial');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /apps\/api › lint/);

  write('apps/api/src/bad.js', 'var x = 1;\n');
  git('add', '.');
  r = commit('feat: bad api');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /apps\/api › lint/);
  assert.match(r.out, /apps\/api\/src\/bad\.js:1:1/);
  write('apps/api/src/bad.js', 'const x = 1;\n');
  git('add', '.');
  assert.equal(commit('feat: good api').code, 0);

  const biomePkg = path.resolve(__dirname, '..', '..', 'node_modules', '@biomejs');
  if (!fs.existsSync(biomePkg) || process.platform === 'win32') return; // uses file symlinks
  const web = path.join(repo, 'apps', 'web');
  fs.mkdirSync(path.join(web, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(biomePkg, path.join(web, 'node_modules', '@biomejs'));
  fs.symlinkSync(path.join(biomePkg, 'biome', 'bin', 'biome'), path.join(web, 'node_modules', '.bin', 'biome'));
  write('.gitignore', 'node_modules\n');
  write('apps/web/package.json', JSON.stringify({ name: 'web', devDependencies: { '@biomejs/biome': '1.9.4' } }));
  write('apps/web/biome.json', JSON.stringify({ linter: { enabled: true, rules: { recommended: true } }, formatter: { enabled: false } }));
  write('apps/web/src/a.ts', 'export function f(a: any) {\n  return a == null;\n}\n');
  // Outside apps/web: not Biome's business.
  write('scripts/tool.ts', 'export function g(a: any) {\n  return a == null;\n}\n');
  git('add', '.');
  r = commit('feat: add web');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Biome check/);
  assert.match(r.out, /apps\/web\/src\/a\.ts:1:\d+/);
  assert.doesNotMatch(r.out, /scripts\/tool\.ts:\d+/);
  write('apps/web/src/a.ts', 'export function f(a: string | null) {\n  return a === null;\n}\n');
  git('add', '.');
  r = commit('feat: add web');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Biome check\s+\d+ file\(s\) clean in apps\/web/);
});

test('monorepo .NET: a solution in a sub-folder is built from its own folder', () => {
  const v = spawnSync('dotnet', ['--version'], { encoding: 'utf8', env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  if (v.status !== 0) return; // no .NET SDK on this machine
  const tfm = `net${v.stdout.trim().split('.')[0] ?? '8'}.0`;
  freshRepo('tg-mono-dn-', 'feature/mono-dotnet');
  write('frontend/package.json', JSON.stringify({ name: 'fe' }));
  write('backend/nuget.config', '<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSources><clear /></packageSources></configuration>\n');
  write('.gitignore', 'bin/\nobj/\n');
  write(
    'backend/src/Lib/Lib.csproj',
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${tfm}</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>\n`,
  );
  // A classic .sln (readable by every SDK) in the backend folder, nothing at the root.
  write(
    'backend/Backend.sln',
    'Microsoft Visual Studio Solution File, Format Version 12.00\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Lib", "src\\Lib\\Lib.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject\nGlobal\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n\t\tDebug|Any CPU = Debug|Any CPU\n\t\tRelease|Any CPU = Release|Any CPU\n\tEndGlobalSection\n\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\n\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n\t\t{11111111-1111-1111-1111-111111111111}.Debug|Any CPU.Build.0 = Debug|Any CPU\n\t\t{11111111-1111-1111-1111-111111111111}.Release|Any CPU.ActiveCfg = Release|Any CPU\n\t\t{11111111-1111-1111-1111-111111111111}.Release|Any CPU.Build.0 = Release|Any CPU\n\tEndGlobalSection\nEndGlobal\n',
  );
  write(
    'backend/src/Lib/Greeter.cs',
    'namespace Lib;\n\npublic class Greeter\n{\n    public string Greet(string name)\n    {\n        return mesage;\n    }\n}\n',
  );
  write('.tollgaterc.json', JSON.stringify({ checks: { dotnet: { format: { enabled: false } } } }));
  git('add', '.');
  assert.equal(sh('node', [CLI, 'install']).code, 0);
  // Pre-restore the dependency-free project to create assets.json for later --no-restore builds.
  sh('dotnet', ['restore', 'backend/Backend.sln'], { DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });

  let r = commit('feat: add greeter');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /dotnet build/);
  assert.match(r.out, /backend\/src\/Lib\/Greeter\.cs:7:16\s+The name 'mesage' does not exist/);
  write(
    'backend/src/Lib/Greeter.cs',
    'namespace Lib;\n\npublic class Greeter\n{\n    public string Greet(string name)\n    {\n        return "Hello " + name;\n    }\n}\n',
  );
  git('add', '.');
  r = commit('feat: add greeter');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dotnet build\s+Built Backend\.sln/);
});
