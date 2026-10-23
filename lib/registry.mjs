import opencode from './agents/opencode.mjs';
import dsh from './agents/dsh.mjs';
import codex from './agents/codex.mjs';
import claude from './agents/claude.mjs';
import gemini from './agents/gemini.mjs';
import qwen from './agents/qwen.mjs';

export const ADAPTERS = [opencode, dsh, codex, claude, gemini, qwen];

export function getAdapter(id) {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

function unknownAgent(id) {
  return new Error(`Unknown agent "${id}"`);
}

export function parseAgentSelection(value) {
  if (value === undefined) {
    return ADAPTERS.map((adapter) => adapter.id);
  }

  const selection = String(value);

  if (selection.trim() === 'all') {
    return ADAPTERS.map((adapter) => adapter.id);
  }

  const ids = [];

  for (const entry of selection.split(',')) {
    const id = entry.trim();

    if (id === '') continue;

    if (!getAdapter(id)) {
      throw unknownAgent(id);
    }

    if (!ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}

export function resolveAdapters(ids) {
  return ids.map((id) => {
    const adapter = getAdapter(id);

    if (!adapter) {
      throw unknownAgent(id);
    }

    return adapter;
  });
}

export function detectAdapters(adapters, ctx) {
  return adapters.map((adapter) => ({
    adapter,
    detection: adapter.detect(ctx),
  }));
}
