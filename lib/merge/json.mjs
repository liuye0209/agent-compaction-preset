function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeObjects(base, patch) {
  const result = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      isPlainObject(value) && isPlainObject(result[key])
        ? mergeObjects(result[key], value)
        : value;
  }

  return result;
}

export function hasJsonComments(text) {
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (
      character === '/' &&
      (text[index + 1] === '/' || text[index + 1] === '*')
    ) {
      return true;
    }
  }

  return false;
}

export function mergeJson(text, patch) {
  let value;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }

  if (!isPlainObject(value)) {
    throw new Error('Invalid JSON: the root value must be an object');
  }

  return `${JSON.stringify(mergeObjects(value, patch), null, 2)}\n`;
}
