import os from 'node:os';
import path from 'node:path';

export function resolveHome({ home, env = process.env } = {}) {
  if (home) return home;
  if (env?.AGENT_COMPACT_HOME) return env.AGENT_COMPACT_HOME;
  return os.homedir();
}

function configRoot(home, env) {
  return env?.XDG_CONFIG_HOME || path.join(home, '.config');
}

export function opencodeConfigPath(home, env = process.env) {
  return path.join(configRoot(home, env), 'opencode', 'opencode.json');
}

export function opencodeJsoncPath(home, env = process.env) {
  return path.join(configRoot(home, env), 'opencode', 'opencode.jsonc');
}

export function dshHome(home, env = process.env) {
  return env?.DSH_HOME || path.join(home, '.dsh');
}

export function codexHome(home, env = process.env) {
  return env?.CODEX_HOME || path.join(home, '.codex');
}

export function claudeConfigDir(home, env = process.env) {
  return env?.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

export function geminiSettingsPath(home) {
  return path.join(home, '.gemini', 'settings.json');
}

export function qwenSettingsPath(home) {
  return path.join(home, '.qwen', 'settings.json');
}
