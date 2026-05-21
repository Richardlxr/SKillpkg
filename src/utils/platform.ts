/**
 * Cross-platform path and environment utilities
 */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { PlatformType, GlobalConfig, InstallScope } from '../types/index.js';
import { pathExists } from './fs.js';

/** Get current platform */
export function getCurrentPlatform(): PlatformType {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

/** Get user home directory */
export function getHomeDir(): string {
  if (process.env['SKILLPKG_HOME_DIR']) {
    return process.env['SKILLPKG_HOME_DIR'];
  }
  if (getCurrentPlatform() === 'windows' && process.env['USERPROFILE']) {
    return process.env['USERPROFILE'];
  }
  if (process.env['HOME']) {
    return process.env['HOME'];
  }
  if (process.env['USERPROFILE']) {
    return process.env['USERPROFILE'];
  }
  return homedir();
}

/** Get skillpkg data directory */
export function getDataDir(): string {
  // Allow override via environment variable
  if (process.env['SKILLPKG_DATA_DIR']) {
    return process.env['SKILLPKG_DATA_DIR'];
  }

  const home = getHomeDir();
  return join(home, '.skillpkg');
}

/** Get default global config */
export function getDefaultConfig(): GlobalConfig {
  const dataDir = getDataDir();
  return {
    defaultScope: 'global',
    defaultAgent: 'all',
    gitPreference: 'ask',
    cacheDir: join(dataDir, 'cache'),
    storeDir: join(dataDir, 'store'),
    dbPath: join(dataDir, 'skills.db'),
    sumfilePath: join(dataDir, 'skm.sum'),
  };
}

/** Choose the least-surprising install scope for commands without --scope. */
export async function defaultInstallScopeForCwd(cwd: string = process.cwd()): Promise<InstallScope> {
  if (await pathExists(join(cwd, 'skm.mod')) || await pathExists(join(cwd, '.git'))) {
    return 'project';
  }

  return getDefaultConfig().defaultScope;
}

/** Shared project skill directory for agents that support the open skills layout. */
export function unifiedProjectSkillsDir(cwd: string = process.cwd()): string {
  return join(cwd, '.agents', 'skills');
}

/** Agent-specific paths */
export const AGENT_PATHS = {
  antigravity: {
    global: () => join(getHomeDir(), '.gemini', 'antigravity', 'skills'),
    project: unifiedProjectSkillsDir,
    mcpConfig: () => join(getHomeDir(), '.gemini', 'antigravity', 'mcp_config.json'),
  },
  'antigravity-cli': {
    global: () => join(getHomeDir(), '.gemini', 'antigravity-cli', 'skills'),
    project: unifiedProjectSkillsDir,
    mcpConfig: (scope: InstallScope = 'global', cwd: string = process.cwd()) =>
      scope === 'project'
        ? join(cwd, '.agents', 'mcp_config.json')
        : join(getHomeDir(), '.gemini', 'antigravity-cli', 'mcp_config.json'),
    settingsConfig: () => join(getHomeDir(), '.gemini', 'antigravity-cli', 'settings.json'),
  },
  'claude-code': {
    global: () => join(getHomeDir(), '.claude', 'skills'),
    project: unifiedProjectSkillsDir,
    symlinkDir: (cwd: string) => join(cwd, '.claude', 'skills'),
    mcpConfig: (scope: InstallScope = 'global', cwd: string = process.cwd()) =>
      scope === 'project' ? join(cwd, '.mcp.json') : join(getHomeDir(), '.claude.json'),
  },
  codex: {
    global: () => join(getHomeDir(), '.agents', 'skills'),
    project: unifiedProjectSkillsDir,
    mcpConfig: (scope: InstallScope = 'global', cwd: string = process.cwd()) =>
      scope === 'project' ? join(cwd, '.codex', 'config.toml') : join(getHomeDir(), '.codex', 'config.toml'),
    legacyMcpConfig: (cwd: string = process.cwd()) => join(cwd, '.mcp.json'),
  },
  cursor: {
    global: () => join(getHomeDir(), '.cursor', 'skills'),
    project: unifiedProjectSkillsDir,
    symlinkDir: (cwd: string) => join(cwd, '.cursor', 'skills'),
    mcpConfig: (scope: InstallScope = 'global', cwd: string = process.cwd()) =>
      scope === 'project' ? join(cwd, '.cursor', 'mcp.json') : join(getHomeDir(), '.cursor', 'mcp.json'),
  },
} as const;
