import chalk from 'chalk';
import inquirer from 'inquirer';
import { getDb } from '../db/index.js';
import { detectAgents } from '../adapters/index.js';
import { logger } from '../utils/logger.js';
import type { AgentAdapter, AgentType, InstallScope, McpRegistryEntry } from '../types/index.js';
import { installModeFromRecord } from '../utils/install_mode.js';
import {
  promptForSearchableSingleSelection,
  SELECT_ALL_CHOICE_VALUE,
  withCheckboxHint,
} from '../utils/searchable_selection.js';

type SkillAssignmentRow = Record<string, unknown> & {
  id: string;
  name: string;
  scope: InstallScope;
  assigned_agents: string;
  installed_path: string;
  source_commit: string;
  integrity: string;
};

type LegacyMcpAssignmentTarget = {
  kind: 'legacy';
  id: string;
  name: string;
  type: string;
  command: string;
  args: string;
  env: string;
  assigned: string;
  scope: InstallScope;
  source: string;
};

type ManagedMcpAssignmentTarget = {
  kind: 'managed';
  id: string;
  name: string;
  type: string;
  command: string;
  args: string;
  env: string;
  assigned: string;
  scope: InstallScope;
  source: string;
};

type McpAssignmentTarget = LegacyMcpAssignmentTarget | ManagedMcpAssignmentTarget;

export async function assignInteractive(options: { scope?: InstallScope } = {}): Promise<void> {
  const db = await getDb();
  
  // 1. Ask what to assign
  const { assignType } = await inquirer.prompt([{
    type: 'list',
    name: 'assignType',
    message: 'What would you like to assign?',
    choices: [
      { name: 'Skill', value: 'skill' },
      { name: 'MCP Service', value: 'mcp' }
    ]
  }]);

  const agents = await detectAgents();
  if (agents.length === 0) {
    logger.error('No agents detected on this system.');
    return;
  }

  if (assignType === 'skill') {
    // List skills
    let query = "SELECT * FROM skills WHERE (scope = 'global' AND project_path = '') OR (scope = 'project' AND project_path = ?)";
    const params: unknown[] = [process.cwd()];
    if (options.scope === 'global') {
      query = "SELECT * FROM skills WHERE scope = 'global' AND project_path = ''";
      params.length = 0;
    } else if (options.scope === 'project') {
      query = "SELECT * FROM skills WHERE scope = 'project' AND project_path = ?";
    }
    query += ' ORDER BY name, scope';

    const skills = db.prepare(query).all(...params) as SkillAssignmentRow[];
    if (skills.length === 0) {
      logger.info('No skills installed yet.');
      return;
    }

    const selectedSkillId = await promptForSearchableSingleSelection({
      choices: skills.map(s => ({
        name: `${s.name} (${s.scope})`,
        value: s.id,
        searchable: `${s.name} ${s.scope} ${s['source_url'] as string || ''} ${s['description'] as string || ''}`,
      })),
      itemLabel: 'skills',
      queryName: 'skillSearch',
      selectionName: 'selectedSkill',
      searchMessage: (total) => `Search skills by name/source/scope (${total} found, leave blank for all):`,
      selectMessage: (matched, total, search) => search
        ? `Found ${matched} of ${total} skills matching "${search}". Select one to assign:`
        : `Found ${total} skills. Select one to assign:`,
      noMatchesMessage: (search) => `No skills matched "${search}". Try another keyword or leave blank to show all.`,
    });
    const selectedSkill = skills.find(s => s.id === selectedSkillId);
    if (!selectedSkill) {
      logger.error('Selected skill was not found.');
      return;
    }

    const checkedAgents = assignedAgentNames(selectedSkill.assigned_agents, agents);
    const targetNames = await promptForAgentNames(agents, {
      message: `Select agents to assign ${chalk.cyan(selectedSkill.name)} to:`,
      checkedAgents,
    });

    const dbValue = targetNames.length === agents.length ? 'all' : JSON.stringify(targetNames);
    
    db.prepare('UPDATE skills SET assigned_agents = ? WHERE id = ?').run(dbValue, selectedSkill.id);

    // Apply changes immediately
    const scope = selectedSkill.scope;
    for (const agent of agents) {
      const isSelected = targetNames.includes(agent.name);
      const isInstalled = (await agent.listInstalled(scope)).some(s => s.name === selectedSkill.name);

      if (isSelected && !isInstalled) {
        // Needs install
        const { parseSkillMd } = await import('../parsers/index.js');
        const skillPath = selectedSkill.installed_path;
        const frontmatter = await parseSkillMd(skillPath);
        if (frontmatter) {
          await agent.installSkill({
            frontmatter,
            localPath: skillPath,
            commit: selectedSkill.source_commit,
            integrity: selectedSkill.integrity,
          }, scope, { installMode: installModeFromRecord(selectedSkill) });
        }
      } else if (!isSelected && isInstalled) {
        // Needs uninstall
        await agent.uninstallSkill(selectedSkill.name, scope);
      }
    }

    logger.success(`Assignments updated for skill "${selectedSkill.name}"`);

  } else {
    // List MCPs
    const mcps = loadMcpAssignmentTargets(db, options.scope);
    
    if (mcps.length === 0) {
      logger.info('No MCP services configured yet.');
      return;
    }

    const selectedMcpKey = await promptForSearchableSingleSelection({
      choices: mcps.map(m => ({
        name: `${m.name} (${m.scope}, ${m.kind === 'managed' ? 'managed' : 'skill'})`,
        value: `${m.kind}:${m.id}`,
        searchable: `${m.name} ${m.scope} ${m.source} ${m.command} ${m.type}`,
      })),
      itemLabel: 'MCP services',
      queryName: 'mcpSearch',
      selectionName: 'selectedMcp',
      searchMessage: (total) => `Search MCP services by name/source/scope (${total} found, leave blank for all):`,
      selectMessage: (matched, total, search) => search
        ? `Found ${matched} of ${total} MCP services matching "${search}". Select one to assign:`
        : `Found ${total} MCP services. Select one to assign:`,
      noMatchesMessage: (search) => `No MCP services matched "${search}". Try another keyword or leave blank to show all.`,
    });
    const selectedMcp = mcps.find(m => `${m.kind}:${m.id}` === selectedMcpKey);
    if (!selectedMcp) {
      logger.error('Selected MCP service was not found.');
      return;
    }

    const assignableAgents = filterAgentsForMcpScope(agents, selectedMcp.scope);
    if (assignableAgents.length === 0) {
      logger.warn(`No detected agents support ${selectedMcp.scope}-scoped MCP assignment.`);
      return;
    }

    const checkedAgents = assignedAgentNames(selectedMcp.assigned, assignableAgents);
    const targetNames = await promptForAgentNames(assignableAgents, {
      message: `Select agents to assign MCP ${chalk.cyan(selectedMcp.name)} to:`,
      checkedAgents,
    });

    const dbValue = targetNames.length === assignableAgents.length ? 'all' : JSON.stringify(targetNames);
    
    if (selectedMcp.kind === 'managed') {
      db.prepare('UPDATE mcp_installations SET assigned_agents = ?, updated_at = ? WHERE id = ?')
        .run(dbValue, new Date().toISOString(), selectedMcp.id);
    } else {
      db.prepare('UPDATE mcp_configs SET agent_configs = ? WHERE id = ?').run(dbValue, selectedMcp.id);
    }

    // Apply changes immediately
    const config = mcpTargetConfig(selectedMcp);
    const env = parseJsonValue<Record<string, string>>(selectedMcp.env, {});
    for (const agent of assignableAgents) {
      const isSelected = targetNames.includes(agent.name);
      const configuredMcps = await agent.listConfiguredMCPs();
      const isConfigured = configuredMcps.some(m => m.name === selectedMcp.name);

      if (isSelected && !isConfigured) {
        await agent.configureMCP(config, env, selectedMcp.scope);
      } else if (!isSelected && isConfigured) {
        await agent.removeMCP(selectedMcp.name, selectedMcp.scope);
      }
    }

    logger.success(`Assignments updated for MCP "${selectedMcp.name}"`);
  }
}

function loadMcpAssignmentTargets(
  db: Awaited<ReturnType<typeof getDb>>,
  scope?: InstallScope
): McpAssignmentTarget[] {
  const managedParams: unknown[] = [process.cwd()];
  let managedWhere = "(scope = 'global' AND project_path = '') OR (scope = 'project' AND project_path = ?)";
  if (scope === 'global') {
    managedWhere = "scope = 'global' AND project_path = ''";
    managedParams.length = 0;
  } else if (scope === 'project') {
    managedWhere = "scope = 'project' AND project_path = ?";
  }

  const managed = db.prepare(`
    SELECT id, name, source, type, command, args, env, assigned_agents, scope
    FROM mcp_installations
    WHERE ${managedWhere}
    ORDER BY name, scope
  `).all(...managedParams) as Record<string, unknown>[];

  const legacyParams: unknown[] = [process.cwd()];
  let legacyWhere = "(s.scope = 'global' AND s.project_path = '') OR (s.scope = 'project' AND s.project_path = ?)";
  if (scope === 'global') {
    legacyWhere = "s.scope = 'global' AND s.project_path = ''";
    legacyParams.length = 0;
  } else if (scope === 'project') {
    legacyWhere = "s.scope = 'project' AND s.project_path = ?";
  }

  const legacy = db.prepare(`
    SELECT mc.id, mc.name, mc.type, mc.command, mc.args, mc.env, mc.agent_configs, s.scope, s.source_url
    FROM mcp_configs mc
    JOIN skills s ON mc.skill_id = s.id
    WHERE ${legacyWhere}
    ORDER BY mc.name, s.scope
  `).all(...legacyParams) as Record<string, unknown>[];

  return [
    ...managed.map((row): ManagedMcpAssignmentTarget => ({
      kind: 'managed',
      id: row['id'] as string,
      name: row['name'] as string,
      source: row['source'] as string,
      type: row['type'] as string || 'stdio',
      command: row['command'] as string,
      args: row['args'] as string || '[]',
      env: row['env'] as string || '{}',
      assigned: row['assigned_agents'] as string || 'all',
      scope: row['scope'] as InstallScope,
    })),
    ...legacy.map((row): LegacyMcpAssignmentTarget => ({
      kind: 'legacy',
      id: row['id'] as string,
      name: row['name'] as string,
      source: row['source_url'] as string,
      type: row['type'] as string || 'stdio',
      command: row['command'] as string,
      args: row['args'] as string || '[]',
      env: row['env'] as string || '{}',
      assigned: row['agent_configs'] as string || 'all',
      scope: row['scope'] as InstallScope,
    })),
  ];
}

async function promptForAgentNames(
  agents: AgentAdapter[],
  options: { message: string; checkedAgents: string[] }
): Promise<AgentType[]> {
  const choices: Array<{ name: string; value: string; checked: boolean }> = agents.map(agent => ({
    name: agent.displayName,
    value: agent.name,
    checked: options.checkedAgents.includes(agent.name),
  }));

  if (agents.length > 1) {
    choices.unshift({
      name: 'All agents',
      value: SELECT_ALL_CHOICE_VALUE,
      checked: false,
    });
  }

  const { targetAgents } = await inquirer.prompt<{ targetAgents: string[] }>([{
    type: 'checkbox',
    name: 'targetAgents',
    message: withCheckboxHint(options.message),
    choices,
  }]);

  if (targetAgents.includes(SELECT_ALL_CHOICE_VALUE)) {
    return agents.map(agent => agent.name);
  }

  return targetAgents.filter((name): name is AgentType =>
    agents.some(agent => agent.name === name)
  );
}

function assignedAgentNames(assigned: string | null | undefined, agents: AgentAdapter[]): string[] {
  if (!assigned || assigned === '{}' || assigned === 'all') {
    return agents.map(agent => agent.name);
  }

  const parsed = parseJsonValue<string[]>(assigned, []);
  return Array.isArray(parsed) ? parsed : agents.map(agent => agent.name);
}

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mcpTargetConfig(target: McpAssignmentTarget): McpRegistryEntry {
  const env = parseJsonValue<Record<string, string>>(target.env, {});
  if (target.type === 'http' || target.type === 'sse') {
    return {
      name: target.name,
      type: target.type,
      url: target.command,
      command: '',
      args: [],
      envKeys: Object.keys(env),
    };
  }

  return {
    name: target.name,
    type: 'stdio',
    command: target.command,
    args: parseJsonValue<string[]>(target.args, []),
    envKeys: Object.keys(env),
  };
}

function filterAgentsForMcpScope(agents: AgentAdapter[], scope: InstallScope): AgentAdapter[] {
  if (scope !== 'project') return agents;
  return agents.filter(agent => ['antigravity-cli', 'claude-code', 'codex', 'cursor'].includes(agent.name));
}
