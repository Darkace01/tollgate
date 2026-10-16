# Changelog

All notable changes to Tollgate are documented here.

## [1.0.0]

First public release.

- Real git hooks (`pre-commit`, `commit-msg`, `pre-push`) backed by a self-contained runner, so checks run for commits from VS Code, the terminal or any Git client.
- Built-in checks: package.json scripts, **Biome**, **Prettier** (check, or format and re-stage), lint-staged, secrets, merge conflict markers, debug statements, TODOs, trailing whitespace, final newline, JSON syntax, large files, forbidden files, protected branches, branch naming, and commit message format (Conventional Commits, ticket IDs).
- Custom command checks with `{files}` and other placeholders, glob filters, per-stage control, and re-staging for formatters.
- Presets (`minimal`, `recommended`, `strict`, `none`) and layered config: `.tollgaterc.json`, `.tollgaterc.local.json`, `package.json#tollgate` and VS Code settings, with a JSON schema for autocomplete.
- Checks view with one-click enable/disable, re-run and severity changes, plus a badge, Problems panel diagnostics, a status bar item and notifications.
- Skip checks with `SKIP=`, inline `tollgate-ignore` comments, or pause Tollgate for a workspace.
- Husky / `core.hooksPath` integration, and chaining of existing hooks.
