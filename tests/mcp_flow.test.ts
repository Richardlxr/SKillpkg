import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, genId, getDb } from '../src/db/index.js';
import type { AgentType, InstallScope, McpRegistryEntry } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  getAllAdapters: vi.fn(),
  resolveAdapters: vi.fn(),
  getMcpConfig: vi.fn(),
  getMcpConfigs: vi.fn(),
  promptForMcpEnv: vi.fn(),
  handleProjectGitTracking: vi.fn(),
}));

vi.mock('../src/adapters/index.js', () => ({
  detectAgents: mocks.detectAgents,
  getAllAdapters: mocks.getAllAdapters,
  resolveAdapters: mocks.resolveAdapters,
}));

vi.mock('../src/core/mcp_registry.js', () => ({
  getMcpConfig: mocks.getMcpConfig,
  getMcpConfigs: mocks.getMcpConfigs,
  promptForMcpEnv: mocks.promptForMcpEnv,
}));

vi.mock('../src/core/git_tracking.js', () => ({
  handleProjectGitTracking: mocks.handleProjectGitTracking,
}));

describe('MCP install and scope flow', () => {
  let root: string;
  let projectA: string;
  let projectB: string;
  let cwd: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;

  beforeEach(async () => {
    closeDb();
    vi.restoreAllMocks();
    mocks.detectAgents.mockReset();
    mocks.getAllAdapters.mockReset();
    mocks.resolveAdapters.mockReset();
    mocks.getMcpConfig.mockReset();
    mocks.getMcpConfigs.mockReset();
    mocks.promptForMcpEnv.mockReset();
    mocks.handleProjectGitTracking.mockReset();

    root = await mkdtemp(join(tmpdir(), 'skm-mcp-flow-'));
    projectA = join(root, 'project-a');
    projectB = join(root, 'project-b');
    cwd = projectA;
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    vi.spyOn(process, 'cwd').mockImplementation(() => cwd);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDb();
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    restoreEnv('SKILLPKG_DATA_DIR', oldDataDir);
    await rm(root, { recursive: true, force: true });
  });

  it('installs project MCPs only into agents with project MCP config support', async () => {
    const { installMcpService } = await import('../src/core/mcp.js');
    const antigravity = fakeAgent('antigravity', 'Antigravity 2.0 / Editor');
    const claude = fakeAgent('claude-code', 'Claude Code');
    const codex = fakeAgent('codex', 'Codex (OpenAI)');
    const config = mcpConfig('demo-mcp', ['server.js']);
    mocks.resolveAdapters.mockResolvedValue([antigravity, claude, codex]);
    mocks.getMcpConfigs.mockResolvedValue([config]);
    mocks.promptForMcpEnv.mockResolvedValue({ TOKEN: 'secret' });

    await installMcpService('github.com/acme/demo-mcp', { scope: 'project', agent: 'all' });

    expect(antigravity.configureMCP).not.toHaveBeenCalled();
    expect(claude.configureMCP).toHaveBeenCalledWith(config, { TOKEN: 'secret' }, 'project');
    expect(codex.configureMCP).toHaveBeenCalledWith(config, { TOKEN: 'secret' }, 'project');
    expect(mocks.handleProjectGitTracking).toHaveBeenCalledTimes(1);

    const row = await getMcpRow('demo-mcp', 'project', projectA);
    expect(row).toMatchObject({
      source: 'github.com/acme/demo-mcp',
      command: 'node',
      scope: 'project',
      project_path: projectA,
    });
    expect(JSON.parse(row.assigned_agents)).toEqual(['claude-code', 'codex']);
    expect(JSON.parse(row.args)).toEqual(['server.js']);
    expect(JSON.parse(row.env)).toEqual({ TOKEN: 'secret' });
  });

  it('keeps global all-agent installs global and assigned to all', async () => {
    const { installMcpService } = await import('../src/core/mcp.js');
    const antigravity = fakeAgent('antigravity', 'Antigravity 2.0 / Editor');
    const claude = fakeAgent('claude-code', 'Claude Code');
    const config = mcpConfig('global-mcp', ['server.js']);
    mocks.resolveAdapters.mockResolvedValue([antigravity, claude]);
    mocks.getMcpConfigs.mockResolvedValue([config]);
    mocks.promptForMcpEnv.mockResolvedValue({});

    await installMcpService('github.com/acme/global-mcp', { scope: 'global', agent: 'all' });

    expect(antigravity.configureMCP).toHaveBeenCalledWith(config, {}, 'global');
    expect(claude.configureMCP).toHaveBeenCalledWith(config, {}, 'global');
    const row = await getMcpRow('global-mcp', 'global', '');
    expect(row.assigned_agents).toBe('all');
    await expect(getMcpRow('global-mcp', 'project', projectA)).rejects.toThrow('Missing MCP row');
  });

  it('installs every MCP config returned from a multi-project source', async () => {
    const { installMcpService } = await import('../src/core/mcp.js');
    const codex = fakeAgent('codex', 'Codex (OpenAI)');
    const alpha = { ...mcpConfig('alpha-mcp', ['alpha.js']), source: 'github.com/acme/mcps#alpha' };
    const beta = { ...mcpConfig('beta-mcp', ['beta.js']), source: 'github.com/acme/mcps#beta' };
    mocks.resolveAdapters.mockResolvedValue([codex]);
    mocks.getMcpConfigs.mockResolvedValue([alpha, beta]);
    mocks.promptForMcpEnv.mockResolvedValue({});

    await installMcpService('github.com/acme/mcps', { scope: 'project', agent: 'codex' });

    expect(codex.configureMCP).toHaveBeenCalledTimes(2);
    expect(codex.configureMCP).toHaveBeenCalledWith(alpha, {}, 'project');
    expect(codex.configureMCP).toHaveBeenCalledWith(beta, {}, 'project');
    expect((await getMcpRow('alpha-mcp', 'project', projectA)).source).toBe('github.com/acme/mcps#alpha');
    expect((await getMcpRow('beta-mcp', 'project', projectA)).source).toBe('github.com/acme/mcps#beta');
  });

  it('syncs only the current project scope and preserves other scopes', async () => {
    const { syncMcpServices } = await import('../src/core/mcp.js');
    const cursor = fakeAgent('cursor', 'Cursor');
    mocks.resolveAdapters.mockResolvedValue([cursor]);
    await seedMcp({
      name: 'shared-mcp',
      source: 'source-a',
      scope: 'project',
      projectPath: projectA,
      assignedAgents: JSON.stringify(['claude-code']),
      args: ['project-a.js'],
    });
    await seedMcp({
      name: 'shared-mcp',
      source: 'source-b',
      scope: 'project',
      projectPath: projectB,
      assignedAgents: JSON.stringify(['cursor']),
      args: ['project-b.js'],
    });
    await seedMcp({
      name: 'shared-mcp',
      source: 'global-source',
      scope: 'global',
      projectPath: '',
      assignedAgents: 'all',
      args: ['global.js'],
    });

    await syncMcpServices({ scope: 'project', agent: 'cursor' });

    expect(cursor.configureMCP).toHaveBeenCalledTimes(1);
    expect(cursor.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shared-mcp', args: ['project-a.js'] }),
      {},
      'project'
    );
    expect(JSON.parse((await getMcpRow('shared-mcp', 'project', projectA)).assigned_agents))
      .toEqual(['claude-code', 'cursor']);
    expect(JSON.parse((await getMcpRow('shared-mcp', 'project', projectB)).assigned_agents))
      .toEqual(['cursor']);
    expect((await getMcpRow('shared-mcp', 'global', '')).assigned_agents).toBe('all');
  });

  it('skips legacy MCP App rows during sync instead of re-adding them as stdio servers', async () => {
    const { syncMcpServices } = await import('../src/core/mcp.js');
    const codex = fakeAgent('codex', 'Codex (OpenAI)');
    mocks.resolveAdapters.mockResolvedValue([codex]);
    await seedMcp({
      name: 'drawio-mcp',
      source: 'https://github.com/jgraph/drawio-mcp.git',
      scope: 'project',
      projectPath: projectA,
      assignedAgents: JSON.stringify(['codex']),
      args: ['mcp-tool-server/src/index.js'],
    });
    await seedMcp({
      name: '@drawio/mcp-app',
      source: 'https://github.com/jgraph/drawio-mcp.git#mcp-app-server',
      scope: 'project',
      projectPath: projectA,
      assignedAgents: JSON.stringify(['codex']),
      args: ['mcp-app-server/src/index.js'],
    });

    await syncMcpServices({ scope: 'project', agent: 'codex' });

    expect(codex.configureMCP).toHaveBeenCalledTimes(1);
    expect(codex.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'drawio-mcp', args: ['mcp-tool-server/src/index.js'] }),
      {},
      'project'
    );
  });

  it('syncs managed SSE endpoint rows as remote MCP configs', async () => {
    const { syncMcpServices } = await import('../src/core/mcp.js');
    const claude = fakeAgent('claude-code', 'Claude Code');
    mocks.resolveAdapters.mockResolvedValue([claude]);
    await seedMcp({
      name: 'asana-com',
      source: 'https://mcp.asana.com/sse',
      type: 'sse',
      command: 'https://mcp.asana.com/sse',
      scope: 'project',
      projectPath: projectA,
      assignedAgents: JSON.stringify(['claude-code']),
      args: [],
    });

    await syncMcpServices({ scope: 'project', agent: 'claude-code' });

    expect(claude.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'asana-com',
        type: 'sse',
        url: 'https://mcp.asana.com/sse',
        command: '',
      }),
      {},
      'project'
    );
  });

  it('removes project MCP assignments without deleting matching global records', async () => {
    const { removeMcpService } = await import('../src/core/mcp.js');
    const claude = fakeAgent('claude-code', 'Claude Code');
    const codex = fakeAgent('codex', 'Codex (OpenAI)');
    const cursor = fakeAgent('cursor', 'Cursor');
    await seedMcp({
      name: 'demo-mcp',
      source: 'project-source',
      scope: 'project',
      projectPath: projectA,
      assignedAgents: 'all',
      args: ['project.js'],
    });
    await seedMcp({
      name: 'demo-mcp',
      source: 'global-source',
      scope: 'global',
      projectPath: '',
      assignedAgents: 'all',
      args: ['global.js'],
    });
    mocks.resolveAdapters.mockResolvedValueOnce([claude]);
    mocks.detectAgents.mockResolvedValue([claude, codex, cursor]);

    await removeMcpService('demo-mcp', 'claude-code', 'project');

    expect(claude.removeMCP).toHaveBeenCalledWith('demo-mcp', 'project');
    expect(JSON.parse((await getMcpRow('demo-mcp', 'project', projectA)).assigned_agents))
      .toEqual(['codex', 'cursor']);

    mocks.resolveAdapters.mockResolvedValueOnce([claude, codex, cursor]);
    await removeMcpService('demo-mcp', 'all', 'project');

    await expect(getMcpRow('demo-mcp', 'project', projectA)).rejects.toThrow('Missing MCP row');
    expect((await getMcpRow('demo-mcp', 'global', '')).source).toBe('global-source');
  });

  it('promotes one project MCP assignment without deleting the remaining project row', async () => {
    const { promoteMcpService } = await import('../src/core/mcp.js');
    const claude = fakeAgent('claude-code', 'Claude Code');
    const codex = fakeAgent('codex', 'Codex (OpenAI)');
    await seedMcp({
      name: 'demo-mcp',
      source: 'project-source',
      scope: 'project',
      projectPath: projectA,
      assignedAgents: JSON.stringify(['claude-code', 'codex']),
      args: ['project.js'],
    });
    mocks.resolveAdapters.mockResolvedValue([claude]);

    await promoteMcpService('demo-mcp', { agent: 'claude-code' });

    expect(claude.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo-mcp', args: ['project.js'] }),
      {},
      'global'
    );
    expect(claude.removeMCP).toHaveBeenCalledWith('demo-mcp', 'project');
    expect(JSON.parse((await getMcpRow('demo-mcp', 'project', projectA)).assigned_agents))
      .toEqual(['codex']);
    expect(JSON.parse((await getMcpRow('demo-mcp', 'global', '')).assigned_agents))
      .toEqual(['claude-code']);
  });

  it('demotes global MCPs only to project-capable agents and keeps unsupported agents global', async () => {
    const { demoteMcpService } = await import('../src/core/mcp.js');
    const antigravity = fakeAgent('antigravity', 'Antigravity 2.0 / Editor');
    const claude = fakeAgent('claude-code', 'Claude Code');
    const codex = fakeAgent('codex', 'Codex (OpenAI)');
    await seedMcp({
      name: 'demo-mcp',
      source: 'global-source',
      scope: 'global',
      projectPath: '',
      assignedAgents: 'all',
      args: ['global.js'],
    });
    mocks.resolveAdapters.mockResolvedValue([antigravity, claude, codex]);
    mocks.detectAgents.mockResolvedValue([antigravity, claude, codex]);

    await demoteMcpService('demo-mcp', { agent: 'all' });

    expect(antigravity.configureMCP).not.toHaveBeenCalled();
    expect(antigravity.removeMCP).not.toHaveBeenCalled();
    expect(claude.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo-mcp', args: ['global.js'] }),
      {},
      'project'
    );
    expect(codex.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo-mcp', args: ['global.js'] }),
      {},
      'project'
    );
    expect(claude.removeMCP).toHaveBeenCalledWith('demo-mcp', 'global');
    expect(codex.removeMCP).toHaveBeenCalledWith('demo-mcp', 'global');
    expect(JSON.parse((await getMcpRow('demo-mcp', 'project', projectA)).assigned_agents))
      .toEqual(['claude-code', 'codex']);
    expect(JSON.parse((await getMcpRow('demo-mcp', 'global', '')).assigned_agents))
      .toEqual(['antigravity']);
    expect(mocks.handleProjectGitTracking).toHaveBeenCalledTimes(1);
  });
});

function fakeAgent(name: AgentType, displayName: string) {
  return {
    name,
    displayName,
    getSkillsDir: vi.fn(),
    installSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    configureMCP: vi.fn(),
    removeMCP: vi.fn(),
    listConfiguredMCPs: vi.fn(),
    listInstalled: vi.fn(),
    detect: vi.fn(),
  };
}

function mcpConfig(name: string, args: string[]): McpRegistryEntry {
  return {
    name,
    command: 'node',
    args,
    envKeys: [],
  };
}

async function seedMcp(options: {
  name: string;
  source: string;
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  scope: InstallScope;
  projectPath: string;
  assignedAgents: string;
  args: string[];
}): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO mcp_installations
      (id, name, source, type, command, args, env, scope, project_path, assigned_agents, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)
  `).run(
    genId(),
    options.name,
    options.source,
    options.type || 'stdio',
    options.command || 'node',
    JSON.stringify(options.args),
    options.scope,
    options.projectPath,
    options.assignedAgents,
    now,
    now
  );
}

async function getMcpRow(name: string, scope: InstallScope, projectPath: string): Promise<Record<string, string>> {
  const db = await getDb();
  const row = db.prepare(`
    SELECT *
    FROM mcp_installations
    WHERE name = ? AND scope = ? AND project_path = ?
  `).get(name, scope, projectPath) as Record<string, string> | undefined;
  if (!row) throw new Error(`Missing MCP row: ${name} ${scope} ${projectPath}`);
  return row;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
