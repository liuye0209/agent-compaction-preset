import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';
import { ADAPTERS } from '../lib/registry.mjs';

const preset = JSON.parse(
  fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'),
);

test('preset matches the default policy', () => {
  assert.deepEqual(preset.policy, DEFAULT_POLICY);
});

test('preset lists all six agents with support levels', () => {
  assert.deepEqual(Object.keys(preset.agents), [
    'opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen',
  ]);
  assert.equal(preset.agents.opencode.support, 'full');
  assert.equal(preset.agents.dsh.support, 'full');
  for (const id of ['codex', 'claude', 'gemini', 'qwen']) {
    assert.equal(preset.agents[id].support, 'partial');
  }
});

test('preset metadata matches the registry and exact keys', () => {
  assert.equal(preset.name, 'default');
  assert.deepEqual(Object.keys(preset.agents), ADAPTERS.map((adapter) => adapter.id));

  for (const adapter of ADAPTERS) {
    assert.equal(preset.agents[adapter.id].support, adapter.support);
  }

  assert.deepEqual(preset.agents.opencode.keys, [
    'compaction.auto', 'compaction.keep.tokens', 'compaction.buffer',
  ]);
  assert.deepEqual(preset.agents.dsh.keys, [
    'auto', 'thresholdRatio', 'headroomTokens', 'maxTokens', 'retainTokens',
  ]);
  assert.deepEqual(preset.agents.codex.keys, [
    'model_context_window', 'model_auto_compact_token_limit',
  ]);
  assert.deepEqual(preset.agents.claude.keys, [
    'autoCompactEnabled', 'autoCompactWindow',
  ]);
  assert.deepEqual(preset.agents.gemini.keys, ['model.compressionThreshold']);
  assert.deepEqual(preset.agents.qwen.keys, ['context.autoCompactThreshold']);
});
