import { writeWithBackup } from '../backup.mjs';
import { opencodeConfigPath, opencodeJsoncPath } from '../paths.mjs';
import { mergeJson } from '../merge/json.mjs';
import { change, commandExists, readJsonFile } from './common.mjs';

const AGENT_ID = 'opencode';
const AGENT_NAME = 'OpenCode';
const SUPPORT = 'full';

function exists(fsImpl, filePath) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function buildPatch(policy) {
  return {
    compaction: {
      auto: true,
      keep: { tokens: policy.keep },
      buffer: policy.context - policy.trigger,
    },
  };
}

function buildTemplate(policy) {
  return `${JSON.stringify(buildPatch(policy), null, 2)}\n`;
}

function currentValues(value) {
  const compaction = value?.compaction;

  return {
    auto: compaction?.auto ?? null,
    keep: compaction?.keep?.tokens ?? null,
    buffer: compaction?.buffer ?? null,
  };
}

function display(value) {
  return value === undefined ? 'missing' : JSON.stringify(value);
}

function detect(ctx) {
  const configPath = opencodeConfigPath(ctx.home, ctx.env);
  const jsoncPath = opencodeJsoncPath(ctx.home, ctx.env);
  const hasJson = exists(ctx.fs, configPath);
  const hasJsonc = exists(ctx.fs, jsoncPath);
  const detected = hasJson || hasJsonc || commandExists(ctx, 'opencode');
  const notes = [];

  if (hasJson && hasJsonc) {
    notes.push(
      `Both ${configPath} and ${jsoncPath} exist; JSONC may override JSON values.`,
    );
  } else if (!hasJson && hasJsonc) {
    notes.push(
      `Only ${jsoncPath} exists; it is not rewritten automatically.`,
    );
  }

  return { detected, configPath, notes };
}

function plan(ctx, policy) {
  const configPath = opencodeConfigPath(ctx.home, ctx.env);
  const jsoncPath = opencodeJsoncPath(ctx.home, ctx.env);
  const hasJson = exists(ctx.fs, configPath);
  const hasJsonc = exists(ctx.fs, jsoncPath);
  const buffer = policy.context - policy.trigger;
  const effective = { trigger: policy.trigger, keep: policy.keep };
  const warnings = [];
  const base = {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    configPath,
    support: SUPPORT,
  };

  if (!hasJson && hasJsonc) {
    warnings.push(
      `Only ${jsoncPath} exists; it may contain comments and will not be rewritten. Apply the printed template manually.`,
    );

    return {
      ...base,
      status: 'manual',
      changes: [],
      effective,
      warnings,
      template: buildTemplate(policy),
    };
  }

  if (!hasJson) {
    return {
      ...base,
      status: 'missing',
      changes: [
        change('compaction.auto', null, true),
        change('compaction.keep.tokens', null, policy.keep),
        change('compaction.buffer', null, buffer),
      ],
      effective,
      warnings,
      nextContent: mergeJson('{}\n', buildPatch(policy)),
    };
  }

  if (hasJsonc) {
    warnings.push(
      `Both ${configPath} and ${jsoncPath} exist; JSONC may override values written to ${configPath}.`,
    );
  }

  const { text, value } = readJsonFile(ctx, configPath);
  const current = currentValues(value);

  if (
    current.auto === true &&
    current.keep === policy.keep &&
    current.buffer === buffer
  ) {
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
    changes: [
      change('compaction.auto', current.auto, true),
      change('compaction.keep.tokens', current.keep, policy.keep),
      change('compaction.buffer', current.buffer, buffer),
    ],
    effective,
    warnings,
    nextContent: mergeJson(text, buildPatch(policy)),
  };
}

function apply(ctx, plan) {
  if (plan.status === 'noop') {
    return { backupPath: null };
  }

  if (plan.status === 'manual') {
    throw new Error(
      `OpenCode requires a manual update for ${plan.configPath}; no file was written.`,
    );
  }

  if (plan.status === 'unsupported') {
    throw new Error(`OpenCode cannot apply a plan for ${plan.configPath}.`);
  }

  if (plan.status === 'missing' && !ctx.create) {
    throw new Error(
      `OpenCode config ${plan.configPath} does not exist; re-run with --create to create it.`,
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
  const configPath = opencodeConfigPath(ctx.home, ctx.env);
  const jsoncPath = opencodeJsoncPath(ctx.home, ctx.env);
  const hasJson = exists(ctx.fs, configPath);
  const hasJsonc = exists(ctx.fs, jsoncPath);

  if (!hasJson) {
    const warnings = [
      hasJsonc
        ? `Only ${jsoncPath} exists; verify JSONC values manually.`
        : `OpenCode config ${configPath} does not exist.`,
    ];

    return {
      effective: { trigger: null, keep: null },
      warnings,
      ok: false,
    };
  }

  const { value } = readJsonFile(ctx, configPath);
  const compaction = value?.compaction;
  const auto = compaction?.auto;
  const keep = compaction?.keep?.tokens;
  const buffer = compaction?.buffer;
  const expectedBuffer = policy.context - policy.trigger;
  const effective = {
    trigger: typeof buffer === 'number' ? policy.context - buffer : null,
    keep: typeof keep === 'number' ? keep : null,
  };
  const warnings = [];

  if (auto !== true) {
    warnings.push(`compaction.auto is ${display(auto)}; expected true.`);
  }

  if (keep !== policy.keep) {
    warnings.push(
      `compaction.keep.tokens is ${display(keep)}; expected ${policy.keep}.`,
    );
  }

  if (buffer !== expectedBuffer) {
    warnings.push(
      `compaction.buffer is ${display(buffer)}; expected ${expectedBuffer}.`,
    );
  }

  if (hasJsonc) {
    warnings.push(
      `Both ${configPath} and ${jsoncPath} exist; JSONC may override JSON values.`,
    );
  }

  return {
    effective,
    warnings,
    ok: auto === true && keep === policy.keep && buffer === expectedBuffer,
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
