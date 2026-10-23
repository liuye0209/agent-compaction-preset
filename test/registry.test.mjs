import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ADAPTERS,
  getAdapter,
  parseAgentSelection,
  resolveAdapters,
  detectAdapters,
} from '../lib/registry.mjs';
import { tempHome, writeHomeFile, makeCtx } from './helpers.mjs';

test('registry exposes the six adapters in order', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id), [
    'opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen',
  ]);
});

test('selection accepts all, a comma list, and rejects unknown ids', () => {
  assert.deepEqual(parseAgentSelection('all'), [
    'opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen',
  ]);
  assert.deepEqual(parseAgentSelection('opencode, codex'), ['opencode', 'codex']);
  assert.throws(() => parseAgentSelection('nope'), /Unknown agent/);
  assert.equal(getAdapter('dsh').id, 'dsh');
});

test('selection defaults to all adapters when undefined', () => {
  assert.deepEqual(parseAgentSelection(undefined), [
    'opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen',
  ]);
});

test('selection filters empty and whitespace-only entries', () => {
  assert.deepEqual(parseAgentSelection('opencode, ,codex,'), ['opencode', 'codex']);
  assert.deepEqual(parseAgentSelection('  '), []);
});

test('selection deduplicates, rejects mixed all, and rejects non-strings', () => {
  assert.deepEqual(parseAgentSelection('codex,codex'), ['codex']);
  assert.throws(() => parseAgentSelection('all,codex'), /Unknown agent/);
  assert.throws(() => parseAgentSelection(null), /Unknown agent/);
});

test('resolveAdapters preserves the requested order', () => {
  assert.deepEqual(resolveAdapters(['codex', 'opencode']).map((a) => a.id), [
    'codex', 'opencode',
  ]);
  assert.throws(() => resolveAdapters(['nope']), /Unknown agent/);
});

test('detectAdapters reports configured agents', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{}\n');
  writeHomeFile(home, path.join('.codex', 'config.toml'), 'model = "x"\n');
  const results = detectAdapters(ADAPTERS, makeCtx(home));
  const detected = results.filter((r) => r.detection.detected).map((r) => r.adapter.id);
  assert.deepEqual(detected.sort(), ['codex', 'opencode']);
});
