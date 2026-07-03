const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

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

const ACTION_MARKER = {
  create:  '+',
  update:  '~',
  destroy: '-',
  replace: '-/+',
  read:    '<=',
  forget:  '.',
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

// Resource header, e.g.:
//   # module.a.aws_x.y will be created
//   # aws_x.y must be replaced
//  # module.a.aws_x.y will no longer be managed by Terraform, ...
const HEADER_RE = /^\s{0,3}# ([a-zA-Z][\w."'()\[\]/ -]*?) (will|must|is|has) (.+)$/;

function headerAction(rest) {
  if (rest.includes('be created')) return 'create';
  if (rest.includes('be destroyed')) return 'destroy';
  if (rest.includes('be updated')) return 'update';
  if (rest.includes('be replaced')) return 'replace';
  if (rest.includes('be read')) return 'read';
  if (rest.includes('no longer be managed')) return 'forget';
  return null;
}

// Diff marker at the start of a line (any indentation).
function classifyLine(text) {
  if (/^\s*-\/\+/.test(text)) return 'replace';
  if (/^\s*\+\/-/.test(text)) return 'replace'; // create_before_destroy
  if (/^\s*<=/.test(text)) return 'read';
  const m = text.match(/^\s*([+~.-])\s/);
  if (!m) return null;
  switch (m[1]) {
    case '+': return 'create';
    case '-': return 'destroy';
    case '~': return 'update';
    case '.': return 'forget';
  }
  return null;
}

function isPlanDoc(doc) {
  if (doc.languageId === 'terraform-plan') return true;
  if (doc.languageId !== 'plaintext') return false;
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 15), 0));
  return /^Terraform (used the selected providers|will perform|planned the following)/m.test(head) ||
         /Resource actions are\s*$/m.test(head) ||
         /indicated with the following symbols/.test(head);
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
      const range = new vscode.Range(i, 0, i, text.length);

      const h = text.match(HEADER_RE);
      if (h) {
        const action = headerAction(h[3]);
        if (action) {
          headerBuckets[action].push(range);
          continue;
        }
      }

      const action = classifyLine(text);
      if (action) {
        lineBuckets[action].push(range);
        const f = text.indexOf('# forces replacement');
        if (f >= 0) {
          forces.push(new vscode.Range(i, f, i, text.length));
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
    const symbols = [];
    const headers = []; // { line, address, action }

    let outputsLine = -1;
    let planLine = -1;
    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;
      const h = text.match(HEADER_RE);
      if (h) {
        const action = headerAction(h[3]);
        if (action) headers.push({ line: i, address: h[1], action });
        continue;
      }
      if (/^Changes to Outputs:/.test(text)) outputsLine = i;
      if (/^Plan: /.test(text)) planLine = i;
    }

    for (let k = 0; k < headers.length; k++) {
      const { line, address, action } = headers[k];
      let end = k + 1 < headers.length ? headers[k + 1].line - 1 : doc.lineCount - 1;
      if (outputsLine > line && (k + 1 >= headers.length || outputsLine < headers[k + 1].line)) {
        end = outputsLine - 1;
      }
      while (end > line && doc.lineAt(end).text.trim() === '') end--;
      const range = new vscode.Range(line, 0, end, doc.lineAt(end).text.length);
      symbols.push(new vscode.DocumentSymbol(
        `${ACTION_MARKER[action]} ${address}`,
        action,
        SYMBOL_KINDS[action],
        range,
        new vscode.Range(line, 0, line, doc.lineAt(line).text.length)
      ));
    }

    if (outputsLine >= 0) {
      let end = planLine > outputsLine ? planLine - 1 : doc.lineCount - 1;
      while (end > outputsLine && doc.lineAt(end).text.trim() === '') end--;
      const outputsSym = new vscode.DocumentSymbol(
        'Changes to Outputs',
        '',
        vscode.SymbolKind.Namespace,
        new vscode.Range(outputsLine, 0, end, doc.lineAt(end).text.length),
        new vscode.Range(outputsLine, 0, outputsLine, doc.lineAt(outputsLine).text.length)
      );
      for (let i = outputsLine + 1; i <= end; i++) {
        const text = doc.lineAt(i).text;
        const m = text.match(/^\s{0,3}([+~-]|-\/\+)\s+(\w+)\s+=/);
        if (m) {
          const lineRange = new vscode.Range(i, 0, i, text.length);
          outputsSym.children.push(new vscode.DocumentSymbol(
            `${m[1]} ${m[2]}`,
            'output',
            vscode.SymbolKind.Variable,
            lineRange,
            lineRange
          ));
        }
      }
      symbols.push(outputsSym);
    }

    if (planLine >= 0) {
      const text = doc.lineAt(planLine).text;
      const lineRange = new vscode.Range(planLine, 0, planLine, text.length);
      symbols.push(new vscode.DocumentSymbol(
        text.trim(),
        '',
        vscode.SymbolKind.Event,
        lineRange,
        lineRange
      ));
    }

    return symbols;
  }
}

// --- binary plan preview -----------------------------------------------
// *tfplan* files are claimed by a custom editor so the open can be routed
// by content: text plans bounce back to the regular text editor; binary
// plans (terraform's plan format is a zip — "PK" magic) are rendered via
// `terraform show -no-color` into a readonly virtual doc that gets the
// terraform-plan language and therefore all the coloring above.

const SHOW_SCHEME = 'tfplan-show';

function isBinaryPlan(fsPath) {
  const buf = Buffer.alloc(2);
  const fd = fs.openSync(fsPath, 'r');
  try {
    fs.readSync(fd, buf, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf[0] === 0x50 && buf[1] === 0x4b;
}

class PlanShowProvider {
  provideTextDocumentContent(uri) {
    const file = uri.fsPath;
    return new Promise((resolve) => {
      // cwd must be the plan's stack folder: terraform show needs the
      // initialized working directory (.terraform provider schemas)
      cp.execFile(
        'terraform',
        ['show', '-no-color', file],
        { cwd: path.dirname(file), maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(stdout);
            return;
          }
          const hint = (stderr || '').includes('Failed to load plugin schemas')
            ? 'Hint: the plan file is probably not inside its stack folder — the preview runs\n' +
              'terraform show in the file\'s directory, which must be terraform-initialized\n' +
              '(.terraform/ present with matching providers).\n\n'
            : '';
          resolve(`Failed to render plan with 'terraform show':\n\n${hint}${stderr || err.message}`);
        }
      );
    });
  }
}

class BinaryPlanEditorProvider {
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
    const doc = await vscode.workspace.openTextDocument(uri.with({ scheme: SHOW_SCHEME }));
    await vscode.languages.setTextDocumentLanguage(doc, 'terraform-plan');
    await vscode.window.showTextDocument(doc, { viewColumn });
    panel.dispose();
  }
}

// Default filename for saved renders, matching the dated snapshot
// convention: 2026.5.14.2235.tfplan (month/day unpadded, HHmm padded).
function timestampPlanName() {
  const d = new Date();
  const hhmm = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}.${hhmm}.tfplan`;
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
  createDecorationTypes(context);

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      [{ language: 'terraform-plan' }, { language: 'plaintext' }],
      new PlanSymbolProvider()
    ),
    vscode.workspace.registerTextDocumentContentProvider(SHOW_SCHEME, new PlanShowProvider()),
    vscode.window.registerCustomEditorProvider('tfplanColors.binaryPlan', new BinaryPlanEditorProvider(), {
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
