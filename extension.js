const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  scanLine,
  planSymbols,
  looksLikePlanText,
  isZipMagic,
  timestampPlanName,
  buildRenderError,
} = require('./lib');

// Action colors — chosen to be readable on both dark and light themes.
// replace uses magenta: the common convention for destroy-then-create.
const COLORS = {
  create:  '#3FB950',
  update:  '#D29922',
  destroy: '#F85149',
  replace: '#DB61A2',
  read:    '#8B949E',
  forget:  '#8B949E',
};

function gutterIcon(color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
    `<rect x="2" y="1" width="4" height="14" rx="1" fill="${color}"/></svg>`;
  return vscode.Uri.parse(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  );
}

let lineTypes = {};      // action -> whole-line decoration (color + gutter + ruler)
let headerTypes = {};    // action -> bold header decoration
let forcesType;          // "# forces replacement" inline highlight

function createDecorationTypes(context) {
  for (const [action, color] of Object.entries(COLORS)) {
    lineTypes[action] = vscode.window.createTextEditorDecorationType({
      color,
      fontStyle: action === 'forget' ? 'italic' : undefined,
      gutterIconPath: gutterIcon(color),
      gutterIconSize: 'contain',
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      isWholeLine: true,
    });
    headerTypes[action] = vscode.window.createTextEditorDecorationType({
      color,
      fontWeight: 'bold',
      gutterIconPath: gutterIcon(color),
      gutterIconSize: 'contain',
      isWholeLine: true,
    });
    context.subscriptions.push(lineTypes[action], headerTypes[action]);
  }
  forcesType = vscode.window.createTextEditorDecorationType({
    color: COLORS.destroy,
    fontWeight: 'bold',
  });
  context.subscriptions.push(forcesType);
}

function isPlanDoc(doc) {
  if (doc.languageId === 'terraform-plan') return true;
  if (doc.languageId !== 'plaintext') return false;
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 15), 0));
  return looksLikePlanText(head);
}

function updateDecorations(editor) {
  const doc = editor.document;
  const lineBuckets = {};
  const headerBuckets = {};
  const forces = [];
  for (const action of Object.keys(COLORS)) {
    lineBuckets[action] = [];
    headerBuckets[action] = [];
  }

  if (isPlanDoc(doc)) {
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      const s = scanLine(text);
      if (!s) continue;
      const range = new vscode.Range(i, 0, i, text.length);
      if (s.kind === 'header') {
        headerBuckets[s.action].push(range);
      } else {
        lineBuckets[s.action].push(range);
        if (s.forcesIndex >= 0) {
          forces.push(new vscode.Range(i, s.forcesIndex, i, text.length));
        }
      }
    }
  }

  for (const action of Object.keys(COLORS)) {
    editor.setDecorations(lineTypes[action], lineBuckets[action]);
    editor.setDecorations(headerTypes[action], headerBuckets[action]);
  }
  editor.setDecorations(forcesType, forces);
}

function updateVisibleEditors() {
  for (const editor of vscode.window.visibleTextEditors) {
    updateDecorations(editor);
  }
}

class PlanSymbolProvider {
  provideDocumentSymbols(doc) {
    if (!isPlanDoc(doc)) return [];
    const lines = [];
    for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
    return planSymbols(lines).map((s) => toDocumentSymbol(s, lines));
  }
}

function toDocumentSymbol(s, lines) {
  if (s.type === 'resource') {
    return new vscode.DocumentSymbol(
      s.name,
      s.detail,
      SYMBOL_KINDS[s.action],
      new vscode.Range(s.startLine, 0, s.endLine, lines[s.endLine].length),
      new vscode.Range(s.startLine, 0, s.startLine, lines[s.startLine].length)
    );
  }
  if (s.type === 'outputs') {
    const sym = new vscode.DocumentSymbol(
      s.name,
      '',
      vscode.SymbolKind.Namespace,
      new vscode.Range(s.startLine, 0, s.endLine, lines[s.endLine].length),
      new vscode.Range(s.startLine, 0, s.startLine, lines[s.startLine].length)
    );
    sym.children = s.children.map((c) => {
      const r = new vscode.Range(c.line, 0, c.line, lines[c.line].length);
      return new vscode.DocumentSymbol(c.name, 'output', vscode.SymbolKind.Variable, r, r);
    });
    return sym;
  }
  const r = new vscode.Range(s.line, 0, s.line, lines[s.line].length);
  return new vscode.DocumentSymbol(s.name, '', vscode.SymbolKind.Event, r, r);
}

// --- binary plan preview -----------------------------------------------
// *tfplan* files are claimed by a custom editor so the open can be routed
// by content: text plans bounce back to the regular text editor; binary
// plans (terraform's plan format is a zip — "PK" magic) are rendered via
// `terraform show -no-color` into a readonly virtual doc that gets the
// terraform-plan language and therefore all the coloring above.

const SHOW_SCHEME = 'tfplan-show';

let logChannel;
function log(msg) {
  if (!logChannel) logChannel = vscode.window.createOutputChannel('Terraform Plan Colors');
  logChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function isBinaryPlan(fsPath) {
  const buf = Buffer.alloc(2);
  const fd = fs.openSync(fsPath, 'r');
  try {
    fs.readSync(fd, buf, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  return isZipMagic(buf);
}

class PlanShowProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
    this._watchers = new Map(); // preview uri string -> disposable
  }

  // Auto-refresh: watch the binary plan while its preview is open and
  // re-render when the file changes (e.g. terraform plan -out=... reruns).
  // Uses VSCode's watcher (not Node fs.watch: macOS directory watching
  // misses in-place rewrites); the debounce lets writes settle before
  // terraform show runs again.
  watch(previewUri) {
    const key = previewUri.toString();
    if (this._watchers.has(key)) return;
    const file = previewUri.fsPath;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file))
    );
    log(`watch attached: ${file}`);
    let timer;
    const refresh = (kind) => {
      log(`watcher event (${kind}): ${file}`);
      clearTimeout(timer);
      timer = setTimeout(() => {
        log(`firing onDidChange: ${previewUri.toString()}`);
        this._onDidChange.fire(previewUri);
      }, 500);
    };
    watcher.onDidChange(() => refresh('change'));
    watcher.onDidCreate(() => refresh('create'));
    watcher.onDidDelete(() => refresh('delete'));
    this._watchers.set(key, {
      dispose: () => {
        clearTimeout(timer);
        watcher.dispose();
      },
    });
  }

  refresh(previewUri) {
    log(`explicit refresh: ${previewUri.toString()}`);
    this._onDidChange.fire(previewUri);
  }

  unwatch(previewUri) {
    const key = previewUri.toString();
    const w = this._watchers.get(key);
    if (w) {
      w.dispose();
      this._watchers.delete(key);
    }
  }

  dispose() {
    for (const w of this._watchers.values()) w.dispose();
    this._watchers.clear();
    this._onDidChange.dispose();
  }

  provideTextDocumentContent(uri) {
    // attach here, not on open events: this runs for every render,
    // including tabs restored on window reload where no open event fires
    this.watch(uri);
    const file = uri.fsPath;
    log(`render requested: ${file}`);
    return new Promise((resolve) => {
      // cwd must be the plan's stack folder: terraform show needs the
      // initialized working directory (.terraform provider schemas)
      cp.execFile(
        'terraform',
        ['show', '-no-color', file],
        { cwd: path.dirname(file), maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          log(`terraform show done: ${file} — ${err ? 'ERROR' : `${stdout.length} bytes`}`);
          resolve(err ? buildRenderError(stderr, err.message) : stdout);
        }
      );
    });
  }
}

class BinaryPlanEditorProvider {
  constructor(showProvider) {
    this.showProvider = showProvider;
  }

  async openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document, panel) {
    const uri = document.uri;
    let binary = false;
    try {
      binary = isBinaryPlan(uri.fsPath);
    } catch {
      // unreadable/virtual — fall through to the text editor
    }
    const viewColumn = panel.viewColumn ?? vscode.ViewColumn.Active;
    if (!binary) {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', viewColumn);
      panel.dispose();
      return;
    }
    panel.webview.html = '<html><body>Rendering plan with terraform show…</body></html>';
    const previewUri = uri.with({ scheme: SHOW_SCHEME });
    // VSCode caches closed virtual docs; if one is being revived, its content
    // is stale (the plan may have changed while unwatched) — force a re-render
    const cached = vscode.workspace.textDocuments.some(
      (d) => d.uri.toString() === previewUri.toString()
    );
    log(`custom editor resolve: ${uri.fsPath} (binary, cached doc: ${cached})`);
    const doc = await vscode.workspace.openTextDocument(previewUri);
    if (cached) this.showProvider.refresh(previewUri);
    await vscode.languages.setTextDocumentLanguage(doc, 'terraform-plan');
    await vscode.window.showTextDocument(doc, { viewColumn });
    panel.dispose();
  }
}

async function saveRenderedPlan() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== SHOW_SCHEME) {
    vscode.window.showWarningMessage('No rendered terraform plan is active.');
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(editor.document.uri.fsPath), timestampPlanName())),
    filters: { 'Terraform Plan': ['tfplan'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(editor.document.getText(), 'utf8'));
  await vscode.window.showTextDocument(target);
}

const SYMBOL_KINDS = {
  create:  vscode.SymbolKind.Constructor,
  update:  vscode.SymbolKind.Field,
  destroy: vscode.SymbolKind.Null,
  replace: vscode.SymbolKind.Class,
  read:    vscode.SymbolKind.Interface,
  forget:  vscode.SymbolKind.Constant,
};

function activate(context) {
  log('extension activated');
  createDecorationTypes(context);
  const showProvider = new PlanShowProvider();

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      [{ language: 'terraform-plan' }, { language: 'plaintext' }],
      new PlanSymbolProvider()
    ),
    showProvider,
    vscode.workspace.registerTextDocumentContentProvider(SHOW_SCHEME, showProvider),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SHOW_SCHEME) showProvider.unwatch(doc.uri);
    }),
    vscode.window.registerCustomEditorProvider('tfplanColors.binaryPlan', new BinaryPlanEditorProvider(showProvider), {
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('tfplanColors.saveRenderedPlan', saveRenderedPlan),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateDecorations(editor);
    }),
    vscode.window.onDidChangeVisibleTextEditors(updateVisibleEditors),
    vscode.workspace.onDidOpenTextDocument(updateVisibleEditors)
  );

  // Re-decorate on edit, debounced.
  let timer;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === e.document) updateDecorations(editor);
        }
      }, 200);
    })
  );

  updateVisibleEditors();
}

function deactivate() {}

module.exports = { activate, deactivate };
