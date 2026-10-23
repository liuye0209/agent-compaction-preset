import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import opencode from '../lib/agents/opencode.mjs';
import { resolvePolicy } from '../lib/policy.mjs';
import { tempHome, writeHomeFile, makeCtx } from './helpers.mjs';

const policy = resolvePolicy();
const relative = path.join('.config', 'opencode', 'opencode.json');

test('OpenCode plan targets 190K trigger and 50K retention', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, relative, '{}\n');
  const plan = opencode.plan(makeCtx(home), policy);
  assert.equal(plan.support, 'full');
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.effective, { trigger: 190000, keep: 50000 });
  assert.deepEqual(plan.changes.map((c) => c.key), [
    'compaction.auto',
    'compaction.keep.tokens',
    'compaction.buffer',
  ]);
});

test('OpenCode apply writes, backs up, and verify reads back', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, relative, '{}\n');
  const ctx = makeCtx(home);
  const plan = opencode.plan(ctx, policy);
  const result = opencode.apply(ctx, plan);
  assert.equal(fs.existsSync(result.backupPath), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.compaction.auto, true);
  assert.deepEqual(parsed.compaction.keep, { tokens: 50000 });
  assert.equal(parsed.compaction.buffer, 10000);
  assert.deepEqual(opencode.verify(ctx, policy), {
    effective: { trigger: 190000, keep: 50000 },
    warnings: [],
    ok: true,
  });
});

test('OpenCode JSONC-only is manual and is never rewritten', (t) => {
  const home = tempHome(t);
  const jsonc = writeHomeFile(home, path.join('.config', 'opencode', 'opencode.jsonc'), '// comment\n{}\n');
  const plan = opencode.plan(makeCtx(home), policy);
  assert.equal(plan.status, 'manual');
  assert.match(plan.template, /"compaction"/);
  assert.equal(fs.readFileSync(jsonc, 'utf8'), '// comment\n{}\n');
  assert.equal(fs.existsSync(path.join(home, relative)), false);
});

test('OpenCode preserves unrelated compaction keys and warns about JSONC', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, relative, JSON.stringify({ compaction: { auto: false, other: true } }, null, 2));
  writeHomeFile(home, path.join('.config', 'opencode', 'opencode.jsonc'), '{}\n');
  const plan = opencode.plan(makeCtx(home), policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.compaction.other, true);
  assert.match(plan.warnings.join(' '), /jsonc/i);
});

test('OpenCode missing config requires --create', (t) => {
  const home = tempHome(t);
  const ctx = makeCtx(home);
  const plan = opencode.plan(ctx, policy);
  assert.equal(plan.status, 'missing');
  assert.throws(() => opencode.apply(ctx, plan), /--create/);
  assert.equal(fs.existsSync(path.join(home, relative)), false);
  assert.doesNotThrow(() => opencode.apply({ ...ctx, create: true }, plan));
  assert.equal(fs.existsSync(path.join(home, relative)), true);
});

test('OpenCode already-configured file is a noop and apply creates no backup', (t) => {
  const home = tempHome(t);
  const content = `${JSON.stringify({
    compaction: { auto: true, keep: { tokens: 50000 }, buffer: 10000 },
  }, null, 2)}\n`;
  const file = writeHomeFile(home, relative, content);
  const ctx = makeCtx(home);
  const plan = opencode.plan(ctx, policy);
  assert.equal(plan.status, 'noop');
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(opencode.apply(ctx, plan), { backupPath: null });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)),
    ['opencode.json'],
  );
});

test('OpenCode rejects JSON with comments', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, relative, '// comment\n{}\n');
  assert.throws(() => opencode.plan(makeCtx(home), policy), /JSON comments/);
});

test('OpenCode refuses to apply a JSONC-only plan and print matches the template', (t) => {
  const home = tempHome(t);
  const jsonc = writeHomeFile(home, path.join('.config', 'opencode', 'opencode.jsonc'), '// comment\n{}\n');
  const ctx = makeCtx(home);
  const plan = opencode.plan(ctx, policy);
  assert.throws(() => opencode.apply(ctx, plan), /manual/i);
  assert.equal(fs.readFileSync(jsonc, 'utf8'), '// comment\n{}\n');
  const template = opencode.print(ctx, policy);
  assert.equal(template, plan.template);
  assert.deepEqual(JSON.parse(template), {
    compaction: { auto: true, keep: { tokens: 50000 }, buffer: 10000 },
  });
});
