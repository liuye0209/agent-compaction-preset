import path from 'node:path';
import { mergeTopLevelToml } from './merge/toml.mjs';
import { readDshCompactionConfig } from './merge/yaml.mjs';

function formatName(extension) {
  if (extension === '.json') return 'JSON';
  if (extension === '.toml') return 'TOML';
  if (extension === '.yml' || extension === '.yaml') return 'YAML';
  return extension === '' ? 'unknown format' : extension.slice(1).toUpperCase();
}

function parseContent(filePath, content) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.json') {
    JSON.parse(content.replace(/^\uFEFF/, ''));
    return;
  }

  if (extension === '.toml') {
    // The merge parser validates string/array closure and table headers before
    // returning the unchanged document.
    mergeTopLevelToml(content, {});
    return;
  }

  if (extension === '.yml' || extension === '.yaml') {
    readDshCompactionConfig(content);
    return;
  }

  throw new Error(
    `Restore aborted: cannot verify parseability of ${filePath}; no files were changed.`,
  );
}

export function assertParseableConfig(filePath, content) {
  const extension = path.extname(filePath).toLowerCase();

  try {
    parseContent(filePath, content);
  } catch (error) {
    if (error.message.startsWith('Restore aborted:')) throw error;
    throw new Error(
      `Restore aborted: backup for ${filePath} is not valid ${formatName(extension)}; no files were changed.`,
    );
  }
}
