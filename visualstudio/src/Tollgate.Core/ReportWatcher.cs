using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace Tollgate.Core
{
    public sealed class ReportChangedEventArgs : EventArgs
    {
        public ReportChangedEventArgs(RunReport report) => Report = report;

        public RunReport Report { get; }
    }

    /// <summary>
    /// Watches <c>.git/tollgate/last-*.json</c>, which the git hook (or any runner invocation) writes after each run,
    /// so commits made from Visual Studio's Git window, the terminal or any other client show up in the IDE.
    /// </summary>
    public sealed class ReportWatcher : IDisposable
    {
        private readonly string _stateDir;
        private readonly FileSystemWatcher _watcher;
        private readonly Dictionary<string, string> _lastSeen = new Dictionary<string, string>();
        private readonly Timer _debounce;
        private readonly object _gate = new object();
        private readonly HashSet<string> _pending = new HashSet<string>();

        public ReportWatcher(string stateDir)
        {
            _stateDir = stateDir;
            Directory.CreateDirectory(stateDir);
            foreach (var stage in Stages.All)
            {
                var r = RunnerClient.ReadLastReport(stateDir, stage);
                if (r != null) _lastSeen[stage] = r.StartedAt;
            }
            _debounce = new Timer(_ => Flush(), null, Timeout.Infinite, Timeout.Infinite);
            _watcher = new FileSystemWatcher(stateDir, "last-*.json")
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.CreationTime | NotifyFilters.Size,
                IncludeSubdirectories = false,
            };
            _watcher.Changed += (_, e) => Queue(e.Name);
            _watcher.Created += (_, e) => Queue(e.Name);
            _watcher.Renamed += (_, e) => Queue(e.Name); // the runner writes a temp file and renames it
            _watcher.EnableRaisingEvents = true;
        }

        /// <summary>Raised on a thread-pool thread with each new report (deduplicated by start time).</summary>
        public event EventHandler<ReportChangedEventArgs>? ReportChanged;

        private void Queue(string? name)
        {
            if (name == null || !name.StartsWith("last-", StringComparison.Ordinal) || !name.EndsWith(".json", StringComparison.Ordinal)) return;
            var stage = name.Substring(5, name.Length - 10);
            lock (_gate) _pending.Add(stage);
            _debounce.Change(250, Timeout.Infinite);
        }

        private void Flush()
        {
            string[] stages;
            lock (_gate)
            {
                stages = new string[_pending.Count];
                _pending.CopyTo(stages);
                _pending.Clear();
            }
            foreach (var stage in stages)
            {
                var report = RunnerClient.ReadLastReport(_stateDir, stage);
                if (report == null) continue;
                lock (_gate)
                {
                    if (_lastSeen.TryGetValue(stage, out var seen) && seen == report.StartedAt) continue;
                    _lastSeen[stage] = report.StartedAt;
                }
                ReportChanged?.Invoke(this, new ReportChangedEventArgs(report));
            }
        }

        public void Dispose()
        {
            _watcher.EnableRaisingEvents = false;
            _watcher.Dispose();
            _debounce.Dispose();
        }
    }
}
