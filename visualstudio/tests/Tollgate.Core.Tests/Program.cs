using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Tollgate.Core;

// Minimal test harness (no NuGet needed). Usage: dotnet run -- <path-to-dist/cli.js>
int _failed = 0;
int _passed = 0;

var runner = args.Length > 0 ? Path.GetFullPath(args[0]) : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../dist/cli.js"));
var node = NodeLocator.Find(Environment.GetEnvironmentVariable("TOLLGATE_NODE"));
if (node == null || !File.Exists(runner))
{
    await Console.Error.WriteLineAsync($"node ({node ?? "missing"}) and the runner ({runner}) are required — run `npm run build` first.");
    return 2;
}

Test("ProcessRunner.Quote round-trips tricky arguments", () =>
{
    var tricky = new[] { "plain", "with space", "quote\"inside", "trailing\\", "back\\\\slash \"mix\"", "" };
    var r = ProcessRunner.RunAsync(node, new[] { "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--" }.Concat(tricky), Directory.GetCurrentDirectory(), TimeSpan.FromSeconds(30)).Result;
    var got = Json.Deserialize<List<string>>(r.Stdout);
    Equal(string.Join("|", tricky), string.Join("|", got));
});

Test("ProcessRunner times out and kills the process", () =>
{
    var sw = Stopwatch.StartNew();
    var r = ProcessRunner.RunAsync(node, new[] { "-e", "setTimeout(()=>{}, 60000)" }, Directory.GetCurrentDirectory(), TimeSpan.FromSeconds(1)).Result;
    True(r.TimedOut, "timed out");
    True(sw.Elapsed < TimeSpan.FromSeconds(10), "returned promptly");
});

Test("Json parses a report (and ignores unknown members)", () =>
{
    var json = "{\"version\":1,\"repoRoot\":\"/r\",\"stage\":\"pre-commit\",\"source\":\"hook\",\"startedAt\":\"2026-10-16T10:00:00.000Z\",\"durationMs\":12,\"blocked\":true,\"future\":42," +
               "\"results\":[{\"id\":\"secrets\",\"name\":\"Secrets\",\"stage\":\"pre-commit\",\"severity\":\"error\",\"status\":\"failed\",\"summary\":\"1 possible secret\",\"durationMs\":3," +
               "\"findings\":[{\"file\":\"a.cs\",\"line\":3,\"column\":7,\"message\":\"Stripe key\",\"rule\":\"Stripe key\"},{\"message\":\"no location\"}]}]}";
    var r = Json.Deserialize<RunReport>(Json.ExtractObject("npm notice something\n" + json + "\ntrailing log line"));
    True(r.Blocked, "blocked");
    Equal("hook", r.Source);
    Equal(3, r.Results[0].Findings[0].Line ?? -1);
    True(r.Results[0].Findings[1].File == null && r.Results[0].Findings[1].Line == null, "optional fields");
    Equal("Tollgate blocked the commit: Secrets failed.", ReportFormatter.Headline(r));
    Equal("a.cs:3:7", ReportFormatter.Location(r.Results[0].Findings[0]));
});

// ---- integration with the real runner on a throwaway repo
var repo = Path.Combine(Path.GetTempPath(), "tg-vs-" + Guid.NewGuid().ToString("N").Substring(0, 8));
Directory.CreateDirectory(Path.Combine(repo, "src", "deep"));
Git(repo, "init", "-q", "-b", "feature/vs");
Git(repo, "config", "user.email", "t@example.com");
Git(repo, "config", "user.name", "Test");
Git(repo, "config", "commit.gpgsign", "false");
await File.WriteAllTextAsync(Path.Combine(repo, "src", "Settings.cs"), "class Settings { const string Key = \"AKIA" + "IOSFODNN7EXAMPLE\"; }\n");
Git(repo, "add", ".");
var client = new RunnerClient(node, runner);

Test("RepoLocator finds the root from a nested folder or file", () =>
{
    Equal(repo, RepoLocator.FindRoot(Path.Combine(repo, "src", "deep")) ?? "");
    Equal(repo, RepoLocator.FindRoot(Path.Combine(repo, "src", "Settings.cs")) ?? "");
    Equal(null, RepoLocator.FindRoot(Path.GetPathRoot(Path.GetTempPath())));
});

await TestAsync("RunnerClient: version, install, list", async () =>
{
    True((await client.GetVersionAsync()).Length > 0, "version");
    await client.InstallHooksAsync(repo, node);
    var info = await client.ListAsync(repo);
    True(info.Hooks.Installed.Contains("pre-commit"), "pre-commit hook installed");
    True(info.Checks.Any(c => c.Id == "secrets" && c.Enabled), "secrets listed");
    True(info.Checks.Any(c => c.Id == "todoComments" && !c.Enabled), "disabled checks listed");
    True(Directory.Exists(info.StateDir), "state dir exists");
    var hook = await File.ReadAllTextAsync(Path.Combine(info.Hooks.HooksDir, "pre-commit"));
    True(hook.Contains(node.Replace('\\', '/')), "node fallback written into the hook");
});

await TestAsync("RunnerClient: run reports the blocking secret with a location", async () =>
{
    var report = await client.RunAsync(repo);
    True(report.Blocked, "blocked");
    var secrets = report.Results.Single(r => r.Id == "secrets");
    Equal("failed", secrets.Status);
    Equal("src/Settings.cs", secrets.Findings[0].File ?? "");
    Equal(1, secrets.Findings[0].Line ?? 0);
    var only = await client.RunAsync(repo, only: new[] { "largeFiles" });
    Equal(1, only.Results.Count);
});

await TestAsync("RunnerClient: toggle (local) and config set change behaviour", async () =>
{
    await client.ToggleAsync(repo, "secrets", enabled: false, local: true);
    True(File.Exists(Path.Combine(repo, ".tollgaterc.local.json")), "local config written");
    var report = await client.RunAsync(repo);
    True(!report.Blocked, "not blocked once secrets is off");
    await client.SetConfigAsync(repo, "checks.largeFiles.maxSizeKB", "1", local: false);
    var info = await client.ListAsync(repo);
    True(info.Sources.Contains(".tollgaterc.json") && info.Sources.Contains(".tollgaterc.local.json"), "both config files used");
    var status = Git(repo, "status", "--porcelain");
    True(!status.Contains(".tollgaterc.local.json"), "local config is git-excluded");
});

await TestAsync("ReportWatcher sees reports written by the git hook", async () =>
{
    var info = await client.ListAsync(repo);
    using var watcher = new ReportWatcher(info.StateDir);
    var got = new TaskCompletionSource<RunReport>();
    watcher.ReportChanged += (_, e) => { if (e.Report.Source == "hook") got.TrySetResult(e.Report); };
    Git(repo, "commit", "-q", "-m", "feat: add settings");
    var finished = await Task.WhenAny(got.Task, Task.Delay(TimeSpan.FromSeconds(15)));
    True(finished == got.Task, "event raised");
    var r = await got.Task;
    True(r.Stage == Stages.PreCommit || r.Stage == Stages.CommitMsg, "stage");
    True(RunnerClient.ReadLastReport(info.StateDir, Stages.PreCommit) != null, "ReadLastReport");
});

try { Directory.Delete(repo, true); } catch { /* best effort */ }
Console.WriteLine($"\n{_passed} passed, {_failed} failed");
return _failed == 0 ? 0 : 1;

string Git(string cwd, params string[] args)
{
    var r = ProcessRunner.RunAsync("git", args, cwd, TimeSpan.FromSeconds(60)).Result;
#pragma warning disable S112 // General or reserved exceptions should never be thrown
    if (r.ExitCode != 0) throw new Exception($"git {string.Join(" ", args)} failed: {r.Stderr}{r.Stdout}");
#pragma warning restore S112 // General or reserved exceptions should never be thrown
    return r.Stdout;
}

void Test(string name, Action body)
{
    try { body(); _passed++; Console.WriteLine($"✔ {name}"); }
    catch (Exception e) { _failed++; Console.WriteLine($"✖ {name}\n    {e.GetBaseException().Message}"); }
}

async Task TestAsync(string name, Func<Task> body)
{
    try { await body(); _passed++; Console.WriteLine($"✔ {name}"); }
    catch (Exception e) { _failed++; Console.WriteLine($"✖ {name}\n    {e.GetBaseException().Message}"); }
}

#pragma warning disable S112 // General or reserved exceptions should never be thrown
void True(bool cond, string what) { if (!cond) throw new Exception($"expected: {what}"); }
#pragma warning restore S112 // General or reserved exceptions should never be thrown

void Equal<T>(T expected, T actual)
{
#pragma warning disable S112 // General or reserved exceptions should never be thrown
    if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"expected <{expected}> but got <{actual}>");
#pragma warning restore S112 // General or reserved exceptions should never be thrown

}
