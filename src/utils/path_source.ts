import { isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** True when a source string points at a local filesystem path instead of a Git source. */
export function isLocalPathSource(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;

  if (isFileUrlSource(trimmed)) return true;
  if (trimmed === '.' || trimmed === '..') return true;
  if (trimmed.startsWith('./') || trimmed.startsWith('../')) return true;
  if (trimmed.startsWith('.\\') || trimmed.startsWith('..\\')) return true;

  return isAbsolute(trimmed) || win32.isAbsolute(trimmed);
}

/** Convert a local path or file URL source into a filesystem path. */
export function localPathFromSource(source: string): string {
  const trimmed = source.trim();
  if (!isFileUrlSource(trimmed)) return trimmed;

  try {
    return fileURLToPath(trimmed);
  } catch {
    return decodeURIComponent(trimmed.replace(/^file:\/\//i, ''));
  }
}

/** Resolve a local path source against a base directory when it is relative. */
export function resolveLocalPathSource(source: string, baseDir: string): string {
  const localPath = localPathFromSource(source);
  if (isAbsolute(localPath) || win32.isAbsolute(localPath)) {
    return localPath;
  }
  return resolve(baseDir, localPath);
}

/** Convert a filesystem path into a portable file URL for database records. */
export function fileUrlFromPath(filePath: string): string {
  return pathToFileURL(filePath).href;
}

function isFileUrlSource(source: string): boolean {
  return /^file:\/\//i.test(source);
}
