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
- When a hook blocks a commit, the first line of its output names the failing check and the reason, so GUI clients such as VS Code's commit dialog show something useful. Passing hooks are silent outside a terminal; set `TOLLGATE_VERBOSE=1` to see their output anyway.
- Commit subjects can be up to 500 characters by default (`commitMessage.maxSubjectLength`, where `0` means no limit). The `strict` preset uses 100.
