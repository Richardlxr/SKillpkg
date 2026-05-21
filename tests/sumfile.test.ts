import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSumfilePath,
  loadSumfile,
  saveSumfile,
  verifyIntegrity,
} from '../src/core/sumfile.js';
import { defaultInstallScopeForCwd, getDefaultConfig } from '../src/utils/platform.js';

describe('sumfile scope handling', () => {
  it('uses separate global and project sumfiles', async () => {
    const root = await mkdtempRoot();
    const oldDataDir = process.env['SKILLPKG_DATA_DIR'];
    process.env['SKILLPKG_DATA_DIR'] = join(root, 'data');

    try {
      const projectDir = join(root, 'project');
      await mkdir(projectDir, { recursive: true });

      await saveSumfile(new Map([
        ['github.com/acme/global-skill', {
          source: 'github.com/acme/global-skill',
          version: '1.0.0',
          integrity: 'sha256-global',
        }],
      ]), { scope: 'global' });
      await saveSumfile(new Map([
        ['github.com/acme/project-skill', {
          source: 'github.com/acme/project-skill',
          version: '2.0.0',
          integrity: 'sha256-project',
        }],
      ]), { scope: 'project', projectPath: projectDir });

      expect(getSumfilePath({ scope: 'global' })).toBe(getDefaultConfig().sumfilePath);
      expect(await loadSumfile({ scope: 'global' })).toHaveProperty('size', 1);
      expect(await loadSumfile({ scope: 'project', projectPath: projectDir })).toHaveProperty('size', 1);

      const globalContent = await readFile(join(root, 'data', 'skm.sum'), 'utf-8');
      const projectContent = await readFile(join(projectDir, 'skm.sum'), 'utf-8');
      expect(globalContent).toContain('github.com/acme/global-skill');
      expect(projectContent).toContain('github.com/acme/project-skill');
    } finally {
      restoreEnv('SKILLPKG_DATA_DIR', oldDataDir);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not silently pass verification when a sumfile entry is missing', async () => {
    const root = await mkdtempRoot();

    try {
      await writeFile(join(root, 'SKILL.md'), 'name: demo\n');
      const result = await verifyIntegrity('github.com/acme/missing', root, new Map());

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('missing-entry');
      expect(result.expected).toBe('<no entry in sumfile>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores malformed sumfile lines', async () => {
    const root = await mkdtempRoot();

    try {
      await writeFile(join(root, 'skm.sum'), [
        'not-enough-columns',
        'too many columns sha256-extra trailing',
        'bad-integrity 1.0.0 md5-nope',
        'valid-source 1.0.0 sha256-good',
        '',
      ].join('\n'));

      const entries = await loadSumfile(root);
      expect(Array.from(entries.keys())).toEqual(['valid-source']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('default install scope', () => {
  it('defaults to project inside a skillpkg or git workspace', async () => {
    const root = await mkdtempRoot();

    try {
      expect(await defaultInstallScopeForCwd(root)).toBe('global');

      await writeFile(join(root, 'skm.mod'), 'module demo\n');
      expect(await defaultInstallScopeForCwd(root)).toBe('project');

      await rm(join(root, 'skm.mod'), { force: true });
      await mkdir(join(root, '.git'));
      expect(await defaultInstallScopeForCwd(root)).toBe('project');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function mkdtempRoot(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'skm-sumfile-test-'));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
