using System.Collections.Generic;
using System.Runtime.Serialization;

namespace Tollgate.Core
{
    // These mirror the JSON written by the Tollgate runner (src/core/types.ts and src/core/catalog.ts).
    // Unknown members are ignored by DataContractJsonSerializer, so newer runners stay compatible.

    [DataContract]
    public sealed class Finding
    {
        [DataMember(Name = "file", EmitDefaultValue = false)] public string? File { get; set; }
        [DataMember(Name = "line", EmitDefaultValue = false)] public int? Line { get; set; }
        [DataMember(Name = "column", EmitDefaultValue = false)] public int? Column { get; set; }
        [DataMember(Name = "message")] public string Message { get; set; } = "";
        [DataMember(Name = "rule", EmitDefaultValue = false)] public string? Rule { get; set; }
    }

    [DataContract]
    public sealed class CheckResult
    {
        [DataMember(Name = "id")] public string Id { get; set; } = "";
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "stage")] public string Stage { get; set; } = "pre-commit";
        /// <summary>"error" or "warning".</summary>
        [DataMember(Name = "severity")] public string Severity { get; set; } = "error";
        /// <summary>"passed", "failed", "skipped" or "error".</summary>
        [DataMember(Name = "status")] public string Status { get; set; } = "passed";
        [DataMember(Name = "summary")] public string Summary { get; set; } = "";
        [DataMember(Name = "durationMs")] public long DurationMs { get; set; }
        [DataMember(Name = "findings")] public List<Finding> Findings { get; set; } = new List<Finding>();
        [DataMember(Name = "output", EmitDefaultValue = false)] public string? Output { get; set; }
        [DataMember(Name = "command", EmitDefaultValue = false)] public string? Command { get; set; }
        [DataMember(Name = "fixable", EmitDefaultValue = false)] public bool? Fixable { get; set; }

        public bool IsFailure => Status == "failed" || Status == "error";
        public bool IsError => Severity == "error";
    }

    [DataContract]
    public sealed class RunReport
    {
        [DataMember(Name = "version")] public int Version { get; set; }
        [DataMember(Name = "repoRoot")] public string RepoRoot { get; set; } = "";
        [DataMember(Name = "stage")] public string Stage { get; set; } = "pre-commit";
        /// <summary>"hook", "vscode", "cli"…</summary>
        [DataMember(Name = "source")] public string Source { get; set; } = "";
        [DataMember(Name = "startedAt")] public string StartedAt { get; set; } = "";
        [DataMember(Name = "durationMs")] public long DurationMs { get; set; }
        [DataMember(Name = "blocked")] public bool Blocked { get; set; }
        [DataMember(Name = "results")] public List<CheckResult> Results { get; set; } = new List<CheckResult>();
        [DataMember(Name = "fixedFiles", EmitDefaultValue = false)] public List<string>? FixedFiles { get; set; }
    }

    [DataContract]
    public sealed class HookStatus
    {
        [DataMember(Name = "hooksDir")] public string HooksDir { get; set; } = "";
        [DataMember(Name = "hooksPath", EmitDefaultValue = false)] public string? HooksPath { get; set; }
        [DataMember(Name = "customHooksPath")] public bool CustomHooksPath { get; set; }
        [DataMember(Name = "installed")] public List<string> Installed { get; set; } = new List<string>();
        [DataMember(Name = "foreign")] public List<string> Foreign { get; set; } = new List<string>();
        [DataMember(Name = "huskyIntegrated")] public List<string> HuskyIntegrated { get; set; } = new List<string>();
        [DataMember(Name = "runnerVersion", EmitDefaultValue = false)] public string? RunnerVersion { get; set; }

        public bool AnyInstalled => Installed.Count > 0 || HuskyIntegrated.Count > 0;
    }

    [DataContract]
    public sealed class CatalogEntry
    {
        [DataMember(Name = "id")] public string Id { get; set; } = "";
        [DataMember(Name = "name")] public string Name { get; set; } = "";
        [DataMember(Name = "stage")] public string Stage { get; set; } = "pre-commit";
        [DataMember(Name = "enabled")] public bool Enabled { get; set; }
        [DataMember(Name = "severity")] public string Severity { get; set; } = "error";
        /// <summary>"builtin", "command" or "custom".</summary>
        [DataMember(Name = "kind")] public string Kind { get; set; } = "builtin";
        [DataMember(Name = "group", EmitDefaultValue = false)] public string? Group { get; set; }
    }

    /// <summary>Output of <c>runner list --json</c>.</summary>
    [DataContract]
    public sealed class CatalogInfo
    {
        [DataMember(Name = "version")] public string Version { get; set; } = "";
        [DataMember(Name = "root")] public string Root { get; set; } = "";
        [DataMember(Name = "stateDir")] public string StateDir { get; set; } = "";
        [DataMember(Name = "configError", EmitDefaultValue = false)] public string? ConfigError { get; set; }
        [DataMember(Name = "sources")] public List<string> Sources { get; set; } = new List<string>();
        [DataMember(Name = "enabled")] public bool Enabled { get; set; } = true;
        [DataMember(Name = "preset", EmitDefaultValue = false)] public string? Preset { get; set; }
        [DataMember(Name = "hooks")] public HookStatus Hooks { get; set; } = new HookStatus();
        [DataMember(Name = "checks")] public List<CatalogEntry> Checks { get; set; } = new List<CatalogEntry>();
    }

    public static class Stages
    {
        public const string PreCommit = "pre-commit";
        public const string CommitMsg = "commit-msg";
        public const string PrePush = "pre-push";
        public static readonly string[] All = { PreCommit, CommitMsg, PrePush };

        public static string Label(string stage) => stage switch
        {
            PreCommit => "Pre-commit",
            CommitMsg => "Commit message",
            PrePush => "Pre-push",
            _ => stage,
        };
    }
}
