using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Tollgate.Core;

namespace Tollgate.VisualStudio
{
    /// <summary>
    /// The Tollgate tool window: a toolbar, a status line, and a tree of stages → checks → findings.
    /// Built in code (no XAML) and themed with Visual Studio's colours.
    /// </summary>
    internal sealed class ChecksControl : UserControl
    {
        private static readonly Brush Green = new SolidColorBrush(Color.FromRgb(0x2E, 0xA0, 0x43));
        private static readonly Brush Red = new SolidColorBrush(Color.FromRgb(0xE5, 0x48, 0x4D));
        private static readonly Brush Amber = new SolidColorBrush(Color.FromRgb(0xD9, 0x96, 0x1A));

        private readonly TextBlock _status = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(8, 4, 8, 6),
        };
        private readonly TreeView _tree = new TreeView
        {
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
        };
        private readonly Button _run;
        private readonly Button _runAll;
        private readonly Button _install;
        private readonly Button _config;
        private readonly Button _pause;
        private readonly HashSet<string> _collapsed = [];

        public ChecksControl()
        {
            Themes.SetUseVsTheme(this, true);
            SetResourceReference(
                BackgroundProperty,
                EnvironmentColors.ToolWindowBackgroundBrushKey
            );
            SetResourceReference(ForegroundProperty, EnvironmentColors.ToolWindowTextBrushKey);
            _tree.SetResourceReference(
                ForegroundProperty,
                EnvironmentColors.ToolWindowTextBrushKey
            );

            _run = MakeButton(
                "▶ Run",
                "Run checks on staged changes",
                () => Service?.RunAsync().FireAndForget()
            );
            _runAll = MakeButton(
                "Run all files",
                "Run checks on every tracked file",
                () => Service?.RunAsync(allFiles: true).FireAndForget()
            );
            _install = MakeButton(
                "Install hooks",
                "Install git hooks so every commit is checked",
                () => Service?.InstallHooksAsync().FireAndForget()
            );
            _config = MakeButton(
                "Configure",
                "Open .tollgaterc.json (created if missing)",
                () => Service?.OpenConfigAsync().FireAndForget()
            );
            _pause = MakeButton(
                "Pause",
                "Pause or resume Tollgate for you in this repository",
                () => Service?.TogglePauseAsync().FireAndForget()
            );

            var toolbar = new WrapPanel { Margin = new Thickness(6, 6, 6, 0) };
            foreach (var b in new[] { _run, _runAll, _install, _config, _pause })
                toolbar.Children.Add(b);

            var root = new DockPanel();
            DockPanel.SetDock(toolbar, Dock.Top);
            DockPanel.SetDock(_status, Dock.Top);
            root.Children.Add(toolbar);
            root.Children.Add(_status);
            root.Children.Add(_tree);
            Content = root;

            Loaded += (_, __) =>
            {
                if (Service != null)
                    Service.Changed += OnChanged;
                Render();
            };
            Unloaded += (_, __) =>
            {
                if (Service != null)
                    Service.Changed -= OnChanged;
            };
        }

        private static TollgateService? Service => TollgateService.Instance;

        private void OnChanged(object? sender, EventArgs e)
        {
            ThreadHelper
                .JoinableTaskFactory.RunAsync(async () =>
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    Render();
                })
                .Task.FireAndForget();
        }

        private static Button MakeButton(string text, string tooltip, Action onClick)
        {
            var b = new Button
            {
                Content = text,
                ToolTip = tooltip,
                Margin = new Thickness(0, 0, 6, 4),
                Padding = new Thickness(8, 2, 8, 2),
            };
            b.Click += (_, __) => onClick();
            return b;
        }

        // ------------------------------------------------------------------ rendering

        private void Render()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var svc = Service;
            var ready = svc?.IsReady == true;
            _run.IsEnabled = _runAll.IsEnabled = ready && svc!.IsRunning == false;
            _config.IsEnabled = _pause.IsEnabled = ready;
            _install.Visibility =
                ready && !svc!.HooksInstalled ? Visibility.Visible : Visibility.Collapsed;
            _pause.Content = svc?.Catalog?.Enabled == false ? "Resume" : "Pause";

            _status.Text = StatusText(svc);
            RememberExpansion();
            _tree.Items.Clear();
            if (svc?.Catalog == null)
                return;

            foreach (var stage in Stages.All)
            {
                var entries = svc.Catalog.Checks.Where(c => c.Stage == stage).ToList();
                svc.Reports.TryGetValue(stage, out var report);
                var results =
                    report?.Results.ToDictionary(r => r.Id)
                    ?? new Dictionary<string, CheckResult>();
                // Results for checks not in the catalog (e.g. a one-off --only run) still deserve a row.
                foreach (var r in results.Values.Where(r => entries.All(e => e.Id != r.Id)))
                {
                    entries.Add(
                        new CatalogEntry
                        {
                            Id = r.Id,
                            Name = r.Name,
                            Stage = stage,
                            Enabled = true,
                            Severity = r.Severity,
                            Kind = "command",
                        }
                    );
                }
                if (entries.Count == 0)
                    continue;

                var stageItem = MakeItem(
                    $"stage:{stage}",
                    Header(Stages.Label(stage), StageSummary(svc, stage, report), bold: true)
                );
                foreach (var entry in entries.OrderBy(e => e.Enabled ? 0 : 1))
                {
                    results.TryGetValue(entry.Id, out var result);
                    stageItem.Items.Add(CheckItem(svc, entry, result));
                }
                _tree.Items.Add(stageItem);
            }
        }

        private static string StatusText(TollgateService? svc)
        {
            if (svc == null)
                return "Loading…";
            if (svc.Problem != null)
                return svc.Problem;
            if (svc.Catalog == null)
                return svc.RepoRoot == null
                    ? "Open a solution or folder in a git repository."
                    : "Reading the repository…";
            var parts = new List<string>
            {
                Path.GetFileName(svc.RepoRoot) ?? "",
                svc.HooksInstalled
                    ? "hooks installed"
                    : "hooks NOT installed — commits aren't checked",
            };
            if (!svc.Catalog.Enabled)
                parts.Add("paused");
            if (!string.IsNullOrEmpty(svc.Catalog.Preset))
                parts.Add($"preset: {svc.Catalog.Preset}");
            if (svc.IsRunning)
                parts.Add("running…");
            return string.Join("  ·  ", parts);
        }

        private static string StageSummary(TollgateService svc, string stage, RunReport? report)
        {
            var installed =
                svc.Catalog?.Hooks.Installed.Contains(stage) == true
                || svc.Catalog?.Hooks.HuskyIntegrated.Contains(stage) == true;
            if (report == null)
                return installed ? "not run yet" : "hook not installed";
            DateTime.TryParse(report.StartedAt, out var when);
            var ago = when == default ? "" : $" · {Ago(when.ToUniversalTime())}";
            return $"{(report.Blocked ? "blocked" : "passed")}{ago} · {report.Source}";
        }

        private static string Ago(DateTime utc)
        {
            var s = (DateTime.UtcNow - utc).TotalSeconds;
            if (s < 60)
                return "just now";
            if (s < 3600)
                return $"{(int)(s / 60)}m ago";
            if (s < 86400)
                return $"{(int)(s / 3600)}h ago";
            return $"{(int)(s / 86400)}d ago";
        }

        private TreeViewItem CheckItem(TollgateService svc, CatalogEntry entry, CheckResult? result)
        {
            var glyph = ReportFormatter.Glyph(result, entry.Enabled);
            var brush =
                !entry.Enabled || result == null ? null
                : result.Status == "passed" ? Green
                : result.IsFailure ? (result.IsError ? Red : Amber)
                : null;
            var summary =
                !entry.Enabled ? "disabled"
                : result == null ? "not run"
                : result.Summary
                    + (result.DurationMs >= 1000 ? $" · {result.DurationMs / 1000.0:0.0}s" : "");
            var header = Header(
                entry.Name,
                summary,
                glyph: glyph,
                glyphBrush: brush,
                dim: !entry.Enabled
            );
            var item = MakeItem(
                $"check:{entry.Stage}:{entry.Id}",
                header,
                expandedByDefault: result?.IsFailure == true
            );
            item.ToolTip =
                $"{entry.Name} ({entry.Id}) — {entry.Severity}{(result?.Command != null ? "\n$ " + result.Command : "")}";

            var menu = new ContextMenu();
            if (entry.Enabled && entry.Stage != Stages.CommitMsg)
            {
                menu.Items.Add(
                    MenuItem(
                        "Run this check",
                        () => svc.RunAsync(entry.Stage, only: new[] { entry.Id }).FireAndForget()
                    )
                );
            }
            menu.Items.Add(
                MenuItem(
                    entry.Enabled ? "Disable" : "Enable",
                    () => svc.SetEnabledAsync(entry, !entry.Enabled).FireAndForget()
                )
            );
            if (entry.Kind != "custom" && entry.Group != null)
            {
                menu.Items.Add(
                    MenuItem(
                        entry.Severity == "error"
                            ? "Make it a warning (don't block)"
                            : "Make it an error (block commits)",
                        () =>
                            svc.SetSeverityAsync(
                                    entry,
                                    entry.Severity == "error" ? "warning" : "error"
                                )
                                .FireAndForget()
                    )
                );
            }
            if (result?.Output != null || result?.Command != null)
                menu.Items.Add(
                    MenuItem("Show output", () => svc.ShowOutputAsync(result!).FireAndForget())
                );
            item.ContextMenu = menu;

            if (result?.IsFailure == true)
            {
                foreach (var finding in result.Findings.Take(200))
                    item.Items.Add(FindingItem(svc, finding, result.IsError));
                if (result.Findings.Count > 200)
                    item.Items.Add(
                        new TreeViewItem
                        {
                            Header =
                                $"… and {result.Findings.Count - 200} more (see the Error List)",
                        }
                    );
                if (result.Findings.Count == 0 || !string.IsNullOrWhiteSpace(result.Output))
                {
                    var output = new TreeViewItem { Header = "Show full output" };
                    output.MouseDoubleClick += (_, e) =>
                    {
                        e.Handled = true;
                        svc.ShowOutputAsync(result).FireAndForget();
                    };
                    output.KeyDown += (_, e) =>
                    {
                        if (e.Key == Key.Enter)
                            svc.ShowOutputAsync(result).FireAndForget();
                    };
                    item.Items.Add(output);
                }
            }
            return item;
        }

        private static TreeViewItem FindingItem(TollgateService svc, Finding finding, bool isError)
        {
            var location = ReportFormatter.Location(finding);
            var header = Header(
                string.IsNullOrEmpty(location) ? finding.Message : location,
                string.IsNullOrEmpty(location) ? "" : finding.Message,
                glyph: isError ? "✖" : "⚠",
                glyphBrush: isError ? Red : Amber
            );
            var item = new TreeViewItem
            {
                Header = header,
                ToolTip =
                    finding.Rule == null ? finding.Message : $"{finding.Message}\n({finding.Rule})",
            };
            if (!string.IsNullOrEmpty(finding.File))
            {
                item.MouseDoubleClick += (_, e) =>
                {
                    e.Handled = true;
                    svc.NavigateAsync(finding).FireAndForget();
                };
                item.KeyDown += (_, e) =>
                {
                    if (e.Key == Key.Enter)
                        svc.NavigateAsync(finding).FireAndForget();
                };
            }
            return item;
        }

        private static MenuItem MenuItem(string text, Action onClick)
        {
            var mi = new MenuItem { Header = text };
            mi.Click += (_, __) => onClick();
            return mi;
        }

        private static StackPanel Header(
            string title,
            string detail,
            bool bold = false,
            string? glyph = null,
            Brush? glyphBrush = null,
            bool dim = false
        )
        {
            var panel = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Opacity = dim ? 0.6 : 1,
            };
            if (glyph != null)
            {
                var g = new TextBlock
                {
                    Text = glyph,
                    Margin = new Thickness(0, 0, 6, 0),
                    FontWeight = FontWeights.Bold,
                };
                if (glyphBrush != null)
                    g.Foreground = glyphBrush;
                panel.Children.Add(g);
            }
            panel.Children.Add(
                new TextBlock
                {
                    Text = title,
                    FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal,
                }
            );
            if (!string.IsNullOrEmpty(detail))
                panel.Children.Add(new TextBlock { Text = "  " + detail, Opacity = 0.7 });
            return panel;
        }

        // Keep the user's expand/collapse choices across re-renders.
        private TreeViewItem MakeItem(string key, object header, bool expandedByDefault = true)
        {
            var item = new TreeViewItem
            {
                Header = header,
                Tag = key,
                IsExpanded = expandedByDefault && !_collapsed.Contains(key),
            };
            if (!expandedByDefault && _collapsed.Contains("open:" + key))
                item.IsExpanded = true;
            return item;
        }

        private void RememberExpansion()
        {
            foreach (var item in Walk(_tree.Items))
            {
                if (item.Tag is not string key)
                    continue;
                if (item.IsExpanded)
                {
                    _collapsed.Remove(key);
                    _collapsed.Add("open:" + key);
                }
                else
                {
                    _collapsed.Add(key);
                    _collapsed.Remove("open:" + key);
                }
            }
        }

        private static IEnumerable<TreeViewItem> Walk(ItemCollection items)
        {
            foreach (var o in items)
            {
                if (o is not TreeViewItem item)
                    continue;
                yield return item;
                foreach (var child in Walk(item.Items))
                    yield return child;
            }
        }
    }
}
