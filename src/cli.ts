#!/usr/bin/env node
/* Tollgate runner — invoked by git hooks, usable standalone. No dependencies. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, sampleConfig } from './core/config';
import { fixFiles, isBlocking, runChecks } from './core/engine';
import { findRepoRoot, stageFiles, stagedFiles, unstagedFiles } from './core/git';
import { editorSettingsPath, installHooks, uninstallHooks } from './core/hooks';
import { formatReport, headline } from './core/reporter';
import type { GuardConfig, Stage } from './core/types';

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

const HELP = `Tollgate ${VERSION}

Usage:
  runner hook <pre-commit|commit-msg|pre-push> [git args]   (called by git)
  runner run [--all] [--stage <stage>] [--only a,b] [--skip a,b] [--json] [--verbose]
  runner fix                 Fix trailing whitespace / EOF newlines in staged files
  runner config              Print the resolved configuration
  runner init                Create a .tollgaterc.json in the repo root
  runner install [--force]   Install git hooks (copies this runner into .git)
  runner uninstall           Remove git hooks

Environment:
  SKIP=id1,id2               Skip checks by id (prefix match, e.g. SKIP=npmScripts)
  TOLLGATE=0          Disable all checks
  TOLLGATE_VERBOSE=1         Print results of passing hooks even when not in a terminal
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (['stage', 'only', 'skip'].includes(k)) flags[k] = argv[++i] ?? '';
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

const list = (v: unknown) =>
  typeof v === 'string' && v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

async function main(): Promise<number> {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] ?? 'help';
  if (flags.version || cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (cmd === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }
  if (process.env.TOLLGATE === '0') return 0;

  const root = await findRepoRoot(process.cwd());
  if (!root) {
    console.error('tollgate: not inside a git repository');
    return cmd === 'hook' ? 0 : 2;
  }
  const editorSettingsFile = await editorSettingsPath(root);
  const color = !!process.stderr.isTTY && !process.env.NO_COLOR;

  switch (cmd) {
    case 'hook':
    case 'run': {
      const stage = (cmd === 'hook' ? pos[1] : (flags.stage as string) || 'pre-commit') as Stage;
      if (!['pre-commit', 'commit-msg', 'pre-push'].includes(stage)) {
        console.error(`Unknown stage: ${stage}`);
        return 2;
      }
      let config: GuardConfig;
      try {
        config = loadConfig(root, { editorSettingsFile }).config;
      } catch (e) {
        console.error(`tollgate: ${(e as Error).message}`);
        return cmd === 'hook' ? 1 : 2;
      }
      const report = await runChecks({
        root,
        stage,
        config,
        source: cmd === 'hook' ? 'hook' : 'cli',
        mode: flags.all ? 'all' : 'staged',
        msgFile: stage === 'commit-msg' ? path.resolve(root, pos[2] ?? '.git/COMMIT_EDITMSG') : undefined,
        only: list(flags.only),
        skip: [...(list(flags.skip) ?? []), ...(list(process.env.SKIP) ?? [])],
      });
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      else if (cmd === 'hook') {
        // GUI clients (VS Code's commit button, GitHub Desktop…) show only the FIRST line of the hook's
        // output, and git sends every hook's output to stderr. So: when blocked, lead with a one-line
        // reason; when passing outside a terminal, stay quiet so an earlier stage's banner never becomes
        // the error message shown for a later stage's failure.
        if (report.blocked) {
          console.error(`${headline(report, (r) => isBlocking(r, config))}\n${formatReport(report, { color, verbose: !!flags.verbose })}`);
        } else if ((process.stderr.isTTY || process.env.TOLLGATE_VERBOSE === '1') && report.results.length) {
          console.error(formatReport(report, { color, verbose: !!flags.verbose }));
        }
      } else console.error(formatReport(report, { color, verbose: !!flags.verbose }));
      return report.blocked ? 1 : 0;
    }
    case 'fix': {
      const config = loadConfig(root, { editorSettingsFile }).config;
      const partial = new Set(await unstagedFiles(root));
      const staged = await stagedFiles(root);
      const changed = await fixFiles(root, staged, config);
      const restage = changed.filter((f) => !partial.has(f));
      await stageFiles(root, restage);
      console.log(changed.length ? `Fixed ${changed.length} file(s):\n  ${changed.join('\n  ')}` : 'Nothing to fix.');
      const left = changed.filter((f) => partial.has(f));
      if (left.length) console.log(`Not re-staged (partially staged): ${left.join(', ')}`);
      return 0;
    }
    case 'config': {
      const { config, sources } = loadConfig(root, { editorSettingsFile });
      console.log(JSON.stringify({ sources, config }, null, 2));
      return 0;
    }
    case 'init': {
      const f = path.join(root, '.tollgaterc.json');
      if (fs.existsSync(f)) {
        console.error('.tollgaterc.json already exists');
        return 1;
      }
      fs.writeFileSync(f, JSON.stringify(sampleConfig(), null, 2) + '\n');
      console.log(`Created ${f}`);
      return 0;
    }
    case 'install': {
      const config = loadConfig(root, { editorSettingsFile }).config;
      const r = await installHooks(root, { stages: config.hooks, runnerSource: __filename, version: VERSION, force: !!flags.force });
      if (!r.ok) {
        console.error(`core.hooksPath is set to "${r.hooksPath}" (husky?). Re-run with --force, or use the VS Code command "Integrate with Husky".`);
        return 1;
      }
      console.log(`Installed hooks: ${r.installed.join(', ')}${r.backedUp.length ? ` (existing hooks kept and chained: ${r.backedUp.join(', ')})` : ''}`);
      return 0;
    }
    case 'uninstall': {
      const removed = await uninstallHooks(root);
      console.log(removed.length ? `Removed hooks: ${removed.join(', ')}` : 'No Tollgate hooks installed.');
      return 0;
    }
    default:
      console.error(HELP);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`tollgate crashed: ${e?.stack ?? e}`);
    // Never block a commit because of an internal bug.
    process.exit(process.argv[2] === 'hook' ? 0 : 2);
  },
);
