# agent-compaction-preset

`agent-compaction-preset` 用一套共享策略，为多个命令行编程代理写入原生的上下文压缩设置。它不代理模型请求，不安装运行时插件，也不管理服务商账户或 API 密钥。它只修改目标压缩键，不会打印无关的配置值。它是一个零运行时依赖的 Node.js CLI（要求 Node.js 20 或更高版本），只修改这些代理已经在使用的配置文件。

默认策略面向 200,000 token 的模型窗口，自动压缩触发阈值为 190,000 token，压缩后保留 50,000 token 的原始上下文。OpenCode 和 DSH 可以应用触发阈值和保留量；上下文窗口是用于推导原生设置的输入，不会写入这些文件。Codex CLI、Claude Code、Gemini CLI 和 Qwen Code 没有用户可配置的保留量设置，因此按部分支持处理：工具会设置它们的触发阈值，并把保留量报告为 `N/A`，而不会假装存在 50K 保留量。

## 1. 能力矩阵

| 代理 | 支持级别 | 触发设置 | 保留设置 | 配置文件 |
|---|---|---|---|---|
| OpenCode | `full` | `compaction.auto: true`、`compaction.buffer: 10000`（在 200K 窗口上有效触发为 190K） | `compaction.keep.tokens: 50000` | `~/.config/opencode/opencode.json` |
| DSH | `full` | `thresholdRatio: 0.95`、`headroomTokens: 0`、`maxTokens: 8192`（在 200K 窗口上有效触发为 190K） | `retainTokens: 50000` | `~/.dsh/profiles/<profile>/cordis.patch.yml` |
| Codex CLI | `partial` | `model_context_window = 200000`、`model_auto_compact_token_limit = 190000` | `N/A` | `~/.codex/config.toml` |
| Claude Code | `partial` | `autoCompactEnabled: true`、`autoCompactWindow: 190000`（v2.1.288+） | `N/A` | `~/.claude/settings.json` |
| Gemini CLI | `partial` | `model.compressionThreshold: 0.95` | `N/A` | `~/.gemini/settings.json` |
| Qwen Code | `partial` | `context.autoCompactThreshold: 0.95` | `N/A` | `~/.qwen/settings.json` |

`full` 表示安装器既能设置触发阈值，也能设置原生的保留上下文预算。`partial` 表示只能设置触发阈值。只有 OpenCode 和 DSH 能保留 50K；其余四个报告 `N/A`，本项目不声称它们能够保留 50K。

路径和环境变量覆盖：

- 当设置了 `XDG_CONFIG_HOME` 时，OpenCode 使用 `$XDG_CONFIG_HOME/opencode/opencode.json`，否则使用表中的路径。同目录下的 `opencode.jsonc` 也会被检测；见第 7 节和第 8 节。
- 当设置了 `DSH_HOME` 时，DSH 使用 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，否则使用 `~/.dsh`。
- 当设置了 `CODEX_HOME` 时，Codex 使用 `$CODEX_HOME/config.toml`。
- 当设置了 `CLAUDE_CONFIG_DIR` 时，Claude Code 使用 `$CLAUDE_CONFIG_DIR/settings.json`。
- `--home <path>` 设置基础主目录；环境变量 `AGENT_COMPACT_HOME` 提供相同作用，且 `--home` 的优先级更高。上面的各代理环境变量仍会覆盖各自的根目录。这主要用于测试和便携使用。

## 2. 快速开始

在本仓库的检出目录中运行：

```bash
node bin/agent-compact.mjs detect
node bin/agent-compact.mjs plan
node bin/agent-compact.mjs apply --yes
node bin/agent-compact.mjs verify
node bin/agent-compact.mjs restore --latest --yes
```

`detect`、`plan` 和 `verify` 是只读的。`apply` 和 `restore` 会写入文件。`plan`、`apply` 和 `verify` 默认选择已检测到的配置；传入 `--agents all` 或逗号分隔的列表（例如 `--agents opencode,codex`）可以显式选择。`apply` 在交互式终端中会请求确认，在非交互会话中若没有 `--yes` 会拒绝执行。当选中的代理还没有配置文件时，使用 `--create`。

## 3. 命令和选项

| 命令 | 作用 | 是否写文件 |
|---|---|---|
| `detect` | 显示全部六个代理、是否检测到、支持级别、配置路径、版本和备注。 | 否 |
| `plan` | 显示所选代理的变更、有效触发阈值、保留量和警告。 | 否 |
| `apply` | 校验计划、备份现有文件、写入、验证，并在失败时回滚整个运行。 | 是 |
| `verify` | 重新读取配置，报告有效触发阈值、保留量和警告。 | 否 |
| `restore` | 恢复一个备份，或为每个所选代理恢复最新备份；替换现有文件时会先创建安全备份。 | 是 |
| `print` | 打印配置模板。默认输出全部六个代理；`--agent` 选择一个。 | 否 |

| 选项 | 含义 |
|---|---|
| `--agents <ids>` | 逗号分隔的代理 id，或 `all`。默认：已检测到的代理（`print` 默认全部六个）。 |
| `--agent <id>` | 打印一个代理的模板。仅由 `print` 支持。 |
| `--context <n>` | 模型上下文窗口大小（token）。默认：`200000`。 |
| `--trigger <n>` | 压缩触发阈值（token）。默认：`--context` 的 95%，向下取整（`200000` 时为 `190000`）。 |
| `--keep <n>` | 保留的原始上下文 token 数。默认：`50000`。 |
| `--profile <name>` | DSH profile 名称。存在多个 profile 时必填。 |
| `--create` | 允许 `apply` 创建缺失的配置文件。 |
| `--strict` | 当所选代理包含部分支持时，以退出码 2 结束。 |
| `--yes` | 跳过 `apply` 和 `restore` 的交互确认。 |
| `--latest` | 为每个所选代理恢复最新备份（默认行为）。 |
| `--file <path>` | 恢复指定的一个 `.bak-agent-compact-*` 备份。 |
| `--json` | 输出机器可读的 JSON，而不是人类可读报告。 |
| `--home <path>` | 覆盖主目录。 |
| `--no-color` | 禁用 ANSI 颜色。 |
| `--version` | 打印版本。 |
| `--help` | 打印帮助。 |

`--trigger` 是绝对 token 数。省略时，默认取 `--context` 的 95% 并向下取整：200,000 窗口为 190,000，100,000 窗口为 95,000。每个代理的原生值会按该窗口重新计算。需要不同的绝对触发阈值时，请显式传入 `--trigger`；例如 `--context 300000 --trigger 280000` 会使用 280,000，而不是 95% 对应的 285,000。`--keep` 除非显式覆盖，否则保持 50,000，并且必须小于触发阈值。对 DSH 而言，它必须小于 DSH 的有效触发阈值；由于 `maxTokens`/`headroomTokens`，该值可能更低。例如 `--context 100000` 得到 95,000 的触发阈值，但 DSH 有效触发阈值为 91,808，因此 `--keep 94000` 会被拒绝。

退出码：`0` 表示成功或已经配置；`1` 表示错误；`2` 表示没有可操作的代理，或 `--strict` 遇到部分支持。

## 4. 写入的确切值

OpenCode（`~/.config/opencode/opencode.json`）：

```json
{
  "compaction": {
    "auto": true,
    "keep": { "tokens": 50000 },
    "buffer": 10000
  }
}
```

`compaction.buffer` 等于 `context - trigger`（默认 10,000）。有效触发阈值为 `context - buffer`，所以 200,000 - 10,000 = 190,000。其他顶层键和 `compaction` 下的其他键会被保留。

DSH（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

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

DSH 的有效触发阈值为
`floor(min(context × thresholdRatio, context - maxTokens - headroomTokens))`。
使用默认值时即
`floor(min(200000 × 0.95, 200000 - 8192 - 0)) = 190000`。现有 `config` 块中的其他键以及无关的 patch 条目会被保留。

Codex CLI（`~/.codex/config.toml`）：

```toml
model_context_window = 200000
model_auto_compact_token_limit = 190000
```

只写入这两个顶层键。`[profiles.*]`、`[model_providers.*]` 或其他表中的同名键不会被修改。如果存在这些键，计划会警告：活动的 profile 可能覆盖顶层值。

Claude Code（`~/.claude/settings.json`）：

```json
{
  "autoCompactEnabled": true,
  "autoCompactWindow": 190000
}
```

`autoCompactWindow` 需要 Claude Code v2.1.288 或更高版本。对于已知较旧的版本，只写入 `autoCompactEnabled: true`，并警告无法应用阈值。如果无法确定版本，则写入两个键并给出警告。

Gemini CLI（`~/.gemini/settings.json`）：

```json
{
  "model": {
    "compressionThreshold": 0.95
  }
}
```

如果文件中只有旧键 `model.chatCompression.contextPercentageThreshold`，则改为更新该旧键，并警告需要迁移。如果两个键都存在，则更新 `model.compressionThreshold`，并警告旧键仍然存在。

Qwen Code（`~/.qwen/settings.json`）：

```json
{
  "context": {
    "autoCompactThreshold": 0.95
  }
}
```

如果存在已弃用的 `model.chatCompression.contextPercentageThreshold` 键，计划会警告 Qwen 会忽略它。配置值是 Qwen 内部 warn/auto/hard 阶梯中的一个目标值，而不是保证。

## 5. 完整支持与部分支持

- **完整支持（OpenCode、DSH）：** 同时配置触发阈值和原生保留预算。在默认策略下，`verify` 报告有效触发阈值为 190,000，保留量为 50,000。
- **部分支持（Codex CLI、Claude Code、Gemini CLI、Qwen Code）：** 只配置触发阈值，没有用户可配置的保留量设置。人类可读报告显示 `keep N/A`；JSON 输出中的 `keep` 为 `null`。不会为这些代理写入或声称 50K 保留量。

当部分支持应当使自动化运行失败时，使用 `--strict`。只要所选代理中包含部分支持，`plan`、`apply` 和 `verify` 就会返回退出码 2；更早的预检错误仍返回退出码 1。

## 6. 备份、验证和恢复

在写入现有文件之前，`apply` 会把它复制为：

```text
<file>.bak-agent-compact-YYYYMMDD-HHmmss
```

如果该名称已存在，会追加数字后缀：
`<file>.bak-agent-compact-YYYYMMDD-HHmmss-1`、`-2`，依此类推。新建文件没有源备份；报告显示 `backup: none`。

`apply` 对所选运行是全员成功或全员回滚。它会先校验每个计划，再备份并写入每个变更文件，然后重新读取验证。任何写入或验证失败时，它会从备份恢复本次运行中已经写入的每个现有文件，并删除本次创建的文件（新建文件没有源备份），然后以错误退出。如果没有任何变更，则不会写入文件，也不会创建备份。

`verify` 是只读的。它报告有效触发阈值、保留量、所有警告，以及目标键是否与策略一致。

`restore --latest` 为每个所选代理（默认是已检测到的代理）查找最新备份。`restore --file <path>` 恢复指定的一个 `.bak-agent-compact-*` 备份。恢复现有目标前，它会为当前文件创建安全备份：

```text
<file>.bak-agent-compact-before-restore-YYYYMMDD-HHmmss
```

并使用相同的数字后缀冲突处理。如果目标不存在，它会从备份重新创建目标，且不会创建安全备份。恢复会写入所选备份的确切字节。恢复按备份、按文件依次进行，不是多文件原子事务。安全备份使每个现有文件的恢复都可以撤销；重新创建的不存在文件如有需要可以删除。

## 7. OpenCode JSONC 手动模板

带注释的 OpenCode 配置（`.jsonc`）永远不会被自动重写，因为重写会丢失注释，甚至可能丢失密钥。如果只存在 `opencode.jsonc`，计划会返回手动状态，工具拒绝应用。请使用以下模板自行编辑：

```jsonc
{
  // 启用自动压缩。
  "compaction": {
    "auto": true,
    // 压缩后保留 50,000 token 的近期原始上下文。
    "keep": { "tokens": 50000 },
    // 在 200,000 token 窗口之前 10,000 token 处开始压缩。
    "buffer": 10000
  }
}
```

如果 `opencode.json` 和 `opencode.jsonc` 同时存在，`apply` 会写入 `opencode.json`，并警告 JSONC 文件可能覆盖这些值。两种情况下，工具都不会修改 JSONC 文件。

当 DSH 的 YAML 使用流式集合或安全编辑器拒绝重写的其他结构时，DSH 也会返回手动计划。使用 `print --agent dsh` 获取规范的 `compaction-basic` 块，然后手动合并到 profile 的 `cordis.patch.yml`。

## 8. 限制

1. **在 200K 模型上使用 250K 触发阈值是不可能的。** 触发阈值必须小于上下文窗口。默认的 190,000 在 200,000 token 模型上留下 10,000 token 余量。
2. **比例设置是相对的。** Gemini CLI 和 Qwen Code 使用 `trigger / context`（默认 0.95）；DSH 使用 `thresholdRatio: 0.95`。OpenCode 的 `buffer` 是绝对差值。单一全局配置无法为不同模型窗口在基于比例的代理中同时指定不同的绝对触发阈值。需要时请按窗口传入 `--context` 和 `--trigger`。
3. **Claude Code 有最小窗口和版本限制。** `autoCompactWindow` 至少为 100,000 token；低于该值时，工具拒绝写入窗口并说明原因。低于 v2.1.288 的 Claude Code 只支持 `autoCompactEnabled` 布尔值，不支持 `autoCompactWindow`。
4. **DSH 有摘要输出上限。** 工具写入 `maxTokens: 8192` 和 `headroomTokens: 0`，因为当 headroom 为零时 DSH 要求正的输出上限。有效触发阈值会被该上限降低：`floor(min(context × ratio, context - maxTokens - headroomTokens))`。默认的 200K/0.95 情况正好是 190,000，因为 `200000 - 8192 = 191808`；更大的上限会使有效触发阈值提前。
5. **Gemini CLI 和 Qwen Code 可能应用内部阶梯或上限。** Gemini 的压缩阈值是目标值，Qwen Code 使用内部 warn/auto/hard 压缩阶梯。`verify` 报告配置的目标值，而不是运行时硬性保证。Gemini 的旧键会被处理并给出迁移警告，Qwen 的已弃用键会被 Qwen 本身忽略。
6. **部分文件只能手动处理。** OpenCode 的 `.jsonc` 注释永远不会被自动重写，DSH 的流式或歧义 YAML 结构也不会被自动编辑。请自行应用打印出的模板。
7. **Codex profile 覆盖不会被修改。** 工具写入顶层键；`[profiles.*]` 或其他表中的同名键可能优先。存在这些键时，计划会警告。
8. **DSH profile 选择可能产生歧义。** 存在多个 profile 时，请传入 `--profile <name>`。重复的 `compaction-basic` 条目会中止；流式 YAML 和歧义结构会回退到手动模板，而不是猜测。
9. **v0.1.0 不支持：** Cursor、Cline/Roo、Aider、Continue、Copilot CLI 和 IDE 扩展。其中一些没有全局压缩阈值，或者没有基于摘要的压缩设置。
10. **优先通过 GitHub 发布。** 此版本从 GitHub 仓库分发，不发布到 npm。

## 9. 开发和测试

需要 Node.js 20 或更高版本。没有运行时依赖。

```bash
node --test
node bin/agent-compact.mjs --help
```

测试套件会隔离主目录和各代理的根目录环境变量，永远不会写入真实的用户配置。持续集成在 Ubuntu、Windows 和 macOS 上使用 Node.js 20、22 和 24 运行 `node --test` 和帮助命令。

## 10. 许可证

MIT。见 [LICENSE](LICENSE)。
