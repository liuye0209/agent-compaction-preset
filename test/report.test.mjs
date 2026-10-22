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
  currentContent: '{"secret":"stale"}',
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
  assert.equal(plan.currentContent, '{"secret":"stale"}');
});

test('sanitizePlan recursively removes content keys without mutating the input', () => {
  const nested = {
    agentId: 'opencode',
    details: {
      name: 'nested',
      nextContent: '{"secret":"sk-test-not-real"}',
      changes: [
        { key: 'a', currentContent: 'old', nextContent: 'new' },
        { deeper: { currentContent: 'old', value: 7 } },
      ],
    },
  };
  const safe = sanitizePlan(nested);

  assert.deepEqual(safe, {
    agentId: 'opencode',
    id: 'opencode',
    details: {
      name: 'nested',
      changes: [{ key: 'a' }, { deeper: { value: 7 } }],
    },
  });
  assert.equal(JSON.stringify(safe).includes('Content'), false);
  assert.equal(nested.details.nextContent, '{"secret":"sk-test-not-real"}');
  assert.equal(nested.details.changes[0].currentContent, 'old');
  assert.equal(nested.details.changes[1].deeper.currentContent, 'old');
});

test('JSON report removes nested content fields', () => {
  const nestedResult = {
    version: '0.1.0',
    command: 'plan',
    agents: [
      {
        agentId: 'opencode',
        nested: {
          nextContent: 'sk-test-not-real',
          list: [{ currentContent: 'sk-test-not-real' }],
        },
      },
    ],
  };
  const json = toJsonReport(nestedResult);

  assert.equal(json.includes('nextContent'), false);
  assert.equal(json.includes('currentContent'), false);
  assert.equal(json.includes('sk-test-not-real'), false);
  assert.deepEqual(JSON.parse(json).agents[0], {
    agentId: 'opencode',
    id: 'opencode',
    nested: { list: [{}] },
  });
});

test('JSON report contains no secrets or nextContent', () => {
  const json = toJsonReport(result);
  assert.equal(json.includes('sk-test-not-real'), false);
  assert.equal(json.includes('nextContent'), false);
  assert.equal(JSON.parse(json).agents[0].effective.trigger, 190000);
});

test('JSON report is indented and ends with exactly one newline', () => {
  const json = toJsonReport(result);

  assert.match(json, /^\{\n {2}"version": "0\.1\.0",\n/);
  assert.equal(json.endsWith('\n'), true);
  assert.equal(json.endsWith('\n\n'), false);
  assert.equal(json, `${JSON.stringify(JSON.parse(json), null, 2)}\n`);
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

const verifyAgent = {
  id: 'codex',
  name: 'Codex CLI',
  support: 'partial',
  configPath: '/home/u/.codex/config.toml',
  effective: { trigger: 190000, keep: null },
  warnings: ['retention is fixed'],
  ok: false,
  status: 'mismatch',
};

test('human apply report lists applied entries and verification agents', () => {
  const human = toHumanReport({
    version: '0.1.0',
    command: 'apply',
    policy: { context: 200000, trigger: 190000, keep: 50000 },
    applied: [
      {
        agentId: 'opencode',
        configPath: '/home/u/.config/opencode/opencode.json',
        backupPath: '/home/u/.config/opencode/opencode.json.bak-agent-compact-20261019-120000',
      },
      { agentId: 'gemini', configPath: '/home/u/.gemini/settings.json', backupPath: null },
    ],
    agents: [verifyAgent],
  }, { color: false });

  assert.match(human, /Applied:/);
  assert.match(human, /opencode/);
  assert.match(human, /config: \/home\/u\/\.config\/opencode\/opencode\.json/);
  assert.match(human, /backup: \/home\/u\/\.config\/opencode\/opencode\.json\.bak-agent-compact-/);
  assert.match(human, /gemini/);
  assert.match(human, /backup: none/);
  assert.match(human, /Verification:/);
  assert.match(human, /Codex CLI \(codex\)/);
  assert.match(human, /support: partial/);
  assert.match(human, /status: mismatch/);
  assert.match(human, /trigger 190000, keep N\/A/);
  assert.match(human, /warning: retention is fixed/);
});

test('human verify report lists support, status, effective, and warnings', () => {
  const human = toHumanReport({
    version: '0.1.0',
    command: 'verify',
    policy: { context: 200000, trigger: 190000, keep: 50000 },
    agents: [verifyAgent],
  }, { color: false });

  assert.match(human, /Verification:/);
  assert.match(human, /Codex CLI \(codex\)/);
  assert.match(human, /support: partial/);
  assert.match(human, /status: mismatch/);
  assert.match(human, /trigger 190000/);
  assert.match(human, /warning: retention is fixed/);
  assert.equal(human.includes('nextContent'), false);
});

test('human restore report lists restored paths and warnings without content', () => {
  const human = toHumanReport({
    version: '0.1.0',
    command: 'restore',
    restored: [
      {
        agentId: 'opencode',
        configPath: '/home/u/.config/opencode/opencode.json',
        backupPath: '/home/u/.config/opencode/opencode.json.bak-agent-compact-20261019-120000',
        safetyBackupPath: '/home/u/.config/opencode/opencode.json.bak-agent-compact-before-restore-20261019-130000',
        nextContent: '{"token":"sk-test-not-real"}',
      },
    ],
    warnings: ['No backup found for DSH (dsh).'],
  }, { color: false });

  assert.match(human, /Restored:/);
  assert.match(human, /opencode/);
  assert.match(human, /config: \/home\/u\/\.config\/opencode\/opencode\.json/);
  assert.match(human, /backup: \/home\/u\/\.config\/opencode\/opencode\.json\.bak-agent-compact-/);
  assert.match(human, /safety backup: .*before-restore/);
  assert.match(human, /warning: No backup found for DSH/);
  assert.equal(human.includes('sk-test-not-real'), false);
  assert.equal(human.includes('nextContent'), false);
});
