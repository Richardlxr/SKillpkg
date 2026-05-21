/**
 * Git operations wrapper using simple-git
 */
import { simpleGit, type SimpleGit } from 'simple-git';
import { join } from 'node:path';
import { ensureDir, pathExists } from './fs.js';
import { logger } from './logger.js';

/** Clone a repository or pull if already cached */
export async function cloneOrPull(repoUrl: string, cacheDir: string): Promise<string> {
  // Normalize URL to a local path
  const repoPath = repoUrlToLocalPath(repoUrl);
  const localDir = join(cacheDir, repoPath);

  if (await pathExists(join(localDir, '.git'))) {
    logger.debug(`Cache hit: ${repoUrl} → ${localDir}`);
    const git: SimpleGit = simpleGit(localDir);
    try {
      await git.pull();
      logger.debug(`Pulled latest for ${repoUrl}`);
    } catch (err) {
      logger.warn(`Failed to pull ${repoUrl}, using cached version`);
    }
  } else {
    logger.debug(`Cloning ${repoUrl} → ${localDir}`);
    await ensureDir(localDir);
    const git: SimpleGit = simpleGit();
    
    // Retry logic for cloning
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      try {
        await git.clone(repoUrl, localDir, ['--depth', '1']);
        break; // Success
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error(`Failed to clone ${repoUrl} after ${maxAttempts} attempts: ${(err as Error).message}`);
        }
        logger.warn(`Clone failed (attempt ${attempts}/${maxAttempts}), retrying in ${attempts * 2}s...`);
        await new Promise(resolve => setTimeout(resolve, attempts * 2000));
      }
    }
  }

  return localDir;
}

/** Get the current commit SHA of a local repo */
export async function getCommitSha(repoDir: string): Promise<string> {
  const git: SimpleGit = simpleGit(repoDir);
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || 'unknown';
}

/** Checkout a specific tag, branch, or commit */
export async function checkout(repoDir: string, ref: string): Promise<void> {
  const git: SimpleGit = simpleGit(repoDir);
  try {
    await git.checkout(ref);
    return;
  } catch (initialError) {
    try {
      await git.raw(['fetch', '--tags', '--force']);
      await git.checkout(ref);
      return;
    } catch {
      // Continue with a targeted fetch below.
    }

    try {
      await git.raw(['fetch', '--depth', '1', 'origin', ref]);
      await git.checkout(['--detach', 'FETCH_HEAD']);
      return;
    } catch {
      throw initialError;
    }
  }
}

/** Convert a repo URL to a safe local directory name */
function repoUrlToLocalPath(url: string): string {
  // https://github.com/owner/repo.git → github.com/owner/repo
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9\/._-]/g, '_');
}
