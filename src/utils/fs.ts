/**
 * File system helpers for cross-platform operations
 */
import { mkdir, readFile, writeFile, rm, access, readdir, stat, cp, symlink, lstat, readlink } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { constants } from 'node:fs';

/** Ensure a directory exists (recursive) */
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/** Check if a path exists */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Check if a path itself exists without following symlinks. */
export async function pathExistsNoFollow(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Check if a path is a symbolic link. */
export async function isSymbolicLink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Check if path is a directory */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Read a file as text, return null if not found */
export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Write text to a file, creating parent directories as needed */
export async function writeFileSafe(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, content, 'utf-8');
}

/** Read and parse a JSON file */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  const content = await readFileOrNull(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** Write JSON to a file with formatting */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeFileSafe(filePath, JSON.stringify(data, null, 2) + '\n');
}

/** Remove a file or directory recursively */
export async function removePath(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch {
    // Ignore errors
  }
}

/** Copy directory recursively */
export async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dirname(dest));
  await cp(src, dest, { recursive: true, force: true });
}

/** Create a symlink (falls back to copy on systems that disallow symlinks) */
export async function createSymlinkOrCopy(target: string, linkPath: string): Promise<boolean> {
  await ensureDir(dirname(linkPath));
  if (!(await pathExists(target))) {
    throw new Error(`Source path does not exist: ${target}`);
  }

  try {
    await symlink(target, linkPath, 'dir');
    return true;
  } catch {
    // Fallback to copy on systems that don't support symlinks
    await copyDir(target, linkPath);
    return false;
  }
}

export type EnsureSymlinkResult = 'created' | 'exists' | 'blocked';

/** Ensure linkPath is a directory symlink to target. Existing real directories are left untouched. */
export async function ensureDirectorySymlink(linkPath: string, target: string): Promise<EnsureSymlinkResult> {
  await ensureDir(target);

  if (await pathExistsNoFollow(linkPath)) {
    if (!(await isSymbolicLink(linkPath))) {
      return 'blocked';
    }

    const currentTarget = await readlink(linkPath);
    const resolvedCurrent = resolve(dirname(linkPath), currentTarget);
    if (resolvedCurrent === resolve(target)) {
      return 'exists';
    }

    return 'blocked';
  }

  await ensureDir(dirname(linkPath));
  const relativeTarget = relative(dirname(linkPath), target) || '.';
  await symlink(relativeTarget, linkPath, 'dir');
  return 'created';
}

/** List subdirectories in a directory */
export async function listSubdirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Recursively find files matching a name up to a max depth */
export async function findFiles(dir: string, filename: string, maxDepth: number = 3): Promise<string[]> {
  const results: string[] = [];
  
  async function search(currentDir: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip hidden folders like .git
        if (entry.name.startsWith('.') && entry.isDirectory()) continue;
        
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await search(fullPath, depth + 1);
        } else if (entry.name === filename) {
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore permission or access errors
    }
  }

  await search(dir, 1);
  return results;
}
