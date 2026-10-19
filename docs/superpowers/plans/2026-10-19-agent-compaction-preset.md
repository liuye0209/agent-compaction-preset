# Agent Compaction Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency Node CLI that writes native context-compaction settings for OpenCode, DSH, Codex, Claude Code, Gemini CLI, and Qwen Code, with preview, backup, rollback, verify, and restore.

**Architecture:** A single CLI plus one adapter per agent. Adapters produce plans and perform one-file writes; shared modules handle policy, paths, format-preserving merges, backups, transactions, reporting, and restore. Codex TOML and DSH YAML use targeted text editors so comments and unrelated settings survive.

**Tech Stack:** Node.js >= 20, ESM, `node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:util.parseArgs`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-agent-compaction-preset-design.md`

## Global Constraints

- Node.js >= 20; ESM only (`"type": "module"`).
- Zero runtime dependencies.
- Default policy is exactly `context: 200000`, `trigger: 190000`, `keep: 50000`.
- Never print API keys, bearer tokens, or whole config files.
- `plan` is read-only; `apply` is the only writing command.
- Every adapter returns `status: 'noop'` and `changes: []` when its target values
  already match; `apply` must not create a backup for a noop plan.
- All writes go through timestamped backup + atomic replace.
- `apply` is all-or-nothing across selected agents.
- JSONC with comments is never rewritten; return a manual template.
- Codex TOML and DSH YAML changes must preserve comments and unrelated entries.
- Partial-support agents must report `keep: null` / `N/A`, never claim 50K retention.
- Tests must use temporary homes and fake secrets only.
- Do not publish to npm in this plan.

## Review Focus

1. **Secrets in output:** real configs contain `experimental_bearer_token`, API keys, and unrelated values. They must never appear in `plan`, `--json`, diffs, or error messages. Tested in Task 5 (Codex bearer token) and Task 8 (`--json`).
2. **JSONC comments:** an OpenCode `.jsonc` with comments must never be rewritten; the user gets a manual template. Tested in Task 3.
3. **DSH ambiguity:** multiple profiles without `--profile`, duplicate `compaction-basic` entries, or flow-style YAML must abort rather than guess. Tested in Task 6.
4. **Codex profile overrides:** top-level writes must not touch same-named keys inside `[profiles.*]`, and the user must be warned. Tested in Task 5.
5. **Windows write failure:** a failed atomic replace must leave the original intact; a failed transaction must restore earlier files. Tested in Task 2 and Task 9, and by the Windows CI job.

---

### Task 1: Project Skeleton and Policy

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `lib/policy.mjs`
- Test: `test/policy.test.mjs`

**Interfaces:**
- Produces: `DEFAULT_POLICY`, `resolvePolicy(overrides)`, `ratioFor(policy)`, `dshEffectiveTrigger(policy, options)`.
- `resolvePolicy(overrides = {}) -> { context: number, trigger: number, keep: number }`.
- `ratioFor(policy) -> number`.
- `dshEffectiveTrigger(policy, { maxTokens = 8192, headroomTokens = 0 } = {}) -> number`.

- [ ] **Step 1: Write the failing policy tests**

```js
// test/policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY,
  resolvePolicy,
  ratioFor,
  dshEffectiveTrigger,
} from '../lib/policy.mjs';

test('default policy is 200K/190K/50K', () => {
  assert.deepEqual(DEFAULT_POLICY, {
    context: 200000,
    trigger: 190000,
    keep: 50000,
  });
  assert.deepEqual(resolvePolicy(), {
    context: 200000,
    trigger: 190000,
    keep: 50000,
  });
});

test('accepts a smaller context', () => {
  assert.deepEqual(
    resolvePolicy({ context: 100000, trigger: 95000, keep: 50000 }),
    { context: 100000, trigger: 95000, keep: 50000 },
  );
});

test('rejects invalid windows', () => {
  assert.throws(() => resolvePolicy({ context: 0 }), /context/);
  assert.throws(() => resolvePolicy({ trigger: 200000 }), /trigger/);
  assert.throws(() => resolvePolicy({ keep: 190000 }), /keep/);
  assert.throws(() => resolvePolicy({ trigger: 50000 }), /keep/);
});

test('computes ratio and DSH effective trigger', () => {
  const policy = resolvePolicy();
  assert.equal(ratioFor(policy), 0.95);
  assert.equal(dshEffectiveTrigger(policy), 190000);
  assert.equal(dshEffectiveTrigger(policy, { maxTokens: 32000 }), 168000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/policy.test.mjs`  
Expected: FAIL because `lib/policy.mjs` does not exist.

- [ ] **Step 3: Implement the skeleton and policy module**

`package.json` must contain:

```json
{
  "name": "agent-compaction-preset",
  "version": "0.1.0",
  "description": "Cross-agent context compaction configuration preset",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test" },
  "license": "MIT"
}
```

`.gitignore` must contain:

```text
node_modules/
coverage/
*.bak-agent-compact-*
*.tmp-agent-compact-*
.DS_Store
```

Implement `lib/policy.mjs` with a frozen `DEFAULT_POLICY`, integer validation,
`trigger < context`, `keep < trigger`, and the DSH formula
`floor(min(context * ratio, context - maxTokens - headroomTokens))`.
Use error messages containing `context`, `trigger`, or `keep` so the tests match.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/policy.test.mjs`  
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore lib/policy.mjs test/policy.test.mjs
git commit -m "feat: add compaction policy and project skeleton"
```

### Task 2: Paths, Backups, and Transaction Safety

**Files:**
- Create: `lib/paths.mjs`
- Create: `lib/backup.mjs`
- Test: `test/paths.test.mjs`
- Test: `test/backup.test.mjs`

**Interfaces:**
- Produces path helpers:
  - `resolveHome({ home, env = process.env } = {}) -> string`
  - `opencodeConfigPath(home, env = process.env) -> string`
  - `opencodeJsoncPath(home, env = process.env) -> string`
  - `dshHome(home, env = process.env) -> string`
  - `codexHome(home, env = process.env) -> string`
  - `claudeConfigDir(home, env = process.env) -> string`
  - `geminiSettingsPath(home) -> string`
  - `qwenSettingsPath(home) -> string`
- Produces write-safety helpers:
  - `timestamp(date) -> string` in UTC `YYYYMMDD-HHmmss`.
  - `createBackup(filePath, { fs, now, label } = {}) -> string` (returns backup path).
  - `atomicWrite(filePath, content, { fs } = {}) -> void`.
  - `writeWithBackup(filePath, content, { fs, now } = {}) -> { backupPath: string | null }`.
  - `findLatestBackup(filePath, { fs } = {}) -> string | null`.
  - `restoreExact(backupPath, targetPath, { fs } = {}) -> void`.
  - `restoreBackup(backupPath, targetPath, { fs, now } = {}) -> { safetyBackupPath: string | null }`.
  - `applyTransaction(entries, { fs, now } = {}) -> { applied: Array<{ agentId, backupPath: string | null, configPath: string }> }`.

- [ ] **Step 1: Write the failing path tests**

```js
// test/paths.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveHome,
  opencodeConfigPath,
  dshHome,
  codexHome,
  claudeConfigDir,
  geminiSettingsPath,
  qwenSettingsPath,
} from '../lib/paths.mjs';

test('home precedence is --home, AGENT_COMPACT_HOME, os.homedir()', () => {
  assert.equal(
    resolveHome({ home: path.join('/tmp', 'explicit'), env: { AGENT_COMPACT_HOME: path.join('/tmp', 'env') } }),
    path.join('/tmp', 'explicit'),
  );
  assert.equal(
    resolveHome({ env: { AGENT_COMPACT_HOME: path.join('/tmp', 'env') } }),
    path.join('/tmp', 'env'),
  );
});

test('opencode path honors XDG_CONFIG_HOME', () => {
  assert.equal(
    opencodeConfigPath(path.join('/tmp', 'home'), { XDG_CONFIG_HOME: path.join('/tmp', 'xdg') }),
    path.join('/tmp', 'xdg', 'opencode', 'opencode.json'),
  );
});

test('agent roots honor their environment overrides', () => {
  assert.equal(dshHome('/h', { DSH_HOME: '/dsh' }), '/dsh');
  assert.equal(codexHome('/h', { CODEX_HOME: '/codex' }), '/codex');
  assert.equal(claudeConfigDir('/h', { CLAUDE_CONFIG_DIR: '/claude' }), '/claude');
  assert.equal(geminiSettingsPath('/h'), path.join('/h', '.gemini', 'settings.json'));
  assert.equal(qwenSettingsPath('/h'), path.join('/h', '.qwen', 'settings.json'));
});
```

- [ ] **Step 2: Run the path tests to verify they fail**

Run: `node --test test/paths.test.mjs`  
Expected: FAIL because `lib/paths.mjs` does not exist.

- [ ] **Step 3: Write the failing backup tests**

```js
// test/backup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  timestamp,
  writeWithBackup,
  atomicWrite,
  findLatestBackup,
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
  const { safetyBackupPath } = restoreBackup(oldBackup, file, { fs, now: fixedNow });
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.match(path.basename(safetyBackupPath), /before-restore/);
  assert.equal(findLatestBackup(file, { fs }), oldBackup);
});
```

- [ ] **Step 4: Run the backup tests to verify they fail**

Run: `node --test test/backup.test.mjs`  
Expected: FAIL because `lib/backup.mjs` does not exist.

- [ ] **Step 5: Implement paths and write safety**

`lib/paths.mjs` uses `node:os` and `node:path`. `resolveHome` chooses
`options.home`, then `env.AGENT_COMPACT_HOME`, then `os.homedir()`. Agent roots
use `DSH_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` when present.

`lib/backup.mjs` requirements:

- `timestamp` uses `date.toISOString()` and returns UTC `YYYYMMDD-HHmmss`.
- `createBackup` copies exact bytes to
  `<file>.bak-agent-compact-<timestamp>`, or
  `<file>.bak-agent-compact-<label>-<timestamp>` when `label` is set. If the
  name exists, append `-1`, `-2`, etc.
- `atomicWrite` creates the parent directory recursively when needed, writes a
  sibling temp file, then renames it over the target. Preserve the original file
  mode on POSIX by copying `statSync(file).mode` to the temp file before the
  rename. Retry a failed rename once on Windows; if both attempts fail, remove
  the temp file and throw without touching the original.
- `writeWithBackup` returns `{ backupPath: null }` when the target does not
  exist; otherwise it creates a backup first.
- `findLatestBackup` matches only
  `<basename>.bak-agent-compact-YYYYMMDD-HHmmss` with an optional `-N` suffix,
  ignoring `before-restore` copies, and returns the lexicographically latest.
- `restoreBackup` creates a `before-restore` safety copy when the current file
  exists, then calls `restoreExact`.
- `applyTransaction` calls `entry.adapter.apply(entry.ctx, entry.plan)` for each
  entry. It skips entries whose plan status is `noop`. On failure, it restores
  every already-applied entry from its backup; if `backupPath` is null, it
  deletes the newly created file instead.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/paths.test.mjs test/backup.test.mjs`  
Expected: PASS (3 path tests, 5 backup tests).

- [ ] **Step 7: Commit**

```bash
git add lib/paths.mjs lib/backup.mjs test/paths.test.mjs test/backup.test.mjs
git commit -m "feat: add cross-platform paths and safe writes"
```

### Task 3: JSON Merge and OpenCode Adapter

**Files:**
- Create: `lib/merge/json.mjs`
- Create: `lib/agents/common.mjs`
- Create: `lib/agents/opencode.mjs`
- Create: `test/helpers.mjs`
- Test: `test/merge-json.test.mjs`
- Test: `test/agents-opencode.test.mjs`

**Interfaces:**
- Produces `hasJsonComments(text) -> boolean` and `mergeJson(text, patch) -> string`.
- Produces shared adapter helpers:
  - `change(key, from, to) -> { key, from, to }`
  - `commandExists(ctx, name) -> boolean`
  - `readJsonFile(ctx, filePath) -> object`
- Produces the OpenCode adapter object:
  - `detect(ctx) -> { detected, configPath, notes }`
  - `plan(ctx, policy) -> plan`
  - `apply(ctx, plan) -> { backupPath: string | null }`
  - `verify(ctx, policy) -> { effective, warnings, ok }`
  - `print(ctx, policy) -> string`
- Plan shape used by every adapter:
  `{ agentId, name, configPath, support, status, changes, effective, warnings, nextContent?, template? }`.
  `status` is `planned | noop | manual | missing | unsupported`.
  `effective` is `{ trigger: number | null, keep: number | null }`.

- [ ] **Step 1: Write the failing JSON merge tests**

```js
// test/merge-json.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasJsonComments, mergeJson } from '../lib/merge/json.mjs';

test('mergeJson preserves unrelated keys and nested objects', () => {
  const input = JSON.stringify({
    theme: 'dark',
    compaction: { auto: false, other: true },
  }, null, 2);
  const parsed = JSON.parse(mergeJson(input, {
    compaction: { auto: true, keep: { tokens: 50000 }, buffer: 10000 },
  }));
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.compaction.auto, true);
  assert.equal(parsed.compaction.other, true);
  assert.deepEqual(parsed.compaction.keep, { tokens: 50000 });
  assert.equal(parsed.compaction.buffer, 10000);
});

test('hasJsonComments ignores comment markers inside strings', () => {
  assert.equal(hasJsonComments('{"url":"https://example.com"}'), false);
  assert.equal(hasJsonComments('{"a":"/* not a comment */"}'), false);
  assert.equal(hasJsonComments('// comment\n{}'), true);
  assert.equal(hasJsonComments('/* block */ {}'), true);
});

test('mergeJson rejects invalid JSON', () => {
  assert.throws(() => mergeJson('{', {}), /JSON/);
});
```

- [ ] **Step 2: Run the JSON tests to verify they fail**

Run: `node --test test/merge-json.test.mjs`  
Expected: FAIL because `lib/merge/json.mjs` does not exist.

- [ ] **Step 3: Write the failing OpenCode adapter tests**

```js
// test/helpers.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeHomeFile(home, relative, content) {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export const fixedNow = () => new Date('2026-10-19T12:00:00Z');

export function makeCtx(home, overrides = {}) {
  return {
    home,
    env: {},
    fs,
    now: fixedNow,
    create: false,
    runCommand: () => ({ status: 1, stdout: '', stderr: '' }),
    ...overrides,
  };
}
```

```js
// test/agents-opencode.test.mjs
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
```

- [ ] **Step 4: Run the OpenCode tests to verify they fail**

Run: `node --test test/agents-opencode.test.mjs`  
Expected: FAIL because `lib/agents/opencode.mjs` does not exist.

- [ ] **Step 5: Implement JSON merge and the OpenCode adapter**

`mergeJson` parses the file, deep-merges plain objects, replaces arrays and
scalars, and returns `JSON.stringify(value, null, 2) + "\n"`. It throws
`Error("Invalid JSON: ...")` on parse failure.

`hasJsonComments` scans character by character, tracks strings and escapes, and
returns true only for `//` or `/*` outside a string.

`lib/agents/common.mjs`:

```js
import { hasJsonComments } from '../merge/json.mjs';

export function change(key, from, to) {
  return { key, from: from ?? null, to };
}
export function commandExists(ctx, name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return ctx.runCommand(cmd, [name], { timeout: 2000 }).status === 0;
}
export function readJsonFile(ctx, filePath) {
  const text = ctx.fs.readFileSync(filePath, 'utf8');
  if (hasJsonComments(text)) throw new Error(`JSON comments are not supported in ${filePath}`);
  try { return { text, value: JSON.parse(text) }; }
  catch (error) { throw new Error(`Invalid JSON in ${filePath}: ${error.message}`); }
}
```

OpenCode adapter behavior:

- `detect` checks the `.json` path and the `.jsonc` sibling; `detected` is true
  if either exists or `commandExists(ctx, 'opencode')`.
- If only `.jsonc` exists: `status: 'manual'`, `template` is the JSON snippet,
  no `nextContent`, never writes.
- If `.json` is missing: `status: 'missing'`, `nextContent` is built from `{}`.
  `apply` throws unless `ctx.create` is true.
- If both exist: add a warning that `.jsonc` may override the `.json` value.
- If `.json` has comments: throw.
- Patch: `{ compaction: { auto: true, keep: { tokens: policy.keep }, buffer: policy.context - policy.trigger } }`.
- `effective` is `{ trigger: policy.context - buffer, keep: policy.keep }`.
- Set `status: 'noop'` and `changes: []` when all three target values already
  match the policy. All adapters must implement this no-op detection; `apply`
  must not create a backup for a noop plan.
- `apply` calls `writeWithBackup(plan.configPath, plan.nextContent, { fs: ctx.fs, now: ctx.now })`.
- `verify` reads `.json`, checks `compaction.auto === true`,
  `compaction.keep.tokens === policy.keep`, and `compaction.buffer === context - trigger`;
  returns `ok: false` with warnings if any differ.
- `print` returns the same JSON snippet used for the manual path.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/merge-json.test.mjs test/agents-opencode.test.mjs`  
Expected: PASS (3 JSON tests, 5 OpenCode tests).

- [ ] **Step 7: Commit**

```bash
git add lib/merge/json.mjs lib/agents/common.mjs lib/agents/opencode.mjs test/helpers.mjs test/merge-json.test.mjs test/agents-opencode.test.mjs
git commit -m "feat: add JSON merge and OpenCode adapter"
```

### Task 4: Claude Code, Gemini CLI, and Qwen Code Adapters

**Files:**
- Create: `lib/agents/claude.mjs`
- Create: `lib/agents/gemini.mjs`
- Create: `lib/agents/qwen.mjs`
- Test: `test/agents-json.test.mjs`

**Interfaces:**
- Each adapter exports the same contract as OpenCode:
  `detect(ctx)`, `plan(ctx, policy)`, `apply(ctx, plan)`, `verify(ctx, policy)`, `print(ctx, policy)`.
- Claude `detect` additionally returns `version: string | null` by running
  `claude --version` through `ctx.runCommand`.
- All three adapters return `support: 'partial'` and
  `effective.keep: null`.

- [ ] **Step 1: Write the failing adapter tests**

```js
// test/agents-json.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import claude from '../lib/agents/claude.mjs';
import gemini from '../lib/agents/gemini.mjs';
import qwen from '../lib/agents/qwen.mjs';
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/agents-json.test.mjs`  
Expected: FAIL because the three adapter files do not exist.

- [ ] **Step 3: Implement the three JSON adapters**

Claude Code:

- Config path: `claudeConfigDir(home, env)/settings.json`.
- `detect` reads the file, and runs `ctx.runCommand('claude', ['--version'], { timeout: 2000 })`.
  Parse the first semver with `/(\d+)\.(\d+)\.(\d+)/`.
- `plan` calls `detect` internally. If the version supports the window and
  `trigger < 100000`, throw an error containing `100000`.
- If version is at least 2.1.288, patch both
  `{ autoCompactEnabled: true, autoCompactWindow: policy.trigger }`.
  Otherwise patch only `{ autoCompactEnabled: true }`, set
  `effective.trigger: null`, and warn that the window requires 2.1.288. In that
  older-version case, do not apply the 100K minimum because no window is written.
- `verify` reads `autoCompactWindow` when present; otherwise `trigger: null`.
  `keep` is always `null`.

Gemini CLI:

- Path: `~/.gemini/settings.json`.
- Read JSON. If `model.compressionThreshold` exists, update it. Else if
  `model.chatCompression.contextPercentageThreshold` exists, update that and
  warn. Else add `model.compressionThreshold`.
- Ratio: `policy.trigger / policy.context`. `effective.trigger` is
  `Math.round(ratio * policy.context)`; `keep: null`.
- If both keys exist, update the new key and warn that the legacy key remains.

Qwen Code:

- Path: `~/.qwen/settings.json`.
- Read JSON. If the retired
  `model.chatCompression.contextPercentageThreshold` exists, add a warning.
- Patch `{ context: { autoCompactThreshold: ratio } }`.
- `effective.trigger` is `Math.round(ratio * policy.context)`; `keep: null`.
- Warn that Qwen uses an internal warn/auto/hard ladder.

All three use `writeWithBackup` in `apply`, `readJsonFile` from
`agents/common.mjs`, and `mergeJson` for the next content. They support
`--create` the same way as OpenCode. They never write if `status` is `manual` or
`missing` without `ctx.create`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/agents-json.test.mjs`  
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/claude.mjs lib/agents/gemini.mjs lib/agents/qwen.mjs test/agents-json.test.mjs
git commit -m "feat: add Claude, Gemini, and Qwen adapters"
```

### Task 5: TOML Merge and Codex CLI Adapter

**Files:**
- Create: `lib/merge/toml.mjs`
- Create: `lib/agents/codex.mjs`
- Test: `test/merge-toml.test.mjs`
- Test: `test/agents-codex.test.mjs`

**Interfaces:**
- Produces:
  - `mergeTopLevelToml(text, values) -> string`
  - `readTopLevelTomlValues(text, keys) -> Record<string, string | undefined>`
  - `findKeysInTables(text, keys) -> Array<{ table: string, key: string, line: number }>`
- Codex adapter uses the standard adapter contract and returns
  `support: 'partial'`, `effective.keep: null`.

- [ ] **Step 1: Write the failing TOML tests**

```js
// test/merge-toml.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTopLevelToml,
  readTopLevelTomlValues,
  findKeysInTables,
} from '../lib/merge/toml.mjs';

const input = `# top
model = "deepseek-flash"
model_context_window = 100000 # old

[model_providers.custom]
experimental_bearer_token = "sk-test-not-real"

[profiles.small]
model_context_window = 64000
`;

test('updates top-level values, preserves comments and secrets', () => {
  const output = mergeTopLevelToml(input, {
    model_context_window: 200000,
    model_auto_compact_token_limit: 190000,
  });
  assert.match(output, /model_context_window = 200000 # old/);
  assert.match(output, /model_auto_compact_token_limit = 190000/);
  assert.match(output, /experimental_bearer_token = "sk-test-not-real"/);
  assert.match(output, /model_context_window = 64000/);
});

test('inserts missing top-level keys before the first table', () => {
  const output = mergeTopLevelToml('model = "x"\n\n[providers.a]\nkey = "v"\n', {
    model_context_window: 200000,
  });
  assert.ok(output.indexOf('model_context_window = 200000') < output.indexOf('[providers.a]'));
});

test('reads top-level values and finds table overrides', () => {
  assert.deepEqual(
    readTopLevelTomlValues(input, ['model_context_window', 'model_auto_compact_token_limit']),
    { model_context_window: '100000', model_auto_compact_token_limit: undefined },
  );
  assert.deepEqual(findKeysInTables(input, ['model_context_window']), [
    { table: 'profiles.small', key: 'model_context_window', line: 9 },
  ]);
});

test('merge is idempotent', () => {
  const once = mergeTopLevelToml(input, { model_context_window: 200000 });
  assert.equal(mergeTopLevelToml(once, { model_context_window: 200000 }), once);
});
```

- [ ] **Step 2: Run the TOML tests to verify they fail**

Run: `node --test test/merge-toml.test.mjs`  
Expected: FAIL because `lib/merge/toml.mjs` does not exist.

- [ ] **Step 3: Write the failing Codex adapter tests**

```js
// test/agents-codex.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import codex from '../lib/agents/codex.mjs';
import { resolvePolicy } from '../lib/policy.mjs';
import { tempHome, writeHomeFile, makeCtx } from './helpers.mjs';

const policy = resolvePolicy();
const relative = path.join('.codex', 'config.toml');

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
```

- [ ] **Step 4: Run the Codex tests to verify they fail**

Run: `node --test test/agents-codex.test.mjs`  
Expected: FAIL because `lib/agents/codex.mjs` does not exist.

- [ ] **Step 5: Implement the TOML editor and Codex adapter**

`mergeTopLevelToml`:

- Detect `\r\n` vs `\n` and preserve it.
- Split into lines. Only lines before the first table header (`^\s*\[`) are
  top-level.
- Match `^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*)$`.
- For target keys, replace the value but preserve a trailing `#` comment
  outside quotes. Use a small scanner; do not use a regex that can split a `#`
  inside a string.
- Insert missing keys immediately before the first table header, or at EOF if
  there is no table.
- Do not modify same-named keys inside tables.
- If a top-level value starts a multiline string (`"""` or `'''`) before the
  first table, abort with an ambiguity error instead of guessing.
- Preserve whether the original ended with a newline.

`readTopLevelTomlValues` returns raw value strings (trimmed) for the requested
keys before the first table. `findKeysInTables` tracks the current table and
returns key occurrences inside tables with 1-based line numbers.

Codex adapter:

- Root: `codexHome(home, env)`, file `config.toml`.
- `plan` builds `nextContent` with
  `mergeTopLevelToml(text, { model_context_window: policy.context, model_auto_compact_token_limit: policy.trigger })`.
- If `findKeysInTables` finds either key, add a warning that the active profile
  may override the top-level values.
- `effective` is `{ trigger: policy.trigger, keep: null }`.
- `apply` uses `writeWithBackup`; `verify` parses the two top-level values and
  checks `Number(...)`.
- `print` returns the two-line TOML snippet.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/merge-toml.test.mjs test/agents-codex.test.mjs`  
Expected: PASS (4 TOML tests, 3 Codex tests).

- [ ] **Step 7: Commit**

```bash
git add lib/merge/toml.mjs lib/agents/codex.mjs test/merge-toml.test.mjs test/agents-codex.test.mjs
git commit -m "feat: add TOML merge and Codex adapter"
```

### Task 6: YAML Merge and DSH Adapter

**Files:**
- Create: `lib/merge/yaml.mjs`
- Create: `lib/agents/dsh.mjs`
- Test: `test/merge-yaml.test.mjs`
- Test: `test/agents-dsh.test.mjs`

**Interfaces:**
- Produces:
  - `mergeDshCompactionBlock(text, config) -> string`
  - `readDshCompactionConfig(text) -> { found: boolean, config: Record<string, unknown> }`
- The DSH adapter uses the standard contract and returns `support: 'full'`.
- `ctx.profile` is the selected profile name, or `undefined`.

- [ ] **Step 1: Write the failing YAML tests**

```js
// test/merge-yaml.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeDshCompactionBlock,
  readDshCompactionConfig,
} from '../lib/merge/yaml.mjs';

const config = {
  auto: true,
  thresholdRatio: 0.95,
  headroomTokens: 0,
  maxTokens: 8192,
  retainTokens: 50000,
};

test('appends a compaction-basic block to an empty patch', () => {
  const output = mergeDshCompactionBlock('[]\n', config);
  assert.match(output, /- id: compaction-basic/);
  assert.match(output, /thresholdRatio: 0\.95/);
  assert.match(output, /retainTokens: 50000/);
  assert.equal(output.split(/\r?\n/).includes('[]'), false);
  assert.deepEqual(readDshCompactionConfig(output), { found: true, config });
});

test('updates an existing block and preserves comments and unknown keys', () => {
  const input = [
    '# keep this comment',
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    thresholdRatio: 0.8 # old',
    '    modelPolicies:',
    '      - provider: local',
    '        model: small-context',
    '        retainTokens: 2048',
    '    auto: false',
    '',
  ].join('\n');
  const output = mergeDshCompactionBlock(input, config);
  assert.match(output, /# keep this comment/);
  assert.match(output, /thresholdRatio: 0\.95 # old/);
  assert.match(output, /modelPolicies:/);
  assert.match(output, /retainTokens: 2048/);
  assert.match(output, /auto: true/);
});

test('rejects duplicate compaction-basic entries', () => {
  const input = [
    '- id: compaction-basic',
    '  config: {}',
    '- id: compaction-basic',
    '  config: {}',
    '',
  ].join('\n');
  assert.throws(() => mergeDshCompactionBlock(input, config), /duplicate/i);
});

test('rejects flow-style config', () => {
  const input = [
    '- id: compaction-basic',
    '  config: { thresholdRatio: 0.8 }',
    '',
  ].join('\n');
  assert.throws(() => mergeDshCompactionBlock(input, config), /flow/i);
});

test('merge is idempotent', () => {
  const once = mergeDshCompactionBlock('[]\n', config);
  assert.equal(mergeDshCompactionBlock(once, config), once);
});
```

- [ ] **Step 2: Run the YAML tests to verify they fail**

Run: `node --test test/merge-yaml.test.mjs`  
Expected: FAIL because `lib/merge/yaml.mjs` does not exist.

- [ ] **Step 3: Write the failing DSH adapter tests**

```js
// test/agents-dsh.test.mjs
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

test('DSH plan targets 190K and 50K on one profile', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, desktop, '[]\n');
  const plan = dsh.plan(makeCtx(home), policy);
  assert.equal(plan.support, 'full');
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
```

- [ ] **Step 4: Run the DSH tests to verify they fail**

Run: `node --test test/agents-dsh.test.mjs`  
Expected: FAIL because `lib/agents/dsh.mjs` does not exist.

- [ ] **Step 5: Implement the YAML block editor and DSH adapter**

`mergeDshCompactionBlock` is a line-oriented editor, not a full YAML parser:

- Detect and preserve `\r\n` vs `\n`.
- Find entries whose trimmed line is `- id: compaction-basic` or
  `- name: '@deepseek-ai/dsh-compaction-basic'` (allow double quotes). Count
  matching blocks, not matching lines: a block containing both `id` and `name`
  is one entry, not two.
- An entry ends at the next line with indentation less than or equal to the
  entry indent that starts with `-`, or at EOF.
- If two entries match, throw `Error("Duplicate compaction-basic entries")`.
- If the entry contains a flow-style `config: { ... }`, throw
  `Error("Flow-style compaction-basic config is not supported")`.
- Find the `config:` line within the entry. If absent, add `  config:` after the
  `name` line, then add keys at four spaces.
- Parse existing `key: value` lines inside the config block. Preserve every
  unknown key and nested block (for example `modelPolicies`) exactly.
- Only update keys at the direct config indentation (the same indent as
  `thresholdRatio`). Never update same-named keys inside a nested mapping such
  as `modelPolicies[].retainTokens`.
- Update the five target keys, preserving a trailing YAML `# comment`.
- If no entry exists and the trimmed file is empty or exactly `[]`, replace the
  file with the new block. Do not append a `-` entry after a flow-style `[]`,
  because that would be invalid YAML.
- Otherwise append the block from the spec, preceded by a blank line when the
  file is not empty.
- `readDshCompactionConfig` finds the single entry, parses the target keys with
  `Number`/boolean conversion, and returns `{ found, config }`.

DSH adapter:

- Profiles live under `dshHome(home, env)/profiles/*/cordis.patch.yml`.
- If `ctx.profile` is set, use it and verify the file exists or `ctx.create`.
- If exactly one profile exists, use it.
- If multiple exist and `ctx.profile` is missing, `detect` returns
  `detected: true` with a note listing the profiles; `plan` throws an error
  containing `--profile`.
- If none exist and `ctx.profile` is missing, `detect` returns
  `detected: false` and never throws; an explicit `plan --agents dsh` throws an
  error asking for `--profile`.
- Build config:
  `{ auto: true, thresholdRatio: policy.trigger / policy.context, headroomTokens: 0, maxTokens: 8192, retainTokens: policy.keep }`.
- Compute `actualTrigger = dshEffectiveTrigger(policy)`. If
  `policy.keep >= actualTrigger`, throw an error containing `retain`.
- If `actualTrigger !== policy.trigger`, add a warning with both values.
- `effective` is `{ trigger: actualTrigger, keep: policy.keep }`.
- `apply` uses `writeWithBackup`; `verify` uses
  `readDshCompactionConfig` and checks `auto`, `thresholdRatio`, `retainTokens`,
  and the computed trigger.
- `print` returns the YAML block from the spec.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/merge-yaml.test.mjs test/agents-dsh.test.mjs`  
Expected: PASS (5 YAML tests, 5 DSH tests).

- [ ] **Step 7: Commit**

```bash
git add lib/merge/yaml.mjs lib/agents/dsh.mjs test/merge-yaml.test.mjs test/agents-dsh.test.mjs
git commit -m "feat: add YAML merge and DSH adapter"
```

### Task 7: Adapter Registry and Detection

**Files:**
- Create: `lib/registry.mjs`
- Test: `test/registry.test.mjs`

**Interfaces:**
- Produces:
  - `ADAPTERS` — array of the six adapter objects in this order: OpenCode,
    DSH, Codex, Claude, Gemini, Qwen.
  - `getAdapter(id) -> adapter | undefined`
  - `parseAgentSelection(value) -> string[]` (`undefined` or `"all"` returns all IDs).
  - `resolveAdapters(ids) -> adapter[]`
  - `detectAdapters(adapters, ctx) -> Array<{ adapter, detection }>`

- [ ] **Step 1: Write the failing registry tests**

```js
// test/registry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ADAPTERS,
  getAdapter,
  parseAgentSelection,
  resolveAdapters,
  detectAdapters,
} from '../lib/registry.mjs';
import { tempHome, writeHomeFile, makeCtx } from './helpers.mjs';

test('registry exposes the six adapters in order', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id), [
    'opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen',
  ]);
});

test('selection accepts all, a comma list, and rejects unknown ids', () => {
  assert.deepEqual(parseAgentSelection('all'), [
    'opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen',
  ]);
  assert.deepEqual(parseAgentSelection('opencode, codex'), ['opencode', 'codex']);
  assert.throws(() => parseAgentSelection('nope'), /Unknown agent/);
  assert.equal(getAdapter('dsh').id, 'dsh');
});

test('resolveAdapters preserves the requested order', () => {
  assert.deepEqual(resolveAdapters(['codex', 'opencode']).map((a) => a.id), [
    'codex', 'opencode',
  ]);
});

test('detectAdapters reports configured agents', (t) => {
  const home = tempHome(t);
  writeHomeFile(home, path.join('.config', 'opencode', 'opencode.json'), '{}\n');
  writeHomeFile(home, path.join('.codex', 'config.toml'), 'model = "x"\n');
  const results = detectAdapters(ADAPTERS, makeCtx(home));
  const detected = results.filter((r) => r.detection.detected).map((r) => r.adapter.id);
  assert.deepEqual(detected.sort(), ['codex', 'opencode']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/registry.test.mjs`  
Expected: FAIL because `lib/registry.mjs` does not exist.

- [ ] **Step 3: Implement the registry**

Import the six adapters and export them in the order above. `parseAgentSelection`
splits on commas, trims, filters empty entries, and validates each ID with
`getAdapter`. `resolveAdapters` maps IDs to objects. `detectAdapters` calls
`adapter.detect(ctx)` and returns `{ adapter, detection }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/registry.test.mjs`  
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/registry.mjs test/registry.test.mjs
git commit -m "feat: add adapter registry and detection"
```

### Task 8: Report Rendering and Read-Only CLI

**Files:**
- Create: `lib/report.mjs`
- Create: `lib/cli.mjs`
- Create: `bin/agent-compact.mjs`
- Test: `test/report.test.mjs`
- Test: `test/cli-plan.test.mjs`

**Interfaces:**
- `sanitizePlan(plan) -> object` removes `nextContent` and `currentContent`.
- `toJsonReport(result) -> string` — pretty JSON plus newline; agents are sanitized.
- `toHumanReport(result, { color = false } = {}) -> string`.
- `runCli(argv, io = {}) -> Promise<number>`.
  - `io` accepts `{ stdout, stderr, fs, env, now, runCommand, isTTY }`.
  - `stdout` and `stderr` need only `.write(text)`.
- `bin/agent-compact.mjs` is a shebang entry that calls `runCli(process.argv.slice(2))` and assigns `process.exitCode`.

- [ ] **Step 1: Write the failing report tests**

```js
// test/report.test.mjs
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

test('JSON report contains no secrets or nextContent', () => {
  const json = toJsonReport(result);
  assert.equal(json.includes('sk-test-not-real'), false);
  assert.equal(json.includes('nextContent'), false);
  assert.equal(JSON.parse(json).agents[0].effective.trigger, 190000);
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
```

- [ ] **Step 2: Run the report tests to verify they fail**

Run: `node --test test/report.test.mjs`  
Expected: FAIL because `lib/report.mjs` does not exist.

- [ ] **Step 3: Write the failing CLI tests**

```js
// test/cli-plan.test.mjs
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
```

- [ ] **Step 4: Run the CLI tests to verify they fail**

Run: `node --test test/cli-plan.test.mjs`  
Expected: FAIL because `bin/agent-compact.mjs` does not exist.

- [ ] **Step 5: Implement report rendering**

`lib/report.mjs`:

- `sanitizePlan` copies the plan and deletes `nextContent` and `currentContent`.
- `toJsonReport` maps `result.agents` through `sanitizePlan` when present, returns
  `JSON.stringify(sanitized, null, 2) + "\n"`.
- `toHumanReport` prints:
  - `agent-compact <version>`
  - `Policy: context <n>, trigger <n>, keep <n>`
  - for `detect`: each agent's `name`, `detected`, `configPath`, `notes`.
  - for `plan`: each agent's `name`, `support`, `status`, `configPath`, changes
    as `key: (unset|value) -> value`, `effective: trigger <n>, keep <n|N/A>`,
    warnings, and `template` when status is `manual`.
  - for `print`: each template under its agent name.
- No ANSI when `color` is false. Use a no-op painter.
- Never include `nextContent` or whole config text.

- [ ] **Step 6: Implement the read-only CLI commands**

`lib/cli.mjs` uses `parseArgs` from `node:util`. Implement `detect`, `plan`,
`print`, `--help`, and `--version` in this task. Help text lists those commands;
Task 9 extends it with `apply`, `verify`, and `restore`.

Option parsing details:

- Options: `agents`, `context`, `trigger`, `keep`, `profile`, `yes`, `create`,
  `strict`, `json`, `home`, `no-color`, `version`, `help`, `latest`, `file`,
  `agent`.
- `allowPositionals: true`, `strict: true`.
- Parse numeric options with `Number` and require `Number.isInteger`. Only add a
  value to the policy override object when the option was supplied.
- `ctx` is `{ home, env, fs, now, runCommand, create, profile }`.
- `home` is `resolveHome({ home: values.home, env })`.
- Selection:
  - If `--agents` is supplied, use `resolveAdapters(parseAgentSelection(values.agents))`.
    `--agents all` explicitly selects all six.
  - Otherwise, detect all six with `detectAdapters(ADAPTERS, ctx)` and select only
    those with `detection.detected`. If none are detected, print a message and
    return 2. This prevents an unconfigured DSH from making `plan` fail on a
    machine that only has OpenCode and Codex.
  - `detect` always reports all six, including `detected: false`.
- `runCli` catches errors, writes `agent-compact: <message>` to `stderr`, and
  returns 1. Error messages must contain only paths and known values.
- `plan` maps each adapter's plan through `sanitizePlan`. If any adapter throws,
  the whole command exits 1.
- `--strict` with any `support === 'partial'` writes the result first, then
  returns 2. It does not write config files.
- `--json` writes only the JSON report to stdout.
- `--version` reads `package.json` relative to `lib/cli.mjs` and prints its
  `version`.
- `--help` prints `Usage: agent-compact <command> [options]` and the command
  list.
- `print` with `--agent` selects one adapter; with `--agents` uses that list;
  otherwise it prints all six. It must not require a detected profile, so the
  DSH template is always available.
- `detect` returns `{ id, name, support, detected, configPath, version, notes }`
  per agent.

`bin/agent-compact.mjs`:

```js
#!/usr/bin/env node
import { runCli } from '../lib/cli.mjs';

process.exitCode = await runCli(process.argv.slice(2));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/report.test.mjs test/cli-plan.test.mjs`  
Expected: PASS (3 report tests, 5 CLI tests).

- [ ] **Step 8: Commit**

```bash
git add lib/report.mjs lib/cli.mjs bin/agent-compact.mjs test/report.test.mjs test/cli-plan.test.mjs
git commit -m "feat: add read-only CLI and report rendering"
```

### Task 9: Apply, Verify, Restore, and Transaction Rollback

**Files:**
- Modify: `lib/backup.mjs` (optional `afterApply` callback)
- Modify: `lib/cli.mjs` (add `apply`, `verify`, `restore`; extend help)
- Test: `test/cli-apply.test.mjs`
- Test: `test/cli-restore.test.mjs`

**Interfaces:**
- `applyTransaction(entries, { fs, now, afterApply } = {}) -> { applied }`.
  - `afterApply(entry)` runs after each successful write. If it throws, the
    transaction restores every applied entry, including the current one.
- CLI `apply` result:
  `{ version, command: 'apply', policy, applied, agents }`, where `applied` is
  `[{ agentId, configPath, backupPath }]` and `agents` is the verification list.
- CLI `verify` result:
  `{ version, command: 'verify', policy, agents }`, each agent with
  `{ id, name, support, configPath, effective, warnings, ok, status }`.
- CLI `restore` result:
  `{ version, command: 'restore', restored, warnings }`, each restored item with
  `{ agentId, configPath, backupPath, safetyBackupPath }`.

- [ ] **Step 1: Write the failing apply/verify tests**

```js
// test/cli-apply.test.mjs
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
```

- [ ] **Step 2: Run the apply tests to verify they fail**

Run: `node --test test/cli-apply.test.mjs`  
Expected: FAIL because `runCli` has no `apply` command.

- [ ] **Step 3: Write the failing restore tests**

```js
// test/cli-restore.test.mjs
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
```

- [ ] **Step 4: Run the restore tests to verify they fail**

Run: `node --test test/cli-restore.test.mjs`  
Expected: FAIL because `runCli` has no `restore` command.

- [ ] **Step 5: Implement the writing commands and transaction callback**

Extend `applyTransaction` in `lib/backup.mjs`:

```js
export function applyTransaction(entries, { fs, now, afterApply } = {}) {
  const applied = [];
  try {
    for (const entry of entries) {
      if (entry.plan.status === 'noop') continue;
      const result = entry.adapter.apply(entry.ctx, entry.plan);
      const item = {
        agentId: entry.agentId,
        configPath: entry.configPath,
        backupPath: result.backupPath ?? null,
      };
      applied.push(item);
      if (afterApply) afterApply({ ...entry, backupPath: item.backupPath });
    }
    return { applied };
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.backupPath) restoreExact(item.backupPath, item.configPath, { fs });
      else fs.rmSync(item.configPath, { force: true });
    }
    throw error;
  }
}
```

Add `apply` in `lib/cli.mjs`:

1. Build plans with `selected.map((adapter) => adapter.plan(ctx, policy))`.
2. Abort before writing if any plan is `manual` (message says use `print`) or
   `missing` without `ctx.create` (message says use `--create`).
3. If `--strict` and any plan has `support === 'partial'`, write the sanitized
   plan report and return 2 without writing.
4. Confirm unless `--yes`. In a non-interactive session, refuse with exit 1 and
   a message containing `--yes`. Use `readline/promises` only when `isTTY` is
   true; a “no” answer returns 0 with an aborted message.
5. Call `applyTransaction` with `afterApply(entry)` that runs
   `entry.adapter.verify(entry.ctx, policy)` and throws if `ok` is false.
6. Re-run verify for all selected adapters and return the apply result. If any
   verify is not `ok`, return 1.

Add `verify` in `lib/cli.mjs`:

- For each selected adapter, call `verify(ctx, policy)`.
- Add `{ id, name, support, configPath, status: ok ? 'ok' : 'mismatch' }`.
- Return 1 if any `ok` is false.
- Under `--strict`, return 2 if any `support === 'partial'`.

Add `restore` in `lib/cli.mjs`:

- `--file <path>`: require the path to contain `.bak-agent-compact-`; target is
  `path.replace(/\.bak-agent-compact-.*$/, '')`, and agent ID is `explicit`.
  Abort if the suffix is missing, so a normal config file is never overwritten
  with itself as a “restore”.
- Otherwise, for each selected adapter, call `detect(ctx)` and use
  `findLatestBackup(detection.configPath, { fs })`. Skip agents with no config
  path or no backup, and add a warning.
- If no backups are found, write the warnings and return 2.
- Confirm unless `--yes`; non-interactive without `--yes` returns 1.
- For each backup, call `restoreBackup(backupPath, targetPath, { fs, now })`.
- Return `{ version, command: 'restore', restored, warnings }`.

Extend help text with `apply`, `verify`, and `restore`. The `--json` output for
all three commands must use `sanitizePlan` anywhere a plan is included and must
never include `nextContent`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/cli-apply.test.mjs test/cli-restore.test.mjs`  
Expected: PASS (7 apply tests, 3 restore tests).

- [ ] **Step 7: Run the full suite**

Run: `node --test`  
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/backup.mjs lib/cli.mjs test/cli-apply.test.mjs test/cli-restore.test.mjs
git commit -m "feat: add apply, verify, restore, and rollback"
```

### Task 10: Documentation, Preset Metadata, CI, and Release Readiness

**Files:**
- Create: `README.md`
- Create: `README.zh-CN.md`
- Create: `LICENSE`
- Create: `presets/default.json`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (add `bin` and `files`)
- Test: `test/preset.test.mjs`
- Test: `test/docs.test.mjs`
- Test: `test/privacy.test.mjs`

**Interfaces:**
- No runtime interface changes.
- `presets/default.json` is documentation and machine-readable metadata. It must
  match `DEFAULT_POLICY` and the six adapter IDs.

- [ ] **Step 1: Write the failing preset and docs tests**

```js
// test/preset.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_POLICY } from '../lib/policy.mjs';

const preset = JSON.parse(
  fs.readFileSync(new URL('../presets/default.json', import.meta.url), 'utf8'),
);

test('preset matches the default policy', () => {
  assert.deepEqual(preset.policy, DEFAULT_POLICY);
});

test('preset lists all six agents with support levels', () => {
  assert.deepEqual(Object.keys(preset.agents), [
    'opencode', 'dsh', 'codex', 'claude', 'gemini', 'qwen',
  ]);
  assert.equal(preset.agents.opencode.support, 'full');
  assert.equal(preset.agents.dsh.support, 'full');
  for (const id of ['codex', 'claude', 'gemini', 'qwen']) {
    assert.equal(preset.agents[id].support, 'partial');
  }
});
```

```js
// test/docs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const zh = fs.readFileSync(new URL('../README.zh-CN.md', import.meta.url), 'utf8');

test('README documents every agent and the default policy', () => {
  for (const name of ['OpenCode', 'DSH', 'Codex', 'Claude Code', 'Gemini CLI', 'Qwen Code']) {
    assert.match(readme, new RegExp(name));
  }
  assert.match(readme, /190,?000/);
  assert.match(readme, /50,?000/);
  assert.match(readme, /partial/i);
  assert.match(readme, /backup/i);
  assert.match(readme, /restore/i);
});

test('Chinese README covers the same capability matrix', () => {
  for (const name of ['OpenCode', 'DSH', 'Codex', 'Claude Code', 'Gemini CLI', 'Qwen Code']) {
    assert.match(zh, new RegExp(name));
  }
  assert.match(zh, /部分支持|partial/i);
});
```

- [ ] **Step 2: Write the failing privacy test**

```js
// test/privacy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
}).trim().split(/\r?\n/).filter(Boolean);

const textExtensions = new Set(['.md', '.json', '.mjs', '.js', '.yml', '.yaml', '.toml', '.txt']);

test('tracked and untracked text files contain no real-looking secrets', () => {
  for (const file of files) {
    if (!textExtensions.has(path.extname(file)) && file !== 'LICENSE' && file !== '.gitignore') {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}/, `${file} contains a real-looking key`);
    assert.doesNotMatch(text, /C:\\Users\\Asus/i, `${file} contains a machine path`);
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/preset.test.mjs test/docs.test.mjs test/privacy.test.mjs`  
Expected: FAIL because the documentation, preset, and license files do not exist.

- [ ] **Step 4: Create the preset and documentation**

`presets/default.json`:

```json
{
  "name": "default",
  "policy": { "context": 200000, "trigger": 190000, "keep": 50000 },
  "agents": {
    "opencode": { "support": "full", "keys": ["compaction.auto", "compaction.keep.tokens", "compaction.buffer"] },
    "dsh": { "support": "full", "keys": ["thresholdRatio", "headroomTokens", "maxTokens", "retainTokens"] },
    "codex": { "support": "partial", "keys": ["model_context_window", "model_auto_compact_token_limit"] },
    "claude": { "support": "partial", "keys": ["autoCompactEnabled", "autoCompactWindow"] },
    "gemini": { "support": "partial", "keys": ["model.compressionThreshold"] },
    "qwen": { "support": "partial", "keys": ["context.autoCompactThreshold"] }
  }
}
```

`README.md` sections, in order:

1. Title and one-paragraph description: writes native compaction settings, no
   proxy, no plugin, no API-key handling.
2. Capability matrix with the six agents, config paths, trigger keys, retention
   keys, and `full`/`partial`.
3. Quick start:
   `node bin/agent-compact.mjs detect`
   `node bin/agent-compact.mjs plan`
   `node bin/agent-compact.mjs apply --yes`
   `node bin/agent-compact.mjs verify`
   `node bin/agent-compact.mjs restore --latest --yes`
4. Commands and options, matching the CLI.
5. Exact values written:
   - OpenCode: `compaction.auto: true`, `compaction.keep.tokens: 50000`,
     `compaction.buffer: 10000`.
   - DSH: `auto: true`, `thresholdRatio: 0.95`, `headroomTokens: 0`,
     `maxTokens: 8192`, `retainTokens: 50000`.
   - Codex: `model_context_window = 200000`,
     `model_auto_compact_token_limit = 190000`.
   - Claude Code: `autoCompactEnabled: true`,
     `autoCompactWindow: 190000` (v2.1.288+).
   - Gemini CLI: `model.compressionThreshold: 0.95`.
   - Qwen Code: `context.autoCompactThreshold: 0.95`.
6. Full vs partial support: only OpenCode and DSH can retain 50K; the other four
   report `N/A`, and no claim of 50K retention is made.
7. Backup, verify, restore, and the `.bak-agent-compact-*` naming.
8. Manual template for OpenCode JSONC with comments.
9. Limitations: 250K on a 200K model is impossible; ratio settings are relative;
   Claude minimum 100K; DSH output cap; Gemini/Qwen internal ladders; Cursor,
   Cline/Roo, Aider, Continue, Copilot CLI are out of scope.
10. Development: `node --test`; no runtime dependencies.
11. License: MIT.

`README.zh-CN.md` is a faithful Chinese translation of the same sections and the
same values. Do not invent additional capabilities.

`LICENSE` is the standard MIT text with
`Copyright (c) 2026 agent-compaction-preset contributors`.

- [ ] **Step 5: Add the package metadata and CI**

Add to `package.json`:

```json
"bin": { "agent-compact": "./bin/agent-compact.mjs" },
"files": ["bin", "lib", "presets", "README.md", "README.zh-CN.md", "LICENSE"]
```

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [20, 22, 24]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: node --test
      - run: node bin/agent-compact.mjs --help
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test`  
Expected: all tests pass, including the privacy scan.

- [ ] **Step 7: Verify the CLI manually**

Run:

```bash
node bin/agent-compact.mjs --help
node bin/agent-compact.mjs --version
node bin/agent-compact.mjs print --agent opencode
```

Expected: help lists all commands, version is `0.1.0`, and the OpenCode template
contains the three compaction keys. Do not run `apply` against real user configs
in this step.

- [ ] **Step 8: Commit**

```bash
git add README.md README.zh-CN.md LICENSE presets/default.json .github/workflows/ci.yml package.json test/preset.test.mjs test/docs.test.mjs test/privacy.test.mjs
git commit -m "docs: add README, preset metadata, and CI"
```

## Plan Self-Review

**Spec coverage:**

- Default 200K/190K/50K policy and `--context` recomputation: Task 1.
- Six adapters: OpenCode (Task 3), Claude/Gemini/Qwen (Task 4), Codex (Task 5),
  DSH (Task 6).
- Full vs partial support: adapter `support` fields and README matrix (Task 10).
- Read-only `plan`, JSON output, strict mode: Task 8.
- `apply`, `verify`, `restore`, backups, rollback, idempotence: Tasks 2 and 9.
- JSONC fallback, TOML comment preservation, YAML duplicate/flow guards: Tasks 3,
  5, and 6.
- Tests, CI, privacy scan, LICENSE, README (EN/ZH): Task 10.
- No npm publish: Task 10 and the global constraints.

**Type consistency:**

- Every adapter returns a plan with
  `{ agentId, name, configPath, support, status, changes, effective, warnings, nextContent?, template? }`.
- Every `verify` returns `{ effective, warnings, ok }`; partial agents use
  `keep: null`.
- Every `apply` returns `{ backupPath: string | null }`; a null backup means the
  file was created.
- `ctx` consistently carries `{ home, env, fs, now, runCommand, create, profile }`.
- `applyTransaction` is synchronous because all adapter writes are synchronous;
  Task 9 adds the optional synchronous `afterApply` callback.
- `runCli` is asynchronous only because interactive confirmation uses
  `readline/promises`.

**Placeholder scan:**

- No `TBD`, `TODO`, `FIXME`, or “implement later” steps remain.
- Task 8 intentionally implements only the read-only commands; Task 9 adds the
  writing commands and updates help text. This is a task boundary, not a
  placeholder.
- Every test step has an exact command and expected result.
- Every task ends with an exact `git add` and commit message.

**Review Focus mapping:**

1. Secrets: Task 5 Codex bearer-token fixture; Task 8 `--json` assertion; Task 10
   repository-wide privacy scan.
2. JSONC: Task 3 manual-only test and unchanged-bytes assertion.
3. DSH ambiguity: Task 6 multiple-profile, duplicate-entry, and flow-style tests.
4. Codex profile overrides: Task 5 preservation and warning tests.
5. Windows write failure: Task 2 failed-rename and rollback tests; Task 9
   injected second-write failure; Task 10 Windows CI job.

**Execution notes:**

- Use `superpowers:subagent-driven-development` for independent tasks, or
  `superpowers:executing-plans` for inline execution.
- Run each task's tests before committing. Do not combine task commits.
- Use temporary homes in every test; never write to the real user configs during
  development.
- The release is GitHub-first. `gh auth login` is required before creating the
  public repository; it is not a code task.
- If an implementation detail conflicts with this plan, update the plan and the
  spec before changing behavior. Do not silently invent a different policy.










