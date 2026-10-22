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

test('README has the required sections and exact capability rows', () => {
  for (const heading of [
    '## 1. Capability matrix',
    '## 2. Quick start',
    '## 3. Commands and options',
    '## 4. Exact values written',
    '## 5. Full vs partial support',
    '## 6. Backup, verify, and restore',
    '## 7. Manual template for OpenCode JSONC',
    '## 8. Limitations',
    '## 9. Development and testing',
    '## 10. License',
  ]) {
    assert.ok(readme.includes(heading), `missing ${heading}`);
  }

  for (const row of [
    '| OpenCode | `full` |',
    '| DSH | `full` |',
    '| Codex CLI | `partial` |',
    '| Claude Code | `partial` |',
    '| Gemini CLI | `partial` |',
    '| Qwen Code | `partial` |',
  ]) {
    assert.ok(readme.includes(row), `missing capability row ${row}`);
  }

  assert.match(readme, /sections 7 and 8/);
  assert.doesNotMatch(readme, /sections 8 and 9/);
  assert.match(readme, /95% of/);
  assert.match(readme, /`--context`/);
  assert.match(readme, /`--trigger`/);
  assert.match(readme, /N\/A/);
  assert.match(readme, /190,?000/);
  assert.match(readme, /50,?000/);
});

test('Chinese README has the same sections and capability rows', () => {
  for (const heading of [
    '## 1. 能力矩阵',
    '## 2. 快速开始',
    '## 3. 命令和选项',
    '## 4. 写入的确切值',
    '## 5. 完整支持与部分支持',
    '## 6. 备份、验证和恢复',
    '## 7. OpenCode JSONC 手动模板',
    '## 8. 限制',
    '## 9. 开发和测试',
    '## 10. 许可证',
  ]) {
    assert.ok(zh.includes(heading), `missing ${heading}`);
  }

  for (const name of ['OpenCode', 'DSH', 'Codex CLI', 'Claude Code', 'Gemini CLI', 'Qwen Code']) {
    assert.match(zh, new RegExp(name));
  }
  for (const support of ['`full`', '`partial`']) {
    assert.ok(zh.includes(support), `missing ${support}`);
  }
  assert.match(zh, /部分支持|partial/i);
  assert.match(zh, /95%/);
  assert.match(zh, /`--context`/);
  assert.match(zh, /`--trigger`/);
  assert.match(zh, /N\/A/);
  assert.match(zh, /190,?000/);
  assert.match(zh, /50,?000/);
});
