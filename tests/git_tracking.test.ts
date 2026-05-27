import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSkill } from '../src/core/commands.js';
import { setGitPreference } from '../src/core/git_config.js';
import { handleProjectGitTracking } from '../src/core/git_tracking.js';
import { closeDb, getDb, genId } from '../src/db/index.js';

const mocks = vi.hoisted(() => ({
  prompt: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: mocks.prompt,
  },
}));

describe('project git tracking preference', () => {
  let root: string;
  let projectDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;
  let stdinDescriptor: PropertyDescriptor | undefined;
  let stdoutDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    closeDb();
    mocks.prompt.mockReset();
    root = await mkdtemp(join(tmpdir(), 'skm-git-tracking-'));
    projectDir = join(root, 'project');
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    await mkdir(projectDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
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

  it('applies auto gitignore for project link installs', async () => {
    const skillSource = await writeSkill(root, 'auto-demo');
    await setGitPreference('auto');

    await linkSkill(skillSource, { scope: 'project' });

    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('# === skillpkg managed');
    expect(gitignore).toContain('.agents/skills/auto-demo');
    expect(gitignore.split('\n')).not.toContain('.agents/skills/');
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('prompts in ask mode for project link installs', async () => {
    const skillSource = await writeSkill(root, 'ask-demo');
    await setGitPreference('ask');
    mocks.prompt.mockResolvedValue({ choice: 'ignore' });
    setTTY(true);

    await linkSkill(skillSource, { scope: 'project' });

    expect(mocks.prompt).toHaveBeenCalledOnce();
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(true);
    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.agents/skills/ask-demo');
  });

  it('saves project link installs to skm.mod only when requested', async () => {
    const skillSource = await writeSkill(root, 'saved-link');
    await setGitPreference('track');

    await linkSkill(skillSource, { scope: 'project', save: true });

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill file://');
    expect(mod).toContain('/saved-link');
    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.mcp.json');
    expect(gitignore).toContain('.claude/skills');
    expect(gitignore).toContain('.cursor/skills');
    expect(gitignore).not.toContain('.agents/skills/saved-link');
  });

  it('saves in-project local links as relative sources', async () => {
    const skillSource = await writeSkill(join(projectDir, '.agents', 'skills'), 'local-link');
    await setGitPreference('track');

    await linkSkill(skillSource, { scope: 'project', save: true });

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill ./.agents/skills/local-link');
    expect(mod).not.toContain('file://');
  });

  it('keeps unified project-local skills trackable in auto mode', async () => {
    const skillSource = await writeSkill(join(projectDir, '.agents', 'skills'), 'team-skill');
    await setGitPreference('auto');

    await linkSkill(skillSource, { scope: 'project' });

    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.mcp.json');
    expect(gitignore).toContain('.claude/skills');
    expect(gitignore).toContain('.cursor/skills');
    expect(gitignore).not.toContain('.agents/skills/team-skill');
  });

  it('writes stable native compatibility ignores even when local symlinks are absent', async () => {
    await mkdir(join(projectDir, '.agents', 'skills'), { recursive: true });

    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO skills
        (id, name, source_url, source_commit, version, description, scope, project_path, alias, installed_path, unified_path, symlink_target, integrity, install_mode, is_linked, installed_at, updated_at, assigned_agents)
      VALUES (?, 'remote-demo', 'https://github.com/acme/remote-demo.git', 'abc1234', '0.0.0', 'remote demo', 'project', ?, NULL, ?, ?, ?, 'sha256-old', 'symlink-cache', 1, ?, ?, 'all')
    `).run(
      genId(),
      projectDir,
      join(root, 'cache', 'remote-demo'),
      join(projectDir, '.agents', 'skills', 'remote-demo'),
      join(root, 'cache', 'remote-demo'),
      now,
      now
    );

    await setGitPreference('auto');
    await handleProjectGitTracking({ cwd: projectDir, yes: true });

    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.agents/skills/remote-demo');
    expect(gitignore).toContain('.claude/skills');
    expect(gitignore).toContain('.cursor/skills');
    expect(gitignore).not.toContain('.claude/skills/remote-demo');
    expect(gitignore).not.toContain('.cursor/skills/remote-demo');
  });
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
