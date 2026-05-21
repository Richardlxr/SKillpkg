import { describe, it, expect } from 'vitest';
import { cloneOrPull, getCommitSha, checkout } from '../src/utils/git.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('git utils', () => {
  it('should export git functions', () => {
    expect(cloneOrPull).toBeDefined();
    expect(getCommitSha).toBeDefined();
    expect(checkout).toBeDefined();
  });

  it('should fetch a missing tag before checkout after a shallow clone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skm-git-test-'));
    const sourceDir = join(root, 'source');
    const cacheDir = join(root, 'cache');

    try {
      await git(['init', sourceDir]);
      await git(['config', 'user.email', 'test@example.com'], sourceDir);
      await git(['config', 'user.name', 'Test User'], sourceDir);

      await writeFile(join(sourceDir, 'SKILL.md'), 'version 1\n');
      await git(['add', 'SKILL.md'], sourceDir);
      await git(['commit', '-m', 'version 1'], sourceDir);
      await git(['tag', 'v0.0.1'], sourceDir);

      await writeFile(join(sourceDir, 'SKILL.md'), 'version 2\n');
      await git(['commit', '-am', 'version 2'], sourceDir);

      const repoDir = await cloneOrPull(`file://${sourceDir}`, cacheDir);
      await checkout(repoDir, 'v0.0.1');

      const checkedOutCommit = await getCommitSha(repoDir);
      const taggedCommit = (await git(['rev-list', '-n', '1', 'v0.0.1'], sourceDir)).trim();
      expect(checkedOutCommit).toBe(taggedCommit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}
