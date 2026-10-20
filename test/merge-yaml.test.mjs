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
