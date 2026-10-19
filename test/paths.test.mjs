import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resolveHome,
  opencodeConfigPath,
  opencodeJsoncPath,
  dshHome,
  codexHome,
  claudeConfigDir,
  geminiSettingsPath,
  qwenSettingsPath,
} from '../lib/paths.mjs';

test('home precedence is --home, AGENT_COMPACT_HOME, os.homedir()', () => {
  assert.equal(
    resolveHome({ home: path.join('/tmp', 'explicit'), env: { AGENT_COMPACT_HOME: path.join('/tmp', 'env') } }),
    path.join('/tmp', 'explicit'),
  );
  assert.equal(
    resolveHome({ env: { AGENT_COMPACT_HOME: path.join('/tmp', 'env') } }),
    path.join('/tmp', 'env'),
  );
});

test('opencode path honors XDG_CONFIG_HOME', () => {
  assert.equal(
    opencodeConfigPath(path.join('/tmp', 'home'), { XDG_CONFIG_HOME: path.join('/tmp', 'xdg') }),
    path.join('/tmp', 'xdg', 'opencode', 'opencode.json'),
  );
});

test('agent roots honor their environment overrides', () => {
  assert.equal(dshHome('/h', { DSH_HOME: '/dsh' }), '/dsh');
  assert.equal(codexHome('/h', { CODEX_HOME: '/codex' }), '/codex');
  assert.equal(claudeConfigDir('/h', { CLAUDE_CONFIG_DIR: '/claude' }), '/claude');
  assert.equal(geminiSettingsPath('/h'), path.join('/h', '.gemini', 'settings.json'));
  assert.equal(qwenSettingsPath('/h'), path.join('/h', '.qwen', 'settings.json'));
});

test('paths fall back to the home directory defaults', () => {
  assert.equal(
    opencodeConfigPath('/h', {}),
    path.join('/h', '.config', 'opencode', 'opencode.json'),
  );
  assert.equal(
    opencodeJsoncPath('/h', { XDG_CONFIG_HOME: '/xdg' }),
    path.join('/xdg', 'opencode', 'opencode.jsonc'),
  );
  assert.equal(dshHome('/h', {}), path.join('/h', '.dsh'));
  assert.equal(codexHome('/h', {}), path.join('/h', '.codex'));
  assert.equal(claudeConfigDir('/h', {}), path.join('/h', '.claude'));
});
