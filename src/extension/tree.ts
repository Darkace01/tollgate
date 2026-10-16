import * as path from 'node:path';
import * as vscode from 'vscode';
import { customCheckId } from '../core/checks/commands';
import { collectChecks } from '../core/engine';
import { stagedFiles } from '../core/git';
import type { CheckResult, ChecksConfig, CustomCheck, Finding, Stage } from '../core/types';
import { type Repo, STAGES } from './repo';

export const BUILTIN_LABELS: Record<keyof ChecksConfig, string> = {
  npmScripts: 'package.json scripts',
  lintStaged: 'lint-staged',
  biome: 'Biome',
  secrets: 'Secrets & credentials',
  conflictMarkers: 'Merge conflict markers',
  debugStatements: 'Debug statements',
  todoComments: 'TODO / FIXME comments',
  trailingWhitespace: 'Trailing whitespace',
  eofNewline: 'Newline at end of file',
  jsonSyntax: 'JSON syntax',
  largeFiles: 'Large files',
  forbiddenFiles: 'Forbidden files',
  protectedBranches: 'Protected branches',
  branchName: 'Branch naming',
  commitMessage: 'Commit message format',
};

const STAGE_LABEL: Record<Stage, string> = { 'pre-commit': 'Pre-commit', 'commit-msg': 'Commit message', 'pre-push': 'Pre-push' };

export type Node =
  | { type: 'repo'; repo: Repo }
  | { type: 'stage'; repo: Repo; stage: Stage }
  | {
      type: 'check';
      repo: Repo;
      stage: Stage;
      id: string;
      name: string;
      enabled: boolean;
      builtinKey?: keyof ChecksConfig;
      custom?: CustomCheck;
      npmScript?: string;
      result?: CheckResult;
    }
  | { type: 'finding'; repo: Repo; finding: Finding; severity: 'error' | 'warning' }
  | { type: 'output'; repo: Repo; result: CheckResult }
  | { type: 'info'; label: string; icon: string; command?: vscode.Command; tooltip?: string };

export function builtinStage(key: keyof ChecksConfig, repo: Repo): Stage {
  if (key === 'commitMessage') return 'commit-msg';
  if (key === 'npmScripts') return repo.loaded?.config.checks.npmScripts.stage ?? 'pre-commit';
  return 'pre-commit';
}

export class ResultsTree implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly running = new Map<string, Set<string>>();

  constructor(private readonly getRepos: () => Repo[]) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  setRunning(repo: Repo, id: string, on: boolean): void {
    const set = this.running.get(repo.root) ?? new Set();
    if (on) set.add(id);
    else set.delete(id);
    this.running.set(repo.root, set);
    this.refresh();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const repos = this.getRepos();
    if (!node) {
      if (!repos.length) return [{ type: 'info', label: 'No git repository in this workspace', icon: 'info' }];
      return repos.length === 1 ? this.repoChildren(repos[0]) : repos.map((repo) => ({ type: 'repo', repo }));
    }
    switch (node.type) {
      case 'repo':
        return this.repoChildren(node.repo);
      case 'stage':
        return this.stageChildren(node.repo, node.stage);
      case 'check': {
        const r = node.result;
        if (!r || (r.status !== 'failed' && r.status !== 'error')) return [];
        const kids: Node[] = r.findings.map((finding) => ({ type: 'finding', repo: node.repo, finding, severity: r.severity }));
        if (r.output?.trim()) kids.push({ type: 'output', repo: node.repo, result: r });
        return kids;
      }
      default:
        return [];
    }
  }

  private repoChildren(repo: Repo): Node[] {
    const out: Node[] = [];
    if (repo.configError)
      out.push({
        type: 'info',
        label: 'Config error',
        icon: 'error',
        tooltip: repo.configError,
        command: { command: 'precommitGuard.showResolvedConfig', title: 'Show config' },
      });
    if (repo.loaded && !repo.loaded.config.enabled)
      out.push({
        type: 'info',
        label: 'Paused — checks are disabled',
        icon: 'debug-pause',
        command: { command: 'precommitGuard.togglePause', title: 'Resume' },
      });
    if (!repo.hooksInstalled) {
      out.push({
        type: 'info',
        label: repo.hooks?.customHooksPath ? 'Hooks not connected (core.hooksPath is set)' : 'Git hooks not installed — click to install',
        icon: 'plug',
        command: { command: 'precommitGuard.installHooks', title: 'Install', arguments: [repo.root] },
      });
    }
    const stages = repo.loaded?.config.hooks ?? STAGES;
    return [...out, ...STAGES.filter((s) => stages.includes(s) || repo.reports.has(s)).map((stage) => ({ type: 'stage' as const, repo, stage }))];
  }

  private async stageChildren(repo: Repo, stage: Stage): Promise<Node[]> {
    const config = repo.loaded?.config;
    if (!config) return [];
    const report = repo.reports.get(stage);
    const results = new Map((report?.results ?? []).map((r) => [r.id, r]));
    let defs: { id: string; name: string }[] = [];
    try {
      defs = await collectChecks(config, repo.root, stage, () => stagedFiles(repo.root));
    } catch {
      /* ignore */
    }

    const nodes: Node[] = defs.map((d) => {
      const builtinKey = (d.id in config.checks ? d.id : d.id.startsWith('npmScripts:') ? 'npmScripts' : undefined) as keyof ChecksConfig | undefined;
      const custom = d.id.startsWith('custom:') ? config.custom.find((c) => customCheckId(c) === d.id) : undefined;
      const npmScript = d.id.startsWith('npmScripts:') ? d.id.split(':').pop() : undefined;
      return { type: 'check', repo, stage, id: d.id, name: d.name, enabled: true, builtinKey, custom, npmScript, result: results.get(d.id) };
    });
    // Results from the last run for checks that no longer exist (e.g. scope changed) are dropped; disabled ones are listed for easy toggling.
    if (vscode.workspace.getConfiguration('precommitGuard').get<boolean>('showDisabledChecks', true)) {
      for (const key of Object.keys(config.checks) as (keyof ChecksConfig)[]) {
        const c = config.checks[key] as { enabled: boolean | 'auto' };
        if (builtinStage(key, repo) !== stage) continue;
        if (c.enabled === false) nodes.push({ type: 'check', repo, stage, id: key, name: BUILTIN_LABELS[key], enabled: false, builtinKey: key });
      }
      for (const c of config.custom) {
        if ((c.stage ?? 'pre-commit') === stage && c.enabled === false && c.command) {
          nodes.push({ type: 'check', repo, stage, id: customCheckId(c), name: c.name, enabled: false, custom: c });
        }
      }
    }
    if (!nodes.length) return [{ type: 'info', label: 'No checks for this stage', icon: 'circle-slash' }];
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'repo': {
        const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('repo');
        item.description = node.repo.root;
        item.contextValue = 'repo';
        return item;
      }
      case 'stage': {
        const report = node.repo.reports.get(node.stage);
        const item = new vscode.TreeItem(STAGE_LABEL[node.stage], vscode.TreeItemCollapsibleState.Expanded);
        const installed = node.repo.hooks?.installed.includes(node.stage) || node.repo.hooks?.huskyIntegrated.includes(node.stage);
        item.iconPath = new vscode.ThemeIcon(installed ? 'git-commit' : 'debug-disconnect');
        item.description = report
          ? `${report.blocked ? 'blocked' : 'passed'} · ${timeAgo(report.startedAt)} · ${report.source}`
          : installed
            ? 'not run yet'
            : 'hook not installed';
        item.contextValue = `stage.${node.stage}`;
        return item;
      }
      case 'check': {
        const r = node.result;
        const running = this.running.get(node.repo.root)?.has(node.id);
        const hasKids = !!r && (r.status === 'failed' || r.status === 'error') && (r.findings.length > 0 || !!r.output?.trim());
        const item = new vscode.TreeItem(node.name, hasKids ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `${node.repo.root}|${node.stage}|${node.id}`;
        if (!node.enabled) {
          item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
          item.description = 'disabled';
        } else if (running) {
          item.iconPath = new vscode.ThemeIcon('loading~spin');
          item.description = 'running…';
        } else if (!r) {
          item.iconPath = new vscode.ThemeIcon('circle-large-outline');
          item.description = 'not run';
        } else {
          item.iconPath = statusIcon(r);
          item.description = r.summary + (r.durationMs >= 1000 ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : '');
        }
        const md = new vscode.MarkdownString(`**${node.name}** \`${node.id}\`\n\n`);
        if (r) md.appendMarkdown(`${r.status} (${r.severity}) — ${r.summary}\n\n`);
        if (r?.command) md.appendCodeblock(r.command, 'sh');
        if (node.custom) md.appendCodeblock(node.custom.command, 'sh');
        item.tooltip = md;
        const kind = node.custom ? 'custom' : node.npmScript ? 'npm' : 'builtin';
        item.contextValue = `check.${kind}.${node.enabled ? 'enabled' : 'disabled'}${r?.fixable && r.status === 'failed' ? '.fixable' : ''}`;
        return item;
      }
      case 'finding': {
        const f = node.finding;
        const label = f.file ? `${path.basename(f.file)}${f.line ? `:${f.line}` : ''}` : f.message;
        const item = new vscode.TreeItem(label);
        item.description = f.file ? f.message : undefined;
        item.tooltip = `${f.file ?? ''}${f.line ? `:${f.line}` : ''}${f.column ? `:${f.column}` : ''}\n${f.message}${f.rule ? `\n(${f.rule})` : ''}`;
        item.iconPath = new vscode.ThemeIcon(
          node.severity === 'error' ? 'error' : 'warning',
          new vscode.ThemeColor(node.severity === 'error' ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground'),
        );
        if (f.file) {
          const uri = vscode.Uri.file(path.join(node.repo.root, f.file));
          const line = Math.max(0, (f.line ?? 1) - 1);
          const col = Math.max(0, (f.column ?? 1) - 1);
          item.resourceUri = uri;
          item.command = { command: 'vscode.open', title: 'Open', arguments: [uri, { selection: new vscode.Range(line, col, line, col) }] };
        }
        item.contextValue = 'finding';
        return item;
      }
      case 'output': {
        const item = new vscode.TreeItem('Show full output');
        item.iconPath = new vscode.ThemeIcon('output');
        item.command = { command: 'precommitGuard.showCheckOutput', title: 'Show output', arguments: [node.result] };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.command = node.command;
        item.tooltip = node.tooltip;
        return item;
      }
    }
  }
}

export function statusIcon(r: CheckResult): vscode.ThemeIcon {
  switch (r.status) {
    case 'passed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'skipped':
      return new vscode.ThemeIcon('debug-step-over', new vscode.ThemeColor('disabledForeground'));
    default:
      return r.severity === 'error'
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
        : new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  }
}

function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
