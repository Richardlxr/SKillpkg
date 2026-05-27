import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, genId, getDb } from '../src/db/index.js';
import { computeIntegrity, saveSumfile } from '../src/core/sumfile.js';
import type { AgentAdapter, InstallScope, SkillPackage } from '../src/types/index.js';

const mocks = vi.hoisted(() => ({
  resolveAdapters: vi.fn(),
}));

vi.mock('../src/adapters/index.js', () => ({
  detectAgents: vi.fn(),
  getAllAdapters: vi.fn(),
  resolveAdapters: mocks.resolveAdapters,
}));

describe('skill promotion', () => {
  let root: string;
  let projectDir: string;
  let globalDir: string;
  let projectAgentDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;

  beforeEach(async () => {
    closeDb();
    mocks.resolveAdapters.mockReset();
    root = await mkdtemp(join(tmpdir(), 'skm-promote-skill-'));
    projectDir = join(root, 'project');
    globalDir = join(root, 'home', '.codex', 'skills');
    projectAgentDir = join(projectDir, '.agents', 'skills');
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

  it('copies project-local skills to global scope without removing the project install', async () => {
    const { promoteSkillToGlobal } = await import('../src/core/sync.js');
    const skillDir = await writeSkill(projectAgentDir, 'team-skill');
    const integrity = await seedProjectSkill(skillDir, 'team-skill');
    const agent = fakeAgent();
    mocks.resolveAdapters.mockResolvedValue([agent]);

    await promoteSkillToGlobal('team-skill');

    const globalSkillDir = join(globalDir, 'team-skill');
    expect(existsSync(join(globalSkillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(agent.uninstallSkill).not.toHaveBeenCalled();

    const db = await getDb();
    const projectRow = db.prepare(`
      SELECT source_url, installed_path
      FROM skills
      WHERE name = 'team-skill' AND scope = 'project' AND project_path = ?
    `).get(projectDir) as { source_url: string; installed_path: string } | undefined;
    expect(projectRow).toMatchObject({
      source_url: './.agents/skills/team-skill',
      installed_path: skillDir,
    });

    const globalRow = db.prepare(`
      SELECT source_url, source_commit, installed_path, install_mode
      FROM skills
      WHERE name = 'team-skill' AND scope = 'global' AND project_path = ''
    `).get() as { source_url: string; source_commit: string; installed_path: string; install_mode: string } | undefined;
    expect(globalRow).toMatchObject({
      source_commit: 'local',
      installed_path: globalSkillDir,
      install_mode: 'copy',
    });
    expect(globalRow?.source_url).toMatch(/^file:\/\//);
    expect(globalRow?.source_url).not.toContain('./.agents/skills');

    const projectSum = await readFile(join(projectDir, 'skm.sum'), 'utf-8');
    expect(projectSum).toContain(`./.agents/skills/team-skill 0.0.0 ${integrity}`);
    const globalSum = await readFile(join(root, 'data', 'skm.sum'), 'utf-8');
    expect(globalSum).toContain(`${globalRow?.source_url} 0.0.0 ${integrity}`);
  });

  it('can remove the project install when requested for all agents', async () => {
    const { promoteSkillToGlobal } = await import('../src/core/sync.js');
    const skillDir = await writeSkill(projectAgentDir, 'team-skill');
    await seedProjectSkill(skillDir, 'team-skill');
    const agent = fakeAgent();
    mocks.resolveAdapters.mockResolvedValue([agent]);

    await promoteSkillToGlobal('team-skill', { removeProject: true });

    expect(agent.uninstallSkill).toHaveBeenCalledWith('team-skill', 'project');
    const db = await getDb();
    expect(db.prepare(`
      SELECT id
      FROM skills
      WHERE name = 'team-skill' AND scope = 'project' AND project_path = ?
    `).get(projectDir)).toBeUndefined();

    const projectSum = await readFile(join(projectDir, 'skm.sum'), 'utf-8');
    expect(projectSum).not.toContain('./.agents/skills/team-skill');
  });

  async function seedProjectSkill(skillDir: string, name: string): Promise<string> {
    const db = await getDb();
    const now = new Date().toISOString();
    const id = genId();
    const integrity = await computeIntegrity(skillDir);
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, ?, ?, 'local', '0.0.0', ?, 'project', ?, NULL, ?, ?, NULL, ?, 'copy', 0, ?, ?, 'all')
    `).run(
      id,
      name,
      `./.agents/skills/${name}`,
      `${name} skill`,
      projectDir,
      skillDir,
      skillDir,
      integrity,
      now,
      now
    );
    db.prepare(`
      INSERT INTO project_skills (id, project_path, skill_source, version, installed_skill_id)
      VALUES (?, ?, ?, NULL, ?)
    `).run(genId(), projectDir, `./.agents/skills/${name}`, id);
    await saveSumfile(new Map([
      [`./.agents/skills/${name}`, {
        source: `./.agents/skills/${name}`,
        version: '0.0.0',
        integrity,
      }],
    ]), { scope: 'project', projectPath: projectDir });
    return integrity;
  }

  function fakeAgent(): AgentAdapter {
    return {
      name: 'codex',
      displayName: 'Codex',
      detect: vi.fn(),
      getSkillsDir: (scope: InstallScope) => scope === 'global' ? globalDir : projectAgentDir,
      installSkill: vi.fn(async (skill: SkillPackage, scope: InstallScope) => {
        const target = join(scope === 'global' ? globalDir : projectAgentDir, skill.frontmatter.name);
        await rm(target, { recursive: true, force: true });
        await mkdir(scope === 'global' ? globalDir : projectAgentDir, { recursive: true });
        await cp(skill.localPath, target, { recursive: true, force: true });
      }),
      uninstallSkill: vi.fn(),
      configureMCP: vi.fn(),
      removeMCP: vi.fn(),
      listConfiguredMCPs: vi.fn(async () => []),
      listInstalled: vi.fn(async () => []),
    };
  }
});

async function writeSkill(root: string, name: string): Promise<string> {
  const skillDir = join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} skill`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'));
  return skillDir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
