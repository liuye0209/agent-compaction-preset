import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveHome } from './paths.mjs';
import { resolvePolicy } from './policy.mjs';
import {
  applyTransaction,
  findLatestBackup,
  restoreBackup,
} from './backup.mjs';
import {
  ADAPTERS,
  detectAdapters,
  parseAgentSelection,
  resolveAdapters,
} from './registry.mjs';
import { sanitizePlan, toHumanReport, toJsonReport } from './report.mjs';

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const NUMERIC_OPTIONS = ['context', 'trigger', 'keep'];

const OPTIONS = {
  agents: { type: 'string' },
  context: { type: 'string' },
  trigger: { type: 'string' },
  keep: { type: 'string' },
  profile: { type: 'string' },
  yes: { type: 'boolean' },
  create: { type: 'boolean' },
  strict: { type: 'boolean' },
  json: { type: 'boolean' },
  home: { type: 'string' },
  'no-color': { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean' },
  latest: { type: 'boolean' },
  file: { type: 'string' },
  agent: { type: 'string' },
};

const HELP_TEXT = `Usage: agent-compact <command> [options]

Commands:
  detect   Show detected agent configurations
  plan     Show planned compaction changes without writing files
  apply    Write plans with backups and verification
  verify   Verify effective compaction settings without writing
  restore  Restore a timestamped backup
  print    Print configuration templates

Options:
  --agents <ids>    Comma-separated agent ids, or "all"
  --agent <id>      Print one agent's template (print only)
  --context <n>     Model context window in tokens (default 200000)
  --trigger <n>     Compaction trigger in tokens (default: 95% of context, floor)
  --keep <n>        Retained raw-context tokens (default 50000)
  --profile <name>  DSH profile name
  --create          Allow creating missing config files
  --strict          Exit 2 when a selected agent has partial support
  --yes             Skip the interactive confirmation
  --latest          Restore the latest backup (default)
  --file <path>     Restore a specific .bak-agent-compact-* backup
  --json            Print machine-readable JSON
  --home <path>     Set the base home directory
  --no-color        Disable ANSI colors
  --version         Print the version
  --help            Print this help
`;

let cachedVersion;

function packageVersion() {
  if (cachedVersion === undefined) {
    cachedVersion = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')).version;
  }

  return cachedVersion;
}

function defaultRunCommand(command, args = [], options = {}) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: options.timeout,
      env: options.env ?? process.env,
    });

    return {
      status: typeof result.status === 'number' ? result.status : null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch {
    return { status: null, stdout: '', stderr: '' };
  }
}

function policyOverrides(values) {
  const overrides = {};

  for (const name of NUMERIC_OPTIONS) {
    if (values[name] === undefined) continue;

    const value = Number(values[name]);

    if (!Number.isInteger(value)) {
      throw new Error(
        `--${name} must be an integer (received ${JSON.stringify(values[name])})`,
      );
    }

    overrides[name] = value;
  }

  return overrides;
}

function colorEnabled(values, env, isTTY) {
  return Boolean(isTTY) && !values['no-color'] && env.NO_COLOR === undefined;
}

function writeResult(result, values, io) {
  if (values.json) {
    io.stdout.write(toJsonReport(result));
    return;
  }

  io.stdout.write(toHumanReport(result, { color: io.color }));
}

function selectedByDetection(ctx) {
  return detectAdapters(ADAPTERS, ctx)
    .filter(({ detection }) => detection.detected)
    .map(({ adapter }) => adapter);
}

function selectForCommand(values, ctx) {
  if (values.agents !== undefined) {
    return resolveAdapters(parseAgentSelection(values.agents));
  }

  return selectedByDetection(ctx);
}

function detectReport(ctx, policy) {
  const agents = detectAdapters(ADAPTERS, ctx).map(({ adapter, detection }) => ({
    id: adapter.id,
    name: adapter.name,
    support: adapter.support,
    detected: Boolean(detection.detected),
    configPath: detection.configPath,
    version: detection.version ?? null,
    notes: Array.isArray(detection.notes) ? detection.notes : [],
  }));

  return {
    version: packageVersion(),
    command: 'detect',
    policy,
    agents,
  };
}

function planReport(values, ctx, policy) {
  const selected = selectForCommand(values, ctx);

  if (selected.length === 0) {
    return { report: null, code: 2 };
  }

  const agents = selected.map((adapter) =>
    sanitizePlan(adapter.plan(ctx, policy)),
  );

  return {
    report: {
      version: packageVersion(),
      command: 'plan',
      policy,
      agents,
    },
    code: 0,
  };
}

function printReport(values, ctx, policy) {
  let selected;

  if (values.agent !== undefined) {
    if (values.agents !== undefined) {
      throw new Error('Use either --agent or --agents, not both.');
    }

    const id = values.agent.trim();

    if (id === '') {
      throw new Error('--agent requires an agent id.');
    }

    selected = resolveAdapters([id]);
  } else if (values.agents !== undefined) {
    selected = resolveAdapters(parseAgentSelection(values.agents));
  } else {
    selected = ADAPTERS;
  }

  if (selected.length === 0) {
    return { report: null, code: 2 };
  }

  const agents = selected.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    support: adapter.support,
    template: adapter.print(ctx, policy),
  }));

  return {
    report: {
      version: packageVersion(),
      command: 'print',
      policy,
      agents,
    },
    code: 0,
  };
}

function noAgentsMessage(values, ctx) {
  if (values.agents !== undefined) {
    return 'No agents selected; pass at least one agent id or "all".';
  }

  return `No configured agents detected under ${ctx.home}; re-run with --agents <list>.`;
}

function verificationAgent(adapter, ctx, policy, configPath) {
  const detection = configPath === undefined ? adapter.detect(ctx) : null;
  const result = adapter.verify(ctx, policy);
  const ok = Boolean(result?.ok);

  return {
    id: adapter.id,
    name: adapter.name,
    support: adapter.support,
    configPath: configPath ?? detection?.configPath ?? null,
    effective: result?.effective ?? { trigger: null, keep: null },
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    ok,
    status: ok ? 'ok' : 'mismatch',
  };
}

async function confirmOrAbort(values, output, prompt, abortMessage) {
  if (values.yes) return true;

  if (!output.isTTY) {
    throw new Error(
      'Refusing to modify files without confirmation in a non-interactive session; re-run with --yes.',
    );
  }

  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({
    input: output.stdin,
    output: output.stderr,
  });
  let answer;

  try {
    answer = await readline.question(prompt);
  } finally {
    readline.close();
  }

  if (!/^(?:y|yes)$/i.test(answer.trim())) {
    output.stderr.write(`agent-compact: ${abortMessage}\n`);
    return false;
  }

  return true;
}

function assertApplicablePlans(plans, ctx) {
  for (const plan of plans) {
    if (plan.status === 'manual') {
      throw new Error(
        `${plan.name} requires a manual update for ${plan.configPath}; run "agent-compact print --agent ${plan.agentId}" and apply the template manually.`,
      );
    }

    if (plan.status === 'missing' && !ctx.create) {
      throw new Error(
        `${plan.name} config ${plan.configPath} does not exist; re-run with --create to create it.`,
      );
    }
  }
}

async function applyCommand(values, ctx, policy, output) {
  const selected = selectForCommand(values, ctx);

  if (selected.length === 0) {
    output.stderr.write(`agent-compact: ${noAgentsMessage(values, ctx)}\n`);
    return 2;
  }

  const plans = selected.map((adapter) => adapter.plan(ctx, policy));

  assertApplicablePlans(plans, ctx);

  if (values.strict && plans.some((plan) => plan.support === 'partial')) {
    writeResult(
      {
        version: packageVersion(),
        command: 'plan',
        policy,
        agents: plans.map((plan) => sanitizePlan(plan)),
      },
      values,
      output,
    );
    return 2;
  }

  const confirmed = await confirmOrAbort(
    values,
    output,
    `Apply changes to ${plans.length} agent(s)? [y/N] `,
    'apply aborted; no files were written.',
  );

  if (!confirmed) return 0;

  const entries = selected.map((adapter, index) => ({
    agentId: adapter.id,
    configPath: plans[index].configPath,
    adapter,
    plan: plans[index],
    ctx,
  }));
  const { applied } = applyTransaction(entries, {
    fs: ctx.fs,
    now: ctx.now,
    afterApply: (entry) => {
      const result = entry.adapter.verify(entry.ctx, policy);

      if (!result?.ok) {
        throw new Error(
          `${entry.agentId} verification failed after writing; rolled back the change.`,
        );
      }
    },
  });
  const agents = selected.map((adapter, index) =>
    verificationAgent(adapter, ctx, policy, plans[index].configPath),
  );
  const report = {
    version: packageVersion(),
    command: 'apply',
    policy,
    applied,
    agents,
  };

  writeResult(report, values, output);
  return agents.every((agent) => agent.ok) ? 0 : 1;
}

function verifyCommand(values, ctx, policy, output) {
  const selected = selectForCommand(values, ctx);

  if (selected.length === 0) {
    output.stderr.write(`agent-compact: ${noAgentsMessage(values, ctx)}\n`);
    return 2;
  }

  const agents = selected.map((adapter) =>
    verificationAgent(adapter, ctx, policy),
  );

  writeResult(
    {
      version: packageVersion(),
      command: 'verify',
      policy,
      agents,
    },
    values,
    output,
  );

  if (agents.some((agent) => !agent.ok)) return 1;

  if (values.strict && agents.some((agent) => agent.support === 'partial')) {
    return 2;
  }

  return 0;
}

function backupTarget(backupPath) {
  const name = path.basename(backupPath);
  const match = /^(.+)\.bak-agent-compact-.+$/.exec(name);

  if (match === null) {
    throw new Error(
      '--file must name a .bak-agent-compact-* backup; refusing to overwrite a config with itself.',
    );
  }

  return path.join(path.dirname(backupPath), match[1]);
}

async function restoreCommand(values, ctx, output) {
  if (values.file !== undefined && values.latest) {
    throw new Error('Use either --file or --latest, not both.');
  }

  const warnings = [];
  let candidates;

  if (values.file !== undefined) {
    const backupPath = values.file;
    candidates = [
      {
        agentId: 'explicit',
        configPath: backupTarget(backupPath),
        backupPath,
      },
    ];
  } else {
    const selected = selectForCommand(values, ctx);

    if (selected.length === 0) {
      output.stderr.write(`agent-compact: ${noAgentsMessage(values, ctx)}\n`);
      return 2;
    }

    candidates = [];

    for (const adapter of selected) {
      const detection = adapter.detect(ctx);

      if (!detection.configPath) {
        warnings.push(
          `${adapter.name} (${adapter.id}) has no config path; skipped.`,
        );
        continue;
      }

      const backupPath = findLatestBackup(detection.configPath, {
        fs: ctx.fs,
      });

      if (backupPath === null) {
        warnings.push(
          `No backup found for ${adapter.name} (${adapter.id}) at ${detection.configPath}.`,
        );
        continue;
      }

      candidates.push({
        agentId: adapter.id,
        configPath: detection.configPath,
        backupPath,
      });
    }

    if (candidates.length === 0) {
      writeResult(
        {
          version: packageVersion(),
          command: 'restore',
          restored: [],
          warnings,
        },
        values,
        output,
      );
      return 2;
    }
  }

  const confirmed = await confirmOrAbort(
    values,
    output,
    `Restore ${candidates.length} backup(s)? [y/N] `,
    'restore aborted; no files were changed.',
  );

  if (!confirmed) return 0;

  const restored = candidates.map((candidate) => {
    const { safetyBackupPath } = restoreBackup(
      candidate.backupPath,
      candidate.configPath,
      { fs: ctx.fs, now: ctx.now },
    );

    return {
      agentId: candidate.agentId,
      configPath: candidate.configPath,
      backupPath: candidate.backupPath,
      safetyBackupPath,
    };
  });

  writeResult(
    {
      version: packageVersion(),
      command: 'restore',
      restored,
      warnings,
    },
    values,
    output,
  );
  return 0;
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const fsImpl = io.fs ?? fs;
  const env = io.env ?? process.env;
  const now = io.now ?? (() => new Date());
  const baseRunCommand = io.runCommand ?? defaultRunCommand;
  const runCommand = (command, args = [], options = {}) =>
    baseRunCommand(command, args, { ...options, env });
  const isTTY = io.isTTY ?? stdout.isTTY ?? process.stdout.isTTY;

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    });

    if (values.help) {
      stdout.write(HELP_TEXT);
      return 0;
    }

    if (values.version) {
      stdout.write(`${packageVersion()}\n`);
      return 0;
    }

    const [command, ...rest] = positionals;

    if (command === undefined) {
      stderr.write('agent-compact: missing command; run agent-compact --help\n');
      return 1;
    }

    if (rest.length > 0) {
      throw new Error(`Unexpected argument ${JSON.stringify(rest.join(' '))}`);
    }

    if (
      !['detect', 'plan', 'apply', 'verify', 'restore', 'print'].includes(
        command,
      )
    ) {
      throw new Error(`Unknown command ${JSON.stringify(command)}`);
    }

    if (values.agent !== undefined && command !== 'print') {
      throw new Error(
        '--agent is only supported by the print command; use --agents to select agents.',
      );
    }

    const policy = resolvePolicy(policyOverrides(values));
    const ctx = {
      home: resolveHome({ home: values.home, env }),
      env,
      fs: fsImpl,
      now,
      runCommand,
      create: Boolean(values.create),
      profile: values.profile,
    };
    const output = {
      stdout,
      stderr,
      color: colorEnabled(values, env, isTTY),
      isTTY: Boolean(isTTY),
      stdin: io.stdin ?? process.stdin,
    };

    if (command === 'detect') {
      writeResult(detectReport(ctx, policy), values, output);
      return 0;
    }

    if (command === 'plan') {
      const { report, code } = planReport(values, ctx, policy);

      if (report === null) {
        stderr.write(`agent-compact: ${noAgentsMessage(values, ctx)}\n`);
        return code;
      }

      writeResult(report, values, output);

      if (
        values.strict &&
        report.agents.some((agent) => agent.support === 'partial')
      ) {
        return 2;
      }

      return code;
    }

    if (command === 'apply') {
      return await applyCommand(values, ctx, policy, output);
    }

    if (command === 'verify') {
      return verifyCommand(values, ctx, policy, output);
    }

    if (command === 'restore') {
      return await restoreCommand(values, ctx, output);
    }

    const { report, code } = printReport(values, ctx, policy);

    if (report === null) {
      stderr.write(`agent-compact: ${noAgentsMessage(values, ctx)}\n`);
      return code;
    }

    writeResult(report, values, output);
    return code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`agent-compact: ${message}\n`);
    return 1;
  }
}
