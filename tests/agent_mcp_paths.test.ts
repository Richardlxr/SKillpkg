import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityCliAdapter } from '../src/adapters/antigravity-cli.js';
import { checkMcpService } from '../src/utils/mcp_status.js';

const oldEnv = {
  SKILLPKG_HOME_DIR: process.env['SKILLPKG_HOME_DIR'],
};

describe('agent MCP path handling', () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skm-agent-mcp-'));
    projectDir = join(root, 'project');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    await mkdir(projectDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (oldEnv.SKILLPKG_HOME_DIR === undefined) {
      delete process.env['SKILLPKG_HOME_DIR'];
    } else {
      process.env['SKILLPKG_HOME_DIR'] = oldEnv.SKILLPKG_HOME_DIR;
    }
  });

  it('writes Antigravity CLI project MCP config to .agents/mcp_config.json', async () => {
    const adapter = new AntigravityCliAdapter();

    await adapter.configureMCP({
      name: 'demo',
      command: 'npx',
      args: ['-y', 'demo-mcp'],
      envKeys: [],
    }, {}, 'project');

    const config = await readJson(join(projectDir, '.agents', 'mcp_config.json'));
    expect(config['mcpServers']).toMatchObject({
      demo: {
        command: 'npx',
        args: ['-y', 'demo-mcp'],
      },
    });

    await expect(adapter.listConfiguredMCPs()).resolves.toContainEqual(expect.objectContaining({
      name: 'demo',
      command: 'npx',
    }));
  });

  it('marks node MCP servers unavailable when their entrypoint path is missing', async () => {
    const result = await checkMcpService({
      name: 'broken',
      command: 'node',
      args: [join(root, 'missing-server.js')],
    });

    expect(result.available).toBe(false);
    expect(result.detail).toContain('entrypoint not found');
  });
});

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
}
