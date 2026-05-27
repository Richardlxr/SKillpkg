import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkOutdated, updateSkills } from '../src/core/commands.js';
import { computeIntegrity } from '../src/core/sumfile.js';
import { closeDb, genId, getDb } from '../src/db/index.js';

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  cloneOrPull: vi.fn(),
  getCommitSha: vi.fn(),
  repoUrlToLocalPath: vi.fn((url: string) => url.replace(/[^a-z0-9]/gi, '-')),
}));

vi.mock('../src/utils/git.js', () => ({
  checkout: mocks.checkout,
  cloneOrPull: mocks.cloneOrPull,
  getCommitSha: mocks.getCommitSha,
  repoUrlToLocalPath: mocks.repoUrlToLocalPath,
}));

describe('local skill updates', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;

  beforeEach(async () => {
    closeDb();
    mocks.checkout.mockReset();
    mocks.cloneOrPull.mockReset();
    mocks.getCommitSha.mockReset();
    root = await mkdtemp(join(tmpdir(), 'skm-update-local-'));
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDb();
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    restoreEnv('SKILLPKG_DATA_DIR', oldDataDir);
    await rm(root, { recursive: true, force: true });
  });

  it('does not treat local, tracked, or linked skills as remote update targets', async () => {
    await seedSkill('local-skill', 'local');
    await seedSkill('tracked-skill', 'tracked');
    await seedSkill('linked-skill', 'linked');

    await checkOutdated();
    await updateSkills();

    expect(mocks.cloneOrPull).not.toHaveBeenCalled();
    expect(mocks.getCommitSha).not.toHaveBeenCalled();
  });

  async function seedSkill(name: string, commit: 'local' | 'tracked' | 'linked'): Promise<void> {
    const skillDir = join(root, 'skills', name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${name}`,
      `description: ${name}`,
      '---',
      '',
      `# ${name}`,
      '',
    ].join('\n'));

    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, ?, ?, ?, '0.0.0', ?, 'global', '', NULL, ?, NULL, NULL, ?, 'copy', 0, ?, ?, 'all')
    `).run(
      genId(),
      name,
      `file://${skillDir}`,
      commit,
      `${name} skill`,
      skillDir,
      await computeIntegrity(skillDir),
      now,
      now
    );
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
