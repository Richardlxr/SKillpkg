import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../src/db/index.js';
import { setGitPreference } from '../src/core/git_config.js';
import { SELECT_ALL_CHOICE_VALUE } from '../src/utils/searchable_selection.js';

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  cloneOrPull: vi.fn(),
  getCommitSha: vi.fn(),
  prompt: vi.fn(),
  resolveAdapters: vi.fn(),
}));

vi.mock('../src/utils/git.js', () => ({
  checkout: mocks.checkout,
  cloneOrPull: mocks.cloneOrPull,
  getCommitSha: mocks.getCommitSha,
}));

vi.mock('../src/adapters/index.js', () => ({
  detectAgents: vi.fn(),
  getAllAdapters: vi.fn(),
  resolveAdapters: mocks.resolveAdapters,
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: mocks.prompt,
  },
}));

describe('multi-skill project git tracking', () => {
  let root: string;
  let projectDir: string;
  let repoDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;
  let stdinDescriptor: PropertyDescriptor | undefined;
  let stdoutDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    closeDb();
    mocks.checkout.mockReset();
    mocks.cloneOrPull.mockReset();
    mocks.getCommitSha.mockReset();
    mocks.prompt.mockReset();
    mocks.resolveAdapters.mockReset();

    root = await mkdtemp(join(tmpdir(), 'skm-multi-skill-git-'));
    projectDir = join(root, 'project');
    repoDir = join(root, 'repo');
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    await mkdir(projectDir, { recursive: true });
    await writeSkill(join(repoDir, 'skills', 'alpha'), 'alpha');
    await writeSkill(join(repoDir, 'skills', 'beta'), 'beta');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    setTTY(true);

    mocks.cloneOrPull.mockResolvedValue(repoDir);
    mocks.getCommitSha.mockResolvedValue('abc1234567890');
    mocks.resolveAdapters.mockResolvedValue([{
      name: 'codex',
      installSkill: vi.fn(),
    }]);
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

  it('asks about git tracking after installing a selected skill from a multi-skill repo', async () => {
    const { installSkill } = await import('../src/core/installer.js');
    await setGitPreference('ask');
    mocks.prompt
      .mockResolvedValueOnce({ skillSearch: '' })
      .mockResolvedValueOnce({ selectedSkills: ['skills/alpha'] })
      .mockResolvedValueOnce({ choice: 'ignore' });

    await installSkill('git@example.com:org/repo.git', {
      scope: 'project',
      noScripts: true,
    });

    expect(mocks.prompt).toHaveBeenCalledTimes(3);
    expect(mocks.prompt.mock.calls[0][0][0].name).toBe('skillSearch');
    expect(mocks.prompt.mock.calls[1][0][0].name).toBe('selectedSkills');
    expect(mocks.prompt.mock.calls[2][0][0].name).toBe('choice');
    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('# === skillpkg managed');
    expect(gitignore).toContain('.agents/skills/alpha');
    expect(gitignore.split('\n')).not.toContain('.agents/skills/');
  });

  it('filters multi-skill install choices by skill name', async () => {
    const { installSkill } = await import('../src/core/installer.js');
    await setGitPreference('track');
    await writeFile(join(projectDir, 'skm.mod'), 'module demo\n');
    mocks.prompt
      .mockResolvedValueOnce({ skillSearch: 'bet' })
      .mockResolvedValueOnce({ selectedSkills: ['skills/beta'] });

    await installSkill('git@example.com:org/repo.git#v1.2.3', {
      scope: 'project',
      noScripts: true,
    });

    const checkboxQuestion = mocks.prompt.mock.calls[1][0][0];
    const checkboxChoices = checkboxQuestion.choices as Array<{ name: string; value: string }>;
    expect(checkboxQuestion.message).toContain('1 of 2 skills matching "bet"');
    expect(checkboxChoices).toHaveLength(1);
    expect(checkboxChoices[0].name).toContain('beta');
    expect(checkboxChoices[0].value).toBe('skills/beta');

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill git@example.com:org/repo.git#skills/beta v1.2.3');
    expect(mod).not.toContain('skills/alpha');
  });

  it('saves selected multi-skill project installs to skm.mod', async () => {
    const { installSkill } = await import('../src/core/installer.js');
    await setGitPreference('track');
    await writeFile(join(projectDir, 'skm.mod'), 'module demo\n');
    mocks.prompt
      .mockResolvedValueOnce({ skillSearch: '' })
      .mockResolvedValueOnce({ selectedSkills: ['skills/alpha'] });

    await installSkill('git@example.com:org/repo.git#v1.2.3', {
      scope: 'project',
      noScripts: true,
    });

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill git@example.com:org/repo.git#skills/alpha v1.2.3');
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
  });

  it('can select all visible skills after searching', async () => {
    const { installSkill } = await import('../src/core/installer.js');
    await setGitPreference('track');
    await writeFile(join(projectDir, 'skm.mod'), 'module demo\n');
    mocks.prompt
      .mockResolvedValueOnce({ skillSearch: '' })
      .mockResolvedValueOnce({ selectedSkills: [SELECT_ALL_CHOICE_VALUE] });

    await installSkill('git@example.com:org/repo.git#v1.2.3', {
      scope: 'project',
      noScripts: true,
    });

    const checkboxQuestion = mocks.prompt.mock.calls[1][0][0];
    const checkboxChoices = checkboxQuestion.choices as Array<{ name: string; value: string }>;
    expect(checkboxChoices[0]).toMatchObject({
      name: 'Select all 2 shown',
      value: SELECT_ALL_CHOICE_VALUE,
    });

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toContain('skill git@example.com:org/repo.git#skills/alpha v1.2.3');
    expect(mod).toContain('skill git@example.com:org/repo.git#skills/beta v1.2.3');
  });

  it('honors --no-save for selected multi-skill project installs', async () => {
    const { installSkill } = await import('../src/core/installer.js');
    await setGitPreference('track');
    await writeFile(join(projectDir, 'skm.mod'), 'module demo\n');
    mocks.prompt
      .mockResolvedValueOnce({ skillSearch: '' })
      .mockResolvedValueOnce({ selectedSkills: ['skills/alpha'] });

    await installSkill('git@example.com:org/repo.git#v1.2.3', {
      scope: 'project',
      noScripts: true,
      save: false,
    });

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toBe('module demo\n');
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
