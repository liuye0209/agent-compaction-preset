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

  if (hasJsonComments(text)) {
    throw new Error(`JSON comments are not supported in ${filePath}`);
  }

  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    const match = /\bat position (\d+)\b/.exec(String(error?.message ?? ''));
    const position = match === null ? '' : ` at position ${match[1]}`;

    throw new Error(`Invalid JSON in ${filePath}${position}`);
  }
}
