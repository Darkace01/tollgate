# Pre-Commit Guard

Configurable pre-commit checks for VS Code **and** the terminal. It works without any setup: it runs the lint, typecheck and format scripts in your `package.json`, runs Biome if you use it, and stops secrets, conflict markers, debug statements and oversized or forbidden files from being committed. You can turn every check on or off, tune it, or add your own shell commands.

Commits are checked whether you make them from the Source Control panel, the terminal, or another Git client. The extension installs real git hooks that call a small self-contained runner, so checks run on every commit, and the results appear in VS Code.

## Features

- **Uses your package.json scripts.** It finds `lint`, `typecheck`, `tsc`, `format:check`, `prettier:check` and similar scripts, detects your package manager (npm/yarn/pnpm/bun), and can scan monorepos per package.
- **Biome built in.** If the repo has `biome.json(c)` or `@biomejs/biome`, it runs `biome check` on staged files. It can apply safe fixes and re-stage the files.
- **lint-staged** runs automatically when the repo has a lint-staged config.
- **Content checks** (only on lines you added, so old code never blocks you):
  - secrets: AWS, GitHub, GitLab, Slack, Stripe, Google, OpenAI, Anthropic, npm, Azure, SendGrid, JWTs, private keys, credentials in URLs and hard-coded passwords. Matches are masked in the output.
  - merge conflict markers
  - debug statements: `console.log`, `debugger`, `.only` tests, `pdb`, `binding.pry`
  - TODO/FIXME comments
  - trailing whitespace and missing final newline (both auto-fixable)
  - JSON that doesn't parse
- **Git hygiene:** large files, forbidden files (`.env`, `*.pem`, keys…), protected branches, branch naming rules, commit message rules (Conventional Commits, ticket references, length limits).
- **Custom checks:** run any shell command, with optional glob filters, `{files}` substitution and re-staging for formatters. A custom check can run at the pre-commit, commit-msg or pre-push stage.
- **Presets:** `minimal`, `recommended` (the default), `strict` or `none`. Your overrides apply on top of the preset.
- **UI:** a results view in the Source Control panel with one-click enable/disable, run and change-severity actions. Findings show in the Problems panel and you can click through to the line. A status bar item shows the last result, and you get a notification when a terminal commit is blocked.
- **Team config:** commit `.precommitrc.json` so everyone gets the same rules. Personal overrides go in `.precommitrc.local.json`.
- **Plays nicely with others:** existing hooks are kept and run first. Husky / `core.hooksPath` repos get a guarded one-liner instead of overwriting files.

## Getting started

1. Install the extension (`code --install-extension precommit-guard-1.0.0.vsix`, or *Extensions → … → Install from VSIX*).
2. Open a git repository. When prompted, click **Install hooks**. You can also run **Pre-Commit Guard: Install Git Hooks** yourself.
3. Commit as usual. To run checks without committing, use the ▶ button in the **Pre-Commit Guard** view (Source Control panel).

## Configuration

Settings are merged in this order (later wins):

`defaults → preset (extends) → VS Code settings → package.json "precommitGuard" → .precommitrc.json → .precommitrc.local.json`

The fastest way to configure is from the UI: **Enable / Disable Checks…**, **Add Custom Check…**, **Choose Preset…**. Changes go to `.precommitrc.json` if it exists, otherwise to workspace settings. The `precommitGuard.configTarget` setting controls this. Both files get autocomplete and validation from a JSON schema.

```jsonc
// .precommitrc.json
{
  "extends": "recommended",
  "failOn": "error",               // "warning" makes warnings block too
  "checks": {
    "npmScripts": { "scripts": ["lint", "typecheck", "test"], "scope": "affected" },
    "biome": { "mode": "check", "applyFixes": true },
    "secrets": { "allowlist": ["EXAMPLE_KEY"] },
    "debugStatements": { "severity": "error" },
    "protectedBranches": { "branches": ["main", "release/*"], "severity": "error" },
    "commitMessage": { "enabled": true, "requireTicket": true, "ticketPattern": "PROJ-\\d+" },
    "largeFiles": { "maxSizeKB": 500 }
  },
  "custom": [
    { "name": "Stylelint", "command": "npx stylelint {files}", "glob": "**/*.{css,scss}" },
    { "name": "Prettier", "command": "npx prettier --write {files}", "glob": "**/*.{ts,tsx,md}", "restage": true },
    { "name": "Unit tests", "command": "npm test", "stage": "pre-push" }
  ]
}
```

### Built-in checks

| id | Default (recommended) | What it does |
|---|---|---|
| `npmScripts` | on, error | Runs matching package.json scripts when relevant files are staged |
| `biome` | auto, error | `biome check` on staged files when Biome is configured |
| `lintStaged` | auto, error | Runs lint-staged when configured |
| `secrets` | on, error | Detects keys, tokens and credentials |
| `conflictMarkers` | on, error | `<<<<<<<`, `>>>>>>>`, `=======` |
| `jsonSyntax` | on, error | Staged `.json` must parse |
| `largeFiles` | on, error | Files over `maxSizeKB` (1024) |
| `forbiddenFiles` | on, error | `.env`, keys, certificates… |
| `debugStatements` | on, warning | console.log, debugger, `.only`, pdb… |
| `protectedBranches` | on, warning | Direct commits to main/master |
| `todoComments` | off | New TODO/FIXME |
| `trailingWhitespace` | off | Auto-fixable |
| `eofNewline` | off | Auto-fixable |
| `branchName` | off | Branch must match a pattern |
| `commitMessage` | off | Conventional Commits, tickets, length |

### Skipping checks

- Ignore a single line: add `precommit-guard-ignore` (or `pragma: allowlist secret`) as a comment on that line.
- Skip some checks for one commit: `SKIP=secrets,npmScripts git commit -m "…"`
- Skip everything for one commit: `git commit --no-verify`
- Pause for the workspace: **Pre-Commit Guard: Pause / Resume Checks**

### Auto-fix

Set `"autoFix": true` and enable `trailingWhitespace` / `eofNewline`. The hook will then fix those problems and re-stage the files. Files with unstaged changes are never re-staged. You can also run **Auto-fix Whitespace & EOF in Staged Files** on demand.

## Command line

The runner is copied to `.git/precommit-guard/runner.js` and works on its own:

```sh
node .git/precommit-guard/runner.js run            # check staged changes
node .git/precommit-guard/runner.js run --all      # check every tracked file
node .git/precommit-guard/runner.js run --only secrets,biome --json
node .git/precommit-guard/runner.js config         # show resolved config and sources
node .git/precommit-guard/runner.js fix
```

## How it works

```
VS Code extension ──installs──▶ .git/hooks/{pre-commit,commit-msg,pre-push}  (sh)
        │                                │
        │ snapshots settings             ▼
        └──────────▶ .git/precommit-guard/ runner.js  ──writes──▶ last-<stage>.json
                                                                       │
                       results view · Problems · status bar ◀── watches┘
```

The hook uses `node` from your PATH. If node isn't there, it falls back to VS Code's bundled runtime. If the runner is missing or crashes, the hook never blocks your commit.

## Development

```sh
npm install
npm run build      # schema + esbuild bundle
npm run lint       # Biome
npm test           # unit + end-to-end git tests + extension smoke test
npm run package    # → precommit-guard-x.y.z.vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host.
