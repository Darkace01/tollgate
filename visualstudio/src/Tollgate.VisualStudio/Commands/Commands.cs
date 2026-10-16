using System;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using Tollgate.Core;
using Task = System.Threading.Tasks.Task;

namespace Tollgate.VisualStudio
{
    // Tools › Tollgate › … and View › Other Windows › Tollgate. IDs match VSCommandTable.vsct.
    // Each command derives directly from BaseCommand<T> (the Community Toolkit's documented pattern).

    internal static class CommandState
    {
        public static TollgateService? Service => TollgateService.Instance;

        /// <summary>Most commands need an open git repository with Node.js available, and no run in progress.</summary>
        public static bool Ready => Service?.IsReady == true && Service.IsRunning == false;
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.ShowWindow)]
    internal sealed class ShowWindowCommand : BaseCommand<ShowWindowCommand>
    {
        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e) => await ChecksToolWindow.ShowAsync();
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.RunChecks)]
    internal sealed class RunChecksCommand : BaseCommand<RunChecksCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = CommandState.Ready;

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            await ChecksToolWindow.ShowAsync();
            if (CommandState.Service != null) await CommandState.Service.RunAsync();
        }
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.RunAllFiles)]
    internal sealed class RunAllFilesCommand : BaseCommand<RunAllFilesCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = CommandState.Ready;

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            await ChecksToolWindow.ShowAsync();
            if (CommandState.Service != null) await CommandState.Service.RunAsync(allFiles: true);
        }
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.RunPrePush)]
    internal sealed class RunPrePushCommand : BaseCommand<RunPrePushCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = CommandState.Ready;

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            await ChecksToolWindow.ShowAsync();
            if (CommandState.Service != null) await CommandState.Service.RunAsync(Stages.PrePush);
        }
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.InstallHooks)]
    internal sealed class InstallHooksCommand : BaseCommand<InstallHooksCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = CommandState.Ready;

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            if (CommandState.Service != null) await CommandState.Service.InstallHooksAsync();
        }
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.UninstallHooks)]
    internal sealed class UninstallHooksCommand : BaseCommand<UninstallHooksCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = CommandState.Ready && CommandState.Service!.HooksInstalled;

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            if (CommandState.Service != null) await CommandState.Service.UninstallHooksAsync();
        }
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.OpenConfig)]
    internal sealed class OpenConfigCommand : BaseCommand<OpenConfigCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = CommandState.Ready;

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            if (CommandState.Service != null) await CommandState.Service.OpenConfigAsync();
        }
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.TogglePause)]
    internal sealed class TogglePauseCommand : BaseCommand<TogglePauseCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e)
        {
            Command.Enabled = CommandState.Ready;
            Command.Text = CommandState.Service?.Catalog?.Enabled == false ? "Resume Tollgate" : "Pause Tollgate (Just Me)";
        }

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            if (CommandState.Service != null) await CommandState.Service.TogglePauseAsync();
        }
    }

    [Command(PackageGuids.TollgateCmdSetString, PackageIds.FixWhitespace)]
    internal sealed class FixWhitespaceCommand : BaseCommand<FixWhitespaceCommand>
    {
        protected override void BeforeQueryStatus(EventArgs e) => Command.Enabled = CommandState.Ready;

        protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
        {
            if (CommandState.Service != null) await CommandState.Service.FixWhitespaceAsync();
        }
    }
}
