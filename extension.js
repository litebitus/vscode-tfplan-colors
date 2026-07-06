const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  ACTION_MARKER,
  scanLine,
  planSymbols,
  foldingRanges,
  resourceAtLine,
  looksLikePlanText,
  isZipMagic,
  timestampPlanName,
  buildRenderError,
  renderedPathFor,
  planPathFrom,
  planSummary,
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

// Plaintext docs that sniff as plans get promoted to the terraform-plan
// language, so language-scoped features (folding-based sticky scroll, word
// wrap, line highlight, breadcrumb defaults) apply — not just the
// content-based ones (colors, symbols).
function promoteIfPlan(doc) {
  if (doc.languageId !== 'plaintext') return;
  if (isPlanDoc(doc)) {
    vscode.languages.setTextDocumentLanguage(doc, 'terraform-plan');
  }
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

// Sidebar "Plan Summary" view: resources grouped by action with colored
// icons (the Outline can't color items), clicking reveals the block in the
// plan. Follows the active plan editor.
const ACTION_ICONS = {
  create:  ['add', 'charts.green'],
  update:  ['edit', 'charts.yellow'],
  destroy: ['remove', 'charts.red'],
  replace: ['arrow-swap', 'charts.purple'],
  read:    ['eye', 'charts.lines'],
  forget:  ['circle-slash', 'charts.lines'],
};

class PlanSummaryProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._summary = null;
    this._groups = [];
    this._uri = null;
    this._doc = null;
    this._docVersion = -1;
  }

  refresh(editor) {
    // drives the view's visibility (`when` clause). With no active editor
    // (focus in panels/trees, or tabs closing) the view only hides when no
    // visible editor holds a plan — so it survives focus changes but goes
    // away when the plan is actually closed.
    if (editor) {
      vscode.commands.executeCommand('setContext', 'tfplanColors.planActive', isPlanDoc(editor.document));
    } else if (!vscode.window.visibleTextEditors.some((e) => isPlanDoc(e.document))) {
      vscode.commands.executeCommand('setContext', 'tfplanColors.planActive', false);
    }
    if (!editor || !isPlanDoc(editor.document)) {
      // keep the last summary while focus is on the tree or other views;
      // it only resets when another plan doc becomes active
      return;
    }
    // skip churn: rebuilding identical content on every editor focus change
    // resets the tree's expansion tracking for nothing. Keyed on the document
    // INSTANCE, not (uri, version): version restarts at 1 for a reopened
    // document, so a file changed on disk between close and reopen would
    // wrongly count as unchanged.
    if (this._doc === editor.document && this._docVersion === editor.document.version) {
      return;
    }
    this._doc = editor.document;
    this._docVersion = editor.document.version;
    const lines = [];
    for (let i = 0; i < editor.document.lineCount; i++) lines.push(editor.document.lineAt(i).text);
    const { summary, groups } = planSummary(lines);
    this._summary = summary;
    this._groups = groups;
    this._uri = editor.document.uri;
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(el) {
    if (!el) {
      const roots = this._groups.map((g) => ({ type: 'group', _id: g.action, ...g }));
      if (this._summary) roots.unshift({ type: 'summaryLine', _id: 'plan-summary-line', ...this._summary });
      return roots;
    }
    // action flows down for the group's color; _id gives every item a
    // stable identity (labels repeat across the tree, which breaks
    // VSCode's label-derived tracking)
    return (el.children || []).map((c) => ({
      ...c,
      action: el.action,
      _id: `${el._id}/${c.name || c.leaf}@${c.line ?? ''}`,
    }));
  }

  getTreeItem(el) {
    if (el.type === 'summaryLine') {
      const item = new vscode.TreeItem(el.text, vscode.TreeItemCollapsibleState.None);
      item.id = el._id;
      item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip = el.text;
      item.command = {
        command: 'vscode.open',
        title: 'Reveal in plan',
        arguments: [this._uri, { selection: new vscode.Range(el.line, 0, el.line, 0) }],
      };
      return item;
    }
    const [icon, color] = ACTION_ICONS[el.action];
    if (el.type === 'group') {
      const item = new vscode.TreeItem(
        `${el.action} (${el.count})`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.id = el._id;
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      return item;
    }
    if (el.type === 'module') {
      const item = new vscode.TreeItem(el.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = el._id;
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      return item;
    }
    const item = new vscode.TreeItem(el.leaf, vscode.TreeItemCollapsibleState.None);
    item.id = el._id;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.tooltip = el.address;
    item.command = {
      command: 'vscode.open',
      title: 'Reveal in plan',
      arguments: [this._uri, { selection: new vscode.Range(el.line, 0, el.line, 0) }],
    };
    return item;
  }
}

class PlanFoldingProvider {
  provideFoldingRanges(doc) {
    if (!isPlanDoc(doc)) return [];
    const lines = [];
    for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
    return foldingRanges(lines).map((r) => new vscode.FoldingRange(r.start, r.end));
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
  if (s.type === 'module') {
    const sym = new vscode.DocumentSymbol(
      s.name,
      '',
      vscode.SymbolKind.Module,
      new vscode.Range(s.startLine, 0, s.endLine, lines[s.endLine].length),
      new vscode.Range(s.startLine, 0, s.startLine, lines[s.startLine].length)
    );
    sym.children = s.children.map((c) => toDocumentSymbol(c, lines));
    return sym;
  }
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

// naming rationale lives with renderedPathFor/planPathFrom in lib.js
function previewUriFor(uri) {
  return uri.with({ scheme: SHOW_SCHEME, path: renderedPathFor(uri.path) });
}

function planPathFor(previewUri) {
  return planPathFrom(previewUri.fsPath);
}

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
    const file = planPathFor(previewUri);
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
    const file = planPathFor(uri);
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
    const previewUri = previewUriFor(uri);
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
    defaultUri: vscode.Uri.file(path.join(path.dirname(planPathFor(editor.document.uri)), timestampPlanName())),
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
  const summaryProvider = new PlanSummaryProvider();
  // createTreeView (vs registerTreeDataProvider) exposes .visible for tests
  const summaryTree = vscode.window.createTreeView('tfplanSummary', { treeDataProvider: summaryProvider });
  const flashType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
  });
  let flashTimer;
  let flashCount = 0; // observability for tests — decorations/focus aren't readable back

  // status bar: full resource address at the cursor — sticky scroll and
  // breadcrumbs truncate deeply nested addresses; this keeps the leaf end
  // visible, the full address in the tooltip, and copies it on click
  const addressItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  addressItem.command = 'tfplanColors.copyResourceAddress';
  let currentAddress = null;
  let addressItemVisible = false; // StatusBarItem has no readable visibility — track for tests

  function updateAddressItem(editor) {
    if (!editor || !isPlanDoc(editor.document)) {
      currentAddress = null;
      addressItemVisible = false;
      addressItem.hide();
      return;
    }
    const lines = [];
    for (let i = 0; i < editor.document.lineCount; i++) lines.push(editor.document.lineAt(i).text);
    const hit = resourceAtLine(lines, editor.selection.active.line);
    if (!hit) {
      currentAddress = null;
      addressItemVisible = false;
      addressItem.hide();
      return;
    }
    currentAddress = hit.address;
    const label = `${ACTION_MARKER[hit.action]} ${hit.address}`;
    const MAX = 60;
    // left-truncate: the leaf module/resource end must stay visible
    addressItem.text = label.length > MAX ? `…${label.slice(label.length - MAX + 1)}` : label;
    addressItem.tooltip = `${hit.address}\n\n${hit.action} — click to copy address`;
    addressItemVisible = true;
    addressItem.show();
  }

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      [{ language: 'terraform-plan' }, { language: 'plaintext' }],
      new PlanSymbolProvider()
    ),
    showProvider,
    summaryTree,
    vscode.commands.registerCommand('tfplanColors.showSummary', () =>
      vscode.commands.executeCommand('tfplanSummary.focus')
    ),
    vscode.languages.registerFoldingRangeProvider({ language: 'terraform-plan' }, new PlanFoldingProvider()),
    vscode.workspace.registerTextDocumentContentProvider(SHOW_SCHEME, showProvider),
    vscode.workspace.onDidOpenTextDocument(promoteIfPlan),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === SHOW_SCHEME) showProvider.unwatch(doc.uri);
    }),
    vscode.window.registerCustomEditorProvider('tfplanColors.binaryPlan', new BinaryPlanEditorProvider(showProvider), {
      supportsMultipleEditorsPerDocument: false,
    }),
    // same provider under 'option' priority: any *tfplan* file can be
    // previewed via "Reopen Editor With…". Auto-open (default priority) is
    // reserved for binary-shaped names (contain tfplan, don't end in .tfplan);
    // *.tfplan is the text-snapshot format — a default-priority claim on it
    // would hijack generic re-opens (e.g. Outline clicks) and drop their
    // selection, leaving navigation dead
    vscode.window.registerCustomEditorProvider('tfplanColors.binaryPlanOptional', new BinaryPlanEditorProvider(showProvider), {
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('tfplanColors.saveRenderedPlan', saveRenderedPlan),
    addressItem,
    vscode.commands.registerCommand('tfplanColors.copyResourceAddress', async () => {
      if (!currentAddress) return;
      await vscode.env.clipboard.writeText(currentAddress);
      vscode.window.setStatusBarMessage(`Copied: ${currentAddress}`, 2000);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => updateAddressItem(e.textEditor)),
    flashType,
    // flash the landing line on programmatic navigation (outline click,
    // go-to-symbol) so the jump target is obvious in a long plan
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // outline clicks arrive with kind undefined (programmatic selection),
      // go-to-symbol with Command — flash both, stay quiet for mouse/keyboard
      if (
        e.kind === vscode.TextEditorSelectionChangeKind.Mouse ||
        e.kind === vscode.TextEditorSelectionChangeKind.Keyboard
      ) return;
      if (!isPlanDoc(e.textEditor.document)) return;
      // navigation targets are a collapsed cursor at column 0; the find
      // widget selects matched text (non-empty, mid-line) — flashing or
      // stealing focus there would break the search flow
      const sel = e.selections[0];
      if (e.selections.length !== 1 || !sel.isEmpty || sel.active.character !== 0) return;
      const line = sel.active.line;
      flashCount++;
      const range = new vscode.Range(line, 0, line, e.textEditor.document.lineAt(line).text.length);
      e.textEditor.setDecorations(flashType, [range]);
      // single-click outline navigation leaves focus in the outline tree;
      // pull it into the editor so the caret is visible at the target
      vscode.window.showTextDocument(e.textEditor.document, {
        viewColumn: e.textEditor.viewColumn,
        preserveFocus: false,
        selection: e.selections[0],
      });
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        if (vscode.window.visibleTextEditors.includes(e.textEditor)) {
          e.textEditor.setDecorations(flashType, []);
        }
      }, 800);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) updateDecorations(editor);
      updateAddressItem(editor);
      summaryProvider.refresh(editor);
    }),
    vscode.window.onDidChangeVisibleTextEditors(updateVisibleEditors),
    vscode.workspace.onDidOpenTextDocument(updateVisibleEditors)
  );

  // Re-decorate on edit, debounced PER DOCUMENT — a shared timer lets
  // chatty documents (output channels, logs) supersede a plan doc's pending
  // update, dropping decoration/summary refreshes entirely
  const changeTimers = new Map();
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      clearTimeout(changeTimers.get(key));
      changeTimers.set(key, setTimeout(() => {
        changeTimers.delete(key);
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === e.document) updateDecorations(editor);
        }
        const active = vscode.window.activeTextEditor;
        if (active && active.document === e.document) summaryProvider.refresh(active);
      }, 200));
    })
  );

  updateVisibleEditors();
  updateAddressItem(vscode.window.activeTextEditor);
  summaryProvider.refresh(vscode.window.activeTextEditor);
  for (const doc of vscode.workspace.textDocuments) promoteIfPlan(doc);

  // integration-test hooks for state the VSCode API can't read back
  return {
    _test: {
      addressItemText: () => addressItem.text,
      addressItemVisible: () => addressItemVisible,
      summaryChildren: (el) => summaryProvider.getChildren(el),
      summaryItem: (el) => summaryProvider.getTreeItem(el),
      summaryViewVisible: () => summaryTree.visible,
      flashCount: () => flashCount,
    },
  };
}

function deactivate() {}

module.exports = { activate, deactivate };
