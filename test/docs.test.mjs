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
