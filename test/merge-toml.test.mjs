import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTopLevelToml,
  readTopLevelTomlValues,
  findKeysInTables,
} from '../lib/merge/toml.mjs';

const input = `# top
model = "deepseek-flash"
model_context_window = 100000 # old

[model_providers.custom]
experimental_bearer_token = "sk-test-not-real"

[profiles.small]
model_context_window = 64000
`;

test('updates top-level values, preserves comments and secrets', () => {
  const output = mergeTopLevelToml(input, {
    model_context_window: 200000,
    model_auto_compact_token_limit: 190000,
  });
  assert.match(output, /model_context_window = 200000 # old/);
  assert.match(output, /model_auto_compact_token_limit = 190000/);
  assert.match(output, /experimental_bearer_token = "sk-test-not-real"/);
  assert.match(output, /model_context_window = 64000/);
});

test('inserts missing top-level keys before the first table', () => {
  const output = mergeTopLevelToml('model = "x"\n\n[providers.a]\nkey = "v"\n', {
    model_context_window: 200000,
  });
  assert.ok(output.indexOf('model_context_window = 200000') < output.indexOf('[providers.a]'));
});

test('reads top-level values and finds table overrides', () => {
  assert.deepEqual(
    readTopLevelTomlValues(input, ['model_context_window', 'model_auto_compact_token_limit']),
    { model_context_window: '100000', model_auto_compact_token_limit: undefined },
  );
  assert.deepEqual(findKeysInTables(input, ['model_context_window']), [
    { table: 'profiles.small', key: 'model_context_window', line: 9 },
  ]);
});

test('merge is idempotent', () => {
  const once = mergeTopLevelToml(input, { model_context_window: 200000 });
  assert.equal(mergeTopLevelToml(once, { model_context_window: 200000 }), once);
});

test('preserves CRLF line endings and the final newline', () => {
  const text = [
    'model = "deepseek-flash"',
    'model_context_window = 100000',
    '',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\r\n');
  const output = mergeTopLevelToml(text, {
    model_context_window: 200000,
    model_auto_compact_token_limit: 190000,
  });
  assert.equal(
    output,
    [
      'model = "deepseek-flash"',
      'model_context_window = 200000',
      '',
      'model_auto_compact_token_limit = 190000',
      '[profiles.small]',
      'model_context_window = 64000',
      '',
    ].join('\r\n'),
  );
});

test('does not add a final newline when the input has none', () => {
  const text = 'model = "x"\n[profiles.a]\nmodel_context_window = 64000';
  const output = mergeTopLevelToml(text, { model_context_window: 200000 });
  assert.equal(
    output,
    'model = "x"\nmodel_context_window = 200000\n[profiles.a]\nmodel_context_window = 64000',
  );
  assert.equal(output.endsWith('\n'), false);
});

test('treats # inside quoted values as data, not a comment', () => {
  const text = [
    'provider = "custom # one" # keep this',
    "literal = 'literal # two'",
    'model_context_window = 100000 # old',
    '',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  const output = mergeTopLevelToml(text, { model_context_window: 200000 });
  assert.match(output, /provider = "custom # one" # keep this/);
  assert.match(output, /literal = 'literal # two'/);
  assert.match(output, /model_context_window = 200000 # old/);
  assert.deepEqual(
    readTopLevelTomlValues(text, ['provider', 'literal', 'model_context_window']),
    {
      provider: '"custom # one"',
      literal: "'literal # two'",
      model_context_window: '100000',
    },
  );
});

test('preserves closed multiline strings and aborts when they are unclosed', () => {
  const basic = [
    'name = """',
    'model_context_window = 1',
    '"""',
    '',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  assert.equal(
    mergeTopLevelToml(basic, { model_context_window: 200000 }),
    [
      'name = """',
      'model_context_window = 1',
      '"""',
      '',
      'model_context_window = 200000',
      '[profiles.small]',
      'model_context_window = 64000',
      '',
    ].join('\n'),
  );

  const literal = [
    "name = '''",
    'model_context_window = 1',
    "'''",
    '',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  assert.equal(
    mergeTopLevelToml(literal, { model_context_window: 200000 }),
    [
      "name = '''",
      'model_context_window = 1',
      "'''",
      '',
      'model_context_window = 200000',
      '[profiles.small]',
      'model_context_window = 64000',
      '',
    ].join('\n'),
  );

  assert.throws(
    () =>
      mergeTopLevelToml('name = """\nmodel_context_window = 1\n', {
        model_context_window: 200000,
      }),
    /Ambiguous TOML.*multiline/i,
  );
  assert.throws(
    () =>
      mergeTopLevelToml("name = '''\nmodel_context_window = 1\n", {
        model_context_window: 200000,
      }),
    /Ambiguous TOML.*multiline/i,
  );
});

test('inserts missing keys at EOF when there is no table', () => {
  assert.equal(
    mergeTopLevelToml('model = "x"\n', { model_context_window: 200000 }),
    'model = "x"\nmodel_context_window = 200000\n',
  );
  assert.equal(
    mergeTopLevelToml('model = "x"', { model_context_window: 200000 }),
    'model = "x"\nmodel_context_window = 200000',
  );
});

test('findKeysInTables ignores top-level keys and reports table line numbers', () => {
  const text = [
    'model_context_window = 1',
    '[profiles.first] # inline comment',
    'model_context_window = 2',
    '[[servers]]',
    'model_context_window = 3',
    '',
  ].join('\n');
  assert.deepEqual(findKeysInTables(text, ['model_context_window']), [
    { table: 'profiles.first', key: 'model_context_window', line: 3 },
    { table: 'servers', key: 'model_context_window', line: 5 },
  ]);
  assert.deepEqual(findKeysInTables('model_context_window = 1\n', ['model_context_window']), []);
});

test('inserts missing keys after a top-level array, not inside it', () => {
  const text = [
    'notify = [',
    '  [1, 2],',
    '  [3, 4]',
    ']',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  const output = mergeTopLevelToml(text, { model_context_window: 200000 });
  assert.equal(
    output,
    [
      'notify = [',
      '  [1, 2],',
      '  [3, 4]',
      ']',
      'model_context_window = 200000',
      '[profiles.small]',
      'model_context_window = 64000',
      '',
    ].join('\n'),
  );
  assert.doesNotMatch(output, /\[1, 2\],\n\s*model_context_window/);
});

test('preserves multiline string contents and inserts target keys outside them', () => {
  const text = [
    '"description" = """',
    'model_context_window = 100000',
    '"""',
    '',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  const output = mergeTopLevelToml(text, { model_context_window: 200000 });
  assert.equal(
    output,
    [
      '"description" = """',
      'model_context_window = 100000',
      '"""',
      '',
      'model_context_window = 200000',
      '[profiles.small]',
      'model_context_window = 64000',
      '',
    ].join('\n'),
  );
});

test('preserves arrays of multiline strings while inserting missing keys', () => {
  const text = [
    'notes = [',
    '  """',
    '  model_context_window = 1',
    '  """,',
    "  '''",
    '  [profiles.fake]',
    '  model_context_window = 2',
    "  '''",
    ']',
    '',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  const output = mergeTopLevelToml(text, { model_context_window: 200000 });
  assert.equal(
    output,
    [
      'notes = [',
      '  """',
      '  model_context_window = 1',
      '  """,',
      "  '''",
      '  [profiles.fake]',
      '  model_context_window = 2',
      "  '''",
      ']',
      '',
      'model_context_window = 200000',
      '[profiles.small]',
      'model_context_window = 64000',
      '',
    ].join('\n'),
  );
});

test('reads only real top-level values, ignoring arrays and multiline strings', () => {
  const text = [
    'notes = [',
    '  """',
    '  model_context_window = 1',
    '  """,',
    '  [3, 4],',
    ']',
    'description = """',
    'model_auto_compact_token_limit = 2',
    '"""',
    'model_context_window = 100000 # real',
    '',
    '[profiles.small]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  assert.deepEqual(
    readTopLevelTomlValues(text, [
      'model_context_window',
      'model_auto_compact_token_limit',
    ]),
    { model_context_window: '100000', model_auto_compact_token_limit: undefined },
  );
});

test('findKeysInTables ignores array elements and table-like multiline text', () => {
  const text = [
    'notify = [',
    '  [3, 4],',
    ']',
    'description = """',
    '[profiles.fake]',
    'model_context_window = 777',
    '"""',
    '[profiles.real]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  assert.deepEqual(findKeysInTables(text, ['model_context_window']), [
    { table: 'profiles.real', key: 'model_context_window', line: 9 },
  ]);
});

test('updates quoted target keys without duplicating them', () => {
  const text = '"model_context_window" = 100000 # old\n';
  const output = mergeTopLevelToml(text, { model_context_window: 200000 });
  assert.equal(output, '"model_context_window" = 200000 # old\n');
  assert.equal((output.match(/model_context_window/g) ?? []).length, 1);
  assert.deepEqual(readTopLevelTomlValues(text, ['model_context_window']), {
    model_context_window: '100000',
  });
});

test('aborts on an unclosed top-level array', () => {
  assert.throws(
    () =>
      mergeTopLevelToml('notify = [\n  [1, 2],\n', {
        model_context_window: 200000,
      }),
    /Ambiguous TOML.*array/i,
  );
});

test('aborts instead of rewriting a multiline target value', () => {
  assert.throws(
    () =>
      mergeTopLevelToml('model_context_window = """\n100000\n"""\n', {
        model_context_window: 200000,
      }),
    /Ambiguous TOML.*multiline/i,
  );
  assert.throws(
    () =>
      mergeTopLevelToml('model_context_window = [\n  100000,\n]\n', {
        model_context_window: 200000,
      }),
    /Ambiguous TOML.*array/i,
  );
});

test('quoted table headers may contain brackets', () => {
  const text = [
    'model = "deepseek-flash"',
    '',
    '[profiles."a[b]"]',
    'model_context_window = 64000',
    '',
  ].join('\n');
  const output = mergeTopLevelToml(text, {
    model_auto_compact_token_limit: 190000,
  });

  assert.ok(
    output.indexOf('model_auto_compact_token_limit = 190000') <
      output.indexOf('[profiles."a[b]"]'),
  );
  assert.deepEqual(
    findKeysInTables(text, ['model_context_window']),
    [{ table: 'profiles."a[b]"', key: 'model_context_window', line: 4 }],
  );
  assert.deepEqual(readTopLevelTomlValues(text, ['model_context_window']), {
    model_context_window: undefined,
  });
});

test('rejects an unclosed value after target top-level keys', () => {
  const text = [
    'model_context_window = 200000',
    'model_auto_compact_token_limit = 190000',
    'model = """',
    '',
  ].join('\n');

  assert.throws(
    () =>
      readTopLevelTomlValues(text, [
        'model_context_window',
        'model_auto_compact_token_limit',
      ]),
    /Ambiguous TOML.*multiline/i,
  );
});

test('rejects an unclosed value after the first table', () => {
  const text = [
    'model_context_window = 200000',
    'model_auto_compact_token_limit = 190000',
    '',
    '[profiles.small]',
    'model = """',
    '',
  ].join('\n');

  assert.throws(
    () =>
      readTopLevelTomlValues(text, [
        'model_context_window',
        'model_auto_compact_token_limit',
      ]),
    /Ambiguous TOML.*multiline/i,
  );
  assert.throws(
    () => findKeysInTables(text, ['model_context_window']),
    /Ambiguous TOML.*multiline/i,
  );
});

test('rejects malformed table headers instead of treating them as top level', () => {
  const text = 'model = "x"\n[profiles."a[b]\nmodel_context_window = 64000\n';

  assert.throws(
    () => readTopLevelTomlValues(text, ['model_context_window']),
    /malformed table header/i,
  );
  assert.throws(
    () => mergeTopLevelToml(text, { model_context_window: 200000 }),
    /malformed table header/i,
  );
});
