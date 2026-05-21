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
import { readdir } from 'node:fs/promises';
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
  pathExistsNoFollow,
} from '../utils/fs.js';
import { fileUrlFromPath } from '../utils/path_source.js';
import { resolveAdapters } from '../adapters/index.js';
import {
  loadSumfile,
  saveSumfile,
  computeIntegrity,
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

/** Initialize a new SKILL.md in the current directory */
export async function initManifest(
  name?: string,
  interactive: boolean = false
): Promise<void> {
  const cwd = process.cwd();
  const mdPath = join(cwd, 'SKILL.md');

  if (await pathExists(mdPath)) {
    logger.warn('SKILL.md already exists in this directory');
    return;
  }

  const skillName = name || 'my-skill';
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
  
  const modPath = join(cwd, 'skm.mod');
  if (!(await pathExists(modPath))) {
    await writeFileSafe(modPath, `module ${skillName}\n\n`);
    logger.success(`Created ${modPath}`);
  }

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

  logger.success(`Created ${mdPath}`);
  logger.info('Edit the SKILL.md and skm.mod files to configure your skill package');
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

  for (const row of rows) {
    const name = row['name'] as string;
    const source = row['source_url'] as string;
    const currentCommit = row['source_commit'] as string;

    spinner.text = `Checking ${name}...`;

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
  const installMode: InstallMode = options.mode === 'copy' ? 'copy' : 'symlink-dev';
  const integrity = await computeIntegrity(absPath);

  const skillPkg: SkillPackage = {
    frontmatter,
    localPath: absPath,
    sourceUrl: fileUrlFromPath(absPath),
    commit: 'linked',
    integrity,
  };

  const adapters = await resolveAdapters(targetAgent as AgentType | 'all');
  for (const adapter of adapters) {
    await adapter.installSkill(skillPkg, scope, { installMode });
  }

  // Record in DB
  const db = await getDb();
  const now = new Date().toISOString();
  const projectPath = scope === 'project' ? process.cwd() : '';
  const symlinkTarget = isSymlinkInstallMode(installMode) ? absPath : null;
  const unifiedPath = scope === 'project'
    ? join(unifiedProjectSkillsDir(projectPath), frontmatter.name)
    : null;
  db.prepare(`
    INSERT OR REPLACE INTO skills (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    genId(), frontmatter.name, fileUrlFromPath(absPath), 'linked',
    frontmatter.version || '0.0.0-linked', frontmatter.description || '',
    scope, projectPath, null, absPath, unifiedPath, symlinkTarget, integrity,
    installMode, legacyIsLinkedValue(installMode), now, now
  );

  if (!isDevInstallMode(installMode)) {
    const target = { scope, projectPath };
    const sumfile = await loadSumfile(target);
    updateSumfileEntry(sumfile, skillPkg);
    await saveSumfile(sumfile, target);
  }

  logger.success(`${installMode === 'copy' ? 'Installed' : 'Linked'} "${frontmatter.name}" from ${absPath}`);
  if (installMode === 'symlink-dev') {
    logger.info('Changes to the source directory will be reflected immediately');
  }
  if (scope === 'project') {
    if (options.save === true) {
      const { saveSkillRequirement } = await import('./modfile.js');
      await saveSkillRequirement(fileUrlFromPath(absPath), frontmatter.version, {
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
  const globalRows = db
    .prepare("SELECT * FROM skills WHERE scope = 'global' AND project_path = ''")
    .all() as Record<string, unknown>[];
  const projectRows = db
    .prepare("SELECT * FROM skills WHERE scope = 'project' AND project_path = ?")
    .all(process.cwd()) as Record<string, unknown>[];

  const cleaned =
    await tidySumfileForRows('global', '', globalRows) +
    await tidySumfileForRows('project', process.cwd(), projectRows);

  const total = cleaned + unified;
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
  const installedSources = new Set(rows.map((row) => row['source_url'] as string || row['name'] as string));

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

  if (cleaned > 0) {
    await saveSumfile(sumfile, target);
  }

  return cleaned;
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
  for (const row of rows) {
    const name = row['name'] as string;
    const source = row['source_url'] as string;
    const currentCommit = row['source_commit'] as string;

    logger.skill(name, 'Checking for updates...');

    try {
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
  logger.success(`Updated ${updated} of ${rows.length} skill(s)`);
}

function repoSourceFromInstallSource(source: string): string {
  return source.split('#')[0];
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
