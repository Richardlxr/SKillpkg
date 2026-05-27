import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AGENT_PATHS, getCodexHomeDir, getHomeDir, unifiedProjectSkillsDir } from '../src/utils/platform.js';
import {
  fileUrlFromPath,
  isLocalPathSource,
  localPathFromSource,
  projectRelativeSourceFromPath,
  resolveLocalPathSource,
} from '../src/utils/path_source.js';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('platform paths', () => {
  const oldEnv = snapshotEnv(['SKILLPKG_HOME_DIR', 'CODEX_HOME', 'HOME', 'USERPROFILE', 'APPDATA']);

  afterEach(() => {
    restoreEnv(oldEnv);
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('prefers USERPROFILE over HOME on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['SKILLPKG_HOME_DIR'];
    process.env['HOME'] = '/c/Users/Alice';
    process.env['USERPROFILE'] = 'C:\\Users\\Alice';

    expect(getHomeDir()).toBe('C:\\Users\\Alice');
  });

  it('matches official agent skill and MCP locations', () => {
    process.env['SKILLPKG_HOME_DIR'] = '/Users/alice';
    delete process.env['CODEX_HOME'];
    const cwd = '/work/project';

    expect(unifiedProjectSkillsDir(cwd)).toBe(join(cwd, '.agents', 'skills'));
    expect(AGENT_PATHS['antigravity-cli'].global()).toBe(join('/Users/alice', '.gemini', 'antigravity-cli', 'skills'));
    expect(AGENT_PATHS['antigravity-cli'].project(cwd)).toBe(join(cwd, '.agents', 'skills'));
    expect(AGENT_PATHS['antigravity-cli'].mcpConfig('project', cwd)).toBe(join(cwd, '.agents', 'mcp_config.json'));
    expect(AGENT_PATHS['claude-code'].project(cwd)).toBe(join(cwd, '.agents', 'skills'));
    expect(AGENT_PATHS['claude-code'].symlinkDir(cwd)).toBe(join(cwd, '.claude', 'skills'));
    expect(getCodexHomeDir()).toBe(join('/Users/alice', '.codex'));
    expect(AGENT_PATHS.codex.global()).toBe(join('/Users/alice', '.codex', 'skills'));
    expect(AGENT_PATHS.codex.legacyGlobal()).toBe(join('/Users/alice', '.agents', 'skills'));
    expect(AGENT_PATHS.codex.project(cwd)).toBe(join(cwd, '.agents', 'skills'));
    expect(AGENT_PATHS.cursor.project(cwd)).toBe(join(cwd, '.agents', 'skills'));
    expect(AGENT_PATHS.cursor.symlinkDir(cwd)).toBe(join(cwd, '.cursor', 'skills'));
  });

  it('honors CODEX_HOME for Codex global skills and config', () => {
    process.env['SKILLPKG_HOME_DIR'] = '/Users/alice';
    process.env['CODEX_HOME'] = '/custom/codex-home';

    expect(getCodexHomeDir()).toBe('/custom/codex-home');
    expect(AGENT_PATHS.codex.global()).toBe(join('/custom/codex-home', 'skills'));
    expect(AGENT_PATHS.codex.mcpConfig('global')).toBe(join('/custom/codex-home', 'config.toml'));
  });
});

describe('local path sources', () => {
  it('recognizes Windows, POSIX, relative, and file URL path sources', () => {
    expect(isLocalPathSource('/tmp/skill')).toBe(true);
    expect(isLocalPathSource('C:\\Users\\Alice\\skill')).toBe(true);
    expect(isLocalPathSource('C:/Users/Alice/skill')).toBe(true);
    expect(isLocalPathSource('\\\\server\\share\\skill')).toBe(true);
    expect(isLocalPathSource('.\\skill')).toBe(true);
    expect(isLocalPathSource('file:///tmp/skill')).toBe(true);
  });

  it('does not mistake Git shorthand or SSH sources for local Windows paths', () => {
    expect(isLocalPathSource('github:owner/repo')).toBe(false);
    expect(isLocalPathSource('git@github.com:owner/repo.git')).toBe(false);
    expect(isLocalPathSource('owner/repo')).toBe(false);
  });

  it('round-trips POSIX paths through file URLs with escaping', () => {
    const url = fileUrlFromPath('/tmp/dev skill');

    expect(url).toBe('file:///tmp/dev%20skill');
    expect(localPathFromSource(url)).toBe('/tmp/dev skill');
  });

  it('keeps Windows absolute replacement paths absolute on non-Windows hosts', () => {
    expect(resolveLocalPathSource('C:\\Users\\Alice\\skill', '/project')).toBe('C:\\Users\\Alice\\skill');
  });

  it('formats project-local paths as portable relative sources', () => {
    expect(projectRelativeSourceFromPath('/project/.agents/skills/demo', '/project')).toBe('./.agents/skills/demo');
    expect(projectRelativeSourceFromPath('/outside/demo', '/project')).toBe(null);
    expect(projectRelativeSourceFromPath('/project', '/project')).toBe('.');
  });
});

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
