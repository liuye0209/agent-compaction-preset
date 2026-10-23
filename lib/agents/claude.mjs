import path from 'node:path';
import { writeWithBackup } from '../backup.mjs';
import { claudeConfigDir } from '../paths.mjs';
import { mergeJson } from '../merge/json.mjs';
import { change, readJsonFile } from './common.mjs';

const AGENT_ID = 'claude';
const AGENT_NAME = 'Claude Code';
const SUPPORT = 'partial';
const MIN_WINDOW_TOKENS = 100000;
const WINDOW_VERSION = [2, 1, 288];

function exists(fsImpl, filePath) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function parseVersion(output) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(output ?? ''));
  return match === null ? null : match[0];
}

function versionAtLeast(version, [major, minor, patch]) {
  if (typeof version !== 'string') return false;

  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;

  const parts = match.slice(1).map(Number);
  if (parts[0] !== major) return parts[0] > major;
  if (parts[1] !== minor) return parts[1] > minor;
  return parts[2] >= patch;
}

function hasWindowSupport(version) {
  return versionAtLeast(version, WINDOW_VERSION);
}

function writesWindow(version) {
  // Unknown versions get both keys; the spec prefers a best-effort window.
  return version === null || hasWindowSupport(version);
}

function assertWindowPolicy(policy, includeWindow) {
  if (includeWindow && policy.trigger < MIN_WINDOW_TOKENS) {
    throw new Error(
      `Claude Code requires autoCompactWindow to be at least ${MIN_WINDOW_TOKENS} tokens; the computed trigger is ${policy.trigger}.`,
    );
  }
}

function buildPatch(policy, includeWindow) {
  return includeWindow
    ? { autoCompactEnabled: true, autoCompactWindow: policy.trigger }
    : { autoCompactEnabled: true };
}

function buildTemplate(policy, includeWindow) {
  return `${JSON.stringify(buildPatch(policy, includeWindow), null, 2)}\n`;
}

function display(value) {
  return value === undefined ? 'missing' : JSON.stringify(value);
}

function detect(ctx) {
  const configPath = path.join(
    claudeConfigDir(ctx.home, ctx.env),
    'settings.json',
  );
  let result = null;
  try {
    result = ctx.runCommand('claude', ['--version'], { timeout: 2000 });
  } catch {
    // A failed spawn is treated as an unknown version.
    result = null;
  }
  const version = result?.status === 0 ? parseVersion(result.stdout) : null;
  const detected = exists(ctx.fs, configPath) || result?.status === 0;
  const notes = [];

  if (version === null && detected) {
    notes.push(
      'Could not determine the Claude Code version; autoCompactWindow requires 2.1.288 or newer.',
    );
  }

  return { detected, configPath, version, notes };
}

function plan(ctx, policy) {
  const { configPath, version } = detect(ctx);
  const includeWindow = writesWindow(version);
  const warnings = [];
  const effective = {
    trigger: includeWindow ? policy.trigger : null,
    keep: null,
  };
  const base = {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    configPath,
    support: SUPPORT,
  };

  if (version === null) {
    warnings.push(
      'Could not determine the Claude Code version; autoCompactWindow requires 2.1.288 or newer, so both keys will be written.',
    );
  } else if (!includeWindow) {
    warnings.push(
      `Claude Code ${version} does not support autoCompactWindow; it requires 2.1.288 or newer, so only autoCompactEnabled will be written.`,
    );
  }

  assertWindowPolicy(policy, includeWindow);

  if (!exists(ctx.fs, configPath)) {
    const changes = [change('autoCompactEnabled', null, true)];

    if (includeWindow) {
      changes.push(change('autoCompactWindow', null, policy.trigger));
    }

    return {
      ...base,
      status: 'missing',
      changes,
      effective,
      warnings,
      nextContent: mergeJson(
        '{}\n',
        buildPatch(policy, includeWindow),
      ),
    };
  }

  const { text, value } = readJsonFile(ctx, configPath);
  const enabled = value?.autoCompactEnabled ?? null;
  const window = value?.autoCompactWindow ?? null;

  if (
    enabled === true &&
    (!includeWindow || window === policy.trigger)
  ) {
    return {
      ...base,
      status: 'noop',
      changes: [],
      effective,
      warnings,
    };
  }

  const changes = [change('autoCompactEnabled', enabled, true)];

  if (includeWindow) {
    changes.push(change('autoCompactWindow', window, policy.trigger));
  }

  return {
    ...base,
    status: 'planned',
    changes,
    effective,
    warnings,
    nextContent: mergeJson(
      text,
      buildPatch(policy, includeWindow),
    ),
  };
}

function apply(ctx, plan) {
  if (plan.status === 'noop') {
    return { backupPath: null };
  }

  if (plan.status === 'manual') {
    throw new Error(
      `Claude Code requires a manual update for ${plan.configPath}; no file was written.`,
    );
  }

  if (plan.status === 'unsupported') {
    throw new Error(
      `Claude Code cannot apply a plan for ${plan.configPath}.`,
    );
  }

  if (plan.status === 'missing' && !ctx.create) {
    throw new Error(
      `Claude Code config ${plan.configPath} does not exist; re-run with --create to create it.`,
    );
  }

  if (typeof plan.nextContent !== 'string') {
    throw new Error(`No content was planned for ${plan.configPath}.`);
  }

  return writeWithBackup(plan.configPath, plan.nextContent, {
    fs: ctx.fs,
    now: ctx.now,
  });
}

function verify(ctx, policy) {
  const { configPath, version } = detect(ctx);

  if (!exists(ctx.fs, configPath)) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [`Claude Code config ${configPath} does not exist.`],
      ok: false,
    };
  }

  const { value } = readJsonFile(ctx, configPath);
  const enabled = value?.autoCompactEnabled;
  const window = value?.autoCompactWindow;
  const includeWindow = writesWindow(version);
  const trigger =
    includeWindow && typeof window === 'number' ? window : null;
  const warnings = [];

  if (enabled !== true) {
    warnings.push(
      `autoCompactEnabled is ${display(enabled)}; expected true.`,
    );
  }

  // Old known versions cannot apply the window, so its absence is fine there.
  const windowOk = includeWindow ? window === policy.trigger : true;

  if (includeWindow && !windowOk) {
    warnings.push(
      `autoCompactWindow is ${display(window)}; expected ${policy.trigger}.`,
    );
  } else if (!includeWindow && window !== undefined) {
    warnings.push(
      `autoCompactWindow is ${display(window)}; Claude Code ${version} ignores it because it requires 2.1.288 or newer.`,
    );
  }

  return {
    effective: { trigger, keep: null },
    warnings,
    ok: enabled === true && windowOk,
  };
}

function print(ctx, policy) {
  const { version } = detect(ctx);
  const includeWindow = writesWindow(version);
  assertWindowPolicy(policy, includeWindow);
  return buildTemplate(policy, includeWindow);
}

export default {
  id: AGENT_ID,
  name: AGENT_NAME,
  support: SUPPORT,
  detect,
  plan,
  apply,
  verify,
  print,
};
