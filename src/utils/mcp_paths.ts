import { isAbsolute, join, relative } from 'node:path';
import { pathExists } from './fs.js';
import { getDataDir, getHomeDir } from './platform.js';

export async function normalizeMcpArgs(args: string[] = []): Promise<string[]> {
  const normalized: string[] = [];
  for (const arg of args) {
    normalized.push(await normalizeSkillpkgDataPath(arg));
  }
  return normalized;
}

export async function normalizeSkillpkgDataPath(value: string): Promise<string> {
  if (!isAbsolute(value)) return value;
  if (await pathExists(value)) return value;

  const legacyBase = legacyMacosDataDir();
  const relativePath = relative(legacyBase, value);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return value;

  const migrated = join(getDataDir(), relativePath);
  return await pathExists(migrated) ? migrated : value;
}

function legacyMacosDataDir(): string {
  return join(getHomeDir(), 'Library', 'Application Support', 'skillpkg');
}

export function isLikelyLocalPath(value: string): boolean {
  return isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\');
}
