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

// block ends at the next header, the outputs section, or the summary
// line — whichever comes first — with trailing blanks trimmed
function blockEnd(headers, k, outputsLine, planLine, lines) {
  const { line } = headers[k];
  let end = k + 1 < headers.length ? headers[k + 1].line - 1 : lines.length - 1;
  if (outputsLine > line && outputsLine - 1 < end) end = outputsLine - 1;
  if (planLine > line && planLine - 1 < end) end = planLine - 1;
  while (end > line && lines[end].trim() === '') end--;
  return end;
}

// Split a resource address into module segments plus the resource leaf,
// e.g. module.a.module.b[0].aws_x.y -> ['module.a', 'module.b[0]', 'aws_x.y'].
// Dots inside brackets or quotes (index keys) do not split.
function splitAddress(address) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (const ch of address) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '.' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  const segments = [];
  let i = 0;
  while (i + 1 < parts.length && parts[i] === 'module') {
    segments.push(`${parts[i]}.${parts[i + 1]}`);
    i += 2;
  }
  const leaf = parts.slice(i).join('.');
  if (leaf) segments.push(leaf);
  return segments;
}

// Build document-symbol descriptors: resources nested under their module
// chain (so breadcrumbs show short per-level crumbs instead of one truncated
// address), the outputs section with one child per output, and the
// "Plan: N to add..." summary. Block ranges trim trailing blank lines;
// module ranges span their children.
function planSymbols(lines) {
  const { headers, outputsLine, planLine } = parsePlanStructure(lines);
  const symbols = [];

  for (let k = 0; k < headers.length; k++) {
    const { line, address, action } = headers[k];
    // a block absorbing the summary would overlap the summary symbol and
    // break outline navigation — blockEnd guards against that
    const end = blockEnd(headers, k, outputsLine, planLine, lines);

    const segments = splitAddress(address);
    let list = symbols;
    for (const seg of segments.slice(0, -1)) {
      let node = list.find((n) => n.type === 'module' && n.name === seg);
      if (!node) {
        node = { type: 'module', name: seg, startLine: line, endLine: end, children: [] };
        list.push(node);
      }
      node.startLine = Math.min(node.startLine, line);
      node.endLine = Math.max(node.endLine, end);
      list = node.children;
    }
    list.push({
      type: 'resource',
      name: `${ACTION_MARKER[action]} ${segments[segments.length - 1]}`,
      address,
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

// Resolve which resource block a line belongs to (header line included).
function resourceAtLine(lines, lineNo) {
  const { headers, outputsLine, planLine } = parsePlanStructure(lines);
  for (let k = headers.length - 1; k >= 0; k--) {
    const h = headers[k];
    if (h.line <= lineNo) {
      const end = blockEnd(headers, k, outputsLine, planLine, lines);
      return lineNo <= end ? { address: h.address, action: h.action } : null;
    }
  }
  return null;
}

// Folding ranges: each resource block folds from its HEADER line (so sticky
// scroll pins the current resource's header), plus the outputs section and
// inner attribute blocks (indent >= 4). Deliberately no region for the
// top-level "Terraform will perform..." umbrella — with indentation-based
// folding it would sit in sticky scroll forever as a stale first line.
function foldingRanges(lines) {
  const { headers, outputsLine, planLine } = parsePlanStructure(lines);
  const ranges = [];

  for (let k = 0; k < headers.length; k++) {
    const { line } = headers[k];
    const end = blockEnd(headers, k, outputsLine, planLine, lines);
    if (end <= line) continue;
    ranges.push({ start: line, end });
    // nested region from the body opening line (first non-comment line after
    // the header comments) so sticky shows header + `~ resource ... {`
    for (let i = line + 1; i <= end; i++) {
      if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
      if (i < end) ranges.push({ start: i, end });
      break;
    }
  }

  if (outputsLine >= 0) {
    let end = planLine > outputsLine ? planLine - 1 : lines.length - 1;
    while (end > outputsLine && lines[end].trim() === '') end--;
    if (end > outputsLine) ranges.push({ start: outputsLine, end });
  }

  // inner blocks by indentation; indent >= 4 keeps resource/header-level
  // lines out (their folding comes from the header regions above)
  const stack = []; // { line, indent }
  let lastNonBlank = -1;
  const closeTo = (indent) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      const r = stack.pop();
      if (r.indent >= 4 && lastNonBlank > r.line) ranges.push({ start: r.line, end: lastNonBlank });
    }
  };
  lines.forEach((text, i) => {
    if (!text.trim()) return;
    const indent = text.match(/^\s*/)[0].length;
    closeTo(indent);
    stack.push({ line: i, indent });
    lastNonBlank = i;
  });
  closeTo(0);

  return ranges;
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
  splitAddress,
  planSymbols,
  foldingRanges,
  resourceAtLine,
};
