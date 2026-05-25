import { basename, join } from 'node:path';
import { parseModFile, generateModFile } from '../parsers/mod.js';
import { pathExists, readFileOrNull, writeFileSafe } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

export interface SaveSkillRequirementOptions {
  cwd?: string;
  save?: boolean;
  yes?: boolean;
  allowCreate?: boolean;
}

export async function saveSkillRequirement(
  source: string,
  version?: string,
  options: SaveSkillRequirementOptions = {}
): Promise<void> {
  if (options.save === false) return;

  const cwd = options.cwd || process.cwd();
  const modPath = join(cwd, 'skm.mod');
  const exists = await pathExists(modPath);

  if (!exists && !(await shouldCreateModFile(cwd, options))) {
    return;
  }

  const content = exists
    ? await readFileOrNull(modPath)
    : `module ${basename(cwd) || 'project'}\n`;
  const mod = parseModFile(content || '');
  if (!mod.module) {
    mod.module = basename(cwd) || 'project';
  }

  const existing = mod.skills.find((skill) => skill.source === source);
  if (existing) {
    existing.version = version;
  } else {
    mod.skills.push({ source, version });
  }

  await writeFileSafe(modPath, generateModFile(mod));
  logger.info(`Saved project dependency to skm.mod: ${source}${version ? ` ${version}` : ''}`);
}

export async function removeSkillRequirement(source: string, cwd: string = process.cwd()): Promise<void> {
  const modPath = join(cwd, 'skm.mod');
  const content = await readFileOrNull(modPath);
  if (!content) return;

  const mod = parseModFile(content);
  const before = mod.skills.length;
  mod.skills = mod.skills.filter((skill) => skill.source !== source);
  mod.requires = mod.skills;

  if (mod.skills.length === before) return;

  await writeFileSafe(modPath, generateModFile(mod));
  logger.info(`Removed project dependency from skm.mod: ${source}`);
}

async function shouldCreateModFile(_cwd: string, options: SaveSkillRequirementOptions): Promise<boolean> {
  return options.allowCreate === true && options.save !== false;
}
