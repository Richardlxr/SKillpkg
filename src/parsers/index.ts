/**
 * SKILL.md parsers
 *
 * Parsing strategy:
 *   1. SKILL.md — single source of truth for metadata (name, description, dependencies, mcp, setup_command)
 *   2. Source string — owner/repo[@version][/path] resolution
 */
import matter from 'gray-matter';
import { join } from 'node:path';
import { readFileOrNull } from '../utils/fs.js';
import type {
  SkillFrontmatter
} from '../types/index.js';

/** Parse SKILL.md frontmatter from a skill directory */
export async function parseSkillMd(skillDir: string): Promise<SkillFrontmatter | null> {
  const content = await readFileOrNull(join(skillDir, 'SKILL.md'));
  if (!content) return null;

  try {
    const { data } = matter(content);
    return {
      name: data.name || '',
      description: data.description || '',
      version: data.version,
      license: data.license,
      compatibility: data.compatibility,
      metadata: data.metadata,
      'allowed-tools': data['allowed-tools'],
      dependencies: normalizeStringArray(data.dependencies),
      mcp: normalizeStringArray(data.mcp),
      setup_command: data.setup_command
    };
  } catch {
    return null;
  }
}

/** Extract the body content (instructions) from SKILL.md, stripping frontmatter */
export async function parseSkillMdBody(skillDir: string): Promise<string | null> {
  const content = await readFileOrNull(join(skillDir, 'SKILL.md'));
  if (!content) return null;

  try {
    const { content: body } = matter(content);
    return body.trim() || null;
  } catch {
    return null;
  }
}



/** Normalize unknown data to a string array */
function normalizeStringArray(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data.filter((s): s is string => typeof s === 'string');
}

/** Normalize unknown data to a string record */
function normalizeStringRecord(data: unknown): Record<string, string> {
  if (!data || typeof data !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    result[k] = String(v);
  }
  return result;
}

/**
 * Parse a source string into structured components.
 *
 * Supported formats:
 *   "owner/repo"               → { repoUrl: "https://github.com/owner/repo" }
 *   "owner/repo/sub/path"      → { repoUrl: ..., skillPath: "sub/path" }
 *   "owner/repo@v1.0.0"        → { repoUrl: ..., version: "v1.0.0" }
 *   "github.com/owner/repo"    → { repoUrl: "https://github.com/owner/repo" }
 *   "https://github.com/..."   → { repoUrl: full URL }
 *   "git@host:owner/repo.git"  → { repoUrl: full SSH URL }
 *   "https://...@v1.0.0"       → { repoUrl: ..., version: "v1.0.0" }
 *   "https://...#v1.0.0"       → { repoUrl: ..., version: "v1.0.0" }
 */
export function parseSourceString(source: string): {
  repoUrl: string;
  skillPath?: string;
  version?: string;
} {
  source = source.trim();

  // Handle fragments: source#sub/path, plus common git URL source#v1.0.0 refs.
  let skillPath: string | undefined;
  let version: string | undefined;
  const hashIdx = source.indexOf('#');
  if (hashIdx > 0) {
    const fragment = source.substring(hashIdx + 1);
    source = source.substring(0, hashIdx);

    const fragmentWithVersion = splitTrailingVersion(fragment);
    if (looksLikeVersionRef(fragment)) {
      version = fragment;
    } else if (fragmentWithVersion.version) {
      skillPath = fragmentWithVersion.source;
      version = fragmentWithVersion.version;
    } else {
      skillPath = fragment;
    }
  }

  // Handle version pinning: source@v1.0.0
  const sourceWithVersion = splitTrailingVersion(source);
  if (sourceWithVersion.version) {
    source = sourceWithVersion.source;
    version = version || sourceWithVersion.version;
  }

  if (source.startsWith('github:')) {
    return { repoUrl: `https://github.com/${source.substring('github:'.length)}`, skillPath, version };
  }

  // Full URL
  if (isFullUrl(source) || isScpLikeGitUrl(source)) {
    return { repoUrl: source, skillPath, version };
  }

  if (isHostQualifiedPath(source)) {
    return { repoUrl: `https://${source}`, skillPath, version };
  }

  // owner/repo or owner/repo/skill-path format
  const parts = source.split('/');
  if (parts.length >= 2) {
    const repoUrl = `https://github.com/${parts[0]}/${parts[1]}`;
    if (!skillPath && parts.length > 2) {
      skillPath = parts.slice(2).join('/');
    }
    return { repoUrl, skillPath, version };
  }

  // Assume it's just a repo name under a default org
  return { repoUrl: `https://github.com/${source}`, skillPath, version };
}

export function formatSourceForDisplay(source: string): string {
  const withoutProtocol = source.replace(/^https?:\/\//i, '');
  return withoutProtocol.startsWith('github.com/')
    ? withoutProtocol.substring('github.com/'.length)
    : withoutProtocol;
}

function splitTrailingVersion(source: string): { source: string; version?: string } {
  const atIdx = source.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === source.length - 1) {
    return { source };
  }

  const candidate = source.substring(atIdx + 1);
  if (!candidate || candidate.includes('/') || /\s/.test(candidate)) {
    return { source };
  }

  const prefix = source.substring(0, atIdx);
  const lastPathSeparator = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf(':'));
  if (atIdx <= lastPathSeparator) {
    return { source };
  }

  return { source: prefix, version: candidate };
}

function looksLikeVersionRef(fragment: string): boolean {
  return /^(?:v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?|[0-9a-f]{7,40})$/i.test(fragment);
}

function isFullUrl(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

function isScpLikeGitUrl(source: string): boolean {
  return /^(?:[^@\s/:]+@)?[^:\s]+:.+/.test(source) && !isFullUrl(source);
}

function isHostQualifiedPath(source: string): boolean {
  const [host] = source.split('/');
  return source.includes('/') && Boolean(host) && (host.includes('.') || host === 'localhost');
}
