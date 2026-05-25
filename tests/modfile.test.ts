import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSkillRequirement } from '../src/core/modfile.js';

describe('skm.mod saving', () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skm-modfile-'));
    projectDir = join(root, 'project');
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates skm.mod by default when creation is allowed', async () => {
    await saveSkillRequirement('github.com/acme/demo-skill', 'v1.0.0', {
      cwd: projectDir,
      allowCreate: true,
    });

    const mod = await readFile(join(projectDir, 'skm.mod'), 'utf-8');
    expect(mod).toBe([
      'module project',
      '',
      'skill github.com/acme/demo-skill v1.0.0',
      '',
    ].join('\n'));
  });

  it('does not create skm.mod for no-save installs', async () => {
    await saveSkillRequirement('github.com/acme/demo-skill', 'v1.0.0', {
      cwd: projectDir,
      save: false,
      allowCreate: true,
    });

    expect(existsSync(join(projectDir, 'skm.mod'))).toBe(false);
  });
});
