/**
 * Antigravity CLI Adapter
 */
import type { AgentType, InstallScope, McpRegistryEntry, DiscoveredMcp } from '../types/index.js';
import { dirname } from 'node:path';
import { AGENT_PATHS } from '../utils/platform.js';
import { pathExists, readJsonFile, writeJsonFile } from '../utils/fs.js';
import { normalizeMcpArgs } from '../utils/mcp_paths.js';
import { logger } from '../utils/logger.js';
import { BaseAdapter } from './base.js';

export class AntigravityCliAdapter extends BaseAdapter {
  readonly name: AgentType = 'antigravity-cli';
  readonly displayName = 'Antigravity CLI';

  getSkillsDir(scope: InstallScope): string {
    return scope === 'global'
      ? AGENT_PATHS['antigravity-cli'].global()
      : AGENT_PATHS['antigravity-cli'].project(process.cwd());
  }

  async detect(): Promise<boolean> {
    const configDir = dirname(AGENT_PATHS['antigravity-cli'].settingsConfig());
    return (
      await pathExists(configDir) ||
      await pathExists(AGENT_PATHS['antigravity-cli'].global()) ||
      await pathExists(AGENT_PATHS['antigravity-cli'].mcpConfig('global'))
    );
  }

  async configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS['antigravity-cli'].mcpConfig(scope);
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
        args: await normalizeMcpArgs(mcp.args || []),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };

    config['mcpServers'] = mcpServers;
    await writeJsonFile(configPath, config);
    logger.agent(this.displayName, `Configured MCP: ${serverName}`);
  }

  async removeMCP(mcpName: string, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS['antigravity-cli'].mcpConfig(scope);
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
      { path: AGENT_PATHS['antigravity-cli'].mcpConfig('global') },
      { path: AGENT_PATHS['antigravity-cli'].mcpConfig('project') },
    ]);
  }
}

function isRemoteMcp(mcp: McpRegistryEntry): mcp is McpRegistryEntry & { type: 'http' | 'sse'; url: string } {
  return (mcp.type === 'http' || mcp.type === 'sse') && Boolean(mcp.url);
}
