import { writeWithBackup } from '../backup.mjs';
import { geminiSettingsPath } from '../paths.mjs';
import { ratioFor } from '../policy.mjs';
import { mergeJson } from '../merge/json.mjs';
import { change, readJsonFile } from './common.mjs';

const AGENT_ID = 'gemini';
const AGENT_NAME = 'Gemini CLI';
const SUPPORT = 'partial';
const NEW_KEY = 'model.compressionThreshold';
const LEGACY_KEY = 'model.chatCompression.contextPercentageThreshold';

const LEGACY_ONLY_WARNING =
  'Gemini CLI uses the legacy model.chatCompression.contextPercentageThreshold key; it was updated, but it should be migrated to model.compressionThreshold.';
const LEGACY_REMAINS_WARNING =
  'The legacy model.chatCompression.contextPercentageThreshold key remains in the file; Gemini CLI may give it precedence over model.compressionThreshold.';

function exists(fsImpl, filePath) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function newValue(value) {
  return value?.model?.compressionThreshold;
}

function legacyValue(value) {
  return value?.model?.chatCompression?.contextPercentageThreshold;
}

function buildPatch(ratio, useLegacy) {
  return useLegacy
    ? { model: { chatCompression: { contextPercentageThreshold: ratio } } }
    : { model: { compressionThreshold: ratio } };
}

function buildTemplate(policy) {
  return `${JSON.stringify(buildPatch(ratioFor(policy), false), null, 2)}\n`;
}

function display(value) {
  return value === undefined ? 'missing' : JSON.stringify(value);
}

function detect(ctx) {
  const configPath = geminiSettingsPath(ctx.home);
  return { detected: exists(ctx.fs, configPath), configPath, notes: [] };
}

function plan(ctx, policy) {
  const configPath = geminiSettingsPath(ctx.home);
  const ratio = ratioFor(policy);
  const effective = {
    trigger: Math.round(ratio * policy.context),
    keep: null,
  };
  const warnings = [];
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
      changes: [change(NEW_KEY, null, ratio)],
      effective,
      warnings,
      nextContent: mergeJson('{}\n', buildPatch(ratio, false)),
    };
  }

  const { text, value } = readJsonFile(ctx, configPath);
  const currentNew = newValue(value);
  const currentLegacy = legacyValue(value);
  const useLegacy = currentNew === undefined && currentLegacy !== undefined;
  const targetKey = useLegacy ? LEGACY_KEY : NEW_KEY;
  const current = useLegacy ? currentLegacy : currentNew;

  if (useLegacy) {
    warnings.push(LEGACY_ONLY_WARNING);
  } else if (currentLegacy !== undefined) {
    warnings.push(LEGACY_REMAINS_WARNING);
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
    changes: [change(targetKey, current, ratio)],
    effective,
    warnings,
    nextContent: mergeJson(text, buildPatch(ratio, useLegacy)),
  };
}

function apply(ctx, plan) {
  if (plan.status === 'noop') {
    return { backupPath: null };
  }

  if (plan.status === 'manual') {
    throw new Error(
      `Gemini CLI requires a manual update for ${plan.configPath}; no file was written.`,
    );
  }

  if (plan.status === 'unsupported') {
    throw new Error(
      `Gemini CLI cannot apply a plan for ${plan.configPath}.`,
    );
  }

  if (plan.status === 'missing' && !ctx.create) {
    throw new Error(
      `Gemini CLI config ${plan.configPath} does not exist; re-run with --create to create it.`,
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
  const configPath = geminiSettingsPath(ctx.home);
  const ratio = ratioFor(policy);

  if (!exists(ctx.fs, configPath)) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [`Gemini CLI config ${configPath} does not exist.`],
      ok: false,
    };
  }

  const { value } = readJsonFile(ctx, configPath);
  const currentNew = newValue(value);
  const currentLegacy = legacyValue(value);
  const current = currentNew === undefined ? currentLegacy : currentNew;
  const warnings = [];

  if (currentNew === undefined && currentLegacy !== undefined) {
    warnings.push(LEGACY_ONLY_WARNING);
  } else if (currentNew !== undefined && currentLegacy !== undefined) {
    warnings.push(LEGACY_REMAINS_WARNING);
  }

  if (current !== ratio) {
    warnings.push(
      `model.compressionThreshold is ${display(current)}; expected ${ratio}.`,
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
