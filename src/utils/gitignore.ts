import { join } from 'node:path';
import { readFileOrNull, writeFileSafe } from './fs.js';

const START_MARKER = '# === skillpkg managed (auto-generated, do not edit manually) ===';
const END_MARKER = '# === end skillpkg managed ===';
const LEGACY_PROJECT_OUTPUT_HEADER = '# Project-scoped skillpkg output';

export const SKILLPKG_GITIGNORE_CONFIG_PATHS = [
  '.mcp.json',
  '.codex/config.toml',
  '.cursor/mcp.json',
  '.agents/mcp_config.json',
];

export const SKILLPKG_GITIGNORE_COMPATIBILITY_PATHS = [
  '.claude/skills',
  '.cursor/skills',
];

export const SKILLPKG_GITIGNORE_GENERATED_PATHS = [
  ...SKILLPKG_GITIGNORE_CONFIG_PATHS,
  ...SKILLPKG_GITIGNORE_COMPATIBILITY_PATHS,
];

export const SKILLPKG_LEGACY_GITIGNORE_PATHS = [
  '.agents/skills/',
  '.claude/skills/',
  '.cursor/skills/',
  ...SKILLPKG_GITIGNORE_GENERATED_PATHS,
];

export function skillpkgGitignorePaths(skillNames: string[]): string[] {
  const skillPaths = skillNames.map((skillName) => `.agents/skills/${skillName}`);

  return [
    ...skillPaths,
    ...SKILLPKG_GITIGNORE_GENERATED_PATHS,
  ];
}

export async function ensureSkillpkgGitignore(
  cwd: string = process.cwd(),
  paths: string[] = SKILLPKG_GITIGNORE_GENERATED_PATHS
): Promise<void> {
  const gitignorePath = join(cwd, '.gitignore');
  const existing = await readFileOrNull(gitignorePath) || '';
  await writeFileSafe(gitignorePath, upsertManagedBlock(existing, paths));
}

export async function clearSkillpkgGitignore(cwd: string = process.cwd()): Promise<void> {
  const gitignorePath = join(cwd, '.gitignore');
  const existing = await readFileOrNull(gitignorePath);
  if (existing === null) return;
  await writeFileSafe(gitignorePath, removeManagedBlock(existing));
}

export async function hasSkillpkgGitignore(cwd: string = process.cwd()): Promise<boolean> {
  const gitignorePath = join(cwd, '.gitignore');
  const existing = await readFileOrNull(gitignorePath);
  return existing !== null && (
    (existing.includes(START_MARKER) && existing.includes(END_MARKER))
    || existing.includes(LEGACY_PROJECT_OUTPUT_HEADER)
  );
}

export function upsertManagedBlock(content: string, paths: string[]): string {
  const withoutBlock = removeManagedBlock(content).trimEnd();
  const block = [
    START_MARKER,
    ...Array.from(new Set(paths)).sort(),
    END_MARKER,
  ].join('\n');

  return `${withoutBlock}${withoutBlock ? '\n\n' : ''}${block}\n`;
}

export function removeManagedBlock(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  const legacyPaths = new Set(SKILLPKG_LEGACY_GITIGNORE_PATHS);
  let skipping = false;
  let skippingLegacy = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === START_MARKER) {
      skipping = true;
      continue;
    }

    if (skipping && trimmed === END_MARKER) {
      skipping = false;
      continue;
    }

    if (skipping) {
      continue;
    }

    if (trimmed === LEGACY_PROJECT_OUTPUT_HEADER) {
      skippingLegacy = true;
      continue;
    }

    if (skippingLegacy) {
      if (!trimmed || legacyPaths.has(trimmed)) {
        continue;
      }
      skippingLegacy = false;
    }

    result.push(line);
  }

  return result.join('\n').trimEnd() + (result.some((line) => line.trim()) ? '\n' : '');
}
