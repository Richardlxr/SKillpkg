import { join } from 'node:path';
import type { GitPreference } from '../types/index.js';
import { getDataDir } from '../utils/platform.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

interface UserConfigFile {
  gitPreference?: GitPreference;
}

const GIT_PREFERENCES: GitPreference[] = ['auto', 'track', 'ask'];

export async function getGitPreference(): Promise<GitPreference> {
  const config = await readJsonFile<UserConfigFile>(configPath());
  return isGitPreference(config?.gitPreference) ? config.gitPreference : 'ask';
}

export async function setGitPreference(preference: GitPreference): Promise<void> {
  const existing = await readJsonFile<UserConfigFile>(configPath()) || {};
  await writeJsonFile(configPath(), {
    ...existing,
    gitPreference: preference,
  });
}

export async function configureGitPreference(preference?: string): Promise<void> {
  if (!preference) {
    logger.info(`Git tracking preference: ${await getGitPreference()}`);
    return;
  }

  if (!isGitPreference(preference)) {
    logger.error(`Invalid git preference: ${preference}`);
    logger.info('Use one of: auto, track, ask');
    return;
  }

  await setGitPreference(preference);
  logger.success(`Git tracking preference set to "${preference}"`);
}

function configPath(): string {
  return join(getDataDir(), 'config.json');
}

function isGitPreference(value: unknown): value is GitPreference {
  return typeof value === 'string' && GIT_PREFERENCES.includes(value as GitPreference);
}
