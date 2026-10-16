using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Shell;

namespace Tollgate.VisualStudio
{
    /// <summary>View › Other Windows › Tollgate — every check per git hook, with results and findings.</summary>
    public class ChecksToolWindow : BaseToolWindow<ChecksToolWindow>
    {
        public override string GetTitle(int toolWindowId) => "Tollgate";

        public override Type PaneType => typeof(Pane);

        public override async Task<FrameworkElement> CreateAsync(int toolWindowId, CancellationToken cancellationToken)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            return new ChecksControl();
        }

        [Guid("6af5627c-33d8-463b-a29f-5ebcb166dd41")]
        internal class Pane : ToolWindowPane
        {
            public Pane()
            {
                BitmapImageMoniker = KnownMonikers.StatusInformation;
            }
        }
    }
}
