const ANSI = Object.freeze({
  bold: '1',
  dim: '2',
  green: '32',
});

function makePainter(enabled) {
  const wrap = (code) => (value) =>
    enabled ? `\x1b[${code}m${value}\x1b[0m` : String(value);

  return {
    bold: wrap(ANSI.bold),
    dim: wrap(ANSI.dim),
    green: wrap(ANSI.green),
  };
}

const CONTENT_KEYS = new Set(['nextContent', 'currentContent']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeValue(value, seen) {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;

  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const safe = [];
    seen.set(value, safe);

    for (const entry of value) {
      safe.push(sanitizeValue(entry, seen));
    }

    return safe;
  }

  const safe = {};
  seen.set(value, safe);

  for (const [key, entry] of Object.entries(value)) {
    if (CONTENT_KEYS.has(key)) continue;

    safe[key] = sanitizeValue(entry, seen);
  }

  return safe;
}

function addIdAlias(record) {
  if (
    isPlainObject(record) &&
    record.agentId !== undefined &&
    record.id === undefined
  ) {
    record.id = record.agentId;
  }

  return record;
}

export function sanitizePlan(plan) {
  return addIdAlias(sanitizeValue(plan, new WeakMap()));
}

export function toJsonReport(result) {
  const safe = sanitizeValue(result, new WeakMap());

  if (isPlainObject(safe) && Array.isArray(safe.agents)) {
    safe.agents = safe.agents.map(addIdAlias);
  }

  return `${JSON.stringify(safe, null, 2)}\n`;
}

function formatNumber(value) {
  return value === null || value === undefined ? 'N/A' : String(value);
}

function formatValue(value) {
  return value === null || value === undefined
    ? '(unset)'
    : JSON.stringify(value);
}

function formatEffective(effective) {
  const value = effective ?? {};
  return `trigger ${formatNumber(value.trigger)}, keep ${formatNumber(value.keep)}`;
}

function agentLabel(agent, paint) {
  const id = agent.id ?? agent.agentId;
  const name = agent.name ?? id ?? 'Unknown agent';

  return id === undefined
    ? `  ${paint.bold(name)}`
    : `  ${paint.bold(name)} (${id})`;
}

function appendWarnings(lines, warnings) {
  if (!Array.isArray(warnings)) return;

  for (const warning of warnings) {
    lines.push(`    warning: ${warning}`);
  }
}

function appendNotes(lines, notes) {
  if (!Array.isArray(notes)) return;

  for (const note of notes) {
    lines.push(`    note: ${note}`);
  }
}

function appendDetect(lines, agent, paint) {
  lines.push(agentLabel(agent, paint));
  lines.push(
    `    detected: ${agent.detected ? paint.green('yes') : 'no'}`,
  );

  if (agent.support !== undefined) {
    lines.push(`    support: ${agent.support}`);
  }

  if (agent.configPath !== undefined) {
    lines.push(`    config: ${agent.configPath}`);
  }

  if (agent.version !== undefined && agent.version !== null) {
    lines.push(`    version: ${agent.version}`);
  }

  appendNotes(lines, agent.notes);
}

function appendPlan(lines, agent, paint) {
  lines.push(agentLabel(agent, paint));

  if (agent.support !== undefined) {
    lines.push(`    support: ${agent.support}`);
  }

  if (agent.status !== undefined) {
    lines.push(`    status: ${agent.status}`);
  }

  if (agent.configPath !== undefined) {
    lines.push(`    config: ${agent.configPath}`);
  }

  if (Array.isArray(agent.changes) && agent.changes.length > 0) {
    lines.push('    changes:');

    for (const entry of agent.changes) {
      lines.push(
        `      ${entry.key}: ${formatValue(entry.from)} -> ${formatValue(entry.to)}`,
      );
    }
  } else {
    lines.push('    changes: none');
  }

  if (agent.effective) {
    lines.push(`    effective: ${formatEffective(agent.effective)}`);
  }

  appendWarnings(lines, agent.warnings);

  if (agent.status === 'manual' && typeof agent.template === 'string') {
    lines.push('    template:');

    for (const templateLine of agent.template.replace(/\n$/, '').split('\n')) {
      lines.push(`      ${templateLine}`);
    }
  }
}

function appendPrint(lines, agent, paint) {
  lines.push(`${agentLabel(agent, paint).trimEnd()}:`);
  lines.push(
    typeof agent.template === 'string'
      ? agent.template.replace(/\n$/, '')
      : '',
  );
  lines.push('');
}

function appendApplied(lines, item, paint) {
  lines.push(`  ${paint.bold(item.agentId)}`);

  if (item.configPath !== undefined) {
    lines.push(`    config: ${item.configPath}`);
  }

  lines.push(`    backup: ${item.backupPath ?? 'none'}`);
}

function appendRestored(lines, item, paint) {
  lines.push(`  ${paint.bold(item.agentId)}`);
  lines.push(`    config: ${item.configPath}`);
  lines.push(`    backup: ${item.backupPath}`);
  lines.push(`    safety backup: ${item.safetyBackupPath ?? 'none'}`);
}

function appendVerification(lines, agent, paint) {
  lines.push(agentLabel(agent, paint));

  if (agent.support !== undefined) {
    lines.push(`    support: ${agent.support}`);
  }

  if (agent.status !== undefined) {
    const status =
      agent.status === 'ok' ? paint.green(agent.status) : agent.status;
    lines.push(`    status: ${status}`);
  }

  if (agent.effective) {
    lines.push(`    effective: ${formatEffective(agent.effective)}`);
  }

  appendWarnings(lines, agent.warnings);
}

function appendTopLevelWarnings(lines, warnings, paint) {
  if (!Array.isArray(warnings) || warnings.length === 0) return;

  lines.push('');
  lines.push(paint.bold('Warnings:'));

  for (const warning of warnings) {
    lines.push(`  warning: ${warning}`);
  }
}

export function toHumanReport(result, { color = false } = {}) {
  const paint = makePainter(Boolean(color));
  const lines = [
    paint.bold(`agent-compact ${result?.version ?? 'unknown'}`),
  ];

  if (result?.policy) {
    lines.push(
      `Policy: context ${formatNumber(result.policy.context)}, trigger ${formatNumber(result.policy.trigger)}, keep ${formatNumber(result.policy.keep)}`,
    );
  }

  const agents = Array.isArray(result?.agents) ? result.agents : [];
  lines.push('');

  if (result?.command === 'detect') {
    lines.push(paint.bold('Detected agents:'));

    if (agents.length === 0) {
      lines.push('  (none)');
    } else {
      for (const agent of agents) appendDetect(lines, agent, paint);
    }
  } else if (result?.command === 'plan') {
    lines.push(paint.bold('Plan:'));

    if (agents.length === 0) {
      lines.push('  (no agents)');
    } else {
      for (const agent of agents) appendPlan(lines, agent, paint);
    }
  } else if (result?.command === 'print') {
    lines.push(paint.bold('Templates:'));

    if (agents.length === 0) {
      lines.push('  (no agents)');
    } else {
      for (const agent of agents) appendPrint(lines, agent, paint);
    }
  } else if (result?.command === 'apply') {
    const applied = Array.isArray(result.applied) ? result.applied : [];
    lines.push(paint.bold('Applied:'));

    if (applied.length === 0) {
      lines.push('  (none)');
    } else {
      for (const item of applied) appendApplied(lines, item, paint);
    }

    lines.push('');
    lines.push(paint.bold('Verification:'));

    if (agents.length === 0) {
      lines.push('  (none)');
    } else {
      for (const agent of agents) appendVerification(lines, agent, paint);
    }
  } else if (result?.command === 'verify') {
    lines.push(paint.bold('Verification:'));

    if (agents.length === 0) {
      lines.push('  (none)');
    } else {
      for (const agent of agents) appendVerification(lines, agent, paint);
    }
  } else if (result?.command === 'restore') {
    const restored = Array.isArray(result.restored) ? result.restored : [];
    lines.push(paint.bold('Restored:'));

    if (restored.length === 0) {
      lines.push('  (none)');
    } else {
      for (const item of restored) appendRestored(lines, item, paint);
    }

    appendTopLevelWarnings(lines, result.warnings, paint);
  } else {
    for (const agent of agents) appendPlan(lines, agent, paint);
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return `${lines.join('\n')}\n`;
}
