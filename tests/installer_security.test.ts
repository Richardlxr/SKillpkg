import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../src/db/index.js';

const mocks = vi.hoisted(() => ({
  cloneOrPull: vi.fn(),
  getCommitSha: vi.fn(),
  resolveAdapters: vi.fn(),
  getSetupHookDisplay: vi.fn(),
  runSetup: vi.fn(),
}));

vi.mock('../src/utils/git.js', () => ({
  checkout: vi.fn(),
  cloneOrPull: mocks.cloneOrPull,
  getCommitSha: mocks.getCommitSha,
}));

vi.mock('../src/adapters/index.js', () => ({
  detectAgents: vi.fn(),
  getAllAdapters: vi.fn(),
  resolveAdapters: mocks.resolveAdapters,
}));

vi.mock('../src/core/hooks.js', () => ({
  getSetupHookDisplay: mocks.getSetupHookDisplay,
  runSetup: mocks.runSetup,
}));

describe('installer security behavior', () => {
  let root: string;
  let repoDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldDataDir: string | undefined;
  let stdinDescriptor: PropertyDescriptor | undefined;
  let stdoutDescriptor: PropertyDescriptor | undefined;
  let installSkillForAgent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    closeDb();
    mocks.cloneOrPull.mockReset();
    mocks.getCommitSha.mockReset();
    mocks.resolveAdapters.mockReset();
    mocks.getSetupHookDisplay.mockReset();
    mocks.runSetup.mockReset();

    root = await mkdtemp(join(tmpdir(), 'skm-installer-security-'));
    repoDir = join(root, 'repo');
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');
    stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    setTTY(false);

    installSkillForAgent = vi.fn().mockResolvedValue('copy');
    mocks.cloneOrPull.mockResolvedValue(repoDir);
    mocks.getCommitSha.mockResolvedValue('abc1234567890');
    mocks.resolveAdapters.mockResolvedValue([{
      name: 'codex',
      installSkill: installSkillForAgent,
    }]);
    mocks.runSetup.mockResolvedValue(true);
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

  it('skips remote setup hooks by default in non-interactive installs', async () => {
    await writeSkill(repoDir, 'remote-demo', 'echo owned');
    mocks.getSetupHookDisplay.mockResolvedValue('echo owned');

    const { installSkill } = await import('../src/core/installer.js');
    await installSkill('github.com/acme/remote-demo', { scope: 'global' });

    expect(mocks.runSetup).not.toHaveBeenCalled();
    expect(installSkillForAgent).toHaveBeenCalled();
  });

  it('runs remote setup hooks when explicitly allowed', async () => {
    await writeSkill(repoDir, 'remote-demo', 'echo owned');
    mocks.getSetupHookDisplay.mockResolvedValue('echo owned');

    const { installSkill } = await import('../src/core/installer.js');
    await installSkill('github.com/acme/remote-demo', {
      scope: 'global',
      runScripts: true,
    });

    expect(mocks.runSetup).toHaveBeenCalledWith('echo owned', repoDir, 'remote-demo');
  });

  it('records copy mode when a requested symlink install degrades to copy', async () => {
    await writeSkill(repoDir, 'remote-demo');
    mocks.getSetupHookDisplay.mockResolvedValue(null);
    installSkillForAgent.mockResolvedValue('copy');

    const { installSkill } = await import('../src/core/installer.js');
    await installSkill('github.com/acme/remote-demo', {
      scope: 'global',
      mode: 'symlink-cache',
      noScripts: true,
    });

    const db = await getDb();
    const row = db.prepare('SELECT install_mode, is_linked, symlink_target FROM skills WHERE name = ?')
      .get('remote-demo') as { install_mode: string; is_linked: number; symlink_target: string | null };

    expect(row).toMatchObject({
      install_mode: 'copy',
      is_linked: 0,
      symlink_target: null,
    });
  });
});

async function writeSkill(path: string, name: string, setupCommand?: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} skill`,
    ...(setupCommand ? [`setup_command: ${setupCommand}`] : []),
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
