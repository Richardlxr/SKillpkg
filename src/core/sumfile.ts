import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { open, readdir, readFile, rename, rm } from 'node:fs/promises';
import type { InstallScope, McpRegistryEntry, SkillPackage } from '../types/index.js';
import { readFileOrNull, ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { getDefaultConfig } from '../utils/platform.js';

const SUMFILE_NAME = 'skm.sum';

export interface SumEntry {
  source: string;
  version: string;
  integrity: string;
}

export interface SumfileTarget {
  scope?: InstallScope;
  projectPath?: string;
  dir?: string;
}

/** Compute SHA-256 integrity hash over a skill directory (go.sum style) */
export async function computeIntegrity(dirPath: string): Promise<string> {
  const { pathExists } = await import('../utils/fs.js');
  if (!(await pathExists(dirPath))) {
    return 'sha256-missing';
  }
  const hash = createHash('sha256');
  await hashDirectory(dirPath, hash, dirPath);
  return 'sha256-' + hash.digest('hex');
}

/** Recursively hash all files in a directory (deterministic order) */
async function hashDirectory(
  dirPath: string,
  hash: ReturnType<typeof createHash>,
  root: string
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  // Sort for determinism
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    // Skip .git and node_modules
    if (entry.name === '.git' || entry.name === 'node_modules') continue;

    if (entry.isFile()) {
      const relPath = relative(root, fullPath);
      hash.update(relPath);
      const content = await readFile(fullPath);
      hash.update(content);
    } else if (entry.isDirectory()) {
      await hashDirectory(fullPath, hash, root);
    }
  }
}

export function getSumfilePath(target?: SumfileTarget | string): string {
  if (typeof target === 'string') return join(target, SUMFILE_NAME);
  if (target?.dir) return join(target.dir, SUMFILE_NAME);
  if (target?.scope === 'global') return getDefaultConfig().sumfilePath;
  return join(target?.projectPath || process.cwd(), SUMFILE_NAME);
}

/** Load sumfile from the selected scope, cwd, or a given directory. */
export async function loadSumfile(target?: SumfileTarget | string): Promise<Map<string, SumEntry>> {
  const sumPath = getSumfilePath(target);
  const content = await readFileOrNull(sumPath);
  const entries = new Map<string, SumEntry>();

  if (!content) {
    return entries;
  }

  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 3 || !parts[2].startsWith('sha256-')) {
      logger.debug(`Ignoring malformed sumfile line ${index + 1} in ${sumPath}`);
      continue;
    }

    entries.set(parts[0], {
      source: parts[0],
      version: parts[1],
      integrity: parts[2],
    });
  }

  return entries;
}

/** Save sumfile atomically. */
export async function saveSumfile(entries: Map<string, SumEntry>, target?: SumfileTarget | string): Promise<void> {
  const sumPath = getSumfilePath(target);
  
  // Sort keys for deterministic output
  const sortedKeys = Array.from(entries.keys()).sort();
  let content = '';
  
  for (const key of sortedKeys) {
    const entry = entries.get(key)!;
    content += `${entry.source} ${entry.version} ${entry.integrity}\n`;
  }

  await writeFileAtomic(sumPath, content);
  logger.debug(`Sumfile written: ${sumPath}`);
}

/** Add or update a skill entry in the sumfile */
export function updateSumfileEntry(
  entries: Map<string, SumEntry>,
  skill: SkillPackage
): void {
  const source = skill.sourceUrl || skill.frontmatter.name;
  if (!skill.integrity) {
    entries.delete(source);
    return;
  }

  entries.set(source, {
    source,
    version: skill.frontmatter.version || '0.0.0',
    integrity: skill.integrity,
  });
}

export function mcpSumSource(source: string): string {
  return `mcp:${source}`;
}

export function updateMcpSumfileEntry(
  entries: Map<string, SumEntry>,
  source: string,
  config: McpRegistryEntry
): void {
  const sumSource = mcpSumSource(source);
  entries.set(sumSource, {
    source: sumSource,
    version: config.resolvedVersion || 'mcp',
    integrity: config.integrity || computeMcpConfigIntegrity(source, config),
  });
}

export function removeMcpSumfileEntry(
  entries: Map<string, SumEntry>,
  source: string
): void {
  entries.delete(mcpSumSource(source));
}

export function computeMcpConfigIntegrity(source: string, config: McpRegistryEntry): string {
  const type = config.type || (config.url ? 'http' : 'stdio');
  const portableConfig = {
    source,
    name: config.name,
    type,
    url: config.url || '',
    command: sanitizeMcpConfigValue(config.command),
    args: (config.args || []).map(sanitizeMcpConfigValue),
  };
  const hash = createHash('sha256').update(JSON.stringify(portableConfig)).digest('hex');
  return `sha256-${hash}`;
}

/** Verify integrity of an installed skill against sumfile */
export async function verifyIntegrity(
  source: string,
  skillPath: string,
  entries: Map<string, SumEntry>
): Promise<{ valid: boolean; expected?: string; actual?: string; reason?: 'missing-entry' | 'mismatch' }> {
  const entry = entries.get(source);
  if (!entry || !entry.integrity) {
    return {
      valid: false,
      expected: '<no entry in sumfile>',
      actual: '<unverified>',
      reason: 'missing-entry',
    };
  }

  const actual = await computeIntegrity(skillPath);
  return {
    valid: actual === entry.integrity,
    expected: entry.integrity,
    actual,
    reason: actual === entry.integrity ? undefined : 'mismatch',
  };
}

function sanitizeMcpConfigValue(value: string): string {
  if (!value) return value;
  return isAbsolute(value) ? `<absolute:${basename(value)}>` : value;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath));
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(tmpPath, 'w');
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmpPath, filePath);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
