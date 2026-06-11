import { describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDir, directorySymlinkType } from '../src/utils/fs.js';

describe('filesystem helpers', () => {
  it('uses Windows junctions for directory links', () => {
    expect(directorySymlinkType('win32')).toBe('junction');
    expect(directorySymlinkType('darwin')).toBe('dir');
    expect(directorySymlinkType('linux')).toBe('dir');
  });

  it('preserves symlinks when copying directories by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skm-copy-symlink-'));
    try {
      const src = join(root, 'src');
      const dest = join(root, 'dest');
      await mkdir(src, { recursive: true });
      await writeFile(join(src, 'target.txt'), 'target');
      await symlink('target.txt', join(src, 'linked.txt'));

      await copyDir(src, dest);

      expect((await lstat(join(dest, 'linked.txt'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(dest, 'linked.txt'))).toBe('target.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
