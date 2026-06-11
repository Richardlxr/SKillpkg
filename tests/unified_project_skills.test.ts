import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { tidySkills } from '../src/core/commands.js';
import { saveSumfile } from '../src/core/sumfile.js';
import { closeDb, getDb, genId } from '../src/db/index.js';
import { upsertManagedBlock } from '../src/utils/gitignore.js';

describe('unified project skills', () => {
  let root: string;
  let projectDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;

  beforeEach(async () => {
    closeDb();
    root = await mkdtemp(join(tmpdir(), 'skm-unified-skills-'));
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

  it('installs Claude project skills into .agents/skills and creates the native symlink', async () => {
    const skillSource = join(root, 'source-skill');
    await writeSkill(skillSource, 'demo', 'demo skill');

    const adapter = new ClaudeCodeAdapter();
    await adapter.installSkill({
      frontmatter: { name: 'demo', description: 'demo skill' },
      localPath: skillSource,
      commit: 'test',
    }, 'project');

    expect(existsSync(join(projectDir, '.agents', 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect((await lstat(join(projectDir, '.claude', 'skills'))).isSymbolicLink()).toBe(true);
    expect(resolve(join(projectDir, '.claude'), await readlink(join(projectDir, '.claude', 'skills'))))
      .toBe(join(projectDir, '.agents', 'skills'));
  });

  it('does not create project links to missing source directories', async () => {
    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.installSkill({
      frontmatter: { name: 'missing-demo', description: 'missing source' },
      localPath: join(root, 'missing-source'),
      commit: 'test',
    }, 'project', { installMode: 'symlink-cache' })).rejects.toThrow(/Source path does not exist/);

    expect(existsSync(join(projectDir, '.agents', 'skills', 'missing-demo'))).toBe(false);
  });

  it('rejects skill names that would escape the skills directory', async () => {
    const skillSource = join(root, 'source-skill');
    const victim = join(projectDir, 'victim');
    await writeSkill(skillSource, 'safe-demo', 'safe skill');
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, 'marker.txt'), 'keep me');

    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.installSkill({
      frontmatter: { name: '../../victim', description: 'unsafe skill' },
      localPath: skillSource,
      commit: 'test',
    }, 'project')).rejects.toThrow(/Invalid skill name/);

    expect(await readFile(join(victim, 'marker.txt'), 'utf-8')).toBe('keep me');
  });

  it('keeps existing unified project-local skill directories in place', async () => {
    const targetSkill = join(projectDir, '.agents', 'skills', 'demo');
    await writeSkill(targetSkill, 'demo', 'demo skill');

    const adapter = new ClaudeCodeAdapter();
    await adapter.installSkill({
      frontmatter: { name: 'demo', description: 'demo skill' },
      localPath: targetSkill,
      commit: 'local',
    }, 'project');

    expect(existsSync(join(targetSkill, 'SKILL.md'))).toBe(true);
  });

  it('replaces existing dangling project skill links', async () => {
    const skillSource = join(root, 'source-skill');
    const targetSkill = join(projectDir, '.agents', 'skills', 'demo');
    await writeSkill(skillSource, 'demo', 'demo skill');
    await mkdir(join(projectDir, '.agents', 'skills'), { recursive: true });
    await symlink(join(root, 'missing-source'), targetSkill, 'dir');

    const adapter = new ClaudeCodeAdapter();
    await adapter.installSkill({
      frontmatter: { name: 'demo', description: 'demo skill' },
      localPath: skillSource,
      commit: 'test',
    }, 'project', { installMode: 'symlink-cache' });

    expect((await lstat(targetSkill)).isSymbolicLink()).toBe(true);
    expect(await readlink(targetSkill)).toBe(skillSource);
  });

  it('tidy --unify migrates legacy project skill directories and records unified paths', async () => {
    const legacySkill = join(projectDir, '.cursor', 'skills', 'legacy-demo');
    await writeSkill(legacySkill, 'legacy-demo', 'legacy skill');

    const db = await getDb();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, 'legacy-demo', 'file://legacy-demo', 'tracked', '0.0.0', 'legacy skill', 'project', ?, NULL, ?, '', 'symlink-dev', 1, ?, ?, 'all')
    `).run(genId(), projectDir, legacySkill, new Date().toISOString(), new Date().toISOString());

    await tidySkills({ unify: true });

    const unifiedSkill = join(projectDir, '.agents', 'skills', 'legacy-demo');
    expect(existsSync(join(unifiedSkill, 'SKILL.md'))).toBe(true);
    expect((await lstat(join(projectDir, '.cursor', 'skills'))).isSymbolicLink()).toBe(true);

    const row = db.prepare(`
      SELECT installed_path, unified_path
      FROM skills
      WHERE name = 'legacy-demo' AND scope = 'project' AND project_path = ?
    `).get(projectDir) as { installed_path: string; unified_path: string } | undefined;

    expect(row).toMatchObject({
      installed_path: unifiedSkill,
      unified_path: unifiedSkill,
    });
  });

  it('tidy prunes broken project skill records and dangling unified links', async () => {
    const brokenLink = join(projectDir, '.agents', 'skills', 'broken-demo');
    await mkdir(join(projectDir, '.agents', 'skills'), { recursive: true });
    await symlink(join(root, 'missing-cache', 'broken-demo'), brokenLink, 'dir');
    await writeFile(join(projectDir, '.gitignore'), upsertManagedBlock('', [
      '.agents/skills/broken-demo',
      '.agents/mcp_config.json',
    ]));
    await saveSumfile(new Map([
      ['https://github.com/acme/broken-demo.git', {
        source: 'https://github.com/acme/broken-demo.git',
        version: '0.0.0',
        integrity: 'sha256-broken',
      }],
      ['mcp:https://github.com/acme/draw-mcp.git#server', {
        source: 'mcp:https://github.com/acme/draw-mcp.git#server',
        version: 'mcp',
        integrity: 'sha256-mcp',
      }],
    ]), { scope: 'project', projectPath: projectDir });

    const db = await getDb();
    const skillId = genId();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, 'broken-demo', 'https://github.com/acme/broken-demo.git', 'abc1234', '0.0.0', 'broken skill', 'project', ?, NULL, ?, ?, ?, '', 'symlink-cache', 1, ?, ?, 'all')
    `).run(
      skillId,
      projectDir,
      join(root, 'missing-cache', 'broken-demo'),
      brokenLink,
      join(root, 'missing-cache', 'broken-demo'),
      new Date().toISOString(),
      new Date().toISOString()
    );
    db.prepare(`
      INSERT INTO project_skills (id, project_path, skill_source, version, installed_skill_id)
      VALUES (?, ?, 'https://github.com/acme/broken-demo.git', NULL, ?)
    `).run(genId(), projectDir, skillId);
    db.prepare(`
      INSERT INTO mcp_installations
        (id, name, source, type, command, args, env, scope, project_path, assigned_agents, installed_at, updated_at)
      VALUES (?, 'draw-mcp', 'https://github.com/acme/draw-mcp.git#server', 'stdio', 'node', '["server.js"]', '{}', 'project', ?, 'all', ?, ?)
    `).run(genId(), projectDir, new Date().toISOString(), new Date().toISOString());

    await tidySkills();

    expect(existsSync(brokenLink)).toBe(false);
    expect(db.prepare('SELECT id FROM skills WHERE id = ?').get(skillId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM project_skills WHERE installed_skill_id = ?').get(skillId)).toBeUndefined();
    const sum = await readFile(join(projectDir, 'skm.sum'), 'utf-8');
    expect(sum).not.toContain('broken-demo');
    expect(sum).toContain('mcp:https://github.com/acme/draw-mcp.git#server mcp sha256-mcp');

    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).not.toContain('.agents/skills/broken-demo');
    expect(gitignore).toContain('.claude/skills');
    expect(gitignore).toContain('.cursor/skills');
  });
});

async function writeSkill(path: string, name: string, description: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
