using System.ComponentModel;
using System.Runtime.InteropServices;
using Community.VisualStudio.Toolkit;

namespace Tollgate.VisualStudio
{
    internal partial class OptionsProvider
    {
        // Tools > Options > Tollgate > General
        [ComVisible(true)]
        public class GeneralOptions : BaseOptionPage<General> { }
    }

    public enum HookInstallMode
    {
        Prompt,
        Always,
        Never,
    }

    /// <summary>
    /// Editor-only preferences. What gets checked lives in the repository (.tollgaterc.json), shared with VS Code,
    /// the terminal and CI.
    /// </summary>
    public class General : BaseOptionModel<General>
    {
        [Category("Git hooks")]
        [DisplayName("Install git hooks automatically")]
        [Description("Prompt: ask once per repository. Always: install silently. Never: only via Tools > Tollgate > Install Git Hooks.")]
        [DefaultValue(HookInstallMode.Prompt)]
        [TypeConverter(typeof(EnumConverter))]
        public HookInstallMode AutoInstallHooks { get; set; } = HookInstallMode.Prompt;

        [Category("Notifications")]
        [DisplayName("Show the Tollgate window when a commit is blocked")]
        [Description("Bring up the Tollgate window with the failing checks when a commit from any client is blocked.")]
        [DefaultValue(true)]
        public bool ShowWindowWhenBlocked { get; set; } = true;

        [Category("Notifications")]
        [DisplayName("Show findings in the Error List")]
        [Description("List Tollgate findings (with file and line) in the Error List.")]
        [DefaultValue(true)]
        public bool ShowInErrorList { get; set; } = true;

        [Category("Runtime")]
        [DisplayName("Node.js path")]
        [Description("Full path to node.exe. Leave empty to use Node.js from PATH, or the copy that ships with Visual Studio's JavaScript/TypeScript tools.")]
        [DefaultValue("")]
        public string NodePath { get; set; } = "";
    }
}
