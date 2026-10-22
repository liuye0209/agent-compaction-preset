import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempHome, writeHomeFile } from './helpers.mjs';

const bin = fileURLToPath(new URL('../bin/agent-compact.mjs', import.meta.url));

function run(args, home) {
  const emptyBin = path.join(home, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  return spawnSync(process.execPath, [bin, ...args, '--home', home, '--no-color'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      AGENT_COMPACT_HOME: '',
      DSH_HOME: path.join(home, '.dsh'),
      CODEX_HOME: '',
      CLAUDE_CONFIG_DIR: '',
      XDG_CONFIG_HOME: '',
      PATH: emptyBin,
      Path: emptyBin,
    },
  });
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

test('plan --json reports both agents and never prints the bearer token', (t) => {
  const home = tempHome(t);
  const { opencode } = setup(home);
  const before = fs.readFileSync(opencode);
  const result = run(['plan', '--json'], home);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.agents.map((a) => a.id), ['opencode', 'codex']);
  assert.deepEqual(report.agents[0].effective, { trigger: 190000, keep: 50000 });
  assert.deepEqual(report.agents[1].effective, { trigger: 190000, keep: null });
  assert.equal(result.stdout.includes('sk-test-not-real'), false);
  assert.deepEqual(fs.readFileSync(opencode), before);
});

test('detect --json lists configured agents', (t) => {
  const home = tempHome(t);
  setup(home);
  const result = run(['detect', '--json'], home);
  assert.equal(result.status, 0, result.stderr);
  const detected = JSON.parse(result.stdout).agents
    .filter((a) => a.detected)
    .map((a) => a.id)
    .sort();
  assert.deepEqual(detected, ['codex', 'opencode']);
});

test('print --agent dsh emits the YAML block', (t) => {
  const home = tempHome(t);
  const result = run(['print', '--agent', 'dsh'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compaction-basic/);
  assert.match(result.stdout, /retainTokens: 50000/);
});

test('help and version are non-destructive', (t) => {
  const home = tempHome(t);
  const help = run(['--help'], home);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage/);
  const version = run(['--version'], home);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /0\.1\.0/);
});

test('invalid context and strict partial selection fail with documented codes', (t) => {
  const home = tempHome(t);
  setup(home);
  const invalid = run(['plan', '--context', 'abc'], home);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /context/);
  const strict = run(['plan', '--strict', '--agents', 'codex', '--json'], home);
  assert.equal(strict.status, 2);
  assert.equal(JSON.parse(strict.stdout).agents[0].support, 'partial');
});

test('plan --json omits raw file contents from every agent', (t) => {
  const home = tempHome(t);
  setup(home);
  const result = run(['plan', '--json'], home);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.agents.some((agent) => Object.hasOwn(agent, 'nextContent')),
    false,
  );
  assert.equal(
    report.agents.some((agent) => Object.hasOwn(agent, 'currentContent')),
    false,
  );
});

test('strict partial writes the human report before exiting 2', (t) => {
  const home = tempHome(t);
  setup(home);
  const result = run(['plan', '--strict', '--agents', 'codex'], home);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Codex CLI/);
  assert.match(result.stdout, /partial/);
  assert.equal(result.stdout.includes('sk-test-not-real'), false);
});

test('print --agent dsh does not require a detected profile', (t) => {
  const home = tempHome(t);
  const result = run(['print', '--agent', 'dsh'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compaction-basic/);
  assert.match(result.stdout, /retainTokens: 50000/);
});
