using System;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace Tollgate.VisualStudio
{
    /// <summary>Raises <see cref="Changed"/> when a solution or folder is opened or closed.</summary>
    internal sealed class SolutionWatcher : IVsSolutionEvents, IVsSolutionEvents7, IDisposable
    {
        private readonly IVsSolution _solution;
        private uint _cookie;

        public SolutionWatcher(IVsSolution solution)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            _solution = solution;
            _solution.AdviseSolutionEvents(this, out _cookie);
        }

        public event EventHandler? Changed;

        /// <summary>Directory of the open solution, or the opened folder ("Open Folder" mode).</summary>
        public string? CurrentDirectory
        {
            get
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                return ErrorHandler.Succeeded(_solution.GetSolutionInfo(out var dir, out _, out _)) && !string.IsNullOrEmpty(dir) ? dir : null;
            }
        }

        private int Raise()
        {
            Changed?.Invoke(this, EventArgs.Empty);
            return VSConstants.S_OK;
        }

        // IVsSolutionEvents
        public int OnAfterOpenSolution(object pUnkReserved, int fNewSolution) => Raise();
        public int OnAfterCloseSolution(object pUnkReserved) => Raise();
        public int OnAfterOpenProject(IVsHierarchy pHierarchy, int fAdded) => VSConstants.S_OK;
        public int OnQueryCloseProject(IVsHierarchy pHierarchy, int fRemoving, ref int pfCancel) => VSConstants.S_OK;
        public int OnBeforeCloseProject(IVsHierarchy pHierarchy, int fRemoved) => VSConstants.S_OK;
        public int OnAfterLoadProject(IVsHierarchy pStubHierarchy, IVsHierarchy pRealHierarchy) => VSConstants.S_OK;
        public int OnQueryUnloadProject(IVsHierarchy pRealHierarchy, ref int pfCancel) => VSConstants.S_OK;
        public int OnBeforeUnloadProject(IVsHierarchy pRealHierarchy, IVsHierarchy pStubHierarchy) => VSConstants.S_OK;
        public int OnQueryCloseSolution(object pUnkReserved, ref int pfCancel) => VSConstants.S_OK;
        public int OnBeforeCloseSolution(object pUnkReserved) => VSConstants.S_OK;

        // IVsSolutionEvents7 (Open Folder)
        public void OnAfterOpenFolder(string folderPath) => Raise();
        public void OnAfterCloseFolder(string folderPath) => Raise();
        public void OnBeforeCloseFolder(string folderPath) { }
        public void OnQueryCloseFolder(string folderPath, ref int pfCancel) { }
        public void OnAfterLoadAllDeferredProjects() { }

        public void Dispose()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (_cookie != 0)
            {
                _solution.UnadviseSolutionEvents(_cookie);
                _cookie = 0;
            }
        }
    }
}
