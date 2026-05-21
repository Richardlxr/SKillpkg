/**
 * skillpkg - Core Type Definitions
 *
 * Design references:
 *   - npm: lockfile integrity, lifecycle hooks, link, outdated
 *   - conda: channels (multi-source), environment profiles
 *   - Go modules: replace directives, go.sum integrity, mod tidy, mod graph
 */

// ============================================================
// Skill Package Types
// ============================================================

/** SKILL.md frontmatter fields (Agent Skills open standard) */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  dependencies?: string[];
  mcp?: string[];
  setup_command?: string;
}

/** MCP Service Registry Entry */
export interface McpRegistryEntry {
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
}

/** Skill dependency declaration in skillpkg.yaml */
export interface SkillDependency {
  name: string;
  source: string;       // Git repository URL or owner/repo shorthand
  path?: string;        // Sub-path within the repo (mono-repo support)
  version?: string;     // Git tag / branch / commit (semver or exact)
}

/**
 * Replace directive — Go mod style
 * Allows redirecting a skill source to another location.
 *
 * Example in skillpkg.yaml:
 *   replace:
 *     - old: github.com/original/skill
 *       new: github.com/my-fork/skill
 *     - old: github.com/broken/tool
 *       new: ../local-fix            # local path
 */
export interface ReplaceDirective {
  old: string;          // Original source (owner/repo or full URL)
  new: string;          // Replacement source or local path
  version?: string;     // Pin replacement to a specific version
}



/** Resolved skill package ready for installation */
export interface SkillPackage {
  frontmatter: SkillFrontmatter;
  localPath: string;       // Path in cache
  sourceUrl?: string;      // Original source URL
  commit: string;          // Git commit SHA
  integrity?: string;      // SHA-256 hash for go.sum style verification
}

export type InstallMode = 'copy' | 'symlink-cache' | 'symlink-dev';

export interface SkillInstallOptions {
  installMode?: InstallMode;
}

// ============================================================
// Agent Types
// ============================================================

export type AgentType =
  | 'antigravity'
  | 'antigravity-cli'
  | 'claude-code'
  | 'codex'
  | 'cursor';

export const ALL_AGENT_TYPES: AgentType[] = [
  'antigravity',
  'antigravity-cli',
  'claude-code',
  'codex',
  'cursor',
];

export type PlatformType = 'windows' | 'macos' | 'linux';

export type InstallScope = 'global' | 'project';
export type GitPreference = 'auto' | 'track' | 'ask';

export interface DiscoveredMcp {
  name: string;
  command: string;
  args?: string[];
  agent: string;
  source: 'db' | 'config';
}

// ============================================================
// Agent Adapter Interface
// ============================================================

/** Standardized interface every agent adapter must implement */
export interface AgentAdapter {
  readonly name: AgentType;
  readonly displayName: string;
  detect(): Promise<boolean>;
  getSkillsDir(scope: InstallScope): string;
  installSkill(skill: SkillPackage, scope: InstallScope, options?: SkillInstallOptions): Promise<void>;
  uninstallSkill(skillName: string, scope: InstallScope): Promise<void>;
  configureMCP(mcp: McpRegistryEntry, env: Record<string, string>, scope?: InstallScope): Promise<void>;
  removeMCP(mcpName: string, scope?: InstallScope): Promise<void>;
  listConfiguredMCPs(): Promise<DiscoveredMcp[]>;
  listInstalled(scope: InstallScope): Promise<InstalledSkillInfo[]>;
}

export interface InstalledSkillInfo {
  name: string;
  path: string;
  hasSkillMd: boolean;
  description?: string;
}

// ============================================================
// Database / Storage Types
// ============================================================

export interface InstalledSkillRecord {
  id: string;
  name: string;
  sourceUrl: string;
  sourceCommit: string;
  version: string;
  description: string;
  scope: InstallScope;
  alias: string | null;
  installedPath: string;
  unifiedPath?: string | null;
  integrity: string;        // SHA-256 hash (go.sum style)
  installMode: InstallMode;
  symlinkTarget?: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface ReplaceHistoryRecord {
  id: string;
  skillName: string;
  oldSource: string;
  oldCommit: string;
  newSource: string;
  newCommit: string;
  replacedAt: string;
}

export interface MCPConfigRecord {
  id: string;
  skillId: string;
  name: string;
  type: string;
  command: string;
  args: string;
  env: string;
  agentConfigs: string;
}

export interface MCPInstallationRecord {
  id: string;
  name: string;
  source: string;
  type: string;
  command: string;
  args: string;
  env: string;
  scope: InstallScope;
  projectPath: string;
  assignedAgents: string;
  installedAt: string;
  updatedAt: string;
}



// ============================================================
// Conflict Types
// ============================================================

export type ConflictStrategy = 'reject' | 'replace' | 'alias' | 'scope';

export interface ConflictInfo {
  skillName: string;
  existingSource: string;
  existingCommit: string;
  newSource: string;
  strategy?: ConflictStrategy;
}

// ============================================================
// CLI Option Types
// ============================================================

export interface InstallOptions {
  replace?: boolean;
  alias?: string;
  scope?: InstallScope;
  mode?: InstallMode;
  agent?: AgentType | 'all';
  force?: boolean;
  noDeps?: boolean;         // Skip dependency installation
  noScripts?: boolean;      // Skip lifecycle scripts
  yes?: boolean;            // Automatically answer yes to prompts
  save?: boolean;           // Save project install to skm.mod
  saveToMod?: boolean;      // Internal: save a recursive install selected by the root request
}

export interface GlobalConfig {
  defaultScope: InstallScope;
  defaultAgent: AgentType | 'all';
  gitPreference: GitPreference;
  cacheDir: string;
  storeDir: string;
  dbPath: string;
  sumfilePath: string;
}

/** Dependency graph node for `skillpkg tree` visualization */
export interface DepTreeNode {
  name: string;
  version: string;
  source: string;
  installMode: InstallMode;
  replaceTarget?: string;
  children: DepTreeNode[];
}

/** Outdated info for `skillpkg outdated` */
export interface OutdatedInfo {
  name: string;
  currentVersion: string;
  currentCommit: string;
  latestCommit: string;
  source: string;
  hasUpdate: boolean;
}
