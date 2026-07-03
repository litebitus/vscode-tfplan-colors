// Pure plan-parsing logic — no vscode imports so it is unit-testable with
// `node --test` (see test/). extension.js maps these results onto the
// VSCode API (decorations, document symbols, editors).

const ACTION_MARKER = {
  create:  '+',
  update:  '~',
  destroy: '-',
  replace: '-/+',
  read:    '<=',
  forget:  '.',
};

// Resource header, e.g.:
//   # module.a.aws_x.y will be created
//   # aws_x.y must be replaced
//  # module.a.aws_x.y will no longer be managed by Terraform, ...
const HEADER_RE = /^\s{0,3}# ([a-zA-Z][\w."'()\[\]/ -]*?) (will|must|is|has) (.+)$/;

function headerAction(rest) {
  // forget first: its phrasing ("...but will not be destroyed") would
  // otherwise be caught by the 'be destroyed' check
  if (rest.includes('no longer be managed')) return 'forget';
  if (rest.includes('be created')) return 'create';
  if (rest.includes('be destroyed')) return 'destroy';
  if (rest.includes('be updated')) return 'update';
  if (rest.includes('be replaced')) return 'replace';
  if (rest.includes('be read')) return 'read';
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

// Classify one line for decoration: a bold resource header, a colored diff
// line (with optional "# forces replacement" highlight offset), or null.
function scanLine(text) {
  const h = text.match(HEADER_RE);
  if (h) {
    const action = headerAction(h[3]);
    if (action) return { kind: 'header', action };
  }
  const action = classifyLine(text);
  if (!action) return null;
  return { kind: 'diff', action, forcesIndex: text.indexOf('# forces replacement') };
}

// Content sniff for plain .txt files that hold terraform plan output.
function looksLikePlanText(head) {
  return /^Terraform (used the selected providers|will perform|planned the following)/m.test(head) ||
         /Resource actions are\s*$/m.test(head) ||
         /indicated with the following symbols/.test(head);
}

// Binary terraform plans are zip archives.
function isZipMagic(buf) {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

// Default filename for saved renders, matching the dated snapshot
// convention: 2026.5.14.2235.tfplan (month/day unpadded, HHmm padded).
function timestampPlanName(d = new Date()) {
  const hhmm = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}.${hhmm}.tfplan`;
}

// Error text shown in the preview when terraform show fails.
function buildRenderError(stderr, fallbackMessage) {
  const hint = (stderr || '').includes('Failed to load plugin schemas')
    ? 'Hint: the plan file is probably not inside its stack folder — the preview runs\n' +
      'terraform show in the file\'s directory, which must be terraform-initialized\n' +
      '(.terraform/ present with matching providers).\n\n'
    : '';
  return `Failed to render plan with 'terraform show':\n\n${hint}${stderr || fallbackMessage}`;
}

// Scan all lines into the plan's structure: resource headers, the outputs
// section, and the summary line.
function parsePlanStructure(lines) {
  const headers = []; // { line, address, action }
  let outputsLine = -1;
  let planLine = -1;
  lines.forEach((text, i) => {
    const h = text.match(HEADER_RE);
    if (h) {
      const action = headerAction(h[3]);
      if (action) headers.push({ line: i, address: h[1], action });
      return;
    }
    if (/^Changes to Outputs:/.test(text)) outputsLine = i;
    if (/^Plan: /.test(text)) planLine = i;
  });
  return { headers, outputsLine, planLine };
}

const OUTPUT_LINE_RE = /^\s{0,3}([+~-]|-\/\+)\s+(\w+)\s+=/;

// Build document-symbol descriptors: resource blocks (range spans the block,
// trailing blanks trimmed), the outputs section with one child per output,
// and the "Plan: N to add..." summary.
function planSymbols(lines) {
  const { headers, outputsLine, planLine } = parsePlanStructure(lines);
  const symbols = [];

  for (let k = 0; k < headers.length; k++) {
    const { line, address, action } = headers[k];
    let end = k + 1 < headers.length ? headers[k + 1].line - 1 : lines.length - 1;
    if (outputsLine > line && (k + 1 >= headers.length || outputsLine < headers[k + 1].line)) {
      end = outputsLine - 1;
    }
    while (end > line && lines[end].trim() === '') end--;
    symbols.push({
      type: 'resource',
      name: `${ACTION_MARKER[action]} ${address}`,
      detail: action,
      action,
      startLine: line,
      endLine: end,
    });
  }

  if (outputsLine >= 0) {
    let end = planLine > outputsLine ? planLine - 1 : lines.length - 1;
    while (end > outputsLine && lines[end].trim() === '') end--;
    const children = [];
    for (let i = outputsLine + 1; i <= end; i++) {
      const m = lines[i].match(OUTPUT_LINE_RE);
      if (m) children.push({ type: 'output', name: `${m[1]} ${m[2]}`, line: i });
    }
    symbols.push({
      type: 'outputs',
      name: 'Changes to Outputs',
      startLine: outputsLine,
      endLine: end,
      children,
    });
  }

  if (planLine >= 0) {
    symbols.push({ type: 'summary', name: lines[planLine].trim(), line: planLine });
  }

  return symbols;
}

module.exports = {
  ACTION_MARKER,
  HEADER_RE,
  headerAction,
  classifyLine,
  scanLine,
  looksLikePlanText,
  isZipMagic,
  timestampPlanName,
  buildRenderError,
  parsePlanStructure,
  planSymbols,
};
