# agent-compaction-preset

`agent-compaction-preset` writes native context-compaction settings for several
CLI coding agents from one shared policy. It does not proxy model requests,
install a runtime plugin, or manage provider accounts or API keys. It edits only
the targeted compaction keys and never prints unrelated configuration values.
It is a zero-runtime-dependency Node.js CLI (Node.js 20 or newer) that edits the
configuration files the agents already use.

The default policy targets a 200,000-token model window with a 190,000-token
automatic compaction trigger and 50,000 tokens of retained raw context after
compaction. OpenCode and DSH can apply both the trigger and retention; for them,
the context window is an input used to derive native settings. Codex CLI also
writes the window as `model_context_window`. Claude Code, Gemini CLI, and Qwen
Code expose no user-configurable retention setting, so they are supported as
partial: the tool sets their trigger and reports retention as `N/A` instead of
pretending a 50K retention value exists.

## 1. Capability matrix

| Agent | Support | Trigger | Retention | Config file |
|---|---|---|---|---|
| OpenCode | `full` | `compaction.auto: true`, `compaction.buffer: 10000` (190K effective on a 200K window) | `compaction.keep.tokens: 50000` | `~/.config/opencode/opencode.json` |
| DSH | `full` | `auto: true`, `thresholdRatio: 0.95`, `headroomTokens: 0`, `maxTokens: 8192` (190K effective on a 200K window) | `retainTokens: 50000` | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| Codex CLI | `partial` | `model_context_window = 200000`, `model_auto_compact_token_limit = 190000` | `N/A` | `~/.codex/config.toml` |
| Claude Code | `partial` | `autoCompactEnabled: true`, `autoCompactWindow: 190000` (v2.1.288+) | `N/A` | `~/.claude/settings.json` |
| Gemini CLI | `partial` | `model.compressionThreshold: 0.95` | `N/A` | `~/.gemini/settings.json` |
| Qwen Code | `partial` | `context.autoCompactThreshold: 0.95` | `N/A` | `~/.qwen/settings.json` |

`full` means the installer can set both the trigger and a native retained-context
budget. `partial` means it can set the trigger only. Only OpenCode and DSH can
retain 50K; the other four report `N/A`, and this project makes no claim that
they can retain 50K.

Path and environment overrides:

- OpenCode uses `$XDG_CONFIG_HOME/opencode/opencode.json` when
  `XDG_CONFIG_HOME` is set, otherwise the path in the table. A sibling
  `opencode.jsonc` is also detected; see sections 7 and 8.
- DSH uses `$DSH_HOME/profiles/<profile>/cordis.patch.yml` when `DSH_HOME` is
  set, otherwise `~/.dsh`.
- Codex uses `$CODEX_HOME/config.toml` when `CODEX_HOME` is set.
- Claude Code uses `$CLAUDE_CONFIG_DIR/settings.json` when
  `CLAUDE_CONFIG_DIR` is set.
- `--home <path>` sets the base home directory; `AGENT_COMPACT_HOME` is the
  environment-variable equivalent and `--home` wins over it. The per-agent
  variables above still take precedence for their own roots. This is intended
  for testing and portable use.

## 2. Quick start

Run from a checkout of this repository:

```bash
node bin/agent-compact.mjs detect
node bin/agent-compact.mjs plan
node bin/agent-compact.mjs apply --yes
node bin/agent-compact.mjs verify
node bin/agent-compact.mjs restore --latest --yes
```

`detect`, `plan`, and `verify` are read-only. `apply` and `restore` write files.
`plan`, `apply`, and `verify` select detected configurations by default; pass
`--agents all` or a comma-separated list such as `--agents opencode,codex` to
choose explicitly. `apply` prompts for confirmation in an interactive terminal
and refuses to run without `--yes` in a non-interactive session. Use `--create`
when a selected agent has no configuration file yet.

## 3. Commands and options

| Command | What it does | Writes files? |
|---|---|---|
| `detect` | Shows all six agents, whether each was detected, its support level, config path, version, and notes. | No |
| `plan` | Shows the changes, effective trigger, retention, and warnings for the selected agents. | No |
| `apply` | Validates plans, backs up existing files, writes, verifies, and rolls back the whole run on failure. | Yes |
| `verify` | Reads the configuration back and reports the effective trigger, retention, and warnings. | No |
| `restore` | Restores one backup, or the latest backup for each selected agent; creates a safety backup when replacing an existing file. | Yes |
| `print` | Prints configuration templates. Defaults to all six agents; `--agent` selects one. | No |

| Option | Meaning |
|---|---|
| `--agents <ids>` | Comma-separated agent ids, or `all`. Default: detected agents (all six for `print`). |
| `--agent <id>` | Print one agent's template. Supported by `print` only. |
| `--context <n>` | Model context window in tokens. Default: `200000`. |
| `--trigger <n>` | Compaction trigger in tokens. Default: 95% of `--context`, rounded down (`190000` at `200000`). |
| `--keep <n>` | Retained raw-context tokens. Default: `50000`. |
| `--profile <name>` | DSH profile name. Required for DSH `plan`/`apply`/`verify` when no profile or more than one profile exists; `apply --create --agents dsh` needs it on a fresh home. |
| `--create` | Allow `apply` to create missing configuration files. |
| `--strict` | Exit with code 2 when a selected agent has partial support. |
| `--yes` | Skip the interactive confirmation for `apply` and `restore`. |
| `--latest` | Restore the latest backup for each selected agent (the default). |
| `--file <path>` | Restore one explicit `.bak-agent-compact-*` backup. |
| `--json` | Print machine-readable JSON instead of the human report. |
| `--home <path>` | Override the home directory. |
| `--no-color` | Disable ANSI colors. |
| `--version` | Print the version. |
| `--help` | Print help. |

`--trigger` is an absolute token count. When you omit it, the default is 95% of
`--context`, rounded down: 190,000 on a 200,000-token window and 95,000 on a
100,000-token window. Each agent's native values are then recomputed for that
window. Pass `--trigger` explicitly when you want a different absolute trigger;
for example, `--context 300000 --trigger 280000` uses 280,000 even though 95%
would be 285,000. `--keep` remains 50,000 unless overridden and must be less
than the trigger. For DSH it must be less than DSH's effective trigger, which
can be lower because of `maxTokens`/`headroomTokens`; for example,
`--context 100000` gives a 95,000 trigger but a 91,808 effective DSH trigger,
so `--keep 94000` is rejected.

Exit codes: `0` for success or an already-configured result, `1` for an error,
and `2` for no actionable agents or a `--strict` partial-support result.

## 4. Exact values written

OpenCode (`~/.config/opencode/opencode.json`):

```json
{
  "compaction": {
    "auto": true,
    "keep": { "tokens": 50000 },
    "buffer": 10000
  }
}
```

`compaction.buffer` is `context - trigger` (10,000 by default). The effective
trigger is `context - buffer`, so 200,000 - 10,000 = 190,000. Other top-level
keys and other `compaction` keys are preserved.

DSH (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

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

DSH uses the effective trigger
`floor(min(context × thresholdRatio, context - maxTokens - headroomTokens))`.
With the default values that is
`floor(min(200000 × 0.95, 200000 - 8192 - 0)) = 190000`. Other keys in the
existing `config` block and unrelated patch entries are preserved.

Codex CLI (`~/.codex/config.toml`):

```toml
model_context_window = 200000
model_auto_compact_token_limit = 190000
```

Only these top-level keys are written. Same-named keys inside
`[profiles.*]`, `[model_providers.*]`, or other tables are left untouched. If
they exist, the plan warns that the active profile may override the top-level
values.

Claude Code (`~/.claude/settings.json`):

```json
{
  "autoCompactEnabled": true,
  "autoCompactWindow": 190000
}
```

`autoCompactWindow` requires Claude Code v2.1.288 or newer. On a known older
version, only `autoCompactEnabled: true` is written and a warning explains that
the threshold cannot be applied. If the version cannot be determined, both keys
are written with a warning.

Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "model": {
    "compressionThreshold": 0.95
  }
}
```

If the file contains only the legacy key
`model.chatCompression.contextPercentageThreshold`, that key is updated instead
and a warning asks for migration. If both keys exist,
`model.compressionThreshold` is updated and a warning notes that the legacy key
is still present.

Qwen Code (`~/.qwen/settings.json`):

```json
{
  "context": {
    "autoCompactThreshold": 0.95
  }
}
```

If the retired `model.chatCompression.contextPercentageThreshold` key is
present, the plan warns that Qwen ignores it. The configured value is a target
inside Qwen's internal warn/auto/hard ladder, not a guarantee.

## 5. Full vs partial support

- **Full (OpenCode, DSH):** the trigger and a native retention budget are both
  configured. With the default policy, `verify` reports an effective trigger of
  190,000 and retention of 50,000.
- **Partial (Codex CLI, Claude Code, Gemini CLI, Qwen Code):** the trigger is
  configured, but there is no user-configurable retention setting. The human
  report prints `keep N/A`; JSON output uses `null` for `keep`. No 50K
  retention value is written or claimed for these agents.

Use `--strict` in automation when partial support should fail the run. For
`plan` and `apply`, it returns exit code 2 when any selected agent is partial.
For `verify`, a failed check returns exit code 1 before `--strict` is considered;
`--strict` returns 2 only when all checks pass but a selected agent is partial.
Earlier preflight errors still exit 1.

## 6. Backup, verify, and restore

Before writing an existing file, `apply` copies it to:

```text
<file>.bak-agent-compact-YYYYMMDD-HHmmss
```

If that name already exists, a numeric suffix is added:
`<file>.bak-agent-compact-YYYYMMDD-HHmmss-1`, `-2`, and so on. A file that is
created new has no source backup; the report shows `backup: none`.

`apply` is all-or-nothing for the selected run. It validates every plan before
writing, backs up and writes each changed file, then verifies each file by
reading it back. If any write or verification fails, it restores every existing
file written in that run from its backup and deletes any file it created (a
created file has no source backup). If nothing needs to change, no files are
written and no backups are created.

`verify` is read-only. It reports the effective trigger and retention, any
warnings, and whether the targeted keys match the policy.

`restore --latest` finds the newest backup for each selected agent (detected
agents by default).
`restore --file <path>` restores one explicit `.bak-agent-compact-*` backup.
Before restoring an existing target, it creates a safety backup of the current
file:

```text
<file>.bak-agent-compact-before-restore-YYYYMMDD-HHmmss
```

with the same numeric-suffix collision handling. If the target is missing, it
is recreated from the backup and no safety backup is created. Before writing
anything, every selected backup is checked for parseability as JSON, TOML, or
DSH YAML; a malformed backup aborts the restore and leaves every target
unchanged. Restoration then writes the exact bytes from the chosen backup.
Restore is performed per backup and per file, sequentially; it is not an atomic
multi-file transaction. A safety backup makes each existing-file restore
reversible; a recreated missing file can be removed if needed.

## 7. Manual template for OpenCode JSONC

An OpenCode configuration with comments (`.jsonc`) is never rewritten, because
rewriting it would lose comments and possibly secrets. If only
`opencode.jsonc` exists, plan returns a manual status and the tool refuses to
apply it. Edit the file yourself using this template:

```jsonc
{
  // Enable automatic compaction.
  "compaction": {
    "auto": true,
    // Retain 50,000 tokens of recent raw context after compaction.
    "keep": { "tokens": 50000 },
    // Start compaction 10,000 tokens before a 200,000-token window.
    "buffer": 10000
  }
}
```

If both `opencode.json` and `opencode.jsonc` exist, `apply` writes
`opencode.json` and warns that the JSONC file may override the values. The
tool does not modify the JSONC file in either case.

DSH also returns a manual plan when its YAML uses flow-style collections or
another structure the safe editor refuses to rewrite. Use
`print --agent dsh` for the canonical `compaction-basic` block and merge it
into the profile's `cordis.patch.yml` by hand.

## 8. Limitations

1. **A 250K trigger on a 200K model is impossible.** The trigger must be less
   than the context window. The default 190,000 leaves 10,000 tokens of
   headroom on a 200,000-token model.
2. **Ratio settings are relative.** Gemini CLI and Qwen Code use
   `trigger / context` (0.95 by default); DSH uses `thresholdRatio: 0.95`.
   OpenCode's `buffer` is an absolute difference. A single global configuration
   cannot target different absolute triggers for different model windows in
   ratio-based agents. Use `--context` and `--trigger` per run when needed.
3. **Claude Code has a minimum window and version limit.**
   `autoCompactWindow` must be at least 100,000 tokens; below that, `plan`,
   `apply`, and `print` refuse to write or render the window and explain why.
   Claude Code versions older than v2.1.288 support only the
   `autoCompactEnabled` boolean, not `autoCompactWindow`.
4. **DSH has a summarization output cap.** The tool writes
   `maxTokens: 8192` and `headroomTokens: 0` because DSH requires a positive
   output cap when headroom is zero. The effective trigger is reduced by that
   cap: `floor(min(context × ratio, context - maxTokens - headroomTokens))`.
   The default 200K/0.95 case is exactly 190,000 because
   `200000 - 8192 = 191808`; a larger cap would move the effective trigger
   earlier.
5. **Gemini CLI and Qwen Code may apply internal ladders or caps.** Gemini's
   configured compression threshold is a target, and Qwen Code uses an internal
   warn/auto/hard compaction ladder. `verify` reports the configured target,
   not a hard runtime guarantee. Gemini's legacy key is handled with a
   migration warning, and Qwen's retired key is ignored by Qwen itself.
6. **Some files are manual-only.** OpenCode `.jsonc` comments are never
   rewritten, and DSH YAML with flow-style or ambiguous structures is not edited
   automatically. Apply the printed template yourself.
7. **Codex profile overrides are not modified.** Top-level keys are written;
   same-named keys in `[profiles.*]` or other tables may take precedence. Both
   `plan` and `verify` warn when they are present.
8. **DSH profile selection can be ambiguous.** If no profile or more than one
   profile exists, pass `--profile <name>` to `plan`, `apply`, or `verify`.
   `apply --create --agents dsh` also needs an explicit profile on a fresh home.
   Duplicate `compaction-basic` entries abort; flow-style YAML and ambiguous
   structures fall back to a manual template rather than guessing.
9. **Out of scope for v0.1.0:** Cursor, Cline/Roo, Aider, Continue, Copilot CLI,
   and IDE extensions. Several have no global compaction threshold or no
   summarization-based compaction setting.
10. **GitHub-first release.** This version is distributed from its GitHub
    repository; it is not published to npm.

## 9. Development and testing

Requires Node.js 20 or newer. There are no runtime dependencies.

```bash
node --test
node bin/agent-compact.mjs --help
```

The test suite isolates the home directory and per-agent root environment
variables, and never writes to real user configurations. Continuous integration
runs `node --test` and the help command on Ubuntu, Windows, and macOS with
Node.js 20, 22, and 24.

## 10. License

MIT. See [LICENSE](LICENSE).
