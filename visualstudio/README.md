# Tollgate for Visual Studio

The Visual Studio 2022+ version of Tollgate. It shares the runner and `.tollgaterc.json` with the VS Code extension, so every check (including the C#/.NET ones) behaves the same in both editors, in the terminal and in CI.

The user-facing description is in [`src/Tollgate.VisualStudio/overview.md`](src/Tollgate.VisualStudio/overview.md), which is also the Marketplace page.

## Layout

| Path | What it is |
| --- | --- |
| `src/Tollgate.Core` | netstandard2.0 / net10.0 library with no dependencies: finds the repo and Node.js, calls the runner (`node runner.js … --json`), parses reports, and watches `.git/tollgate/last-*.json`. |
| `src/Tollgate.VisualStudio` | The VSIX: package, Tools › Tollgate commands, the Tollgate tool window, Error List integration and Tools › Options › Tollgate. Built on the [Community Visual Studio Toolkit](https://github.com/VsixCommunity/Community.VisualStudio.Toolkit). |
| `tests/Tollgate.Core.Tests` | A small test program that runs `Tollgate.Core` against the real runner. |

All of the checking logic lives in the runner (`dist/cli.js` at the repo root). The VSIX bundles a copy as `runner/cli.js` and installs it into `.git/tollgate/` when it installs the hooks.

## Build

Requires Windows, Visual Studio 2022 (17.13 or later, for `.slnx` solutions) with the **Visual Studio extension development** workload, and Node.js. Without that workload, Visual Studio can't load `Tollgate.VisualStudio.csproj` and reports "The application which this project type is based on was not found". Add the workload in the Visual Studio Installer (**Modify › Workloads › Visual Studio extension development**).

```powershell
npm ci
npm run build                     # builds dist/cli.js, which the VSIX bundles
msbuild visualstudio\src\Tollgate.VisualStudio\Tollgate.VisualStudio.csproj /restore /p:Configuration=Release
```

The VSIX is written to `visualstudio\src\Tollgate.VisualStudio\bin\Release\Tollgate.VisualStudio.vsix`. CI builds it on every push (the `visualstudio` job), and you can download it from the run's artifacts.

To debug, open `visualstudio\Tollgate.VisualStudio.slnx`, set **Tollgate.VisualStudio** as the startup project and press **F5**. That launches an experimental instance of Visual Studio with the extension loaded.

Run the Core tests on any OS with the .NET 8 SDK:

```sh
npm run build
dotnet run --project visualstudio/tests/Tollgate.Core.Tests -- dist/cli.js
```

## Publish to the Visual Studio Marketplace

The extension uses the same publisher as the VS Code extension (`KazeemQuadri`). Metadata is in [`publishManifest.json`](src/Tollgate.VisualStudio/publishManifest.json).

1. Bump `Version` in `source.extension.vsixmanifest` (the `Identity` element) and in `Properties/AssemblyInfo.cs`.
2. Build the VSIX in Release.
3. Publish with `VsixPublisher.exe`, which is installed with the VS SDK:

   ```powershell
   $publisher = "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VSSDK\VisualStudioIntegration\Tools\Bin\VsixPublisher.exe"
   & $publisher publish `
     -payload visualstudio\src\Tollgate.VisualStudio\bin\Release\Tollgate.VisualStudio.vsix `
     -publishManifest visualstudio\src\Tollgate.VisualStudio\publishManifest.json `
     -personalAccessToken $env:VSCE_PAT
   ```

   The same Azure DevOps PAT (scope **Marketplace → Manage**) works for both extensions. You can also upload the `.vsix` by hand at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage).
