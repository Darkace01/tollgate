using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Threading;
using Tollgate.Core;
using Task = System.Threading.Tasks.Task;
using TaskScheduler = System.Threading.Tasks.TaskScheduler;

namespace Tollgate.VisualStudio
{
    /// <summary>
    /// Owns Tollgate's state for the open solution: the repository, the check catalog, the latest reports,
    /// git-hook maintenance, and the Error List. UI (tool window, commands) observes <see cref="Changed"/>.
    /// All checking is done by the bundled runner — the same one the git hooks and the VS Code extension use.
    /// </summary>
    internal sealed class TollgateService : IDisposable
    {
        private const string SolutionExplorerWindow = "{3AE79031-E1BC-11D0-8F78-00A0C9110057}";
        private const string DismissedMarker = "vs-hooks-dismissed";

        private readonly AsyncPackage _package;
        private readonly HashSet<string> _ownRuns = new HashSet<string>();
        private SolutionWatcher? _solution;
        private ErrorListReporter? _errors;
        private ReportWatcher? _watcher;
        private OutputWindowPane? _pane;
        private CancellationTokenSource? _runCts;
        private string? _bundledVersion;
        private bool _promptShown;

        private TollgateService(AsyncPackage package) => _package = package;

        public static TollgateService? Instance { get; private set; }

        public event EventHandler? Changed;

        public string? RepoRoot { get; private set; }
        public CatalogInfo? Catalog { get; private set; }
        public Dictionary<string, RunReport> Reports { get; } = new Dictionary<string, RunReport>();
        public bool IsRunning { get; private set; }
        /// <summary>Why Tollgate can't work right now (no repo, no Node.js, config error…), if anything.</summary>
        public string? Problem { get; private set; }
        public RunnerClient? Client { get; private set; }

        public bool IsReady => RepoRoot != null && Client != null && Catalog != null;
        public bool HooksInstalled => Catalog?.Hooks.AnyInstalled == true;

        public static async Task InitializeAsync(AsyncPackage package)
        {
            var service = new TollgateService(package);
            Instance = service;
            await service.StartAsync();
        }

        private async Task StartAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var solution = (IVsSolution?)await _package.GetServiceAsync(typeof(SVsSolution)) ?? throw new InvalidOperationException("IVsSolution service unavailable");
            _solution = new SolutionWatcher(solution);
            _solution.Changed += (_, __) => RefreshAsync().FireAndForget();
            _errors = new ErrorListReporter(_package);
            await RefreshAsync();
        }

        // ------------------------------------------------------------------ state

        public async Task RefreshAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var dir = _solution?.CurrentDirectory;
            var root = RepoLocator.FindRoot(dir);
            if (!string.Equals(root, RepoRoot, StringComparison.OrdinalIgnoreCase))
            {
                _watcher?.Dispose();
                _watcher = null;
                Reports.Clear();
                Catalog = null;
                _promptShown = false;
            }
            RepoRoot = root;
            if (root == null)
            {
                Problem = dir == null ? "Open a solution or folder to use Tollgate." : "This solution isn't inside a git repository.";
                Publish();
                return;
            }
            if (!EnsureClient())
            {
                Publish();
                return;
            }

            try
            {
                var client = Client!;
                await TaskScheduler.Default;
                var catalog = await client.ListAsync(root);
                _bundledVersion ??= await client.GetVersionAsync();
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

                Catalog = catalog;
                Problem = catalog.ConfigError != null ? $"Configuration error: {catalog.ConfigError}" : null;
                foreach (var stage in Stages.All)
                {
                    var report = RunnerClient.ReadLastReport(catalog.StateDir, stage);
                    if (report != null) Reports[stage] = report;
                }
                if (_watcher == null)
                {
                    _watcher = new ReportWatcher(catalog.StateDir);
                    _watcher.ReportChanged += (_, e) => HandleReportAsync(e.Report).FireAndForget();
                }
                Publish();
                await MaintainHooksAsync(catalog);
            }
            catch (Exception ex)
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                Problem = $"Tollgate couldn't read this repository: {FirstLine(ex)}";
                await LogAsync(ex.ToString());
                Publish();
            }
        }

        private bool EnsureClient()
        {
            var extensionDir = Path.GetDirectoryName(typeof(TollgateService).Assembly.Location) ?? "";
            var runner = Path.Combine(extensionDir, "runner", "cli.js");
            string? devenv = null;
            try
            {
                devenv = Process.GetCurrentProcess().MainModule?.FileName;
            }
            catch (Exception)
            {
                // Access to the main module can fail in unusual hosting environments.
            }
            var node = NodeLocator.Find(General.Instance.NodePath, NodeLocator.VisualStudioCandidates(devenv));
            if (node == null)
            {
                Client = null;
                Problem = "Tollgate needs Node.js to run checks. Install Node.js (LTS) from nodejs.org, or set its path in Tools › Options › Tollgate.";
                return false;
            }
            if (!File.Exists(runner))
            {
                Client = null;
                Problem = "The Tollgate runner is missing from the extension folder. Please reinstall the extension.";
                return false;
            }
            if (Client == null || Client.NodePath != node) Client = new RunnerClient(node, runner);
            return true;
        }

        private void Publish()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _errors?.Update(General.Instance.ShowInErrorList ? RepoRoot : null, Reports.Values.ToList());
            Changed?.Invoke(this, EventArgs.Empty);
        }

        private async Task HandleReportAsync(RunReport report)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (_ownRuns.Contains(report.StartedAt)) return; // already shown (and possibly merged) by RunAsync
            Reports[report.Stage] = report;
            Publish();
            if (report.Source != "hook") return;
            await LogReportAsync(report);
            await VS.StatusBar.ShowMessageAsync(ReportFormatter.Headline(report));
            if (report.Blocked && General.Instance.ShowWindowWhenBlocked) await ChecksToolWindow.ShowAsync();
        }

        // ------------------------------------------------------------------ hooks

        private async Task MaintainHooksAsync(CatalogInfo catalog)
        {
            var hooks = catalog.Hooks;
            if (hooks.Installed.Count > 0)
            {
                // Keep .git/tollgate/runner.js in step with the extension after updates.
                if (_bundledVersion != null && hooks.RunnerVersion != _bundledVersion) await InstallHooksAsync(quiet: true, force: hooks.CustomHooksPath);
                return;
            }
            if (hooks.HuskyIntegrated.Count > 0 || _promptShown) return;
            if (File.Exists(Path.Combine(catalog.StateDir, DismissedMarker))) return;
            var mode = General.Instance.AutoInstallHooks;
            if (mode == HookInstallMode.Never) return;
            if (mode == HookInstallMode.Always && !hooks.CustomHooksPath)
            {
                await InstallHooksAsync(quiet: true);
                return;
            }
            _promptShown = true;
            await ShowInstallPromptAsync(catalog);
        }

        private async Task ShowInstallPromptAsync(CatalogInfo catalog)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            var custom = catalog.Hooks.CustomHooksPath;
            var text = custom
                ? $"Tollgate: this repository uses core.hooksPath ({catalog.Hooks.HooksPath}). Install Tollgate's git hooks there anyway?  "
                : "Tollgate: install git hooks so every commit — from Visual Studio, the terminal or any Git client — is checked?  ";
            var model = new InfoBarModel(
                new IVsInfoBarTextSpan[]
                {
                    new InfoBarTextSpan(text),
                    new InfoBarHyperlink("Install hooks"),
                    new InfoBarTextSpan("    "),
                    new InfoBarHyperlink("Never for this repository"),
                },
                KnownMonikers.StatusInformation,
                true);
            var bar = VS.InfoBar.CreateInfoBar(SolutionExplorerWindow, model);
            if (bar == null)
            {
                await VS.StatusBar.ShowMessageAsync("Tollgate: git hooks aren't installed — use Tools › Tollgate › Install Git Hooks.");
                return;
            }
            bar.ActionItemClicked += (_, e) =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                if (e.ActionItem.Text == "Install hooks") InstallHooksAsync(quiet: false, force: custom).FireAndForget();
                else TryWriteMarker(catalog.StateDir);
                e.InfoBarUIElement.Close();
            };
            await bar.TryShowInfoBarUIAsync();
        }

        private static void TryWriteMarker(string stateDir)
        {
            try
            {
                File.WriteAllText(Path.Combine(stateDir, DismissedMarker), DateTime.UtcNow.ToString("o"));
            }
            catch (IOException)
            {
                // Not important.
            }
        }

        public async Task InstallHooksAsync(bool quiet = false, bool force = false)
        {
            if (RepoRoot == null || Client == null) return;
            var root = RepoRoot;
            var client = Client;
            try
            {
                await TaskScheduler.Default;
                var r = await client.InstallHooksAsync(root, client.NodePath, force);
                await LogAsync(r.Stdout.Trim());
                await RefreshAsync();
                if (!quiet) await VS.StatusBar.ShowMessageAsync("Tollgate: git hooks installed — commits are now checked.");
            }
            catch (RunnerException ex) when (ex.Message.Contains("core.hooksPath"))
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                var answer = await VS.MessageBox.ShowAsync(
                    "Tollgate",
                    $"{ex.Message}\n\nInstall into that hooks folder anyway? (Existing hooks there are kept and run first.)",
                    OLEMSGICON.OLEMSGICON_QUERY,
                    OLEMSGBUTTON.OLEMSGBUTTON_YESNO);
                if (answer == VSConstants.MessageBoxResult.IDYES) await InstallHooksAsync(quiet, force: true);
            }
            catch (Exception ex)
            {
                await ShowErrorAsync("Couldn't install the git hooks", ex);
            }
        }

        public async Task UninstallHooksAsync()
        {
            if (RepoRoot == null || Client == null) return;
            try
            {
                var r = await Client.UninstallHooksAsync(RepoRoot);
                await LogAsync(r.Stdout.Trim());
                await RefreshAsync();
                await VS.StatusBar.ShowMessageAsync("Tollgate: git hooks removed.");
            }
            catch (Exception ex)
            {
                await ShowErrorAsync("Couldn't remove the git hooks", ex);
            }
        }

        // ------------------------------------------------------------------ running

        public async Task RunAsync(string stage = Stages.PreCommit, bool allFiles = false, IReadOnlyList<string>? only = null)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (RepoRoot == null || Client == null || IsRunning) return;
            var root = RepoRoot;
            var client = Client;
            IsRunning = true;
            Publish();
            _runCts = new CancellationTokenSource();
            var ct = _runCts.Token;
            try
            {
                SaveAllDocuments();
                await VS.StatusBar.StartAnimationAsync(StatusAnimation.Sync);
                await VS.StatusBar.ShowMessageAsync(allFiles ? "Tollgate: checking all files…" : "Tollgate: checking staged changes…");

                await TaskScheduler.Default;
                var report = await client.RunAsync(root, stage, allFiles, only, ct);
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();

                _ownRuns.Add(report.StartedAt);
                if (only != null && only.Count > 0 && Reports.TryGetValue(stage, out var previous))
                {
                    // Re-running a single check: keep the other results visible.
                    var merged = previous.Results.ToDictionary(r => r.Id);
                    foreach (var r in report.Results) merged[r.Id] = r;
                    report.Results = merged.Values.ToList();
                    report.Blocked = report.Results.Any(r => r.IsFailure && r.IsError);
                }
                Reports[stage] = report;
                await LogReportAsync(report);
                await VS.StatusBar.ShowMessageAsync(ReportFormatter.Headline(report));
            }
            catch (OperationCanceledException)
            {
                await VS.StatusBar.ShowMessageAsync("Tollgate: run cancelled.");
            }
            catch (Exception ex)
            {
                await ShowErrorAsync("Tollgate couldn't run the checks", ex);
            }
            finally
            {
                await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                IsRunning = false;
                _runCts?.Dispose();
                _runCts = null;
                await VS.StatusBar.EndAnimationAsync(StatusAnimation.Sync);
                Publish();
            }
        }

        public void CancelRun() => _runCts?.Cancel();

        private void SaveAllDocuments()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                if (Package.GetGlobalService(typeof(EnvDTE.DTE)) is EnvDTE.DTE dte) dte.Documents.SaveAll();
            }
            catch (Exception)
            {
                // Saving is a convenience; checks still run against what's on disk / staged.
            }
        }

        public async Task FixWhitespaceAsync()
        {
            if (RepoRoot == null || Client == null) return;
            try
            {
                SaveAllDocuments();
                var r = await Client.FixAsync(RepoRoot);
                await LogAsync(r.Stdout.Trim());
                await VS.StatusBar.ShowMessageAsync($"Tollgate: {r.Stdout.Trim().Split('\n').FirstOrDefault()}");
                await RunAsync();
            }
            catch (Exception ex)
            {
                await ShowErrorAsync("Couldn't fix the staged files", ex);
            }
        }

        // ------------------------------------------------------------------ configuration

        /// <summary>
        /// Team config (.tollgaterc.json) when the repository has one, otherwise personal (.tollgaterc.local.json) —
        /// the same rule the VS Code extension uses.
        /// </summary>
        private bool UseLocalConfig => RepoRoot == null || !File.Exists(Path.Combine(RepoRoot, ".tollgaterc.json"));

        public async Task SetEnabledAsync(CatalogEntry entry, bool enabled)
        {
            if (RepoRoot == null || Client == null) return;
            try
            {
                var r = await Client.ToggleAsync(RepoRoot, entry.Id, enabled, UseLocalConfig);
                await VS.StatusBar.ShowMessageAsync($"Tollgate: {r.Stdout.Trim()}");
                await RefreshAsync();
            }
            catch (Exception ex)
            {
                await ShowErrorAsync($"Couldn't change {entry.Name}", ex);
            }
        }

        public async Task SetSeverityAsync(CatalogEntry entry, string severity)
        {
            if (RepoRoot == null || Client == null) return;
            var path = entry.Group != null && entry.Kind != "custom" ? $"checks.{entry.Group}.severity" : null;
            if (path == null)
            {
                await VS.MessageBox.ShowWarningAsync("Tollgate", "Set the severity of custom checks in .tollgaterc.json.");
                return;
            }
            try
            {
                await Client.SetConfigAsync(RepoRoot, path, $"\"{severity}\"", UseLocalConfig);
                await RefreshAsync();
            }
            catch (Exception ex)
            {
                await ShowErrorAsync($"Couldn't change {entry.Name}", ex);
            }
        }

        public async Task TogglePauseAsync()
        {
            if (RepoRoot == null || Client == null || Catalog == null) return;
            var pause = Catalog.Enabled;
            try
            {
                await Client.SetConfigAsync(RepoRoot, "enabled", pause ? "false" : "true", local: true);
                await RefreshAsync();
                await VS.StatusBar.ShowMessageAsync(pause ? "Tollgate paused for you in this repository (.tollgaterc.local.json)." : "Tollgate resumed.");
            }
            catch (Exception ex)
            {
                await ShowErrorAsync("Couldn't pause Tollgate", ex);
            }
        }

        public async Task OpenConfigAsync()
        {
            if (RepoRoot == null || Client == null) return;
            var file = Path.Combine(RepoRoot, ".tollgaterc.json");
            if (!File.Exists(file)) await Client.InitConfigAsync(RepoRoot);
            await VS.Documents.OpenAsync(file);
            await RefreshAsync();
        }

        // ------------------------------------------------------------------ navigation & output

        public async Task NavigateAsync(Finding finding)
        {
            if (RepoRoot == null || string.IsNullOrEmpty(finding.File)) return;
            var path = Path.Combine(RepoRoot, finding.File!.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(path)) return;
            var view = await VS.Documents.OpenAsync(path);
            var textView = view?.TextView;
            if (textView == null) return;
            var snapshot = textView.TextSnapshot;
            var lineNumber = Math.Max(0, Math.Min((finding.Line ?? 1) - 1, snapshot.LineCount - 1));
            var line = snapshot.GetLineFromLineNumber(lineNumber);
            var position = Math.Min(line.Start.Position + Math.Max(0, (finding.Column ?? 1) - 1), line.End.Position);
            var point = new SnapshotPoint(snapshot, position);
            textView.Caret.MoveTo(point);
            textView.ViewScroller.EnsureSpanVisible(new SnapshotSpan(point, 0), EnsureSpanVisibleOptions.AlwaysCenter);
            textView.VisualElement.Focus();
        }

        public async Task ShowOutputAsync(CheckResult result)
        {
            var sb = new StringBuilder();
            sb.AppendLine($"── {result.Name} ({result.Id}) — {result.Status}: {result.Summary}");
            if (!string.IsNullOrEmpty(result.Command)) sb.AppendLine($"$ {result.Command}");
            sb.AppendLine(string.IsNullOrWhiteSpace(result.Output) ? "(no output)" : result.Output!.TrimEnd());
            await LogAsync(sb.ToString(), activate: true);
        }

        public async Task ShowOutputPaneAsync()
        {
            await EnsurePaneAsync();
            if (_pane != null) await _pane.ActivateAsync();
        }

        private async Task EnsurePaneAsync()
        {
            _pane ??= await VS.Windows.CreateOutputWindowPaneAsync("Tollgate");
        }

        private async Task LogAsync(string text, bool activate = false)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            await EnsurePaneAsync();
            if (_pane == null) return;
            await _pane.WriteLineAsync($"[{DateTime.Now:HH:mm:ss}] {text}");
            if (activate) await _pane.ActivateAsync();
        }

        private Task LogReportAsync(RunReport report)
        {
            var sb = new StringBuilder();
            sb.AppendLine($"Tollgate · {report.Stage} ({report.Source}) — {(report.Blocked ? "BLOCKED" : "ok")} in {report.DurationMs / 1000.0:0.0}s");
            foreach (var r in report.Results)
            {
                sb.AppendLine($"  {ReportFormatter.Glyph(r)} {r.Name} — {r.Summary}");
                if (!r.IsFailure) continue;
                foreach (var f in r.Findings.Take(25)) sb.AppendLine($"      {ReportFormatter.Location(f)}  {f.Message}");
                if (r.Findings.Count > 25) sb.AppendLine($"      … and {r.Findings.Count - 25} more");
            }
            return LogAsync(sb.ToString());
        }

        private async Task ShowErrorAsync(string what, Exception ex)
        {
            await LogAsync($"{what}: {ex}");
            var detail = ex is RunnerException re && !string.IsNullOrWhiteSpace(re.Output) ? re.Output.Trim() : ex.Message;
            await VS.MessageBox.ShowErrorAsync("Tollgate", $"{what}.\n\n{Truncate(detail, 1500)}");
        }

        private static string FirstLine(Exception ex) => ex.Message.Split('\n').FirstOrDefault()?.Trim() ?? ex.GetType().Name;

        private static string Truncate(string s, int max) => s.Length <= max ? s : s.Substring(0, max) + "…";

        public void Dispose()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _runCts?.Cancel();
            _watcher?.Dispose();
            _solution?.Dispose();
            _errors?.Dispose();
            Instance = null;
        }
    }
}
