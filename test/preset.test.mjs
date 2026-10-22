import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';

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
