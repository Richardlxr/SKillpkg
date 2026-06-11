/**
 * Extended commands — inspired by npm/conda/Go
 *
 * - outdated  (npm outdated)
 * - tree      (npm ls / go mod graph)
 * - link      (npm link)
 * - tidy      (go mod tidy)
 * - init      (npm init / go mod init)
 * - verify    (go mod verify)
 */
import { join, resolve } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import chalk from 'chalk';
import ora from 'ora';
import type {
  DepTreeNode,
  OutdatedInfo,
  AgentType,
  InstallScope,
  SkillPackage,
  InstallMode,
} from '../types/index.js';
import { getDb, genId } from '../db/index.js';
import { formatSourceForDisplay, parseSkillMd } from '../parsers/index.js';
import { getCommitSha, cloneOrPull } from '../utils/git.js';
import { AGENT_PATHS, getDefaultConfig, unifiedProjectSkillsDir } from '../utils/platform.js';
import {
  pathExists,
  writeFileSafe,
  removePath,
  ensureDir,
  copyDir,
  ensureDirectorySymlink,
  isSymbolicLink,
  listSubdirs,
  pathExistsNoFollow,
  readFileOrNull,
} from '../utils/fs.js';
import { fileUrlFromPath, isLocalPathSource, projectRelativeSourceFromPath, resolveLocalPathSource } from '../utils/path_source.js';
import { resolveAdapters } from '../adapters/index.js';
import {
  loadSumfile,
  saveSumfile,
  computeIntegrity,
  computeMcpConfigIntegrity,
  mcpSumSource,
  updateSumfileEntry,
  verifyIntegrity,
} from './sumfile.js';
import { logger } from '../utils/logger.js';
import {
  formatInstallMode,
  installModeFromRecord,
  isDevInstallMode,
  isSymlinkInstallMode,
  legacyIsLinkedValue,
} from '../utils/install_mode.js';

// ─────────────────────────────────────────────────────────────
// skm init — npm init / go mod init
// ─────────────────────────────────────────────────────────────

/** Initialize a new project manifest and, when needed, a root SKILL.md. */
export async function initManifest(
  name?: string,
  interactive: boolean = false
): Promise<void> {
  const cwd = process.cwd();
  const mdPath = join(cwd, 'SKILL.md');
  const projectSkillSources = await discoverProjectSkillSources(cwd);
  const localSkillSources = projectSkillSources
    .filter((source) => source.kind === 'local')
    .map((source) => source.source);
  const hasRootSkill = await pathExists(mdPath);
  const rootFrontmatter = hasRootSkill ? await parseSkillMd(cwd) : null;
  const shouldCreateRootSkill = !hasRootSkill && projectSkillSources.length === 0;
  const shouldSaveRootSkill = projectSkillSources.length === 0 && (hasRootSkill || shouldCreateRootSkill);
  const skillName = name || rootFrontmatter?.name || 'my-skill';
  const moduleName = name || (projectSkillSources.length > 0 ? projectModuleName(cwd) : skillName);

  if (shouldCreateRootSkill) {
    const description = 'A new agent skill';
    const content = `---
name: ${skillName}
version: "0.1.0"
description: "${description}"
# dependencies: []
# mcp: []
# setup_command: ""
---

# ${skillName}

${description}
`;

    await writeFileSafe(mdPath, content);
    logger.success(`Created ${mdPath}`);
  } else if (hasRootSkill) {
    logger.warn('SKILL.md already exists in this directory');
  }
  
  const modPath = join(cwd, 'skm.mod');
  if (!(await pathExists(modPath))) {
    await writeFileSafe(modPath, `module ${moduleName}\n\n`);
    logger.success(`Created ${modPath}`);
  }

  const { saveSkillRequirement } = await import('./modfile.js');
  if (shouldSaveRootSkill) {
    await saveSkillRequirement('.', undefined, { cwd, allowCreate: true });
    await adoptProjectLocalSkill(cwd, '.');
  }

  for (const source of projectSkillSources) {
    await saveSkillRequirement(source.source, undefined, { cwd, allowCreate: true });
    if (source.kind === 'dependency') {
      if (!(await shouldAdoptProjectDependencySkill(cwd, source, interactive))) {
        continue;
      }
      await adoptProjectDependencySkill(cwd, source);
    } else {
      await adoptProjectLocalSkill(cwd, source.source);
    }
  }

  if (projectSkillSources.length > 0) {
    await ensureProjectSkillCompatibilityLinks(cwd);
  }

  const { adoptProjectMcpConfigs } = await import('./mcp.js');
  await adoptProjectMcpConfigs({ save: true });
  await ensureProjectGeneratedConfigGitignore(cwd);
  await warnIfProjectLocalSkillsAreGitignored(cwd, localSkillSources);

  if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
    const { default: inquirer } = await import('inquirer');
    const { setGitPreference } = await import('./git_config.js');
    const { gitPreference } = await inquirer.prompt([{
      type: 'list',
      name: 'gitPreference',
      message: 'How should skillpkg handle git tracking?',
      choices: [
        { name: 'Auto-gitignore installed project skills (recommended)', value: 'auto' },
        { name: 'Track project skills in git (for team sharing)', value: 'track' },
        { name: 'Ask each time', value: 'ask' },
      ],
    }]);
    await setGitPreference(gitPreference);
  }

  logger.info('Edit the SKILL.md and skm.mod files to configure your skill package');
}

type ProjectSkillSource =
  | {
    kind: 'local';
    source: string;
    skillDir: string;
  }
  | {
    kind: 'dependency';
    source: string;
    skillDir: string;
    sourceCommit: string;
    installMode: InstallMode;
    installedPath: string;
    symlinkTarget: string | null;
  };

async function discoverProjectSkillSources(cwd: string): Promise<ProjectSkillSource[]> {
  const skillsDir = unifiedProjectSkillsDir(cwd);
  if (!(await pathExists(skillsDir))) return [];

  const dirs = await listSubdirs(skillsDir);
  const sources = new Map<string, ProjectSkillSource>();

  for (const dir of dirs) {
    const skillDir = join(skillsDir, dir);
    const frontmatter = await parseSkillMd(skillDir);
    if (!frontmatter?.name) continue;

    if (await isSymbolicLink(skillDir)) {
      const dependency = await dependencySourceForProjectSkillSymlink(cwd, skillDir, frontmatter.name);
      if (dependency) {
        sources.set(dependency.source, dependency);
        continue;
      }

      if (!(await materializeProjectSkillSymlink(skillDir))) {
        continue;
      }
    }

    const source = projectRelativeSourceFromPath(skillDir, cwd);
    if (source) {
      sources.set(source, { kind: 'local', source, skillDir });
    }
  }

  return [...sources.values()].sort((a, b) => a.source.localeCompare(b.source));
}

async function adoptProjectLocalSkill(cwd: string, source: string): Promise<void> {
  const skillDir = resolveLocalPathSource(source, cwd);
  const frontmatter = await parseSkillMd(skillDir);
  if (!frontmatter?.name) return;

  const integrity = await computeIntegrity(skillDir);
  const db = await getDb();
  const now = new Date().toISOString();
  const unifiedPath = join(unifiedProjectSkillsDir(cwd), frontmatter.name);
  const existingRow = db
    .prepare('SELECT id FROM skills WHERE name = ? AND scope = ? AND project_path = ?')
    .get(frontmatter.name, 'project', cwd) as { id: string } | undefined;

  if (existingRow) {
    db.prepare(`
      UPDATE skills SET
        source_url = ?, source_commit = ?, version = ?, description = ?,
        installed_path = ?, unified_path = ?, symlink_target = ?, integrity = ?,
        install_mode = ?, is_linked = ?, assigned_agents = ?, updated_at = ?
      WHERE id = ?
    `).run(
      source, 'local', frontmatter.version || '0.0.0', frontmatter.description || '',
      skillDir, unifiedPath, null, integrity,
      'copy', legacyIsLinkedValue('copy'), 'all', now, existingRow.id
    );
  } else {
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId(), frontmatter.name, source, 'local',
      frontmatter.version || '0.0.0', frontmatter.description || '',
      'project', cwd, null, skillDir, unifiedPath, null, integrity,
      'copy', legacyIsLinkedValue('copy'), now, now, 'all'
    );
  }

  const sumfile = await loadSumfile({ scope: 'project', projectPath: cwd });
  updateSumfileEntry(sumfile, {
    frontmatter,
    localPath: skillDir,
    sourceUrl: source,
    commit: 'local',
    integrity,
  });
  await saveSumfile(sumfile, { scope: 'project', projectPath: cwd });
}

async function shouldAdoptProjectDependencySkill(
  cwd: string,
  source: Extract<ProjectSkillSource, { kind: 'dependency' }>,
  interactive: boolean
): Promise<boolean> {
  const frontmatter = await parseSkillMd(source.skillDir);
  const skillName = frontmatter?.name || source.source;
  const sumfile = await loadSumfile({ scope: 'project', projectPath: cwd });
  const result = await verifyIntegrity(source.source, source.skillDir, sumfile);

  if (result.valid) return true;

  if (result.reason === 'missing-entry') {
    logger.warn(`Project skill "${skillName}" from ${source.source} has no skm.sum entry; recording the current copy.`);
    return true;
  }

  logger.warn(`Project skill "${skillName}" from ${source.source} does not match skm.sum.`);
  logger.warn(`Expected ${result.expected}, got ${result.actual}.`);

  if (!interactive) {
    logger.warn('Using the current copy because --yes/non-interactive mode was requested.');
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    logger.warn('Skipping this dependency because the current shell cannot prompt for confirmation.');
    logger.info('Run skm init interactively to review it, or run skm init -y to accept the current copy.');
    return false;
  }

  const { default: inquirer } = await import('inquirer');
  const { acceptMismatchedSkill } = await inquirer.prompt<{ acceptMismatchedSkill: boolean }>([{
    type: 'confirm',
    name: 'acceptMismatchedSkill',
    message: `Use the current local copy of "${skillName}" and update skm.sum?`,
    default: false,
  }]);

  if (!acceptMismatchedSkill) {
    logger.warn(`Kept ${source.source} in skm.mod without updating skm.sum from the current local copy.`);
  }

  return acceptMismatchedSkill;
}

async function adoptProjectDependencySkill(cwd: string, source: Extract<ProjectSkillSource, { kind: 'dependency' }>): Promise<void> {
  const frontmatter = await parseSkillMd(source.skillDir);
  if (!frontmatter?.name) return;

  const integrity = await computeIntegrity(source.skillDir);
  const db = await getDb();
  const now = new Date().toISOString();
  const unifiedPath = join(unifiedProjectSkillsDir(cwd), frontmatter.name);
  const existingRow = db
    .prepare('SELECT id FROM skills WHERE name = ? AND scope = ? AND project_path = ?')
    .get(frontmatter.name, 'project', cwd) as { id: string } | undefined;

  let skillId = existingRow?.id || genId();
  if (existingRow) {
    db.prepare(`
      UPDATE skills SET
        source_url = ?, source_commit = ?, version = ?, description = ?,
        installed_path = ?, unified_path = ?, symlink_target = ?, integrity = ?,
        install_mode = ?, is_linked = ?, assigned_agents = ?, updated_at = ?
      WHERE id = ?
    `).run(
      source.source, source.sourceCommit, frontmatter.version || '0.0.0', frontmatter.description || '',
      source.installedPath, unifiedPath, source.symlinkTarget, integrity,
      source.installMode, legacyIsLinkedValue(source.installMode), 'all', now, existingRow.id
    );
  } else {
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skillId, frontmatter.name, source.source, source.sourceCommit,
      frontmatter.version || '0.0.0', frontmatter.description || '',
      'project', cwd, null, source.installedPath, unifiedPath, source.symlinkTarget, integrity,
      source.installMode, legacyIsLinkedValue(source.installMode), now, now, 'all'
    );
  }

  db.prepare(`
    INSERT INTO project_skills (id, project_path, skill_source, version, installed_skill_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_path, skill_source) DO UPDATE SET
      version = excluded.version,
      installed_skill_id = excluded.installed_skill_id
  `).run(genId(), cwd, source.source, null, skillId);

  const sumfile = await loadSumfile({ scope: 'project', projectPath: cwd });
  updateSumfileEntry(sumfile, {
    frontmatter,
    localPath: source.skillDir,
    sourceUrl: source.source,
    commit: source.sourceCommit,
    integrity,
  });
  await saveSumfile(sumfile, { scope: 'project', projectPath: cwd });
}

async function dependencySourceForProjectSkillSymlink(
  cwd: string,
  skillDir: string,
  skillName: string
): Promise<Extract<ProjectSkillSource, { kind: 'dependency' }> | null> {
  const target = await realPathOrNull(skillDir);
  if (!target) return null;

  const db = await getDb();
  const rows = db.prepare(`
    SELECT source_url, source_commit, installed_path, unified_path, symlink_target, install_mode, is_linked
    FROM skills
    WHERE name = ? AND (scope != 'project' OR project_path = ?)
    ORDER BY CASE WHEN scope = 'project' THEN 0 ELSE 1 END
  `).all(skillName, cwd) as Record<string, unknown>[];

  for (const row of rows) {
    const source = row['source_url'] as string;
    if (!isManifestDependencySource(source)) continue;

    const candidates = [
      row['installed_path'] as string | null,
      row['unified_path'] as string | null,
      row['symlink_target'] as string | null,
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const candidate of candidates) {
      if (await pointsAtSamePath(candidate, target)) {
        return {
          kind: 'dependency',
          source,
          skillDir,
          sourceCommit: (row['source_commit'] as string) || 'resolved',
          installMode: 'symlink-cache',
          installedPath: (row['installed_path'] as string) || target,
          symlinkTarget: (row['symlink_target'] as string) || target,
        };
      }
    }
  }

  return null;
}

async function materializeProjectSkillSymlink(skillDir: string): Promise<boolean> {
  const target = await realPathOrNull(skillDir);
  if (!target) {
    logger.warn(`Skipping broken project skill symlink: ${skillDir}`);
    return false;
  }

  const tempDir = `${skillDir}.skm-materialize-${Date.now()}`;
  await copyDir(target, tempDir);
  await removePath(skillDir);
  await copyDir(tempDir, skillDir);
  await removePath(tempDir);
  logger.info(`Copied symlinked project skill into ${skillDir}`);
  return true;
}

async function ensureProjectSkillCompatibilityLinks(cwd: string): Promise<void> {
  for (const [agentName, pathConfig] of Object.entries(AGENT_PATHS)) {
    if (!('symlinkDir' in pathConfig)) continue;

    const symlinkDir = pathConfig.symlinkDir(cwd);
    const targetDir = pathConfig.project(cwd);
    try {
      const result = await ensureDirectorySymlink(symlinkDir, targetDir);
      if (result === 'created') {
        logger.info(`Created ${agentName} project skills compatibility link: ${symlinkDir} -> ${targetDir}`);
      } else if (result === 'blocked') {
        logger.warn(`${agentName} project skills path already exists and is not a compatible symlink: ${symlinkDir}`);
      }
    } catch (err) {
      logger.warn(`Failed to create ${agentName} project skills compatibility link: ${(err as Error).message}`);
    }
  }
}

async function pointsAtSamePath(candidate: string, target: string): Promise<boolean> {
  const resolved = await realPathOrNull(candidate);
  return Boolean(resolved && resolve(resolved) === resolve(target));
}

async function realPathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function isManifestDependencySource(source: string): boolean {
  if (!source || source === '.' || source.startsWith('./') || source.startsWith('../')) {
    return false;
  }
  if (source.startsWith('.\\') || source.startsWith('..\\') || source.startsWith('file://') || isLocalPathSource(source)) {
    return false;
  }
  return true;
}

async function warnIfProjectLocalSkillsAreGitignored(cwd: string, sources: string[]): Promise<void> {
  if (sources.length === 0) return;

  const gitignore = await readFileOrNull(join(cwd, '.gitignore'));
  if (!gitignore) return;

  const broadAgentsIgnore = gitignore.split('\n').some((line) => {
    const trimmed = line.trim();
    return trimmed === '.agents/' || trimmed === '.agents' || trimmed === '.agents/*';
  });

  if (broadAgentsIgnore) {
    logger.warn('Project-local skills live in .agents/skills, but .gitignore ignores .agents/. Remove the broad .agents/ rule or teammates will not receive those skills.');
  }
}

async function ensureProjectGeneratedConfigGitignore(cwd: string): Promise<void> {
  const { ensureSkillpkgGitignore, SKILLPKG_GITIGNORE_GENERATED_PATHS } = await import('../utils/gitignore.js');
  await ensureSkillpkgGitignore(cwd, [
    ...SKILLPKG_GITIGNORE_GENERATED_PATHS,
    ...await discoverProjectSkillSymlinkIgnores(cwd),
  ]);
}

async function discoverProjectSkillSymlinkIgnores(cwd: string): Promise<string[]> {
  const skillsDir = unifiedProjectSkillsDir(cwd);
  if (!(await pathExists(skillsDir))) return [];

  const ignores: string[] = [];
  for (const dir of await listSubdirs(skillsDir)) {
    const skillDir = join(skillsDir, dir);
    if (await isSymbolicLink(skillDir)) {
      ignores.push(`.agents/skills/${dir}`);
    }
  }

  return ignores.sort();
}

function projectModuleName(cwd: string): string {
  return cwd.split(/[\\/]+/).filter(Boolean).pop() || 'project';
}

// ─────────────────────────────────────────────────────────────
// skm outdated — npm outdated
// ─────────────────────────────────────────────────────────────

/** Check for outdated skills by comparing local commit vs remote HEAD */
export async function checkOutdated(): Promise<void> {
  const db = await getDb();
  const rows = db.prepare('SELECT * FROM skills ORDER BY name').all() as Record<string, unknown>[];

  if (rows.length === 0) {
    logger.info('No skills installed');
    return;
  }

  const spinner = ora('Checking for updates...').start();
  const config = getDefaultConfig();
  const outdated: OutdatedInfo[] = [];
  let skipped = 0;

  for (const row of rows) {
    const name = row['name'] as string;
    const source = row['source_url'] as string;
    const currentCommit = row['source_commit'] as string;

    spinner.text = `Checking ${name}...`;

    if (!isRemoteUpdatableSkill(row)) {
      logger.debug(`Skipping local skill: ${name}`);
      skipped++;
      continue;
    }

    try {
      // Pull latest from remote
      const repoDir = await cloneOrPull(repoSourceFromInstallSource(source), config.cacheDir);
      const latestCommit = await getCommitSha(repoDir);

      outdated.push({
        name,
        currentVersion: row['version'] as string || '0.0.0',
        currentCommit,
        latestCommit,
        source,
        hasUpdate: currentCommit !== latestCommit,
      });
    } catch {
      logger.debug(`Failed to check ${name}`);
    }
  }

  spinner.stop();
  logger.blank();

  const hasUpdates = outdated.filter((o) => o.hasUpdate);

  if (hasUpdates.length === 0) {
    if (outdated.length === 0 && skipped > 0) {
      logger.success(`No remote Git skills to check (${skipped} local/linked/tracked skipped)`);
      return;
    }
    logger.success('All skills are up to date');
    return;
  }

  const tableHead = ['Name', 'Current', 'Status', 'Source'];
  const tableRows: string[][] = [];

  for (const info of outdated) {
    const status = info.hasUpdate
      ? chalk.yellow(`${info.currentCommit.substring(0, 7)} → ${info.latestCommit.substring(0, 7)}`)
      : chalk.green('up to date');

    tableRows.push([
      info.name,
      info.currentVersion,
      status,
      formatSourceForDisplay(info.source)
    ]);
  }

  logger.table(tableHead, tableRows);
  logger.blank();
  logger.info(`${hasUpdates.length} skill(s) can be updated. Run ${chalk.cyan('skm update')} to update.`);
}

// ─────────────────────────────────────────────────────────────
// skm tree — npm ls / go mod graph
// ─────────────────────────────────────────────────────────────

/** Display dependency tree */
export async function showTree(): Promise<void> {
  const db = await getDb();
  const rows = db.prepare('SELECT * FROM skills ORDER BY name').all() as Record<string, unknown>[];

  if (rows.length === 0) {
    logger.info('No skills installed');
    return;
  }

  // Build adjacency list from dependencies table
  const deps = db.prepare('SELECT * FROM dependencies').all() as Record<string, unknown>[];
  const childrenOf = new Map<string, string[]>();
  const isChild = new Set<string>();

  for (const dep of deps) {
    const parentId = dep['parent_skill_id'] as string;
    const childName = dep['child_skill_name'] as string;
    const list = childrenOf.get(parentId) || [];
    list.push(childName);
    childrenOf.set(parentId, list);
    isChild.add(childName);
  }

  // Find root skills (not a dependency of anything)
  const roots = rows.filter((r) => !isChild.has(r['name'] as string));
  const allByName = new Map(rows.map((r) => [r['name'] as string, r]));

  logger.blank();
  console.log(chalk.bold('  skm dependency tree'));
  logger.blank();

  for (const root of roots) {
    printNode(root, allByName, childrenOf, '', true);
  }

  logger.blank();
  logger.info(`Total: ${rows.length} skill(s)`);
}

function printNode(
  row: Record<string, unknown>,
  allByName: Map<string, Record<string, unknown>>,
  childrenOf: Map<string, string[]>,
  prefix: string,
  isLast: boolean
): void {
  const name = row['name'] as string;
  const version = row['version'] as string || '0.0.0';
  const installMode = installModeFromRecord(row);
  const modeLabel = installMode === 'copy' ? '' : chalk.magenta(` [${formatInstallMode(installMode)}]`);
  const connector = isLast ? '└── ' : '├── ';

  console.log(
    `  ${prefix}${connector}${chalk.cyan(name)}@${chalk.gray(version)}${modeLabel}`
  );

  const children = childrenOf.get(row['id'] as string) || [];
  for (let i = 0; i < children.length; i++) {
    const child = allByName.get(children[i]);
    if (child) {
      const newPrefix = prefix + (isLast ? '    ' : '│   ');
      printNode(child, allByName, childrenOf, newPrefix, i === children.length - 1);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// skm link — npm link (local development)
// ─────────────────────────────────────────────────────────────

/** Link a local skill directory for development */
export async function linkSkill(
  localPath: string,
  options: { scope?: InstallScope; agent?: string; mode?: InstallMode; yes?: boolean; save?: boolean } = {}
): Promise<void> {
  const absPath = resolve(localPath);

  if (!(await pathExists(join(absPath, 'SKILL.md')))) {
    logger.error(`No SKILL.md found in ${absPath}`);
    return;
  }

  const frontmatter = await parseSkillMd(absPath);
  if (!frontmatter?.name) {
    logger.error('Invalid SKILL.md: missing name');
    return;
  }

  const scope = options.scope || 'global';
  const targetAgent = options.agent || 'all';
  const projectPath = scope === 'project' ? process.cwd() : '';
  const projectRelativeSource = scope === 'project'
    ? projectRelativeSourceFromPath(absPath, projectPath)
    : null;
  const unifiedProjectLocalPath = scope === 'project'
    ? join(unifiedProjectSkillsDir(projectPath), frontmatter.name)
    : null;
  const isUnifiedProjectLocal = Boolean(
    unifiedProjectLocalPath && resolve(absPath) === resolve(unifiedProjectLocalPath)
  );
  const installMode: InstallMode = isUnifiedProjectLocal || options.mode === 'copy' ? 'copy' : 'symlink-dev';
  const sourceUrl = isUnifiedProjectLocal && projectRelativeSource ? projectRelativeSource : fileUrlFromPath(absPath);
  const integrity = await computeIntegrity(absPath);

  const skillPkg: SkillPackage = {
    frontmatter,
    localPath: absPath,
    sourceUrl,
    commit: 'linked',
    integrity,
  };

  const adapters = await resolveAdapters(targetAgent as AgentType | 'all');
  let actualInstallMode = installMode;
  for (const adapter of adapters) {
    const adapterInstallMode = await adapter.installSkill(skillPkg, scope, { installMode });
    if (adapterInstallMode !== installMode) {
      actualInstallMode = 'copy';
    }
  }

  // Record in DB
  const db = await getDb();
  const now = new Date().toISOString();
  const symlinkTarget = isSymlinkInstallMode(actualInstallMode) ? absPath : null;
  const unifiedPath = scope === 'project'
    ? join(unifiedProjectSkillsDir(projectPath), frontmatter.name)
    : null;
  db.prepare(`
    INSERT OR REPLACE INTO skills (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    genId(), frontmatter.name, sourceUrl, isUnifiedProjectLocal || actualInstallMode === 'copy' ? 'local' : 'linked',
    frontmatter.version || (isUnifiedProjectLocal || actualInstallMode === 'copy' ? '0.0.0' : '0.0.0-linked'), frontmatter.description || '',
    scope, projectPath, null, absPath, unifiedPath, symlinkTarget, integrity,
    actualInstallMode, legacyIsLinkedValue(actualInstallMode), now, now
  );

  if (!isDevInstallMode(actualInstallMode)) {
    const target = { scope, projectPath };
    const sumfile = await loadSumfile(target);
    updateSumfileEntry(sumfile, skillPkg);
    await saveSumfile(sumfile, target);
  }

  logger.success(`${actualInstallMode === 'copy' ? 'Installed' : 'Linked'} "${frontmatter.name}" from ${absPath}`);
  if (actualInstallMode === 'symlink-dev') {
    logger.info('Changes to the source directory will be reflected immediately');
  }
  if (scope === 'project') {
    if (options.save === true) {
      const { saveSkillRequirement } = await import('./modfile.js');
      await saveSkillRequirement(projectRelativeSource || fileUrlFromPath(absPath), frontmatter.version, {
        save: options.save,
        yes: options.yes,
        allowCreate: true,
      });
    }
    const { handleProjectGitTracking } = await import('./git_tracking.js');
    await handleProjectGitTracking({ yes: options.yes });
  }
}

// ─────────────────────────────────────────────────────────────
// skm tidy — go mod tidy
// ─────────────────────────────────────────────────────────────

/** Remove unused skills and clean up the sumfile */
export async function tidySkills(options: { unify?: boolean } = {}): Promise<void> {
  const db = await getDb();
  const unified = options.unify ? await unifyProjectSkillDirs(db) : 0;
  const pruned =
    await pruneBrokenSkillRows(db, 'global', '') +
    await pruneBrokenSkillRows(db, 'project', process.cwd());
  const globalRows = db
    .prepare("SELECT * FROM skills WHERE scope = 'global' AND project_path = ''")
    .all() as Record<string, unknown>[];
  const projectRows = db
    .prepare("SELECT * FROM skills WHERE scope = 'project' AND project_path = ?")
    .all(process.cwd()) as Record<string, unknown>[];

  const cleaned =
    await tidySumfileForRows('global', '', globalRows) +
    await tidySumfileForRows('project', process.cwd(), projectRows);

  const total = cleaned + unified + pruned;
  if (pruned > 0 || unified > 0) {
    const { handleProjectGitTracking } = await import('./git_tracking.js');
    await handleProjectGitTracking({ refreshExisting: true });
  }

  if (total > 0) {
    logger.success(`Tidied ${total} entries`);
  } else {
    logger.success('Everything is tidy');
  }
}

async function unifyProjectSkillDirs(db: Awaited<ReturnType<typeof getDb>>): Promise<number> {
  const cwd = process.cwd();
  const unifiedDir = unifiedProjectSkillsDir(cwd);
  await ensureDir(unifiedDir);

  let changed = 0;
  for (const [agentName, pathConfig] of Object.entries(AGENT_PATHS)) {
    if (!('symlinkDir' in pathConfig)) continue;

    const legacyDir = pathConfig.symlinkDir(cwd);
    if (await pathExistsNoFollow(legacyDir) && !(await isSymbolicLink(legacyDir))) {
      for (const entry of await safeReadDir(legacyDir)) {
        const source = join(legacyDir, entry);
        const target = join(unifiedDir, entry);

        if (!(await pathExists(target))) {
          await copyDir(source, target);
          logger.info(`Moved ${agentName} project skill "${entry}" into ${unifiedDir}`);
          changed++;
        } else {
          logger.info(`Skipped duplicate ${agentName} project skill "${entry}" already in ${unifiedDir}`);
        }
      }

      await removePath(legacyDir);
      rewriteProjectSkillPaths(db, legacyDir, unifiedDir, cwd);
      changed++;
    }

    const result = await ensureDirectorySymlink(legacyDir, unifiedDir);
    if (result === 'created') {
      logger.info(`Created ${legacyDir} -> ${unifiedDir}`);
      changed++;
    } else if (result === 'blocked') {
      logger.warn(`Cannot unify ${legacyDir}; it exists but is not a compatible symlink.`);
    }
  }

  const projectRows = db
    .prepare("SELECT id, name, unified_path FROM skills WHERE scope = 'project' AND project_path = ?")
    .all(cwd) as { id: string; name: string; unified_path: string | null }[];

  for (const row of projectRows) {
    const unifiedPath = join(unifiedDir, row.name);
    if (row.unified_path !== unifiedPath) {
      db.prepare('UPDATE skills SET unified_path = ?, updated_at = ? WHERE id = ?')
        .run(unifiedPath, new Date().toISOString(), row.id);
      changed++;
    }
  }

  return changed;
}

async function pruneBrokenSkillRows(
  db: Awaited<ReturnType<typeof getDb>>,
  scope: InstallScope,
  projectPath: string
): Promise<number> {
  const rows = db
    .prepare("SELECT id, name, source_url, installed_path, unified_path FROM skills WHERE scope = ? AND project_path = ?")
    .all(scope, projectPath) as Array<{
      id: string;
      name: string;
      source_url: string;
      installed_path: string;
      unified_path: string | null;
    }>;

  let pruned = 0;
  for (const row of rows) {
    if (await pathExists(join(row.installed_path, 'SKILL.md'))) {
      continue;
    }

    await removeBrokenNativeSkillPath(scope, projectPath, row);
    db.prepare('DELETE FROM project_skills WHERE installed_skill_id = ?').run(row.id);
    db.prepare('DELETE FROM mcp_configs WHERE skill_id = ?').run(row.id);
    db.prepare('DELETE FROM skills WHERE id = ?').run(row.id);
    logger.info(`Removed broken ${scope} skill record: ${row.name}`);
    pruned++;
  }

  return pruned;
}

async function removeBrokenNativeSkillPath(
  scope: InstallScope,
  projectPath: string,
  row: { installed_path: string; unified_path: string | null }
): Promise<void> {
  if (scope !== 'project') return;

  const unifiedDir = unifiedProjectSkillsDir(projectPath);
  const nativePaths = new Set<string>();
  if (row.unified_path) nativePaths.add(row.unified_path);
  if (isPathUnder(row.installed_path, unifiedDir)) nativePaths.add(row.installed_path);

  for (const nativePath of nativePaths) {
    if (await pathExistsNoFollow(nativePath)) {
      await removePath(nativePath);
    }
  }
}

function rewriteProjectSkillPaths(
  db: Awaited<ReturnType<typeof getDb>>,
  legacyDir: string,
  unifiedDir: string,
  projectPath: string
): void {
  const rows = db
    .prepare("SELECT id, installed_path, symlink_target FROM skills WHERE scope = 'project' AND project_path = ?")
    .all(projectPath) as Array<{ id: string; installed_path: string; symlink_target: string | null }>;

  for (const row of rows) {
    const installedPath = rewritePathPrefix(row.installed_path, legacyDir, unifiedDir);
    const symlinkTarget = row.symlink_target
      ? rewritePathPrefix(row.symlink_target, legacyDir, unifiedDir)
      : null;

    if (installedPath !== row.installed_path || symlinkTarget !== row.symlink_target) {
      db.prepare('UPDATE skills SET installed_path = ?, symlink_target = ?, updated_at = ? WHERE id = ?')
        .run(installedPath, symlinkTarget, new Date().toISOString(), row.id);
    }
  }
}

function rewritePathPrefix(pathValue: string, oldPrefix: string, newPrefix: string): string {
  if (pathValue === oldPrefix) return newPrefix;
  for (const separator of ['/', '\\']) {
    if (pathValue.startsWith(`${oldPrefix}${separator}`)) {
      return `${newPrefix}${pathValue.slice(oldPrefix.length)}`;
    }
  }
  return pathValue;
}

function isPathUnder(pathValue: string, parentPath: string): boolean {
  if (pathValue === parentPath) return true;
  for (const separator of ['/', '\\']) {
    if (pathValue.startsWith(`${parentPath}${separator}`)) {
      return true;
    }
  }
  return false;
}

async function safeReadDir(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function tidySumfileForRows(
  scope: InstallScope,
  projectPath: string,
  rows: Record<string, unknown>[]
): Promise<number> {
  const target = { scope, projectPath };
  const sumfile = await loadSumfile(target);
  const mcpRows = await tidyMcpRows(scope, projectPath);
  const installedSources = new Set([
    ...rows.map((row) => row['source_url'] as string || row['name'] as string),
    ...mcpRows.map((row) => mcpSumSource(row.source)),
  ]);

  let cleaned = 0;
  for (const source of Array.from(sumfile.keys())) {
    if (!installedSources.has(source)) {
      sumfile.delete(source);
      logger.info(`Removed orphaned ${scope} sumfile entry: ${source}`);
      cleaned++;
    }
  }

  for (const row of rows) {
    const source = row['source_url'] as string || row['name'] as string;
    if (!sumfile.has(source)) {
      const integrity = row['integrity'] as string || await computeIntegrity(row['installed_path'] as string);
      sumfile.set(source, {
        source,
        version: row['version'] as string || '0.0.0',
        integrity,
      });
      logger.info(`Added missing ${scope} sumfile entry: ${source}`);
      cleaned++;
    }
  }

  for (const row of mcpRows) {
    const source = mcpSumSource(row.source);
    if (!sumfile.has(source)) {
      sumfile.set(source, {
        source,
        version: 'mcp',
        integrity: computeMcpConfigIntegrity(row.source, {
          name: row.name,
          type: row.type,
          command: row.command,
          args: parseJsonValue<string[]>(row.args, []),
          envKeys: [],
        }),
      });
      logger.info(`Added missing ${scope} MCP sumfile entry: ${source}`);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    await saveSumfile(sumfile, target);
  }

  return cleaned;
}

async function tidyMcpRows(scope: InstallScope, projectPath: string): Promise<Array<{
  name: string;
  source: string;
  type: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
}>> {
  const db = await getDb();
  return db.prepare(`
    SELECT name, source, type, command, args
    FROM mcp_installations
    WHERE scope = ? AND project_path = ?
    ORDER BY name
  `).all(scope, projectPath) as Array<{
    name: string;
    source: string;
    type: 'stdio' | 'http' | 'sse';
    command: string;
    args: string;
  }>;
}

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────
// skm verify — go mod verify
// ─────────────────────────────────────────────────────────────

/** Verify integrity of all installed skills against the sumfile */
export async function verifySkills(): Promise<void> {
  const db = await getDb();
  const rows = db.prepare('SELECT * FROM skills').all() as Record<string, unknown>[];

  if (rows.length === 0) {
    logger.info('No skills to verify');
    return;
  }

  const spinner = ora('Verifying integrity...').start();
  let passed = 0;
  let failed = 0;
  let unverified = 0;
  let skipped = 0;
  const sumfiles = new Map<string, Awaited<ReturnType<typeof loadSumfile>>>();

  for (const row of rows) {
    const name = row['name'] as string;
    const source = row['source_url'] as string || name;
    const path = row['installed_path'] as string;
    const scope = row['scope'] as InstallScope;
    const projectPath = scope === 'project' ? (row['project_path'] as string || process.cwd()) : '';
    spinner.text = `Verifying ${name}...`;

    if (isDevInstallMode(installModeFromRecord(row))) {
      logger.debug(`Skipping linked skill: ${name}`);
      skipped++;
      continue;
    }

    const sumfileKey = `${scope}:${projectPath}`;
    let sumfile = sumfiles.get(sumfileKey);
    if (!sumfile) {
      sumfile = await loadSumfile({ scope, projectPath });
      sumfiles.set(sumfileKey, sumfile);
    }

    const result = await verifyIntegrity(source, path, sumfile);
    if (result.valid) {
      passed++;
    } else if (result.reason === 'missing-entry') {
      unverified++;
      logger.warn(`${name}: unverified (no ${scope} sumfile entry)`);
    } else {
      failed++;
      logger.warn(`${name}: integrity mismatch`);
      logger.debug(`  expected: ${result.expected}`);
      logger.debug(`  actual:   ${result.actual}`);
    }
  }

  spinner.stop();
  logger.blank();

  if (failed === 0 && unverified === 0) {
    logger.success(`All ${passed} skill(s) verified successfully (${skipped} linked/skipped)`);
  } else {
    logger.error(`${failed} skill(s) failed verification, ${unverified} unverified, ${passed} passed, ${skipped} skipped`);
    logger.info(`Run ${chalk.cyan('skm install --force')} to reinstall affected skills`);
  }
}

// ─────────────────────────────────────────────────────────────
// skm update — npm update (enhanced)
// ─────────────────────────────────────────────────────────────

/** Update one or all skills to their latest version */
export async function updateSkills(
  skillName?: string,
  options: { scope?: string; agent?: string; yes?: boolean } = {}
): Promise<void> {
  const { installSkill } = await import('./installer.js');
  const db = await getDb();

  let query = "SELECT * FROM skills WHERE install_mode != 'symlink-dev' AND (scope != 'project' OR project_path = ?)";
  const params: unknown[] = [process.cwd()];

  if (skillName) {
    query += ' AND name = ?';
    params.push(skillName);
  }

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

  if (rows.length === 0) {
    logger.info(skillName ? `Skill "${skillName}" not found or is linked` : 'No updatable skills');
    return;
  }

  let updated = 0;
  let checked = 0;
  let skipped = 0;
  for (const row of rows) {
    const name = row['name'] as string;
    const source = row['source_url'] as string;
    const currentCommit = row['source_commit'] as string;

    logger.skill(name, 'Checking for updates...');

    if (!isRemoteUpdatableSkill(row)) {
      logger.skill(name, 'Local or tracked source; skipping update');
      skipped++;
      continue;
    }

    try {
      checked++;
      const config = getDefaultConfig();
      const repoDir = await cloneOrPull(repoSourceFromInstallSource(source), config.cacheDir);
      const latestCommit = await getCommitSha(repoDir);

      if (currentCommit === latestCommit) {
        logger.skill(name, 'Already up to date');
        continue;
      }

      logger.skill(name, `${currentCommit.substring(0, 7)} → ${latestCommit.substring(0, 7)}`);

      await installSkill(source, {
        force: true,
        yes: options.yes,
        mode: installModeFromRecord(row),
        scope: (row['scope'] as InstallScope) || 'global',
        agent: (options.agent as AgentType | 'all') || 'all',
      });

      updated++;
    } catch (err) {
      logger.error(`Failed to update ${name}: ${(err as Error).message}`);
    }
  }

  logger.blank();
  logger.success(`Updated ${updated} of ${checked} remote skill(s)`);
  if (skipped > 0) {
    logger.info(`Skipped ${skipped} local/linked/tracked skill(s)`);
  }
}

function repoSourceFromInstallSource(source: string): string {
  return source.split('#')[0];
}

function isRemoteUpdatableSkill(row: Record<string, unknown>): boolean {
  const source = String(row['source_url'] || '');
  const commit = String(row['source_commit'] || '');
  if (!source || isLocalPathSource(source)) return false;
  if (['local', 'linked', 'tracked'].includes(commit)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// skm cache clean
// ─────────────────────────────────────────────────────────────

/** Clean the global cache directory */
export async function cleanCache(): Promise<void> {
  const config = getDefaultConfig();
  const spinner = ora('Cleaning cache directory...').start();
  
  try {
    await removePath(config.cacheDir);
    await ensureDir(config.cacheDir);
    spinner.succeed(`Cache cleaned: ${config.cacheDir}`);
  } catch (err) {
    spinner.fail(`Failed to clean cache: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// skm track
// ─────────────────────────────────────────────────────────────

/** Track untracked skills without assigning them to agents. */
export async function trackSkills(targetSkillName?: string): Promise<void> {
  const db = await getDb();
  const rows = db
    .prepare("SELECT name, scope FROM skills WHERE scope != 'project' OR project_path = ?")
    .all(process.cwd()) as { name: string; scope: string }[];
  const dbNames = new Set(rows.map((r) => `${r.name}:${r.scope}`));

  const { detectAgents } = await import('../adapters/index.js');
  const agents = await detectAgents();

  type TrackCandidate = {
    name: string;
    path: string;
    scope: InstallScope;
    agentName: string;
    version: string;
    description: string;
    integrity: string;
  };

  const untracked: TrackCandidate[] = [];

  for (const agent of agents) {
    for (const sc of ['global', 'project'] as InstallScope[]) {
      const installed = await agent.listInstalled(sc);
      for (const skill of installed) {
        const frontmatter = await parseSkillMd(skill.path);
        const name = frontmatter?.name || skill.name;
        if (targetSkillName && targetSkillName !== name && targetSkillName !== skill.name) {
          continue;
        }
        if (dbNames.has(`${name}:${sc}`)) {
          continue;
        }

        untracked.push({
          name,
          path: skill.path,
          scope: sc,
          agentName: agent.name,
          version: frontmatter?.version || '0.0.0-linked',
          description: frontmatter?.description || '',
          integrity: await computeIntegrity(skill.path),
        });
      }
    }
  }

  if (untracked.length === 0) {
    if (targetSkillName) {
      logger.info(`No untracked skill found named "${targetSkillName}".`);
    } else {
      logger.info('No untracked skills found.');
    }
    return;
  }

  const { getDataDir } = await import('../utils/platform.js');
  const centralizedDir = join(getDataDir(), 'skills');
  await ensureDir(centralizedDir);

  const groups = new Map<string, TrackCandidate[]>();
  for (const skill of untracked) {
    const key = `${skill.scope}:${skill.name}`;
    const existing = groups.get(key) || [];
    existing.push(skill);
    groups.set(key, existing);
  }

  for (const group of groups.values()) {
    const source = group[0];
    const distinctIntegrities = new Set(group.map((skill) => skill.integrity));
    if (distinctIntegrities.size > 1) {
      logger.warn(`Skipping "${source.name}" (${source.scope}): found different untracked copies in multiple agents`);
      logger.info('Resolve the duplicate native skill directories first, then run skm track again.');
      continue;
    }

    const destPath = join(centralizedDir, source.scope, source.name);
    logger.info(`Tracking "${source.name}"...`);
    try {
      await removePath(destPath);
      await copyDir(source.path, destPath);
      const storedIntegrity = await computeIntegrity(destPath);
      const now = new Date().toISOString();
      const projectPath = source.scope === 'project' ? process.cwd() : '';
      const existingRow = db
        .prepare('SELECT id FROM skills WHERE name = ? AND scope = ? AND project_path = ?')
        .get(source.name, source.scope, projectPath) as { id: string } | undefined;

      if (existingRow) {
        db.prepare(`
          UPDATE skills SET
            source_url = ?, source_commit = ?, version = ?, description = ?,
            installed_path = ?, symlink_target = ?, integrity = ?,
            install_mode = ?, is_linked = ?, assigned_agents = ?, updated_at = ?
          WHERE id = ?
        `).run(
          fileUrlFromPath(destPath), 'tracked', source.version, source.description,
          destPath, destPath, storedIntegrity,
          'symlink-dev', legacyIsLinkedValue('symlink-dev'), '[]', now, existingRow.id
        );
      } else {
        db.prepare(`
          INSERT INTO skills
            (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          genId(), source.name, fileUrlFromPath(destPath), 'tracked',
          source.version, source.description, source.scope, projectPath, null,
          destPath, destPath, storedIntegrity,
          'symlink-dev', legacyIsLinkedValue('symlink-dev'), now, now, '[]'
        );
      }

      for (const skill of group) {
        if (skill.path !== destPath) {
          await removePath(skill.path);
        }
      }

      logger.success(`Successfully tracked "${source.name}" to ${destPath}`);
      logger.info(`Run ${chalk.cyan('skm assign')} to choose which agents receive it.`);
    } catch (err) {
      logger.error(`Failed to track "${source.name}": ${(err as Error).message}`);
    }
  }
}
