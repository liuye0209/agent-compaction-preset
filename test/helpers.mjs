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
