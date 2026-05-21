import chalk from 'chalk';
import inquirer from 'inquirer';
import { getDb } from '../db/index.js';
import { detectAgents } from '../adapters/index.js';
import { logger } from '../utils/logger.js';
import type { InstallScope } from '../types/index.js';
import { installModeFromRecord } from '../utils/install_mode.js';

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

  const agentChoices = agents.map(a => ({ name: a.displayName, value: a }));

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

    const skills = db.prepare(query).all(...params) as Record<string, unknown>[];
    if (skills.length === 0) {
      logger.info('No skills installed yet.');
      return;
    }

    const { selectedSkill } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedSkill',
      message: 'Select a skill to assign:',
      choices: skills.map(s => ({
        name: `${s['name'] as string} (${s['scope'] as string})`,
        value: s,
      }))
    }]);

    const currentAssigned = selectedSkill['assigned_agents'] as string;
    let checkedAgents: string[];
    if (currentAssigned === 'all') {
      checkedAgents = agents.map(a => a.name);
    } else {
      try {
        checkedAgents = JSON.parse(currentAssigned);
      } catch {
        checkedAgents = agents.map(a => a.name);
      }
    }

    const { targetAgents } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'targetAgents',
      message: `Select agents to assign ${chalk.cyan(selectedSkill['name'] as string)} to:`,
      choices: agentChoices.map(c => ({
        ...c,
        checked: checkedAgents.includes(c.value.name)
      }))
    }]);

    const targetNames = targetAgents.map((a: any) => a.name);
    const dbValue = targetNames.length === agents.length ? 'all' : JSON.stringify(targetNames);
    
    db.prepare('UPDATE skills SET assigned_agents = ? WHERE id = ?').run(dbValue, selectedSkill['id']);

    // Apply changes immediately
    const scope = selectedSkill['scope'] as InstallScope;
    for (const agent of agents) {
      const isSelected = targetNames.includes(agent.name);
      const isInstalled = (await agent.listInstalled(scope)).some(s => s.name === selectedSkill['name']);

      if (isSelected && !isInstalled) {
        // Needs install
        const { parseSkillMd } = await import('../parsers/index.js');
        const skillPath = selectedSkill['installed_path'] as string;
        const frontmatter = await parseSkillMd(skillPath);
        if (frontmatter) {
          await agent.installSkill({
            frontmatter,
            localPath: skillPath,
            commit: selectedSkill['source_commit'] as string,
            integrity: selectedSkill['integrity'] as string,
          }, scope, { installMode: installModeFromRecord(selectedSkill) });
        }
      } else if (!isSelected && isInstalled) {
        // Needs uninstall
        await agent.uninstallSkill(selectedSkill['name'] as string, scope);
      }
    }

    logger.success(`Assignments updated for skill "${selectedSkill['name']}"`);

  } else {
    // List MCPs
    const mcps = db.prepare(`
      SELECT mc.*, s.name as skill_name, s.installed_path 
      FROM mcp_configs mc 
      JOIN skills s ON mc.skill_id = s.id 
      ORDER BY mc.name
    `).all() as Record<string, unknown>[];
    
    if (mcps.length === 0) {
      logger.info('No MCP services configured yet.');
      return;
    }

    const { selectedMcp } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedMcp',
      message: 'Select an MCP service to assign:',
      choices: mcps.map(m => ({ name: m['name'] as string, value: m }))
    }]);

    const currentAssigned = selectedMcp['agent_configs'] as string;
    let checkedAgents: string[];
    if (!currentAssigned || currentAssigned === '{}' || currentAssigned === 'all') {
      checkedAgents = agents.map(a => a.name);
    } else {
      try {
        const parsed = JSON.parse(currentAssigned);
        checkedAgents = Array.isArray(parsed) ? parsed : agents.map(a => a.name);
      } catch {
        checkedAgents = agents.map(a => a.name);
      }
    }

    const { targetAgents } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'targetAgents',
      message: `Select agents to assign MCP ${chalk.cyan(selectedMcp['name'] as string)} to:`,
      choices: agentChoices.map(c => ({
        ...c,
        checked: checkedAgents.includes(c.value.name)
      }))
    }]);

    const targetNames = targetAgents.map((a: any) => a.name);
    const dbValue = targetNames.length === agents.length ? 'all' : JSON.stringify(targetNames);
    
    db.prepare('UPDATE mcp_configs SET agent_configs = ? WHERE id = ?').run(dbValue, selectedMcp['id']);

    // Apply changes immediately
    for (const agent of agents) {
      const isSelected = targetNames.includes(agent.name);
      const configuredMcps = await agent.listConfiguredMCPs();
      const isConfigured = configuredMcps.some(m => m.name === selectedMcp['name']);

      if (isSelected && !isConfigured) {
        await agent.configureMCP({
          name: selectedMcp['name'] as string,
          command: selectedMcp['command'] as string,
          args: JSON.parse(selectedMcp['args'] as string || '[]'),
          envKeys: Object.keys(JSON.parse(selectedMcp['env'] as string || '{}'))
        }, JSON.parse(selectedMcp['env'] as string || '{}'));
      } else if (!isSelected && isConfigured) {
        await agent.removeMCP(selectedMcp['name'] as string);
      }
    }

    logger.success(`Assignments updated for MCP "${selectedMcp['name']}"`);
  }
}
