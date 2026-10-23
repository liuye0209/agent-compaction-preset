import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  timestamp,
  createBackup,
  writeWithBackup,
  atomicWrite,
  findLatestBackup,
  restoreExact,
  restoreBackup,
  applyTransaction,
} from '../lib/backup.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fixedNow = () => new Date('2026-10-19T12:00:00Z');

test('timestamp uses UTC YYYYMMDD-HHmmss', () => {
  assert.equal(timestamp(fixedNow()), '20261019-120000');
});

test('writeWithBackup writes new bytes and preserves old bytes', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  const { backupPath } = writeWithBackup(file, 'new', { now: fixedNow });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(fs.readFileSync(backupPath, 'utf8'), 'old');
  assert.match(path.basename(backupPath), /^settings\.json\.bak-agent-compact-20261019-120000$/);
});

test('atomicWrite leaves the original intact when replace fails', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  const failingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') return () => { throw new Error('EPERM'); };
      return target[prop];
    },
  });
  assert.throws(() => atomicWrite(file, 'new', { fs: failingFs }), /EPERM/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('.tmp-agent-compact-')),
    [],
  );
});

test('applyTransaction rolls back earlier writes when a later adapter fails', (t) => {
  const dir = tempDir(t);
  const fileA = path.join(dir, 'a.json');
  const fileB = path.join(dir, 'b.json');
  fs.writeFileSync(fileA, 'old-a');
  fs.writeFileSync(fileB, 'old-b');
  const adapterA = {
    apply: (ctx, plan) => writeWithBackup(plan.configPath, plan.nextContent, { fs, now: ctx.now }),
  };
  const adapterB = { apply: () => { throw new Error('boom'); } };
  assert.throws(() => applyTransaction([
    {
      agentId: 'a', configPath: fileA, adapter: adapterA,
      plan: { configPath: fileA, nextContent: 'new-a' }, ctx: { now: fixedNow },
    },
    {
      agentId: 'b', configPath: fileB, adapter: adapterB,
      plan: { configPath: fileB, nextContent: 'new-b' }, ctx: { now: fixedNow },
    },
  ], { fs, now: fixedNow }), /boom/);
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'old-a');
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'old-b');
});

test('restoreBackup creates a before-restore safety copy and findLatestBackup ignores it', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'current');
  const oldBackup = path.join(dir, 'settings.json.bak-agent-compact-20261019-110000');
  fs.writeFileSync(oldBackup, 'original');
  const beforeRestore = fs.readFileSync(file);
  const { safetyBackupPath } = restoreBackup(oldBackup, file, { fs, now: fixedNow });
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.match(path.basename(safetyBackupPath), /before-restore/);
  assert.deepEqual(fs.readFileSync(safetyBackupPath), beforeRestore);
  assert.equal(findLatestBackup(file, { fs }), oldBackup);
});

test('writeWithBackup creates missing parents and returns a null backup for a new file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'deeper', 'settings.json');
  const result = writeWithBackup(file, 'new', { now: fixedNow });
  assert.deepEqual(result, { backupPath: null });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('createBackup suffixes collisions and findLatestBackup picks the latest', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'v1');
  const first = createBackup(file, { now: fixedNow });
  const second = createBackup(file, { now: fixedNow });
  assert.equal(path.basename(first), 'settings.json.bak-agent-compact-20261019-120000');
  assert.equal(path.basename(second), 'settings.json.bak-agent-compact-20261019-120000-1');
  assert.equal(findLatestBackup(file, { fs }), second);

  fs.writeFileSync(file, 'v2');
  restoreExact(first, file, { fs });
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1');
});

test('applyTransaction skips noop plans and deletes newly created files on rollback', (t) => {
  const dir = tempDir(t);
  const created = path.join(dir, 'created.json');
  const noop = {
    agentId: 'noop',
    configPath: path.join(dir, 'noop.json'),
    adapter: { apply: () => { throw new Error('noop adapter must not run'); } },
    plan: { status: 'noop', configPath: path.join(dir, 'noop.json'), nextContent: 'x' },
    ctx: { now: fixedNow },
  };
  const creator = {
    agentId: 'creator',
    configPath: created,
    adapter: {
      apply: (ctx, plan) => writeWithBackup(plan.configPath, plan.nextContent, { fs, now: ctx.now }),
    },
    plan: { configPath: created, nextContent: 'created' },
    ctx: { now: fixedNow },
  };
  const failing = {
    agentId: 'failing',
    configPath: path.join(dir, 'failing.json'),
    adapter: { apply: () => { throw new Error('boom'); } },
    plan: { configPath: path.join(dir, 'failing.json'), nextContent: 'x' },
    ctx: { now: fixedNow },
  };

  assert.deepEqual(applyTransaction([noop], { fs, now: fixedNow }), { applied: [] });
  assert.throws(() => applyTransaction([creator, failing], { fs, now: fixedNow }), /boom/);
  assert.equal(fs.existsSync(created), false);
});

test('applyTransaction runs afterApply for noop plans and rolls back earlier writes', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'written.json');
  fs.writeFileSync(file, 'old');
  const creator = {
    agentId: 'creator',
    configPath: file,
    adapter: {
      apply: (ctx, plan) => writeWithBackup(plan.configPath, plan.nextContent, { fs, now: ctx.now }),
    },
    plan: { configPath: file, nextContent: 'new' },
    ctx: { now: fixedNow },
  };
  const noop = {
    agentId: 'noop',
    configPath: path.join(dir, 'noop.json'),
    adapter: { apply: () => { throw new Error('noop adapter must not run'); } },
    plan: { status: 'noop', configPath: path.join(dir, 'noop.json') },
    ctx: { now: fixedNow },
  };

  assert.throws(
    () =>
      applyTransaction([creator, noop], {
        fs,
        now: fixedNow,
        afterApply: (entry) => {
          if (entry.agentId === 'noop') throw new Error('noop verification failed');
        },
      }),
    /noop verification failed/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
});

test('atomicWrite preserves the POSIX mode when replacing a file', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o600);
  atomicWrite(file, 'new', { fs });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('atomicWrite creates a new file with owner-only permissions', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  atomicWrite(file, 'new', { fs });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('restoreExact preserves the backup mode for a missing target', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  const backup = path.join(dir, 'settings.json.bak-agent-compact-20261019-120000');
  fs.writeFileSync(backup, 'original');
  fs.chmodSync(backup, 0o640);

  restoreExact(backup, file, { fs });
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test('atomicWrite updates a symlink target instead of replacing the link', { skip: process.platform === 'win32' }, (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'real.json');
  const link = path.join(dir, 'settings.json');
  fs.writeFileSync(target, 'old');
  fs.symlinkSync(target, link);
  atomicWrite(link, 'new', { fs });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('applyTransaction rolls back the current entry when afterApply throws', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  const adapter = {
    apply: (ctx, plan) => writeWithBackup(plan.configPath, plan.nextContent, { fs, now: ctx.now }),
  };
  const seen = [];
  assert.throws(() => applyTransaction([
    {
      agentId: 'a', configPath: file, adapter,
      plan: { configPath: file, nextContent: 'new' }, ctx: { now: fixedNow },
    },
  ], {
    fs,
    now: fixedNow,
    afterApply: (entry) => {
      seen.push(entry.backupPath);
      throw new Error('verify failed');
    },
  }), /verify failed/);
  assert.equal(seen.length, 1);
  assert.match(path.basename(seen[0]), /^settings\.json\.bak-agent-compact-/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
});

test('applyTransaction deletes a newly created current entry when afterApply throws', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'settings.json');
  const adapter = {
    apply: (ctx, plan) => writeWithBackup(plan.configPath, plan.nextContent, { fs, now: ctx.now }),
  };
  assert.throws(() => applyTransaction([
    {
      agentId: 'a', configPath: file, adapter,
      plan: { configPath: file, nextContent: 'new' }, ctx: { now: fixedNow },
    },
  ], {
    fs,
    now: fixedNow,
    afterApply: () => { throw new Error('verify failed'); },
  }), /verify failed/);
  assert.equal(fs.existsSync(file), false);
});

test('applyTransaction reports applied entries', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  const adapter = {
    apply: (ctx, plan) => writeWithBackup(plan.configPath, plan.nextContent, { fs, now: ctx.now }),
  };
  const { applied } = applyTransaction([
    {
      agentId: 'a', configPath: file, adapter,
      plan: { configPath: file, nextContent: 'new' }, ctx: { now: fixedNow },
    },
  ], { fs, now: fixedNow });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].agentId, 'a');
  assert.equal(applied[0].configPath, file);
  assert.match(path.basename(applied[0].backupPath), /^settings\.json\.bak-agent-compact-20261019-120000$/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});
