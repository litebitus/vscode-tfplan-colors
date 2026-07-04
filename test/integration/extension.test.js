const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const fixtures = path.resolve(__dirname, '..', 'fixtures');

async function openDoc(name) {
  const doc = await vscode.workspace.openTextDocument(path.join(fixtures, name));
  await vscode.window.showTextDocument(doc);
  return doc;
}

async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite('language association', () => {
  test('.tfplan files get the terraform-plan language', async () => {
    const doc = await openDoc('sample.tfplan');
    assert.strictEqual(doc.languageId, 'terraform-plan');
  });

  test('plan-looking plaintext is promoted to terraform-plan', async () => {
    await openDoc('promoted-plan.txt');
    await waitFor(() =>
      vscode.workspace.textDocuments.some(
        (d) => d.fileName.endsWith('promoted-plan.txt') && d.languageId === 'terraform-plan'
      )
    );
  });

  test('unrelated plaintext stays plaintext', async () => {
    const doc = await openDoc('not-a-plan.txt');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(doc.languageId, 'plaintext');
  });
});

suite('document symbols', () => {
  test('module-nested tree with resources, outputs, and summary', async () => {
    const doc = await openDoc('sample.tfplan');
    const symbols = await waitFor(async () => {
      const s = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
      return s && s.length ? s : null;
    });

    const mod = symbols.find((s) => s.name === 'module.app');
    assert.ok(mod, 'module.app node exists');
    assert.strictEqual(mod.kind, vscode.SymbolKind.Module);
    assert.deepStrictEqual(mod.children.map((c) => c.name), ['<= data.aws_ami.base']);

    assert.ok(symbols.some((s) => s.name === '+ aws_instance.web'));
    assert.ok(symbols.some((s) => s.name === '-/+ aws_security_group.sg'));
    assert.ok(symbols.some((s) => s.name === '. aws_kms_alias.k'));

    const outputs = symbols.find((s) => s.name === 'Changes to Outputs');
    assert.ok(outputs, 'outputs section exists');
    assert.strictEqual(outputs.children.length, 3);

    assert.ok(symbols.some((s) => s.name.startsWith('Plan: ')));
  });

  test('resource symbol navigates to its header line', async () => {
    const doc = await openDoc('sample.tfplan');
    const symbols = await waitFor(async () => {
      const s = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
      return s && s.length ? s : null;
    });
    const web = symbols.find((s) => s.name === '+ aws_instance.web');
    assert.strictEqual(web.selectionRange.start.line, 15);
    assert.strictEqual(web.range.end.line, 18);
  });
});

suite('folding', () => {
  test('resource blocks fold from their header line', async () => {
    const doc = await openDoc('sample.tfplan');
    const ranges = await waitFor(async () => {
      const r = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri);
      return r && r.length ? r : null;
    });
    const has = (start, end) => ranges.some((r) => r.start === start && r.end === end);
    assert.ok(has(9, 13), 'read block folds from header');
    assert.ok(has(25, 31), 'replace block folds from header');
    assert.ok(has(26, 31), 'resource body line folds (second sticky level)');
    assert.ok(has(43, 46), 'outputs section folds');
    assert.equal(ranges.some((r) => r.start === 7), false, 'no top-level umbrella region');
  });
});

suite('editor defaults', () => {
  test('terraform-plan documents get the contributed defaults', async () => {
    const doc = await openDoc('sample.tfplan');
    const cfg = vscode.workspace.getConfiguration('editor', { uri: doc.uri, languageId: 'terraform-plan' });
    assert.strictEqual(cfg.get('wordWrap'), 'on');
    assert.strictEqual(cfg.get('stickyScroll.defaultModel'), 'foldingProviderModel');
    assert.strictEqual(cfg.get('renderLineHighlight'), 'all');
    const crumbs = vscode.workspace.getConfiguration('breadcrumbs', { uri: doc.uri, languageId: 'terraform-plan' });
    assert.strictEqual(crumbs.get('filePath'), 'last');
  });
});

suite('navigation resolution', () => {
  test('generic open with a selection lands on the requested line', async () => {
    // exercises the editor-resolver path that outline clicks use — a
    // default-priority custom editor claiming text plans would swallow
    // the selection here (the original navigation bug)
    const uri = vscode.Uri.file(path.join(fixtures, 'sample.tfplan'));
    await vscode.commands.executeCommand('vscode.open', uri, {
      selection: new vscode.Range(20, 0, 20, 0),
    });
    await waitFor(() => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.uri.fsPath === uri.fsPath && e.selection.active.line === 20;
    });
  });
});

suite('status bar address item', () => {
  async function testApi() {
    const ext = vscode.extensions.getExtension('lite2073.tfplan-colors');
    await ext.activate();
    return ext.exports._test;
  }

  test('shows inside a resource block, hides outside', async () => {
    const api = await testApi();
    const doc = await openDoc('sample.tfplan');
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(29, 0, 29, 0); // inside the sg block
    await waitFor(() => api.addressItemVisible() && api.addressItemText().includes('aws_security_group.sg'));
    editor.selection = new vscode.Selection(1, 0, 1, 0); // legend
    await waitFor(() => !api.addressItemVisible());
  });

  test('long addresses left-truncate with … keeping the leaf visible', async () => {
    const api = await testApi();
    const doc = await openDoc('long-address.tfplan');
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(4, 0, 4, 0);
    await waitFor(() => api.addressItemVisible() && api.addressItemText().includes('aws_appautoscaling_target'));
    const text = api.addressItemText();
    assert.ok(text.startsWith('…'), `expected leading …, got: ${text}`);
    assert.ok(text.endsWith('aws_appautoscaling_target.this'), `leaf missing: ${text}`);
  });
});

suite('plan summary view', () => {
  async function testApi() {
    const ext = vscode.extensions.getExtension('lite2073.tfplan-colors');
    await ext.activate();
    return ext.exports._test;
  }

  test('groups resources by action in severity order', async () => {
    const api = await testApi();
    await openDoc('sample.tfplan');
    const groups = await waitFor(async () => {
      const g = await api.summaryChildren();
      return g.length === 6 ? g : null;
    });
    assert.deepStrictEqual(
      groups.map((g) => g.action),
      ['replace', 'destroy', 'create', 'update', 'read', 'forget']
    );
    const item = api.summaryItem(groups[0]);
    assert.strictEqual(item.label, 'replace (1)');
    assert.strictEqual(item.iconPath.id, 'arrow-swap');
  });

  test('resource items reveal their block in the plan', async () => {
    const api = await testApi();
    await openDoc('sample.tfplan');
    const groups = await waitFor(async () => {
      const g = await api.summaryChildren();
      return g.length === 6 ? g : null;
    });
    const [resource] = api.summaryChildren(groups[0]);
    const item = api.summaryItem(resource);
    assert.strictEqual(item.label, 'aws_security_group.sg');
    assert.strictEqual(item.command.command, 'vscode.open');
    assert.strictEqual(item.command.arguments[1].selection.start.line, 25);
  });

  test('Summarize command makes the view visible', async () => {
    const api = await testApi();
    await openDoc('sample.tfplan');
    await vscode.commands.executeCommand('tfplanColors.showSummary');
    await waitFor(() => api.summaryViewVisible());
  });
});

suite('resource address command', () => {
  test('copies the enclosing resource address at the cursor', async () => {
    const doc = await openDoc('sample.tfplan');
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(29, 0, 29, 0); // inside the sg block
    await new Promise((r) => setTimeout(r, 300));
    await vscode.commands.executeCommand('tfplanColors.copyResourceAddress');
    const clip = await vscode.env.clipboard.readText();
    assert.strictEqual(clip, 'aws_security_group.sg');
  });

  test('command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('tfplanColors.copyResourceAddress'));
    assert.ok(commands.includes('tfplanColors.saveRenderedPlan'));
  });
});
