import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlan, toJsonReport, toHumanReport } from '../lib/report.mjs';

const plan = {
  agentId: 'opencode',
  name: 'OpenCode',
  support: 'full',
  status: 'planned',
  configPath: '/home/u/.config/opencode/opencode.json',
  changes: [{ key: 'compaction.buffer', from: null, to: 10000 }],
  effective: { trigger: 190000, keep: 50000 },
  warnings: [],
  nextContent: '{"secret":"sk-test-not-real"}',
};
const result = {
  version: '0.1.0',
  command: 'plan',
  policy: { context: 200000, trigger: 190000, keep: 50000 },
  agents: [plan],
};

test('sanitizePlan removes file contents', () => {
  const safe = sanitizePlan(plan);
  assert.equal(Object.hasOwn(safe, 'nextContent'), false);
  assert.equal(Object.hasOwn(safe, 'currentContent'), false);
  assert.equal(safe.agentId, 'opencode');
});

test('sanitizePlan adds the id alias without clobbering an existing id', () => {
  assert.equal(sanitizePlan(plan).id, 'opencode');
  assert.equal(sanitizePlan({ ...plan, id: 'custom' }).id, 'custom');
  assert.equal(plan.nextContent, '{"secret":"sk-test-not-real"}');
});

test('JSON report contains no secrets or nextContent', () => {
  const json = toJsonReport(result);
  assert.equal(json.includes('sk-test-not-real'), false);
  assert.equal(json.includes('nextContent'), false);
  assert.equal(JSON.parse(json).agents[0].effective.trigger, 190000);
});

test('human report includes support and effective values', () => {
  const human = toHumanReport(result, { color: false });
  assert.match(human, /OpenCode/);
  assert.match(human, /full/);
  assert.match(human, /190000/);
  assert.match(human, /50000/);
  assert.equal(human.includes('sk-test-not-real'), false);
  assert.equal(/\x1b\[/.test(human), false);
});
