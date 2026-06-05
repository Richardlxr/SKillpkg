import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityCliAdapter } from '../src/adapters/antigravity-cli.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { checkMcpService } from '../src/utils/mcp_status.js';

const oldEnv = {
  SKILLPKG_HOME_DIR: process.env['SKILLPKG_HOME_DIR'],
  SKILLPKG_DATA_DIR: process.env['SKILLPKG_DATA_DIR'],
};

describe('agent MCP path handling', () => {
  let root: string;
  let projectDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skm-agent-mcp-'));
    projectDir = join(root, 'project');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    delete process.env['SKILLPKG_DATA_DIR'];
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
    if (oldEnv.SKILLPKG_DATA_DIR === undefined) {
      delete process.env['SKILLPKG_DATA_DIR'];
    } else {
      process.env['SKILLPKG_DATA_DIR'] = oldEnv.SKILLPKG_DATA_DIR;
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

  it('rewrites legacy skillpkg cache paths when configuring MCP servers', async () => {
    const adapter = new ClaudeCodeAdapter();
    const homeDir = process.env['SKILLPKG_HOME_DIR']!;
    const relativeCachePath = join('mcp-cache', 'demo-mcp', 'server.js');
    const currentEntrypoint = join(homeDir, '.skillpkg', relativeCachePath);
    const legacyEntrypoint = join(homeDir, 'Library', 'Application Support', 'skillpkg', relativeCachePath);
    await mkdir(join(homeDir, '.skillpkg', 'mcp-cache', 'demo-mcp'), { recursive: true });
    await writeFile(currentEntrypoint, 'console.log("demo");\n');

    await adapter.configureMCP({
      name: 'demo',
      command: 'node',
      args: [legacyEntrypoint],
      envKeys: [],
    }, {}, 'project');

    const config = await readJson(join(projectDir, '.mcp.json'));
    const mcpServers = config['mcpServers'] as Record<string, { args: string[] }>;
    expect(mcpServers['demo']?.args).toEqual([currentEntrypoint]);
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

  it('surfaces the migrated path when a legacy entrypoint path is stale', async () => {
    const homeDir = process.env['SKILLPKG_HOME_DIR']!;
    const relativeCachePath = join('mcp-cache', 'demo-mcp', 'server.js');
    const currentEntrypoint = join(homeDir, '.skillpkg', relativeCachePath);
    const legacyEntrypoint = join(homeDir, 'Library', 'Application Support', 'skillpkg', relativeCachePath);
    await mkdir(join(homeDir, '.skillpkg', 'mcp-cache', 'demo-mcp'), { recursive: true });
    await writeFile(currentEntrypoint, 'console.log("demo");\n');

    const result = await checkMcpService({
      name: 'stale',
      command: 'node',
      args: [legacyEntrypoint],
    });

    expect(result.available).toBe(false);
    expect(result.detail).toContain(currentEntrypoint);
  });
});

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
}
