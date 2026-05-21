import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, genId, getDb } from '../src/db/index.js';
import { saveSumfile } from '../src/core/sumfile.js';
import { skillpkgGitignorePaths, upsertManagedBlock } from '../src/utils/gitignore.js';

const mocks = vi.hoisted(() => ({
  resolveAdapters: vi.fn(),
  uninstallSkill: vi.fn(),
  removeMCP: vi.fn(),
}));

vi.mock('../src/adapters/index.js', () => ({
  detectAgents: vi.fn(),
  getAllAdapters: vi.fn(),
  resolveAdapters: mocks.resolveAdapters,
}));

describe('uninstall scope handling', () => {
  let root: string;
  let projectDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;

  beforeEach(async () => {
    closeDb();
    mocks.resolveAdapters.mockReset();
    mocks.uninstallSkill.mockReset();
    mocks.removeMCP.mockReset();
    root = await mkdtemp(join(tmpdir(), 'skm-uninstall-scope-'));
    projectDir = join(root, 'project');
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    await mkdir(projectDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    mocks.resolveAdapters.mockResolvedValue([{
      name: 'codex',
      uninstallSkill: mocks.uninstallSkill,
      removeMCP: mocks.removeMCP,
    }]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDb();
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    restoreEnv('SKILLPKG_DATA_DIR', oldDataDir);
    await rm(root, { recursive: true, force: true });
  });

  it('defaults to uninstalling the current project skill and removes it from skm.mod', async () => {
    const { uninstallSkill } = await import('../src/core/installer.js');
    const db = await getDb();
    const skillId = await seedSkill({
      name: 'demo',
      scope: 'project',
      projectPath: projectDir,
      source: 'github.com/acme/demo#skills/demo',
    });
    await writeFile(join(projectDir, 'skm.mod'), [
      'module demo-project',
      '',
      'skill github.com/acme/demo#skills/demo v1.0.0',
      'mcp @playwright/mcp',
      '',
    ].join('\n'));
    await saveSumfile(new Map([
      ['github.com/acme/demo#skills/demo', {
        source: 'github.com/acme/demo#skills/demo',
        version: '0.0.0',
        integrity: 'sha256-demo',
      }],
    ]), { scope: 'project', projectPath: projectDir });

    await uninstallSkill('demo');

    expect(mocks.uninstallSkill).toHaveBeenCalledWith('demo', 'project');
    expect(db.prepare('SELECT id FROM skills WHERE id = ?').get(skillId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM project_skills WHERE installed_skill_id = ?').get(skillId)).toBeUndefined();
    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).not.toContain('github.com/acme/demo#skills/demo');
    expect(mod).toContain('mcp @playwright/mcp');
    const sum = await readFile(join(projectDir, 'skm.sum'), 'utf-8');
    expect(sum).not.toContain('github.com/acme/demo#skills/demo');
  });

  it('keeps skm.mod when project uninstall is run with --no-save', async () => {
    const { uninstallSkill } = await import('../src/core/installer.js');
    await seedSkill({
      name: 'local-only',
      scope: 'project',
      projectPath: projectDir,
      source: 'github.com/acme/local-only',
    });
    await writeFile(join(projectDir, 'skm.mod'), [
      'module demo-project',
      '',
      'skill github.com/acme/local-only v1.0.0',
      '',
    ].join('\n'));

    await uninstallSkill('local-only', { save: false });

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill github.com/acme/local-only v1.0.0');
  });

  it('refreshes existing project gitignore entries after project uninstall', async () => {
    const { uninstallSkill } = await import('../src/core/installer.js');
    await seedSkill({
      name: 'demo',
      scope: 'project',
      projectPath: projectDir,
      source: 'github.com/acme/demo',
    });
    await seedSkill({
      name: 'keep',
      scope: 'project',
      projectPath: projectDir,
      source: 'github.com/acme/keep',
    });
    await writeFile(
      join(projectDir, '.gitignore'),
      upsertManagedBlock('node_modules/\n', skillpkgGitignorePaths(['demo', 'keep']))
    );

    await uninstallSkill('demo', { save: false });

    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.agents/skills/keep');
    expect(gitignore.split('\n')).not.toContain('.agents/skills/demo');
    expect(gitignore.split('\n')).not.toContain('.agents/skills/');
  });

  it('falls back to global uninstall when the current project has no matching skill', async () => {
    const { uninstallSkill } = await import('../src/core/installer.js');
    await seedSkill({
      name: 'global-demo',
      scope: 'global',
      projectPath: '',
      source: 'github.com/acme/global-demo',
    });

    await uninstallSkill('global-demo');

    expect(mocks.uninstallSkill).toHaveBeenCalledWith('global-demo', 'global');
  });
});

async function seedSkill(options: {
  name: string;
  scope: 'global' | 'project';
  projectPath: string;
  source: string;
}): Promise<string> {
  const db = await getDb();
  const now = new Date().toISOString();
  const id = genId();
  db.prepare(`
    INSERT INTO skills
      (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
    VALUES (?, ?, ?, 'abc123', '0.0.0', 'demo skill', ?, ?, NULL, ?, NULL, NULL, 'sha256-demo', 'copy', 0, ?, ?, 'all')
  `).run(id, options.name, options.source, options.scope, options.projectPath, join(options.projectPath || rootFallback(), options.name), now, now);

  if (options.scope === 'project') {
    db.prepare(`
      INSERT INTO project_skills (id, project_path, skill_source, version, installed_skill_id)
      VALUES (?, ?, ?, 'v1.0.0', ?)
    `).run(genId(), options.projectPath, options.source, id);
  }

  return id;
}

function rootFallback(): string {
  return process.env['SKILLPKG_DATA_DIR'] || tmpdir();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
