/**
 * Agent sync — ensure all detected agents have the same skills installed
 *
 * Like `conda env export` + `conda env create`, this synchronizes
 * the skill set across all detected agents on the system.
 */
import chalk from 'chalk';
import ora from 'ora';
import { join } from 'node:path';
import type { AgentType, InstallMode, InstallScope } from '../types/index.js';
import { detectAgents, getAllAdapters, resolveAdapters } from '../adapters/index.js';
import { getDb, genId } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { getDefaultConfig, unifiedProjectSkillsDir } from '../utils/platform.js';
import { pathExists } from '../utils/fs.js';
import { cloneOrPull, checkout, repoUrlToLocalPath } from '../utils/git.js';
import { fileUrlFromPath, isLocalPathSource, localPathFromSource } from '../utils/path_source.js';
import { parseSourceString } from '../parsers/index.js';
import {
  defaultInstallModeForScope,
  installModeFromRecord,
  isSymlinkInstallMode,
  legacyIsLinkedValue,
} from '../utils/install_mode.js';
import { loadSumfile, saveSumfile, updateSumfileEntry } from './sumfile.js';

/** Sync skills across all detected agents */
export async function syncAgents(
  options: { scope?: InstallScope; agent?: AgentType | 'all' } = {}
): Promise<void> {
  const scope = options.scope || 'global';
  const targetAgent = options.agent;
  const forceApply = Boolean(targetAgent);
  const spinner = ora('Detecting agents...').start();

  const agents = targetAgent ? await resolveAdapters(targetAgent) : await detectAgents();
  if (agents.length === 0) {
    spinner.fail('No agents detected');
    return;
  }

  spinner.text = 'Loading installed skills...';
  const db = await getDb();
  const projectPath = scope === 'project' ? process.cwd() : '';
  const skills = db
    .prepare('SELECT * FROM skills WHERE scope = ? AND project_path = ?')
    .all(scope, projectPath) as Record<string, unknown>[];
  const projectOverrideNames = scope === 'global'
    ? new Set((db
        .prepare("SELECT name FROM skills WHERE scope = 'project' AND project_path = ?")
        .all(process.cwd()) as { name: string }[]).map((row) => row.name))
    : new Set<string>();
  const globalNames = scope === 'project'
    ? new Set((db
        .prepare("SELECT name FROM skills WHERE scope = 'global' AND project_path = ''")
        .all() as { name: string }[]).map((row) => row.name))
    : new Set<string>();

  if (skills.length === 0) {
    spinner.info('No skills to sync');
    const { syncMcpServices } = await import('./mcp.js');
    await syncMcpServices({ scope, agent: targetAgent });
    return;
  }

  spinner.text = `Syncing ${skills.length} skill(s) to ${agents.length} agent(s)...`;

  let synced = 0;
  for (const agent of agents) {
    const existing = await agent.listInstalled(scope);
    const existingNames = new Set(existing.map((s) => s.name));

    for (const skill of skills) {
      const name = skill['name'] as string;
      const assigned = skill['assigned_agents'] as string;

      if (scope === 'global' && projectOverrideNames.has(name)) {
        if (existingNames.has(name)) {
          await agent.uninstallSkill(name, 'global');
          logger.agent(agent.displayName, `Skipped global ${name}; current project has an override`);
        }
        continue;
      }
      
      let isAssigned = false;
      if (!assigned || assigned === 'all') {
        isAssigned = true;
      } else {
        try {
          const parsed = JSON.parse(assigned);
          isAssigned = Array.isArray(parsed) && parsed.includes(agent.name);
        } catch {
          isAssigned = true;
        }
      }

      if (forceApply) {
        isAssigned = true;
      }

      if (!isAssigned) {
        if (existingNames.has(name)) {
          // Uninstall if it's not assigned but is installed
          await agent.uninstallSkill(name, scope);
          logger.agent(agent.displayName, `Unsynced (removed) ${name}`);
        }
        continue;
      }

      if (scope === 'project' && globalNames.has(name)) {
        await agent.uninstallSkill(name, 'global');
      }

      if (existingNames.has(name)) {
        if (forceApply) {
          updateSkillAssignment(db, skill, targetAgent || 'all', agents.map((a) => a.name));
        }
        continue;
      }

      try {
        // This skill is in DB but not in this agent — deploy it
        const { parseSkillMd } = await import('../parsers/index.js');
        const skillPath = await resolveSkillSourcePath(db, skill);
        const frontmatter = await parseSkillMd(skillPath);
        await agent.installSkill(
          {
            frontmatter: frontmatter || { name, description: skill['description'] as string || '' },
            localPath: skillPath,
            commit: skill['source_commit'] as string,
            integrity: skill['integrity'] as string,
          },
          scope,
          { installMode: installModeFromRecord(skill) }
        );
        synced++;
        logger.agent(agent.displayName, `Synced ${name}`);
        updateSkillAssignment(db, skill, targetAgent || 'all', agents.map((a) => a.name));

        // Also sync MCP configs
        if (frontmatter?.mcp?.length) {
          const { getMcpConfig } = await import('./mcp_registry.js');
          for (const mcpName of frontmatter.mcp) {
            const configRow = db.prepare('SELECT agent_configs FROM mcp_configs WHERE name = ?').get(mcpName) as { agent_configs: string } | undefined;
            const mcpAssigned = configRow?.agent_configs;
            
            let isMcpAssigned = true;
            if (mcpAssigned && mcpAssigned !== 'all' && mcpAssigned !== '{}') {
              try {
                const parsed = JSON.parse(mcpAssigned);
                isMcpAssigned = Array.isArray(parsed) && parsed.includes(agent.name);
              } catch {
                isMcpAssigned = true;
              }
            }

            if (isMcpAssigned) {
              const config = await getMcpConfig(mcpName);
              await agent.configureMCP(config, {}, scope); // Assume silent sync
            }
          }
        }
      } catch (err) {
        logger.warn(`Failed to sync ${name} to ${agent.displayName}: ${(err as Error).message}`);
      }
    }
  }

  spinner.succeed(`Synced ${synced} skill(s) across ${agents.length} agent(s)`);

  const { syncMcpServices } = await import('./mcp.js');
  await syncMcpServices({ scope, agent: targetAgent });
}

async function resolveSkillSourcePath(
  db: Awaited<ReturnType<typeof getDb>>,
  skill: Record<string, unknown>
): Promise<string> {
  const skillName = skill['name'] as string;
  const installedPath = skill['installed_path'] as string;

  if (await hasSkillSource(installedPath)) {
    return installedPath;
  }

  const sourceUrl = skill['source_url'] as string;
  const recoveredPath = await recoverSkillSourcePath(sourceUrl, skill['source_commit'] as string, installedPath);
  if (recoveredPath && await hasSkillSource(recoveredPath)) {
    const installMode = installModeFromRecord(skill);
    db.prepare('UPDATE skills SET installed_path = ?, symlink_target = ?, updated_at = ? WHERE id = ?')
      .run(
        recoveredPath,
        isSymlinkInstallMode(installMode) ? recoveredPath : null,
        new Date().toISOString(),
        skill['id']
      );
    logger.warn(`Refreshed missing cache for skill "${skillName}" from ${sourceUrl}`);
    return recoveredPath;
  }

  throw new Error(
    `Skill source for "${skillName}" is missing at ${installedPath}. ` +
    `Run skm update ${skillName} or reinstall it.`
  );
}

async function recoverSkillSourcePath(
  sourceUrl: string,
  commit: string,
  previousInstalledPath: string
): Promise<string | null> {
  if (!sourceUrl) return null;

  if (isLocalPathSource(sourceUrl)) {
    const localPath = localPathFromSource(sourceUrl);
    return await hasSkillSource(localPath) ? localPath : null;
  }

  const { repoUrl, skillPath } = parseSourceString(sourceUrl);
  const repoDir = await cloneOrPull(repoUrl, getDefaultConfig().cacheDir);
  if (commit && commit !== 'linked' && commit !== 'unknown') {
    await checkout(repoDir, commit);
  }

  const recoveredSkillPath = skillPath || inferSkillPathFromPreviousInstall(previousInstalledPath, repoUrl);
  return recoveredSkillPath ? join(repoDir, recoveredSkillPath) : repoDir;
}

async function hasSkillSource(skillPath: string | undefined): Promise<boolean> {
  return Boolean(skillPath) && await pathExists(join(skillPath as string, 'SKILL.md'));
}

function inferSkillPathFromPreviousInstall(previousInstalledPath: string, repoUrl: string): string | undefined {
  const marker = repoUrlToLocalPath(repoUrl).split(/[\\/]+/).filter(Boolean);
  if (marker.length === 0) return undefined;

  const parts = previousInstalledPath.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index <= parts.length - marker.length; index++) {
    if (marker.every((part, offset) => parts[index + offset] === part)) {
      const remainder = parts.slice(index + marker.length);
      return remainder.length > 0 ? remainder.join('/') : undefined;
    }
  }

  return undefined;
}

function parseAssignedAgents(value: string | undefined): string[] {
  if (!value || value === 'all') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mergedAssignment(existing: string | undefined, targetAgent: AgentType | 'all', agentNames: AgentType[]): string {
  if (targetAgent === 'all') return 'all';
  const merged = new Set(parseAssignedAgents(existing));
  for (const agentName of agentNames) merged.add(agentName);
  return JSON.stringify(Array.from(merged));
}

function updateSkillAssignment(
  db: Awaited<ReturnType<typeof getDb>>,
  skill: Record<string, unknown>,
  targetAgent: AgentType | 'all',
  agentNames: AgentType[]
): void {
  const assignedAgents = mergedAssignment(skill['assigned_agents'] as string | undefined, targetAgent, agentNames);
  db.prepare('UPDATE skills SET assigned_agents = ?, updated_at = ? WHERE id = ?')
    .run(assignedAgents, new Date().toISOString(), skill['id'] as string);
}

/** Promote a project skill to global scope and apply it to target agent(s). */
export async function promoteSkillToGlobal(
  skillName: string,
  options: { agent?: AgentType | 'all'; removeProject?: boolean } = {}
): Promise<void> {
  const targetAgent = options.agent || 'all';
  const db = await getDb();
  const projectPath = process.cwd();
  const projectSkill = db.prepare(`
    SELECT *
    FROM skills
    WHERE name = ? AND scope = 'project' AND project_path = ?
    LIMIT 1
  `).get(skillName, projectPath) as Record<string, unknown> | undefined;

  if (!projectSkill) {
    const globalSkill = db.prepare(`
      SELECT id
      FROM skills
      WHERE name = ? AND scope = 'global' AND project_path = ''
      LIMIT 1
    `).get(skillName) as { id: string } | undefined;

    if (globalSkill) {
      logger.info(`Skill "${skillName}" is already global`);
      return;
    }

    logger.error(`Project skill "${skillName}" is not managed by skm`);
    return;
  }

  const agents = await resolveAdapters(targetAgent);
  if (agents.length === 0) {
    logger.warn('No target agents found for skill promotion.');
    return;
  }

  const { parseSkillMd } = await import('../parsers/index.js');
  let installedPath: string;
  try {
    installedPath = await resolveSkillSourcePath(db, projectSkill);
  } catch (err) {
    logger.error((err as Error).message);
    return;
  }
  const frontmatter = await parseSkillMd(installedPath);
  const skillPackage = {
    frontmatter: frontmatter || {
      name: skillName,
      description: (projectSkill['description'] as string) || '',
    },
    localPath: installedPath,
    sourceUrl: projectSkill['source_url'] as string,
    commit: projectSkill['source_commit'] as string,
    integrity: projectSkill['integrity'] as string,
  };

  const successfulAgents: typeof agents = [];
  for (const agent of agents) {
    try {
      await agent.installSkill(skillPackage, 'global', { installMode: 'copy' });
      if (options.removeProject) {
        await agent.uninstallSkill(skillName, 'project');
      }
      successfulAgents.push(agent);
    } catch (err) {
      logger.warn(`Failed to promote ${skillName} on ${agent.displayName}: ${(err as Error).message}`);
    }
  }

  if (successfulAgents.length === 0) {
    logger.error(`Failed to promote skill "${skillName}" to any target agent`);
    return;
  }

  const now = new Date().toISOString();
  const globalInstalledPath = join(successfulAgents[0].getSkillsDir('global'), skillName);
  const promotedLocal = isProjectLocalSkill(projectSkill);
  const globalSourceUrl = promotedLocal
    ? fileUrlFromPath(globalInstalledPath)
    : projectSkill['source_url'] as string;
  const globalSourceCommit = promotedLocal
    ? 'local'
    : projectSkill['source_commit'] as string;
  const globalSkillPackage = {
    ...skillPackage,
    localPath: globalInstalledPath,
    sourceUrl: globalSourceUrl,
    commit: globalSourceCommit,
  };
  const existingGlobal = db.prepare(`
    SELECT id, assigned_agents
    FROM skills
    WHERE name = ? AND scope = 'global' AND project_path = ''
    LIMIT 1
  `).get(skillName) as { id: string; assigned_agents: string } | undefined;
  const assignedAgents = existingGlobal
    ? mergedAssignment(existingGlobal.assigned_agents, targetAgent, agents.map((agent) => agent.name))
    : mergedAssignment(undefined, targetAgent, agents.map((agent) => agent.name));

  if (existingGlobal) {
    db.prepare(`
      UPDATE skills SET
        source_url = ?, source_commit = ?, version = ?, description = ?,
        alias = ?, installed_path = ?, unified_path = NULL, symlink_target = NULL, integrity = ?,
        install_mode = 'copy', is_linked = 0, assigned_agents = ?, updated_at = ?
      WHERE id = ?
    `).run(
      globalSourceUrl,
      globalSourceCommit,
      projectSkill['version'],
      projectSkill['description'],
      projectSkill['alias'] || null,
      globalInstalledPath,
      projectSkill['integrity'] || '',
      assignedAgents,
      now,
      existingGlobal.id
    );
  } else {
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, ?, ?, ?, ?, ?, 'global', '', ?, ?, NULL, ?, 'copy', 0, ?, ?, ?)
    `).run(
      genId(),
      skillName,
      globalSourceUrl,
      globalSourceCommit,
      projectSkill['version'],
      projectSkill['description'],
      projectSkill['alias'] || null,
      globalInstalledPath,
      projectSkill['integrity'] || '',
      now,
      now,
      assignedAgents
    );
  }

  if (options.removeProject && targetAgent === 'all') {
    const projectSumfile = await loadSumfile({ scope: 'project', projectPath });
    projectSumfile.delete(projectSkill['source_url'] as string || skillName);
    await saveSumfile(projectSumfile, { scope: 'project', projectPath });

    db.prepare('DELETE FROM project_skills WHERE installed_skill_id = ?').run(projectSkill['id']);
    db.prepare('DELETE FROM skills WHERE id = ?').run(projectSkill['id']);
  } else if (options.removeProject) {
    logger.warn('Project DB record was kept because --remove-project only removes records when promoting to all agents.');
  }

  const globalSumfile = await loadSumfile({ scope: 'global' });
  updateSumfileEntry(globalSumfile, globalSkillPackage);
  await saveSumfile(globalSumfile, { scope: 'global' });

  logger.success(`Promoted skill "${skillName}" to global scope`);
}

function isProjectLocalSkill(skill: Record<string, unknown>): boolean {
  const source = String(skill['source_url'] || '').replace(/\\/g, '/');
  return source === '.'
    || source.startsWith('./.agents/skills/')
    || source.startsWith('.agents/skills/')
    || skill['source_commit'] === 'local';
}

/** Demote a global skill into the current project scope and apply it to target agent(s). */
export async function demoteSkillToProject(
  skillName: string,
  options: { agent?: AgentType | 'all'; mode?: InstallMode } = {}
): Promise<void> {
  const targetAgent = options.agent || 'all';
  const db = await getDb();
  const projectPath = process.cwd();
  const globalSkill = db.prepare(`
    SELECT *
    FROM skills
    WHERE name = ? AND scope = 'global' AND project_path = ''
    LIMIT 1
  `).get(skillName) as Record<string, unknown> | undefined;

  if (!globalSkill) {
    const projectSkill = db.prepare(`
      SELECT id
      FROM skills
      WHERE name = ? AND scope = 'project' AND project_path = ?
      LIMIT 1
    `).get(skillName, projectPath) as { id: string } | undefined;

    if (projectSkill) {
      logger.info(`Skill "${skillName}" is already project-scoped`);
      return;
    }

    logger.error(`Global skill "${skillName}" is not managed by skm`);
    return;
  }

  const agents = await resolveAdapters(targetAgent);
  if (agents.length === 0) {
    logger.warn('No target agents found for skill demotion.');
    return;
  }

  const sourceUrl = globalSkill['source_url'] as string;
  const requestedMode = !sourceUrl.startsWith('file://') && options.mode === 'symlink-dev'
    ? 'symlink-cache'
    : options.mode;
  const installMode = requestedMode || (sourceUrl.startsWith('file://') ? 'symlink-dev' : defaultInstallModeForScope('project'));
  let installedPath: string;
  try {
    installedPath = await resolveSkillSourcePath(db, globalSkill);
  } catch (err) {
    logger.error((err as Error).message);
    return;
  }
  const { parseSkillMd } = await import('../parsers/index.js');
  const frontmatter = await parseSkillMd(installedPath);
  const skillPackage = {
    frontmatter: frontmatter || {
      name: skillName,
      description: (globalSkill['description'] as string) || '',
    },
    localPath: installedPath,
    sourceUrl,
    commit: globalSkill['source_commit'] as string,
    integrity: globalSkill['integrity'] as string,
  };

  for (const agent of agents) {
    try {
      await agent.installSkill(skillPackage, 'project', { installMode });
      await agent.uninstallSkill(skillName, 'global');
    } catch (err) {
      logger.warn(`Failed to demote ${skillName} on ${agent.displayName}: ${(err as Error).message}`);
    }
  }

  const now = new Date().toISOString();
  const assignedAgents = mergedAssignment(undefined, targetAgent, agents.map((agent) => agent.name));
  const symlinkTarget = isSymlinkInstallMode(installMode) ? installedPath : null;
  const unifiedPath = join(unifiedProjectSkillsDir(projectPath), skillName);
  const isLinked = legacyIsLinkedValue(installMode);
  const existingProject = db.prepare(`
    SELECT id
    FROM skills
    WHERE name = ? AND scope = 'project' AND project_path = ?
    LIMIT 1
  `).get(skillName, projectPath) as { id: string } | undefined;

  let projectSkillId: string;
  if (existingProject) {
    db.prepare(`
      UPDATE skills SET
        source_url = ?, source_commit = ?, version = ?, description = ?,
        alias = ?, installed_path = ?, unified_path = ?, symlink_target = ?, integrity = ?,
        install_mode = ?, is_linked = ?, assigned_agents = ?, updated_at = ?
      WHERE id = ?
    `).run(
      sourceUrl,
      globalSkill['source_commit'],
      globalSkill['version'],
      globalSkill['description'],
      globalSkill['alias'] || null,
      installedPath,
      unifiedPath,
      symlinkTarget,
      globalSkill['integrity'] || '',
      installMode,
      isLinked,
      assignedAgents,
      now,
      existingProject.id
    );
    projectSkillId = existingProject.id;
  } else {
    projectSkillId = genId();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, ?, ?, ?, ?, ?, 'project', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectSkillId,
      skillName,
      sourceUrl,
      globalSkill['source_commit'],
      globalSkill['version'],
      globalSkill['description'],
      projectPath,
      globalSkill['alias'] || null,
      installedPath,
      unifiedPath,
      symlinkTarget,
      globalSkill['integrity'] || '',
      installMode,
      isLinked,
      now,
      now,
      assignedAgents
    );
  }

  db.prepare(`
    INSERT INTO project_skills (id, project_path, skill_source, version, installed_skill_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_path, skill_source) DO UPDATE SET
      version = excluded.version,
      installed_skill_id = excluded.installed_skill_id
  `).run(genId(), projectPath, sourceUrl, globalSkill['version'] || null, projectSkillId);

  if (targetAgent === 'all') {
    const globalSumfile = await loadSumfile({ scope: 'global' });
    globalSumfile.delete(sourceUrl);
    await saveSumfile(globalSumfile, { scope: 'global' });

    db.prepare('DELETE FROM skills WHERE id = ?').run(globalSkill['id']);
  }

  const projectSumfile = await loadSumfile({ scope: 'project', projectPath });
  updateSumfileEntry(projectSumfile, skillPackage);
  await saveSumfile(projectSumfile, { scope: 'project', projectPath });

  logger.success(`Demoted skill "${skillName}" to project scope`);
}

/** Show per-agent configuration details */
export async function showAgentConfig(agentName: string): Promise<void> {
  const all = getAllAdapters();
  const agent = all.find((a) => a.name === agentName || a.displayName.toLowerCase().includes(agentName.toLowerCase()));

  if (!agent) {
    logger.error(`Agent "${agentName}" not found`);
    logger.info(`Available agents: ${all.map((a) => a.name).join(', ')}`);
    return;
  }

  const detected = await agent.detect();

  logger.blank();
  console.log(chalk.bold(`  ${agent.displayName}`));
  logger.blank();
  console.log(`  Name:       ${agent.name}`);
  console.log(`  Status:     ${detected ? chalk.green('✔ detected') : chalk.red('✖ not found')}`);
  console.log(`  Global dir: ${agent.getSkillsDir('global')}`);
  console.log(`  Project dir: ${agent.getSkillsDir('project')}`);

  if (detected) {
    logger.blank();
    console.log(chalk.bold('  Global Skills:'));
    const globalSkills = await agent.listInstalled('global');
    if (globalSkills.length === 0) {
      console.log('    (none)');
    } else {
      for (const s of globalSkills) {
        const indicator = s.hasSkillMd ? chalk.green('●') : chalk.gray('○');
        console.log(`    ${indicator} ${s.name}${s.description ? chalk.gray(` — ${s.description}`) : ''}`);
      }
    }

    logger.blank();
    console.log(chalk.bold('  Project Skills:'));
    const projectSkills = await agent.listInstalled('project');
    if (projectSkills.length === 0) {
      console.log('    (none)');
    } else {
      for (const s of projectSkills) {
        const indicator = s.hasSkillMd ? chalk.green('●') : chalk.gray('○');
        console.log(`    ${indicator} ${s.name}${s.description ? chalk.gray(` — ${s.description}`) : ''}`);
      }
    }
  }

  logger.blank();
}
