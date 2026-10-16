# Contributing to Tollgate

Thanks for helping! This guide covers local development.

## Setup

```sh
npm install
npm run build        # generates the JSON schema + bundles dist/extension.js and dist/cli.js
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with Tollgate loaded. To get the launch config, copy the files in `vscode-config/` into `.vscode/` if that folder doesn't exist yet.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Schema + esbuild bundle |
| `npm run watch` | Rebuild on change |
| `npm run lint` / `lint:fix` | [Biome](https://biomejs.dev) lint + format check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests, end-to-end tests that make real git commits (including real Biome and Prettier runs), and an extension smoke test against a mocked VS Code API |
| `npm run package` | Build `tollgate-x.y.z.vsix` |

## Project layout

```
src/
  cli.ts                 # the git-hook runner (bundled to dist/cli.js, copied into .git/tollgate/runner.js)
  core/                  # editor-independent engine, shared by the runner and the extension
    config.ts            # defaults, presets, layered config loading
    engine.ts            # collects + runs checks, writes .git/tollgate/last-<stage>.json
    git.ts               # staged file sets, added-line diff parsing
    hooks.ts             # hook install/uninstall, Husky integration
    checks/builtin.ts    # secrets, conflict markers, debug statements, branches, commit message…
    checks/commands.ts   # package.json scripts, Biome, Prettier, lint-staged, custom commands, output parsing
  extension/             # VS Code UI: tree view, diagnostics, status bar, commands, settings sync
scripts/schema.js        # single source of truth for the config schema (+ package.json settings)
test/                    # node:test suites + smoke test
```

The config schema lives in `scripts/schema.js`. Running `npm run build` regenerates `schemas/tollgaterc.schema.json` and the `contributes.configuration` section of `package.json`, so edit the script rather than those generated files.

## Adding a built-in check

1. Add its config type to `src/core/types.ts` (`ChecksConfig`) and its defaults to `baseDefaults()` in `src/core/config.ts`.
2. Implement it in `src/core/checks/` and register it in `builtinChecks()`, or in `collectChecks()` for command-based checks.
3. Add a label in `BUILTIN_LABELS` (`src/extension/tree.ts`) and a schema entry in `scripts/schema.js`.
4. Add tests and document it in the README table.

## Dogfooding

This repo uses Tollgate on itself (see `.tollgaterc.json`). Test fixtures that contain fake secrets carry a `tollgate-ignore` comment.
