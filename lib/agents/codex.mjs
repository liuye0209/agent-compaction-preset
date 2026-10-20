import path from 'node:path';
import { writeWithBackup } from '../backup.mjs';
import { codexHome } from '../paths.mjs';
import {
  findKeysInTables,
  mergeTopLevelToml,
  readTopLevelTomlValues,
} from '../merge/toml.mjs';
import { change, commandExists } from './common.mjs';

const AGENT_ID = 'codex';
const AGENT_NAME = 'Codex CLI';
const SUPPORT = 'partial';
const CONTEXT_KEY = 'model_context_window';
const TRIGGER_KEY = 'model_auto_compact_token_limit';

function exists(fsImpl, filePath) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function configPath(ctx) {
  return path.join(codexHome(ctx.home, ctx.env), 'config.toml');
}

function buildPatch(policy) {
  return {
    [CONTEXT_KEY]: policy.context,
    [TRIGGER_KEY]: policy.trigger,
  };
}

function buildTemplate(policy) {
  return `${CONTEXT_KEY} = ${policy.context}\n${TRIGGER_KEY} = ${policy.trigger}\n`;
}

function display(value) {
  return value === undefined ? 'missing' : JSON.stringify(value);
}

function profileWarnings(text) {
  const entries = findKeysInTables(text, [CONTEXT_KEY, TRIGGER_KEY]);

  if (entries.length === 0) return [];

  const tables = [...new Set(entries.map((entry) => entry.table))].join(', ');
  return [
    `Codex keys inside table(s) ${tables} may override the top-level values when that profile is active; verify the active profile.`,
  ];
}

function detect(ctx) {
  const filePath = configPath(ctx);
  let cliDetected = false;

  try {
    cliDetected = commandExists(ctx, 'codex');
  } catch {
    // A failed spawn means the CLI was not detected, not that detection failed.
    cliDetected = false;
  }

  return {
    detected: exists(ctx.fs, filePath) || cliDetected,
    configPath: filePath,
    notes: [],
  };
}

function plan(ctx, policy) {
  const filePath = configPath(ctx);
  const effective = { trigger: policy.trigger, keep: null };
  const base = {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    configPath: filePath,
    support: SUPPORT,
  };

  if (!exists(ctx.fs, filePath)) {
    return {
      ...base,
      status: 'missing',
      changes: [
        change(CONTEXT_KEY, null, policy.context),
        change(TRIGGER_KEY, null, policy.trigger),
      ],
      effective,
      warnings: [],
      nextContent: mergeTopLevelToml('', buildPatch(policy)),
    };
  }

  const text = ctx.fs.readFileSync(filePath, 'utf8');
  const current = readTopLevelTomlValues(text, [CONTEXT_KEY, TRIGGER_KEY]);
  const warnings = profileWarnings(text);

  if (
    Number(current[CONTEXT_KEY]) === policy.context &&
    Number(current[TRIGGER_KEY]) === policy.trigger
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
      change(CONTEXT_KEY, current[CONTEXT_KEY], policy.context),
      change(TRIGGER_KEY, current[TRIGGER_KEY], policy.trigger),
    ],
    effective,
    warnings,
    nextContent: mergeTopLevelToml(text, buildPatch(policy)),
  };
}

function apply(ctx, plan) {
  if (plan.status === 'noop') {
    return { backupPath: null };
  }

  if (plan.status === 'manual') {
    throw new Error(
      `Codex CLI requires a manual update for ${plan.configPath}; no file was written.`,
    );
  }

  if (plan.status === 'unsupported') {
    throw new Error(`Codex CLI cannot apply a plan for ${plan.configPath}.`);
  }

  if (plan.status === 'missing' && !ctx.create) {
    throw new Error(
      `Codex CLI config ${plan.configPath} does not exist; re-run with --create to create it.`,
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
  const filePath = configPath(ctx);

  if (!exists(ctx.fs, filePath)) {
    return {
      effective: { trigger: null, keep: null },
      warnings: [`Codex CLI config ${filePath} does not exist.`],
      ok: false,
    };
  }

  const text = ctx.fs.readFileSync(filePath, 'utf8');
  const current = readTopLevelTomlValues(text, [CONTEXT_KEY, TRIGGER_KEY]);
  const context = current[CONTEXT_KEY];
  const trigger = current[TRIGGER_KEY];
  const contextNumber = context === undefined ? null : Number(context);
  const triggerNumber = trigger === undefined ? null : Number(trigger);
  const warnings = [];

  if (contextNumber !== policy.context) {
    warnings.push(
      `${CONTEXT_KEY} is ${display(context)}; expected ${policy.context}.`,
    );
  }

  if (triggerNumber !== policy.trigger) {
    warnings.push(
      `${TRIGGER_KEY} is ${display(trigger)}; expected ${policy.trigger}.`,
    );
  }

  return {
    effective: {
      trigger: Number.isFinite(triggerNumber) ? triggerNumber : null,
      keep: null,
    },
    warnings,
    ok: contextNumber === policy.context && triggerNumber === policy.trigger,
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
