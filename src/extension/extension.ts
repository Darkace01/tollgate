import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { slug } from '../core/checks/commands';
import { loadConfig, sampleConfig } from '../core/config';
import { fixFiles, isBlocking, runChecks } from '../core/engine';
import { stageFiles, stagedFiles, unstagedFiles } from '../core/git';
import { installHooks, installRunner, integrateWithHusky, uninstallHooks } from '../core/hooks';
import { formatReport } from '../core/reporter';
import type { CheckResult, ChecksConfig, Preset, RunReport, Severity, Stage } from '../core/types';
import { Repo } from './repo';
import { SECTION, addCustom, editorSettings, repoConfigFile, uiSetting, updateConfigValue, updateCustom } from './settings';
import { BUILTIN_LABELS, type Node, ResultsTree, builtinStage } from './tree';

let output: vscode.OutputChannel;
const repos = new Map<string, Repo>();
let tree: ResultsTree;
let status: vscode.StatusBarItem;
let treeView: vscode.TreeView<unknown>;
let diagnostics: vscode.DiagnosticCollection;
let ctx: vscode.ExtensionContext;
let currentRun: vscode.CancellationTokenSource | undefined;

const version = () => ctx.extension.packageJSON.version as string;
const runnerSource = () => ctx.asAbsolutePath(path.join('dist', 'cli.js'));
const log = (msg: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;
  output = vscode.window.createOutputChannel('Tollgate');
  diagnostics = vscode.languages.createDiagnosticCollection('tollgate');
  tree = new ResultsTree(() => [...repos.values()]);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'tollgate.run';
  treeView = vscode.window.createTreeView('tollgate.results', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(output, diagnostics, status, treeView);

  registerCommands(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => discoverRepos()),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      for (const repo of repos.values()) {
        await repo.syncSettings();
        if (e.affectsConfiguration(`${SECTION}.hooks`) && repo.hooks?.installed.length) await doInstall(repo, true);
      }
      updateUi();
    }),
  );
  await discoverRepos();
}

export function deactivate(): void {
  currentRun?.cancel();
  repos.forEach((r) => r.dispose());
}

// ------------------------------------------------------------------ repos

async function discoverRepos(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = new Map<string, vscode.WorkspaceFolder>();
  for (const f of folders) {
    const root = await Repo.discover(f).catch(() => undefined);
    if (root && !found.has(root)) found.set(root, f);
  }
  for (const [root, repo] of repos)
    if (!found.has(root)) {
      repo.dispose();
      repos.delete(root);
    }
  for (const [root, folder] of found) {
    if (repos.has(root)) continue;
    const repo = new Repo(root, folder);
    repos.set(root, repo);
    try {
      await repo.init();
    } catch (e) {
      log(`Failed to initialise ${root}: ${(e as Error).message}`);
      continue;
    }
    repo.onDidChange(({ newHookReport }) => {
      updateUi();
      if (newHookReport) onHookReport(repo, newHookReport);
    });
    log(`Watching ${root} (config: ${repo.loaded?.sources.join(' → ') ?? 'error'})`);
    await maintainHooks(repo);
  }
  vscode.commands.executeCommand('setContext', 'tollgate.hasRepo', repos.size > 0);
  updateUi();
}

/** Keep the runner fresh after extension updates, and offer to install hooks the first time. */
async function maintainHooks(repo: Repo): Promise<void> {
  const h = repo.hooks;
  if (!h) return;
  if (h.installed.length) {
    if (h.runnerVersion !== version()) await doInstall(repo, true, true);
    return;
  }
  if (h.huskyIntegrated.length) {
    await installRunner(repo.root, runnerSource(), version());
    return;
  }
  const mode = uiSetting<string>('autoInstallHooks', repo.folder?.uri);
  const dismissedKey = `dismissed:${repo.root}`;
  if (mode === 'never' || ctx.workspaceState.get(dismissedKey)) return;
  if (mode === 'always' && !h.customHooksPath) {
    await doInstall(repo, false, true);
    return;
  }

  const actions = h.customHooksPath ? ['Integrate with Husky', 'Install anyway', 'Not now', 'Never'] : ['Install hooks', 'Not now', 'Never'];
  const msg = h.customHooksPath
    ? `Tollgate: "${repo.name}" uses core.hooksPath (${h.hooksPath}). Add Tollgate to those hooks?`
    : `Tollgate: install git hooks in "${repo.name}" so checks run on every commit (VS Code and terminal)?`;
  vscode.window.showInformationMessage(msg, ...actions).then(async (choice) => {
    if (choice === 'Install hooks') await doInstall(repo);
    else if (choice === 'Install anyway') await doInstall(repo, true);
    else if (choice === 'Integrate with Husky') await doHusky(repo);
    else if (choice === 'Never') await ctx.workspaceState.update(dismissedKey, true);
  });
}

async function doInstall(repo: Repo, force = false, quiet = false): Promise<boolean> {
  const stages = repo.loaded?.config.hooks ?? ['pre-commit', 'commit-msg', 'pre-push'];
  const res = await installHooks(repo.root, {
    stages,
    runnerSource: runnerSource(),
    version: version(),
    nodeFallback: process.execPath,
    force: force || !!repo.hooks?.installed.length,
  });
  if (!res.ok) {
    const choice = await vscode.window.showWarningMessage(
      `core.hooksPath is set to "${res.hooksPath}" (husky, lefthook…). Installing there may overwrite tracked files.`,
      'Integrate with Husky',
      'Install anyway',
      'Cancel',
    );
    if (choice === 'Integrate with Husky') return doHusky(repo);
    if (choice === 'Install anyway') return doInstall(repo, true);
    return false;
  }
  await repo.refreshHooks();
  log(`Installed hooks in ${repo.root}: ${res.installed.join(', ')}${res.backedUp.length ? ` (chained existing: ${res.backedUp.join(', ')})` : ''}`);
  if (!quiet) {
    vscode.window.showInformationMessage(
      `Tollgate hooks installed in "${repo.name}" (${res.installed.join(', ')}).${res.backedUp.length ? ' Your existing hooks are kept and run first.' : ''}`,
    );
  }
  updateUi();
  return true;
}

async function doHusky(repo: Repo): Promise<boolean> {
  const stages = repo.loaded?.config.hooks ?? ['pre-commit', 'commit-msg', 'pre-push'];
  const touched = await integrateWithHusky(repo.root, { stages, runnerSource: runnerSource(), version: version() });
  await repo.refreshHooks();
  updateUi();
  vscode.window.showInformationMessage(
    touched.length ? `Added Tollgate to ${touched.join(', ')}. The line is a no-op for teammates without the extension.` : 'Husky hooks already call Tollgate.',
  );
  return true;
}

async function pickRepo(arg?: unknown): Promise<Repo | undefined> {
  if (typeof arg === 'string' && repos.has(arg)) return repos.get(arg);
  if (arg && typeof arg === 'object' && 'repo' in arg) return (arg as { repo: Repo }).repo;
  if (arg instanceof vscode.Uri) {
    const r = [...repos.values()].find((x) => arg.fsPath.startsWith(x.root));
    if (r) return r;
  }
  const list = [...repos.values()];
  if (!list.length) {
    vscode.window.showWarningMessage('Tollgate: no git repository found in this workspace.');
    return undefined;
  }
  if (list.length === 1) return list[0];
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const byEditor = active ? list.find((r) => active.startsWith(r.root + path.sep)) : undefined;
  const pick = await vscode.window.showQuickPick(
    list.map((r) => ({ label: r.name, description: r.root, repo: r, picked: r === byEditor })),
    { placeHolder: 'Select repository' },
  );
  return pick?.repo;
}

// ------------------------------------------------------------------ running

async function run(repo: Repo, opts: { mode?: 'staged' | 'all'; only?: string[]; stage?: Stage; silent?: boolean } = {}): Promise<RunReport | undefined> {
  if (repo.running) {
    vscode.window.showInformationMessage('Tollgate is already running.');
    return;
  }
  await repo.syncSettings();
  if (repo.configError) {
    vscode.window.showErrorMessage(`Tollgate config error: ${repo.configError}`);
    return;
  }
  const stage = opts.stage ?? 'pre-commit';
  repo.running = true;
  updateUi();
  currentRun = new vscode.CancellationTokenSource();
  const abort = new AbortController();
  currentRun.token.onCancellationRequested(() => abort.abort());
  log(`Running ${stage} checks (${opts.mode ?? 'staged'}${opts.only ? `, only ${opts.only.join(',')}` : ''}) in ${repo.root}`);
  try {
    const report = await vscode.window.withProgress(
      {
        location: opts.silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
        title: 'Tollgate',
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        return runChecks({
          root: repo.root,
          stage,
          source: 'vscode',
          mode: opts.mode ?? 'staged',
          only: opts.only,
          editorSettings: editorSettings(repo.folder?.uri),
          signal: abort.signal,
          onStart: (d) => {
            tree.setRunning(repo, d.id, true);
            progress.report({ message: d.name });
          },
          onResult: (r) => {
            tree.setRunning(repo, r.id, false);
            log(`  ${r.status.padEnd(7)} ${r.name} — ${r.summary}`);
          },
        });
      },
    );
    tree.running.delete(repo.root);
    if (opts.only && repo.reports.get(stage)) {
      // Partial run: merge into the previous report so other results stay visible.
      const prev = repo.reports.get(stage)!;
      const merged = new Map(prev.results.map((r) => [r.id, r]));
      report.results.forEach((r) => merged.set(r.id, r));
      report.results = [...merged.values()];
      const cfg = repo.loaded!.config;
      report.blocked = report.results.some((r) => isBlocking(r, cfg));
    }
    repo.setReport(report);
    output.appendLine(formatReport(report, { color: false }));
    if (!opts.silent) announce(repo, report, false);
    return report;
  } catch (e) {
    log(`Run failed: ${(e as Error).stack ?? e}`);
    vscode.window.showErrorMessage(`Tollgate failed: ${(e as Error).message}`);
  } finally {
    repo.running = false;
    tree.running.delete(repo.root);
    currentRun?.dispose();
    currentRun = undefined;
    updateUi();
  }
}

function announce(repo: Repo, report: RunReport, fromHook: boolean): void {
  const failed = report.results.filter((r) => r.status === 'failed' || r.status === 'error');
  const where = repos.size > 1 ? ` in ${repo.name}` : '';
  if (report.blocked) {
    const blocking = failed.filter((r) => isBlocking(r, repo.loaded?.config ?? ({ failOn: 'error' } as never)));
    const warnings = failed.length - blocking.length;
    const names = blocking.map((r) => r.name).join(', ');
    const extra = warnings ? ` (+${warnings} warning${warnings === 1 ? '' : 's'})` : '';
    const msg = fromHook ? `Commit blocked${where}: ${names} failed${extra}.` : `${blocking.length} check(s) failed${where}: ${names}${extra}`;
    const actions = ['Show Results', 'Show Output'];
    if (failed.some((r) => r.fixable)) actions.unshift('Auto-fix');
    vscode.window.showErrorMessage(`Tollgate: ${msg}`, ...actions).then((c) => handleAction(c, repo));
  } else if (failed.length) {
    if (uiSetting<string>('notifyOn') === 'all' || !fromHook) {
      vscode.window
        .showWarningMessage(`Tollgate: passed with ${failed.length} warning(s)${where}: ${failed.map((r) => r.name).join(', ')}`, 'Show Results')
        .then((c) => handleAction(c, repo));
    }
  } else if (!fromHook) {
    vscode.window.setStatusBarMessage(`$(pass) Tollgate: all ${report.results.filter((r) => r.status === 'passed').length} checks passed`, 4000);
  }
}

function handleAction(choice: string | undefined, repo: Repo): void {
  if (choice === 'Show Results') vscode.commands.executeCommand('tollgate.results.focus');
  else if (choice === 'Show Output') output.show(true);
  else if (choice === 'Auto-fix') vscode.commands.executeCommand('tollgate.fix', repo.root);
}

function onHookReport(repo: Repo, report: RunReport): void {
  log(`Git ${report.stage} hook ran (${report.blocked ? 'BLOCKED' : 'ok'}) in ${repo.root}`);
  output.appendLine(formatReport(report, { color: false }));
  const notify = uiSetting<string>('notifyOn');
  if (notify === 'never') return;
  if (report.blocked || notify === 'all') announce(repo, report, true);
}

// ------------------------------------------------------------------ UI

function updateUi(): void {
  tree.refresh();
  updateDiagnostics();
  updateStatus();
}

function updateDiagnostics(): void {
  diagnostics.clear();
  if (!uiSetting<boolean>('showDiagnostics')) return;
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const repo of repos.values()) {
    for (const report of repo.reports.values()) {
      for (const r of report.results) {
        if (r.status !== 'failed' && r.status !== 'error') continue;
        for (const f of r.findings) {
          if (!f.file) continue;
          const abs = path.join(repo.root, f.file);
          const line = Math.max(0, (f.line ?? 1) - 1);
          const col = Math.max(0, (f.column ?? 1) - 1);
          const d = new vscode.Diagnostic(
            new vscode.Range(line, col, line, Number.MAX_SAFE_INTEGER),
            f.message,
            r.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
          );
          d.source = `Tollgate › ${r.name}`;
          if (f.rule) d.code = f.rule;
          const list = byFile.get(abs) ?? [];
          list.push(d);
          byFile.set(abs, list);
        }
      }
    }
  }
  for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
}

function updateBadge(): void {
  const failed = [...repos.values()]
    .flatMap((r) => [...r.reports.values()])
    .flatMap((r) => r.results)
    .filter((r) => (r.status === 'failed' || r.status === 'error') && r.severity === 'error');
  treeView.badge = failed.length ? { value: failed.length, tooltip: `${failed.length} blocking check(s) failed` } : undefined;
}

function updateStatus(): void {
  updateBadge();
  if (!uiSetting<boolean>('showStatusBar') || !repos.size) {
    status.hide();
    return;
  }
  const all = [...repos.values()];
  const reports = all.map((r) => r.reports.get('pre-commit')).filter(Boolean) as RunReport[];
  const failed = reports.flatMap((r) => r.results).filter((r) => r.status === 'failed' || r.status === 'error');
  const blocked = reports.some((r) => r.blocked);
  if (all.some((r) => r.running)) {
    status.text = '$(sync~spin) Tollgate';
    status.tooltip = 'Tollgate: running checks…';
    status.backgroundColor = undefined;
  } else if (all.every((r) => r.loaded && !r.loaded.config.enabled)) {
    status.text = '$(debug-pause) Tollgate';
    status.tooltip = 'Tollgate is paused — click to run, or use "Tollgate: Resume"';
    status.backgroundColor = undefined;
  } else if (!all.some((r) => r.hooksInstalled)) {
    status.text = '$(shield) Tollgate $(debug-disconnect)';
    status.tooltip = 'Tollgate: git hooks not installed — commits are not checked. Click to run checks now.';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (blocked) {
    const blocking = failed.filter((r) => r.severity === 'error');
    status.text = `$(error) Tollgate ${blocking.length || failed.length}`;
    status.tooltip = `Tollgate: ${(blocking.length ? blocking : failed).map((r) => r.name).join(', ')} failed — click to re-run`;
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (failed.length) {
    status.text = `$(warning) Tollgate ${failed.length}`;
    status.tooltip = `Tollgate: ${failed.length} warning(s) — click to re-run`;
    status.backgroundColor = undefined;
  } else {
    status.text = reports.length ? '$(pass) Tollgate' : '$(shield) Tollgate';
    status.tooltip = reports.length ? 'Tollgate: last run passed — click to run on staged changes' : 'Tollgate: click to run checks on staged changes';
    status.backgroundColor = undefined;
  }
  status.show();
}

// ------------------------------------------------------------------ commands

function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('tollgate.run', async (arg?: unknown) => {
    const r = await pickRepo(arg);
    if (r) await run(r);
  });
  reg('tollgate.runAll', async (arg?: unknown) => {
    const r = await pickRepo(arg);
    if (r) await run(r, { mode: 'all' });
  });
  reg('tollgate.runPrePush', async (arg?: unknown) => {
    const r = await pickRepo(arg);
    if (r) await run(r, { stage: 'pre-push' });
  });
  reg('tollgate.runCheck', async (node?: Node) => {
    if (node?.type !== 'check') return;
    await run(node.repo, { only: [node.id], stage: node.stage === 'commit-msg' ? 'pre-commit' : node.stage });
  });
  reg('tollgate.cancel', () => currentRun?.cancel());

  reg('tollgate.installHooks', async (arg?: unknown) => {
    const r = await pickRepo(arg);
    if (r) await doInstall(r);
  });
  reg('tollgate.integrateHusky', async (arg?: unknown) => {
    const r = await pickRepo(arg);
    if (r) await doHusky(r);
  });
  reg('tollgate.uninstallHooks', async (arg?: unknown) => {
    const r = await pickRepo(arg);
    if (!r) return;
    const removed = await uninstallHooks(r.root);
    await r.refreshHooks();
    updateUi();
    vscode.window.showInformationMessage(removed.length ? `Removed Tollgate hooks: ${removed.join(', ')}` : 'No Tollgate hooks were installed.');
  });

  reg('tollgate.togglePause', async () => {
    const current = vscode.workspace.getConfiguration(SECTION).get<boolean>('enabled', true);
    await vscode.workspace.getConfiguration(SECTION).update('enabled', !current, vscode.ConfigurationTarget.Workspace);
    vscode.window.setStatusBarMessage(`Tollgate ${current ? 'paused' : 'resumed'} for this workspace`, 3000);
  });

  reg('tollgate.disableCheck', (node?: Node) => vscode.commands.executeCommand('tollgate.toggleCheck', node));
  reg('tollgate.enableCheck', (node?: Node) => vscode.commands.executeCommand('tollgate.toggleCheck', node));
  reg('tollgate.toggleCheck', async (node?: Node) => {
    if (node?.type !== 'check') return;
    const repo = node.repo;
    let where: string | undefined;
    if (node.custom) where = await updateCustom(repo.root, repo.folder?.uri, node.custom, { enabled: !node.enabled });
    else if (node.npmScript) {
      const scripts = repo.loaded!.config.checks.npmScripts.scripts.filter((s) => s !== node.npmScript);
      where = await updateConfigValue(repo.root, repo.folder?.uri, ['checks', 'npmScripts', 'scripts'], scripts);
    } else if (node.builtinKey) {
      where = await updateConfigValue(repo.root, repo.folder?.uri, ['checks', node.builtinKey, 'enabled'], !node.enabled);
    }
    await repo.syncSettings();
    if (where) vscode.window.setStatusBarMessage(`${node.name} ${node.enabled ? 'disabled' : 'enabled'} (${where})`, 3000);
  });

  reg('tollgate.setSeverity', async (node?: Node) => {
    if (node?.type !== 'check' || (!node.builtinKey && !node.custom)) return;
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'error', description: 'Blocks the commit' },
        { label: 'warning', description: 'Reports but allows the commit' },
      ],
      { placeHolder: `Severity for ${node.name}` },
    );
    if (!pick) return;
    const repo = node.repo;
    if (node.builtinKey) await updateConfigValue(repo.root, repo.folder?.uri, ['checks', node.builtinKey, 'severity'], pick.label);
    else if (node.custom) {
      await updateCustom(repo.root, repo.folder?.uri, node.custom, { severity: pick.label as Severity });
    }
    await repo.syncSettings();
  });

  reg('tollgate.configureChecks', async (arg?: unknown) => {
    const repo = await pickRepo(arg);
    if (!repo?.loaded) return;
    const cfg = repo.loaded.config;
    type Item = vscode.QuickPickItem & { key?: keyof ChecksConfig; customKey?: { id?: string; name: string } };
    const items: Item[] = [{ label: 'Built-in checks', kind: vscode.QuickPickItemKind.Separator }];
    for (const key of Object.keys(cfg.checks) as (keyof ChecksConfig)[]) {
      const c = cfg.checks[key] as { enabled: boolean | 'auto'; severity: Severity };
      items.push({
        label: BUILTIN_LABELS[key],
        description: `${key} · ${c.severity} · ${builtinStage(key, repo)}${c.enabled === 'auto' ? ' · auto' : ''}`,
        picked: c.enabled !== false,
        key,
      });
    }
    if (cfg.custom.length) items.push({ label: 'Custom checks', kind: vscode.QuickPickItemKind.Separator });
    for (const c of cfg.custom.filter((x) => x.command)) {
      items.push({ label: c.name, description: `${c.command}`, picked: c.enabled !== false, customKey: { id: c.id, name: c.name } });
    }
    const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Select the checks to enable', matchOnDescription: true });
    if (!picked) return;
    const on = new Set(picked);
    for (const item of items) {
      if (item.key) {
        const cur = (cfg.checks[item.key] as { enabled: boolean | 'auto' }).enabled;
        const want = on.has(item);
        if ((cur !== false) !== want) await updateConfigValue(repo.root, repo.folder?.uri, ['checks', item.key, 'enabled'], want);
      } else if (item.customKey) {
        const cur = cfg.custom.find((c) => (c.id ?? c.name) === (item.customKey!.id ?? item.customKey!.name))?.enabled !== false;
        if (cur !== on.has(item)) await updateCustom(repo.root, repo.folder?.uri, item.customKey, { enabled: on.has(item) });
      }
    }
    await repo.syncSettings();
  });

  reg('tollgate.selectPreset', async (arg?: unknown) => {
    const repo = await pickRepo(arg);
    if (!repo) return;
    const presets: { label: Preset; detail: string }[] = [
      { label: 'minimal', detail: 'Secrets, conflict markers, large/forbidden files, lint' },
      { label: 'recommended', detail: 'Minimal + JSON syntax, debug statements (warn), protected branches (warn), lint/typecheck/format scripts' },
      { label: 'strict', detail: 'Everything on: whitespace, EOF, TODOs, branch naming, Conventional Commits, tests' },
      { label: 'none', detail: 'Start from nothing — only what you enable explicitly' },
    ];
    const pick = await vscode.window.showQuickPick(
      presets.map((p) => ({ ...p, description: p.label === repo.loaded?.config.extends ? 'current' : undefined })),
      { placeHolder: 'Choose a preset (your overrides still apply)' },
    );
    if (!pick) return;
    const where = await updateConfigValue(repo.root, repo.folder?.uri, ['extends'], pick.label);
    await repo.syncSettings();
    vscode.window.setStatusBarMessage(`Preset set to ${pick.label} (${where})`, 3000);
  });

  reg('tollgate.addCustomCheck', async (arg?: unknown) => {
    const repo = await pickRepo(arg);
    if (!repo) return;
    const name = await vscode.window.showInputBox({ prompt: 'Name of the check', placeHolder: 'e.g. Prettier, Unit tests, Stylelint' });
    if (!name) return;
    const command = await vscode.window.showInputBox({
      prompt: 'Shell command. Placeholders: {files} staged files · {root} · {branch} · {msgFile}',
      placeHolder: 'npx --no-install prettier --check {files}',
    });
    if (!command) return;
    const glob = await vscode.window.showInputBox({
      prompt: 'Only run when staged files match this glob (leave empty to always run)',
      placeHolder: '**/*.{ts,tsx}',
    });
    if (glob === undefined) return;
    const stage = await vscode.window.showQuickPick(['pre-commit', 'commit-msg', 'pre-push'], { placeHolder: 'When should it run?' });
    if (!stage) return;
    const severity = await vscode.window.showQuickPick(['error', 'warning'], { placeHolder: 'Severity (error blocks the commit)' });
    if (!severity) return;
    const restage = /--write|--fix|\bfmt\b|format(?!:check)/.test(command)
      ? (await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'This looks like a formatter. Re-stage files it modifies?' })) === 'Yes'
      : false;
    const check: Record<string, unknown> = { id: slug(name), name, command, stage, severity };
    if (glob) check.glob = glob;
    if (restage) check.restage = true;
    const where = await addCustom(repo.root, repo.folder?.uri, check);
    await repo.syncSettings();
    const choice = await vscode.window.showInformationMessage(`Added "${name}" to ${where}.`, 'Run it now');
    if (choice) await run(repo, { only: [`custom:${slug(name)}`], stage: stage === 'commit-msg' ? 'pre-commit' : (stage as Stage) });
  });

  reg('tollgate.createConfig', async (arg?: unknown) => {
    const repo = await pickRepo(arg);
    if (!repo) return;
    const f = repoConfigFile(repo.root);
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(sampleConfig(), null, 2) + '\n');
    await vscode.window.showTextDocument(vscode.Uri.file(f));
  });

  reg('tollgate.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${ctx.extension.id}`));
  reg('tollgate.showOutput', () => output.show());

  reg('tollgate.showResolvedConfig', async (arg?: unknown) => {
    const repo = await pickRepo(arg);
    if (!repo) return;
    let content: string;
    try {
      const { config, sources } = loadConfig(repo.root, { editorSettings: editorSettings(repo.folder?.uri) });
      content = JSON.stringify({ _sources: sources, ...config }, null, 2);
    } catch (e) {
      content = `// ${(e as Error).message}`;
    }
    const doc = await vscode.workspace.openTextDocument({ language: 'jsonc', content });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  reg('tollgate.showCheckOutput', async (result?: CheckResult) => {
    if (!result) return;
    const content = `# ${result.name} (${result.id}) — ${result.status}\n${result.command ? `# $ ${result.command}\n` : ''}\n${result.output ?? ''}`;
    const doc = await vscode.workspace.openTextDocument({ language: 'log', content });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  reg('tollgate.fix', async (arg?: unknown) => {
    const repo = await pickRepo(arg);
    if (!repo?.loaded) return;
    const staged = await stagedFiles(repo.root);
    if (!staged.length) {
      vscode.window.showInformationMessage('No staged files to fix.');
      return;
    }
    await vscode.workspace.saveAll(false);
    const partial = new Set(await unstagedFiles(repo.root));
    const changed = await fixFiles(repo.root, staged, repo.loaded.config);
    await stageFiles(
      repo.root,
      changed.filter((f) => !partial.has(f)),
    );
    const skipped = changed.filter((f) => partial.has(f));
    vscode.window.showInformationMessage(
      changed.length
        ? `Fixed whitespace/EOF in ${changed.length} file(s)${skipped.length ? ` (${skipped.length} partially-staged file(s) fixed but not re-staged)` : ' and re-staged them'}.`
        : 'Nothing to fix.',
    );
    await run(repo, { silent: true });
  });

  reg('tollgate.clearResults', () => {
    for (const repo of repos.values()) {
      repo.reports.clear();
      repo.fire();
    }
  });
}
