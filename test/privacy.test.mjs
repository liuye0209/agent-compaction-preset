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
