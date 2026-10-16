using System.Linq;

namespace Tollgate.Core
{
    public static class ReportFormatter
    {
        /// <summary>One line suitable for a status bar or info bar.</summary>
        public static string Headline(RunReport report)
        {
            var failed = report.Results.Where(r => r.IsFailure).ToList();
            var blocking = failed.Where(r => r.IsError).ToList();
            var what = report.Stage == Stages.PrePush ? "push" : "commit";
            if (report.Blocked)
            {
                var names = string.Join(", ", (blocking.Count > 0 ? blocking : failed).Select(r => r.Name));
                return $"Tollgate blocked the {what}: {names} failed.";
            }
            if (failed.Count > 0) return $"Tollgate: passed with {failed.Count} warning(s) — {string.Join(", ", failed.Select(r => r.Name))}.";
            var passed = report.Results.Count(r => r.Status == "passed");
            return $"Tollgate: all {passed} check(s) passed.";
        }

        public static string Glyph(CheckResult? result, bool enabled = true)
        {
            if (!enabled) return "⊘";
            if (result == null) return "○";
            return result.Status switch
            {
                "passed" => "✔",
                "skipped" => "↷",
                _ => result.IsError ? "✖" : "⚠",
            };
        }

        public static string Location(Finding f) =>
            f.File == null ? "" : f.File + (f.Line.HasValue ? $":{f.Line}" : "") + (f.Column.HasValue ? $":{f.Column}" : "");
    }
}
