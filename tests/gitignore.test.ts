import { describe, expect, it } from 'vitest';
import {
  removeManagedBlock,
  SKILLPKG_LEGACY_GITIGNORE_PATHS,
  skillpkgGitignorePaths,
  upsertManagedBlock,
} from '../src/utils/gitignore.js';

describe('skillpkg gitignore management', () => {
  it('adds and replaces the managed block without disturbing user entries', () => {
    const first = upsertManagedBlock('node_modules/\n', skillpkgGitignorePaths(['demo']));

    expect(first).toContain('node_modules/');
    expect(first).toContain('# === skillpkg managed');
    expect(first).toContain('.agents/skills/demo');
    expect(first).not.toContain('.claude/skills/demo');
    expect(first).not.toContain('.cursor/skills/demo');
    expect(first.split('\n')).not.toContain('.agents/skills/');
    expect(first).not.toContain('.opencode');
    expect(first).not.toContain('.hermes');

    const second = upsertManagedBlock(first.replace('.agents/skills/demo', '.old/skills/demo'), skillpkgGitignorePaths(['demo']));

    expect(second).toContain('node_modules/');
    expect(second).toContain('.agents/skills/demo');
    expect(second).not.toContain('.old/skills/');
  });

  it('removes only the managed block', () => {
    const managed = upsertManagedBlock('dist/\n', ['.agents/skills/']);

    expect(removeManagedBlock(managed)).toBe('dist/\n');
  });

  it('removes the old unmarked project output block', () => {
    const legacy = [
      'node_modules/',
      '',
      '# Project-scoped skillpkg output',
      '.agents/skills/',
      '.claude/skills/',
      '.cursor/skills/',
      '.mcp.json',
      '.codex/config.toml',
      '.cursor/mcp.json',
      '.agents/mcp_config.json',
      '',
      '# Logs',
      '*.log',
      '',
    ].join('\n');

    expect(removeManagedBlock(legacy)).toBe([
      'node_modules/',
      '',
      '# Logs',
      '*.log',
      '',
    ].join('\n'));
  });

  it('replaces the old unmarked project output block with a managed block', () => {
    const legacy = [
      'dist/',
      '',
      '# Project-scoped skillpkg output',
      '.agents/skills/',
      '.claude/skills/',
      '.cursor/skills/',
      '.mcp.json',
      '.codex/config.toml',
      '.cursor/mcp.json',
      '.agents/mcp_config.json',
      '',
    ].join('\n');

    const next = upsertManagedBlock(legacy, skillpkgGitignorePaths(['demo']));

    expect(next).toContain('dist/');
    expect(next).toContain('# === skillpkg managed');
    expect(next).toContain('.agents/skills/demo');
    expect(next).not.toContain('# Project-scoped skillpkg output');
  });

  it('keeps compatibility with old whole-directory path constants for legacy cleanup', () => {
    expect(SKILLPKG_LEGACY_GITIGNORE_PATHS).toContain('.agents/skills/');
  });
});
