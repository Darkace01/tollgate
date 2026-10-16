// Smoke test: activates dist/extension.js against a minimal mock of the `vscode` API,
// on a real temporary git repo, and exercises commands + the tree view.
// Run: node test/smoke.js   (after npm run build)
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pcg-smoke-'));
const sh = (c) => execSync(c, { cwd: repo, stdio: 'pipe' }).toString();
sh('git init -q -b feature/smoke && git config user.email a@b.c && git config user.name T');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"' } }));
fs.writeFileSync(path.join(repo, 'a.js'), "console.log('x');\nconst k = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n");
sh('git add .');

const settings = {}; // key -> value (workspace)
const commands = new Map();
const messages = [];
const treeProviders = new Map();
const diagnosticsSet = new Map();
class EventEmitter {
  constructor() {
    this.l = [];
    this.event = (fn) => {
      this.l.push(fn);
      return { dispose() {} };
    };
  }
  fire(v) {
    for (const f of this.l) f(v);
  }
  dispose() {}
}
const configListeners = [];
class Uri {
  constructor(p) {
    this.fsPath = p;
    this.path = p;
  }
  static file(p) {
    return new Uri(p);
  }
}
const vscode = {
  EventEmitter,
  Uri,
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(v = '') {
      this.value = v;
    }
    appendMarkdown(s) {
      this.value += s;
      return this;
    }
    appendCodeblock(s) {
      this.value += `\n${s}\n`;
      return this;
    }
  },
  Range: class {
    constructor(a, b, c, d) {
      Object.assign(this, { a, b, c, d });
    }
  },
  Diagnostic: class {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 15, Window: 10 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  QuickPickItemKind: { Separator: -1 },
  CancellationTokenSource: class {
    constructor() {
      this.e = new EventEmitter();
      this.token = { onCancellationRequested: this.e.event };
    }
    cancel() {
      this.e.fire();
    }
    dispose() {}
  },
  RelativePattern: class {
    constructor(b, p) {
      Object.assign(this, { b, p });
    }
  },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => process.env.VERBOSE && console.log('  [out]', l), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerTreeDataProvider: (id, p) => {
      treeProviders.set(id, p);
      return { dispose() {} };
    },
    withProgress: (_o, fn) => fn({ report() {} }, { onCancellationRequested() {} }),
    showInformationMessage: async (m) => {
      messages.push(['info', m]);
      return undefined;
    },
    showWarningMessage: async (m) => {
      messages.push(['warn', m]);
      return undefined;
    },
    showErrorMessage: async (m) => {
      messages.push(['error', m]);
      return undefined;
    },
    setStatusBarMessage: (m) => messages.push(['status', m]),
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => undefined,
    activeTextEditor: undefined,
  },
  languages: {
    createDiagnosticCollection: () => ({
      clear: () => diagnosticsSet.clear(),
      set: (u, d) => diagnosticsSet.set(u.fsPath, d),
      dispose() {},
    }),
  },
  commands: {
    registerCommand: (id, fn) => {
      commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: async (id, ...a) => (commands.has(id) ? commands.get(id)(...a) : undefined),
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(repo), name: 'smoke', index: 0 }],
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidChangeConfiguration: (fn) => {
      configListeners.push(fn);
      return { dispose() {} };
    },
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    getConfiguration: () => ({
      get: (k, d) => (k in settings ? settings[k] : (defaults[k] ?? d)),
      inspect: (k) => ({ workspaceValue: settings[k] }),
      update: async (k, v) => {
        settings[k] = v;
        for (const fn of configListeners) await fn({ affectsConfiguration: (s) => s === 'precommitGuard' || s === `precommitGuard.${k}` });
      },
    }),
    openTextDocument: async () => ({}),
    saveAll: async () => true,
  },
};
const pkg = require(path.join(root, 'package.json'));
const defaults = Object.fromEntries(Object.entries(pkg.contributes.configuration.properties).map(([k, v]) => [k.replace('precommitGuard.', ''), v.default]));
defaults.autoInstallHooks = 'always';

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest);
};

(async () => {
  const ext = require(path.join(root, 'dist', 'extension.js'));
  const state = new Map();
  const context = {
    subscriptions: [],
    extension: { packageJSON: pkg, id: '10star.precommit-guard' },
    asAbsolutePath: (p) => path.join(root, p),
    workspaceState: { get: (k) => state.get(k), update: async (k, v) => state.set(k, v) },
  };
  await ext.activate(context);

  // Every contributed command is registered.
  for (const c of pkg.contributes.commands) assert.ok(commands.has(c.command), `command not registered: ${c.command}`);
  console.log(`✔ ${pkg.contributes.commands.length} commands registered`);

  // autoInstallHooks=always installed the hooks.
  assert.ok(fs.readFileSync(path.join(repo, '.git/hooks/pre-commit'), 'utf8').includes('precommit-guard-managed'));
  assert.ok(fs.existsSync(path.join(repo, '.git/precommit-guard/runner.js')));
  assert.ok(fs.existsSync(path.join(repo, '.git/precommit-guard/vscode-settings.json')));
  console.log('✔ hooks + runner installed on activation');

  // Run checks from the UI.
  await commands.get('precommitGuard.run')();
  const tree = treeProviders.get('precommitGuard.results');
  const top = await tree.getChildren();
  const pre = top.find((n) => n.type === 'stage' && n.stage === 'pre-commit');
  assert.ok(pre, 'pre-commit stage node');
  const checks = await tree.getChildren(pre);
  const secrets = checks.find((n) => n.id === 'secrets');
  assert.equal(secrets.result.status, 'failed');
  const items = checks.map((n) => tree.getTreeItem(n));
  assert.ok(items.every((i) => i.label));
  const kids = await tree.getChildren(secrets);
  assert.equal(kids[0].type, 'finding');
  assert.ok(tree.getTreeItem(kids[0]).command, 'finding opens file');
  assert.ok(diagnosticsSet.get(path.join(repo, 'a.js')).length >= 2, 'diagnostics published');
  assert.ok(messages.some(([t, m]) => t === 'error' && /failed/.test(m)));
  console.log(`✔ run → ${checks.length} tree checks, secrets failed with ${kids.length} finding(s), diagnostics published`);

  // Toggle a disabled check on via the tree.
  const todo = checks.find((n) => n.id === 'todoComments');
  assert.equal(todo.enabled, false);
  await commands.get('precommitGuard.enableCheck')(todo);
  assert.equal(settings.checks.todoComments.enabled, true);
  const snap = JSON.parse(fs.readFileSync(path.join(repo, '.git/precommit-guard/vscode-settings.json'), 'utf8'));
  assert.equal(snap.checks.todoComments.enabled, true, 'settings snapshot synced for git hook');
  console.log('✔ enable check via tree → workspace settings + hook snapshot updated');

  // Hook commit from the "terminal" picks up VS Code settings and the UI reloads the report.
  settings.checks = { ...settings.checks, secrets: { enabled: false } };
  for (const fn of configListeners) await fn({ affectsConfiguration: (s) => s === 'precommitGuard' || s === 'precommitGuard.checks' });
  let out = '';
  try {
    out = execSync('git commit -m "chore: smoke test commit"', { cwd: repo, stdio: 'pipe' }).toString();
  } catch (e) {
    out = e.stdout.toString() + e.stderr.toString();
    throw new Error(`commit failed:\n${out}`);
  }
  console.log('✔ terminal commit passes with secrets disabled via VS Code settings');

  // Create config + resolved config + pause.
  await commands.get('precommitGuard.createConfig')();
  assert.ok(fs.existsSync(path.join(repo, '.precommitrc.json')));
  await commands.get('precommitGuard.togglePause')();
  assert.equal(settings.enabled, false);
  await commands.get('precommitGuard.uninstallHooks')();
  assert.ok(!fs.existsSync(path.join(repo, '.git/hooks/pre-commit')));
  console.log('✔ createConfig, pause, uninstall');

  ext.deactivate();
  console.log('SMOKE OK');
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE FAILED', e);
  process.exit(1);
});
