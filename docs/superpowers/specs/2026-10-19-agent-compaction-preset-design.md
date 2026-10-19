# Agent Compaction Preset — Design Spec

- Date: 2026-10-19
- Status: Draft for review
- Repository: `agent-compaction-preset`
- CLI: `agent-compact`
- License: MIT
- Runtime: Node.js >= 20
- Runtime dependencies: none

## 1. Purpose

`agent-compaction-preset` is a cross-agent configuration preset and installer for
context compaction. It writes each supported agent's native compaction settings,
using one policy definition, and reports honestly which agents support the full
policy and which only support a subset.

The project was previously scoped as an OpenCode-only preset. This design
replaces that scope with a multi-agent adapter architecture. OpenCode remains a
supported adapter, but the project name and documentation are no longer tied to
it.

## 2. Goals

1. Support six CLI agents in the first release:
   - OpenCode
   - DeepSeek Harness (DSH)
   - Codex CLI
   - Claude Code
   - Gemini CLI
   - Qwen Code
2. Apply a default policy of:
   - context window: 200,000 tokens
   - automatic compaction trigger: 190,000 tokens
   - recent raw context retained after compaction: 50,000 tokens
3. Allow `--context` to recompute all native values for a different window.
4. Never claim support for a setting an agent does not expose.
5. Make every write previewable, reversible, and safe around secrets.
6. Ship a zero-dependency Node CLI with tests and GitHub Actions CI.

## 3. Non-goals

- No request proxy, certificate interception, streaming rewrite, or runtime
  plugin. This project only writes native configuration.
- No model routing, provider setup, API key management, or model switching.
- No automatic upgrade of the agents themselves.
- No Cursor, Cline/Roo, Aider, Continue, Copilot CLI, or IDE extension support in
  v0.1.0. Several of these have no global compaction threshold or no
  summarization-based compaction.
- No npm publication in v0.1.0. The first release is a public GitHub repository.
- No attempt to make all agents retain exactly 50,000 tokens. Only agents with a
  native retention setting can do that.

## 4. Decisions

| Topic | Decision |
|---|---|
| Project name | `agent-compaction-preset` |
| CLI name | `agent-compact` |
| Architecture | Single CLI + adapter registry |
| Default context | 200,000 tokens |
| Default trigger | 190,000 tokens |
| Default retained raw context | 50,000 tokens |
| Trigger strategy | Fixed 190K target on a 200K window; `--context` recomputes |
| Full-support agents | OpenCode, DSH |
| Trigger-only agents | Codex CLI, Claude Code, Gemini CLI, Qwen Code |
| Config write model | Detect → plan → apply → verify; dry-run by default for `plan` |
| Write safety | Backup, atomic write, all-or-nothing apply, rollback |
| Secrets | Never print values outside the targeted keys |
| Dependencies | None at runtime; Node built-ins only |
| License | MIT |

### 4.1 Why fixed 190K/50K

The user's original target was a 250K trigger on a 200K-context model. That is
not representable: the trigger would exceed the model window. The closest safe
target is 190K, leaving 10K of headroom. The 50K retained-context target is
preserved where the agent supports an absolute retention setting.

The preset is therefore defined as a policy for a 200K model. Other windows are
supported by passing `--context`, but a single global config cannot
simultaneously represent different absolute triggers for different models in
agents whose native setting is relative to the model window. This limitation is
documented per adapter.

## 5. Capability Matrix

| Agent | Config file | Trigger setting | Retention setting | Support |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | `compaction.buffer` (relative) | `compaction.keep.tokens` | Full |
| DSH | `~/.dsh/profiles/<profile>/cordis.patch.yml` | `compaction-basic.thresholdRatio` + `headroomTokens` | `retainTokens` | Full |
| Codex CLI | `~/.codex/config.toml` | `model_auto_compact_token_limit` | none | Partial |
| Claude Code | `~/.claude/settings.json` | `autoCompactWindow` | none | Partial |
| Gemini CLI | `~/.gemini/settings.json` | `model.compressionThreshold` (ratio) | none | Partial |
| Qwen Code | `~/.qwen/settings.json` | `context.autoCompactThreshold` (ratio) | none | Partial |

“Full” means the installer can set both the trigger and the retained raw-context
budget. “Partial” means the installer can set the trigger only; `verify` reports
retention as `N/A` and the README explains why.

## 6. Architecture

```text
agent-compaction-preset/
├─ bin/
│  └─ agent-compact.mjs          # CLI entry point
├─ lib/
│  ├─ registry.mjs               # adapter registration, detection, capability matrix
│  ├─ policy.mjs                 # trigger/retention calculation and validation
│  ├─ paths.mjs                  # cross-platform paths and environment overrides
│  ├─ backup.mjs                 # timestamped backups, atomic writes, restore
│  ├─ report.mjs                 # human and JSON output, redaction
│  ├─ agents/
│  │  ├─ opencode.mjs
│  │  ├─ dsh.mjs
│  │  ├─ codex.mjs
│  │  ├─ claude.mjs
│  │  ├─ gemini.mjs
│  │  └─ qwen.mjs
│  └─ merge/
│     ├─ json.mjs                # JSON/JSONC-aware targeted merge
│     ├─ toml.mjs                # top-level TOML key merge
│     └─ yaml.mjs                # targeted DSH compaction-basic block merge
├─ presets/
│  └─ default.json               # preset metadata and default policy
├─ test/
│  ├─ fixtures/
│  ├─ policy.test.mjs
│  ├─ merge-json.test.mjs
│  ├─ merge-toml.test.mjs
│  ├─ merge-yaml.test.mjs
│  ├─ agents.test.mjs
│  └─ cli.test.mjs
├─ .github/workflows/ci.yml
├─ README.md
├─ README.zh-CN.md
├─ LICENSE
└─ package.json
```

### 6.1 Adapter contract

Each adapter exports:

```js
export default {
  id: "opencode",
  name: "OpenCode",
  support: "full" | "partial",
  detect(ctx),          // returns { detected, configPath, version?, notes[] }
  plan(ctx, policy),    // returns { changes[], effective, warnings[], template? }
  apply(ctx, plan),     // writes one file atomically; returns { backupPath }
  verify(ctx, policy),  // reads back and returns { effective, warnings[] }
  print(ctx, policy),   // returns a manual template string
};
```

Adapters do not implement backup, diff rendering, confirmation, or rollback.
Those are shared concerns in `backup.mjs`, `report.mjs`, and the CLI.

### 6.2 Data flow

```text
detect
  → resolve policy (200K/190K/50K, overridden by --context/--trigger/--keep)
  → plan each selected agent
  → validate all plans
  → render diff / JSON (redacted)
  → apply: backup all → write all → verify all
  → on failure: restore every file written in this run
```

`plan` never modifies files. `apply` is the only command that writes.

## 7. Policy

### 7.1 Defaults

```json
{
  "context": 200000,
  "trigger": 190000,
  "keep": 50000
}
```

Validation:

- `context > 0`
- `0 < trigger < context`
- `0 < keep < trigger`
- For ratio-based adapters, `trigger / context` must be greater than 0 and less
  than or equal to 1.

### 7.2 Native value derivation

| Adapter | Native value |
|---|---|
| OpenCode | `buffer = context - trigger`; `keep.tokens = keep` |
| DSH | `thresholdRatio = trigger / context`; `headroomTokens = 0`; `maxTokens = 8192`; `retainTokens = keep` |
| Codex | `model_context_window = context`; `model_auto_compact_token_limit = trigger` |
| Claude Code | `autoCompactWindow = trigger`; `autoCompactEnabled = true` |
| Gemini CLI | `model.compressionThreshold = trigger / context` |
| Qwen Code | `context.autoCompactThreshold = trigger / context` |

For DSH, the effective trigger is:

```text
floor(min(context × thresholdRatio, context − maxTokens − headroomTokens))
```

With the default policy this is:

```text
floor(min(200000 × 0.95, 200000 − 8192 − 0))
= floor(min(190000, 191808))
= 190000
```

`maxTokens` is set to 8192 because DSH requires a positive summarization output
cap when `headroomTokens` is zero. Setting it to the model's full output limit
would move the effective trigger earlier.

### 7.3 Reported effective values

`plan` and `verify` report the *effective* trigger, not just the requested one.
If an adapter cannot reach the requested trigger exactly, the output shows the
actual value and a warning. The installer must not silently clamp.

## 8. Agent Adapters

### 8.1 OpenCode

- Path resolution:
  - `XDG_CONFIG_HOME/opencode/opencode.json` when `XDG_CONFIG_HOME` is set.
  - Otherwise `~/.config/opencode/opencode.json`.
- Detect `.jsonc` sibling. If only `.jsonc` exists, do not rewrite it; return a
  manual template because JSONC comments and secrets would be lost.
- If both `.json` and `.jsonc` exist, write `.json` and warn that `.jsonc` may
  override the value. (On the current machine, `.json` is effective and
  `/api/config` reflects it.)
- Merge target:

```json
{
  "compaction": {
    "auto": true,
    "keep": { "tokens": 50000 },
    "buffer": 10000
  }
}
```

- Preserve other top-level keys and other compaction keys.
- Effective trigger: `context - buffer`.
- Retention: `keep.tokens`.

### 8.2 DSH

- Profile root: `DSH_HOME` or `~/.dsh`.
- Find `profiles/*/cordis.patch.yml`.
- If exactly one profile exists, use it.
- If multiple profiles exist, require `--profile <name>`.
- Target block:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: true
    thresholdRatio: 0.95
    headroomTokens: 0
    maxTokens: 8192
    retainTokens: 50000
```

- If an entry with `id: compaction-basic` or
  `name: '@deepseek-ai/dsh-compaction-basic'` exists, update its `config` keys.
- Preserve every existing key in that `config` block; only update or add the
  five target keys. Do not replace the whole config map. DSH patch semantics
  replace a matching plugin entry's config wholesale, so dropping existing keys
  would silently remove user customizations.
- If it does not exist, append the block.
- If more than one matching entry exists, abort with an ambiguity error.
- After computing the native values, require `keep < actualTrigger`; if not,
  abort with a clear message instead of writing a configuration that DSH will
  reject at load time.
- If the entry uses flow-style YAML (`{...}`) or an unexpected structure, abort
  and return a manual template.
- Preserve comments and unrelated patch entries.
- Effective trigger as defined in section 7.2.
- Retention: `retainTokens`.

### 8.3 Codex CLI

- Root: `CODEX_HOME` or `~/.codex`.
- File: `config.toml`.
- Write only these top-level keys:

```toml
model_context_window = 200000
model_auto_compact_token_limit = 190000
```

- Do not touch the same keys inside `[profiles.*]`, `[model_providers.*]`, or
  any other table.
- If the same keys exist inside a `[profiles.*]` table, warn that the active
  profile may override the top-level values. Do not modify the profile table.
- Preserve comments, blank lines, sections, and all unrelated values, including
  `experimental_bearer_token`.
- If a top-level key exists, replace only its value and preserve an inline
  trailing comment.
- If the file structure is ambiguous (for example, a multiline string spans the
  top-level area), abort instead of guessing.
- Retention: not supported. `verify` reports `N/A`.

### 8.4 Claude Code

- File: `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR/settings.json` when
  that environment variable is set).
- Write:

```json
{
  "autoCompactEnabled": true,
  "autoCompactWindow": 190000
}
```

- `autoCompactWindow` requires Claude Code v2.1.288 or newer.
- Detect the version by running `claude --version` with a short timeout. If the
  version is older, omit `autoCompactWindow`, set only `autoCompactEnabled`, and
  warn that the threshold cannot be applied.
- If the version cannot be determined, write both keys and warn.
- Claude Code requires a minimum window of 100,000 tokens. If the computed
  trigger is below 100,000, refuse to write the window and report the reason.
- Retention: not supported. `verify` reports `N/A`.

### 8.5 Gemini CLI

- File: `~/.gemini/settings.json`.
- Prefer `model.compressionThreshold`.
- If the file has the legacy key
  `model.chatCompression.contextPercentageThreshold` and does not have
  `model.compressionThreshold`, update the legacy key and warn that it should be
  migrated.
- If both keys exist, update `model.compressionThreshold` and warn that the
  legacy key is still present.
- Value: `trigger / context` (0.95 by default).
- Retention: not supported. `verify` reports `N/A`.

### 8.6 Qwen Code

- File: `~/.qwen/settings.json`.
- Write `context.autoCompactThreshold = trigger / context`.
- If the retired `model.chatCompression.contextPercentageThreshold` key is
  present, warn that Qwen ignores it and that the new key is being written.
- Qwen uses an internal three-tier warn/auto/hard ladder. The configured value is
  a target, not a guarantee; `verify` reports the target and the warning.
- Retention: not supported. `verify` reports `N/A`.

## 9. CLI

### 9.1 Commands

```text
agent-compact detect [--json]
agent-compact plan   [options] [--json]
agent-compact apply  [options] [--yes] [--create]
agent-compact verify [options] [--json]
agent-compact restore [--agents <ids>] [--latest | --file <path>] [--yes]
agent-compact print  [--agent <id>] [--json]
agent-compact --version
agent-compact --help
```

### 9.2 Options

| Option | Meaning |
|---|---|
| `--agents <ids>` | Comma-separated agent IDs, or `all`. Default: all detected. |
| `--context <n>` | Model context window. Default: 200000. |
| `--trigger <n>` | Trigger tokens. Default: 190000. |
| `--keep <n>` | Retained raw-context tokens. Default: 50000. |
| `--profile <name>` | DSH profile. Required when multiple profiles exist. |
| `--yes` | Skip interactive confirmation for `apply` and `restore`. |
| `--create` | Create a missing config file from a minimal template. |
| `--strict` | Exit non-zero if any selected agent is partial. |
| `--json` | Machine-readable output. |
| `--home <path>` | Override the user home directory for testing or portable use. |
| `--no-color` | Disable ANSI colors. |

`AGENT_COMPACT_HOME` is also supported as a home override for tests. `--home`
takes precedence.

### 9.3 Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including “already configured” |
| 1 | Error: invalid input, parse failure, write failure, rollback failure |
| 2 | No actionable agents, or `--strict` found a partial-support agent |

### 9.4 Output

Human output includes:

- detected agents and config paths
- support level (`full` or `partial`)
- requested policy and effective per-agent values
- redacted diff of targeted keys
- warnings for partial support, version mismatch, JSONC fallback, and DSH
  profile selection
- backup paths after `apply`

JSON output shape:

```json
{
  "version": "0.1.0",
  "policy": { "context": 200000, "trigger": 190000, "keep": 50000 },
  "agents": [
    {
      "id": "opencode",
      "name": "OpenCode",
      "detected": true,
      "configPath": "C:\\Users\\...\\opencode.json",
      "support": "full",
      "status": "planned",
      "changes": [
        { "key": "compaction.buffer", "from": null, "to": 10000 }
      ],
      "effective": { "trigger": 190000, "keep": 50000 },
      "warnings": []
    }
  ]
}
```

The JSON output must never include API keys, bearer tokens, or unrelated config
values.

## 10. Merge and File Safety

### 10.1 JSON and JSONC

- Read UTF-8.
- Detect comments with a scanner that ignores string literals.
- If comments are present:
  - `.jsonc`: do not rewrite; return a manual template.
  - `.json` with comments: treat as invalid and abort.
- Parse with `JSON.parse`. On failure, abort with the path and parser position.
- Merge only the target object. Do not delete keys.
- Write `JSON.stringify(value, null, 2) + "\n"`.
- Plain JSON may be reformatted, but no keys are lost. A backup is always made.

### 10.2 TOML

- Use a line-based editor rather than a full TOML serializer, to preserve
  comments and ordering.
- Only consider lines before the first table header (`[` or `[[`).
- Match `key = value` for the two Codex keys.
- Replace only the value; preserve leading whitespace and a trailing `#`
  comment.
- If a key is missing, insert it in the top-level block before the first table.
- Do not modify same-named keys inside tables.
- If the top-level structure is ambiguous, abort.

### 10.3 YAML

- Use a targeted block editor for `cordis.patch.yml`, not a full YAML parser.
- Locate the `compaction-basic` entry by `id` or `name`.
- Determine the block by indentation; the next entry starts at the same or lower
  indentation.
- Update or add the `config` keys.
- Preserve comments and other entries.
- Abort on flow-style mappings, duplicate matching entries, or unexpected
  indentation.

### 10.4 Atomic writes and backups

- Backup path: `<file>.bak-agent-compact-<YYYYMMDD-HHmmss>`.
- If the timestamp collides, append `-1`, `-2`, etc.
- If the target is a symlink, resolve it before writing and update the resolved
  file; never replace the symlink itself. If resolution is ambiguous, abort.
- Backup before any write. If backup fails, abort.
- Write to a temporary file in the same directory, validate, then replace the
  original with the temporary file.
- Preserve file mode on POSIX. On Windows, retry a failed replacement once; if
  it still fails, abort and leave the original file untouched.
- Do not fall back to an in-place rewrite: it would break the atomic-write
  guarantee. The backup remains available for manual recovery.
- Remove temporary files on failure.

### 10.5 Apply transaction

1. Build and validate plans for every selected agent.
2. If any plan is invalid, abort before writing anything.
3. Create backups for every file that will change.
4. Write each file.
5. Verify each file by reading it back.
6. If any write or verification fails, restore every file already written in
   this run from its backup, then exit with an error.
7. If nothing changed, do not create backups and report “already configured”.

### 10.6 Restore

- `restore --latest` finds the newest `*.bak-agent-compact-*` for each selected
  agent.
- `restore --file <path>` restores one explicit backup.
- Before restoring, create a safety backup of the current file.
- Restore exact bytes, then verify parseability.
- Report the restored path and the safety backup path.

## 11. Error Handling

- Missing config: report as not configured; offer `print` or `--create`.
- Invalid JSON/TOML/YAML: abort that agent and, during `apply`, abort the whole
  transaction.
- Permission denied: report the path and the OS error; do not retry blindly.
- DSH multiple profiles without `--profile`: abort with the profile list.
- DSH duplicate `compaction-basic` entries: abort with both line numbers.
- Claude version too old: write only the boolean, warn, and mark the agent
  `partial`.
- OpenCode `.jsonc` only: no write; return a template.
- Unsupported agent requested explicitly: report `unsupported` and exit 2 under
  `--strict`.

## 12. Testing

### 12.1 Unit tests

- `policy`:
  - default 200K → 190K/50K
  - custom context
  - invalid `keep >= trigger`
  - invalid `trigger >= context`
  - ratio rounding
  - DSH effective-trigger formula
- `merge/json`:
  - preserve unrelated keys and nested objects
  - idempotence
  - invalid JSON abort
  - JSONC comment detection
- `merge/toml`:
  - preserve comments, blank lines, sections, bearer token
  - update existing top-level keys
  - insert missing keys before the first table
  - do not touch same-named keys inside tables
  - idempotence
- `merge/yaml`:
  - append a new `compaction-basic` block
  - update an existing block
  - preserve comments and other entries
  - duplicate-block abort
  - flow-style abort
  - idempotence

### 12.2 Adapter and CLI integration tests

- Use `fs.mkdtempSync(os.tmpdir())` and `--home` or `AGENT_COMPACT_HOME`.
- Fixtures contain fake secrets such as `sk-test-not-real`.
- For each agent: detect, plan, apply, verify.
- `plan` does not change file hashes.
- `apply --yes` creates a backup, writes, and is idempotent.
- Injected write failure triggers full rollback.
- `restore --latest` restores exact bytes.
- `--json` output does not contain fake secrets.
- Edge cases:
  - OpenCode `.jsonc` only
  - OpenCode both `.json` and `.jsonc`
  - DSH one profile and multiple profiles
  - DSH existing block and no block
  - Codex top-level keys and same-named keys inside a table
  - Claude old version
  - Gemini legacy key
  - Qwen retired key
- CLI tests spawn `node bin/agent-compact.mjs` with a temp home; they do not
  touch the real user configuration.

### 12.3 CI

GitHub Actions matrix:

- `ubuntu-latest`, `windows-latest`, `macos-latest`
- Node 20, 22, 24

Commands:

```bash
node --test
node bin/agent-compact.mjs --help
```

### 12.4 Manual verification

- Copy representative real configs into a temp directory, with secrets replaced.
- Run `detect`, `plan`, `apply --yes`, `verify`, `restore --latest`.
- Confirm exact restoration with file hashes.
- Do not modify the real user configs during automated tests.

## 13. Release

### 13.1 Repository contents

- `README.md` (English) and `README.zh-CN.md` (Chinese)
- `LICENSE` (MIT)
- `package.json`
- `bin/`, `lib/`, `presets/`
- `test/`
- `.github/workflows/ci.yml`
- `.gitignore`

No API keys, bearer tokens, real user configs, absolute machine paths, or
generated test artifacts.

### 13.2 README sections

1. What this is and what it is not
2. Capability matrix
3. Quick start
4. Commands and options
5. Exact values written for each agent
6. Full vs partial support
7. Backup, verify, and restore
8. Manual templates for JSONC or unsupported formats
9. Limitations
10. Development and testing
11. License

### 13.3 package.json

```json
{
  "name": "agent-compaction-preset",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agent-compact": "./bin/agent-compact.mjs" },
  "files": ["bin", "lib", "presets", "README.md", "README.zh-CN.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test" },
  "license": "MIT"
}
```

### 13.4 Publication

- Create a public GitHub repository named `agent-compaction-preset`.
- Push `main`.
- Add topics: `context-compaction`, `ai-agents`, `opencode`, `deepseek-harness`,
  `codex`, `claude-code`, `gemini-cli`, `qwen-code`.
- Do not publish to npm without a separate explicit decision.
- Publishing requires a working `gh auth login`; this is an operational
  prerequisite, not a code feature.

## 14. Limitations

1. Codex CLI, Claude Code, Gemini CLI, and Qwen Code have no user-configurable
   “retain 50K” setting. They are marked partial.
2. OpenCode and DSH use relative or ratio-based settings. The default 190K
   trigger is exact on a 200K window; other windows require `--context` and
   produce different native values.
3. A single OpenCode global config cannot simultaneously target different
   absolute triggers for different model windows.
4. DSH’s effective trigger is reduced by its summarization output cap. With the
   default `maxTokens = 8192`, the 200K target is exact; with a larger cap, it
   would fire earlier.
5. Claude Code’s `autoCompactWindow` minimum is 100K. Triggers below that are
   refused.
6. Claude Code versions older than 2.1.288 cannot set the window; only the
   enable/disable flag is written.
7. Gemini CLI and Qwen Code may apply internal caps or ladders; their reported
   trigger is a target, not a hard guarantee.
8. JSONC files with comments are never rewritten; users must apply the printed
   template manually.
9. Cursor, Cline/Roo, Aider, Continue, Copilot CLI, and IDE extensions are out of
   scope for v0.1.0.

## 15. Acceptance Criteria

- `node --test` passes on Windows, Linux, and macOS with Node 20/22/24.
- All six adapters can detect, plan, apply, and verify against fixtures.
- OpenCode and DSH report effective trigger 190,000 and retention 50,000 on the
  default policy.
- Codex, Claude Code, Gemini CLI, and Qwen Code report effective trigger
  190,000 and retention `N/A`.
- `plan` never changes a file.
- `apply` is idempotent and rolls back on failure.
- `restore --latest` restores exact original bytes.
- `--json` output contains no secrets.
- README capability claims match the adapter behavior.
- The repository contains no API keys or machine-specific absolute paths.

## 16. Implementation Plan Handoff

Expected implementation order:

1. Repository skeleton, `package.json`, policy module, tests.
2. Registry, paths, report, backup/atomic write.
3. JSON merge + OpenCode, Claude Code, Gemini CLI, Qwen Code adapters.
4. TOML merge + Codex adapter.
5. YAML merge + DSH adapter.
6. CLI commands, confirmation, JSON output, strict mode.
7. Integration tests, rollback tests, restore tests.
8. README (EN/ZH), CI, license, privacy scan.
9. Local smoke test with temp copies.
10. GitHub publication after `gh auth login`.

Primary risks:

- Format-preserving TOML/YAML editing has edge cases; aborting with a template is
  the correct fallback.
- DSH profile selection and duplicate entries can be ambiguous; require
  `--profile` and abort on duplicates.
- Windows atomic replacement differs from POSIX; tests must cover both.
- Partial-support messaging must not imply retention is configured when it is
  not.

No implementation begins until this spec is reviewed and approved, and the
implementation plan is written and approved.
