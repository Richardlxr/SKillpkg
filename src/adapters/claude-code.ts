/**
 * Claude Code Adapter
 */
import type { AgentType, InstallScope, McpRegistryEntry, DiscoveredMcp } from '../types/index.js';
import { AGENT_PATHS } from '../utils/platform.js';
import { pathExists, readJsonFile, readJsonFileForUpdate, writeJsonFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { BaseAdapter } from './base.js';

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name: AgentType = 'claude-code';
  readonly displayName = 'Claude Code';

  getSkillsDir(scope: InstallScope): string {
    return scope === 'global'
      ? AGENT_PATHS['claude-code'].global()
      : AGENT_PATHS['claude-code'].project(process.cwd());
  }

  async detect(): Promise<boolean> {
    return pathExists(AGENT_PATHS['claude-code'].global());
  }

  async configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS['claude-code'].mcpConfig(scope);
    if (!configPath) return;

    if (scope === 'project') {
      await this.removeLegacyProjectMcpEntries(mcp.name);
    }

    const config = await readJsonFileForUpdate<Record<string, unknown>>(configPath);
    const mcpServers = (config['mcpServers'] as Record<string, unknown>) || {};
    const serverName = this.mcpServerName(mcp.name);

    this.removeMcpServerEntries(mcpServers, mcp.name);
    mcpServers[serverName] = isRemoteMcp(mcp)
      ? {
        type: mcp.type,
        url: mcp.url,
      }
      : {
        command: mcp.command,
        args: mcp.args || [],
        env: env || {},
      };

    config['mcpServers'] = mcpServers;
    await writeJsonFile(configPath, config);
    logger.agent(this.displayName, `Configured MCP: ${serverName}`);
  }

  async removeMCP(mcpName: string, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS['claude-code'].mcpConfig(scope);
    if (!configPath) return;

    let removed = false;
    const config = await readJsonFileForUpdate<Record<string, unknown>>(configPath);
    const mcpServers = (config['mcpServers'] as Record<string, unknown>) || {};

    if (this.removeMcpServerEntries(mcpServers, mcpName)) {
      config['mcpServers'] = mcpServers;
      await writeJsonFile(configPath, config);
      removed = true;
    }

    if (scope === 'project' && await this.removeLegacyProjectMcpEntries(mcpName)) {
      removed = true;
    }

    if (removed) {
      logger.agent(this.displayName, `Removed MCP: ${this.mcpServerName(mcpName)}`);
    }
  }

  async listConfiguredMCPs(): Promise<DiscoveredMcp[]> {
    const results = await this.parseJsonMcpConfigs([
      { path: AGENT_PATHS['claude-code'].mcpConfig('global') },
      { path: AGENT_PATHS['claude-code'].mcpConfig('project') },
    ]);

    const local = await this.parseLocalProjectMcpConfig();
    return [...results, ...local];
  }

  private async parseLocalProjectMcpConfig(): Promise<DiscoveredMcp[]> {
    const configPath = AGENT_PATHS['claude-code'].mcpConfig('global');
    const config = await readJsonFile<Record<string, unknown>>(configPath);
    if (!config) return [];

    const projects = config['projects'] as Record<string, Record<string, unknown>> | undefined;
    const project = projects?.[process.cwd()];
    const mcpServers = project?.['mcpServers'] as Record<string, Record<string, unknown>> | undefined;
    if (!mcpServers) return [];

    return Object.entries(mcpServers).map(([name, serverConfig]) => ({
      name,
      command: (serverConfig['command'] as string) || (serverConfig['url'] as string) || 'unknown',
      args: serverConfig['args'] as string[] | undefined,
      agent: this.displayName,
      source: 'config' as const,
    }));
  }

  private async removeLegacyProjectMcpEntries(mcpName: string): Promise<boolean> {
    const configPath = AGENT_PATHS['claude-code'].mcpConfig('global');
    if (!(await pathExists(configPath))) return false;

    const config = await readJsonFileForUpdate<Record<string, unknown>>(configPath);
    const projects = config['projects'] as Record<string, Record<string, unknown>> | undefined;
    const project = projects?.[process.cwd()];
    if (!project) return false;

    const mcpServers = project?.['mcpServers'] as Record<string, unknown> | undefined;
    if (!mcpServers) return false;

    const removed = this.removeMcpServerEntries(mcpServers, mcpName);
    if (!removed) return false;

    project['mcpServers'] = mcpServers;
    await writeJsonFile(configPath, config);
    return true;
  }
}

function isRemoteMcp(mcp: McpRegistryEntry): mcp is McpRegistryEntry & { type: 'http' | 'sse'; url: string } {
  return (mcp.type === 'http' || mcp.type === 'sse') && Boolean(mcp.url);
}
