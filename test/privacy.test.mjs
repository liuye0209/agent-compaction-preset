import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
}).trim().split(/\r?\n/).filter(Boolean);

const textExtensions = new Set([
  '.md', '.json', '.jsonc', '.mjs', '.js', '.cjs', '.yml', '.yaml',
  '.toml', '.txt', '.example',
]);

const secretPatterns = [
  { name: 'OpenAI-style key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'bearer token', pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
];

test('tracked and untracked text files contain no real-looking secrets', () => {
  assert.ok(files.length > 0, 'privacy scan found no files');

  for (const file of files) {
    if (
      !textExtensions.has(path.extname(file))
      && file !== 'LICENSE'
      && file !== '.gitignore'
      && file !== '.env'
    ) {
      continue;
    }

    const text = fs.readFileSync(file, 'utf8');
    for (const { name, pattern } of secretPatterns) {
      assert.doesNotMatch(text, pattern, `${file} contains a real-looking ${name}`);
    }
    assert.doesNotMatch(text, /C:\\Users\\[^\\\s]+/i, `${file} contains a Windows user path`);
    assert.doesNotMatch(text, /\/Users\/[^/\s]+/i, `${file} contains a macOS user path`);
  }
});
