import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';

describe('Codex MCP server names', () => {
  let root: string;
  let projectDir: string;
  let oldSkillpkgHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skm-codex-mcp-'));
    projectDir = join(root, 'project');
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    await mkdir(projectDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (oldSkillpkgHome === undefined) {
      delete process.env['SKILLPKG_HOME_DIR'];
    } else {
      process.env['SKILLPKG_HOME_DIR'] = oldSkillpkgHome;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('writes scoped npm packages under Codex-safe server ids', async () => {
    const adapter = new CodexAdapter();

    await adapter.configureMCP({
      name: '@drawio/mcp',
      command: 'npx',
      args: ['-y', '@drawio/mcp'],
      envKeys: [],
    }, {}, 'project');

    const config = await readFile(join(projectDir, '.codex', 'config.toml'), 'utf-8');
    expect(config).toContain('[mcp_servers."drawio-mcp"]');
    expect(config).not.toContain('[mcp_servers."@drawio/mcp"]');
  });

  it('removes legacy invalid blocks when reconfiguring a scoped package', async () => {
    const configPath = join(projectDir, '.codex', 'config.toml');
    await mkdir(join(projectDir, '.codex'), { recursive: true });
    await writeFile(configPath, [
      '[mcp_servers."@drawio/mcp"]',
      'command = "node"',
      'args = ["old.js"]',
      'enabled = true',
      '',
    ].join('\n'));

    const adapter = new CodexAdapter();
    await adapter.configureMCP({
      name: '@drawio/mcp',
      command: 'npx',
      args: ['-y', '@drawio/mcp'],
      envKeys: [],
    }, {}, 'project');

    const config = await readFile(configPath, 'utf-8');
    expect(config).toContain('[mcp_servers."drawio-mcp"]');
    expect(config).not.toContain('[mcp_servers."@drawio/mcp"]');

    await adapter.removeMCP('@drawio/mcp', 'project');
    await expect(readFile(configPath, 'utf-8')).resolves.not.toContain('drawio-mcp');
  });
});
