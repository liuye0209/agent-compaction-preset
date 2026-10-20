import { writeWithBackup } from '../backup.mjs';
import { qwenSettingsPath } from '../paths.mjs';
import { ratioFor } from '../policy.mjs';
import { mergeJson } from '../merge/json.mjs';
import { change, readJsonFile } from './common.mjs';

const AGENT_ID = 'qwen';
const AGENT_NAME = 'Qwen Code';
const SUPPORT = 'partial';
const TARGET_KEY = 'context.autoCompactThreshold';
const RETIRED_KEY = 'model.chatCompression.contextPercentageThreshold';

const LADDER_WARNING =
  'Qwen Code uses an internal warn/auto/hard compaction ladder; the configured value is a target, not a guarantee.';
const RETIRED_KEY_WARNING =
  'Qwen Code ignores the retired model.chatCompression.contextPercentageThreshold key; context.autoCompactThreshold is written instead.';

function exists(fsImpl, filePath) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function currentValue(value) {
  return value?.context?.autoCompactThreshold;
}

function retiredValue(value) {
  return value?.model?.chatCompression?.contextPercentageThreshold;
}

function buildPatch(ratio) {
  return { context: { autoCompactThreshold: ratio } };
}

function buildTemplate(policy) {
  return `${JSON.stringify(buildPatch(ratioFor(policy)), null, 2)}\n`;
}

function detect(ctx) {
  const configPath = qwenSettingsPath(ctx.home);
  return { detected: exists(ctx.fs, configPath), configPath, notes: [] };
}

function plan(ctx, policy) {
  const configPath = qwenSettingsPath(ctx.home);
  const ratio = ratioFor(policy);
  const effective = {
    trigger: Math.round(ratio * policy.context),
    keep: null,
  };
  const warnings = [LADDER_WARNING];
  const base = {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    configPath,
    support: SUPPORT,
  };

  if (!exists(ctx.fs, configPath)) {
    return {
      ...base,
      status: 'missing',
      changes: [change(TARGET_KEY, null, ratio)],
      effective,
      warnings,
      nextContent: mergeJson('{}\n', buildPatch(ratio)),
    };
  }

  const { text, value } = readJsonFile(ctx, configPath);
  const current = currentValue(value);

  if (retiredValue(value) !== undefined) {
    warnings.push(RETIRED_KEY_WARNING);
  }

  if (current === ratio) {
    return {
      ...base,
      status: 'noop',
      changes: [],
      effective,
      warnings,
    };
  }

  return {
    ...base,
    status: 'planned',
    changes: [change(TARGET_KEY, current, ratio)],
    effective,
    warnings,
    nextContent: mergeJson(text, buildPatch(ratio)),
  };
}

function apply(ctx, plan) {
  if (plan.status === 'noop') {
    return { backupPath: null };
  }

  if (plan.status === 'manual') {
    throw new Error(
      `Qwen Code requires a manual update for ${plan.configPath}; no file was written.`,
    );
  }

  if (plan.status === 'unsupported') {
    throw new Error(`Qwen Code cannot apply a plan for ${plan.configPath}.`);
  }

  if (plan.status === 'missing' && !ctx.create) {
    throw new Error(
      `Qwen Code config ${plan.configPath} does not exist; re-run with --create to create it.`,
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
  const configPath = qwenSettingsPath(ctx.home);
  const ratio = ratioFor(policy);
  const warnings = [LADDER_WARNING];

  if (!exists(ctx.fs, configPath)) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [...warnings, `Qwen Code config ${configPath} does not exist.`],
      ok: false,
    };
  }

  const { value } = readJsonFile(ctx, configPath);
  const current = currentValue(value);

  if (retiredValue(value) !== undefined) {
    warnings.push(RETIRED_KEY_WARNING);
  }

  if (current !== ratio) {
    warnings.push(
      `context.autoCompactThreshold is ${current === undefined ? 'missing' : JSON.stringify(current)}; expected ${ratio}.`,
    );
  }

  return {
    effective: {
      trigger:
        typeof current === 'number'
          ? Math.round(current * policy.context)
          : null,
      keep: null,
    },
    warnings,
    ok: typeof current === 'number' && current === ratio,
  };
}

function print(_ctx, policy) {
  return buildTemplate(policy);
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
