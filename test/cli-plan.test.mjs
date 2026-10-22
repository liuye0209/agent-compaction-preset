import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli } from '../lib/cli.mjs';
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

function listFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    files.push(full);

    if (entry.isDirectory()) files.push(...listFiles(full));
  }

  return files;
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

test('plan --context derives a 95% trigger unless --trigger is supplied', (t) => {
  const home = tempHome(t);
  setup(home);

  const derived = run(
    ['plan', '--context', '100000', '--agents', 'opencode', '--json'],
    home,
  );
  assert.equal(derived.status, 0, derived.stderr);
  const derivedReport = JSON.parse(derived.stdout);
  assert.deepEqual(derivedReport.policy, {
    context: 100000,
    trigger: 95000,
    keep: 50000,
  });
  assert.deepEqual(derivedReport.agents[0].effective, {
    trigger: 95000,
    keep: 50000,
  });

  const explicit = run(
    [
      'plan', '--context', '100000', '--trigger', '90000',
      '--agents', 'opencode', '--json',
    ],
    home,
  );
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout).policy, {
    context: 100000,
    trigger: 90000,
    keep: 50000,
  });
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
  assert.match(help.stdout, /95% of context/);
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

test('plan rejects malformed JSON without echoing config content', (t) => {
  const home = tempHome(t);
  writeHomeFile(
    home,
    path.join('.config', 'opencode', 'opencode.json'),
    '{"token":"sk-test-not-real",}\n',
  );
  const result = run(['plan'], home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid JSON/);
  assert.match(result.stderr, /opencode\.json/);
  assert.equal(result.stderr.includes('sk-test-not-real'), false);
  assert.equal(result.stderr.includes('"token"'), false);
  assert.equal(result.stderr.includes('{"'), false);
  assert.doesNotMatch(result.stderr, /Unexpected|Expected|is not valid JSON/);
});

test('--agent is rejected outside print and documented as print-only', (t) => {
  const home = tempHome(t);
  setup(home);

  for (const command of ['plan', 'detect']) {
    const result = run([command, '--agent', 'codex'], home);
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /--agent/);
    assert.match(result.stderr, /print/);
  }

  const help = run(['--help'], home);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--agent <id>.*print only/i);
});

test('plan leaves both configs unchanged and writes no backups', (t) => {
  const home = tempHome(t);
  const { opencode, codex } = setup(home);
  const opencodeBefore = fs.readFileSync(opencode);
  const codexBefore = fs.readFileSync(codex);
  const result = run(['plan', '--json'], home);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(opencode), opencodeBefore);
  assert.deepEqual(fs.readFileSync(codex), codexBefore);
  assert.equal(
    listFiles(home).some((file) => path.basename(file).includes('.bak-agent-compact-')),
    false,
  );
});

test('detect --json returns all six adapters', (t) => {
  const home = tempHome(t);
  setup(home);
  const result = run(['detect', '--json'], home);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.agents.map((agent) => agent.id),
    ['opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen'],
  );
  assert.deepEqual(
    report.agents.filter((agent) => agent.detected).map((agent) => agent.id).sort(),
    ['codex', 'opencode'],
  );
});

test('plan with no detected agents exits 2 with guidance', (t) => {
  const home = tempHome(t);
  const result = run(['plan'], home);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No configured agents detected/);
  assert.match(result.stderr, /--agents/);
});

test('unknown commands and extra positionals exit 1', (t) => {
  const home = tempHome(t);
  const unknown = run(['frobnicate'], home);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);

  const extra = run(['detect', 'extra'], home);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Unexpected argument/);
});

test('runCli passes io.env to child commands and honors io.stdout TTY', async (t) => {
  const home = tempHome(t);
  const env = { AGENT_COMPACT_TEST: '1' };
  const calls = [];
  const stdout = {
    isTTY: true,
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk);
    },
  };
  const stderr = {
    chunks: [],
    write(chunk) {
      this.chunks.push(chunk);
    },
  };

  const code = await runCli(['detect', '--home', home], {
    stdout,
    stderr,
    env,
    runCommand: (command, args, options = {}) => {
      calls.push({ command, args, env: options.env });
      return { status: 1, stdout: '', stderr: '' };
    },
  });

  assert.equal(code, 0, stderr.chunks.join(''));
  assert.equal(calls.length > 0, true);
  assert.equal(calls.every((call) => call.env === env), true);
  assert.match(stdout.chunks.join(''), /\x1b\[/);
});
