/**
 * Codex (OpenAI) Adapter
 */
import { join } from 'node:path';
import type { AgentType, InstallScope, McpRegistryEntry, DiscoveredMcp, InstalledSkillInfo } from '../types/index.js';
import { AGENT_PATHS } from '../utils/platform.js';
import { listSubdirs, pathExists, readFileOrNull, writeFileSafe } from '../utils/fs.js';
import { parseSkillMd } from '../parsers/index.js';
import { logger } from '../utils/logger.js';
import { mcpServerNameCandidates, toMcpServerName } from '../utils/mcp_names.js';
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
    return (
      await pathExists(AGENT_PATHS.codex.global()) ||
      await pathExists(AGENT_PATHS.codex.legacyGlobal()) ||
      await pathExists(AGENT_PATHS.codex.mcpConfig('global')) ||
      await pathExists(AGENT_PATHS.codex.configDir())
    );
  }

  async listInstalled(scope: InstallScope): Promise<InstalledSkillInfo[]> {
    if (scope !== 'global') {
      return super.listInstalled(scope);
    }

    const byName = new Map<string, InstalledSkillInfo>();
    for (const skillsDir of [AGENT_PATHS.codex.global(), AGENT_PATHS.codex.legacyGlobal()]) {
      for (const skill of await listInstalledCodexSkills(skillsDir)) {
        if (!byName.has(skill.name)) {
          byName.set(skill.name, skill);
        }
      }
    }

    return Array.from(byName.values());
  }

  async configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.codex.mcpConfig(scope);
    if (!configPath) return;

    const existing = await readFileOrNull(configPath);
    const serverName = this.mcpServerName(mcp.name);
    const next = upsertCodexMcpBlock(existing || '', {
      ...mcp,
      name: serverName,
    }, env || {}, mcp.name);
    await writeFileSafe(configPath, next);
    logger.agent(this.displayName, `Configured MCP: ${serverName}`);
  }

  async removeMCP(mcpName: string, scope: InstallScope = 'global'): Promise<void> {
    const configPath = AGENT_PATHS.codex.mcpConfig(scope);
    if (!configPath) return;

    const existing = await readFileOrNull(configPath);
    if (!existing) return;

    const next = removeCodexMcpBlock(existing, mcpName);
    if (next !== existing) {
      await writeFileSafe(configPath, next);
      logger.agent(this.displayName, `Removed MCP: ${this.mcpServerName(mcpName)}`);
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

async function listInstalledCodexSkills(skillsDir: string): Promise<InstalledSkillInfo[]> {
  if (!(await pathExists(skillsDir))) return [];

  const dirs = await listSubdirs(skillsDir);
  const results: InstalledSkillInfo[] = [];

  for (const dir of dirs) {
    const fullPath = join(skillsDir, dir);
    const hasSkillMd = await pathExists(join(fullPath, 'SKILL.md'));
    if (!hasSkillMd) continue;

    const fm = await parseSkillMd(fullPath);
    const name = fm?.name || dir;
    const description = fm?.description;

    results.push({
      name,
      path: fullPath,
      hasSkillMd,
      description,
    });
  }

  return results;
}

function upsertCodexMcpBlock(content: string, mcp: McpRegistryEntry, env: Record<string, string>, originalName: string = mcp.name): string {
  const cleaned = removeCodexMcpBlock(content, originalName).trimEnd();
  const block = buildCodexMcpBlock(mcp, env);
  return `${cleaned}${cleaned ? '\n\n' : ''}${block}\n`;
}

function removeCodexMcpBlock(content: string, mcpName: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let skipping = false;
  const candidates = mcpServerNameCandidates(mcpName);
  const targetName = toMcpServerName(mcpName);

  for (const line of lines) {
    const tableName = parseCodexMcpTableName(line);
    if (tableName) {
      skipping = candidates.includes(tableName) || toMcpServerName(tableName) === targetName;
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
    'enabled = true',
  ];

  if ((mcp.type === 'http' || mcp.type === 'sse') && mcp.url) {
    lines.push(`url = ${tomlString(mcp.url)}`);
    return lines.join('\n');
  }

  lines.splice(1, 0,
    `command = ${tomlString(mcp.command)}`,
    `args = ${tomlArray(mcp.args || [])}`,
  );

  if (Object.keys(env).length > 0) {
    lines.push(`env = ${tomlInlineTable(env)}`);
  }

  return lines.join('\n');
}

export function parseCodexMcpServers(content: string, agent: string): DiscoveredMcp[] {
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
  const match = line.trim().match(/^\[mcp_servers\.(.+?)\]\s*(?:#.*)?$/);
  if (!match) return null;
  const key = match[1].trim();
  if (key.startsWith('"')) {
    return parseTomlString(key);
  }
  return key;
}

function parseTomlString(value: string): string {
  const trimmed = stripTomlInlineComment(value).trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = stripTomlInlineComment(value).trim();
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

function stripTomlInlineComment(value: string): string {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === '#' && !inString) {
      return value.slice(0, i);
    }
  }

  return value;
}
