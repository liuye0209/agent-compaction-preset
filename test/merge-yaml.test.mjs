import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeDshCompactionBlock,
  readDshCompactionConfig,
} from '../lib/merge/yaml.mjs';

const config = {
  auto: true,
  thresholdRatio: 0.95,
  headroomTokens: 0,
  maxTokens: 8192,
  retainTokens: 50000,
};

test('appends a compaction-basic block to an empty patch', () => {
  const output = mergeDshCompactionBlock('[]\n', config);
  assert.match(output, /- id: compaction-basic/);
  assert.match(output, /thresholdRatio: 0\.95/);
  assert.match(output, /retainTokens: 50000/);
  assert.equal(output.split(/\r?\n/).includes('[]'), false);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('updates an existing block and preserves comments and unknown keys', () => {
  const input = [
    '# keep this comment',
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    thresholdRatio: 0.8 # old',
    '    modelPolicies:',
    '      - provider: local',
    '        model: small-context',
    '        retainTokens: 2048',
    '    auto: false',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.match(output, /# keep this comment/);
  assert.match(output, /thresholdRatio: 0\.95 # old/);
  assert.match(output, /modelPolicies:/);
  assert.match(output, /retainTokens: 2048/);
  assert.match(output, /auto: true/);
});

test('rejects duplicate compaction-basic entries', () => {
  const input = [
    '- id: compaction-basic',
    '  config: {}',
    '- id: compaction-basic',
    '  config: {}',
    '',
  ].join('\n');
  assert.throws(() => mergeDshCompactionBlock(input, config), /duplicate/i);
});

test('rejects flow-style config', () => {
  const input = [
    '- id: compaction-basic',
    '  config: { thresholdRatio: 0.8 }',
    '',
  ].join('\n');
  assert.throws(() => mergeDshCompactionBlock(input, config), /flow/i);
});

test('merge is idempotent', () => {
  const once = mergeDshCompactionBlock('[]\n', config);
  assert.equal(mergeDshCompactionBlock(once, config), once);
});

test('preserves CRLF and a missing final newline', () => {
  const input = [
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    thresholdRatio: 0.8',
    '    modelPolicies:',
    '      - provider: local',
    '        retainTokens: 2048',
  ].join('\r\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.equal(output.endsWith('\n'), false);
  assert.equal(output.includes('\r\n'), true);
  assert.equal(output.replace(/\r\n/g, '').includes('\n'), false);
  assert.match(output, /thresholdRatio: 0\.95\r\n/);
  assert.match(output, /retainTokens: 2048/);
});

test('preserves a final newline when one exists', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: false',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.equal(output.endsWith('\n'), true);
  assert.equal(output.endsWith('\n\n'), false);
});

test('counts one block containing both id and name as a single entry', () => {
  const input = [
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    thresholdRatio: 0.8',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.equal(output.match(/- id: compaction-basic/g).length, 1);
  assert.match(output, /thresholdRatio: 0\.95/);
});

test('matches a double-quoted entry name', () => {
  const input = [
    '- name: "@deepseek-ai/dsh-compaction-basic"',
    '  id: compaction-basic',
    '  config:',
    '    auto: false',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.equal(output.match(/dsh-compaction-basic/g).length, 1);
  assert.match(output, /auto: true/);
});

test('preserves nested retainTokens and updates the direct one', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    retainTokens: 40000',
    '    modelPolicies:',
    '      - provider: local',
    '        retainTokens: 2048',
    '',
  ].join('\n');
  const update = { ...config, retainTokens: 60000 };
  const output = mergeDshCompactionBlock(input, update);
  assert.match(output, /    retainTokens: 60000/);
  assert.match(output, /        retainTokens: 2048/);
  assert.deepEqual(readDshCompactionConfig(output), {
    found: true,
    config: update,
  });
});

test('adds a config block when the entry has none', () => {
  const input = [
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.match(output, /^  config:$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('appends a new block with a blank line and preserves unrelated entries', () => {
  const input = [
    '- id: telemetry',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.match(output, /- id: telemetry\n  config:\n    enabled: true\n/);
  assert.match(output, /\n\n- id: compaction-basic/);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('replaces an empty file and a flow-style empty array', () => {
  const expected = mergeDshCompactionBlock('', config);
  assert.equal(mergeDshCompactionBlock('[]', config), expected);
  assert.equal(expected.includes('[]'), false);
  assert.match(expected, /^- id: compaction-basic/m);
});

test('rejects an unexpected inline config value', () => {
  const input = ['- id: compaction-basic', '  config: null', ''].join('\n');
  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected|unsupported/i,
  );
});

test('rejects a target key that contains a nested mapping', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto:',
    '      enabled: true',
    '',
  ].join('\n');
  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected/i,
  );
});

test('read returns only direct config values', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: false # keep',
    '    thresholdRatio: "0.8"',
    '    modelPolicies:',
    '      - retainTokens: 2048',
    '        thresholdRatio: 0.1',
    '',
  ].join('\n');
  assert.deepEqual(readDshCompactionConfig(input), {
    found: true,
    config: { auto: false, thresholdRatio: 0.8 },
  });
});

test('read reports no entry for an unrelated patch', () => {
  assert.deepEqual(readDshCompactionConfig('[]\n'), {
    found: false,
    config: {},
  });
  assert.deepEqual(
    readDshCompactionConfig('- id: telemetry\n  config:\n    enabled: true\n'),
    { found: false, config: {} },
  );
});

test('a comment aligned with config does not truncate the config block', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: false',
    '# aligned with config:',
    '    thresholdRatio: 0.8',
    '    headroomTokens: 12',
    '    maxTokens: 4096',
    '    retainTokens: 40000',
    '',
  ].join('\n');

  assert.deepEqual(readDshCompactionConfig(input), {
    found: true,
    config: {
      auto: false,
      thresholdRatio: 0.8,
      headroomTokens: 12,
      maxTokens: 4096,
      retainTokens: 40000,
    },
  });

  const output = mergeDshCompactionBlock(input, config);
  assert.match(output, /# aligned with config:/);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

const unexpectedConfigStructures = [
  {
    name: 'a flow map after config',
    lines: ['- id: compaction-basic', '  config:', '    { thresholdRatio: 0.8 }', ''],
  },
  {
    name: 'a sequence after config',
    lines: ['- id: compaction-basic', '  config:', '    - auto: true', ''],
  },
  {
    name: 'a scalar after config',
    lines: ['- id: compaction-basic', '  config:', '    just a scalar', ''],
  },
  {
    name: 'a block scalar target value',
    lines: ['- id: compaction-basic', '  config:', '    auto: |', '      false', ''],
  },
  {
    name: 'a flow mapping target value',
    lines: ['- id: compaction-basic', '  config:', '    auto: { enabled: true }', ''],
  },
  {
    name: 'a flow sequence target value',
    lines: ['- id: compaction-basic', '  config:', '    auto: [true]', ''],
  },
  {
    name: 'a folded block scalar target value',
    lines: ['- id: compaction-basic', '  config:', '    auto: >', '      true', ''],
  },
  {
    name: 'an anchored target value',
    lines: ['- id: compaction-basic', '  config:', '    auto: &enabled true', ''],
  },
  {
    name: 'an aliased target value',
    lines: ['- id: compaction-basic', '  config:', '    auto: *enabled', ''],
  },
  {
    name: 'a tagged target value',
    lines: ['- id: compaction-basic', '  config:', '    auto: !enabled true', ''],
  },
];

for (const { name, lines } of unexpectedConfigStructures) {
  test(`rejects ${name} as an unexpected structure`, () => {
    const input = lines.join('\n');
    assert.throws(
      () => mergeDshCompactionBlock(input, config),
      /unexpected structure|unsupported structure/i,
    );
    assert.throws(
      () => readDshCompactionConfig(input),
      /unexpected structure|unsupported structure/i,
    );
  });
}

test('rejects a target key with a multiline plain scalar', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: this is',
    '      a multiline scalar',
    '',
  ].join('\n');
  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected structure/i,
  );
  assert.throws(() => readDshCompactionConfig(input), /unexpected structure/i);
});

test('rejects inconsistent entry indentation', () => {
  const input = [
    '-   id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    auto: false',
    '',
  ].join('\n');
  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected structure|unsupported structure/i,
  );
});

test('inserts missing keys after an unknown nested block', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: false',
    '    modelPolicies:',
    '      - provider: local',
    '        retainTokens: 2048',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.match(
    output,
    /modelPolicies:\n      - provider: local\n        retainTokens: 2048\n    thresholdRatio: 0\.95/,
  );
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('rejects duplicate direct target keys instead of updating both', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: false',
    '    thresholdRatio: 0.8',
    '    auto: true',
    '',
  ].join('\n');
  assert.throws(() => mergeDshCompactionBlock(input, config), /duplicate/i);
  assert.throws(() => readDshCompactionConfig(input), /duplicate/i);
});

test('updates a noncanonically indented entry using the dash column', () => {
  const input = [
    '-   id: compaction-basic',
    "    name: '@deepseek-ai/dsh-compaction-basic'",
    '    config:',
    '      auto: false',
    '      retainTokens: 40000',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.match(output, /^    config:$/m);
  assert.match(output, /^      auto: true$/m);
  assert.match(output, /^      thresholdRatio: 0\.95$/m);
  assert.match(output, /^      retainTokens: 50000$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('rejects a top-level flow-style compaction entry', () => {
  const input = ['- { id: compaction-basic, config: {} }', ''].join('\n');
  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected structure|unsupported structure/i,
  );
});

const unsupportedRoots = [
  { name: 'a top-level mapping', lines: ['plugins:', '  - id: telemetry', ''] },
  { name: 'an empty flow mapping', lines: ['{}', ''] },
  { name: 'a nonempty flow sequence', lines: ['[1, 2]', ''] },
  { name: 'a scalar document', lines: ['just-a-scalar', ''] },
  { name: 'a document marker', lines: ['---', '- id: telemetry', ''] },
];

for (const { name, lines } of unsupportedRoots) {
  test(`rejects appending to ${name}`, () => {
    assert.throws(
      () => mergeDshCompactionBlock(lines.join('\n'), config),
      /unexpected structure|unsupported structure/i,
    );
  });
}

test('replaces whitespace-only documents and empty flow sequences', () => {
  const expected = mergeDshCompactionBlock('', config);
  for (const input of ['', '   \n\n', '[]\n', '[ ]\n', '[] # comment\n']) {
    assert.equal(mergeDshCompactionBlock(input, config), expected);
  }
});

test('keeps a leading comment when appending to a comment-only document', () => {
  const output = mergeDshCompactionBlock('# preamble\n', config);
  assert.match(output, /^# preamble$/m);
  assert.match(output, /^- id: compaction-basic$/m);
});

test('rejects an indentless sequence after config', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '  - auto: true',
    '',
  ].join('\n');

  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected structure/i,
  );
  assert.throws(() => readDshCompactionConfig(input), /unexpected structure/i);
});

test('rejects over-indented continuation keys instead of adding a config block', () => {
  const input = [
    '- id: compaction-basic',
    "    name: '@deepseek-ai/dsh-compaction-basic'",
    '    config:',
    '      auto: false',
    '',
  ].join('\n');

  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected structure/i,
  );
  assert.throws(() => readDshCompactionConfig(input), /unexpected structure/i);
});

test('inserts missing keys after a block scalar whose last line starts with #', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    custom: |',
    '      hello',
    '      # literal last line',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  const lines = output.split('\n');
  const scalarLine = lines.indexOf('    custom: |');
  const literalLine = lines.indexOf('      # literal last line');
  const firstInserted = lines.findIndex((line) => line.startsWith('    auto: '));

  assert.notEqual(scalarLine, -1);
  assert.notEqual(literalLine, -1);
  assert.notEqual(firstInserted, -1);
  assert.ok(scalarLine < literalLine);
  assert.ok(literalLine < firstInserted);
  assert.match(
    output,
    /custom: \|\n      hello\n      # literal last line\n    auto: true\n/,
  );
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

const scalarPreservationCases = [
  {
    name: 'a sequence-item literal block scalar whose last line starts with #',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    prompts:',
      '      - |',
      '        hello',
      '        # literal last line',
      '',
    ],
    scalarText:
      '    prompts:\n      - |\n        hello\n        # literal last line',
    lastScalarLine: '        # literal last line',
    blankLinesAfterScalar: 0,
  },
  {
    name: 'an anchored literal block scalar whose last line starts with #',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: &a |',
      '      hello',
      '      # literal last line',
      '',
    ],
    scalarText: '    custom: &a |\n      hello\n      # literal last line',
    lastScalarLine: '      # literal last line',
    blankLinesAfterScalar: 0,
  },
  {
    name: 'a tagged literal block scalar whose last line starts with #',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: !!str |',
      '      hello',
      '      # literal last line',
      '',
    ],
    scalarText: '    custom: !!str |\n      hello\n      # literal last line',
    lastScalarLine: '      # literal last line',
    blankLinesAfterScalar: 0,
  },
  {
    name: 'a keep-chomping block scalar with trailing blank lines',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: |+',
      '      hello',
      '',
      '',
    ],
    scalarText: '    custom: |+\n      hello',
    lastScalarLine: '      hello',
    blankLinesAfterScalar: 1,
  },
  {
    name: 'a direct literal block scalar whose last line starts with #',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: |',
      '      hello',
      '      # literal last line',
      '',
    ],
    scalarText: '    custom: |\n      hello\n      # literal last line',
    lastScalarLine: '      # literal last line',
    blankLinesAfterScalar: 0,
  },
];

for (const {
  name,
  lines,
  scalarText,
  lastScalarLine,
  blankLinesAfterScalar,
} of scalarPreservationCases) {
  test(`inserts missing targets after ${name}`, () => {
    const input = lines.join('\n');
    const output = mergeDshCompactionBlock(input, config);
    const outputLines = output.split('\n');
    const lastScalar = outputLines.indexOf(lastScalarLine);
    const firstInserted = outputLines.findIndex((line) =>
      line.startsWith('    auto: '),
    );

    assert.ok(
      output.startsWith(input),
      'the original document, including the scalar, is preserved byte-for-byte',
    );
    assert.ok(output.includes(scalarText), 'the scalar text is preserved');
    assert.notEqual(lastScalar, -1);
    assert.notEqual(firstInserted, -1);
    assert.ok(lastScalar < firstInserted, 'insertion follows the scalar');
    assert.deepEqual(
      outputLines.slice(lastScalar + 1, firstInserted),
      Array(blankLinesAfterScalar).fill(''),
      'the scalar trailing blank lines are preserved',
    );
    for (const key of Object.keys(config)) {
      assert.match(output, new RegExp(`^    ${key}: `, 'm'));
    }
    assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
  });
}

const multilineQuotedConfigs = [
  {
    name: 'a multiline double-quoted scalar',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: "hello',
      '      # literal"',
      '',
    ],
  },
  {
    name: 'a multiline double-quoted scalar containing target-looking lines',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: "hello',
      '    auto: false',
      '    bye"',
      '',
    ],
  },
  {
    name: 'a multiline single-quoted scalar containing target-looking lines',
    lines: [
      '- id: compaction-basic',
      '  config:',
      "    custom: 'hello",
      '    auto: false',
      "    bye'",
      '',
    ],
  },
  {
    name: 'an anchored multiline double-quoted scalar',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: &a "hello',
      '    auto: false',
      '    bye"',
      '',
    ],
  },
  {
    name: 'a multiline double-quoted scalar with escaped quotes',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: "hello \\"there',
      '    auto: false',
      '    bye"',
      '',
    ],
  },
  {
    name: 'a sequence-item multiline double-quoted scalar',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    prompts:',
      '      - "hello',
      '        auto: false',
      '        bye"',
      '',
    ],
  },
];

for (const { name, lines } of multilineQuotedConfigs) {
  test(`rejects ${name} as an unexpected structure`, () => {
    const input = lines.join('\n');

    assert.throws(
      () => mergeDshCompactionBlock(input, config),
      {
        code: 'DSH_UNEXPECTED_STRUCTURE',
        message: /multiline quoted scalars/i,
      },
    );
    assert.throws(
      () => readDshCompactionConfig(input),
      {
        code: 'DSH_UNEXPECTED_STRUCTURE',
        message: /multiline quoted scalars/i,
      },
    );
  });
}

const multilineFlowConfigs = [
  {
    name: 'a multiline flow map hiding a target key',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: {',
      '    auto: false',
      '    }',
      '',
    ],
  },
  {
    name: 'a multiline flow map whose closing brace shares a line with a key',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: {',
      '    auto: false,',
      '    other: true }',
      '',
    ],
  },
  {
    name: 'a multiline flow sequence under an unknown key',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: [',
      '      one,',
      '      two,',
      '    ]',
      '',
    ],
  },
];

for (const { name, lines } of multilineFlowConfigs) {
  test(`rejects ${name} as an unexpected structure`, () => {
    const input = lines.join('\n');

    assert.throws(
      () => mergeDshCompactionBlock(input, config),
      {
        code: 'DSH_UNEXPECTED_STRUCTURE',
        message: /unexpected structure.*multiline flow collections/i,
      },
    );
    assert.throws(
      () => readDshCompactionConfig(input),
      {
        code: 'DSH_UNEXPECTED_STRUCTURE',
        message: /unexpected structure.*multiline flow collections/i,
      },
    );
  });
}

test('updates targets when unknown keys have single-line flow collections', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    custom: { a: 1 }',
    "    note: { text: don't }",
    '    list: [1, 2, 3]',
    '    auto: false',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /custom: \{ a: 1 \}/);
  assert.match(output, /note: \{ text: don't \}/);
  assert.match(output, /list: \[1, 2, 3\]/);
  assert.match(output, /^    auto: true$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('ignores braces and brackets in quoted values and block scalar content', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    custom: "hello { world"',
    '    anchored: &a "hello { world"',
    "    other: '[1, 2'",
    '    block: |',
    '      { not: closed',
    '      [ also not closed',
    '    auto: false',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /custom: "hello \{ world"/);
  assert.match(output, /anchored: &a "hello \{ world"/);
  assert.match(output, /other: '\[1, 2'/);
  assert.match(output, /^      \{ not: closed$/m);
  assert.match(output, /^    auto: true$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('updates targets when unknown keys have single-line quoted values', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    custom: "hello: auto: false"',
    '    hash: "hello # world"',
    "    other: 'it''s fine'",
    '    auto: false # it\'s "fine"',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /custom: "hello: auto: false"/);
  assert.match(output, /hash: "hello # world"/);
  assert.match(output, /other: 'it''s fine'/);
  assert.match(output, /^    auto: true # it's "fine"$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('ignores quotes inside block scalar content', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    custom: |',
    '      hello "unclosed',
    "      and 'also unclosed",
    '    prompts:',
    '      - |',
    '        another "unclosed',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.ok(output.startsWith(input));
  assert.ok(output.includes('      hello "unclosed\n'));
  assert.ok(output.includes('        another "unclosed\n'));
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('ignores quotes in comments when inspecting config', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    # it\'s a "comment',
    '    auto: false # don\'t "worry"',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /# it's a "comment/);
  assert.match(output, /^    auto: true # don't "worry"$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('updates an existing target in place before an unknown scalar block', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: false # old',
    '    prompts:',
    '      - |',
    '        hello',
    '        # literal last line',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.match(output, /^    auto: true # old$/m);
  assert.ok(
    output.includes(
      '        # literal last line\n    thresholdRatio: 0.95\n',
    ),
  );
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('rejects quoted entry keys instead of appending a second block', () => {
  const starts = [
    ['- "id": compaction-basic', ''],
    ["- 'name': '@deepseek-ai/dsh-compaction-basic'", ''],
    ['- id: compaction-basic', '  "config":', '    auto: false', ''],
  ];

  for (const lines of starts) {
    const input = lines.join('\n');
    assert.throws(
      () => mergeDshCompactionBlock(input, config),
      /unexpected structure/i,
    );
    assert.throws(
      () => readDshCompactionConfig(input),
      /unexpected structure/i,
    );
  }
});

test('rejects a multiline quoted scalar hidden behind a colon-containing key', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    custom:foo: "hello',
    '    auto: false',
    '    bye: true"',
    '',
  ].join('\n');

  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    {
      code: 'DSH_UNEXPECTED_STRUCTURE',
      message: /multiline quoted scalars/i,
    },
  );
  assert.throws(
    () => readDshCompactionConfig(input),
    {
      code: 'DSH_UNEXPECTED_STRUCTURE',
      message: /multiline quoted scalars/i,
    },
  );
});

test('preserves colon-containing keys with single-line quoted values', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    custom:foo: "hello"',
    '    note: keep',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.ok(output.includes('    custom:foo: "hello"\n'));
  assert.ok(output.includes('    note: keep\n'));
  assert.match(output, /^    auto: true$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('does not treat a colon-containing target prefix as the target key', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto:foo: "hello"',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.ok(output.includes('    auto:foo: "hello"\n'));
  assert.match(output, /^    auto: true$/m);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('rejects a target-shaped line whose colon is not followed by whitespace', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto:false',
    '    thresholdRatio: 0.8',
    '',
  ].join('\n');

  assert.throws(
    () => mergeDshCompactionBlock(input, config),
    /unexpected structure/i,
  );
  assert.throws(() => readDshCompactionConfig(input), /unexpected structure/i);
});

test('updates a target whose colon is followed by a tab', () => {
  const input = ['- id: compaction-basic', '  config:', '    auto:\tfalse', ''].join(
    '\n',
  );
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /^    auto:\ttrue$/m);
  assert.equal(readDshCompactionConfig(output).config.auto, true);
});

test('updates a target with an empty value', () => {
  const input = ['- id: compaction-basic', '  config:', '    auto:', ''].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /^    auto: true$/m);
  assert.equal(readDshCompactionConfig(output).config.auto, true);
});

test('updates a target with an empty value and a comment', () => {
  const input = [
    '- id: compaction-basic',
    '  config:',
    '    auto: # disabled',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /^    auto: true # disabled$/m);
  assert.equal(readDshCompactionConfig(output).config.auto, true);
});

test('updates a normal target in place without duplicating it', () => {
  const input = ['- id: compaction-basic', '  config:', '    auto: false', ''].join(
    '\n',
  );
  const output = mergeDshCompactionBlock(input, config);

  assert.match(output, /^    auto: true$/m);
  assert.equal(output.match(/^    auto: /gm).length, 1);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});
