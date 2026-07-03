const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  headerAction,
  classifyLine,
  scanLine,
  looksLikePlanText,
  isZipMagic,
  timestampPlanName,
  buildRenderError,
  parsePlanStructure,
  planSymbols,
} = require('../lib');

// Sanitized composite of real terraform plan output, covering every marker
// and header phrasing the parser supports. Indexed comments = line numbers.
const PLAN = [
  /* 0*/ 'Terraform used the selected providers to generate the following execution plan. Resource actions are',
  /* 1*/ 'indicated with the following symbols:',
  /* 2*/ '  + create',
  /* 3*/ '  ~ update in-place',
  /* 4*/ '-/+ destroy and then create replacement',
  /* 5*/ ' <= read (data resources)',
  /* 6*/ '',
  /* 7*/ 'Terraform will perform the following actions:',
  /* 8*/ '',
  /* 9*/ '  # module.app.data.aws_ami.base will be read during apply',
  /*10*/ '  # (depends on a resource or a module with changes pending)',
  /*11*/ ' <= data "aws_ami" "base" {',
  /*12*/ '      + id = (known after apply)',
  /*13*/ '    }',
  /*14*/ '',
  /*15*/ '  # aws_instance.web will be created',
  /*16*/ '  + resource "aws_instance" "web" {',
  /*17*/ '      + ami = "ami-123"',
  /*18*/ '    }',
  /*19*/ '',
  /*20*/ '  # aws_instance.old will be destroyed',
  /*21*/ '  - resource "aws_instance" "old" {',
  /*22*/ '      - ami = "ami-000" -> null',
  /*23*/ '    }',
  /*24*/ '',
  /*25*/ '  # aws_security_group.sg must be replaced',
  /*26*/ '-/+ resource "aws_security_group" "sg" {',
  /*27*/ '      ~ name = "a" -> "b" # forces replacement',
  /*28*/ '      ~ tags = [',
  /*29*/ '          - "old",',
  /*30*/ '        ]',
  /*31*/ '    }',
  /*32*/ '',
  /*33*/ '  # aws_thing.cfg will be updated in-place',
  /*34*/ '  ~ resource "aws_thing" "cfg" {',
  /*35*/ '      ~ input = "x" -> "y"',
  /*36*/ '    }',
  /*37*/ '',
  /*38*/ ' # aws_kms_alias.k will no longer be managed by Terraform, but will not be destroyed',
  /*39*/ ' # (destroy = false is set in the configuration)',
  /*40*/ ' . resource "aws_kms_alias" "k" {',
  /*41*/ '    }',
  /*42*/ '',
  /*43*/ 'Changes to Outputs:',
  /*44*/ '  + new_output = "v"',
  /*45*/ '  - old_output = "x" -> null',
  /*46*/ '  ~ chg_output = "a" -> "b"',
  /*47*/ '',
  /*48*/ 'Plan: 1 to add, 2 to change, 2 to destroy.',
];

describe('classifyLine', () => {
  const cases = [
    ['      + arn = (known after apply)', 'create'],
    ['  + create', 'create'],
    ['      - ami = "ami-000" -> null', 'destroy'],
    ['          - "AWSCURRENT",', 'destroy'],
    ['      ~ input = "x" -> "y"', 'update'],
    ['-/+ resource "aws_x" "y" {', 'replace'],
    ['  -/+ nested replace', 'replace'],
    ['+/- resource "aws_x" "y" {', 'replace'],
    [' <= data "aws_ami" "base" {', 'read'],
    ['<= read at column zero', 'read'],
    [' . resource "aws_kms_alias" "k" {', 'forget'],
  ];
  for (const [line, expected] of cases) {
    test(`${JSON.stringify(line)} -> ${expected}`, () => {
      assert.equal(classifyLine(line), expected);
    });
  }

  const negatives = [
    'Plan: 1 to add, 2 to change, 2 to destroy.',
    'Terraform will perform the following actions:',
    '  # aws_instance.web will be created',
    '        id = "unchanged"',
    '--- not a marker',
    '-> null',
    '+not-a-marker (no space after +)',
    '',
    '    }',
  ];
  for (const line of negatives) {
    test(`${JSON.stringify(line)} -> null`, () => {
      assert.equal(classifyLine(line), null);
    });
  }
});

describe('headerAction', () => {
  const cases = [
    ['be created', 'create'],
    ['be destroyed', 'destroy'],
    ['be updated in-place', 'update'],
    ['be replaced due to changes in replace_triggered_by', 'replace'],
    ['be replaced, as requested', 'replace'],
    ['be replaced', 'replace'], // "must be replaced" -> verb 'must', rest 'be replaced'
    ['tainted, so must be replaced', 'replace'], // verb 'is'
    ['be read during apply', 'read'],
    ['no longer be managed by Terraform, but will not be destroyed', 'forget'],
  ];
  for (const [rest, expected] of cases) {
    test(`"${rest}" -> ${expected}`, () => {
      assert.equal(headerAction(rest), expected);
    });
  }

  test('unknown phrasing -> null', () => {
    assert.equal(headerAction('do something unrecognized'), null);
  });

  test('forget wins over the "be destroyed" substring it contains', () => {
    assert.equal(
      headerAction('no longer be managed by Terraform, but will not be destroyed'),
      'forget'
    );
  });
});

describe('scanLine', () => {
  test('resource headers classify with their action', () => {
    assert.deepEqual(scanLine(PLAN[9]), { kind: 'header', action: 'read' });
    assert.deepEqual(scanLine(PLAN[15]), { kind: 'header', action: 'create' });
    assert.deepEqual(scanLine(PLAN[20]), { kind: 'header', action: 'destroy' });
    assert.deepEqual(scanLine(PLAN[25]), { kind: 'header', action: 'replace' });
    assert.deepEqual(scanLine(PLAN[33]), { kind: 'header', action: 'update' });
  });

  test('one-space-indented forget header', () => {
    assert.deepEqual(scanLine(PLAN[38]), { kind: 'header', action: 'forget' });
  });

  test('header continuation lines are not headers or diffs', () => {
    assert.equal(scanLine(PLAN[10]), null);
    assert.equal(scanLine(PLAN[39]), null);
  });

  test('diff line carries forcesIndex when "# forces replacement" present', () => {
    const s = scanLine(PLAN[27]);
    assert.equal(s.kind, 'diff');
    assert.equal(s.action, 'update');
    assert.equal(s.forcesIndex, PLAN[27].indexOf('# forces replacement'));
    assert.ok(s.forcesIndex > 0);
  });

  test('diff line without forces replacement has forcesIndex -1', () => {
    const s = scanLine(PLAN[17]);
    assert.equal(s.kind, 'diff');
    assert.equal(s.forcesIndex, -1);
  });

  test('legend lines classify as diffs', () => {
    assert.equal(scanLine(PLAN[2]).action, 'create');
    assert.equal(scanLine(PLAN[4]).action, 'replace');
    assert.equal(scanLine(PLAN[5]).action, 'read');
  });

  test('prose and structure lines yield null', () => {
    assert.equal(scanLine(PLAN[0]), null);
    assert.equal(scanLine(PLAN[7]), null);
    assert.equal(scanLine(PLAN[48]), null);
    assert.equal(scanLine('    }'), null);
    assert.equal(scanLine(''), null);
  });
});

describe('looksLikePlanText', () => {
  test('detects real plan head', () => {
    assert.ok(looksLikePlanText(PLAN.slice(0, 8).join('\n')));
  });
  test('detects "Terraform will perform" alone', () => {
    assert.ok(looksLikePlanText('Terraform will perform the following actions:'));
  });
  test('detects legend fragment', () => {
    assert.ok(looksLikePlanText('indicated with the following symbols:'));
  });
  test('rejects unrelated text', () => {
    assert.equal(looksLikePlanText('hello world\nnothing to see'), false);
    assert.equal(looksLikePlanText(''), false);
  });
});

describe('isZipMagic', () => {
  test('PK header is binary', () => {
    assert.ok(isZipMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  });
  test('text is not binary', () => {
    assert.equal(isZipMagic(Buffer.from('Terraform used the selected')), false);
  });
  test('empty and single-byte buffers are not binary', () => {
    assert.equal(isZipMagic(Buffer.alloc(0)), false);
    assert.equal(isZipMagic(Buffer.from([0x50])), false);
  });
});

describe('timestampPlanName', () => {
  test('month/day unpadded, HHmm padded', () => {
    assert.equal(timestampPlanName(new Date(2026, 6, 3, 9, 5)), '2026.7.3.0905.tfplan');
  });
  test('double-digit month/day', () => {
    assert.equal(timestampPlanName(new Date(2026, 11, 25, 23, 59)), '2026.12.25.2359.tfplan');
  });
  test('midnight pads to 0000', () => {
    assert.equal(timestampPlanName(new Date(2026, 0, 1, 0, 0)), '2026.1.1.0000.tfplan');
  });
});

describe('buildRenderError', () => {
  test('schema failure gets the stack-folder hint', () => {
    const out = buildRenderError('Error: Failed to load plugin schemas\n...', 'exit 1');
    assert.ok(out.includes('Hint:'));
    assert.ok(out.includes('Failed to load plugin schemas'));
  });
  test('other stderr passes through without hint', () => {
    const out = buildRenderError('Error: something else', 'exit 1');
    assert.equal(out.includes('Hint:'), false);
    assert.ok(out.includes('Error: something else'));
  });
  test('empty stderr falls back to the exec error message', () => {
    const out = buildRenderError('', 'spawn terraform ENOENT');
    assert.ok(out.includes('spawn terraform ENOENT'));
  });
});

describe('parsePlanStructure', () => {
  const s = parsePlanStructure(PLAN);
  test('finds all six resource headers with actions in order', () => {
    assert.deepEqual(
      s.headers.map((h) => [h.line, h.action, h.address]),
      [
        [9, 'read', 'module.app.data.aws_ami.base'],
        [15, 'create', 'aws_instance.web'],
        [20, 'destroy', 'aws_instance.old'],
        [25, 'replace', 'aws_security_group.sg'],
        [33, 'update', 'aws_thing.cfg'],
        [38, 'forget', 'aws_kms_alias.k'],
      ]
    );
  });
  test('locates outputs and summary lines', () => {
    assert.equal(s.outputsLine, 43);
    assert.equal(s.planLine, 48);
  });
});

describe('planSymbols', () => {
  const symbols = planSymbols(PLAN);

  test('resource symbols carry marker-prefixed names and block ranges', () => {
    const resources = symbols.filter((x) => x.type === 'resource');
    assert.deepEqual(
      resources.map((r) => [r.name, r.startLine, r.endLine]),
      [
        ['<= module.app.data.aws_ami.base', 9, 13],
        ['+ aws_instance.web', 15, 18],
        ['- aws_instance.old', 20, 23],
        ['-/+ aws_security_group.sg', 25, 31],
        ['~ aws_thing.cfg', 33, 36],
        ['. aws_kms_alias.k', 38, 41],
      ]
    );
  });

  test('resource detail is the action', () => {
    const detail = symbols.filter((x) => x.type === 'resource').map((r) => r.detail);
    assert.deepEqual(detail, ['read', 'create', 'destroy', 'replace', 'update', 'forget']);
  });

  test('outputs section symbol with one child per output', () => {
    const outputs = symbols.find((x) => x.type === 'outputs');
    assert.equal(outputs.startLine, 43);
    assert.equal(outputs.endLine, 46);
    assert.deepEqual(
      outputs.children.map((c) => [c.name, c.line]),
      [
        ['+ new_output', 44],
        ['- old_output', 45],
        ['~ chg_output', 46],
      ]
    );
  });

  test('summary symbol is the trimmed Plan line', () => {
    const summary = symbols.find((x) => x.type === 'summary');
    assert.equal(summary.name, 'Plan: 1 to add, 2 to change, 2 to destroy.');
    assert.equal(summary.line, 48);
  });

  test('symbols keep document order: resources, outputs, summary', () => {
    assert.deepEqual(
      symbols.map((x) => x.type),
      ['resource', 'resource', 'resource', 'resource', 'resource', 'resource', 'outputs', 'summary']
    );
  });

  test('plan without outputs or summary yields only resources', () => {
    const symbolsNoOutputs = planSymbols(PLAN.slice(0, 42));
    assert.deepEqual(
      symbolsNoOutputs.map((x) => x.type),
      ['resource', 'resource', 'resource', 'resource', 'resource', 'resource']
    );
    // last block now trims to its closing brace before the trailing blank
    const last = symbolsNoOutputs[symbolsNoOutputs.length - 1];
    assert.equal(last.endLine, 41);
  });

  test('empty input yields no symbols', () => {
    assert.deepEqual(planSymbols([]), []);
    assert.deepEqual(planSymbols(['']), []);
  });

  test('"No changes." plan yields no symbols', () => {
    assert.deepEqual(
      planSymbols(['No changes. Your infrastructure matches the configuration.']),
      []
    );
  });
});
