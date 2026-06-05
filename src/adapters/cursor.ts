/**
 * Cursor Adapter
 */
import type { AgentType, InstallScope, McpRegistryEntry, DiscoveredMcp } from '../types/index.js';
import { AGENT_PATHS } from '../utils/platform.js';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { normalizeMcpArgs } from '../utils/mcp_paths.js';
import { logger } from '../utils/logger.js';
import { BaseAdapter } from './base.js';

export class CursorAdapter extends BaseAdapter {
  readonly name: AgentType = 'cursor';
  readonly displayName = 'Cursor';

  getSkillsDir(scope: InstallScope): string {
    return scope === 'global'
      ? AGENT_PATHS.cursor.global()
      : AGENT_PATHS.cursor.project(process.cwd());
  }

  async detect(): Promise<boolean> {
    return pathExists(AGENT_PATHS.cursor.global());
  }

  async configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.cursor.mcpConfig(scope);
    if (!configPath) return;

    const config = (await readJsonFile<Record<string, unknown>>(configPath)) || { mcpServers: {} };
    const mcpServers = (config['mcpServers'] as Record<string, unknown>) || {};
    const serverName = this.mcpServerName(mcp.name);

    this.removeMcpServerEntries(mcpServers, mcp.name);
    mcpServers[serverName] = isRemoteMcp(mcp)
      ? {
        type: mcp.type,
        url: mcp.url,
      }
      : {
        type: 'stdio',
        command: mcp.command,
        args: await normalizeMcpArgs(mcp.args || []),
        env: env || {},
      };

    config['mcpServers'] = mcpServers;
    await writeJsonFile(configPath, config);
    logger.agent(this.displayName, `Configured MCP: ${serverName}`);
  }

  async removeMCP(mcpName: string, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.cursor.mcpConfig(scope);
    if (!configPath) return;

    const config = (await readJsonFile<Record<string, unknown>>(configPath)) || {};
    const mcpServers = (config['mcpServers'] as Record<string, unknown>) || {};

    if (this.removeMcpServerEntries(mcpServers, mcpName)) {
      config['mcpServers'] = mcpServers;
      await writeJsonFile(configPath, config);
      logger.agent(this.displayName, `Removed MCP: ${this.mcpServerName(mcpName)}`);
    }
  }

  async listConfiguredMCPs(): Promise<DiscoveredMcp[]> {
    return this.parseJsonMcpConfigs([
      { path: AGENT_PATHS.cursor.mcpConfig('global') },
      { path: AGENT_PATHS.cursor.mcpConfig('project') },
    ]);
  }
}

function isRemoteMcp(mcp: McpRegistryEntry): mcp is McpRegistryEntry & { type: 'http' | 'sse'; url: string } {
  return (mcp.type === 'http' || mcp.type === 'sse') && Boolean(mcp.url);
}
