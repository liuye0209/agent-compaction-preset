const ASSIGNMENT = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)(.*)$/;
const TABLE_HEADER = /^\s*\[\[?\s*([^\[\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const MULTILINE_DELIMITERS = ['"""', "'''"];

function tableName(line) {
  const match = TABLE_HEADER.exec(line);
  return match === null ? null : match[1].trim();
}

function linesOf(text) {
  return String(text ?? '').split(/\r?\n/);
}

function splitValueAndComment(raw) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }

    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === '#') {
      const head = raw.slice(0, index);
      const value = head.trim();
      return {
        value,
        gap: head.slice(head.trimEnd().length),
        comment: raw.slice(index),
      };
    }
  }

  return { value: raw.trim(), gap: '', comment: '' };
}

function assertNoOpenMultiline(value, lineNumber) {
  for (const delimiter of MULTILINE_DELIMITERS) {
    if (!value.startsWith(delimiter)) continue;
    if (value.indexOf(delimiter, delimiter.length) === -1) {
      throw new Error(
        `Ambiguous TOML: multiline string in a top-level value on line ${lineNumber}; refusing to guess.`,
      );
    }
  }
}

function formatValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  throw new TypeError(
    'TOML values must be strings, finite numbers, or booleans',
  );
}

export function mergeTopLevelToml(text, values) {
  const source = String(text ?? '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = source.endsWith('\n');
  const lines = source === '' ? [] : source.split(/\r?\n/);

  if (endsWithNewline) lines.pop();

  const firstTable = lines.findIndex((line) => tableName(line) !== null);
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable;
  const found = new Set();

  for (let index = 0; index < topLevelEnd; index += 1) {
    const match = ASSIGNMENT.exec(lines[index]);
    if (match === null) continue;

    const [, indent, key, equals, rest] = match;
    const { value, gap, comment } = splitValueAndComment(rest);
    assertNoOpenMultiline(value, index + 1);

    if (!Object.hasOwn(values, key)) continue;

    lines[index] =
      indent +
      key +
      equals +
      formatValue(values[key]) +
      gap +
      comment;
    found.add(key);
  }

  const missing = Object.keys(values).filter((key) => !found.has(key));

  if (missing.length > 0) {
    const insertAt = firstTable === -1 ? lines.length : firstTable;
    lines.splice(
      insertAt,
      0,
      ...missing.map((key) => `${key} = ${formatValue(values[key])}`),
    );
  }

  return lines.join(newline) + (endsWithNewline ? newline : '');
}

export function readTopLevelTomlValues(text, keys) {
  const requested = new Set(keys);
  const values = {};

  for (const key of keys) values[key] = undefined;

  for (const line of linesOf(text)) {
    if (tableName(line) !== null) break;

    const match = ASSIGNMENT.exec(line);
    if (match === null || !requested.has(match[2])) continue;

    values[match[2]] = splitValueAndComment(match[4]).value;
  }

  return values;
}

export function findKeysInTables(text, keys) {
  const requested = new Set(keys);
  const found = [];
  let table = null;
  const lines = linesOf(text);

  for (let index = 0; index < lines.length; index += 1) {
    const name = tableName(lines[index]);

    if (name !== null) {
      table = name;
      continue;
    }

    if (table === null) continue;

    const match = ASSIGNMENT.exec(lines[index]);
    if (match !== null && requested.has(match[2])) {
      found.push({ table, key: match[2], line: index + 1 });
    }
  }

  return found;
}
