import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import dsh from '../lib/agents/dsh.mjs';
import { resolvePolicy } from '../lib/policy.mjs';
import { tempHome, writeHomeFile, makeCtx } from './helpers.mjs';

const policy = resolvePolicy();
const desktop = path.join('.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
const web = path.join('.dsh', 'profiles', 'web', 'cordis.patch.yml');

const template = [
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  config:',
  '    auto: true',
  '    thresholdRatio: 0.95',
  '    headroomTokens: 0',
  '    maxTokens: 8192',
  '    retainTokens: 50000',
  '',
].join('\n');

function assertNoBackup(file) {
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
}

test('DSH plan targets 190K and 50K on one profile', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, '[]\n');
  const plan = dsh.plan(makeCtx(home), policy);
  assert.equal(plan.support, 'full');
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.effective, { trigger: 190000, keep: 50000 });
  assert.match(plan.nextContent, /thresholdRatio: 0\.95/);
  assert.match(plan.nextContent, /headroomTokens: 0/);
  assert.match(plan.nextContent, /maxTokens: 8192/);
  assert.match(plan.nextContent, /retainTokens: 50000/);
});

test('DSH requires --profile when multiple profiles exist', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, '[]\n');
  writeHomeFile(home, web, '[]\n');
  assert.throws(() => dsh.plan(makeCtx(home), policy), /--profile/);
});

test('DSH uses the selected profile', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, '[]\n');
  writeHomeFile(home, web, '[]\n');
  const plan = dsh.plan(makeCtx(home, { profile: 'web' }), policy);
  assert.equal(plan.configPath, path.join(home, web));
});

test('DSH rejects retention that is not below the effective trigger', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, '[]\n');
  const small = resolvePolicy({ context: 100000, trigger: 99000, keep: 95000 });
  assert.throws(() => dsh.plan(makeCtx(home), small), /retain/i);
});

test('DSH apply and verify read the effective values', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, desktop, '[]\n');
  const ctx = makeCtx(home);
  const plan = dsh.plan(ctx, policy);
  const result = dsh.apply(ctx, plan);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.deepEqual(dsh.verify(ctx, policy), {
    effective: { trigger: 190000, keep: 50000 },
    warnings: [],
    ok: true,
  });
  assert.match(fs.readFileSync(file, 'utf8'), /- id: compaction-basic/);
});

test('DSH detect reports one profile and no profile without throwing', (t) => {
  const home = tempHome(t);
  const empty = dsh.detect(makeCtx(home));
  assert.equal(empty.detected, false);
  assert.deepEqual(empty.notes, []);
  assert.throws(() => dsh.plan(makeCtx(home), policy), /--profile/);

  writeHomeFile(home, desktop, '[]\n');
  const one = dsh.detect(makeCtx(home));
  assert.equal(one.detected, true);
  assert.equal(one.configPath, path.join(home, desktop));
  assert.deepEqual(one.notes, []);
});

test('DSH detect ignores an empty profiles directory', (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, '.dsh', 'profiles'), { recursive: true });
  const result = dsh.detect(makeCtx(home));
  assert.equal(result.detected, false);
  assert.deepEqual(result.notes, []);
});

test('DSH detect lists multiple profiles and plan requires a selection', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, '[]\n');
  writeHomeFile(home, web, '[]\n');
  const detection = dsh.detect(makeCtx(home));
  assert.equal(detection.detected, true);
  assert.match(detection.notes.join(' '), /desktop/);
  assert.match(detection.notes.join(' '), /web/);
});

test('DSH explicit missing profile requires --create and creates without a backup', (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'laptop'), {
    recursive: true,
  });
  const ctx = makeCtx(home, { profile: 'laptop' });
  const configPath = path.join(
    home,
    '.dsh',
    'profiles',
    'laptop',
    'cordis.patch.yml',
  );
  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'missing');
  assert.equal(plan.configPath, configPath);
  assert.deepEqual(plan.effective, { trigger: 190000, keep: 50000 });
  assert.match(plan.nextContent, /- id: compaction-basic/);
  assert.throws(() => dsh.apply(ctx, plan), /--create/);
  assert.equal(fs.existsSync(configPath), false);

  const createCtx = { ...ctx, create: true };
  assert.deepEqual(dsh.apply(createCtx, plan), { backupPath: null });
  assert.equal(fs.existsSync(configPath), true);
  assert.deepEqual(dsh.verify(createCtx, policy), {
    effective: { trigger: 190000, keep: 50000 },
    warnings: [],
    ok: true,
  });
});

test('DSH rejects profile names that escape the profiles directory', (t) => {
  const home = tempHome(t);
  assert.throws(
    () => dsh.plan(makeCtx(home, { profile: '../escape' }), policy),
    /profile/i,
  );
  assert.throws(
    () => dsh.plan(makeCtx(home, { profile: 'a\\b' }), policy),
    /profile/i,
  );
});

test('DSH already-configured file is a noop and apply creates no backup', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, desktop, template);
  const ctx = makeCtx(home);
  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'noop');
  assert.deepEqual(plan.changes, []);
  assert.equal('nextContent' in plan, false);
  assert.deepEqual(dsh.apply(ctx, plan), { backupPath: null });
  assert.equal(fs.readFileSync(file, 'utf8'), template);
  assertNoBackup(file);
});

test('DSH plan is read-only and preserves the source while planning', (t) => {
  const home = tempHome(t);
  const content = '- id: telemetry\n  config:\n    enabled: true\n';
  const file = writeHomeFile(home, desktop, content);
  const plan = dsh.plan(makeCtx(home), policy);
  assert.equal(plan.status, 'planned');
  assert.match(plan.nextContent, /- id: compaction-basic/);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);
});

test('DSH plan warns when the effective trigger differs', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, '[]\n');
  const high = resolvePolicy({ context: 200000, trigger: 195000, keep: 50000 });
  const plan = dsh.plan(makeCtx(home), high);
  assert.deepEqual(plan.effective, { trigger: 191808, keep: 50000 });
  assert.match(plan.warnings.join(' '), /191808/);
  assert.match(plan.warnings.join(' '), /195000/);
});

test('DSH flow-style config returns a manual plan and never writes', (t) => {
  const home = tempHome(t);
  const content = [
    '- id: compaction-basic',
    '  config: { thresholdRatio: 0.8 }',
    '',
  ].join('\n');
  const file = writeHomeFile(home, desktop, content);
  const ctx = makeCtx(home);
  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'manual');
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.template, template);
  assert.match(plan.warnings.join(' '), /manual|flow|structure/i);
  assert.throws(() => dsh.apply(ctx, plan), /manual/i);
  assert.equal(fs.readFileSync(file, 'utf8'), content);

  const verified = dsh.verify(ctx, policy);
  assert.equal(verified.ok, false);
  assert.deepEqual(verified.effective, { trigger: null, keep: 50000 });
  assert.match(verified.warnings.join(' '), /manual|flow|structure/i);
});

test('DSH duplicate entries throw instead of returning a manual template', (t) => {
  const home = tempHome(t);
  writeHomeFile(
    home,
    desktop,
    [
      '- id: compaction-basic',
      '  config:',
      '    auto: true',
      '- id: compaction-basic',
      '  config:',
      '    auto: true',
      '',
    ].join('\n'),
  );
  assert.throws(() => dsh.plan(makeCtx(home), policy), /duplicate/i);
});

test('DSH verify reports mismatches and computes the configured trigger', (t) => {
  const home = tempHome(t);
  writeHomeFile(
    home,
    desktop,
    [
      '- id: compaction-basic',
      '  config:',
      '    auto: false',
      '    thresholdRatio: 0.8',
      '    headroomTokens: 100',
      '    maxTokens: 4000',
      '    retainTokens: 40000',
      '',
    ].join('\n'),
  );
  const result = dsh.verify(makeCtx(home), policy);
  assert.equal(result.ok, false);
  assert.deepEqual(result.effective, { trigger: 160000, keep: 50000 });
  assert.match(result.warnings.join(' '), /auto/);
  assert.match(result.warnings.join(' '), /thresholdRatio/);
  assert.match(result.warnings.join(' '), /retainTokens/);
});

test('DSH verify reports a missing file for an explicit profile', (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'desktop'), {
    recursive: true,
  });
  const result = dsh.verify(makeCtx(home, { profile: 'desktop' }), policy);
  assert.equal(result.ok, false);
  assert.deepEqual(result.effective, { trigger: null, keep: 50000 });
  assert.match(result.warnings.join(' '), /does not exist/);
});

test('DSH ignores profile directories without a patch file', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(home, desktop, '[]\n');
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'scratch'), {
    recursive: true,
  });

  const detection = dsh.detect(makeCtx(home));
  assert.equal(detection.detected, true);
  assert.equal(detection.configPath, file);
  assert.deepEqual(detection.notes, []);

  const plan = dsh.plan(makeCtx(home), policy);
  assert.equal(plan.configPath, file);
  assert.equal(plan.status, 'planned');
});

test('DSH reports no profiles when only unrelated directories exist', (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'scratch'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(home, '.dsh', 'profiles', 'laptop'), {
    recursive: true,
  });

  const detection = dsh.detect(makeCtx(home));
  assert.equal(detection.detected, false);
  assert.deepEqual(detection.notes, []);
  assert.throws(() => dsh.plan(makeCtx(home), policy), /--profile/);
});

test('DSH verify reports multiple profiles without throwing', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, template);
  writeHomeFile(home, web, template);
  const result = dsh.verify(makeCtx(home), policy);
  assert.equal(result.ok, false);
  assert.match(result.warnings.join(' '), /--profile/);
});

test('DSH print returns the canonical YAML block', (t) => {
  const home = tempHome(t);
  assert.equal(dsh.print(makeCtx(home), policy), template);
});

test('DSH honors DSH_HOME', (t) => {
  const home = tempHome(t);
  const custom = path.join(home, 'custom-dsh');
  const relative = path.join('profiles', 'desktop', 'cordis.patch.yml');
  writeHomeFile(custom, relative, '[]\n');
  const ctx = makeCtx(home, { env: { DSH_HOME: custom } });
  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.configPath, path.join(custom, relative));
});

test('DSH plans and applies a noncanonically indented entry', (t) => {
  const home = tempHome(t);
  const file = writeHomeFile(
    home,
    desktop,
    [
      '-   id: compaction-basic',
      "    name: '@deepseek-ai/dsh-compaction-basic'",
      '    config:',
      '      auto: false',
      '',
    ].join('\n'),
  );
  const ctx = makeCtx(home);
  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'planned');
  assert.match(plan.nextContent, /^      auto: true$/m);

  dsh.apply(ctx, plan);
  assert.match(fs.readFileSync(file, 'utf8'), /^      thresholdRatio: 0\.95$/m);
  assert.deepEqual(dsh.verify(ctx, policy), {
    effective: { trigger: 190000, keep: 50000 },
    warnings: [],
    ok: true,
  });
});

const scalarPreservationInputs = [
  {
    name: 'a block scalar whose last line starts with #',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: |',
      '      hello',
      '      # literal last line',
      '',
    ],
    scalarText: '    custom: |\n      hello\n      # literal last line',
  },
  {
    name: 'a block scalar containing unclosed quotes',
    lines: [
      '- id: compaction-basic',
      '  config:',
      '    custom: |',
      '      hello "unclosed',
      "      and 'also unclosed",
      '',
    ],
    scalarText: '    custom: |\n      hello "unclosed\n      and \'also unclosed',
  },
];

for (const { name, lines, scalarText } of scalarPreservationInputs) {
  test(`DSH plan and apply preserve ${name} while adding targets`, (t) => {
    const home = tempHome(t);
    const content = lines.join('\n');
    const file = writeHomeFile(home, desktop, content);
    const ctx = makeCtx(home);

    const plan = dsh.plan(ctx, policy);
    assert.equal(plan.status, 'planned');
    assert.ok(plan.nextContent.startsWith(content));
    assert.ok(plan.nextContent.includes(scalarText));
    assert.match(plan.nextContent, /^    auto: true$/m);
    assert.equal(fs.readFileSync(file, 'utf8'), content);

    dsh.apply(ctx, plan);
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.startsWith(content));
    assert.ok(written.includes(scalarText));
    assert.deepEqual(dsh.verify(ctx, policy), {
      effective: { trigger: 190000, keep: 50000 },
      warnings: [],
      ok: true,
    });
  });
}

test('DSH plans and applies with single-line quoted unknown values', (t) => {
  const home = tempHome(t);
  const content = [
    '- id: compaction-basic',
    '  config:',
    '    custom: "hello: auto: false"',
    '    hash: "hello # world"',
    "    note: 'it''s fine'",
    '    auto: false # it\'s "fine"',
    '',
  ].join('\n');
  const file = writeHomeFile(home, desktop, content);
  const ctx = makeCtx(home);

  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'planned');
  assert.ok(plan.nextContent.includes('    custom: "hello: auto: false"\n'));
  assert.ok(plan.nextContent.includes('    hash: "hello # world"\n'));
  assert.ok(plan.nextContent.includes("    note: 'it''s fine'\n"));
  assert.match(plan.nextContent, /^    auto: true # it's "fine"$/m);
  assert.equal(fs.readFileSync(file, 'utf8'), content);

  dsh.apply(ctx, plan);
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(written.includes('    custom: "hello: auto: false"\n'));
  assert.ok(written.includes('    hash: "hello # world"\n'));
  assert.ok(written.includes("    note: 'it''s fine'\n"));
  assert.deepEqual(dsh.verify(ctx, policy), {
    effective: { trigger: 190000, keep: 50000 },
    warnings: [],
    ok: true,
  });
});

test('DSH plans and applies with single-line flow collections under unknown keys', (t) => {
  const home = tempHome(t);
  const content = [
    '- id: compaction-basic',
    '  config:',
    '    custom: { a: 1 }',
    "    note: { text: don't }",
    '    list: [1, 2, 3]',
    '',
  ].join('\n');
  const file = writeHomeFile(home, desktop, content);
  const ctx = makeCtx(home);

  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'planned');
  assert.ok(plan.nextContent.includes('    custom: { a: 1 }\n'));
  assert.ok(plan.nextContent.includes("    note: { text: don't }\n"));
  assert.ok(plan.nextContent.includes('    list: [1, 2, 3]\n'));
  assert.match(plan.nextContent, /^    auto: true$/m);
  assert.equal(fs.readFileSync(file, 'utf8'), content);

  dsh.apply(ctx, plan);
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(written.includes('    custom: { a: 1 }\n'));
  assert.ok(written.includes("    note: { text: don't }\n"));
  assert.ok(written.includes('    list: [1, 2, 3]\n'));
  assert.deepEqual(dsh.verify(ctx, policy), {
    effective: { trigger: 190000, keep: 50000 },
    warnings: [],
    ok: true,
  });
});

const manualStructures = [
  [
    'a flow map on the line after config',
    ['- id: compaction-basic', '  config:', '    { thresholdRatio: 0.8 }', ''],
  ],
  [
    'a sequence after config',
    ['- id: compaction-basic', '  config:', '    - auto: true', ''],
  ],
  [
    'a block scalar target value',
    ['- id: compaction-basic', '  config:', '    auto: |', '      false', ''],
  ],
  [
    'a flow mapping target value',
    ['- id: compaction-basic', '  config:', '    auto: { enabled: true }', ''],
  ],
  [
    'duplicate direct target keys',
    [
      '- id: compaction-basic',
      '  config:',
      '    auto: false',
      '    thresholdRatio: 0.8',
      '    auto: true',
      '',
    ],
  ],
  [
    'a top-level flow-style compaction entry',
    ['- { id: compaction-basic, config: {} }', ''],
  ],
  [
    'a top-level mapping root',
    [
      'plugins:',
      '  - id: compaction-basic',
      '    config:',
      '      auto: false',
      '',
    ],
  ],
  ['an empty flow mapping root', ['{}', '']],
  ['a nonempty flow sequence root', ['[1, 2]', '']],
  ['a scalar root', ['just-a-scalar', '']],
  [
    'an indentless sequence after config',
    ['- id: compaction-basic', '  config:', '  - auto: true', ''],
  ],
  [
    'over-indented continuation keys',
    [
      '- id: compaction-basic',
      "    name: '@deepseek-ai/dsh-compaction-basic'",
      '    config:',
      '      auto: false',
      '',
    ],
  ],
  ['a quoted entry key', ['- "id": compaction-basic', '']],
  [
    'a multiline double-quoted scalar',
    [
      '- id: compaction-basic',
      '  config:',
      '    custom: "hello',
      '      # literal"',
      '',
    ],
  ],
  [
    'a multiline quoted scalar hiding target-looking lines',
    [
      '- id: compaction-basic',
      '  config:',
      '    custom: "hello',
      '    auto: false',
      '    bye"',
      '',
    ],
  ],
  [
    'a multiline flow map hiding target-looking lines',
    [
      '- id: compaction-basic',
      '  config:',
      '    custom: {',
      '    auto: false',
      '    }',
      '',
    ],
  ],
  [
    'a multiline flow sequence under an unknown key',
    [
      '- id: compaction-basic',
      '  config:',
      '    custom: [',
      '      one,',
      '      two,',
      '    ]',
      '',
    ],
  ],
];

for (const [name, lines] of manualStructures) {
  test(`DSH returns a manual plan for ${name}`, (t) => {
    const home = tempHome(t);
    const content = lines.join('\n');
    const file = writeHomeFile(home, desktop, content);
    const ctx = makeCtx(home);

    const plan = dsh.plan(ctx, policy);
    assert.equal(plan.status, 'manual');
    assert.equal(plan.template, template);
    assert.equal('nextContent' in plan, false);
    assert.deepEqual(plan.changes, []);
    assert.match(plan.warnings.join(' '), /unexpected|unsupported/i);

    assert.throws(() => dsh.apply(ctx, plan), /manual/i);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assertNoBackup(file);

    const verified = dsh.verify(ctx, policy);
    assert.equal(verified.ok, false);
    assert.match(verified.warnings.join(' '), /unexpected|unsupported|manual/i);
  });
}

test('DSH treats a multiline flow map that could hide a rewrite as manual', (t) => {
  const home = tempHome(t);
  const content = [
    '- id: compaction-basic',
    '  config:',
    '    custom: {',
    '    auto: false,',
    '    other: true }',
    '',
  ].join('\n');
  const file = writeHomeFile(home, desktop, content);
  const ctx = makeCtx(home);

  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'manual');
  assert.equal(plan.template, template);
  assert.equal('nextContent' in plan, false);
  assert.deepEqual(plan.changes, []);
  assert.match(plan.warnings.join(' '), /multiline flow collections/i);

  assert.throws(() => dsh.apply(ctx, plan), /manual/i);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);

  const verified = dsh.verify(ctx, policy);
  assert.equal(verified.ok, false);
  assert.match(verified.warnings.join(' '), /multiline flow collections/i);
});

test('DSH treats a quoted scalar hidden behind a colon-containing key as manual', (t) => {
  const home = tempHome(t);
  const content = [
    '- id: compaction-basic',
    '  config:',
    '    custom:foo: "hello',
    '    auto: false',
    '    bye: true"',
    '',
  ].join('\n');
  const file = writeHomeFile(home, desktop, content);
  const ctx = makeCtx(home);

  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'manual');
  assert.equal(plan.template, template);
  assert.equal('nextContent' in plan, false);
  assert.deepEqual(plan.changes, []);
  assert.match(plan.warnings.join(' '), /multiline quoted scalars/i);

  assert.throws(() => dsh.apply(ctx, plan), /manual/i);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assertNoBackup(file);

  const verified = dsh.verify(ctx, policy);
  assert.equal(verified.ok, false);
  assert.match(verified.warnings.join(' '), /multiline quoted scalars/i);
});

test('DSH plans and applies colon-containing keys with single-line quoted values', (t) => {
  const home = tempHome(t);
  const content = [
    '- id: compaction-basic',
    '  config:',
    '    custom:foo: "hello"',
    '    auto:foo: "hello"',
    '',
  ].join('\n');
  const file = writeHomeFile(home, desktop, content);
  const ctx = makeCtx(home);

  const plan = dsh.plan(ctx, policy);
  assert.equal(plan.status, 'planned');
  assert.ok(plan.nextContent.includes('    custom:foo: "hello"\n'));
  assert.ok(plan.nextContent.includes('    auto:foo: "hello"\n'));
  assert.match(plan.nextContent, /^    auto: true$/m);
  assert.equal(plan.nextContent.includes('auto:true'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), content);

  dsh.apply(ctx, plan);
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(written.includes('    custom:foo: "hello"\n'));
  assert.ok(written.includes('    auto:foo: "hello"\n'));
  assert.match(written, /^    auto: true$/m);
  assert.deepEqual(dsh.verify(ctx, policy), {
    effective: { trigger: 190000, keep: 50000 },
    warnings: [],
    ok: true,
  });
});
