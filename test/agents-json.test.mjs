import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import claude from '../lib/agents/claude.mjs';
import gemini from '../lib/agents/gemini.mjs';
import qwen from '../lib/agents/qwen.mjs';
import { readJsonFile } from '../lib/agents/common.mjs';
import { resolvePolicy } from '../lib/policy.mjs';
import { tempHome, writeHomeFile, makeCtx } from './helpers.mjs';

const policy = resolvePolicy();
const claudePath = path.join('.claude', 'settings.json');
const geminiPath = path.join('.gemini', 'settings.json');
const qwenPath = path.join('.qwen', 'settings.json');

function claudeCtx(home, version = '2.1.300') {
  return makeCtx(home, {
    runCommand: () => ({ status: 0, stdout: `${version}\n`, stderr: '' }),
  });
}

function missingCliCtx(home) {
  return makeCtx(home, {
    runCommand: () => ({ status: 1, stdout: '', stderr: 'not found' }),
  });
}

function assertNoBackup(file) {
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
}

test('JSON parse errors report only the path and an optional position', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(
    home,
    path.join('.config', 'opencode', 'opencode.json'),
    '{"token":"sk-test-not-real",}\n',
  );
  let message;

  try {
    readJsonFile(makeCtx(home), file);
  } catch (error) {
    message = error.message;
  }

  assert.ok(message, 'expected readJsonFile to throw');
  assert.match(message, /^Invalid JSON in .*opencode\.json(?: at position \d+)?$/);
  assert.equal(message.includes('sk-test-not-real'), false);
  assert.equal(message.includes('"token"'), false);
});

test('Claude Code writes both keys on a supported version', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  const ctx = claudeCtx(home);
  const plan = claude.plan(ctx, policy);
  assert.equal(plan.support, 'partial');
  assert.deepEqual(plan.effective, { trigger: 190000, keep: null });
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.autoCompactEnabled, true);
  assert.equal(parsed.autoCompactWindow, 190000);
});

test('Claude Code older than 2.1.288 only sets the boolean', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  const plan = claude.plan(claudeCtx(home, '2.1.200'), policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.autoCompactEnabled, true);
  assert.equal(parsed.autoCompactWindow, undefined);
  assert.equal(plan.effective.trigger, null);
  assert.match(plan.warnings.join(' '), /2\.1\.288/);
});

test('Claude Code refuses a trigger below 100K', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  assert.throws(
    () => claude.plan(claudeCtx(home), resolvePolicy({ context: 100000, trigger: 95000, keep: 50000 })),
    /100000/,
  );
});

test('Claude Code does not apply the 100K minimum when the window is omitted', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  const plan = claude.plan(
    claudeCtx(home, '2.1.200'),
    resolvePolicy({ context: 100000, trigger: 95000, keep: 50000 }),
  );
  assert.equal(plan.effective.trigger, null);
  assert.equal(JSON.parse(plan.nextContent).autoCompactWindow, undefined);
});

test('Claude Code detect reads the config and parses the CLI version', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, claudePath, '{}\n');
  const calls = [];
  const ctx = makeCtx(home, {
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '2.1.300 (Claude Code)\n', stderr: '' };
    },
  });
  const detected = claude.detect(ctx);
  assert.equal(detected.detected, true);
  assert.equal(detected.configPath, file);
  assert.equal(detected.version, '2.1.300');
  assert.deepEqual(calls, [
    { command: 'claude', args: ['--version'], options: { timeout: 2000 } },
  ]);
});

test('Claude Code unknown version writes both keys and reports 190000', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  const plan = claude.plan(missingCliCtx(home), policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.autoCompactEnabled, true);
  assert.equal(parsed.autoCompactWindow, 190000);
  assert.deepEqual(plan.effective, { trigger: 190000, keep: null });
  assert.match(plan.warnings.join(' '), /could not determine/i);
  assert.match(plan.warnings.join(' '), /2\.1\.288/);
});

test('Claude Code unknown version still enforces the 100K minimum', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  assert.throws(
    () => claude.plan(
      missingCliCtx(home),
      resolvePolicy({ context: 100000, trigger: 95000, keep: 50000 }),
    ),
    /100000/,
  );
});

test('Claude Code treats a throwing version probe as unknown', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  const ctx = makeCtx(home, {
    runCommand: () => {
      throw new Error('spawn failed');
    },
  });
  const plan = claude.plan(ctx, policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.autoCompactEnabled, true);
  assert.equal(parsed.autoCompactWindow, 190000);
  assert.deepEqual(plan.effective, { trigger: 190000, keep: null });
  assert.match(plan.warnings.join(' '), /could not determine/i);
});

test('Claude Code apply writes with a backup and verify reads it back', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, claudePath, '{}\n');
  const ctx = claudeCtx(home);
  const plan = claude.plan(ctx, policy);
  assert.equal(plan.status, 'planned');
  const result = claude.apply(ctx, plan);
  assert.deepEqual(Object.keys(result), ['backupPath']);
  assert.equal(fs.existsSync(result.backupPath), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.autoCompactEnabled, true);
  assert.equal(parsed.autoCompactWindow, 190000);
  assert.deepEqual(claude.verify(ctx, policy), {
    effective: { trigger: 190000, keep: null },
    warnings: [],
    ok: true,
  });
});

test('Claude Code missing config requires --create and plan is read-only', (t) => {
  const home = tempHome(t);
  const ctx = claudeCtx(home);
  const plan = claude.plan(ctx, policy);
  assert.equal(plan.status, 'missing');
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.autoCompactEnabled, true);
  assert.equal(parsed.autoCompactWindow, 190000);
  assert.equal(fs.existsSync(path.join(home, claudePath)), false);
  assert.throws(() => claude.apply(ctx, plan), /--create/);
  assert.equal(fs.existsSync(path.join(home, claudePath)), false);
  assert.deepEqual(claude.apply({ ...ctx, create: true }, plan), { backupPath: null });
  assert.equal(fs.existsSync(path.join(home, claudePath)), true);
});

test('Claude Code already-configured file is a noop and apply creates no backup', (t) => {
  const home = tempHome(t);
  const content = `${JSON.stringify({
    autoCompactEnabled: true,
    autoCompactWindow: 190000,
  }, null, 2)}\n`;
  const file = writeHomeFile(home, claudePath, content);
  const ctx = claudeCtx(home);
  const plan = claude.plan(ctx, policy);
  assert.equal(plan.status, 'noop');
  assert.deepEqual(plan.changes, []);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.deepEqual(claude.apply(ctx, plan), { backupPath: null });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);
});

test('Claude Code rejects JSON with comments and print matches the template', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '// comment\n{}\n');
  assert.throws(() => claude.plan(claudeCtx(home), policy), /JSON comments/);

  const emptyHome = tempHome(t);
  const supported = claude.print(claudeCtx(emptyHome), policy);
  assert.deepEqual(JSON.parse(supported), {
    autoCompactEnabled: true,
    autoCompactWindow: 190000,
  });
  const legacy = claude.print(claudeCtx(emptyHome, '2.1.200'), policy);
  assert.deepEqual(JSON.parse(legacy), { autoCompactEnabled: true });
  const unknown = claude.print(missingCliCtx(emptyHome), policy);
  assert.deepEqual(JSON.parse(unknown), {
    autoCompactEnabled: true,
    autoCompactWindow: 190000,
  });
});

test('Claude Code verify requires the window on supported versions', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, `${JSON.stringify({
    autoCompactEnabled: true,
  }, null, 2)}\n`);
  const result = claude.verify(claudeCtx(home), policy);
  assert.equal(result.effective.trigger, null);
  assert.equal(result.ok, false);
  assert.match(result.warnings.join(' '), /autoCompactWindow/);
});

test('Claude Code verify requires the window when the version is unknown', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, `${JSON.stringify({
    autoCompactEnabled: true,
  }, null, 2)}\n`);
  const result = claude.verify(missingCliCtx(home), policy);
  assert.equal(result.ok, false);
  assert.match(result.warnings.join(' '), /autoCompactWindow/);
});

test('Claude Code verify rejects a wrong window', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, `${JSON.stringify({
    autoCompactEnabled: true,
    autoCompactWindow: 180000,
  }, null, 2)}\n`);
  const result = claude.verify(claudeCtx(home), policy);
  assert.equal(result.effective.trigger, 180000);
  assert.equal(result.ok, false);
  assert.match(result.warnings.join(' '), /autoCompactWindow/);
});

test('Claude Code verify accepts correct keys for supported and unknown versions', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, `${JSON.stringify({
    autoCompactEnabled: true,
    autoCompactWindow: 190000,
  }, null, 2)}\n`);
  assert.deepEqual(claude.verify(claudeCtx(home), policy), {
    effective: { trigger: 190000, keep: null },
    warnings: [],
    ok: true,
  });
  assert.deepEqual(claude.verify(missingCliCtx(home), policy), {
    effective: { trigger: 190000, keep: null },
    warnings: [],
    ok: true,
  });
});

test('Claude Code verify tolerates a missing window on old versions', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, `${JSON.stringify({
    autoCompactEnabled: true,
  }, null, 2)}\n`);
  const result = claude.verify(claudeCtx(home, '2.1.200'), policy);
  assert.deepEqual(result, {
    effective: { trigger: null, keep: null },
    warnings: [],
    ok: true,
  });
});

test('Claude Code verify validates a window present on an old version', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, `${JSON.stringify({
    autoCompactEnabled: true,
    autoCompactWindow: 180000,
  }, null, 2)}\n`);
  const result = claude.verify(claudeCtx(home, '2.1.200'), policy);
  assert.equal(result.effective.trigger, 180000);
  assert.equal(result.ok, false);
  assert.match(result.warnings.join(' '), /autoCompactWindow/);
});

test('Gemini writes the new threshold key and reports 190K', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, geminiPath, '{}\n');
  const plan = gemini.plan(makeCtx(home), policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.model.compressionThreshold, 0.95);
  assert.deepEqual(plan.effective, { trigger: 190000, keep: null });
});

test('Gemini updates the legacy key when it is the only one present', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, geminiPath, JSON.stringify({
    model: { chatCompression: { contextPercentageThreshold: 0.5 } },
  }, null, 2));
  const plan = gemini.plan(makeCtx(home), policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.model.chatCompression.contextPercentageThreshold, 0.95);
  assert.equal(parsed.model.compressionThreshold, undefined);
  assert.match(plan.warnings.join(' '), /legacy/i);
});

test('Gemini updates the new key and keeps the legacy key when both exist', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, geminiPath, JSON.stringify({
    model: {
      compressionThreshold: 0.5,
      chatCompression: { contextPercentageThreshold: 0.6 },
    },
  }, null, 2));
  const plan = gemini.plan(makeCtx(home), policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.model.compressionThreshold, 0.95);
  assert.equal(parsed.model.chatCompression.contextPercentageThreshold, 0.6);
  assert.match(plan.warnings.join(' '), /legacy/i);
});

test('Gemini missing config requires --create and apply returns its backup result', (t) => {
  const home = tempHome(t);
  const ctx = makeCtx(home);
  const plan = gemini.plan(ctx, policy);
  assert.equal(plan.status, 'missing');
  assert.equal(JSON.parse(plan.nextContent).model.compressionThreshold, 0.95);
  assert.throws(() => gemini.apply(ctx, plan), /--create/);
  assert.equal(fs.existsSync(path.join(home, geminiPath)), false);
  assert.deepEqual(gemini.apply({ ...ctx, create: true }, plan), { backupPath: null });

  const existingHome = tempHome(t);
  const file = writeHomeFile(existingHome, geminiPath, '{}\n');
  const existingCtx = makeCtx(existingHome);
  const existingPlan = gemini.plan(existingCtx, policy);
  const result = gemini.apply(existingCtx, existingPlan);
  assert.deepEqual(Object.keys(result), ['backupPath']);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.notEqual(file, result.backupPath);
});

test('Gemini already-configured file is a noop and apply creates no backup', (t) => {
  const home = tempHome(t);
  const content = `${JSON.stringify({ model: { compressionThreshold: 0.95 } }, null, 2)}\n`;
  const file = writeHomeFile(home, geminiPath, content);
  const ctx = makeCtx(home);
  const plan = gemini.plan(ctx, policy);
  assert.equal(plan.status, 'noop');
  assert.deepEqual(plan.changes, []);
  assert.deepEqual(gemini.apply(ctx, plan), { backupPath: null });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);
});

test('Gemini rejects JSON with comments and print matches the template', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, geminiPath, '// comment\n{}\n');
  assert.throws(() => gemini.plan(makeCtx(home), policy), /JSON comments/);
  assert.deepEqual(JSON.parse(gemini.print(makeCtx(home), policy)), {
    model: { compressionThreshold: 0.95 },
  });
});

test('Gemini verify reads the legacy key when the new key is absent', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, geminiPath, JSON.stringify({
    model: { chatCompression: { contextPercentageThreshold: 0.95 } },
  }, null, 2));
  const result = gemini.verify(makeCtx(home), policy);
  assert.equal(result.effective.trigger, 190000);
  assert.equal(result.effective.keep, null);
  assert.match(result.warnings.join(' '), /legacy/i);
});

test('Qwen writes autoCompactThreshold and warns about the retired key', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, qwenPath, JSON.stringify({
    model: { chatCompression: { contextPercentageThreshold: 0.5 } },
  }, null, 2));
  const plan = qwen.plan(makeCtx(home), policy);
  const parsed = JSON.parse(plan.nextContent);
  assert.equal(parsed.context.autoCompactThreshold, 0.95);
  assert.match(plan.warnings.join(' '), /ignored|retired/i);
});

test('Qwen warns about its internal ladder and reports the target trigger', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, qwenPath, '{}\n');
  const plan = qwen.plan(makeCtx(home), policy);
  assert.equal(plan.support, 'partial');
  assert.deepEqual(plan.effective, { trigger: 190000, keep: null });
  assert.match(plan.warnings.join(' '), /warn.*auto.*hard|ladder/i);
});

test('Qwen missing config requires --create and apply returns its backup result', (t) => {
  const home = tempHome(t);
  const ctx = makeCtx(home);
  const plan = qwen.plan(ctx, policy);
  assert.equal(plan.status, 'missing');
  assert.equal(JSON.parse(plan.nextContent).context.autoCompactThreshold, 0.95);
  assert.throws(() => qwen.apply(ctx, plan), /--create/);
  assert.equal(fs.existsSync(path.join(home, qwenPath)), false);
  assert.deepEqual(qwen.apply({ ...ctx, create: true }, plan), { backupPath: null });

  const existingHome = tempHome(t);
  const file = writeHomeFile(existingHome, qwenPath, '{}\n');
  const existingCtx = makeCtx(existingHome);
  const result = qwen.apply(existingCtx, qwen.plan(existingCtx, policy));
  assert.deepEqual(Object.keys(result), ['backupPath']);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.notEqual(file, result.backupPath);
});

test('Qwen already-configured file is a noop and apply creates no backup', (t) => {
  const home = tempHome(t);
  const content = `${JSON.stringify({ context: { autoCompactThreshold: 0.95 } }, null, 2)}\n`;
  const file = writeHomeFile(home, qwenPath, content);
  const ctx = makeCtx(home);
  const plan = qwen.plan(ctx, policy);
  assert.equal(plan.status, 'noop');
  assert.deepEqual(plan.changes, []);
  assert.match(plan.warnings.join(' '), /ladder/i);
  assert.deepEqual(qwen.apply(ctx, plan), { backupPath: null });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);
});

test('Qwen rejects JSON with comments and print matches the template', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, qwenPath, '// comment\n{}\n');
  assert.throws(() => qwen.plan(makeCtx(home), policy), /JSON comments/);
  assert.deepEqual(JSON.parse(qwen.print(makeCtx(home), policy)), {
    context: { autoCompactThreshold: 0.95 },
  });
});

test('the three partial adapters verify their effective trigger', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  writeHomeFile(home, geminiPath, '{}\n');
  writeHomeFile(home, qwenPath, '{}\n');
  const c = claude.plan(claudeCtx(home), policy);
  claude.apply(claudeCtx(home), c);
  assert.equal(claude.verify(claudeCtx(home), policy).effective.trigger, 190000);
  const g = gemini.plan(makeCtx(home), policy);
  gemini.apply(makeCtx(home), g);
  assert.equal(gemini.verify(makeCtx(home), policy).effective.trigger, 190000);
  const q = qwen.plan(makeCtx(home), policy);
  qwen.apply(makeCtx(home), q);
  assert.equal(qwen.verify(makeCtx(home), policy).effective.trigger, 190000);
});

test('the three partial adapters keep retention unreported', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, claudePath, '{}\n');
  writeHomeFile(home, geminiPath, '{}\n');
  writeHomeFile(home, qwenPath, '{}\n');
  assert.equal(claude.plan(claudeCtx(home), policy).effective.keep, null);
  assert.equal(gemini.plan(makeCtx(home), policy).effective.keep, null);
  assert.equal(qwen.plan(makeCtx(home), policy).effective.keep, null);
});
