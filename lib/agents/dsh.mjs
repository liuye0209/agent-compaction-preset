import path from 'node:path';
import { writeWithBackup } from '../backup.mjs';
import { dshEffectiveTrigger } from '../policy.mjs';
import { dshHome } from '../paths.mjs';
import {
  mergeDshCompactionBlock,
  readDshCompactionConfig,
} from '../merge/yaml.mjs';
import { change } from './common.mjs';

const AGENT_ID = 'dsh';
const AGENT_NAME = 'DSH';
const SUPPORT = 'full';
const MAX_TOKENS = 8192;
const HEADROOM_TOKENS = 0;
const PATCH_FILE = 'cordis.patch.yml';
const TARGET_KEYS = Object.freeze([
  'auto',
  'thresholdRatio',
  'headroomTokens',
  'maxTokens',
  'retainTokens',
]);

function exists(fsImpl, filePath) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isRegularFile(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function profilesDir(ctx) {
  return path.join(dshHome(ctx.home, ctx.env), 'profiles');
}

function configPathFor(ctx, profile) {
  return path.join(profilesDir(ctx), profile, PATCH_FILE);
}

function validateProfile(profile) {
  if (
    typeof profile !== 'string' ||
    profile === '' ||
    profile === '.' ||
    profile === '..' ||
    profile.includes('/') ||
    profile.includes('\\') ||
    profile.includes('..') ||
    path.isAbsolute(profile)
  ) {
    throw new Error(
      `Invalid DSH profile name ${JSON.stringify(profile)}; use a plain profile directory name.`,
    );
  }

  return profile;
}

function listProfiles(ctx) {
  const directory = profilesDir(ctx);
  let names;

  try {
    names = ctx.fs.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return names
    .filter((name) => {
      const profileDir = path.join(directory, name);

      try {
        if (!ctx.fs.statSync(profileDir).isDirectory()) return false;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }

      return isRegularFile(ctx.fs, path.join(profileDir, PATCH_FILE));
    })
    .sort();
}

function selectProfile(ctx) {
  const profiles = listProfiles(ctx);

  if (ctx.profile !== undefined && ctx.profile !== null) {
    const profile = validateProfile(ctx.profile);
    return { profile, profiles, explicit: true };
  }

  if (profiles.length === 1) {
    return { profile: profiles[0], profiles, explicit: false };
  }

  if (profiles.length === 0) {
    throw new Error(
      `No DSH profiles found under ${profilesDir(ctx)}; re-run with --profile <name>.`,
    );
  }

  throw new Error(
    `Multiple DSH profiles exist (${profiles.join(', ')}); re-run with --profile <name>.`,
  );
}

function buildConfig(policy) {
  return {
    auto: true,
    thresholdRatio: policy.trigger / policy.context,
    headroomTokens: HEADROOM_TOKENS,
    maxTokens: MAX_TOKENS,
    retainTokens: policy.keep,
  };
}

function buildTemplate(policy) {
  return mergeDshCompactionBlock('', buildConfig(policy));
}

function configMatches(config, current) {
  return (
    current.auto === true &&
    current.thresholdRatio === config.thresholdRatio &&
    current.headroomTokens === HEADROOM_TOKENS &&
    current.maxTokens === MAX_TOKENS &&
    current.retainTokens === config.retainTokens
  );
}

function changesFor(config, current = {}) {
  return TARGET_KEYS.map((key) =>
    change(`config.${key}`, current[key] ?? null, config[key]),
  );
}

function effectiveFor(policy) {
  return {
    trigger: dshEffectiveTrigger(policy),
    keep: policy.keep,
  };
}

function display(value) {
  return value === undefined ? 'missing' : JSON.stringify(value);
}

function detect(ctx) {
  const profiles = listProfiles(ctx);

  if (ctx.profile !== undefined && ctx.profile !== null) {
    const profile = validateProfile(ctx.profile);
    const configPath = configPathFor(ctx, profile);

    return {
      detected: exists(ctx.fs, configPath),
      configPath,
      notes: [],
    };
  }

  if (profiles.length > 1) {
    return {
      detected: true,
      configPath: profilesDir(ctx),
      notes: [
        `Multiple DSH profiles exist: ${profiles.join(', ')}. Use --profile to select one.`,
      ],
    };
  }

  if (profiles.length === 1) {
    const configPath = configPathFor(ctx, profiles[0]);

    return {
      detected: exists(ctx.fs, configPath),
      configPath,
      notes: [],
    };
  }

  return {
    detected: false,
    configPath: profilesDir(ctx),
    notes: [],
  };
}

function assertRetention(policy, effective) {
  if (policy.keep >= effective.trigger) {
    throw new Error(
      `DSH retain (${policy.keep}) must be less than the effective trigger (${effective.trigger}); DSH would reject this configuration.`,
    );
  }
}

function plan(ctx, policy) {
  const selection = selectProfile(ctx);
  const configPath = configPathFor(ctx, selection.profile);
  const config = buildConfig(policy);
  const effective = effectiveFor(policy);
  const warnings = [];
  const base = {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    configPath,
    support: SUPPORT,
  };

  assertRetention(policy, effective);

  if (effective.trigger !== policy.trigger) {
    warnings.push(
      `DSH effective trigger is ${effective.trigger}, not the requested ${policy.trigger}.`,
    );
  }

  if (!exists(ctx.fs, configPath)) {
    return {
      ...base,
      status: 'missing',
      changes: changesFor(config),
      effective,
      warnings,
      nextContent: mergeDshCompactionBlock('', config),
    };
  }

  const text = ctx.fs.readFileSync(configPath, 'utf8');
  let current;
  let nextContent;

  try {
    current = readDshCompactionConfig(text);

    if (current.found && configMatches(config, current.config)) {
      return {
        ...base,
        status: 'noop',
        changes: [],
        effective,
        warnings,
      };
    }

    nextContent = mergeDshCompactionBlock(text, config);
  } catch (error) {
    if (error.code === 'DSH_DUPLICATE_ENTRY') throw error;

    if (
      error.code === 'DSH_FLOW_STYLE' ||
      error.code === 'DSH_UNEXPECTED_STRUCTURE'
    ) {
      warnings.push(`${error.message}; apply the template manually.`);

      return {
        ...base,
        status: 'manual',
        changes: [],
        effective,
        warnings,
        template: buildTemplate(policy),
      };
    }

    throw error;
  }

  return {
    ...base,
    status: 'planned',
    changes: changesFor(config, current.config),
    effective,
    warnings,
    nextContent,
  };
}

function apply(ctx, plan) {
  if (plan.status === 'noop') {
    return { backupPath: null };
  }

  if (plan.status === 'manual') {
    throw new Error(
      `DSH requires a manual update for ${plan.configPath}; no file was written.`,
    );
  }

  if (plan.status === 'unsupported') {
    throw new Error(`DSH cannot apply a plan for ${plan.configPath}.`);
  }

  if (plan.status === 'missing' && !ctx.create) {
    throw new Error(
      `DSH config ${plan.configPath} does not exist; re-run with --create to create it.`,
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
  let selection;

  try {
    selection = selectProfile(ctx);
  } catch (error) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [error.message],
      ok: false,
    };
  }

  const configPath = configPathFor(ctx, selection.profile);

  if (!exists(ctx.fs, configPath)) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [`DSH config ${configPath} does not exist.`],
      ok: false,
    };
  }

  const text = ctx.fs.readFileSync(configPath, 'utf8');
  let current;

  try {
    current = readDshCompactionConfig(text);
  } catch (error) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [
        `DSH config ${configPath} could not be read: ${error.message}; verify manually.`,
      ],
      ok: false,
    };
  }

  if (!current.found) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [
        `DSH config ${configPath} has no compaction-basic entry; apply the template manually.`,
      ],
      ok: false,
    };
  }

  const config = current.config;
  const expectedRatio = policy.trigger / policy.context;
  const warnings = [];

  if (config.auto !== true) {
    warnings.push(`config.auto is ${display(config.auto)}; expected true.`);
  }

  if (config.thresholdRatio !== expectedRatio) {
    warnings.push(
      `config.thresholdRatio is ${display(config.thresholdRatio)}; expected ${expectedRatio}.`,
    );
  }

  if (config.headroomTokens !== HEADROOM_TOKENS) {
    warnings.push(
      `config.headroomTokens is ${display(config.headroomTokens)}; expected ${HEADROOM_TOKENS}.`,
    );
  }

  if (config.maxTokens !== MAX_TOKENS) {
    warnings.push(
      `config.maxTokens is ${display(config.maxTokens)}; expected ${MAX_TOKENS}.`,
    );
  }

  if (config.retainTokens !== policy.keep) {
    warnings.push(
      `config.retainTokens is ${display(config.retainTokens)}; expected ${policy.keep}.`,
    );
  }

  const actual =
    typeof config.thresholdRatio === 'number' &&
    Number.isFinite(config.thresholdRatio) &&
    typeof config.maxTokens === 'number' &&
    Number.isFinite(config.maxTokens) &&
    typeof config.headroomTokens === 'number' &&
    Number.isFinite(config.headroomTokens)
      ? Math.floor(
          Math.min(
            policy.context * config.thresholdRatio,
            policy.context - config.maxTokens - config.headroomTokens,
          ),
        )
      : null;
  const actualKeep =
    typeof config.retainTokens === 'number' &&
    Number.isFinite(config.retainTokens)
      ? config.retainTokens
      : null;

  if (actual !== null && actual !== policy.trigger) {
    warnings.push(
      `DSH effective trigger is ${actual}, not the requested ${policy.trigger}.`,
    );
  }

  if (actual !== null && actualKeep !== null && actualKeep >= actual) {
    warnings.push(
      `config.retainTokens is ${actualKeep}; it must be less than the DSH effective trigger ${actual}.`,
    );
  }

  const ok =
    config.auto === true &&
    config.thresholdRatio === expectedRatio &&
    config.headroomTokens === HEADROOM_TOKENS &&
    config.maxTokens === MAX_TOKENS &&
    config.retainTokens === policy.keep &&
    actual !== null &&
    actualKeep !== null &&
    actualKeep < actual;

  return {
    effective: { trigger: actual, keep: actualKeep },
    warnings,
    ok,
  };
}

function print(_ctx, policy) {
  assertRetention(policy, effectiveFor(policy));
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
