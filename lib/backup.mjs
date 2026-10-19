import fs from 'node:fs';
import path from 'node:path';

let tempCounter = 0;

export function timestamp(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function statOrNull(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function pathExists(fsImpl, filePath) {
  return statOrNull(fsImpl, filePath) !== null;
}

function backupLabelPrefix(label) {
  if (label === undefined || label === null || label === '') return '';
  const text = String(label);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw new TypeError(
      'backup label may contain only letters, digits, ".", "_" and "-"',
    );
  }
  return `${text}-`;
}

function resolveWriteTarget(filePath, fsImpl) {
  let stats;
  try {
    stats = fsImpl.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return filePath;
    throw error;
  }

  if (!stats.isSymbolicLink()) return filePath;
  return fsImpl.realpathSync(filePath);
}

function temporaryPath(targetPath) {
  const base = path.basename(targetPath);
  tempCounter += 1;
  return path.join(
    path.dirname(targetPath),
    `${base}.tmp-agent-compact-${process.pid}-${tempCounter}`,
  );
}

function replaceFile(fsImpl, tempPath, targetPath) {
  try {
    fsImpl.renameSync(tempPath, targetPath);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    // Windows can transiently lock the destination (antivirus, editors);
    // retry exactly once as required by the write-safety contract.
    fsImpl.renameSync(tempPath, targetPath);
  }
}

export function createBackup(
  filePath,
  { fs: fsImpl = fs, now = () => new Date(), label } = {},
) {
  const prefix = `${filePath}.bak-agent-compact-${backupLabelPrefix(label)}${timestamp(now())}`;
  let candidate = prefix;
  let counter = 1;

  while (pathExists(fsImpl, candidate)) {
    candidate = `${prefix}-${counter}`;
    counter += 1;
  }

  fsImpl.copyFileSync(filePath, candidate);
  return candidate;
}

export function atomicWrite(filePath, content, { fs: fsImpl = fs } = {}) {
  const targetPath = resolveWriteTarget(filePath, fsImpl);
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });

  const original = statOrNull(fsImpl, targetPath);
  const tempPath = temporaryPath(targetPath);

  try {
    fsImpl.writeFileSync(tempPath, content);
    if (original !== null && process.platform !== 'win32') {
      fsImpl.chmodSync(tempPath, original.mode);
    }
    replaceFile(fsImpl, tempPath, targetPath);
  } catch (error) {
    try {
      fsImpl.rmSync(tempPath, { force: true });
    } catch {
      // Keep the original failure; cleanup is best effort.
    }
    throw error;
  }
}

export function writeWithBackup(
  filePath,
  content,
  { fs: fsImpl = fs, now = () => new Date() } = {},
) {
  const backupPath = pathExists(fsImpl, filePath)
    ? createBackup(filePath, { fs: fsImpl, now })
    : null;

  atomicWrite(filePath, content, { fs: fsImpl });
  return { backupPath };
}

export function findLatestBackup(filePath, { fs: fsImpl = fs } = {}) {
  const directory = path.dirname(filePath);
  const escaped = path
    .basename(filePath)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^${escaped}\\.bak-agent-compact-\\d{8}-\\d{6}(?:-\\d+)?$`,
  );

  let names;
  try {
    names = fsImpl.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const matches = names.filter((name) => pattern.test(name)).sort();
  return matches.length === 0
    ? null
    : path.join(directory, matches[matches.length - 1]);
}

export function restoreExact(backupPath, targetPath, { fs: fsImpl = fs } = {}) {
  const content = fsImpl.readFileSync(backupPath);
  atomicWrite(targetPath, content, { fs: fsImpl });
}

export function restoreBackup(
  backupPath,
  targetPath,
  { fs: fsImpl = fs, now = () => new Date() } = {},
) {
  const safetyBackupPath = pathExists(fsImpl, targetPath)
    ? createBackup(targetPath, { fs: fsImpl, now, label: 'before-restore' })
    : null;

  restoreExact(backupPath, targetPath, { fs: fsImpl });
  return { safetyBackupPath };
}

function rollback(applied, fsImpl) {
  const failures = [];

  for (const record of [...applied].reverse()) {
    try {
      if (record.backupPath === null) {
        fsImpl.rmSync(record.configPath, { force: true });
      } else {
        restoreExact(record.backupPath, record.configPath, { fs: fsImpl });
      }
    } catch (error) {
      failures.push({ record, error });
    }
  }

  return failures;
}

export function applyTransaction(
  entries,
  { fs: fsImpl = fs, now = () => new Date() } = {},
) {
  void now;
  const applied = [];

  try {
    for (const entry of entries) {
      if (entry.plan?.status === 'noop') continue;

      const result = entry.adapter.apply(entry.ctx, entry.plan);
      applied.push({
        agentId: entry.agentId,
        backupPath: result?.backupPath ?? null,
        configPath: entry.configPath ?? entry.plan?.configPath,
      });
    }
  } catch (error) {
    const failures = rollback(applied, fsImpl);
    if (failures.length > 0) {
      const detail = failures
        .map(({ record, error: failure }) => `${record.agentId}: ${failure.message}`)
        .join('; ');
      throw new Error(`${error.message}; rollback failed for ${detail}`, {
        cause: error,
      });
    }
    throw error;
  }

  return { applied };
}
