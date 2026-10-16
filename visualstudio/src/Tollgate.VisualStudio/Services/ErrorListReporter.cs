using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Tollgate.Core;

namespace Tollgate.VisualStudio
{
    /// <summary>Publishes Tollgate findings to the Error List (double-click navigates to the line).</summary>
    internal sealed class ErrorListReporter : IDisposable
    {
        private readonly ErrorListProvider _provider;

        public ErrorListReporter(IServiceProvider serviceProvider)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _provider = new ErrorListProvider(serviceProvider)
            {
                ProviderName = "Tollgate",
                ProviderGuid = new Guid("97e13e21-c656-4782-8b32-7a76715f01d6"),
            };
        }

        public void Update(string? repoRoot, IEnumerable<RunReport> reports)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _provider.SuspendRefresh();
            try
            {
                _provider.Tasks.Clear();
                if (repoRoot == null) return;
                foreach (var report in reports)
                {
                    foreach (var result in report.Results)
                    {
                        if (!result.IsFailure) continue;
                        foreach (var finding in result.Findings)
                        {
                            if (string.IsNullOrEmpty(finding.File)) continue;
                            var task = new ErrorTask
                            {
                                Category = TaskCategory.BuildCompile,
                                ErrorCategory = result.IsError ? TaskErrorCategory.Error : TaskErrorCategory.Warning,
                                Text = $"{finding.Message} (Tollgate › {result.Name}{(string.IsNullOrEmpty(finding.Rule) ? "" : ": " + finding.Rule)})",
                                Document = Path.Combine(repoRoot, finding.File!.Replace('/', Path.DirectorySeparatorChar)),
                                Line = Math.Max(0, (finding.Line ?? 1) - 1),
                                Column = Math.Max(0, (finding.Column ?? 1) - 1),
                            };
                            task.Navigate += OnNavigate;
                            _provider.Tasks.Add(task);
                        }
                    }
                }
            }
            finally
            {
                _provider.ResumeRefresh();
            }
        }

        private void OnNavigate(object? sender, EventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (sender is ErrorTask task) _provider.Navigate(task, VSConstants.LOGVIEWID_Code);
        }

        public void Dispose()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _provider.Tasks.Clear();
            _provider.Dispose();
        }
    }
}
