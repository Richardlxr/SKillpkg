import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityAdapter } from '../src/adapters/antigravity.js';
import { trackSkills } from '../src/core/commands.js';
import { closeDb, getDb } from '../src/db/index.js';

describe('trackSkills', () => {
  let root: string;
  let projectDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;

  beforeEach(async () => {
    closeDb();
    root = await mkdtemp(join(tmpdir(), 'skm-track-test-'));
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

  it('adopts native skills without assigning or injecting them into every detected agent', async () => {
    const home = process.env['HOME'] as string;
    const antigravitySkill = join(home, '.gemini', 'antigravity', 'skills', 'demo');
    const codexSkillsDir = join(home, '.codex', 'skills');
    const staleStoreDir = join(root, 'data', 'skills', 'global', 'demo');

    await writeSkill(antigravitySkill, 'demo', 'from antigravity');
    await mkdir(codexSkillsDir, { recursive: true });
    await mkdir(staleStoreDir, { recursive: true });
    await writeFile(join(staleStoreDir, 'stale.txt'), 'old copy');

    await trackSkills();

    const storedSkill = join(staleStoreDir, 'SKILL.md');
    expect(existsSync(storedSkill)).toBe(true);
    expect(existsSync(join(staleStoreDir, 'stale.txt'))).toBe(false);
    expect(existsSync(antigravitySkill)).toBe(false);
    expect(existsSync(join(codexSkillsDir, 'demo'))).toBe(false);

    const db = await getDb();
    const row = db.prepare(`
      SELECT name, scope, assigned_agents, installed_path
      FROM skills
      WHERE name = 'demo' AND scope = 'global' AND project_path = ''
    `).get() as { name: string; scope: string; assigned_agents: string; installed_path: string } | undefined;

    expect(row).toMatchObject({
      name: 'demo',
      scope: 'global',
      assigned_agents: '[]',
      installed_path: staleStoreDir,
    });
  });

  it('adopts native skills that are exposed as directory symlinks', async () => {
    const home = process.env['HOME'] as string;
    const skillsDir = join(home, '.gemini', 'antigravity', 'skills');
    const nativeSource = join(root, 'native-source', 'symlink-demo');
    const nativeLink = join(skillsDir, 'symlink-demo');
    const staleStoreDir = join(root, 'data', 'skills', 'global', 'symlink-demo');

    await writeSkill(nativeSource, 'symlink-demo', 'linked native skill');
    await mkdir(skillsDir, { recursive: true });
    await mkdir(staleStoreDir, { recursive: true });
    await writeFile(join(staleStoreDir, 'stale.txt'), 'old copy');

    try {
      await symlink(nativeSource, nativeLink, 'dir');
    } catch {
      return;
    }

    await trackSkills('symlink-demo');

    expect((await lstat(staleStoreDir)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(staleStoreDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(staleStoreDir, 'stale.txt'))).toBe(false);
    expect(existsSync(nativeLink)).toBe(false);
    expect(existsSync(nativeSource)).toBe(true);
  });
});

describe('agent skill discovery', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skm-adapter-test-'));
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
  });

  afterEach(async () => {
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    await rm(root, { recursive: true, force: true });
  });

  it('uses SKILL.md name and ignores non-skill directories', async () => {
    const home = process.env['HOME'] as string;
    const skillsDir = join(home, '.gemini', 'antigravity', 'skills');
    await writeSkill(join(skillsDir, 'directory-name'), 'frontmatter-name', 'native skill');
    await mkdir(join(skillsDir, 'not-a-skill'), { recursive: true });

    const adapter = new AntigravityAdapter();
    const installed = await adapter.listInstalled('global');

    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      name: 'frontmatter-name',
      path: join(skillsDir, 'directory-name'),
      hasSkillMd: true,
      description: 'native skill',
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
