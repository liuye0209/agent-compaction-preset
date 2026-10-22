import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveHome } from './paths.mjs';
import { resolvePolicy } from './policy.mjs';
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
  print    Print configuration templates

Options:
  --agents <ids>    Comma-separated agent ids, or "all"
  --agent <id>      Print one agent's template (print only)
  --context <n>     Model context window in tokens (default 200000)
  --trigger <n>     Compaction trigger in tokens (default 190000)
  --keep <n>        Retained raw-context tokens (default 50000)
  --profile <name>  DSH profile name
  --create          Allow creating missing config files
  --strict          Exit 2 when a selected agent has partial support
  --json            Print machine-readable JSON
  --home <path>     Override the home directory
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

    if (!['detect', 'plan', 'print'].includes(command)) {
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
