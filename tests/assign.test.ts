import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, genId, getDb } from '../src/db/index.js';
import { SELECT_ALL_CHOICE_VALUE } from '../src/utils/searchable_selection.js';
import type { AgentAdapter, AgentType, InstallScope } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock('../src/adapters/index.js', () => ({
  detectAgents: mocks.detectAgents,
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: mocks.prompt,
  },
}));

describe('interactive assignment prompts', () => {
  let root: string;
  let projectDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;

  beforeEach(async () => {
    closeDb();
    mocks.detectAgents.mockReset();
    mocks.prompt.mockReset();

    root = await mkdtemp(join(tmpdir(), 'skm-assign-'));
    projectDir = join(root, 'project');
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    await mkdir(projectDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDb();
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    restoreEnv('SKILLPKG_DATA_DIR', oldDataDir);
    await rm(root, { recursive: true, force: true });
  });

  it('searches skills before assignment and offers an all-agents checkbox option', async () => {
    const { assignInteractive } = await import('../src/core/assign.js');
    const db = await getDb();
    const reviewSkillId = seedSkill(db, 'reviewer');
    seedSkill(db, 'writer');
    const codex = agent('codex', 'Codex', { installedSkills: ['reviewer'] });
    const claude = agent('claude-code', 'Claude Code', { installedSkills: ['reviewer'] });
    mocks.detectAgents.mockResolvedValue([codex, claude]);
    mocks.prompt
      .mockResolvedValueOnce({ assignType: 'skill' })
      .mockResolvedValueOnce({ skillSearch: 'review' })
      .mockResolvedValueOnce({ selectedSkill: reviewSkillId })
      .mockResolvedValueOnce({ targetAgents: [SELECT_ALL_CHOICE_VALUE] });

    await assignInteractive();

    const updated = db.prepare('SELECT assigned_agents FROM skills WHERE id = ?').get(reviewSkillId) as { assigned_agents: string };
    expect(updated.assigned_agents).toBe('all');

    const skillSearchQuestion = mocks.prompt.mock.calls[1][0][0];
    expect(skillSearchQuestion).toMatchObject({ type: 'input', name: 'skillSearch' });

    const skillSelectQuestion = mocks.prompt.mock.calls[2][0][0];
    expect(skillSelectQuestion).toMatchObject({ type: 'list', name: 'selectedSkill' });
    expect(skillSelectQuestion.message).toContain('1 of 2 skills matching "review"');
    expect(skillSelectQuestion.choices).toHaveLength(1);
    expect(skillSelectQuestion.choices[0].name).toContain('reviewer');

    const agentQuestion = mocks.prompt.mock.calls[3][0][0];
    expect(agentQuestion).toMatchObject({ type: 'checkbox', name: 'targetAgents' });
    expect(agentQuestion.message).toContain('Use Space to select');
    expect(agentQuestion.choices[0]).toMatchObject({
      name: 'All agents',
      value: SELECT_ALL_CHOICE_VALUE,
    });
  });

  it('searches managed MCP services and assigns project MCPs only to project-capable agents', async () => {
    const { assignInteractive } = await import('../src/core/assign.js');
    const db = await getDb();
    const mcpId = seedManagedMcp(db, {
      name: 'drawio',
      source: 'https://github.com/jgraph/drawio-mcp.git#mcp-tool-server',
      scope: 'project',
      projectPath: projectDir,
    });
    const codex = agent('codex', 'Codex');
    const cursor = agent('cursor', 'Cursor');
    const antigravity = agent('antigravity', 'Antigravity');
    mocks.detectAgents.mockResolvedValue([codex, cursor, antigravity]);
    mocks.prompt
      .mockResolvedValueOnce({ assignType: 'mcp' })
      .mockResolvedValueOnce({ mcpSearch: 'draw' })
      .mockResolvedValueOnce({ selectedMcp: `managed:${mcpId}` })
      .mockResolvedValueOnce({ targetAgents: [SELECT_ALL_CHOICE_VALUE] });

    await assignInteractive({ scope: 'project' });

    const updated = db.prepare('SELECT assigned_agents FROM mcp_installations WHERE id = ?').get(mcpId) as { assigned_agents: string };
    expect(updated.assigned_agents).toBe('all');

    const mcpSelectQuestion = mocks.prompt.mock.calls[2][0][0];
    expect(mcpSelectQuestion.message).toContain('1 of 1 MCP services matching "draw"');

    const agentQuestion = mocks.prompt.mock.calls[3][0][0];
    expect(agentQuestion.choices.map((choice: { name: string }) => choice.name)).toEqual([
      'All agents',
      'Codex',
      'Cursor',
    ]);
    expect(codex.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'drawio', command: 'node' }),
      { DRAWIO_TOKEN: 'secret' },
      'project'
    );
    expect(cursor.configureMCP).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'drawio', command: 'node' }),
      { DRAWIO_TOKEN: 'secret' },
      'project'
    );
    expect(antigravity.configureMCP).not.toHaveBeenCalled();
  });
});

function seedSkill(
  db: Awaited<ReturnType<typeof getDb>>,
  name: string,
  scope: InstallScope = 'global'
): string {
  const id = genId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO skills
      (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
    VALUES (?, ?, ?, 'abc1234', '0.0.0', ?, ?, ?, NULL, ?, NULL, NULL, 'sha256-demo', 'copy', 0, ?, ?, '[]')
  `).run(
    id,
    name,
    `github.com/acme/${name}`,
    `${name} description`,
    scope,
    scope === 'project' ? process.cwd() : '',
    join(process.cwd(), '.agents', 'skills', name),
    now,
    now
  );
  return id;
}

function seedManagedMcp(
  db: Awaited<ReturnType<typeof getDb>>,
  options: { name: string; source: string; scope: InstallScope; projectPath: string }
): string {
  const id = genId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO mcp_installations
      (id, name, source, type, command, args, env, scope, project_path, assigned_agents, installed_at, updated_at)
    VALUES (?, ?, ?, 'stdio', 'node', ?, ?, ?, ?, '[]', ?, ?)
  `).run(
    id,
    options.name,
    options.source,
    JSON.stringify(['server.js']),
    JSON.stringify({ DRAWIO_TOKEN: 'secret' }),
    options.scope,
    options.projectPath,
    now,
    now
  );
  return id;
}

function agent(
  name: AgentType,
  displayName: string,
  options: { installedSkills?: string[]; configuredMcps?: string[] } = {}
): AgentAdapter {
  return {
    name,
    displayName,
    detect: vi.fn(async () => true),
    getSkillsDir: vi.fn(() => ''),
    installSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    configureMCP: vi.fn(),
    removeMCP: vi.fn(),
    listConfiguredMCPs: vi.fn(async () => (options.configuredMcps || []).map(mcpName => ({
      name: mcpName,
      command: 'node',
      agent: displayName,
      source: 'config' as const,
    }))),
    listInstalled: vi.fn(async () => (options.installedSkills || []).map(skillName => ({
      name: skillName,
      path: join(process.cwd(), '.agents', 'skills', skillName),
      hasSkillMd: true,
    }))),
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
