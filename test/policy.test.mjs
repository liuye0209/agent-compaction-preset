import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY,
  resolvePolicy,
  ratioFor,
  dshEffectiveTrigger,
} from '../lib/policy.mjs';

test('default policy is 200K/190K/50K', () => {
  assert.deepEqual(DEFAULT_POLICY, {
    context: 200000,
    trigger: 190000,
    keep: 50000,
  });
  assert.deepEqual(resolvePolicy(), {
    context: 200000,
    trigger: 190000,
    keep: 50000,
  });
});

test('accepts a smaller context', () => {
  assert.deepEqual(
    resolvePolicy({ context: 100000, trigger: 95000, keep: 50000 }),
    { context: 100000, trigger: 95000, keep: 50000 },
  );
});

test('rejects invalid windows', () => {
  assert.throws(() => resolvePolicy({ context: 0 }), /context/);
  assert.throws(() => resolvePolicy({ trigger: 200000 }), /trigger/);
  assert.throws(() => resolvePolicy({ keep: 190000 }), /keep/);
  assert.throws(() => resolvePolicy({ trigger: 50000 }), /keep/);
});

test('computes ratio and DSH effective trigger', () => {
  const policy = resolvePolicy();
  assert.equal(ratioFor(policy), 0.95);
  assert.equal(dshEffectiveTrigger(policy), 190000);
  assert.equal(dshEffectiveTrigger(policy, { maxTokens: 32000 }), 168000);
});
