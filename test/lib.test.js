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
  splitAddress,
  planSymbols,
  foldingRanges,
  resourceAtLine,
  heredocMask,
  renderedPathFor,
  planPathFrom,
  planSummary,
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

describe('splitAddress', () => {
  const cases = [
    ['aws_instance.web', ['aws_instance.web']],
    ['module.app.data.aws_ami.base', ['module.app', 'data.aws_ami.base']],
    [
      'module.pipelines.module.ecs_service_production[0].aws_appautoscaling_target.this',
      ['module.pipelines', 'module.ecs_service_production[0]', 'aws_appautoscaling_target.this'],
    ],
    ['module.m.aws_x.y["key.with.dots"]', ['module.m', 'aws_x.y["key.with.dots"]']],
    ['module.a.module.b.module.c.aws_x.y', ['module.a', 'module.b', 'module.c', 'aws_x.y']],
    ['terraform_data.trigger', ['terraform_data.trigger']],
  ];
  for (const [address, expected] of cases) {
    test(address, () => {
      assert.deepEqual(splitAddress(address), expected);
    });
  }
});

describe('planSymbols', () => {
  const symbols = planSymbols(PLAN);

  function flattenResources(list) {
    const out = [];
    for (const n of list) {
      if (n.type === 'resource') out.push(n);
      if (n.type === 'module') out.push(...flattenResources(n.children));
    }
    return out;
  }

  test('module-scoped resource nests under its module node', () => {
    const mod = symbols.find((x) => x.type === 'module');
    assert.equal(mod.name, 'module.app');
    assert.equal(mod.startLine, 9);
    assert.equal(mod.endLine, 13);
    assert.deepEqual(
      mod.children.map((c) => [c.name, c.startLine, c.endLine]),
      [['<= data.aws_ami.base', 9, 13]]
    );
  });

  test('resource symbols carry marker-prefixed leaf names and block ranges', () => {
    assert.deepEqual(
      flattenResources(symbols).map((r) => [r.name, r.startLine, r.endLine]),
      [
        ['<= data.aws_ami.base', 9, 13],
        ['+ aws_instance.web', 15, 18],
        ['- aws_instance.old', 20, 23],
        ['-/+ aws_security_group.sg', 25, 31],
        ['~ aws_thing.cfg', 33, 36],
        ['. aws_kms_alias.k', 38, 41],
      ]
    );
  });

  test('resources keep the full address and action detail', () => {
    const resources = flattenResources(symbols);
    assert.equal(resources[0].address, 'module.app.data.aws_ami.base');
    assert.deepEqual(
      resources.map((r) => r.detail),
      ['read', 'create', 'destroy', 'replace', 'update', 'forget']
    );
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

  test('symbols keep document order: module, resources, outputs, summary', () => {
    assert.deepEqual(
      symbols.map((x) => x.type),
      ['module', 'resource', 'resource', 'resource', 'resource', 'resource', 'outputs', 'summary']
    );
  });

  test('plan without outputs or summary yields only resource tree', () => {
    const noOutputs = planSymbols(PLAN.slice(0, 42));
    assert.deepEqual(
      noOutputs.map((x) => x.type),
      ['module', 'resource', 'resource', 'resource', 'resource', 'resource']
    );
    // last block now trims to its closing brace before the trailing blank
    assert.equal(noOutputs[noOutputs.length - 1].endLine, 41);
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

describe('foldingRanges', () => {
  const ranges = foldingRanges(PLAN);
  const has = (start, end) => ranges.some((r) => r.start === start && r.end === end);

  test('each resource block folds from its header line', () => {
    assert.ok(has(9, 13));
    assert.ok(has(15, 18));
    assert.ok(has(20, 23));
    assert.ok(has(25, 31));
    assert.ok(has(33, 36));
    assert.ok(has(38, 41));
  });

  test('outputs section folds', () => {
    assert.ok(has(43, 46));
  });

  test('inner attribute blocks fold', () => {
    // tags list inside the replace block (lines 28-30)
    assert.ok(ranges.some((r) => r.start === 28));
  });

  test('no region starts at the top-level umbrella lines', () => {
    assert.equal(ranges.some((r) => r.start === 0), false);
    assert.equal(ranges.some((r) => r.start === 7), false);
  });

  test('resource body opening lines fold too (second sticky level)', () => {
    assert.ok(has(11, 13)); // <= data "aws_ami" "base" {
    assert.ok(has(16, 18)); // + resource "aws_instance" "web" {
    assert.ok(has(26, 31)); // -/+ resource "aws_security_group" "sg" {
    assert.ok(has(40, 41)); // . resource "aws_kms_alias" "k" {
  });

  test('empty input yields no ranges', () => {
    assert.deepEqual(foldingRanges([]), []);
  });
});

describe('heredocMask', () => {
  const HEREDOC_PLAN = [
    /* 0*/ '  # aws_codebuild_project.ci will be created',
    /* 1*/ '  + resource "aws_codebuild_project" "ci" {',
    /* 2*/ '      + buildspec = <<-EOT',
    /* 3*/ '            "artifacts":',
    /* 4*/ '              "files":',
    /* 5*/ '              - "**/*"',
    /* 6*/ '              - "second item"',
    /* 7*/ '            # aws_fake.resource will be destroyed',
    /* 8*/ '        EOT',
    /* 9*/ '      + type = "CODEPIPELINE"',
    /*10*/ '    }',
  ];

  test('masks heredoc content and terminator, not the opener', () => {
    const mask = heredocMask(HEREDOC_PLAN);
    assert.deepEqual(mask, [false, false, false, true, true, true, true, true, true, false, false]);
  });

  test('heredoc content is not classified as headers or resources', () => {
    const { headers } = parsePlanStructure(HEREDOC_PLAN);
    assert.deepEqual(headers.map((h) => h.address), ['aws_codebuild_project.ci']);
  });

  test('terminator with trailing comma closes the heredoc', () => {
    const mask = heredocMask(['      + <<-EOT', '        - yaml item', '        EOT,', '      + next = 1']);
    assert.deepEqual(mask, [false, true, true, false]);
  });

  test('destroy-diff terminator "EOT -> null" closes the heredoc', () => {
    const mask = heredocMask([
      '      - cluster_public_key = <<-EOT',
      '            ssh-rsa AAAA... Amazon-Redshift',
      '        EOT -> null',
      '      - cluster_revision_number = "331388" -> null',
    ]);
    assert.deepEqual(mask, [false, true, true, false]);
  });

  test('changed-value terminator "EOT -> (known after apply)" closes the heredoc', () => {
    const mask = heredocMask(['~ x = <<-EOT', 'content', 'EOT -> (known after apply)', '~ y = 1 -> 2']);
    assert.deepEqual(mask, [false, true, true, false]);
  });

  test('opener with "# forces replacement" comment still starts the heredoc', () => {
    const mask = heredocMask([
      '      ~ user_data = <<-EOT # forces replacement',
      '        - some yaml item',
      '        EOT',
      '      ~ other = 1 -> 2',
    ]);
    assert.deepEqual(mask, [false, true, true, false]);
  });

  test('content lines merely containing the delimiter word do not close', () => {
    const mask = heredocMask(['+ x = <<-EOT', 'EOTHER line', 'say EOT here', 'EOT', '+ y = 1']);
    assert.deepEqual(mask, [false, true, true, true, false]);
  });

  test('lines after the heredoc classify normally', () => {
    const { summary, groups } = planSummary([...HEREDOC_PLAN, '', 'Plan: 1 to add, 0 to change, 0 to destroy.']);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].action, 'create');
    assert.ok(summary);
  });
});

describe('planSummary', () => {
  test('carries the Plan summary line', () => {
    const { summary } = planSummary(PLAN);
    assert.deepEqual(summary, { text: 'Plan: 1 to add, 2 to change, 2 to destroy.', line: 48 });
  });

  test('summary is null without a Plan line', () => {
    const { summary } = planSummary(PLAN.slice(0, 42));
    assert.equal(summary, null);
  });

  test('groups resources by action in severity order with counts', () => {
    const { groups } = planSummary(PLAN);
    assert.deepEqual(
      groups.map((g) => [g.action, g.count]),
      [
        ['replace', 1],
        ['destroy', 1],
        ['create', 1],
        ['update', 1],
        ['read', 1],
        ['forget', 1],
      ]
    );
  });

  test('root-level resources are direct children with leaf and line', () => {
    const { groups } = planSummary(PLAN);
    const replace = groups.find((g) => g.action === 'replace');
    assert.deepEqual(replace.children, [
      { type: 'resource', address: 'aws_security_group.sg', leaf: 'aws_security_group.sg', line: 25 },
    ]);
  });

  test('module resources nest under module nodes', () => {
    const { groups } = planSummary(PLAN);
    const read = groups.find((g) => g.action === 'read');
    assert.deepEqual(read.children, [
      {
        type: 'module',
        name: 'module.app',
        children: [
          { type: 'resource', address: 'module.app.data.aws_ami.base', leaf: 'data.aws_ami.base', line: 9 },
        ],
      },
    ]);
  });

  test('deep chains nest one node per module and share prefixes', () => {
    const lines = [
      '  # module.a.module.b.aws_x.one will be destroyed',
      '  - resource "aws_x" "one" {',
      '    }',
      '  # module.a.module.b.aws_x.two will be destroyed',
      '  - resource "aws_x" "two" {',
      '    }',
    ];
    const { groups } = planSummary(lines);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
    const a = groups[0].children[0];
    assert.equal(a.name, 'module.a');
    const b = a.children[0];
    assert.equal(b.name, 'module.b');
    assert.deepEqual(b.children.map((r) => r.leaf), ['aws_x.one', 'aws_x.two']);
  });

  test('empty actions are omitted', () => {
    const { groups } = planSummary(PLAN.slice(0, 14)); // only the read block
    assert.deepEqual(groups.map((g) => g.action), ['read']);
  });

  test('no changes yields no groups', () => {
    assert.deepEqual(planSummary(['No changes.']), { summary: null, groups: [] });
  });
});

describe('rendered preview paths', () => {
  // basename shapes claimed by the default-priority custom editor —
  // a rendered path matching any of these re-enters the custom editor on
  // generic opens and breaks outline navigation
  const CLAIMS = [
    (b) => b === 'tfplan',
    (b) => b.startsWith('tfplan.'),
    (b) => b.endsWith('-tfplan'),
    (b) => b.endsWith('_tfplan'),
  ];

  const binaries = ['tfplan', 'tfplan.bin', 'prod-tfplan', 'prod_tfplan'];

  for (const name of binaries) {
    test(`rendered name for ${name} matches no default claim and ends in .tfplan`, () => {
      const rendered = renderedPathFor(`/stack/dir/${name}`);
      const base = rendered.slice(rendered.lastIndexOf('/') + 1);
      assert.ok(base.endsWith('.tfplan'), base);
      for (const claims of CLAIMS) assert.equal(claims(base), false, base);
    });

    test(`round-trips back to the plan path for ${name}`, () => {
      assert.equal(planPathFrom(renderedPathFor(`/stack/dir/${name}`)), `/stack/dir/${name}`);
    });
  }

  test('non-rendered paths pass through unchanged', () => {
    assert.equal(planPathFrom('/stack/dir/tfplan'), '/stack/dir/tfplan');
  });
});

describe('resourceAtLine', () => {
  test('header line resolves to its own resource', () => {
    assert.deepEqual(resourceAtLine(PLAN, 15), { address: 'aws_instance.web', action: 'create' });
  });
  test('line inside a block resolves to the enclosing resource', () => {
    assert.deepEqual(resourceAtLine(PLAN, 29), { address: 'aws_security_group.sg', action: 'replace' });
    assert.deepEqual(resourceAtLine(PLAN, 12), { address: 'module.app.data.aws_ami.base', action: 'read' });
  });
  test('lines outside any block resolve to null', () => {
    assert.equal(resourceAtLine(PLAN, 0), null);   // legend
    assert.equal(resourceAtLine(PLAN, 14), null);  // blank between blocks
    assert.equal(resourceAtLine(PLAN, 44), null);  // outputs section
    assert.equal(resourceAtLine(PLAN, 48), null);  // summary
  });
});

describe('planSymbols nesting', () => {
  const NESTED = [
    /* 0*/ '  # module.a.module.b.aws_x.one will be created',
    /* 1*/ '  + resource "aws_x" "one" {',
    /* 2*/ '    }',
    /* 3*/ '',
    /* 4*/ '  # module.a.module.b.aws_x.two will be destroyed',
    /* 5*/ '  - resource "aws_x" "two" {',
    /* 6*/ '    }',
    /* 7*/ '',
    /* 8*/ '  # module.a.aws_y.z will be updated in-place',
    /* 9*/ '  ~ resource "aws_y" "z" {',
    /*10*/ '    }',
  ];
  const symbols = planSymbols(NESTED);

  test('same module chain groups into one node', () => {
    assert.equal(symbols.length, 1);
    const a = symbols[0];
    assert.equal(a.name, 'module.a');
    assert.deepEqual(a.children.map((c) => [c.type, c.name]), [
      ['module', 'module.b'],
      ['resource', '~ aws_y.z'],
    ]);
    const b = a.children[0];
    assert.deepEqual(b.children.map((c) => c.name), ['+ aws_x.one', '- aws_x.two']);
  });

  test('module ranges span their children', () => {
    const a = symbols[0];
    const b = a.children[0];
    assert.equal(b.startLine, 0);
    assert.equal(b.endLine, 6);
    assert.equal(a.startLine, 0);
    assert.equal(a.endLine, 10);
  });

  test('last block stops before the summary when there is no outputs section', () => {
    // mirrors real plans: module resources, no outputs, Plan line at EOF —
    // the last block must not absorb the summary (breaks outline navigation)
    const withSummary = [...NESTED, '', 'Plan: 1 to add, 1 to change, 1 to destroy.'];
    const syms = planSymbols(withSummary);
    const a = syms[0];
    assert.equal(a.endLine, 10);
    assert.equal(a.children[1].endLine, 10);
    const summary = syms.find((x) => x.type === 'summary');
    assert.equal(summary.line, 12);
    assert.ok(a.endLine < summary.line);
  });
});
