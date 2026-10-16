# Tollgate — Pre-Commit Checks for Visual Studio

**Every commit stops at the gate.** Tollgate checks your staged changes before they reach the repository, whether you commit from Visual Studio's Git Changes window, the terminal, or any other Git client.

C# and .NET work out of the box:

- **`dotnet format`**: style and formatting problems in staged C#/VB files, following your `.editorconfig`.
- **`dotnet build`**: compile errors, reported with file and line.
- **CSharpier**: when your repo uses it (`.config/dotnet-tools.json` or `.csharpierrc`).
- **`dotnet test`**: optional, on push.

It also checks every commit for:

- **secrets**, including connection-string passwords, AWS/Azure/GitHub/Stripe keys and private keys (masked in the output)
- **debug code** such as `Debugger.Break()` and `Debugger.Launch()`
- **merge conflict markers**
- **JSON syntax** (comments are allowed in `appsettings.json` and `launchSettings.json`)
- **large files**
- **files that should never be committed**: `.suo`, `*.user`, `bin/` and `obj/` output, `*.publishsettings`, `.env` and keys
- **protected branches**, **branch naming** and **commit message format** (Conventional Commits, ticket IDs)
- **your own commands**: any shell command can be a check

## How it works

1. Open a solution or folder in a git repository. Tollgate offers to **install git hooks**.
2. Commit as usual. If a blocking check fails, the commit is stopped. The **Tollgate** window shows what failed, and findings also appear in the **Error List**. Double-click a finding to jump to the line.
3. Run checks at any time from **Tools › Tollgate › Run Checks on Staged Changes**.

The checks run inside real git hooks, so commits from the terminal and other Git clients are protected too.

## Configure

Your rules live in the repository, in **`.tollgaterc.json`**, which is shared with your team, the Tollgate VS Code extension and CI. Run **Tools › Tollgate › Open .tollgaterc.json** to create one, or turn checks on and off from the Tollgate window (right-click a check).

```jsonc
{
  "extends": "recommended",            // minimal | recommended | strict | none
  "checks": {
    "dotnet": {
      "format": { "applyFixes": true },  // format and re-stage instead of failing
      "build": { "configuration": "Debug", "warningsAsErrors": false },
      "test": { "enabled": true, "stage": "pre-push" }
    },
    "commitMessage": { "enabled": true, "requireTicket": true }
  }
}
```

Skip checks for one commit with `SKIP=dotnet git commit …`, ignore a single line with a `// tollgate-ignore` comment, or pause Tollgate just for you with **Tools › Tollgate › Pause**.

## Requirements

- Visual Studio 2022 or later
- **Node.js** (LTS). Tollgate's runner is a small Node script shared by every editor. The copy installed with Visual Studio's JavaScript/TypeScript tools works too, or you can set a path in **Tools › Options › Tollgate**.
- The **.NET SDK** for the .NET checks. Without it, they're skipped, never blocking.

Also available for [VS Code](https://marketplace.visualstudio.com/items?itemName=KazeemQuadri.tollgate). Source and issues: [github.com/Darkace01/tollgate](https://github.com/Darkace01/tollgate).
