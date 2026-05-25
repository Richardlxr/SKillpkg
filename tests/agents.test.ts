import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAllAdapters } from '../src/adapters/index.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ALL_AGENT_TYPES } from '../src/types/index.js';

describe('agent registry', () => {
  it('registers one adapter for every supported agent type', () => {
    const adapterNames = getAllAdapters().map((adapter) => adapter.name);

    expect(adapterNames.sort()).toEqual([...ALL_AGENT_TYPES].sort());
    expect(adapterNames).toContain('antigravity-cli');
    expect(adapterNames).not.toContain('gemini-cli');
  });
});

describe('Codex adapter detection', () => {
  let root: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;
  let oldCodexHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skm-codex-detect-'));
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    oldCodexHome = process.env['CODEX_HOME'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    delete process.env['CODEX_HOME'];
  });

  afterEach(async () => {
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    restoreEnv('CODEX_HOME', oldCodexHome);
    await rm(root, { recursive: true, force: true });
  });

  it('detects Codex from its config directory even before the skills directory exists', async () => {
    const home = process.env['HOME'] as string;
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(join(home, '.codex', 'config.toml'), '');

    const adapter = new CodexAdapter();

    expect(await adapter.detect()).toBe(true);
  });

  it('uses the Codex home skills directory for global installs', async () => {
    const home = process.env['HOME'] as string;
    const skillDir = join(home, '.codex', 'skills', 'codex-home-skill');
    await writeSkill(skillDir, 'codex-home-skill', 'from codex home dir');

    const adapter = new CodexAdapter();

    expect(adapter.getSkillsDir('global')).toBe(join(home, '.codex', 'skills'));
    expect(await adapter.listInstalled('global')).toContainEqual(expect.objectContaining({
      name: 'codex-home-skill',
      path: skillDir,
      hasSkillMd: true,
      description: 'from codex home dir',
    }));
  });

  it('still scans legacy ~/.agents/skills for previously installed Codex skills', async () => {
    const home = process.env['HOME'] as string;
    const legacySkillDir = join(home, '.agents', 'skills', 'legacy-codex-skill');
    await writeSkill(legacySkillDir, 'legacy-codex-skill', 'from legacy shared dir');

    const adapter = new CodexAdapter();
    const installed = await adapter.listInstalled('global');

    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      name: 'legacy-codex-skill',
      path: legacySkillDir,
      hasSkillMd: true,
      description: 'from legacy shared dir',
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
