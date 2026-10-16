# Publishing Tollgate

Tollgate is set up to publish as **`KazeemQuadri.tollgate`** on the VS Code Marketplace, and optionally on Open VSX for Cursor, VSCodium and Windsurf users.

## One-time setup

### 1. GitHub repo ✅

The code lives at <https://github.com/Darkace01/tollgate> (public). The README's images are loaded from there (`vsce` rewrites `images/…` to `https://github.com/Darkace01/tollgate/raw/HEAD/images/…`), so keep the repo public.

> Moving the repo? Update `repository`, `homepage` and `bugs` in `package.json`, plus the two links at the bottom of `README.md`.

### 2. Create the Marketplace publisher

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account.
2. **Create publisher**, with ID `KazeemQuadri`. It must match `"publisher"` in `package.json`.

### 3. Create a Personal Access Token (PAT)

1. Go to <https://dev.azure.com>. Create an organisation if you don't have one; any name works.
2. User settings → **Personal access tokens** → **New Token**.
   - Organization: **All accessible organizations** (this is required)
   - Scopes: **Custom defined** → **Marketplace → Manage**
3. Copy the token.

### 4. (Optional) Open VSX

1. Sign in at <https://open-vsx.org> with GitHub, and sign the Publisher Agreement in your profile.
2. Create an access token in your profile settings.
3. Create the namespace once: `npx ovsx create-namespace KazeemQuadri -p <token>`

### 5. Add the tokens to GitHub

Repo → Settings → Secrets and variables → Actions:

- `VSCE_PAT` — the Azure DevOps token
- `OVSX_PAT` — the Open VSX token (optional; that step is skipped without it)

## Releasing

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Commit, then tag and push:
   ```sh
   git tag v1.0.0
   git push origin main --tags
   ```
3. The **Release** workflow lints, tests, packages, publishes to the Marketplace (and Open VSX), and attaches the `.vsix` to a GitHub release.

New versions usually show up on the Marketplace within a few minutes, after Microsoft's automated scan.

## Publishing by hand (alternative)

```sh
npx vsce login KazeemQuadri         # paste the PAT
npm run publish:vsce                # or: npx vsce publish patch  (bumps the version too)
npx ovsx publish -p <open-vsx-token> # optional
```

## Pre-flight checklist

- [ ] `npm run lint && npm test` pass
- [ ] `npm run package` prints no warnings, and `npx vsce ls` lists only `dist/`, `media/`, `schemas/`, the README, CHANGELOG, LICENSE and `package.json`
- [ ] The repo is public, so the README images load
- [ ] The version is bumped and the CHANGELOG is updated
- [ ] You've installed the `.vsix` locally (**Extensions → … → Install from VSIX**) and made a test commit
