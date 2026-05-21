/**
 * Codex (OpenAI) Adapter
 */
import type { AgentType, InstallScope, McpRegistryEntry, DiscoveredMcp } from '../types/index.js';
import { AGENT_PATHS } from '../utils/platform.js';
import { pathExists, readFileOrNull, writeFileSafe } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { BaseAdapter } from './base.js';

export class CodexAdapter extends BaseAdapter {
  readonly name: AgentType = 'codex';
  readonly displayName = 'Codex (OpenAI)';

  getSkillsDir(scope: InstallScope): string {
    return scope === 'global'
      ? AGENT_PATHS.codex.global()
      : AGENT_PATHS.codex.project(process.cwd());
  }

  async detect(): Promise<boolean> {
    return pathExists(AGENT_PATHS.codex.global());
  }

  async configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.codex.mcpConfig(scope);
    if (!configPath) return;

    const existing = await readFileOrNull(configPath);
    const next = upsertCodexMcpBlock(existing || '', mcp, env || {});
    await writeFileSafe(configPath, next);
    logger.agent(this.displayName, `Configured MCP: ${mcp.name}`);
  }

  async removeMCP(mcpName: string, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.codex.mcpConfig(scope);
    if (!configPath) return;

    const existing = await readFileOrNull(configPath);
    if (!existing) return;

    const next = removeCodexMcpBlock(existing, mcpName);
    if (next !== existing) {
      await writeFileSafe(configPath, next);
      logger.agent(this.displayName, `Removed MCP: ${mcpName}`);
    }
  }

  async listConfiguredMCPs(): Promise<DiscoveredMcp[]> {
    const byName = new Map<string, DiscoveredMcp>();

    for (const configPath of [
      AGENT_PATHS.codex.mcpConfig('global'),
      AGENT_PATHS.codex.mcpConfig('project'),
    ]) {
      const content = await readFileOrNull(configPath);
      if (content) {
        for (const mcp of parseCodexMcpServers(content, this.displayName)) {
          byName.set(mcp.name, mcp);
        }
      }
    }

    // Backward compatibility for older project-level .mcp.json files.
    for (const mcp of await this.parseJsonMcpConfig(AGENT_PATHS.codex.legacyMcpConfig())) {
      if (!byName.has(mcp.name)) {
        byName.set(mcp.name, mcp);
      }
    }

    return Array.from(byName.values());
  }
}

function upsertCodexMcpBlock(content: string, mcp: McpRegistryEntry, env: Record<string, string>): string {
  const cleaned = removeCodexMcpBlock(content, mcp.name).trimEnd();
  const block = buildCodexMcpBlock(mcp, env);
  return `${cleaned}${cleaned ? '\n\n' : ''}${block}\n`;
}

function removeCodexMcpBlock(content: string, mcpName: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const tableName = parseCodexMcpTableName(line);
    if (tableName) {
      skipping = tableName === mcpName;
    } else if (skipping && line.trim().startsWith('[')) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join('\n').trimEnd() + (kept.length > 0 ? '\n' : '');
}

function buildCodexMcpBlock(mcp: McpRegistryEntry, env: Record<string, string>): string {
  const lines = [
    `[mcp_servers.${tomlKey(mcp.name)}]`,
    `command = ${tomlString(mcp.command)}`,
    `args = ${tomlArray(mcp.args || [])}`,
    'enabled = true',
  ];

  if (Object.keys(env).length > 0) {
    lines.push(`env = ${tomlInlineTable(env)}`);
  }

  return lines.join('\n');
}

function parseCodexMcpServers(content: string, agent: string): DiscoveredMcp[] {
  const results: DiscoveredMcp[] = [];
  let current: DiscoveredMcp | null = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const tableName = parseCodexMcpTableName(line);
    if (tableName) {
      current = { name: tableName, command: 'unknown', args: undefined, agent, source: 'config' };
      results.push(current);
      continue;
    }

    if (!current) continue;

    const command = line.match(/^command\s*=\s*(.+)$/);
    if (command) {
      current.command = parseTomlString(command[1]) || 'unknown';
      continue;
    }

    const url = line.match(/^url\s*=\s*(.+)$/);
    if (url && current.command === 'unknown') {
      current.command = parseTomlString(url[1]) || 'unknown';
      continue;
    }

    const args = line.match(/^args\s*=\s*(.+)$/);
    if (args) {
      current.args = parseTomlStringArray(args[1]);
    }
  }

  return results;
}

function parseCodexMcpTableName(line: string): string | null {
  const match = line.trim().match(/^\[mcp_servers\.(.+)\]$/);
  if (!match) return null;
  const key = match[1].trim();
  if (key.startsWith('"')) {
    return parseTomlString(key);
  }
  return key;
}

function parseTomlString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function tomlKey(value: string): string {
  return tomlString(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`);
  return `{ ${entries.join(', ')} }`;
}
