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

test('refuses to guess when a top-level multiline string is open', () => {
  const basic = 'name = """\nmodel_context_window = 1\n"""\n\n[profiles.small]\nmodel_context_window = 64000\n';
  assert.throws(
    () => mergeTopLevelToml(basic, { model_context_window: 200000 }),
    /Ambiguous TOML.*multiline/i,
  );

  const literal = "name = '''\nmodel_context_window = 1\n'''\n\n[profiles.small]\nmodel_context_window = 64000\n";
  assert.throws(
    () => mergeTopLevelToml(literal, { model_context_window: 200000 }),
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
