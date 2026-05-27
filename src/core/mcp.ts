/**
 * MCP service management commands
 *
 * MCPs can be managed independently from skills. Managed MCPs are recorded
 * with project/global scope so they can be promoted and re-applied to agents.
 */
import chalk from 'chalk';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getDb, genId } from '../db/index.js';
import { detectAgents, getAllAdapters, resolveAdapters } from '../adapters/index.js';
import { logger } from '../utils/logger.js';
import { looksLikeMcpAppName, toMcpServerName } from '../utils/mcp_names.js';
import type { AgentAdapter, AgentType, DiscoveredMcp, InstallScope, McpRegistryEntry } from '../types/index.js';

const execAsync = promisify(exec);

type TargetAgent = AgentType | 'all';

interface ManagedMcpRow {
  id: string;
  name: string;
  source: string;
  type: string;
  command: string;
  args: string;
  env: string;
  scope: InstallScope;
  project_path: string;
  assigned_agents: string;
  installed_at: string;
  updated_at: string;
}

interface McpInstallOptions {
  agent?: TargetAgent;
  scope?: InstallScope;
  save?: boolean;
}

interface McpRemoveOptions {
  save?: boolean;
}

/** Scan agent config files for MCP services not tracked in the DB */
async function discoverMcpFromConfigs(): Promise<DiscoveredMcp[]> {
  const results: DiscoveredMcp[] = [];
  const adapters = getAllAdapters();

  for (const adapter of adapters) {
    try {
      const mcps = await adapter.listConfiguredMCPs();
      results.push(...mcps);
    } catch (err) {
      logger.debug(`Failed to read MCP config for ${adapter.displayName}: ${(err as Error).message}`);
    }
  }

  return results;
}

function projectPathForScope(scope: InstallScope): string {
  return scope === 'project' ? process.cwd() : '';
}

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToConfig(row: ManagedMcpRow): McpRegistryEntry {
  if (row.type === 'http' || row.type === 'sse') {
    return {
      name: row.name,
      type: row.type,
      url: row.command,
      command: '',
      args: [],
      envKeys: Object.keys(parseJsonValue<Record<string, string>>(row.env, {})),
    };
  }

  return {
    name: row.name,
    type: 'stdio',
    command: row.command,
    args: parseJsonValue<string[]>(row.args, []),
    envKeys: Object.keys(parseJsonValue<Record<string, string>>(row.env, {})),
  };
}

function rowToEnv(row: ManagedMcpRow): Record<string, string> {
  return parseJsonValue<Record<string, string>>(row.env, {});
}

function isUnsupportedManagedMcpRow(row: ManagedMcpRow): boolean {
  if (row.type === 'http' || row.type === 'sse') return false;

  const references = [
    row.name,
    row.source,
    row.command,
    ...parseJsonValue<string[]>(row.args, []),
  ];
  return references.some((value) => looksLikeMcpAppName(value));
}

function assignmentFor(targetAgent: TargetAgent, agentNames: AgentType[], scope: InstallScope): string {
  if (targetAgent === 'all' && scope !== 'project') return 'all';
  return JSON.stringify(agentNames);
}

function mergeAssignment(
  existing: string | null | undefined,
  targetAgent: TargetAgent,
  agentNames: AgentType[],
  scope: InstallScope
): string {
  if (targetAgent === 'all' && scope !== 'project') return 'all';
  if (targetAgent === 'all') return JSON.stringify(agentNames);
  if (!existing || existing === 'all') return JSON.stringify(agentNames);

  const parsed = parseJsonValue<string[]>(existing, []);
  const merged = new Set<string>(parsed);
  for (const agentName of agentNames) merged.add(agentName);
  return JSON.stringify(Array.from(merged));
}

function removeAssignment(existing: string | null | undefined, targetAgent: TargetAgent, agentNames: AgentType[]): string {
  if (targetAgent === 'all') return '[]';
  if (!existing || existing === 'all') return existing || 'all';

  const toRemove = new Set<string>(agentNames);
  const parsed = parseJsonValue<string[]>(existing, []);
  return JSON.stringify(parsed.filter((agentName) => !toRemove.has(agentName)));
}

async function assignedAgentNamesForScope(
  assigned: string | null | undefined,
  scope: InstallScope
): Promise<AgentType[]> {
  if (assigned && assigned !== 'all') {
    return parseJsonValue<AgentType[]>(assigned, []);
  }

  const detected = await detectAgents();
  return detected
    .filter((agent) => scope !== 'project' || agentSupportsProjectMcp(agent))
    .map((agent) => agent.name);
}

async function removeMcpInstallationAssignments(
  db: Database.Database,
  row: ManagedMcpRow,
  movedAgentNames: AgentType[]
): Promise<boolean> {
  const moved = new Set(movedAgentNames);
  const remaining = (await assignedAgentNamesForScope(row.assigned_agents, row.scope))
    .filter((agentName) => !moved.has(agentName));

  if (remaining.length === 0) {
    db.prepare('DELETE FROM mcp_installations WHERE id = ?').run(row.id);
    return true;
  }

  db.prepare('UPDATE mcp_installations SET assigned_agents = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(remaining), new Date().toISOString(), row.id);
  return false;
}

function formatAssigned(assigned: string | null | undefined): string {
  if (!assigned || assigned === 'all') return 'all';
  const parsed = parseJsonValue<string[]>(assigned, []);
  return parsed.length > 0 ? parsed.join(',') : 'none';
}

function agentSupportsProjectMcp(agent: AgentAdapter): boolean {
  return ['antigravity-cli', 'claude-code', 'codex', 'cursor'].includes(agent.name);
}

function filterAgentsForMcpScope(agents: AgentAdapter[], scope: InstallScope): AgentAdapter[] {
  if (scope !== 'project') return agents;

  const supported = agents.filter(agentSupportsProjectMcp);
  for (const agent of agents) {
    if (!agentSupportsProjectMcp(agent)) {
      logger.warn(`Skipping ${agent.displayName}: project-scoped MCP configuration is not supported.`);
    }
  }

  return supported;
}

function currentManagedMcpRows(db: Database.Database): ManagedMcpRow[] {
  return db.prepare(`
    SELECT *
    FROM mcp_installations
    WHERE (scope = 'global' AND project_path = '')
       OR (scope = 'project' AND project_path = ?)
    ORDER BY name
  `).all(process.cwd()) as ManagedMcpRow[];
}

function upsertMcpInstallation(
  db: Database.Database,
  source: string,
  config: McpRegistryEntry,
  env: Record<string, string>,
  scope: InstallScope,
  targetAgent: TargetAgent,
  agentNames: AgentType[]
): void {
  const now = new Date().toISOString();
  const projectPath = projectPathForScope(scope);
  const type = config.type || (config.url ? 'http' : 'stdio');
  const command = type === 'http' || type === 'sse' ? (config.url || config.command) : config.command;
  const existing = db.prepare(`
    SELECT id, assigned_agents
    FROM mcp_installations
    WHERE scope = ? AND project_path = ? AND (name = ? OR source = ?)
    ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(scope, projectPath, config.name, source, config.name) as { id: string; assigned_agents: string } | undefined;

  const assignedAgents = existing
    ? mergeAssignment(existing.assigned_agents, targetAgent, agentNames, scope)
    : assignmentFor(targetAgent, agentNames, scope);

  if (existing) {
    db.prepare(`
      UPDATE mcp_installations SET
        name = ?,
        source = ?,
        type = ?,
        command = ?,
        args = ?,
        env = ?,
        assigned_agents = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      config.name,
      source,
      type,
      command,
      JSON.stringify(config.args || []),
      JSON.stringify(env || {}),
      assignedAgents,
      now,
      existing.id
    );
    return;
  }

  db.prepare(`
    INSERT INTO mcp_installations
      (id, name, source, type, command, args, env, scope, project_path, assigned_agents, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name, scope, project_path) DO UPDATE SET
      source = excluded.source,
      type = excluded.type,
      command = excluded.command,
      args = excluded.args,
      env = excluded.env,
      assigned_agents = excluded.assigned_agents,
      updated_at = excluded.updated_at
  `).run(
    genId(),
    config.name,
    source,
    type,
    command,
    JSON.stringify(config.args || []),
    JSON.stringify(env || {}),
    scope,
    projectPath,
    assignedAgents,
    now,
    now
  );
}

function updateMcpAssignment(
  db: Database.Database,
  row: ManagedMcpRow,
  targetAgent: TargetAgent,
  agentNames: AgentType[],
  scope: InstallScope
): void {
  const assignedAgents = mergeAssignment(row.assigned_agents, targetAgent, agentNames, scope);
  db.prepare('UPDATE mcp_installations SET assigned_agents = ?, updated_at = ? WHERE id = ?')
    .run(assignedAgents, new Date().toISOString(), row.id);
}

async function updateMcpSumfile(source: string, config: McpRegistryEntry, scope: InstallScope): Promise<void> {
  const { loadSumfile, saveSumfile, updateMcpSumfileEntry } = await import('./sumfile.js');
  const projectPath = projectPathForScope(scope);
  const target = { scope, projectPath };
  const sumfile = await loadSumfile(target);
  updateMcpSumfileEntry(sumfile, source, config);
  await saveSumfile(sumfile, target);
}

async function removeMcpSumfile(source: string, scope: InstallScope, projectPath: string): Promise<void> {
  const { loadSumfile, removeMcpSumfileEntry, saveSumfile } = await import('./sumfile.js');
  const target = { scope, projectPath };
  const sumfile = await loadSumfile(target);
  removeMcpSumfileEntry(sumfile, source);
  await saveSumfile(sumfile, target);
}

async function saveProjectMcpRequirement(source: string, options: { save?: boolean } = {}): Promise<void> {
  const { saveMcpRequirement } = await import('./modfile.js');
  await saveMcpRequirement(source, {
    save: options.save,
    allowCreate: true,
  });
}

async function removeProjectMcpRequirement(source: string, options: { save?: boolean } = {}): Promise<void> {
  if (options.save === false) return;
  const { removeMcpRequirement } = await import('./modfile.js');
  await removeMcpRequirement(source);
}

/** Install an MCP service independently and record it for future sync/promote. */
export async function installMcpService(name: string, options: McpInstallOptions = {}): Promise<void> {
  const { getMcpConfigs, promptForMcpEnv } = await import('./mcp_registry.js');
  const scope = options.scope || 'global';
  const targetAgent = options.agent || 'all';
  const configs = await getMcpConfigs(name);
  const agentsToInstall = filterAgentsForMcpScope(await resolveAdapters(targetAgent), scope);

  if (configs.length === 0) {
    logger.warn(`No MCP services resolved for "${name}".`);
    return;
  }

  if (agentsToInstall.length === 0) {
    logger.warn('No target agents found for MCP deployment.');
    return;
  }

  const db = await getDb();
  let installed = 0;

  for (const config of configs) {
    const source = config.source || name;
    const env = await promptForMcpEnv(config);

    for (const agent of agentsToInstall) {
      try {
        await agent.configureMCP(config, env, scope);
      } catch (e) {
        logger.warn(`Failed to configure MCP on ${agent.displayName}: ${(e as Error).message}`);
      }
    }

    upsertMcpInstallation(
      db,
      source,
      config,
      env,
      scope,
      targetAgent,
      agentsToInstall.map((agent) => agent.name)
    );
    await updateMcpSumfile(source, config, scope);
    if (scope === 'project') {
      await saveProjectMcpRequirement(source, { save: options.save });
    }
    installed++;
  }

  if (installed === 1) {
    logger.success(`Installed MCP "${configs[0].name}" (${scope})`);
  } else {
    logger.success(`Installed ${installed} MCP service(s) (${scope})`);
  }
  if (scope === 'project') {
    const { handleProjectGitTracking } = await import('./git_tracking.js');
    await handleProjectGitTracking();
  }
}

/** Backward-compatible wrapper for the CLI command. */
export async function addMcpService(
  name: string,
  targetOrOptions: string | McpInstallOptions = 'all'
): Promise<void> {
  const options: McpInstallOptions = typeof targetOrOptions === 'string'
    ? { agent: targetOrOptions as TargetAgent }
    : targetOrOptions;
  await installMcpService(name, options);
}

/** Remove an independently installed MCP service. */
export async function removeMcpService(
  name: string,
  targetAgent: string = 'all',
  scope: InstallScope = 'global',
  options: McpRemoveOptions = {}
): Promise<void> {
  const db = await getDb();
  const agentsToRemove = filterAgentsForMcpScope(await resolveAdapters(targetAgent as TargetAgent), scope);

  if (agentsToRemove.length === 0) {
    logger.warn('No target agents found for MCP removal.');
    return;
  }

  const projectPath = projectPathForScope(scope);
  const row = db.prepare(`
    SELECT *
    FROM mcp_installations
    WHERE scope = ? AND project_path = ? AND (name = ? OR source = ? OR name = ?)
    ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(scope, projectPath, name, name, toMcpServerName(name), name) as ManagedMcpRow | undefined;
  const configuredName = row?.name || toMcpServerName(name);

  for (const agent of agentsToRemove) {
    try {
      await agent.removeMCP(configuredName, scope);
    } catch (e) {
      logger.warn(`Failed to remove MCP from ${agent.displayName}: ${(e as Error).message}`);
    }
  }

  if (!row) return;

  let rowDeleted = false;
  if (targetAgent === 'all') {
    db.prepare('DELETE FROM mcp_installations WHERE id = ?').run(row.id);
    rowDeleted = true;
  } else {
    const removedAgentNames = agentsToRemove.map((agent) => agent.name);
    const nextAssignment = row.assigned_agents === 'all'
      ? JSON.stringify(filterAgentsForMcpScope(await detectAgents(), scope)
        .map((agent) => agent.name)
        .filter((agentName) => !removedAgentNames.includes(agentName)))
      : removeAssignment(row.assigned_agents, targetAgent as TargetAgent, removedAgentNames);
    const nextAgents = parseJsonValue<string[]>(nextAssignment, []);
    if (nextAssignment !== 'all' && nextAgents.length === 0) {
      db.prepare('DELETE FROM mcp_installations WHERE id = ?').run(row.id);
      rowDeleted = true;
    } else {
      db.prepare('UPDATE mcp_installations SET assigned_agents = ?, updated_at = ? WHERE id = ?')
        .run(nextAssignment, new Date().toISOString(), row.id);
    }
  }

  if (rowDeleted) {
    await removeMcpSumfile(row.source, row.scope, row.project_path);
    if (row.scope === 'project') {
      await removeProjectMcpRequirement(row.source, options);
    }
  }
}

/** Apply managed MCP services for a scope to one or all agents. */
export async function syncMcpServices(
  options: { scope?: InstallScope; agent?: TargetAgent } = {}
): Promise<void> {
  const scope = options.scope || 'global';
  const targetAgent = options.agent || 'all';
  const db = await getDb();
  const projectPath = projectPathForScope(scope);
  const rows = db.prepare(`
    SELECT *
    FROM mcp_installations
    WHERE scope = ? AND project_path = ?
    ORDER BY name
  `).all(scope, projectPath) as ManagedMcpRow[];

  if (rows.length === 0) {
    logger.info(`No managed MCP services to sync (${scope})`);
    return;
  }

  const agents = filterAgentsForMcpScope(await resolveAdapters(targetAgent), scope);
  if (agents.length === 0) {
    logger.warn('No target agents found for MCP sync.');
    return;
  }

  let synced = 0;
  let skipped = 0;
  for (const row of rows) {
    if (isUnsupportedManagedMcpRow(row)) {
      logger.warn(`Skipping MCP "${row.name}": MCP App/HTTP servers cannot be synced as stdio servers.`);
      skipped++;
      continue;
    }

    const config = rowToConfig(row);
    const env = rowToEnv(row);

    for (const agent of agents) {
      try {
        await agent.configureMCP(config, env, scope);
        synced++;
      } catch (e) {
        logger.warn(`Failed to sync MCP ${row.name} to ${agent.displayName}: ${(e as Error).message}`);
      }
    }

    updateMcpAssignment(db, row, targetAgent, agents.map((agent) => agent.name), scope);
  }

  logger.success(`Synced ${rows.length - skipped} MCP service(s) to ${agents.length} agent(s) (${scope})`);
  if (skipped > 0) {
    logger.warn(`Skipped ${skipped} unsupported MCP App/HTTP service(s). Remove them with skm mcp remove if they are no longer needed.`);
  }
  logger.debug(`MCP config writes: ${synced}`);
}

/** Promote a project MCP to global scope and apply it to target agent(s). */
export async function promoteMcpService(
  name: string,
  options: { agent?: TargetAgent } = {}
): Promise<void> {
  const targetAgent = options.agent || 'all';
  const db = await getDb();
  const projectPath = process.cwd();
  const row = db.prepare(`
    SELECT *
    FROM mcp_installations
    WHERE scope = 'project'
      AND project_path = ?
      AND (name = ? OR source = ?)
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(projectPath, name, name) as ManagedMcpRow | undefined;

  if (!row) {
    const globalRow = db.prepare(`
      SELECT id
      FROM mcp_installations
      WHERE scope = 'global' AND project_path = '' AND (name = ? OR source = ?)
      LIMIT 1
    `).get(name, name) as { id: string } | undefined;

    if (globalRow) {
      logger.info(`MCP "${name}" is already global`);
      return;
    }

    logger.error(`Project MCP "${name}" is not managed by skm`);
    return;
  }

  if (isUnsupportedManagedMcpRow(row)) {
    logger.error(`Project MCP "${row.name}" appears to be an MCP App/HTTP server and cannot be promoted as stdio.`);
    return;
  }

  const agents = await resolveAdapters(targetAgent);
  if (agents.length === 0) {
    logger.warn('No target agents found for MCP promotion.');
    return;
  }

  const config = rowToConfig(row);
  const env = rowToEnv(row);
  const appliedAgents: AgentType[] = [];

  for (const agent of agents) {
    try {
      await agent.configureMCP(config, env, 'global');
      if (agentSupportsProjectMcp(agent)) {
        await agent.removeMCP(config.name, 'project');
      }
      appliedAgents.push(agent.name);
    } catch (e) {
      logger.warn(`Failed to promote MCP ${row.name} on ${agent.displayName}: ${(e as Error).message}`);
    }
  }

  if (appliedAgents.length === 0) {
    logger.warn(`MCP "${row.name}" was not promoted to any agent.`);
    return;
  }

  upsertMcpInstallation(db, row.source, config, env, 'global', targetAgent, appliedAgents);
  await updateMcpSumfile(row.source, config, 'global');
  const projectRowDeleted = await removeMcpInstallationAssignments(db, row, appliedAgents);
  if (projectRowDeleted) {
    await removeMcpSumfile(row.source, 'project', row.project_path);
    await removeProjectMcpRequirement(row.source);
  }
  logger.success(`Promoted MCP "${config.name}" to global scope`);
}

/** Demote a global MCP to project scope and apply it to target agent(s). */
export async function demoteMcpService(
  name: string,
  options: { agent?: TargetAgent } = {}
): Promise<void> {
  const targetAgent = options.agent || 'all';
  const db = await getDb();
  const projectPath = process.cwd();
  const row = db.prepare(`
    SELECT *
    FROM mcp_installations
    WHERE scope = 'global'
      AND project_path = ''
      AND (name = ? OR source = ? OR name = ?)
    ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(name, name, toMcpServerName(name), name) as ManagedMcpRow | undefined;

  if (!row) {
    const projectRow = db.prepare(`
      SELECT id
      FROM mcp_installations
      WHERE scope = 'project' AND project_path = ? AND (name = ? OR source = ? OR name = ?)
      LIMIT 1
    `).get(projectPath, name, name, toMcpServerName(name)) as { id: string } | undefined;

    if (projectRow) {
      logger.info(`MCP "${name}" is already project-scoped`);
      return;
    }

    logger.error(`Global MCP "${name}" is not managed by skm`);
    return;
  }

  if (isUnsupportedManagedMcpRow(row)) {
    logger.error(`Global MCP "${row.name}" appears to be an MCP App/HTTP server and cannot be demoted as stdio.`);
    return;
  }

  const agents = filterAgentsForMcpScope(await resolveAdapters(targetAgent), 'project');
  if (agents.length === 0) {
    logger.warn('No target agents found for MCP demotion.');
    return;
  }

  const config = rowToConfig(row);
  const env = rowToEnv(row);
  const appliedAgents: AgentType[] = [];

  for (const agent of agents) {
    try {
      await agent.configureMCP(config, env, 'project');
      await agent.removeMCP(config.name, 'global');
      appliedAgents.push(agent.name);
    } catch (e) {
      logger.warn(`Failed to demote MCP ${row.name} on ${agent.displayName}: ${(e as Error).message}`);
    }
  }

  if (appliedAgents.length === 0) {
    logger.warn(`MCP "${row.name}" was not demoted to any agent.`);
    return;
  }

  upsertMcpInstallation(db, row.source, config, env, 'project', targetAgent, appliedAgents);
  await updateMcpSumfile(row.source, config, 'project');
  await saveProjectMcpRequirement(row.source);
  const globalRowDeleted = await removeMcpInstallationAssignments(db, row, appliedAgents);
  if (globalRowDeleted) {
    await removeMcpSumfile(row.source, 'global', row.project_path);
  }

  const { handleProjectGitTracking } = await import('./git_tracking.js');
  await handleProjectGitTracking();

  logger.success(`Demoted MCP "${config.name}" to project scope`);
}

/** List all configured MCP services */
export async function listMcpServices(): Promise<void> {
  const db = await getDb();

  const skillRows = db.prepare(`
    SELECT mc.*, s.name as skill_name, s.scope
    FROM mcp_configs mc
    JOIN skills s ON mc.skill_id = s.id
    ORDER BY mc.name
  `).all() as Record<string, unknown>[];
  const managedRows = currentManagedMcpRows(db);

  const configMcps = await discoverMcpFromConfigs();
  const dbNames = new Set<string>([
    ...skillRows.map((r) => r['name'] as string),
    ...managedRows.map((r) => r.name),
  ]);
  const extraFromConfig = configMcps.filter((m) => !dbNames.has(m.name));

  const totalCount = skillRows.length + managedRows.length + extraFromConfig.length;

  if (totalCount === 0) {
    logger.info('No MCP services configured');
    logger.info('MCP services can be installed with skm mcp add or declared in skm.mod');
    return;
  }

  const tableHead = ['Service', 'Command', 'Agent/Skill', 'Source'];
  const tableRows: string[][] = [];

  for (const row of managedRows) {
    tableRows.push([
      chalk.cyan.bold(row.name),
      row.command,
      `${row.scope}:${formatAssigned(row.assigned_agents)}`,
      chalk.cyan('skm')
    ]);
  }

  for (const row of skillRows) {
    tableRows.push([
      chalk.cyan.bold(row['name'] as string),
      row['command'] as string,
      `${row['skill_name'] as string} (${row['scope'] as string})`,
      chalk.cyan('skm')
    ]);
  }

  for (const mcp of extraFromConfig) {
    tableRows.push([
      chalk.yellow.bold(mcp.name),
      mcp.command,
      mcp.agent,
      chalk.yellow('config')
    ]);
  }

  logger.blank();
  logger.table(tableHead, tableRows);
  logger.blank();
  logger.info(`Total: ${totalCount} MCP service(s)`);
  if (extraFromConfig.length > 0) {
    logger.info(`  ${chalk.cyan('skm')}: managed by skm  ${chalk.yellow('config')}: found in agent config files`);
  }
}

/** Check MCP service status (whether command is available) */
export async function checkMcpStatus(): Promise<void> {
  const db = await getDb();

  const skillRows = db.prepare(`
    SELECT mc.*, s.name as skill_name
    FROM mcp_configs mc
    JOIN skills s ON mc.skill_id = s.id
    ORDER BY mc.name
  `).all() as Record<string, unknown>[];
  const managedRows = currentManagedMcpRows(db);

  const configMcps = await discoverMcpFromConfigs();
  const dbNames = new Set<string>([
    ...skillRows.map((r) => r['name'] as string),
    ...managedRows.map((r) => r.name),
  ]);
  const extraFromConfig = configMcps.filter((m) => !dbNames.has(m.name));

  const allServices: { name: string; command: string; type?: string }[] = [
    ...managedRows.map((r) => ({ name: r.name, command: r.command, type: r.type })),
    ...skillRows.map((r) => ({ name: r['name'] as string, command: r['command'] as string })),
    ...extraFromConfig.map((m) => ({ name: m.name, command: m.command })),
  ];

  if (allServices.length === 0) {
    logger.info('No MCP services to check');
    return;
  }

  const uniqueServices = Array.from(
    new Map(allServices.map((s) => [`${s.name}:${s.command}`, s])).values()
  );

  logger.blank();
  console.log(chalk.bold('  MCP Service Status'));
  logger.blank();

  for (const svc of uniqueServices) {
    if (svc.type === 'http' || svc.type === 'sse' || /^https?:\/\//i.test(svc.command)) {
      console.log(`  ${svc.name.padEnd(25)} ${chalk.green('remote')}  ${chalk.gray(`(${svc.command})`)}`);
      continue;
    }

    let available = false;
    try {
      const checkCmd = process.platform === 'win32'
        ? `where ${svc.command} 2>nul`
        : `command -v ${svc.command} 2>/dev/null`;
      await execAsync(checkCmd);
      available = true;
    } catch {
      // Command not found
    }

    const status = available
      ? chalk.green('✔ available')
      : chalk.red('✖ not found');

    console.log(`  ${svc.name.padEnd(25)} ${status}  ${chalk.gray(`(${svc.command})`)}`);
  }

  logger.blank();

  const agents = await detectAgents();
  console.log(chalk.bold('  Agent MCP Support'));
  logger.blank();
  for (const agent of agents) {
    console.log(`  ${agent.displayName.padEnd(25)} ${chalk.green('✔ detected')}`);
  }
  logger.blank();
}
