import inquirer from 'inquirer';
import { getGitPreference } from './git_config.js';
import { getDb } from '../db/index.js';
import { unifiedProjectSkillsDir } from '../utils/platform.js';
import {
  ensureSkillpkgGitignore,
  hasSkillpkgGitignore,
  SKILLPKG_GITIGNORE_GENERATED_PATHS,
  skillpkgGitignorePaths,
} from '../utils/gitignore.js';
import { logger } from '../utils/logger.js';

type GitTrackingChoice = 'ignore' | 'track' | 'later';

const promptedProjects = new Set<string>();

export async function handleProjectGitTracking(
  options: { cwd?: string; yes?: boolean; refreshExisting?: boolean } = {}
): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const preference = await getGitPreference();

  if (preference === 'auto') {
    await ensureSkillpkgGitignore(cwd, await projectGitignorePaths(cwd));
    logger.info('Updated .gitignore for local project skills and MCP config.');
    return;
  }

  if (preference === 'track') {
    await ensureSkillpkgGitignore(cwd, SKILLPKG_GITIGNORE_GENERATED_PATHS);
    logger.info('Project skills are left trackable by git; project MCP config stays gitignored.');
    return;
  }

  if (options.yes) {
    await ensureSkillpkgGitignore(cwd, await projectGitignorePaths(cwd));
    logger.info('Updated .gitignore for local project skills and MCP config.');
    return;
  }

  if (options.refreshExisting) {
    if (await hasSkillpkgGitignore(cwd)) {
      await ensureSkillpkgGitignore(cwd, await projectGitignorePaths(cwd));
      logger.info('Updated .gitignore for local project skills and MCP config.');
    }
    return;
  }

  if (promptedProjects.has(cwd) || !process.stdin.isTTY || !process.stdout.isTTY) {
    return;
  }

  promptedProjects.add(cwd);
  const { choice } = await inquirer.prompt<{ choice: GitTrackingChoice }>([{
    type: 'list',
    name: 'choice',
    message: 'Git tracking for installed project skills:',
    choices: [
      { name: 'Gitignore installed project skill paths and project MCP config (recommended for local-only skills)', value: 'ignore' },
      { name: 'Track project skills in git (for team sharing)', value: 'track' },
      { name: 'Decide later', value: 'later' },
    ],
  }]);

  if (choice === 'ignore') {
    await ensureSkillpkgGitignore(cwd, await projectGitignorePaths(cwd));
    logger.info('Updated .gitignore for local project skills and MCP config.');
  } else if (choice === 'track') {
    await ensureSkillpkgGitignore(cwd, SKILLPKG_GITIGNORE_GENERATED_PATHS);
    logger.info('Project skills are left trackable by git; project MCP config stays gitignored.');
  }
}

async function projectGitignorePaths(cwd: string): Promise<string[]> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT name, source_url, installed_path FROM skills WHERE scope = 'project' AND project_path = ? ORDER BY name")
    .all(cwd) as { name: string; source_url: string; installed_path: string }[];

  return [
    ...skillpkgGitignorePaths(
      rows
        .filter((row) => !isProjectLocalSkillSource(row, cwd))
        .map((row) => row.name)
    ),
  ];
}

function isProjectLocalSkillSource(
  row: { source_url: string; installed_path: string },
  cwd: string
): boolean {
  const source = row.source_url.replace(/\\/g, '/');
  if (source.startsWith('./.agents/skills/') || source.startsWith('.agents/skills/')) {
    return true;
  }

  const unifiedDir = unifiedProjectSkillsDir(cwd).replace(/\\/g, '/');
  const installedPath = row.installed_path.replace(/\\/g, '/');
  return installedPath.startsWith(`${unifiedDir}/`);
}
