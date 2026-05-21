import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { tidySkills } from '../src/core/commands.js';
import { closeDb, getDb, genId } from '../src/db/index.js';

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
