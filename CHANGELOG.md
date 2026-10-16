# Changelog

## 1.0.0

- First release: git hooks (pre-commit, commit-msg, pre-push) with a self-contained runner.
- Built-in checks: package.json scripts, Biome, lint-staged, secrets, conflict markers, debug statements, TODOs, trailing whitespace, EOF newline, JSON syntax, large files, forbidden files, protected branches, branch naming, commit message format.
- Custom command checks with `{files}` substitution, globs, stages and re-staging.
- Presets, layered configuration (`.precommitrc.json`, package.json, VS Code settings), and a JSON schema.
- Results view, Problems panel diagnostics, status bar item, notifications, auto-fix, and Husky integration.
