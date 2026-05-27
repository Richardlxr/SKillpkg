import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { initManifest } from '../src/core/commands.js';
import { closeDb, getDb, genId } from '../src/db/index.js';

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: mocks.prompt,
  },
}));

describe('skm init', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;
  let stdinDescriptor: PropertyDescriptor | undefined;
  let stdoutDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    closeDb();
    root = await mkdtemp(join(tmpdir(), 'skm-init-'));
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    mocks.prompt.mockReset();
    stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDb();
    restoreDescriptor(process.stdin, 'isTTY', stdinDescriptor);
    restoreDescriptor(process.stdout, 'isTTY', stdoutDescriptor);
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    restoreEnv('SKILLPKG_DATA_DIR', oldDataDir);
    await rm(root, { recursive: true, force: true });
  });

  it('adopts project-local skills from .agents/skills into mod, sum, db, and native links', async () => {
    await writeSkill(join(root, '.agents', 'skills', 'context'), 'context');
    await writeSkill(join(root, '.agents', 'skills', 'writer'), 'writer');
    await writeSkill(join(root, 'cache', 'downloaded'), 'downloaded');
    let symlinkCreated = false;
    try {
      await symlink(join(root, 'cache', 'downloaded'), join(root, '.agents', 'skills', 'downloaded'), 'dir');
      symlinkCreated = true;
    } catch {
      // Symlink creation can be unavailable on some platforms; the core assertions still apply.
    }

    await initManifest(undefined, false);

    expect(existsSync(join(root, 'SKILL.md'))).toBe(false);
    expect(await readFile(join(root, 'skm.mod'), 'utf-8')).toBe([
      `module ${basename(root)}`,
      '',
      'skill ./.agents/skills/context',
      ...(symlinkCreated ? ['skill ./.agents/skills/downloaded'] : []),
      'skill ./.agents/skills/writer',
      '',
    ].join('\n'));
    const gitignore = await readFile(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.agents/mcp_config.json');
    expect(gitignore).toContain('.claude/skills');
    expect(gitignore).toContain('.cursor/skills');

    if (symlinkCreated) {
      expect((await lstat(join(root, '.agents', 'skills', 'downloaded'))).isSymbolicLink()).toBe(false);
    }

    expect((await lstat(join(root, '.claude', 'skills'))).isSymbolicLink()).toBe(true);
    expect(resolve(join(root, '.claude'), await readlink(join(root, '.claude', 'skills'))))
      .toBe(join(root, '.agents', 'skills'));

    const sum = await readFile(join(root, 'skm.sum'), 'utf-8');
    expect(sum).toContain('./.agents/skills/context 0.0.0 sha256-');
    if (symlinkCreated) {
      expect(sum).toContain('./.agents/skills/downloaded 0.0.0 sha256-');
    }
    expect(sum).toContain('./.agents/skills/writer 0.0.0 sha256-');

    const db = await getDb();
    const rows = db.prepare(`
      SELECT name, source_url, scope, project_path, installed_path, install_mode
      FROM skills
      WHERE scope = 'project' AND project_path = ?
      ORDER BY name
    `).all(root);

    expect(rows).toMatchObject([
      {
        name: 'context',
        source_url: './.agents/skills/context',
        scope: 'project',
        project_path: root,
        installed_path: join(root, '.agents', 'skills', 'context'),
        install_mode: 'copy',
      },
      ...(symlinkCreated ? [{
        name: 'downloaded',
        source_url: './.agents/skills/downloaded',
        scope: 'project',
        project_path: root,
        installed_path: join(root, '.agents', 'skills', 'downloaded'),
        install_mode: 'copy',
      }] : []),
      {
        name: 'writer',
        source_url: './.agents/skills/writer',
        scope: 'project',
        project_path: root,
        installed_path: join(root, '.agents', 'skills', 'writer'),
        install_mode: 'copy',
      },
    ]);
  });

  it('keeps sourced project skill symlinks as manifest dependencies', async () => {
    const cachedSkill = join(root, 'cache', 'remote-skill');
    const projectSkill = join(root, '.agents', 'skills', 'remote-skill');
    await writeSkill(cachedSkill, 'remote-skill');
    await mkdir(join(root, '.agents', 'skills'), { recursive: true });
    await symlink(cachedSkill, projectSkill, 'dir');

    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, 'remote-skill', 'https://github.com/acme/remote-skill.git', 'abc1234', '0.0.0', 'remote skill', 'project', ?, NULL, ?, ?, ?, 'sha256-old', 'symlink-cache', 1, ?, ?, 'all')
    `).run(genId(), root, cachedSkill, projectSkill, cachedSkill, now, now);

    await initManifest(undefined, false);

    const mod = await readFile(join(root, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill https://github.com/acme/remote-skill.git');
    expect(mod).not.toContain('skill ./.agents/skills/remote-skill');

    const gitignore = await readFile(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.agents/skills/remote-skill');

    const sum = await readFile(join(root, 'skm.sum'), 'utf-8');
    expect(sum).toContain('https://github.com/acme/remote-skill.git 0.0.0 sha256-');

    const row = db.prepare(`
      SELECT source_url, install_mode, symlink_target
      FROM skills
      WHERE name = 'remote-skill' AND scope = 'project' AND project_path = ?
    `).get(root) as { source_url: string; install_mode: string; symlink_target: string } | undefined;

    expect(row).toMatchObject({
      source_url: 'https://github.com/acme/remote-skill.git',
      install_mode: 'symlink-cache',
      symlink_target: cachedSkill,
    });
  });

  it('asks before adopting sourced project skill symlinks that do not match skm.sum', async () => {
    const cachedSkill = join(root, 'cache', 'remote-skill');
    const projectSkill = join(root, '.agents', 'skills', 'remote-skill');
    await writeSkill(cachedSkill, 'remote-skill');
    await mkdir(join(root, '.agents', 'skills'), { recursive: true });
    await symlink(cachedSkill, projectSkill, 'dir');
    await writeFile(join(root, 'skm.sum'), [
      'https://github.com/acme/remote-skill.git 0.0.0 sha256-stale',
      '',
    ].join('\n'));

    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, 'remote-skill', 'https://github.com/acme/remote-skill.git', 'abc1234', '0.0.0', 'remote skill', 'project', ?, NULL, ?, ?, ?, 'sha256-old', 'symlink-cache', 1, ?, ?, 'all')
    `).run(genId(), root, cachedSkill, projectSkill, cachedSkill, now, now);

    setTTY(true);
    mocks.prompt.mockImplementation(async (questions: Array<{ name: string }>) => {
      const name = questions[0]?.name;
      if (name === 'acceptMismatchedSkill') return { acceptMismatchedSkill: false };
      if (name === 'gitPreference') return { gitPreference: 'track' };
      return {};
    });

    await initManifest(undefined, true);

    expect(mocks.prompt).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'acceptMismatchedSkill' }),
    ]));

    const mod = await readFile(join(root, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill https://github.com/acme/remote-skill.git');

    const sum = await readFile(join(root, 'skm.sum'), 'utf-8');
    expect(sum).toContain('https://github.com/acme/remote-skill.git 0.0.0 sha256-stale');
  });

  it('updates skm.sum for mismatched sourced project skill symlinks when accepted non-interactively', async () => {
    const cachedSkill = join(root, 'cache', 'remote-skill');
    const projectSkill = join(root, '.agents', 'skills', 'remote-skill');
    await writeSkill(cachedSkill, 'remote-skill');
    await mkdir(join(root, '.agents', 'skills'), { recursive: true });
    await symlink(cachedSkill, projectSkill, 'dir');
    await writeFile(join(root, 'skm.sum'), [
      'https://github.com/acme/remote-skill.git 0.0.0 sha256-stale',
      '',
    ].join('\n'));

    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, 'remote-skill', 'https://github.com/acme/remote-skill.git', 'abc1234', '0.0.0', 'remote skill', 'project', ?, NULL, ?, ?, ?, 'sha256-old', 'symlink-cache', 1, ?, ?, 'all')
    `).run(genId(), root, cachedSkill, projectSkill, cachedSkill, now, now);

    await initManifest(undefined, false);

    const mod = await readFile(join(root, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill https://github.com/acme/remote-skill.git');

    const sum = await readFile(join(root, 'skm.sum'), 'utf-8');
    expect(sum).toContain('https://github.com/acme/remote-skill.git 0.0.0 sha256-');
    expect(sum).not.toContain('sha256-stale');
  });

  it('adopts project MCP config into mod and sum', async () => {
    const repoRoot = join(root, 'data', 'mcp-cache', 'github.com', 'acme', 'demo-mcp');
    const mcpProject = join(repoRoot, 'server');
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    await mkdir(join(mcpProject, 'src'), { recursive: true });
    await writeFile(join(mcpProject, 'package.json'), JSON.stringify({
      name: '@acme/demo-mcp',
      main: 'src/index.js',
    }));
    await writeFile(join(mcpProject, 'src', 'index.js'), 'console.log("mcp");\n');
    await mkdir(join(root, '.agents'), { recursive: true });
    await writeFile(join(root, '.agents', 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        'demo-mcp': {
          command: 'node',
          args: [join(mcpProject, 'src', 'index.js')],
        },
      },
    }, null, 2));

    await initManifest(undefined, false);

    const mod = await readFile(join(root, 'skm.mod'), 'utf-8');
    expect(mod).toContain('mcp https://github.com/acme/demo-mcp.git#server');

    const sum = await readFile(join(root, 'skm.sum'), 'utf-8');
    expect(sum).toContain('mcp:https://github.com/acme/demo-mcp.git#server mcp sha256-');
  });

  it('keeps root skill projects installable from skm.mod', async () => {
    await writeSkill(root, 'root-skill');

    await initManifest(undefined, false);

    expect(await readFile(join(root, 'skm.mod'), 'utf-8')).toBe([
      'module root-skill',
      '',
      'skill .',
      '',
    ].join('\n'));
  });
});

async function writeSkill(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} skill`,
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

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

function restoreDescriptor(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  property: 'isTTY',
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(stream, property, descriptor);
  } else {
    delete (stream as unknown as Record<string, unknown>)[property];
  }
}
