const BARE_KEY = /^[A-Za-z0-9_-]+/;
const BASIC_ESCAPES = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

function malformedTableHeader() {
  return new Error(
    'Ambiguous TOML: malformed table header; refusing to guess.',
  );
}

function tableName(line) {
  const indent = /^\s*/.exec(line)[0].length;
  if (line[indent] !== '[') return null;

  const arrayTable = line[indent + 1] === '[';
  let index = indent + (arrayTable ? 2 : 1);
  let name = '';

  while (index < line.length) {
    const character = line[index];

    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      let closed = false;

      while (index < line.length) {
        const current = line[index];

        if (escaped) {
          escaped = false;
          index += 1;
          continue;
        }
        if (current === '\\') {
          escaped = true;
          index += 1;
          continue;
        }
        if (current === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }

      if (!closed || decodeBasicKey(line.slice(start + 1, index - 1)) === null) {
        throw malformedTableHeader();
      }
      name += line.slice(start, index);
      continue;
    }

    if (character === "'") {
      const end = line.indexOf("'", index + 1);
      if (end === -1) throw malformedTableHeader();
      name += line.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    if (character === ']') {
      const closeLength = arrayTable ? 2 : 1;
      if (arrayTable && line[index + 1] !== ']') throw malformedTableHeader();
      if (!/^\s*(?:#.*)?$/.test(line.slice(index + closeLength))) {
        throw malformedTableHeader();
      }

      const trimmed = name.trim();
      if (trimmed === '') throw malformedTableHeader();
      return trimmed;
    }

    name += character;
    index += 1;
  }

  throw malformedTableHeader();
}

function linesOf(text) {
  return String(text ?? '').split(/\r?\n/);
}

function isClean(state) {
  return state.multiline === null && state.bracketDepth === 0;
}

function decodeBasicKey(raw) {
  let decoded = '';

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (character !== '\\') {
      decoded += character;
      continue;
    }

    const escape = raw[index + 1];
    if (escape === undefined) return null;

    if (escape === 'u' || escape === 'U') {
      const length = escape === 'u' ? 4 : 8;
      const hex = raw.slice(index + 2, index + 2 + length);
      if (hex.length !== length || !/^[0-9A-Fa-f]+$/.test(hex)) return null;

      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) return null;

      decoded += String.fromCodePoint(codePoint);
      index += length + 1;
      continue;
    }

    if (!Object.hasOwn(BASIC_ESCAPES, escape)) return null;
    decoded += BASIC_ESCAPES[escape];
    index += 1;
  }

  return decoded;
}

function parseKeyAt(line, start) {
  const character = line[start];

  if (character === '"') {
    let raw = '';
    let index = start + 1;

    while (index < line.length) {
      const current = line[index];

      if (current === '"') {
        const key = decodeBasicKey(raw);
        if (key === null) return null;
        return { key, text: line.slice(start, index + 1), end: index + 1 };
      }

      if (current === '\\') {
        raw += current;
        if (index + 1 < line.length) raw += line[index + 1];
        index += 2;
        continue;
      }

      raw += current;
      index += 1;
    }

    return null;
  }

  if (character === "'") {
    const end = line.indexOf("'", start + 1);
    if (end === -1) return null;

    return {
      key: line.slice(start + 1, end),
      text: line.slice(start, end + 1),
      end: end + 1,
    };
  }

  const match = BARE_KEY.exec(line.slice(start));
  if (match === null) return null;

  return { key: match[0], text: match[0], end: start + match[0].length };
}

function parseAssignment(line) {
  const indent = /^\s*/.exec(line)[0];
  const parsed = parseKeyAt(line, indent.length);
  if (parsed === null) return null;

  let index = parsed.end;
  while (line[index] === ' ' || line[index] === '\t') index += 1;
  if (line[index] !== '=') return null;
  index += 1;
  while (line[index] === ' ' || line[index] === '\t') index += 1;

  return {
    indent,
    key: parsed.key,
    keyText: parsed.text,
    separator: line.slice(parsed.end, index),
    rest: line.slice(index),
  };
}

function scanLine(line, state) {
  let index = 0;
  let multiline = state.multiline;
  let bracketDepth = state.bracketDepth;
  let commentIndex = -1;

  while (index < line.length) {
    if (multiline !== null) {
      const quote = multiline[0];

      if (quote === '"' && line[index] === '\\') {
        index += 2;
        continue;
      }

      if (line[index] !== quote) {
        index += 1;
        continue;
      }

      let run = 1;
      while (line[index + run] === quote) run += 1;

      if (run >= 3) multiline = null;
      index += run;
      continue;
    }

    const character = line[index];

    if (character === '#') {
      commentIndex = index;
      break;
    }

    if (character === '"') {
      if (line.startsWith('"""', index)) {
        multiline = '"""';
        index += 3;
        continue;
      }

      index += 1;
      while (index < line.length) {
        if (line[index] === '\\') {
          index += 2;
          continue;
        }
        if (line[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === "'") {
      if (line.startsWith("'''", index)) {
        multiline = "'''";
        index += 3;
        continue;
      }

      const close = line.indexOf("'", index + 1);
      index = close === -1 ? line.length : close + 1;
      continue;
    }

    if (character === '[') {
      bracketDepth += 1;
      index += 1;
      continue;
    }

    if (character === ']') {
      if (bracketDepth > 0) bracketDepth -= 1;
      index += 1;
      continue;
    }

    index += 1;
  }

  return {
    multiline,
    bracketDepth,
    commentIndex,
  };
}

function splitValueAndComment(raw) {
  const scan = scanLine(raw, { multiline: null, bracketDepth: 0 });

  if (scan.commentIndex === -1) {
    return {
      value: raw.trim(),
      gap: '',
      comment: '',
      state: { multiline: scan.multiline, bracketDepth: scan.bracketDepth },
    };
  }

  const head = raw.slice(0, scan.commentIndex);

  return {
    value: head.trim(),
    gap: head.slice(head.trimEnd().length),
    comment: raw.slice(scan.commentIndex),
    state: { multiline: scan.multiline, bracketDepth: scan.bracketDepth },
  };
}

function assertClosed(state) {
  if (state.multiline !== null) {
    throw new Error(
      'Ambiguous TOML: unclosed multiline string at EOF; refusing to guess.',
    );
  }

  if (state.bracketDepth > 0) {
    throw new Error(
      'Ambiguous TOML: unclosed array at EOF; refusing to guess.',
    );
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

  let state = { multiline: null, bracketDepth: 0 };
  let firstTable = -1;
  const assignments = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (isClean(state)) {
      if (tableName(line) !== null) {
        if (firstTable === -1) firstTable = index;
        continue;
      }

      const assignment = parseAssignment(line);
      if (assignment !== null) {
        const split = splitValueAndComment(assignment.rest);
        if (firstTable === -1) assignments.push({ index, assignment, split });
        state = split.state;
        continue;
      }
    }

    state = scanLine(line, state);
  }

  assertClosed(state);

  const found = new Set();

  for (const { index, assignment, split } of assignments) {
    if (!Object.hasOwn(values, assignment.key)) continue;

    if (split.state.multiline !== null) {
      throw new Error(
        `Ambiguous TOML: multiline value for key ${assignment.keyText} on line ${index + 1}; refusing to guess.`,
      );
    }

    if (split.state.bracketDepth > 0) {
      throw new Error(
        `Ambiguous TOML: array value for key ${assignment.keyText} on line ${index + 1}; refusing to guess.`,
      );
    }

    lines[index] =
      assignment.indent +
      assignment.keyText +
      assignment.separator +
      formatValue(values[assignment.key]) +
      split.gap +
      split.comment;
    found.add(assignment.key);
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

  let state = { multiline: null, bracketDepth: 0 };
  let topLevel = true;

  for (const line of linesOf(text)) {
    if (isClean(state)) {
      if (tableName(line) !== null) {
        topLevel = false;
        continue;
      }

      const assignment = parseAssignment(line);
      if (assignment !== null) {
        const split = splitValueAndComment(assignment.rest);
        if (topLevel && requested.has(assignment.key)) {
          values[assignment.key] = split.value;
        }
        state = split.state;
        continue;
      }
    }

    state = scanLine(line, state);
  }

  assertClosed(state);
  return values;
}

export function findKeysInTables(text, keys) {
  const requested = new Set(keys);
  const found = [];
  const lines = linesOf(text);
  let table = null;
  let state = { multiline: null, bracketDepth: 0 };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (isClean(state)) {
      const name = tableName(line);
      if (name !== null) {
        table = name;
        continue;
      }

      const assignment = parseAssignment(line);
      if (assignment !== null) {
        if (table !== null && requested.has(assignment.key)) {
          found.push({ table, key: assignment.key, line: index + 1 });
        }
        state = splitValueAndComment(assignment.rest).state;
        continue;
      }
    }

    state = scanLine(line, state);
  }

  assertClosed(state);
  return found;
}
