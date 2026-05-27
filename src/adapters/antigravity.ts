/**
 * Antigravity 2.0 / Editor Adapter
 */
import type { AgentType, InstallScope, McpRegistryEntry, DiscoveredMcp } from '../types/index.js';
import { AGENT_PATHS } from '../utils/platform.js';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { BaseAdapter } from './base.js';

export class AntigravityAdapter extends BaseAdapter {
  readonly name: AgentType = 'antigravity';
  readonly displayName = 'Antigravity 2.0 / Editor';

  getSkillsDir(scope: InstallScope): string {
    return scope === 'global'
      ? AGENT_PATHS.antigravity.global()
      : AGENT_PATHS.antigravity.project(process.cwd());
  }

  async detect(): Promise<boolean> {
    return pathExists(AGENT_PATHS.antigravity.global());
  }

  async configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, _scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.antigravity.mcpConfig();
    if (!configPath) return;

    const config = (await readJsonFile<Record<string, unknown>>(configPath)) || {};
    const mcpServers = (config['mcpServers'] as Record<string, unknown>) || {};
    const serverName = this.mcpServerName(mcp.name);

    this.removeMcpServerEntries(mcpServers, mcp.name);
    mcpServers[serverName] = isRemoteMcp(mcp)
      ? {
        serverUrl: mcp.url,
      }
      : {
        command: mcp.command,
        args: mcp.args || [],
        ...(env && Object.keys(env).length > 0 ? { env: env } : {}),
      };

    config['mcpServers'] = mcpServers;
    await writeJsonFile(configPath, config);
    logger.agent(this.displayName, `Configured MCP: ${serverName}`);
  }

  async removeMCP(mcpName: string, _scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.antigravity.mcpConfig();
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
    return this.parseJsonMcpConfig(AGENT_PATHS.antigravity.mcpConfig());
  }
}

function isRemoteMcp(mcp: McpRegistryEntry): mcp is McpRegistryEntry & { type: 'http' | 'sse'; url: string } {
  return (mcp.type === 'http' || mcp.type === 'sse') && Boolean(mcp.url);
}
