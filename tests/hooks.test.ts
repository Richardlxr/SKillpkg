import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  platform: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
  execFile: mocks.execFile,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    platform: mocks.platform,
  };
});

describe('setup hooks', () => {
  let root: string;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(async () => {
    vi.resetModules();
    mocks.exec.mockReset();
    mocks.execFile.mockReset();
    mocks.platform.mockReset();
    mocks.platform.mockReturnValue('linux');
    mocks.exec.mockImplementation((_cmd: string, _options: unknown, callback: ExecCallback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      callback(null, { stdout: '', stderr: '' });
    });
    restorePlatform(platformDescriptor);
    root = await mkdtemp(join(tmpdir(), 'skm-hooks-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    restorePlatform(platformDescriptor);
  });

  it('runs Windows PowerShell setup hooks without shell command parsing', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mocks.platform.mockReturnValue('win32');
    await writeFile(join(root, 'setup.ps1'), 'Write-Output ok\n');
    const { runSetup } = await import('../src/core/hooks.js');

    await expect(runSetup(undefined, root, 'demo')).resolves.toBe(true);

    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'setup.ps1'],
      expect.objectContaining({ cwd: root, windowsHide: true }),
      expect.any(Function)
    );
  });

  it('runs Windows cmd and bat setup hooks through cmd.exe explicitly', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mocks.platform.mockReturnValue('win32');
    await writeFile(join(root, 'setup.cmd'), 'echo ok\r\n');
    const { runSetup } = await import('../src/core/hooks.js');

    await expect(runSetup(undefined, root, 'demo')).resolves.toBe(true);

    expect(mocks.execFile).toHaveBeenCalledWith(
      'cmd.exe',
      ['/d', '/s', '/c', 'setup.cmd'],
      expect.objectContaining({ cwd: root, windowsHide: true }),
      expect.any(Function)
    );
  });

  it('preflights Unix-only setup_command on Windows before invoking a shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mocks.platform.mockReturnValue('win32');
    const { runSetup } = await import('../src/core/hooks.js');

    await expect(runSetup('cp src dest', root, 'demo')).resolves.toBe(false);

    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('runs setup.sh through bash without shell command parsing', async () => {
    await writeFile(join(root, 'setup.sh'), 'echo ok\n');
    const { runSetup } = await import('../src/core/hooks.js');

    await expect(runSetup(undefined, root, 'demo')).resolves.toBe(true);

    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledWith(
      'bash',
      ['setup.sh'],
      expect.objectContaining({ cwd: root, windowsHide: true }),
      expect.any(Function)
    );
  });
});

type ExecCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

function restorePlatform(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(process, 'platform', descriptor);
  }
}
