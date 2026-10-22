import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../lib/cli.mjs';
import { tempHome, writeHomeFile } from './helpers.mjs';

function makeIO() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    get out() { return out.join(''); },
    get err() { return err.join(''); },
    isTTY: false,
  };
}

function backupFilesFor(file) {
  return fs.readdirSync(path.dirname(file))
    .filter((name) => name.includes('.bak-agent-compact-'));
}

test('restore --latest restores exact original bytes', async (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{"theme":"dark"}\n');
  const original = fs.readFileSync(file);
  const applied = makeIO();
  assert.equal(
    await runCli(['apply', '--yes', '--agents', 'opencode', '--json', '--home', home], applied),
    0,
    applied.err,
  );
  assert.notDeepEqual(fs.readFileSync(file), original);
  const io = makeIO();
  const code = await runCli(['restore', '--latest', '--yes', '--agents', 'opencode', '--json', '--home', home], io);
  assert.equal(code, 0, io.err);
  const report = JSON.parse(io.out);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.match(report.restored[0].safetyBackupPath, /before-restore/);
});

test('restore --file restores an explicit backup', async (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{}\n');
  const backup = path.join(path.dirname(file), `${path.basename(file)}.bak-agent-compact-20261019-120000`);
  fs.writeFileSync(backup, 'explicit\n');
  const io = makeIO();
  const code = await runCli(['restore', '--file', backup, '--yes', '--json', '--home', home], io);
  assert.equal(code, 0, io.err);
  assert.equal(fs.readFileSync(file, 'utf8'), 'explicit\n');
});

test('restore with no backups exits 2', async (t) => {
  const home = tempHome(t);
  writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{}\n');
  const io = makeIO();
  const code = await runCli(['restore', '--latest', '--yes', '--agents', 'opencode', '--home', home], io);
  assert.equal(code, 2);
});

test('restore defaults to latest when neither --latest nor --file is given', async (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{"theme":"dark"}\n');
  const original = fs.readFileSync(file);
  const applied = makeIO();
  assert.equal(
    await runCli(['apply', '--yes', '--agents', 'opencode', '--json', '--home', home], applied),
    0,
    applied.err,
  );
  const io = makeIO();
  const code = await runCli(['restore', '--yes', '--agents', 'opencode', '--json', '--home', home], io);
  assert.equal(code, 0, io.err);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('restore rejects --file and --latest together', async (t) => {
  const home = tempHome(t);
  const io = makeIO();
  const code = await runCli(
    ['restore', '--file', 'x.bak-agent-compact-20261019-120000', '--latest', '--yes', '--home', home],
    io,
  );
  assert.equal(code, 1);
  assert.match(io.err, /--file|--latest/);
});

test('restore --file rejects a path without the backup suffix and does not write', async (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{}\n');
  const before = fs.readFileSync(file);
  const io = makeIO();
  const code = await runCli(['restore', '--file', file, '--yes', '--json', '--home', home], io);
  assert.equal(code, 1);
  assert.match(io.err, /bak-agent-compact/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(backupFilesFor(file), []);
});

test('restore without --yes refuses non-interactive writes', async (t) => {
  const home = tempHome(t);
  writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{}\n');
  const applied = makeIO();
  assert.equal(
    await runCli(['apply', '--yes', '--agents', 'opencode', '--json', '--home', home], applied),
    0,
    applied.err,
  );
  const io = makeIO();
  const code = await runCli(['restore', '--latest', '--agents', 'opencode', '--home', home], io);
  assert.equal(code, 1);
  assert.match(io.err, /--yes/);
});

test('restore human output lists paths and warnings', async (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{}\n');
  const applied = makeIO();
  assert.equal(
    await runCli(['apply', '--yes', '--agents', 'opencode', '--json', '--home', home], applied),
    0,
    applied.err,
  );
  const io = makeIO();
  const code = await runCli(['restore', '--latest', '--yes', '--agents', 'opencode', '--home', home], io);
  assert.equal(code, 0, io.err);
  assert.match(io.out, /Restored:/);
  assert.match(io.out, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(io.out, /backup:/);
  assert.match(io.out, /safety backup:/);
});
