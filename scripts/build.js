// Bundles the extension and the standalone git-hook runner with esbuild.
const esbuild = require('esbuild');
const pkg = require('../package.json');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: !production, minify: production, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', sourcemap: false, define: { __VERSION__: JSON.stringify(pkg.version) } },
];

(async () => {
  if (watch) {
    for (const b of builds) await (await esbuild.context(b)).watch();
  } else {
    await Promise.all(builds.map((b) => esbuild.build(b)));
  }
})().catch(() => process.exit(1));
