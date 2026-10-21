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
const BLOCK_SCALAR_VALUE = /^[|>][0-9+-]*$/;
const NODE_PROPERTY_PREFIX = /^[&!]\S+(?:\s+|$)/;
const UNSUPPORTED_VALUE_PREFIXES = Object.freeze([
  '{',
  '[',
  '|',
  '>',
  '&',
  '*',
  '!',
]);

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

function duplicateKeyError(key, first, second) {
  return structureError(
    'DSH_UNEXPECTED_STRUCTURE',
    `Unexpected structure: duplicate config.${key} keys at lines ${first + 1} and ${second + 1}; refusing to update both`,
  );
}

function flowStyleError() {
  return structureError(
    'DSH_FLOW_STYLE',
    'Flow-style compaction-basic config is not supported',
  );
}

function unexpectedError(
  line,
  detail = 'expected a block mapping',
) {
  return structureError(
    'DSH_UNEXPECTED_STRUCTURE',
    `Unexpected structure in compaction-basic config on line ${line + 1}; ${detail}`,
  );
}

function unsupportedRootError(line) {
  return structureError(
    'DSH_UNEXPECTED_STRUCTURE',
    `Unsupported structure on line ${line + 1}; the DSH patch must be a top-level block sequence, an empty flow sequence, or empty`,
  );
}

function unsupportedEntryError(line) {
  return structureError(
    'DSH_UNEXPECTED_STRUCTURE',
    `Unsupported structure on line ${line + 1}; flow-style compaction entries cannot be updated safely`,
  );
}

function splitDocument(text) {
  const source = String(text ?? '');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = source.endsWith(eol);
  const body = finalNewline ? source.slice(0, -eol.length) : source;

  return {
    source,
    eol,
    finalNewline,
    lines: body === '' ? [] : body.split(eol),
  };
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

function isBlankLine(line) {
  return line.trim() === '';
}

function isCommentLine(line) {
  return line.trim().startsWith('#');
}

function isIgnorableLine(line) {
  return isBlankLine(line) || isCommentLine(line);
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

function isQuotedKeyLine(line) {
  return /^\s*(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*')\s*:/.test(line);
}

function isBlockScalarValue(value) {
  return BLOCK_SCALAR_VALUE.test(value);
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

function scalarText(line) {
  let content = line.trimStart();
  if (content === '' || content.startsWith('#')) return '';

  const item = /^-(?:\s+(.*))?$/.exec(content);
  if (item !== null) content = item[1] ?? '';

  const parsed = parseKeyLine(content);
  if (parsed !== null) content = parsed.rest;

  return splitValueAndComment(content).value.trim();
}

function scalarBody(value) {
  let rest = value;
  let match;

  while ((match = NODE_PROPERTY_PREFIX.exec(rest)) !== null) {
    rest = rest.slice(match[0].length).trimStart();
  }

  return rest;
}

function blockScalarHeaderIndent(line) {
  return isBlockScalarValue(scalarBody(scalarText(line)))
    ? indentOf(line)
    : -1;
}

function hasUnclosedQuotedScalar(line) {
  const body = scalarBody(scalarText(line));
  const quote = body[0];

  if (quote !== '"' && quote !== "'") return false;

  for (let index = 1; index < body.length; index += 1) {
    const character = body[index];

    if (quote === '"') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') return false;
      continue;
    }

    if (character === "'") {
      if (body[index + 1] === "'") {
        index += 1;
        continue;
      }
      return false;
    }
  }

  return true;
}

function assertNoMultilineQuotedScalars(lines, analysis) {
  let blockScalarIndent = -1;

  for (
    let index = analysis.configLine + 1;
    index < analysis.blockEnd;
    index += 1
  ) {
    const line = lines[index];

    if (blockScalarIndent !== -1) {
      if (isBlankLine(line) || indentOf(line) > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }

    if (isIgnorableLine(line)) continue;

    const headerIndent = blockScalarHeaderIndent(line);
    if (headerIndent !== -1) {
      blockScalarIndent = headerIndent;
      continue;
    }

    if (hasUnclosedQuotedScalar(line)) {
      throw unexpectedError(
        index,
        'multiline quoted scalars in the DSH config are not supported',
      );
    }
  }
}

function isQuotedScalarStart(value, index) {
  if (index === 0) return true;

  let previous = index - 1;

  if (!/\s/.test(value[previous])) {
    return (
      value[previous] === ':' ||
      value[previous] === ',' ||
      value[previous] === '[' ||
      value[previous] === '{' ||
      value[previous] === '?'
    );
  }

  while (previous >= 0 && /\s/.test(value[previous])) previous -= 1;
  if (previous < 0) return true;

  const significant = value[previous];

  return (
    significant === ':' ||
    significant === ',' ||
    significant === '[' ||
    significant === '{' ||
    significant === '?' ||
    significant === '-'
  );
}

function hasUnclosedFlowCollection(line) {
  const value = scalarBody(scalarText(line));
  let quote = null;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote !== null) {
      if (quote === '"' && character === '\\') {
        index += 1;
        continue;
      }
      if (quote === "'" && character === "'" && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }

    if (character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      break;
    }

    if (
      (character === '"' || character === "'") &&
      isQuotedScalarStart(value, index)
    ) {
      quote = character;
      continue;
    }

    if (character === '{' || character === '[') {
      depth += 1;
      continue;
    }

    if ((character === '}' || character === ']') && depth > 0) {
      depth -= 1;
    }
  }

  return depth > 0;
}

function assertNoMultilineFlowCollections(lines, analysis) {
  let blockScalarIndent = -1;

  for (
    let index = analysis.configLine + 1;
    index < analysis.blockEnd;
    index += 1
  ) {
    const line = lines[index];

    if (blockScalarIndent !== -1) {
      if (isBlankLine(line) || indentOf(line) > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }

    if (isIgnorableLine(line)) continue;

    const headerIndent = blockScalarHeaderIndent(line);
    if (headerIndent !== -1) {
      blockScalarIndent = headerIndent;
      continue;
    }

    if (hasUnclosedFlowCollection(line)) {
      throw unexpectedError(
        index,
        'multiline flow collections in the DSH config are not supported',
      );
    }
  }
}

function findEntries(lines) {
  const entries = [];
  let index = 0;

  while (index < lines.length) {
    const start = ENTRY_START.exec(lines[index]);
    if (start === null || start[1].length !== 0) {
      index += 1;
      continue;
    }

    const entryIndent = start[1].length;
    const keyIndent = lines[index].length - start[2].length;
    let end = index + 1;

    while (end < lines.length) {
      const line = lines[end];

      if (isIgnorableLine(line)) {
        end += 1;
        continue;
      }

      const indent = indentOf(line);
      if (indent < entryIndent) break;
      if (indent === entryIndent && ENTRY_START.test(line)) break;
      end += 1;
    }

    entries.push({ start: index, end, indent: entryIndent, keyIndent });
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
    if (indentOf(line) !== entry.keyIndent) return null;
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

    if (configLine !== -1) {
      throw unexpectedError(index, 'duplicate config keys');
    }

    const value = splitValueAndComment(parsed.rest).value;
    if (value.startsWith('{')) throw flowStyleError();
    if (value !== '') throw unexpectedError(index);

    configLine = index;
  }

  if (configLine === -1) {
    return {
      configLine,
      blockEnd: entry.end,
      directIndent: entry.keyIndent + 2,
    };
  }

  const configIndent = indentOf(lines[configLine]);
  let blockEnd = entry.end;

  for (let index = configLine + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (isIgnorableLine(line)) continue;

    const indent = indentOf(line);
    if (indent > configIndent) continue;

    if (indent !== entry.keyIndent || parseKeyLine(line) === null) {
      throw unexpectedError(
        index,
        'the config block must be a block mapping, not a sequence or scalar',
      );
    }

    blockEnd = index;
    break;
  }

  let firstContent = -1;

  for (let index = configLine + 1; index < blockEnd; index += 1) {
    if (isIgnorableLine(lines[index])) continue;
    firstContent = index;
    break;
  }

  let directIndent = configIndent + 2;

  if (firstContent !== -1) {
    const line = lines[firstContent];
    const parsed = parseKeyLine(line);

    if (parsed === null || ENTRY_START.test(line)) {
      throw unexpectedError(firstContent);
    }
    if (parsed.indent <= configIndent) {
      throw unexpectedError(firstContent);
    }

    directIndent = parsed.indent;
  }

  return { configLine, blockEnd, directIndent, firstContent };
}

function classifyRoot(lines, source) {
  const content = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isIgnorableLine(lines[index])) content.push(index);
  }

  if (content.length === 0) {
    return {
      kind: source.trim() === '' ? 'empty' : 'comment-only',
      line: 0,
    };
  }

  const first = content[0];
  const trimmed = lines[first].trim();

  if (/^\[\s*\](\s+#.*)?$/.test(trimmed)) {
    return content.length === 1
      ? { kind: 'empty-flow-sequence', line: first }
      : { kind: 'unsupported', line: content[1] };
  }

  if (indentOf(lines[first]) === 0 && /^-(?:\s|$)/.test(lines[first])) {
    return { kind: 'block-sequence', line: first };
  }

  return { kind: 'unsupported', line: first };
}

function validateEntryLayout(lines, entry) {
  const start = ENTRY_START.exec(lines[entry.start]);
  if (start !== null && isQuotedKeyLine(start[2].trimStart())) {
    throw unexpectedError(entry.start, 'quoted entry keys are not supported');
  }

  let owner = directEntryKey(lines[entry.start], entry.start, entry);

  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (isIgnorableLine(line)) continue;

    const indent = indentOf(line);
    if (indent === 0) {
      throw unexpectedError(
        index,
        'unexpected top-level content inside a sequence entry',
      );
    }
    if (indent < entry.keyIndent) {
      throw unexpectedError(index, 'entry indentation is inconsistent');
    }

    if (indent === entry.keyIndent) {
      if (isQuotedKeyLine(line)) {
        throw unexpectedError(index, 'quoted entry keys are not supported');
      }

      const parsed = parseKeyLine(line);
      if (parsed !== null) owner = parsed;
      continue;
    }

    if (owner === null) {
      throw unexpectedError(
        index,
        'unexpected nested content inside a sequence entry',
      );
    }

    const ownerValue = splitValueAndComment(owner.rest).value;

    if (
      owner.key === 'id' ||
      owner.key === 'name' ||
      (ownerValue !== '' && !isBlockScalarValue(ownerValue))
    ) {
      throw unexpectedError(
        index,
        `nested content under entry key ${owner.key} is not supported`,
      );
    }
  }
}

function validateBlockEntries(lines, entries) {
  for (const entry of entries) {
    validateEntryLayout(lines, entry);

    const start = ENTRY_START.exec(lines[entry.start]);
    if (start === null) continue;

    const content = start[2].trimStart();
    if (!content.startsWith('{') && !content.startsWith('[')) continue;

    const entryText = lines.slice(entry.start, entry.end).join('\n');
    if (entryText.includes('compaction-basic')) {
      throw unsupportedEntryError(entry.start);
    }
  }
}

function hasNestedBlock(lines, index, blockEnd, directIndent) {
  for (let next = index + 1; next < blockEnd; next += 1) {
    if (isIgnorableLine(lines[next])) continue;
    return indentOf(lines[next]) > directIndent;
  }

  return false;
}

function isUnsupportedTargetValue(value) {
  if (value === '') return false;
  return UNSUPPORTED_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function inspectConfig(lines, analysis) {
  const targets = new Map();
  if (analysis.configLine === -1) return targets;

  assertNoMultilineQuotedScalars(lines, analysis);
  assertNoMultilineFlowCollections(lines, analysis);

  const seen = new Map();

  for (
    let index = analysis.configLine + 1;
    index < analysis.blockEnd;
    index += 1
  ) {
    const line = lines[index];
    if (isIgnorableLine(line)) continue;

    const indent = indentOf(line);
    if (indent < analysis.directIndent) {
      throw unexpectedError(
        index,
        'the config block is not a consistent block mapping',
      );
    }
    if (indent > analysis.directIndent) continue;

    const parsed = parseKeyLine(line);
    if (parsed === null || ENTRY_START.test(line)) {
      throw unexpectedError(index);
    }

    if (!TARGET_KEYS.includes(parsed.key)) continue;

    if (seen.has(parsed.key)) {
      throw duplicateKeyError(parsed.key, seen.get(parsed.key), index);
    }
    seen.set(parsed.key, index);

    const split = splitValueAndComment(parsed.rest);
    if (isUnsupportedTargetValue(split.value)) {
      throw unexpectedError(
        index,
        `config.${parsed.key} is not a plain scalar`,
      );
    }
    if (
      hasNestedBlock(lines, index, analysis.blockEnd, analysis.directIndent)
    ) {
      throw unexpectedError(
        index,
        `config.${parsed.key} must be a single-line plain scalar`,
      );
    }

    targets.set(parsed.key, {
      index,
      key: parsed.key,
      parsed,
      split,
    });
  }

  return targets;
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

export function mergeDshCompactionBlock(text, config) {
  const document = splitDocument(text);
  const lines = [...document.lines];
  const entries = findEntries(lines);
  const matching = entries.filter((entry) => entryMatches(lines, entry));

  if (matching.length > 1) {
    throw duplicateError(matching[0].start, matching[1].start);
  }

  const root = classifyRoot(lines, document.source);

  validateBlockEntries(lines, entries);

  if (matching.length === 0) {
    const block = renderBlock(config, document.eol);

    if (root.kind === 'empty' || root.kind === 'empty-flow-sequence') {
      return block;
    }
    if (root.kind === 'comment-only' || root.kind === 'block-sequence') {
      return appendBlock(document, block);
    }

    throw unsupportedRootError(root.line);
  }

  if (root.kind !== 'block-sequence') {
    throw unsupportedRootError(root.line);
  }

  const entry = matching[0];
  const analysis = analyzeConfig(lines, entry);
  const targets = inspectConfig(lines, analysis);

  if (analysis.configLine === -1) {
    const insertion = findConfigInsertionLine(lines, entry);
    lines.splice(
      insertion,
      0,
      `${' '.repeat(entry.keyIndent)}config:`,
      ...TARGET_KEYS.map(
        (key) =>
          `${' '.repeat(entry.keyIndent + 2)}${key}: ${formatScalar(config[key])}`,
      ),
    );
  } else {
    for (const [key, target] of targets) {
      lines[target.index] =
        `${' '.repeat(target.parsed.indent)}${key}:${target.parsed.separator}` +
        `${formatScalar(config[key])}${target.split.gap}${target.split.comment}`;
    }

    const missing = TARGET_KEYS.filter((key) => !targets.has(key));

    if (missing.length > 0) {
      const insertion = analysis.blockEnd;
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

  validateBlockEntries(document.lines, entries);

  const matching = entries.filter((entry) =>
    entryMatches(document.lines, entry),
  );

  if (matching.length === 0) return { found: false, config: {} };
  if (matching.length > 1) {
    throw duplicateError(matching[0].start, matching[1].start);
  }

  const root = classifyRoot(document.lines, document.source);
  if (root.kind !== 'block-sequence') {
    throw unsupportedRootError(root.line);
  }

  const analysis = analyzeConfig(document.lines, matching[0]);
  const targets = inspectConfig(document.lines, analysis);

  if (analysis.configLine === -1) return { found: true, config: {} };

  const config = {};

  for (const [key, target] of targets) {
    config[key] = parseScalar(target.split.value);
  }

  return { found: true, config };
}
