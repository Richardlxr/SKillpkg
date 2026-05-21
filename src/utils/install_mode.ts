import type { InstallMode, InstallScope } from '../types/index.js';

const INSTALL_MODES: InstallMode[] = ['copy', 'symlink-cache', 'symlink-dev'];

export function isInstallMode(value: unknown): value is InstallMode {
  return typeof value === 'string' && INSTALL_MODES.includes(value as InstallMode);
}

export function defaultInstallModeForScope(scope: InstallScope): InstallMode {
  return scope === 'project' ? 'symlink-cache' : 'copy';
}

export function installModeFromRecord(row: Record<string, unknown>): InstallMode {
  const installMode = row['install_mode'];
  if (isInstallMode(installMode)) return installMode;

  const sourceUrl = String(row['source_url'] || '');
  if (row['is_linked'] && sourceUrl.startsWith('file://')) return 'symlink-dev';
  if (row['is_linked']) return 'symlink-cache';
  return 'copy';
}

export function isSymlinkInstallMode(mode: InstallMode): boolean {
  return mode === 'symlink-cache' || mode === 'symlink-dev';
}

export function isDevInstallMode(mode: InstallMode): boolean {
  return mode === 'symlink-dev';
}

export function legacyIsLinkedValue(mode: InstallMode): number {
  return isSymlinkInstallMode(mode) ? 1 : 0;
}

export function formatInstallMode(mode: InstallMode): string {
  switch (mode) {
    case 'copy':
      return 'copy';
    case 'symlink-cache':
      return 'cache link';
    case 'symlink-dev':
      return 'dev link';
  }
}
