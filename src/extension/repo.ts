import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CONFIG_FILES, type LoadedConfig, loadConfig } from '../core/config';
import { STATE_DIR, readLastReport, reportFileName, stateDir } from '../core/engine';
import { findRepoRoot } from '../core/git';
import { type HookStatus, hookStatus, writeEditorSettings } from '../core/hooks';
import type { RunReport, Stage } from '../core/types';
import { editorSettings } from './settings';

export const STAGES: Stage[] = ['pre-commit', 'commit-msg', 'pre-push'];

const real = (p: string) => {
  const r = fs.realpathSync.native(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * git reports the repository root as a canonical path (symlinks resolved, Windows 8.3 short names expanded),
 * but VS Code addresses files by the path the folder was opened with — e.g. macOS `/var/…` vs `/private/var/…`.
 * Express the root in the workspace's own spelling so diagnostics and "open file" links match open editors.
 */
export function alignWithWorkspacePath(folderPath: string, gitRoot: string): string {
  try {
    const mapped = path.resolve(folderPath, path.relative(real(folderPath), real(gitRoot)));
    return real(mapped) === real(gitRoot) ? mapped : gitRoot;
  } catch {
    return gitRoot;
  }
}

export class Repo implements vscode.Disposable {
  reports = new Map<Stage, RunReport>();
  hooks?: HookStatus;
  loaded?: LoadedConfig;
  configError?: string;
  running = false;
  private watchers: vscode.Disposable[] = [];
  private stateDirPath?: string;
  private lastSeen = new Map<Stage, string>();

  private readonly _onDidChange = new vscode.EventEmitter<{ repo: Repo; newHookReport?: RunReport }>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    public readonly root: string,
    public readonly folder: vscode.WorkspaceFolder | undefined,
  ) {}

  get name(): string {
    return path.basename(this.root);
  }

  static async discover(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const root = await findRepoRoot(folder.uri.fsPath);
    return root ? alignWithWorkspacePath(folder.uri.fsPath, root) : undefined;
  }

  async init(): Promise<void> {
    this.stateDirPath = await stateDir(this.root);
    fs.mkdirSync(this.stateDirPath, { recursive: true });
    await this.syncSettings();
    await this.refreshHooks();
    for (const s of STAGES) {
      const r = await readLastReport(this.root, s);
      if (r) {
        this.reports.set(s, r);
        this.lastSeen.set(s, r.startedAt);
      }
    }
    this.watch();
  }

  /** Snapshot VS Code settings into .git so the hook runner (outside VS Code) sees them too. */
  async syncSettings(): Promise<void> {
    const settings = editorSettings(this.folder?.uri);
    try {
      await writeEditorSettings(this.root, settings);
    } catch {
      /* read-only .git? */
    }
    try {
      this.loaded = loadConfig(this.root, { editorSettings: settings });
      this.configError = undefined;
    } catch (e) {
      this.configError = (e as Error).message;
    }
    this.fire();
  }

  async refreshHooks(): Promise<void> {
    try {
      this.hooks = await hookStatus(this.root);
    } catch {
      this.hooks = undefined;
    }
  }

  get hooksInstalled(): boolean {
    return !!this.hooks && (this.hooks.installed.length > 0 || this.hooks.huskyIntegrated.length > 0);
  }

  private watch(): void {
    // Reports are written by the git hook (any process) — poll the small files; reliable across platforms and inside .git.
    for (const s of STAGES) {
      const file = path.join(this.stateDirPath!, reportFileName(s));
      const listener = () => this.reloadReport(s);
      fs.watchFile(file, { interval: 1000 }, listener);
      this.watchers.push({ dispose: () => fs.unwatchFile(file, listener) });
    }
    const pattern = new vscode.RelativePattern(vscode.Uri.file(this.root), `{${[...CONFIG_FILES, 'package.json', '.lintstagedrc*'].join(',')}}`);
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    const reload = () => this.syncSettings();
    w.onDidChange(reload);
    w.onDidCreate(reload);
    w.onDidDelete(reload);
    this.watchers.push(w);
    // Monorepos: tool configs in sub-folders change which checks apply (Biome, Prettier, lint-staged, .NET).
    const nested = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(this.root),
        '**/{biome.json,biome.jsonc,.prettierrc*,prettier.config.*,.lintstagedrc*,lint-staged.config.*,*.sln,*.slnx,*.csproj,*.vbproj,*.fsproj,.csharpierrc*,dotnet-tools.json}',
      ),
    );
    const refresh = () => this.fire();
    nested.onDidCreate(refresh);
    nested.onDidDelete(refresh);
    nested.onDidChange(refresh);
    this.watchers.push(nested);
  }

  private async reloadReport(stage: Stage): Promise<void> {
    const r = await readLastReport(this.root, stage);
    if (!r || r.startedAt === this.lastSeen.get(stage)) return;
    this.lastSeen.set(stage, r.startedAt);
    this.reports.set(stage, r);
    this.fire(r.source !== 'vscode' ? r : undefined);
  }

  setReport(r: RunReport): void {
    this.reports.set(r.stage, r);
    this.lastSeen.set(r.stage, r.startedAt);
    this.fire();
  }

  fire(newHookReport?: RunReport): void {
    this._onDidChange.fire({ repo: this, newHookReport });
  }

  get stateDir(): string {
    return this.stateDirPath ?? path.join(this.root, '.git', STATE_DIR);
  }

  dispose(): void {
    this.watchers.forEach((w) => w.dispose());
    this._onDidChange.dispose();
  }
}
