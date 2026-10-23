import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import codex from '../lib/agents/codex.mjs';
import { resolvePolicy } from '../lib/policy.mjs';
import { tempHome, writeHomeFile, makeCtx } from './helpers.mjs';

const policy = resolvePolicy();
const relative = path.join('.codex', 'config.toml');

function assertNoBackup(file) {
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
}

test('Codex plan writes absolute trigger and context', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, relative, 'model = "deepseek-flash"\n');
  const plan = codex.plan(makeCtx(home), policy);
  assert.equal(plan.support, 'partial');
  assert.deepEqual(plan.effective, { trigger: 190000, keep: null });
  assert.match(plan.nextContent, /model_context_window = 200000/);
  assert.match(plan.nextContent, /model_auto_compact_token_limit = 190000/);
});

test('Codex apply preserves bearer token and warns about profile keys', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, relative, [
    'model = "deepseek-flash"',
    '',
    '[model_providers.custom]',
    'experimental_bearer_token = "sk-test-not-real"',
    '',
    '[profiles.small]',
    'model_auto_compact_token_limit = 32000',
    '',
  ].join('\n'));
  const ctx = makeCtx(home);
  const plan = codex.plan(ctx, policy);
  assert.match(plan.warnings.join(' '), /profiles/i);
  codex.apply(ctx, plan);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /experimental_bearer_token = "sk-test-not-real"/);
  assert.match(text, /model_auto_compact_token_limit = 32000/);
  assert.match(text, /model_auto_compact_token_limit = 190000/);
  assert.equal(JSON.stringify(plan.changes).includes('sk-test-not-real'), false);
});

test('Codex verify reads top-level values', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, relative, 'model_context_window = 200000\nmodel_auto_compact_token_limit = 190000\n');
  assert.deepEqual(codex.verify(makeCtx(home), policy), {
    effective: { trigger: 190000, keep: null },
    warnings: [],
    ok: true,
  });
});

test('Codex detect is safe when no config or CLI exists', (t) => {
  const home = tempHome(t);
  const result = codex.detect(makeCtx(home));
  assert.deepEqual(result, {
    detected: false,
    configPath: path.join(home, relative),
    notes: [],
  });
});

test('Codex detect honors CODEX_HOME and tolerates a failing CLI probe', (t) => {
  const home = tempHome(t);
  const custom = path.join(home, 'custom-codex');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'config.toml'), '');
  const ctx = makeCtx(home, {
    env: { CODEX_HOME: custom },
    runCommand: () => {
      throw new Error('spawn failed');
    },
  });
  const result = codex.detect(ctx);
  assert.equal(result.detected, true);
  assert.equal(result.configPath, path.join(custom, 'config.toml'));
  assert.deepEqual(result.notes, []);
});

test('Codex missing config requires --create and creates without a backup', (t) => {
  const home = tempHome(t);
  const ctx = makeCtx(home);
  const plan = codex.plan(ctx, policy);
  assert.equal(plan.status, 'missing');
  assert.deepEqual(plan.changes, [
    { key: 'model_context_window', from: null, to: 200000 },
    { key: 'model_auto_compact_token_limit', from: null, to: 190000 },
  ]);
  assert.equal(fs.existsSync(path.join(home, relative)), false);
  assert.throws(() => codex.apply(ctx, plan), /--create/);
  assert.equal(fs.existsSync(path.join(home, relative)), false);

  const createCtx = { ...ctx, create: true };
  assert.deepEqual(codex.apply(createCtx, plan), { backupPath: null });
  assert.equal(fs.existsSync(path.join(home, relative)), true);
  assert.deepEqual(codex.verify(createCtx, policy), {
    effective: { trigger: 190000, keep: null },
    warnings: [],
    ok: true,
  });
});

test('Codex apply writes with a backup and verify reads it back', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, relative, 'model = "deepseek-flash"\n');
  const ctx = makeCtx(home);
  const plan = codex.plan(ctx, policy);
  assert.equal(plan.status, 'planned');
  const result = codex.apply(ctx, plan);
  assert.deepEqual(Object.keys(result), ['backupPath']);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), 'model = "deepseek-flash"\n');
  assert.deepEqual(codex.verify(ctx, policy), {
    effective: { trigger: 190000, keep: null },
    warnings: [],
    ok: true,
  });
  assert.equal(fs.existsSync(file), true);
});

test('Codex already-configured file is a noop and apply creates no backup', (t) => {
  const home = tempHome(t);
  const content = 'model_context_window = 200000\nmodel_auto_compact_token_limit = 190000\n';
  const file = writeHomeFile(home, relative, content);
  const ctx = makeCtx(home);
  const plan = codex.plan(ctx, policy);
  assert.equal(plan.status, 'noop');
  assert.deepEqual(plan.changes, []);
  assert.equal('nextContent' in plan, false);
  assert.deepEqual(codex.apply(ctx, plan), { backupPath: null });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);
});

test('Codex plan is read-only and preserves a CRLF config while planning', (t) => {
  const home = tempHome(t);
  const content = 'model_context_window = 100000\r\nmodel_auto_compact_token_limit = 180000\r\n';
  const file = writeHomeFile(home, relative, content);
  const plan = codex.plan(makeCtx(home), policy);
  assert.equal(plan.status, 'planned');
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);
  assert.match(plan.nextContent, /model_context_window = 200000\r\n/);
  assert.match(plan.nextContent, /model_auto_compact_token_limit = 190000\r\n/);
});

test('Codex verify reports a missing config without throwing', (t) => {
  const home = tempHome(t);
  const result = codex.verify(makeCtx(home), policy);
  assert.deepEqual(result.effective, { trigger: null, keep: null });
  assert.equal(result.ok, false);
  assert.match(result.warnings.join(' '), /does not exist/);
});

test('Codex verify reports mismatched and missing top-level values', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, relative, 'model_context_window = 100000\nmodel_auto_compact_token_limit = 180000\n');
  const mismatched = codex.verify(makeCtx(home), policy);
  assert.deepEqual(mismatched.effective, { trigger: 180000, keep: null });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.warnings.join(' '), /model_context_window/);
  assert.match(mismatched.warnings.join(' '), /model_auto_compact_token_limit/);

  const missingHome = tempHome(t);
  writeHomeFile(missingHome, relative, 'model_context_window = 200000\n');
  const missing = codex.verify(makeCtx(missingHome), policy);
  assert.deepEqual(missing.effective, { trigger: null, keep: null });
  assert.equal(missing.ok, false);
  assert.match(missing.warnings.join(' '), /model_auto_compact_token_limit is missing/);
});

test('Codex plan inserts target keys before a quoted profile table', (t) => {
  const home = tempHome(t);
  writeHomeFile(
    home,
    relative,
    [
      'model = "deepseek-flash"',
      '',
      '[profiles."a[b]"]',
      'model_context_window = 64000',
      '',
    ].join('\n'),
  );
  const plan = codex.plan(makeCtx(home), policy);

  assert.equal(plan.status, 'planned');
  assert.match(plan.warnings.join(' '), /a\[b\]/);
  assert.ok(
    plan.nextContent.indexOf('model_context_window = 200000') <
      plan.nextContent.indexOf('[profiles."a[b]"]'),
  );
  assert.match(
    plan.nextContent,
    /\[profiles\."a\[b\]"\]\nmodel_context_window = 64000/,
  );
});

test('Codex plan rejects an unclosed TOML value after matching keys', (t) => {
  const home = tempHome(t);
  writeHomeFile(
    home,
    relative,
    [
      'model_context_window = 200000',
      'model_auto_compact_token_limit = 190000',
      'model = """',
      '',
    ].join('\n'),
  );

  assert.throws(
    () => codex.plan(makeCtx(home), policy),
    /Ambiguous TOML.*multiline/i,
  );
});

test('Codex verify rejects an unclosed TOML value after matching keys', (t) => {
  const home = tempHome(t);
  writeHomeFile(
    home,
    relative,
    [
      'model_context_window = 200000',
      'model_auto_compact_token_limit = 190000',
      '',
      '[profiles.small]',
      'model = """',
      '',
    ].join('\n'),
  );

  assert.throws(
    () => codex.verify(makeCtx(home), policy),
    /Ambiguous TOML.*multiline/i,
  );
});

test('Codex verify warns about target keys inside profile tables', (t) => {
  const home = tempHome(t);
  writeHomeFile(
    home,
    relative,
    [
      'model_context_window = 200000',
      'model_auto_compact_token_limit = 190000',
      '',
      '[profiles.small]',
      'model_auto_compact_token_limit = 32000',
      '',
    ].join('\n'),
  );
  const result = codex.verify(makeCtx(home), policy);

  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' '), /profiles\.small/);
});

test('Codex print returns the two-line TOML snippet', (t) => {
  const home = tempHome(t);
  assert.equal(
    codex.print(makeCtx(home), policy),
    'model_context_window = 200000\nmodel_auto_compact_token_limit = 190000\n',
  );
});
