using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Tollgate.Core
{
    public static class RepoLocator
    {
        /// <summary>Walk up from <paramref name="start"/> to the directory containing <c>.git</c> (a folder, or a file for worktrees).</summary>
        public static string? FindRoot(string? start)
        {
            if (string.IsNullOrEmpty(start)) return null;
            var dir = File.Exists(start) ? Path.GetDirectoryName(start) : start;
            while (!string.IsNullOrEmpty(dir))
            {
                var git = Path.Combine(dir!, ".git");
                if (Directory.Exists(git) || File.Exists(git)) return dir;
                dir = Path.GetDirectoryName(dir);
            }
            return null;
        }
    }

    public static class NodeLocator
    {
        /// <summary>
        /// Find node: an explicit path, then PATH, then extra candidates (e.g. the copy bundled with
        /// Visual Studio's JavaScript tooling under MSBuild\Microsoft\VisualStudio\NodeJs).
        /// </summary>
        public static string? Find(string? configured, IEnumerable<string>? extraCandidates = null)
        {
            if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
            var isWindows = Environment.OSVersion.Platform == PlatformID.Win32NT;
            var names = isWindows ? new[] { "node.exe" } : new[] { "node" };
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in path.Split(Path.PathSeparator).Where(d => !string.IsNullOrWhiteSpace(d)))
            {
                foreach (var name in names)
                {
                    try
                    {
                        var candidate = Path.Combine(dir.Trim().Trim('"'), name);
                        if (File.Exists(candidate)) return candidate;
                    }
                    catch (ArgumentException)
                    {
                        // Invalid characters in a PATH entry.
                    }
                }
            }
            if (isWindows)
            {
                var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                var nodeJs = Path.Combine(programFiles, "nodejs", "node.exe");
                if (File.Exists(nodeJs)) return nodeJs;
            }
            return extraCandidates?.FirstOrDefault(File.Exists);
        }

        /// <summary>Node shipped with Visual Studio's JS/TS tooling, derived from the devenv.exe location.</summary>
        public static IEnumerable<string> VisualStudioCandidates(string? devenvPath)
        {
            if (string.IsNullOrEmpty(devenvPath)) yield break;
            // …\Common7\IDE\devenv.exe → install root
            var root = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(devenvPath)));
            if (string.IsNullOrEmpty(root)) yield break;
            yield return Path.Combine(root, "MSBuild", "Microsoft", "VisualStudio", "NodeJs", "node.exe");
            yield return Path.Combine(root, "MSBuild", "Microsoft", "VisualStudio", "NodeJs", "win-x64", "node.exe");
        }
    }
}
