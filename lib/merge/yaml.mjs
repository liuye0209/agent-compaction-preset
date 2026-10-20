const TARGET_KEYS = Object.freeze([
  'auto',
  'thresholdRatio',
  'headroomTokens',
  'maxTokens',
  'retainTokens',
]);

const ENTRY_START = /^(\s*)-\s+(.*)$/;
const KEY_LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):(\s*)(.*)$/;
const NUMBER_LITERAL =
  /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

function structureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function duplicateError(first, second) {
  return structureError(
    'DSH_DUPLICATE_ENTRY',
    `Duplicate compaction-basic entries at lines ${first + 1} and ${second + 1}`,
  );
}

function flowStyleError() {
  return structureError(
    'DSH_FLOW_STYLE',
    'Flow-style compaction-basic config is not supported',
  );
}

function unexpectedError(line) {
  return structureError(
    'DSH_UNEXPECTED_STRUCTURE',
    `Unexpected compaction-basic config structure on line ${line + 1}; expected a block mapping`,
  );
}

function splitDocument(text) {
  const source = String(text ?? '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = source.endsWith(eol);
  const body = finalNewline ? source.slice(0, -eol.length) : source;

  return {
    eol,
    finalNewline,
    lines: body === '' ? [] : body.split(eol),
  };
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

function parseKeyLine(line) {
  const match = KEY_LINE.exec(line);
  if (match === null) return null;

  return {
    indent: match[1].length,
    key: match[2],
    separator: match[3],
    rest: match[4],
  };
}

function unquote(value) {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }

  return value;
}

function splitValueAndComment(raw) {
  let quote = null;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (quote !== null) {
      if (character === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (
      character === '#' &&
      (index === 0 || /\s/.test(raw[index - 1]))
    ) {
      const valuePart = raw.slice(0, index);
      const value = valuePart.trimEnd();

      return {
        value,
        gap: valuePart.slice(value.length),
        comment: raw.slice(index),
      };
    }
  }

  const value = raw.trimEnd();
  return { value, gap: raw.slice(value.length), comment: '' };
}

function findEntries(lines) {
  const entries = [];
  let index = 0;

  while (index < lines.length) {
    const start = ENTRY_START.exec(lines[index]);
    if (start === null) {
      index += 1;
      continue;
    }

    const entryIndent = start[1].length;
    let end = index + 1;

    while (end < lines.length) {
      const line = lines[end];

      if (line.trim() === '') {
        end += 1;
        continue;
      }

      const indent = indentOf(line);
      if (indent < entryIndent) break;
      if (indent === entryIndent && ENTRY_START.test(line)) break;
      end += 1;
    }

    entries.push({ start: index, end, indent: entryIndent });
    index = end;
  }

  return entries;
}

function directEntryKey(line, index, entry) {
  let content;

  if (index === entry.start) {
    const match = ENTRY_START.exec(line);
    if (match === null) return null;
    content = match[2];
  } else {
    if (indentOf(line) !== entry.indent + 2) return null;
    content = line.trim();
  }

  return parseKeyLine(content);
}

function entryMatches(lines, entry) {
  for (let index = entry.start; index < entry.end; index += 1) {
    const parsed = directEntryKey(lines[index], index, entry);
    if (parsed === null) continue;

    const value = unquote(splitValueAndComment(parsed.rest).value);

    if (parsed.key === 'id' && value === 'compaction-basic') return true;
    if (
      parsed.key === 'name' &&
      value === '@deepseek-ai/dsh-compaction-basic'
    ) {
      return true;
    }
  }

  return false;
}

function analyzeConfig(lines, entry) {
  let configLine = -1;

  for (let index = entry.start; index < entry.end; index += 1) {
    const parsed = directEntryKey(lines[index], index, entry);
    if (parsed === null || parsed.key !== 'config') continue;

    if (configLine !== -1) throw unexpectedError(index);

    const value = splitValueAndComment(parsed.rest).value;
    if (value.startsWith('{')) throw flowStyleError();
    if (value !== '') throw unexpectedError(index);

    configLine = index;
  }

  if (configLine === -1) {
    return {
      configLine,
      blockEnd: entry.end,
      directIndent: entry.indent + 4,
    };
  }

  const configIndent = entry.indent + 2;
  let blockEnd = entry.end;

  for (let index = configLine + 1; index < entry.end; index += 1) {
    if (lines[index].trim() === '') continue;
    if (indentOf(lines[index]) <= configIndent) {
      blockEnd = index;
      break;
    }
  }

  let directIndent = configIndent + 2;

  for (let index = configLine + 1; index < blockEnd; index += 1) {
    if (lines[index].trim() === '' || lines[index].trim().startsWith('#')) {
      continue;
    }
    directIndent = indentOf(lines[index]);
    break;
  }

  return { configLine, blockEnd, directIndent };
}

function formatScalar(value) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value;

  throw new TypeError(
    'DSH YAML values must be strings, finite numbers, or booleans',
  );
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return null;

  const unquoted = unquote(value);

  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (NUMBER_LITERAL.test(unquoted)) return Number(unquoted);

  return unquoted;
}

function blockLines(config) {
  return [
    '- id: compaction-basic',
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    ...TARGET_KEYS.map((key) => `    ${key}: ${formatScalar(config[key])}`),
  ];
}

function renderBlock(config, eol) {
  return `${blockLines(config).join(eol)}${eol}`;
}

function appendBlock(document, block) {
  const { lines, eol, finalNewline } = document;

  if (lines.length === 0) return block;

  const base = lines.join(eol) + (finalNewline ? eol : '');
  const last = lines[lines.length - 1];

  if (last.trim() === '') return `${base}${block}`;
  if (finalNewline) return `${base}${eol}${block}`;

  return `${base}${eol}${eol}${block}`;
}

function hasNestedBlock(lines, index, blockEnd, directIndent) {
  for (let next = index + 1; next < blockEnd; next += 1) {
    const trimmed = lines[next].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return indentOf(lines[next]) > directIndent;
  }

  return false;
}

function findConfigInsertionLine(lines, entry) {
  let idLine = -1;
  let nameLine = -1;

  for (let index = entry.start; index < entry.end; index += 1) {
    const parsed = directEntryKey(lines[index], index, entry);
    if (parsed === null) continue;
    if (parsed.key === 'name') nameLine = index;
    if (parsed.key === 'id') idLine = index;
  }

  const anchor = nameLine !== -1 ? nameLine : idLine;
  return anchor === -1 ? entry.start + 1 : anchor + 1;
}

function findKeyInsertionLine(lines, analysis) {
  let firstDirect = -1;
  let lastScalar = -1;

  for (
    let index = analysis.configLine + 1;
    index < analysis.blockEnd;
    index += 1
  ) {
    if (indentOf(lines[index]) !== analysis.directIndent) continue;

    const parsed = parseKeyLine(lines[index]);
    if (parsed === null) continue;

    if (firstDirect === -1) firstDirect = index;
    if (splitValueAndComment(parsed.rest).value !== '') lastScalar = index;
  }

  if (lastScalar !== -1) return lastScalar + 1;
  if (firstDirect !== -1) return firstDirect;
  return analysis.configLine + 1;
}

export function mergeDshCompactionBlock(text, config) {
  const document = splitDocument(text);
  const lines = [...document.lines];
  const entries = findEntries(lines);
  const matching = entries.filter((entry) => entryMatches(lines, entry));

  if (matching.length > 1) {
    throw duplicateError(matching[0].start, matching[1].start);
  }

  if (matching.length === 0) {
    const block = renderBlock(config, document.eol);
    const trimmed = String(text ?? '').trim();

    if (trimmed === '' || trimmed === '[]') return block;
    return appendBlock(document, block);
  }

  const entry = matching[0];
  const analysis = analyzeConfig(lines, entry);

  if (analysis.configLine === -1) {
    const insertion = findConfigInsertionLine(lines, entry);
    lines.splice(
      insertion,
      0,
      `${' '.repeat(entry.indent + 2)}config:`,
      ...TARGET_KEYS.map(
        (key) =>
          `${' '.repeat(entry.indent + 4)}${key}: ${formatScalar(config[key])}`,
      ),
    );
  } else {
    const found = new Set();

    for (
      let index = analysis.configLine + 1;
      index < analysis.blockEnd;
      index += 1
    ) {
      if (indentOf(lines[index]) !== analysis.directIndent) continue;

      const parsed = parseKeyLine(lines[index]);
      if (parsed === null || !TARGET_KEYS.includes(parsed.key)) continue;

      const split = splitValueAndComment(parsed.rest);
      if (
        split.value === '' &&
        hasNestedBlock(lines, index, analysis.blockEnd, analysis.directIndent)
      ) {
        throw unexpectedError(index);
      }

      lines[index] =
        `${' '.repeat(parsed.indent)}${parsed.key}:${parsed.separator}` +
        `${formatScalar(config[parsed.key])}${split.gap}${split.comment}`;
      found.add(parsed.key);
    }

    const missing = TARGET_KEYS.filter((key) => !found.has(key));

    if (missing.length > 0) {
      const insertion = findKeyInsertionLine(lines, analysis);
      lines.splice(
        insertion,
        0,
        ...missing.map(
          (key) =>
            `${' '.repeat(analysis.directIndent)}${key}: ${formatScalar(config[key])}`,
        ),
      );
    }
  }

  return lines.join(document.eol) + (document.finalNewline ? document.eol : '');
}

export function readDshCompactionConfig(text) {
  const document = splitDocument(text);
  const entries = findEntries(document.lines);
  const matching = entries.filter((entry) =>
    entryMatches(document.lines, entry),
  );

  if (matching.length === 0) return { found: false, config: {} };
  if (matching.length > 1) {
    throw duplicateError(matching[0].start, matching[1].start);
  }

  const analysis = analyzeConfig(document.lines, matching[0]);

  if (analysis.configLine === -1) return { found: true, config: {} };

  const config = {};

  for (
    let index = analysis.configLine + 1;
    index < analysis.blockEnd;
    index += 1
  ) {
    if (indentOf(document.lines[index]) !== analysis.directIndent) continue;

    const parsed = parseKeyLine(document.lines[index]);
    if (parsed === null || !TARGET_KEYS.includes(parsed.key)) continue;

    const value = splitValueAndComment(parsed.rest).value;
    if (
      value === '' &&
      hasNestedBlock(
        document.lines,
        index,
        analysis.blockEnd,
        analysis.directIndent,
      )
    ) {
      throw unexpectedError(index);
    }

    config[parsed.key] = parseScalar(value);
  }

  return { found: true, config };
}
