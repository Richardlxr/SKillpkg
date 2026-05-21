import { describe, expect, it } from 'vitest';
import {
  defaultInstallModeForScope,
  formatInstallMode,
  installModeFromRecord,
  isDevInstallMode,
  isSymlinkInstallMode,
  legacyIsLinkedValue,
} from '../src/utils/install_mode.js';

describe('install mode helpers', () => {
  it('keeps scope defaults separate from explicit install mode', () => {
    expect(defaultInstallModeForScope('global')).toBe('copy');
    expect(defaultInstallModeForScope('project')).toBe('symlink-cache');
  });

  it('infers old records from is_linked and source_url', () => {
    expect(installModeFromRecord({ is_linked: 0, source_url: 'https://example.com/repo.git' })).toBe('copy');
    expect(installModeFromRecord({ is_linked: 1, source_url: 'https://example.com/repo.git' })).toBe('symlink-cache');
    expect(installModeFromRecord({ is_linked: 1, source_url: 'file:///tmp/dev-skill' })).toBe('symlink-dev');
  });

  it('prefers explicit install_mode over legacy fields', () => {
    expect(installModeFromRecord({ install_mode: 'copy', is_linked: 1, source_url: 'file:///tmp/dev-skill' })).toBe('copy');
  });

  it('classifies mode behavior', () => {
    expect(isSymlinkInstallMode('copy')).toBe(false);
    expect(isSymlinkInstallMode('symlink-cache')).toBe(true);
    expect(isSymlinkInstallMode('symlink-dev')).toBe(true);
    expect(isDevInstallMode('symlink-dev')).toBe(true);
    expect(legacyIsLinkedValue('copy')).toBe(0);
    expect(legacyIsLinkedValue('symlink-cache')).toBe(1);
  });

  it('formats modes for CLI output', () => {
    expect(formatInstallMode('copy')).toBe('copy');
    expect(formatInstallMode('symlink-cache')).toBe('cache link');
    expect(formatInstallMode('symlink-dev')).toBe('dev link');
  });
});
