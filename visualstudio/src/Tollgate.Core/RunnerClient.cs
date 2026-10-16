using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Tollgate.Core
{
    public sealed class RunnerException : Exception
    {
        public RunnerException(string message, string output) : base(message) => Output = output;

        public string Output { get; }
    }

    /// <summary>
    /// Talks to the Tollgate runner (a single dependency-free Node script, the same one the git hooks run).
    /// All logic lives in the runner, so every editor behaves identically.
    /// </summary>
    public sealed class RunnerClient
    {
        private static readonly TimeSpan QuickTimeout = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan RunTimeout = TimeSpan.FromMinutes(20);

        public RunnerClient(string nodePath, string runnerPath)
        {
            NodePath = nodePath;
            RunnerPath = runnerPath;
        }

        public string NodePath { get; }

        /// <summary>The runner bundled with the extension (dist/cli.js).</summary>
        public string RunnerPath { get; }

        public async Task<string> GetVersionAsync(CancellationToken ct = default)
        {
            var r = await InvokeAsync(Directory.GetCurrentDirectory(), new[] { "--version" }, QuickTimeout, ct).ConfigureAwait(false);
            return r.Stdout.Trim();
        }

        public async Task<CatalogInfo> ListAsync(string repoRoot, CancellationToken ct = default)
        {
            var r = await InvokeAsync(repoRoot, new[] { "list", "--json" }, QuickTimeout, ct).ConfigureAwait(false);
            if (r.ExitCode != 0) throw new RunnerException($"tollgate list failed (exit {r.ExitCode})", r.Stderr + r.Stdout);
            return Json.Deserialize<CatalogInfo>(Json.ExtractObject(r.Stdout));
        }

        /// <summary>Run checks. Exit code 1 just means "blocked" — the JSON report is still printed.</summary>
        public async Task<RunReport> RunAsync(string repoRoot, string stage = Stages.PreCommit, bool allFiles = false, IEnumerable<string>? only = null, CancellationToken ct = default)
        {
            var args = new List<string> { "run", "--json", "--stage", stage };
            if (allFiles) args.Add("--all");
            var onlyList = only?.Where(s => !string.IsNullOrWhiteSpace(s)).ToList();
            if (onlyList != null && onlyList.Count > 0)
            {
                args.Add("--only");
                args.Add(string.Join(",", onlyList));
            }
            var r = await InvokeAsync(repoRoot, args, RunTimeout, ct).ConfigureAwait(false);
            if (r.TimedOut) throw new RunnerException("Tollgate timed out", r.Stderr);
            if (r.ExitCode > 1 || r.Stdout.IndexOf('{') < 0) throw new RunnerException($"tollgate run failed (exit {r.ExitCode})", r.Stderr + r.Stdout);
            return Json.Deserialize<RunReport>(Json.ExtractObject(r.Stdout));
        }

        public Task<ProcessResult> InstallHooksAsync(string repoRoot, string? nodeFallback = null, bool force = false, CancellationToken ct = default)
        {
            var args = new List<string> { "install" };
            if (force) args.Add("--force");
            if (!string.IsNullOrEmpty(nodeFallback))
            {
                args.Add("--node-fallback");
                args.Add(nodeFallback!);
            }
            return InvokeCheckedAsync(repoRoot, args, ct);
        }

        public Task<ProcessResult> UninstallHooksAsync(string repoRoot, CancellationToken ct = default) =>
            InvokeCheckedAsync(repoRoot, new[] { "uninstall" }, ct);

        public Task<ProcessResult> InitConfigAsync(string repoRoot, CancellationToken ct = default) =>
            InvokeAsync(repoRoot, new[] { "init" }, QuickTimeout, ct);

        public Task<ProcessResult> FixAsync(string repoRoot, CancellationToken ct = default) =>
            InvokeCheckedAsync(repoRoot, new[] { "fix" }, ct);

        /// <param name="local">Write the personal .tollgaterc.local.json instead of the shared .tollgaterc.json.</param>
        public Task<ProcessResult> ToggleAsync(string repoRoot, string checkId, bool enabled, bool local, CancellationToken ct = default)
        {
            var args = new List<string> { "toggle", checkId, enabled ? "on" : "off" };
            if (local) args.Add("--local");
            return InvokeCheckedAsync(repoRoot, args, ct);
        }

        /// <param name="jsonValue">A JSON literal, e.g. <c>"\"warning\""</c>, <c>false</c>, <c>500</c>.</param>
        public Task<ProcessResult> SetConfigAsync(string repoRoot, string dottedPath, string jsonValue, bool local, CancellationToken ct = default)
        {
            var args = new List<string> { "config", "set", dottedPath, jsonValue };
            if (local) args.Add("--local");
            return InvokeCheckedAsync(repoRoot, args, ct);
        }

        /// <summary>The newest report the hook or a manual run wrote for a stage, if any.</summary>
        public static RunReport? ReadLastReport(string stateDir, string stage)
        {
            var file = Path.Combine(stateDir, $"last-{stage}.json");
            if (!File.Exists(file)) return null;
            for (var attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    return Json.Deserialize<RunReport>(File.ReadAllText(file));
                }
                catch (IOException)
                {
                    Thread.Sleep(50); // being replaced by the hook
                }
                catch (System.Runtime.Serialization.SerializationException)
                {
                    return null;
                }
            }
            return null;
        }

        private async Task<ProcessResult> InvokeCheckedAsync(string repoRoot, IEnumerable<string> args, CancellationToken ct)
        {
            var r = await InvokeAsync(repoRoot, args, QuickTimeout, ct).ConfigureAwait(false);
            if (r.ExitCode != 0) throw new RunnerException((r.Stderr + r.Stdout).Trim(), r.Stderr + r.Stdout);
            return r;
        }

        private Task<ProcessResult> InvokeAsync(string cwd, IEnumerable<string> args, TimeSpan timeout, CancellationToken ct) =>
            ProcessRunner.RunAsync(NodePath, new[] { RunnerPath }.Concat(args), cwd, timeout, ct);
    }
}
