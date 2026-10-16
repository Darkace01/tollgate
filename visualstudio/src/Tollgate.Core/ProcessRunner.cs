using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Tollgate.Core
{
    public sealed class ProcessResult
    {
        public ProcessResult(int exitCode, string stdout, string stderr, bool timedOut)
        {
            ExitCode = exitCode;
            Stdout = stdout;
            Stderr = stderr;
            TimedOut = timedOut;
        }

        public int ExitCode { get; }
        public string Stdout { get; }
        public string Stderr { get; }
        public bool TimedOut { get; }
    }

    /// <summary>Async process execution that works on .NET Framework (no WaitForExitAsync / ArgumentList there).</summary>
    public static class ProcessRunner
    {
        public static async Task<ProcessResult> RunAsync(
            string fileName,
            IEnumerable<string> args,
            string workingDirectory,
            TimeSpan timeout,
            CancellationToken cancellationToken = default,
            IDictionary<string, string>? environment = null)
        {
            var psi = new ProcessStartInfo(fileName, JoinArguments(args))
            {
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            psi.EnvironmentVariables["NO_COLOR"] = "1";
            psi.EnvironmentVariables["FORCE_COLOR"] = "0";
            if (environment != null)
            {
                foreach (var kv in environment) psi.EnvironmentVariables[kv.Key] = kv.Value;
            }

            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            var outDone = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var errDone = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var exited = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

            using var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) =>
            {
                if (e.Data == null) outDone.TrySetResult(true);
                else lock (stdout) stdout.AppendLine(e.Data);
            };
            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data == null) errDone.TrySetResult(true);
                else lock (stderr) stderr.AppendLine(e.Data);
            };
            process.Exited += (_, __) => exited.TrySetResult(true);

            if (!process.Start()) throw new InvalidOperationException($"Could not start {fileName}");
            process.StandardInput.Close();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            var timedOut = false;
            using (var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                timeoutCts.CancelAfter(timeout);
                var cancelled = new TaskCompletionSource<bool>();
                using (timeoutCts.Token.Register(() => cancelled.TrySetResult(true)))
                {
                    var finished = await Task.WhenAny(exited.Task, cancelled.Task).ConfigureAwait(false);
                    if (finished != exited.Task)
                    {
                        timedOut = !cancellationToken.IsCancellationRequested;
                        KillTree(process);
                    }
                }
            }

            // Drain the remaining output (bounded, in case a grandchild keeps the pipes open).
            await Task.WhenAny(Task.WhenAll(outDone.Task, errDone.Task), Task.Delay(2000)).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            int code;
            try
            {
                code = process.HasExited ? process.ExitCode : -1;
            }
            catch (InvalidOperationException)
            {
                code = -1;
            }
            lock (stdout)
            lock (stderr)
            {
                return new ProcessResult(code, stdout.ToString(), stderr.ToString(), timedOut);
            }
        }

        private static void KillTree(Process process)
        {
            try
            {
                if (process.HasExited) return;
                if (Environment.OSVersion.Platform == PlatformID.Win32NT)
                {
                    using var taskkill = Process.Start(new ProcessStartInfo("taskkill", $"/pid {process.Id} /T /F") { CreateNoWindow = true, UseShellExecute = false });
                    taskkill?.WaitForExit(5000);
                }
                else
                {
                    process.Kill();
                }
            }
            catch
            {
                // Already gone.
            }
        }

        /// <summary>Quote arguments using the Windows CommandLineToArgvW rules (also understood by .NET on Unix).</summary>
        public static string JoinArguments(IEnumerable<string> args) => string.Join(" ", args.Select(Quote));

        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            var backslashes = 0;
            foreach (var c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1).Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes).Append(c);
                }
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2).Append('"');
            return sb.ToString();
        }
    }
}
