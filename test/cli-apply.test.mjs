import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../lib/cli.mjs';
import { tempHome, writeHomeFile } from './helpers.mjs';

function makeIO(overrides = {}) {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    get out() { return out.join(''); },
    get err() { return err.join(''); },
    isTTY: false,
    env: {},
    ...overrides,
  };
}

function setup(home) {
  const opencode = writeHomeFile(
    home, path.join('.config', 'opencode', 'opencode.json'), '{}\n',
  );
  const codex = writeHomeFile(home, path.join('.codex', 'config.toml'), [
    'model = "deepseek-flash"',
    '',
    '[model_providers.custom]',
    'experimental_bearer_token = "sk-test-not-real"',
    '',
  ].join('\n'));
  return { opencode, codex };
}

function backupsFor(file) {
  const dir = path.dirname(file);
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${path.basename(file)}.bak-agent-compact-`));
}

test('apply writes, backs up, verifies, and is idempotent', async (t) => {
  const home = tempHome(t);
  const { opencode } = setup(home);
  const io = makeIO();
  const code = await runCli(['apply', '--yes', '--agents', 'opencode', '--json', '--home', home], io);
  assert.equal(code, 0, io.err);
  const report = JSON.parse(io.out);
  assert.equal(report.command, 'apply');
  assert.equal(report.applied.length, 1);
  assert.equal(report.agents[0].configPath, opencode);
  assert.equal(report.agents[0].effective.trigger, 190000);
  assert.equal(report.agents[0].ok, true);
  assert.equal(backupsFor(opencode).length, 1);
  const second = makeIO();
  const code2 = await runCli(['apply', '--yes', '--agents', 'opencode', '--json', '--home', home], second);
  assert.equal(code2, 0, second.err);
  assert.equal(JSON.parse(second.out).applied.length, 0);
  assert.equal(backupsFor(opencode).length, 1);
});

test('apply --create creates a missing config without a backup', async (t) => {
  const home = tempHome(t);
  const io = makeIO();
  const code = await runCli(['apply', '--yes', '--create', '--agents', 'opencode', '--json', '--home', home], io);
  assert.equal(code, 0, io.err);
  const report = JSON.parse(io.out);
  assert.equal(report.applied[0].backupPath, null);
  const file = path.join(home, '.config', 'opencode', 'opencode.json');
  assert.equal(fs.existsSync(file), true);
});

test('apply --strict refuses partial agents before writing', async (t) => {
  const home = tempHome(t);
  const { codex } = setup(home);
  const before = fs.readFileSync(codex);
  const io = makeIO();
  const code = await runCli(['apply', '--strict', '--yes', '--agents', 'codex', '--json', '--home', home], io);
  assert.equal(code, 2);
  assert.equal(JSON.parse(io.out).agents[0].support, 'partial');
  assert.deepEqual(fs.readFileSync(codex), before);
});

test('apply preflight missing-config error wins over --strict', async (t) => {
  const home = tempHome(t);
  const io = makeIO();
  const code = await runCli(['apply', '--strict', '--yes', '--agents', 'codex', '--json', '--home', home], io);
  assert.equal(code, 1);
  assert.match(io.err, /--create/);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'config.toml')), false);
});

test('apply aborts every agent when one plan requires --create', async (t) => {
  const home = tempHome(t);
  const opencode = writeHomeFile(
    home, path.join('.config', 'opencode', 'opencode.json'), '{}\n',
  );
  const before = fs.readFileSync(opencode);
  const io = makeIO();
  const code = await runCli(['apply', '--yes', '--agents', 'opencode,codex', '--json', '--home', home], io);
  assert.equal(code, 1);
  assert.match(io.err, /--create/);
  assert.deepEqual(fs.readFileSync(opencode), before);
  assert.equal(backupsFor(opencode).length, 0);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'config.toml')), false);
});

test('apply without --yes refuses non-interactive writes', async (t) => {
  const home = tempHome(t);
  setup(home);
  const io = makeIO({ isTTY: false });
  const code = await runCli(['apply', '--agents', 'opencode', '--home', home], io);
  assert.equal(code, 1);
  assert.match(io.err, /--yes/);
});

test('apply preserves unrelated secrets and never prints them', async (t) => {
  const home = tempHome(t);
  const { codex } = setup(home);
  const io = makeIO();
  const code = await runCli(['apply', '--yes', '--agents', 'codex', '--json', '--home', home], io);
  assert.equal(code, 0, io.err);
  assert.equal(io.out.includes('sk-test-not-real'), false);
  assert.match(fs.readFileSync(codex, 'utf8'), /experimental_bearer_token = "sk-test-not-real"/);
});

test('verify --json reports partial retention as null', async (t) => {
  const home = tempHome(t);
  setup(home);
  const applyIO = makeIO();
  assert.equal(
    await runCli(['apply', '--yes', '--agents', 'codex', '--json', '--home', home], applyIO),
    0,
    applyIO.err,
  );
  const io = makeIO();
  const code = await runCli(['verify', '--json', '--agents', 'codex', '--home', home], io);
  assert.equal(code, 0, io.err);
  const report = JSON.parse(io.out);
  assert.deepEqual(report.agents[0].effective, { trigger: 190000, keep: null });
  assert.equal(report.agents[0].ok, true);
});

test('a failed second write rolls back the first file', async (t) => {
  const home = tempHome(t);
  const { opencode } = setup(home);
  const before = fs.readFileSync(opencode);
  const failingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'renameSync') {
        return (from, to) => {
          if (String(to).endsWith('config.toml')) throw new Error('EPERM');
          return fs.renameSync(from, to);
        };
      }
      return target[prop];
    },
  });
  const io = makeIO({ fs: failingFs });
  const code = await runCli(['apply', '--yes', '--agents', 'opencode,codex', '--home', home], io);
  assert.equal(code, 1);
  assert.match(io.err, /EPERM|failed/i);
  assert.deepEqual(fs.readFileSync(opencode), before);
});

test('verify --strict --agents codex returns 2 for partial support even when ok', async (t) => {
  const home = tempHome(t);
  setup(home);
  const applyIO = makeIO();
  assert.equal(
    await runCli(['apply', '--yes', '--agents', 'codex', '--json', '--home', home], applyIO),
    0,
    applyIO.err,
  );
  const io = makeIO();
  const code = await runCli(['verify', '--strict', '--agents', 'codex', '--json', '--home', home], io);
  assert.equal(code, 2);
  const report = JSON.parse(io.out);
  assert.equal(report.agents[0].support, 'partial');
  assert.equal(report.agents[0].ok, true);
  assert.equal(report.agents[0].status, 'ok');
});

test('apply aborts before writing when a DSH plan is manual', async (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(
    home,
    path.join('.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    [
      '- id: compaction-basic',
      "  name: '@deepseek-ai/dsh-compaction-basic'",
      '  config: { auto: true }',
      '',
    ].join('\n'),
  );
  const before = fs.readFileSync(file);
  const io = makeIO();
  const code = await runCli(['apply', '--yes', '--agents', 'dsh', '--json', '--home', home], io);
  assert.equal(code, 1);
  assert.match(io.err, /print/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(backupsFor(file).length, 0);
});

test('apply, verify, and restore outputs never include content or bearer tokens', async (t) => {
  const home = tempHome(t);
  setup(home);
  const commands = [
    ['apply', '--yes', '--agents', 'codex', '--json', '--home', home],
    ['verify', '--agents', 'codex', '--json', '--home', home],
    ['restore', '--latest', '--yes', '--agents', 'codex', '--json', '--home', home],
    ['apply', '--yes', '--agents', 'codex', '--home', home],
    ['verify', '--agents', 'codex', '--home', home],
    ['restore', '--latest', '--yes', '--agents', 'codex', '--home', home],
  ];

  for (const args of commands) {
    const io = makeIO();
    const code = await runCli(args, io);
    assert.equal(code, 0, `${args[0]}: ${io.err}`);
    const output = `${io.out}${io.err}`;
    assert.equal(output.includes('sk-test-not-real'), false, `${args[0]} leaked a token`);
    assert.equal(output.includes('nextContent'), false, `${args[0]} leaked nextContent`);
    assert.equal(output.includes('currentContent'), false, `${args[0]} leaked currentContent`);
  }
});

test('apply human output lists applied files and verification', async (t) => {
  const home = tempHome(t);
  const { codex } = setup(home);
  const io = makeIO();
  const code = await runCli(['apply', '--yes', '--agents', 'codex', '--home', home], io);
  assert.equal(code, 0, io.err);
  assert.match(io.out, /Applied:/);
  assert.match(io.out, new RegExp(`config:? ${codex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(io.out, /backup:/);
  assert.match(io.out, /Verification:/);
  assert.match(io.out, /Codex CLI \(codex\)/);
  assert.match(io.out, /status: ok/);
});
