/**
 * Base Agent Adapter with shared logic
 */
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentType,
  InstallScope,
  InstalledSkillInfo,
  McpRegistryEntry,
  SkillPackage,
  DiscoveredMcp,
  SkillInstallOptions,
} from '../types/index.js';
import {
  ensureDir,
  pathExists,
  removePath,
  copyDir,
  listSubdirs,
  readJsonFile,
  createSymlinkOrCopy,
  ensureDirectorySymlink,
} from '../utils/fs.js';
import { parseSkillMd } from '../parsers/index.js';
import { logger } from '../utils/logger.js';
import { isSymlinkInstallMode } from '../utils/install_mode.js';
import { AGENT_PATHS } from '../utils/platform.js';
import { mcpServerNameCandidates, toMcpServerName } from '../utils/mcp_names.js';

/**
 * Abstract base class that provides common installation logic.
 * Each concrete adapter only needs to override agent-specific methods.
 */
export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly name: AgentType;
  abstract readonly displayName: string;

  /** Get the skills directory for a given scope */
  abstract getSkillsDir(scope: InstallScope): string;

  /** Detect if this agent is installed */
  abstract detect(): Promise<boolean>;

  /** Configure MCP service for this agent */
  abstract configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, scope?: InstallScope): Promise<void>;

  /** Remove MCP configuration */
  abstract removeMCP(mcpName: string, scope?: InstallScope): Promise<void>;

  /** List configured MCP services from the agent's config file */
  abstract listConfiguredMCPs(): Promise<DiscoveredMcp[]>;

  /** Install a skill into an agent's skills directory */
  async installSkill(skill: SkillPackage, scope: InstallScope, options: SkillInstallOptions = {}): Promise<void> {
    const skillsDir = this.getSkillsDir(scope);
    await ensureDir(skillsDir);
    await this.ensureAgentSymlink(scope);

    const targetDir = join(skillsDir, skill.frontmatter.name);

    // Remove existing if present
    if (await pathExists(targetDir)) {
      await removePath(targetDir);
    }

    if (options.installMode && isSymlinkInstallMode(options.installMode)) {
      const linked = await createSymlinkOrCopy(skill.localPath, targetDir);
      const verb = linked ? 'Linked' : 'Installed';
      logger.agent(this.displayName, `${verb} ${skill.frontmatter.name} → ${targetDir}`);
      return;
    }

    await copyDir(skill.localPath, targetDir);
    logger.agent(this.displayName, `Installed ${skill.frontmatter.name} → ${targetDir}`);
  }

  /** Ensure project-only compatibility paths point at the unified .agents/skills directory. */
  protected async ensureAgentSymlink(scope: InstallScope): Promise<void> {
    if (scope !== 'project') return;

    const pathConfig = AGENT_PATHS[this.name] as {
      project: (cwd: string) => string;
      symlinkDir?: (cwd: string) => string;
    };
    if (!pathConfig.symlinkDir) return;

    const cwd = process.cwd();
    const symlinkDir = pathConfig.symlinkDir(cwd);
    const targetDir = pathConfig.project(cwd);

    try {
      const result = await ensureDirectorySymlink(symlinkDir, targetDir);
      if (result === 'created') {
        logger.agent(this.displayName, `Linked project skills ${symlinkDir} → ${targetDir}`);
      } else if (result === 'blocked') {
        logger.warn(
          `${this.displayName} project skills path already exists and is not the unified symlink: ${symlinkDir}. ` +
          `Run skm tidy --unify to migrate it.`
        );
      }
    } catch (err) {
      logger.warn(`Failed to create project skills symlink for ${this.displayName}: ${(err as Error).message}`);
    }
  }

  /** Uninstall a skill */
  async uninstallSkill(skillName: string, scope: InstallScope): Promise<void> {
    const skillsDir = this.getSkillsDir(scope);
    const targetDir = join(skillsDir, skillName);

    if (await pathExists(targetDir)) {
      await removePath(targetDir);
      logger.agent(this.displayName, `Uninstalled ${skillName}`);
    }
  }

  /** List installed skills */
  async listInstalled(scope: InstallScope): Promise<InstalledSkillInfo[]> {
    const skillsDir = this.getSkillsDir(scope);
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

  /** Helper to parse standard JSON MCP configurations */
  protected async parseJsonMcpConfig(configPath: string | null, sectionName: string = 'mcpServers'): Promise<DiscoveredMcp[]> {
    const results: DiscoveredMcp[] = [];
    if (!configPath || !(await pathExists(configPath))) return results;

    try {
      const config = await readJsonFile<Record<string, unknown>>(configPath);
      if (!config) return results;

      const mcpServers = config[sectionName] as Record<string, Record<string, unknown>> | undefined;
      if (!mcpServers) return results;

      for (const [name, serverConfig] of Object.entries(mcpServers)) {
        results.push({
          name,
          command: (serverConfig['command'] as string) || (serverConfig['serverUrl'] as string) || (serverConfig['url'] as string) || 'unknown',
          args: serverConfig['args'] as string[] | undefined,
          agent: this.displayName,
          source: 'config',
        });
      }
    } catch {
      logger.debug(`Failed to read MCP config for ${this.displayName}: ${configPath}`);
    }

    return results;
  }

  protected async parseJsonMcpConfigs(paths: Array<{ path: string | null; sectionName?: string }>): Promise<DiscoveredMcp[]> {
    const byName = new Map<string, DiscoveredMcp>();
    for (const entry of paths) {
      const mcps = await this.parseJsonMcpConfig(entry.path, entry.sectionName);
      for (const mcp of mcps) {
        byName.set(`${mcp.agent}:${mcp.name}:${mcp.command}:${(mcp.args || []).join('\0')}`, mcp);
      }
    }
    return Array.from(byName.values());
  }

  protected mcpServerName(name: string): string {
    return toMcpServerName(name);
  }

  protected removeMcpServerEntries(
    mcpServers: Record<string, unknown>,
    name: string
  ): boolean {
    let removed = false;
    const targetName = this.mcpServerName(name);
    for (const key of Object.keys(mcpServers)) {
      if (mcpServerNameCandidates(name).includes(key) || this.mcpServerName(key) === targetName) {
        delete mcpServers[key];
        removed = true;
      }
    }
    return removed;
  }
}
