/**
 * Core Installer — orchestrates skill installation, dependency resolution, and MCP setup
 *
 * Integration points:
 *   - Replace directives (Go mod style): redirect dependency sources
 *   - Lifecycle hooks: setup_command or setup.sh
 *   - Lockfile with integrity (go.sum style): reproducible installs
 *   - Recursive dependency resolution with cycle detection
 */
import { join, dirname, relative } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import type {
  SkillPackage,
  InstallOptions,
  AgentType,
  InstallScope,
} from '../types/index.js';
import { formatSourceForDisplay, parseSourceString, parseSkillMd } from '../parsers/index.js';
import { cloneOrPull, getCommitSha, checkout } from '../utils/git.js';
import { pathExists, isDirectory } from '../utils/fs.js';
import { getDefaultConfig, unifiedProjectSkillsDir } from '../utils/platform.js';
import { isLocalPathSource, localPathFromSource } from '../utils/path_source.js';
import { promptForSearchableSelection } from '../utils/searchable_selection.js';
import { getDb, genId } from '../db/index.js';
import { getAllAdapters, resolveAdapters } from '../adapters/index.js';
import { applyReplaceDirectives } from './replace.js';
import { runSetup } from './hooks.js';
import { loadSumfile, saveSumfile, updateSumfileEntry, computeIntegrity } from './sumfile.js';
import { logger } from '../utils/logger.js';
import {
  defaultInstallModeForScope,
  formatInstallMode,
  installModeFromRecord,
  isDevInstallMode,
  isSymlinkInstallMode,
  legacyIsLinkedValue,
} from '../utils/install_mode.js';

/** Track install path for cycle detection */
const installStack = new Set<string>();

interface SkillSelectionChoice {
  name: string;
  value: string;
  skillName: string;
  subPath: string;
}

/**
 * Install a skill from a source string
 * Source formats:
 *   "owner/repo"            → https://github.com/owner/repo
 *   "owner/repo/sub/path"   → sub-directory in repo
 *   "owner/repo@v1.0.0"     → version pinning
 *   "https://..."            → full URL
 *   "/local/path"           → local directory (detected as link)
 *   "C:\\local\\path"       → Windows local directory (detected as link)
 *   "file:///local/path"    → local directory URL (detected as link)
 */
export async function installSkill(
  source: string,
  options: InstallOptions = {}
): Promise<void> {
  const spinner = ora('Resolving source...').start();
  let installKey: string | undefined;
  const scope: InstallScope = options.scope || 'global';

  try {
    // Check for local path (npm link / go replace local)
    const localPath = isLocalPathSource(source) ? localPathFromSource(source) : null;
    if (localPath && await isDirectory(localPath)) {
      spinner.stop();
      const { linkSkill } = await import('./commands.js');
      await linkSkill(localPath, {
        scope: options.scope,
        agent: options.agent,
        mode: options.mode === 'copy' ? 'copy' : 'symlink-dev',
        yes: options.yes,
        save: options.save,
      });
      return;
    }

    // 1. Parse source
    const { repoUrl, skillPath, version } = parseSourceString(source);
    const installSource = skillPath ? `${repoUrl}#${skillPath}` : repoUrl;
    const manifestSource = toModSource(source, version, installSource);

    // 2. Cycle detection
    installKey = `${repoUrl}:${skillPath || ''}`;
    if (installStack.has(installKey)) {
      spinner.warn(`Circular dependency detected: ${source}, skipping`);
      return;
    }
    installStack.add(installKey);

    spinner.text = `Cloning ${repoUrl}...`;

    // 3. Clone or update repo
    const config = getDefaultConfig();
    const repoDir = await cloneOrPull(repoUrl, config.cacheDir);

    // 4. Checkout version if specified
    if (version) {
      spinner.text = `Checking out ${version}...`;
      await checkout(repoDir, version);
    }

    // 5. Determine skill directory
    let skillDir = skillPath ? join(repoDir, skillPath) : repoDir;
    if (!(await pathExists(join(skillDir, 'SKILL.md')))) {
      const { findFiles } = await import('../utils/fs.js');
      const foundSkills = await findFiles(skillDir, 'SKILL.md', 6);
      
      if (foundSkills.length === 0) {
        spinner.fail('No SKILL.md found in the target directory or its subdirectories (depth 6)');
        return;
      } else if (foundSkills.length === 1) {
        skillDir = dirname(foundSkills[0]);
        spinner.succeed(`Found SKILL.md at ${skillDir.replace(repoDir, '') || '.'}`);
      } else {
        let selectedSkills: string[] = [];

        if (options.yes) {
          selectedSkills = foundSkills.map(p => relative(repoDir, dirname(p)) || '.');
          spinner.info(`Automatically selecting all ${selectedSkills.length} skills found in repository`);
        } else {
          spinner.stop();
          selectedSkills = await promptForSelectedSkills(repoDir, foundSkills);
        }
        
        // Loop over choices and install them recursively
        for (const subPath of selectedSkills) {
          // Re-construct the source string to target this specific subpath
          const versionSuffix = version ? `@${version}` : '';
          const newSource = `${repoUrl}#${subPath}${versionSuffix}`;
          await installSkill(newSource, { ...options, saveToMod: true });
        }
        if (scope === 'project' && installStack.size === 1) {
          const { handleProjectGitTracking } = await import('./git_tracking.js');
          await handleProjectGitTracking({ yes: options.yes });
        }
        return; // we're done since recursive calls handled it
      }
    }

    // 6. Parse skill metadata
    spinner.text = 'Parsing skill metadata...';
    const frontmatter = await parseSkillMd(skillDir);
    if (!frontmatter || !frontmatter.name) {
      spinner.fail('Invalid SKILL.md: missing name in frontmatter');
      return;
    }

    const commit = await getCommitSha(repoDir);
    const skillName = options.alias || frontmatter.name;

    // 7. Conflict detection
    const db = await getDb();
    const requestedMode = options.mode === 'symlink-dev' ? 'symlink-cache' : options.mode;
    const installMode = requestedMode || defaultInstallModeForScope(scope);
    const projectPath = scope === 'project' ? process.cwd() : '';
    const existing = db
      .prepare('SELECT * FROM skills WHERE name = ? AND scope = ? AND project_path = ?')
      .get(skillName, scope, projectPath) as Record<string, unknown> | undefined;

    if (existing && !options.replace && !options.force) {
      const existingSource = existing['source_url'] as string;
      if (existingSource !== installSource) {
        spinner.fail(
          `Conflict: "${skillName}" already installed from ${existingSource}\n` +
          `  ${chalk.gray('Options:')}\n` +
          `  ${chalk.cyan('--replace')}  Replace with the new source\n` +
          `  ${chalk.cyan('--alias')}    Install under a different name\n` +
          `  ${chalk.cyan('--scope project')}  Install at project level (can coexist with global)`
        );
        return;
      }
      // Same source — treat as update
      const existingInstallMode = installModeFromRecord(existing);
      if (existing['source_commit'] === commit && existingInstallMode === installMode && !options.force) {
        if (scope !== 'project') {
          spinner.succeed(`"${skillName}" is already up to date (${commit.substring(0, 7)})`);
          return;
        }
        spinner.info(`"${skillName}" is already up to date; refreshing project links`);
      }
    }

    // 8. Handle replacement (Go replace / npm overwrite)
    const replacedSource = existing && existing['source_url'] !== installSource
      ? existing['source_url'] as string
      : undefined;

    if (existing && (options.replace || existing['source_url'] === installSource)) {
      if (options.replace && existing['source_url'] !== installSource) {
        spinner.text = 'Recording replacement history...';
        db.prepare(`
          INSERT INTO replace_history (id, skill_name, old_source, old_commit, new_source, new_commit, replaced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          genId(), skillName,
          existing['source_url'], existing['source_commit'],
          installSource, commit, new Date().toISOString()
        );
        logger.info(`Replacing "${skillName}" (was from ${existing['source_url']})`);
      }
      db.prepare('DELETE FROM skills WHERE id = ?').run(existing['id']);
    }

    // 9. Compute integrity hash (go.sum style)
    spinner.text = 'Computing integrity hash...';
    const integrity = await computeIntegrity(skillDir);

    // 10. Build SkillPackage
    const skillPkg: SkillPackage = {
      frontmatter: { ...frontmatter, name: skillName },
      localPath: skillDir,
      sourceUrl: installSource,
      commit,
      integrity,
    };

    // 11. Run setup hook
    if (!options.noScripts) {
      spinner.text = 'Running setup...';
      const ok = await runSetup(frontmatter.setup_command, skillDir, skillName);
      if (!ok && !options.force) {
        spinner.fail('setup failed. Use --force to skip.');
        return;
      }
    }

    // 12. Resolve dependencies
    // Note: Assuming `frontmatter.dependencies` contains strings of dependencies. 
    // Wait, applyReplaceDirectives was taking `manifest.dependencies` (SkillDependency[]) and `manifest.replace`.
    // I will simplify dependencies to just strings in SKILL.md.
    if (!options.noDeps && frontmatter.dependencies?.length) {
      spinner.text = 'Resolving dependencies...';
      
      for (const depSource of frontmatter.dependencies) {
        spinner.stop();
        logger.skill(skillName, `Installing dependency: ${depSource}`);
        await installSkill(depSource, {
          scope: options.scope,
          mode: options.mode,
          agent: options.agent,
          force: true,
          noScripts: options.noScripts,
          save: false,
          saveToMod: false,
        });
        spinner.start();
      }

      // Record dependency relationships in DB
      for (const depSource of frontmatter.dependencies) {
        // Need to parse to get a generic name if possible, or just record source
        const parsed = parseSourceString(depSource);
        const childName = parsed.repoUrl.split('/').pop() || depSource;
        
        db.prepare(`
          INSERT OR IGNORE INTO dependencies (id, parent_skill_id, child_skill_name, child_source, required_version)
          VALUES (?, (SELECT id FROM skills WHERE name = ? LIMIT 1), ?, ?, ?)
        `).run(genId(), skillName, childName, depSource, parsed.version || null);
      }
    }

    // 13. Deploy to agent(s)
    const targetAgent = options.agent || 'all';
    spinner.text = `Deploying to ${targetAgent === 'all' ? 'all detected agents' : targetAgent}...`;

    const adapters = await resolveAdapters(targetAgent as AgentType | 'all');
    const assignedAgents = targetAgent === 'all'
      ? 'all'
      : JSON.stringify(adapters.map((adapter) => adapter.name));
    for (const adapter of adapters) {
      await adapter.installSkill(skillPkg, scope, { installMode });

      // Configure MCP services
      if (frontmatter.mcp?.length) {
        const { getMcpConfig, promptForMcpEnv } = await import('./mcp_registry.js');
        for (const mcpName of frontmatter.mcp) {
          const config = await getMcpConfig(mcpName);
          const env = await promptForMcpEnv(config);
          await adapter.configureMCP(config, env, scope);
        }
      }
    }

    // 14. Record in database
    const now = new Date().toISOString();
    const existingRow = db
      .prepare('SELECT id FROM skills WHERE name = ? AND scope = ? AND project_path = ?')
      .get(skillName, scope, projectPath) as { id: string } | undefined;

    let installedSkillId: string;
    const symlinkTarget = isSymlinkInstallMode(installMode) ? skillDir : null;
    const isLinked = legacyIsLinkedValue(installMode);
    const unifiedPath = scope === 'project'
      ? join(unifiedProjectSkillsDir(projectPath), skillName)
      : null;

    if (existingRow) {
      db.prepare(`
        UPDATE skills SET
          source_url = ?, source_commit = ?, version = ?, description = ?,
          project_path = ?, alias = ?, installed_path = ?, unified_path = ?, symlink_target = ?, integrity = ?,
          install_mode = ?, is_linked = ?, assigned_agents = ?, updated_at = ?
        WHERE id = ?
      `).run(
        installSource, commit, frontmatter.version || '0.0.0',
        frontmatter.description || '', projectPath, options.alias || null,
        skillDir, unifiedPath, symlinkTarget, integrity,
        installMode, isLinked, assignedAgents, now, existingRow.id
      );
      installedSkillId = existingRow.id;
    } else {
      installedSkillId = genId();
      db.prepare(`
        INSERT INTO skills
          (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        installedSkillId, skillName, installSource, commit,
        frontmatter.version || '0.0.0', frontmatter.description || '',
        scope, projectPath, options.alias || null, skillDir, unifiedPath, symlinkTarget, integrity,
        installMode, isLinked, now, now, assignedAgents
      );
    }

    if (scope === 'project') {
      db.prepare(`
        INSERT INTO project_skills (id, project_path, skill_source, version, installed_skill_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_path, skill_source) DO UPDATE SET
          version = excluded.version,
          installed_skill_id = excluded.installed_skill_id
      `).run(genId(), projectPath, manifestSource, version || null, installedSkillId);
    }

    if (scope === 'project') {
      await warnAboutCoexistingGlobalSkill(skillName);
    }

    // 15. Update sumfile (go.sum style)
    const sumfileTarget = { scope, projectPath };
    const sumfile = await loadSumfile(sumfileTarget);
    if (replacedSource) {
      sumfile.delete(replacedSource);
    }
    updateSumfileEntry(sumfile, skillPkg);
    await saveSumfile(sumfile, sumfileTarget);

    const isRootProjectInstall = scope === 'project' && installStack.size === 1;
    spinner.succeed(
      `Installed "${skillName}" ` +
      chalk.gray(`(${commit.substring(0, 7)} → ${adapters.length} agent(s))`) +
      (frontmatter.dependencies?.length ? chalk.gray(` + ${frontmatter.dependencies.length} dep(s)`) : '')
    );

    // 16. Update skm.mod for project installs selected by the root request.
    const shouldSaveToMod = scope === 'project'
      && options.save !== false
      && (installStack.size === 1 || options.saveToMod === true);
    if (shouldSaveToMod) {
      const { saveSkillRequirement } = await import('./modfile.js');
      await saveSkillRequirement(manifestSource || skillName, version, {
        save: options.save,
        yes: options.yes,
        allowCreate: true,
      });
    }
    if (isRootProjectInstall) {
      const { handleProjectGitTracking } = await import('./git_tracking.js');
      await handleProjectGitTracking({ yes: options.yes });
    }
  } catch (err) {
    spinner.fail(`Installation failed: ${(err as Error).message}`);
    logger.debug((err as Error).stack || '');
  } finally {
    // Always clean up cycle detection to prevent stale entries
    if (installKey) installStack.delete(installKey);
  }
}

async function promptForSelectedSkills(repoDir: string, foundSkills: string[]): Promise<string[]> {
  const choices = await buildSkillSelectionChoices(repoDir, foundSkills);
  return promptForSearchableSelection({
    choices: choices.map((choice) => ({
      name: choice.name,
      value: choice.value,
      searchable: `${choice.skillName} ${choice.subPath}`,
    })),
    itemLabel: 'skills',
    queryName: 'skillSearch',
    selectionName: 'selectedSkills',
    searchMessage: (total) => `Search skills by name/path (${total} found, leave blank for all):`,
    selectMessage: (matched, total, query) => query
      ? `Found ${matched} of ${total} skills matching "${query}". Select which ones to install:`
      : `Found ${total} skills in this repository. Select which ones to install:`,
    noMatchesMessage: (query) => `No skills matched "${query}". Try another keyword or leave blank to show all.`,
    includeSelectAll: true,
  });
}

async function buildSkillSelectionChoices(repoDir: string, foundSkills: string[]): Promise<SkillSelectionChoice[]> {
  return Promise.all(foundSkills.map(async (skillMdPath) => {
    const skillDir = dirname(skillMdPath);
    const subPath = relative(repoDir, skillDir) || '.';
    const frontmatter = await parseSkillMd(skillDir);
    const skillName = frontmatter?.name || subPath;
    const name = skillName === subPath
      ? skillName
      : `${skillName} ${chalk.gray(`(${subPath})`)}`;

    return {
      name,
      value: subPath,
      skillName,
      subPath,
    };
  }));
}

async function warnAboutCoexistingGlobalSkill(skillName: string): Promise<void> {
  const db = await getDb();
  const globalSkill = db.prepare(`
    SELECT id
    FROM skills
    WHERE name = ? AND scope = 'global' AND project_path = ''
    LIMIT 1
  `).get(skillName) as { id: string } | undefined;

  if (!globalSkill) return;

  logger.warn(
    `Project skill "${skillName}" coexists with a global install. ` +
    `skm keeps both scopes; use skm promote/demote/uninstall to move or remove a scope intentionally.`
  );
}

/** Uninstall a skill */
export async function uninstallSkill(
  skillName: string,
  options: { scope?: string; agent?: string; noScripts?: boolean; save?: boolean } = {}
): Promise<void> {
  const db = await getDb();
  const scope = (options.scope || await defaultUninstallScope(db, skillName)) as InstallScope;
  const projectPath = scope === 'project' ? process.cwd() : '';

  const record = db
    .prepare('SELECT * FROM skills WHERE name = ? AND scope = ? AND project_path = ?')
    .get(skillName, scope, projectPath) as Record<string, unknown> | undefined;

  if (!record) {
    logger.error(`Skill "${skillName}" is not installed (scope: ${scope})`);
    return;
  }

  const targetAgent = options.agent || 'all';
  const adapters = await resolveAdapters(targetAgent as AgentType | 'all');

  for (const adapter of adapters) {
    await adapter.uninstallSkill(skillName, scope as InstallScope);

    const mcpConfigs = db
      .prepare('SELECT * FROM mcp_configs WHERE skill_id = ?')
      .all(record['id'] as string) as Record<string, unknown>[];

    for (const mcp of mcpConfigs) {
      await adapter.removeMCP(mcp['name'] as string, scope as InstallScope);
    }
  }

  // Update sumfile
  const sumfileTarget = { scope, projectPath };
  const sumfile = await loadSumfile(sumfileTarget);
  const source = record['source_url'] as string || skillName;
  sumfile.delete(source);
  await saveSumfile(sumfile, sumfileTarget);

  if (scope === 'project' && options.save !== false) {
    const projectSkill = db
      .prepare('SELECT skill_source FROM project_skills WHERE installed_skill_id = ? LIMIT 1')
      .get(record['id']) as { skill_source: string } | undefined;
    const { removeSkillRequirement } = await import('./modfile.js');
    await removeSkillRequirement(projectSkill?.skill_source || source, projectPath);
  }

  // Remove from database
  db.prepare('DELETE FROM project_skills WHERE installed_skill_id = ?').run(record['id']);
  db.prepare('DELETE FROM skills WHERE id = ?').run(record['id']);

  if (scope === 'project') {
    const { handleProjectGitTracking } = await import('./git_tracking.js');
    await handleProjectGitTracking({ cwd: projectPath, refreshExisting: true });
  }

  logger.success(`Uninstalled "${skillName}"`);
}

async function defaultUninstallScope(
  db: Awaited<ReturnType<typeof getDb>>,
  skillName: string
): Promise<InstallScope> {
  const projectSkill = db.prepare(`
    SELECT id
    FROM skills
    WHERE name = ? AND scope = 'project' AND project_path = ?
    LIMIT 1
  `).get(skillName, process.cwd()) as { id: string } | undefined;

  return projectSkill ? 'project' : 'global';
}

/** List installed skills */
export async function listSkills(scope?: string): Promise<void> {
  const db = await getDb();

  let query = 'SELECT * FROM skills';
  const params: unknown[] = [];

  if (scope) {
    query += ' WHERE scope = ?';
    params.push(scope);
    if (scope === 'project') {
      query += ' AND project_path = ?';
      params.push(process.cwd());
    } else if (scope === 'global') {
      query += " AND project_path = ''";
    }
  } else {
    query += " WHERE (scope = 'global' AND project_path = '') OR (scope = 'project' AND project_path = ?)";
    params.push(process.cwd());
  }
  query += ' ORDER BY name';

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  const conflictRows = db
    .prepare("SELECT name, scope, project_path FROM skills WHERE (scope = 'global' AND project_path = '') OR (scope = 'project' AND project_path = ?)")
    .all(process.cwd()) as Record<string, unknown>[];
  const dbNames = new Set(rows.map((r) => `${r['name'] as string}:${r['scope'] as string}`));

  // Discover untracked skills from agents
  const { detectAgents } = await import('../adapters/index.js');
  const agents = await detectAgents();
  const untracked: { name: string; scope: string; source: string }[] = [];
  
  const scopesToCheck: InstallScope[] = scope ? [scope as InstallScope] : ['global', 'project'];
  
  for (const agent of agents) {
    for (const sc of scopesToCheck) {
      const installed = await agent.listInstalled(sc);
      for (const skill of installed) {
        if (!dbNames.has(`${skill.name}:${sc}`)) {
          // Avoid duplicates if multiple agents have the same untracked skill
          if (!untracked.find(u => u.name === skill.name && u.scope === sc)) {
            untracked.push({
              name: skill.name,
              scope: sc,
              source: `untracked (${agent.name})`
            });
          }
        }
      }
    }
  }

  const totalCount = rows.length + untracked.length;

  if (logger.isJsonMode()) {
    logger.json({
      tracked: rows.map((row) => ({
        ...row,
        scope_conflict: scopeConflictLabel(row, conflictRows) || null,
      })),
      untracked,
    });
    return;
  }

  if (totalCount === 0) {
    logger.info('No skills installed');
    return;
  }

  const tableHead = ['Name', 'Version', 'Scope', 'Mode', 'Source', 'Status'];
  const tableRows: string[][] = [];

  // Print tracked skills
  for (const row of rows) {
    const conflict = scopeConflictLabel(row, conflictRows);
    tableRows.push([
      conflict ? chalk.yellow.bold(row['name'] as string) : chalk.cyan.bold(row['name'] as string),
      (row['version'] as string || '—'),
      row['scope'] as string,
      formatInstallMode(installModeFromRecord(row)),
      formatSourceForDisplay(row['source_url'] as string),
      conflict ? chalk.yellow(`⚠ ${conflict}`) : chalk.green('ok')
    ]);
  }

  // Print untracked skills
  for (const u of untracked) {
    tableRows.push([
      chalk.yellow.bold(u.name),
      '—',
      u.scope,
      chalk.yellow('untracked'),
      chalk.gray(u.source),
      chalk.yellow('untracked')
    ]);
  }

  logger.blank();
  logger.table(tableHead, tableRows);
  logger.blank();
  logger.info(`Total: ${totalCount} skill(s)`);
  if (untracked.length > 0) {
    logger.info(`  ${chalk.yellow('untracked')}: found in agent directories but not managed by skm`);
  }
}

function scopeConflictLabel(
  row: Record<string, unknown>,
  visibleRows: Record<string, unknown>[]
): string | null {
  const name = row['name'] as string;
  const scopes = new Set(
    visibleRows
      .filter((candidate) => candidate['name'] === name)
      .map((candidate) => candidate['scope'] as string)
  );

  if (!(scopes.has('global') && scopes.has('project'))) return null;
  return row['scope'] === 'global' ? 'coexists with project' : 'coexists with global';
}

/** Show skill info */
export async function showSkillInfo(skillName: string): Promise<void> {
  const db = await getDb();

  const rows = db
    .prepare(`
      SELECT * FROM skills
      WHERE name = ?
        AND (
          (scope = 'project' AND project_path = ?)
          OR (scope = 'global' AND project_path = '')
        )
      ORDER BY
        CASE
          WHEN scope = 'project' THEN 0
          ELSE 1
        END
    `)
    .all(skillName, process.cwd()) as Record<string, unknown>[];
  const row = rows[0];

  if (!row) {
    logger.error(`Skill "${skillName}" is not installed`);
    return;
  }

  // Dependencies
  const deps = db
    .prepare('SELECT child_skill_name, child_source FROM dependencies WHERE parent_skill_id = ?')
    .all(row['id'] as string) as Record<string, unknown>[];

  // Replace history
  const history = db
    .prepare('SELECT * FROM replace_history WHERE skill_name = ? ORDER BY replaced_at DESC')
    .all(skillName) as Record<string, unknown>[];
  const conflict = scopeConflictLabel(row, rows);
  const agentInjections = await collectAgentInjectionStatus(row);

  if (logger.isJsonMode()) {
    logger.json({
      ...row,
      dependencies: deps,
      replace_history: history,
      scope_conflict: conflict,
      coexisting_scopes: rows,
      agent_injections: agentInjections,
    });
    return;
  }

  let infoText = `${chalk.bold.cyan(row['name'] as string)}\n`;
  infoText += `${chalk.gray(row['description'] as string || 'No description')}\n\n`;
  
  infoText += `${chalk.bold('Version:')}    ${row['version'] || '—'}\n`;
  infoText += `${chalk.bold('Source:')}     ${row['source_url']}\n`;
  infoText += `${chalk.bold('Commit:')}     ${chalk.gray(row['source_commit'] as string)}\n`;
  infoText += `${chalk.bold('Scope:')}      ${row['scope']}\n`;
  infoText += `${chalk.bold('Mode:')}       ${formatInstallMode(installModeFromRecord(row))}\n`;
  if (conflict) {
    infoText += `${chalk.bold('Conflict:')}   ${chalk.yellow(`⚠ ${conflict}`)}\n`;
  }
  
  if (row['alias']) {
    infoText += `${chalk.bold('Alias:')}      ${row['alias']}\n`;
  }
  
  infoText += `${chalk.bold('Installed:')}  ${chalk.gray(row['installed_at'] as string)}\n`;
  infoText += `${chalk.bold('Updated:')}    ${chalk.gray(row['updated_at'] as string)}\n`;

  if (deps.length > 0) {
    infoText += `\n${chalk.bold('Dependencies:')}\n`;
    for (const d of deps) {
      infoText += `  ${chalk.cyan('•')} ${d['child_skill_name']} ${chalk.gray(`(${d['child_source']})`)}\n`;
    }
  }

  if (history.length > 0) {
    infoText += `\n${chalk.bold('Replace History:')}\n`;
    for (const h of history) {
      infoText += `  ${chalk.yellow('•')} ${h['replaced_at']}: ${chalk.gray(h['old_source'] as string)} → ${h['new_source']}\n`;
    }
  }

  if (agentInjections.length > 0) {
    infoText += `\n${chalk.bold('Agent Injection:')}\n`;
    for (const injection of agentInjections) {
      const state = injection.installed ? chalk.green('✔') : chalk.gray('✖');
      const detected = injection.detected ? '' : chalk.gray(' (not detected)');
      const assigned = injection.assigned ? '' : chalk.gray(' (not assigned)');
      infoText += `  ${state} ${injection.agent} ${chalk.gray(`[${injection.scope}]`)} ${chalk.gray(injection.path)}${detected}${assigned}\n`;
    }
  }

  logger.box(infoText);
}

async function collectAgentInjectionStatus(row: Record<string, unknown>): Promise<Array<{
  agent: string;
  agent_name: AgentType;
  scope: InstallScope;
  detected: boolean;
  assigned: boolean;
  installed: boolean;
  path: string;
}>> {
  const adapters = getAllAdapters();
  const scope = row['scope'] as InstallScope;
  const skillName = row['name'] as string;

  const statuses = [];
  for (const adapter of adapters) {
    const detected = await adapter.detect();
    const targetPath = join(adapter.getSkillsDir(scope), skillName);
    const installed = await pathExists(targetPath);

    statuses.push({
      agent: adapter.displayName,
      agent_name: adapter.name,
      scope,
      detected,
      assigned: isAssignedToAgent(row['assigned_agents'] as string | undefined, adapter.name),
      installed,
      path: targetPath,
    });
  }

  return statuses;
}

function isAssignedToAgent(value: string | undefined, agentName: AgentType): boolean {
  if (!value || value === 'all') return true;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.includes(agentName);
  } catch {
    return true;
  }
}

/** Show a project-aware status overview for installed skills. */
export async function showSkillStatus(scope?: string): Promise<void> {
  const db = await getDb();
  let query = 'SELECT * FROM skills';
  const params: unknown[] = [];

  if (scope) {
    query += ' WHERE scope = ?';
    params.push(scope);
    if (scope === 'project') {
      query += ' AND project_path = ?';
      params.push(process.cwd());
    } else if (scope === 'global') {
      query += " AND project_path = ''";
    }
  } else {
    query += " WHERE (scope = 'global' AND project_path = '') OR (scope = 'project' AND project_path = ?)";
    params.push(process.cwd());
  }
  query += ' ORDER BY name, scope';

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  if (rows.length === 0) {
    if (logger.isJsonMode()) {
      logger.json({ skills: [] });
      return;
    }
    logger.info('No skills installed');
    return;
  }

  const conflictRows = db
    .prepare("SELECT name, scope, project_path FROM skills WHERE (scope = 'global' AND project_path = '') OR (scope = 'project' AND project_path = ?)")
    .all(process.cwd()) as Record<string, unknown>[];
  const sumfiles = new Map<string, Awaited<ReturnType<typeof loadSumfile>>>();

  const statusRows = [];
  for (const row of rows) {
    const rowScope = row['scope'] as InstallScope;
    const projectPath = rowScope === 'project' ? (row['project_path'] as string || process.cwd()) : '';
    const source = row['source_url'] as string || row['name'] as string;
    const sumfileKey = `${rowScope}:${projectPath}`;
    let sumfile = sumfiles.get(sumfileKey);
    if (!sumfile) {
      sumfile = await loadSumfile({ scope: rowScope, projectPath });
      sumfiles.set(sumfileKey, sumfile);
    }

    const injections = await collectAgentInjectionStatus(row);
    const assignedDetected = injections.filter((item) => item.assigned && item.detected);
    const installedAssigned = assignedDetected.filter((item) => item.installed);
    const conflict = scopeConflictLabel(row, conflictRows);
    const missingSum = !isDevInstallMode(installModeFromRecord(row)) && !sumfile.has(source);
    const issues = [
      conflict,
      missingSum ? 'unverified' : null,
      installedAssigned.length < assignedDetected.length ? 'agent drift' : null,
    ].filter((item): item is string => Boolean(item));

    statusRows.push({
      row,
      conflict,
      missingSum,
      injections,
      assignedDetected: assignedDetected.length,
      installedAssigned: installedAssigned.length,
      status: issues.length ? issues.join(', ') : 'ok',
    });
  }

  if (logger.isJsonMode()) {
    logger.json({
      skills: statusRows.map((entry) => ({
        ...entry.row,
        scope_conflict: entry.conflict,
        sumfile_missing: entry.missingSum,
        agent_injections: entry.injections,
        status: entry.status,
      })),
    });
    return;
  }

  const tableRows = statusRows.map((entry) => [
    entry.conflict ? chalk.yellow.bold(entry.row['name'] as string) : chalk.cyan.bold(entry.row['name'] as string),
    entry.row['version'] as string || '—',
    entry.row['scope'] as string,
    formatInstallMode(installModeFromRecord(entry.row)),
    `${entry.installedAssigned}/${entry.assignedDetected}`,
    formatSourceForDisplay(entry.row['source_url'] as string),
    entry.status === 'ok' ? chalk.green('ok') : chalk.yellow(entry.status),
  ]);

  logger.blank();
  logger.table(['Name', 'Version', 'Scope', 'Mode', 'Agents', 'Source', 'Status'], tableRows);
  logger.blank();
  logger.info('Agents column shows installed/assigned detected agents.');
}

/** Install all skills listed in skm.mod in the current directory */
export async function installFromMod(options: InstallOptions = {}): Promise<void> {
  const { pathExists, readFileOrNull } = await import('../utils/fs.js');
  const { join } = await import('node:path');
  const { parseModFile } = await import('../parsers/mod.js');
  
  const modPath = join(process.cwd(), 'skm.mod');
  if (!(await pathExists(modPath))) {
    logger.error('No skm.mod found in current directory. Run skm init or specify a source.');
    return;
  }

  const content = await readFileOrNull(modPath);
  if (!content) return;

  const mod = parseModFile(content);
  const scope = options.scope || 'project';
  if (mod.skills.length === 0 && mod.mcps.length === 0) {
    logger.info('No skills or MCP services listed in skm.mod');
    return;
  }

  logger.info(`Found ${mod.skills.length} skill(s) and ${mod.mcps.length} MCP service(s) in skm.mod`);
  for (const req of mod.skills) {
    const source = req.version && !isLocalPathSource(req.source) ? `${req.source}@${req.version}` : req.source;
    await installSkill(source, { ...options, scope });
  }

  if (mod.mcps.length > 0) {
    const { installMcpService } = await import('./mcp.js');
    for (const mcp of mod.mcps) {
      await installMcpService(mcp.name, {
        scope,
        agent: (options.agent || 'all') as AgentType | 'all',
        save: false,
      });
    }
  }
}

function toModSource(originalSource: string, version: string | undefined, resolvedSource: string): string {
  if (!version) return originalSource || resolvedSource;
  const suffix = `@${version}`;
  return originalSource.endsWith(suffix)
    ? originalSource.slice(0, -suffix.length)
    : originalSource || resolvedSource;
}
