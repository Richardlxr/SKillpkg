import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityCliAdapter } from '../src/adapters/antigravity-cli.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { CursorAdapter } from '../src/adapters/cursor.js';
import type { McpRegistryEntry } from '../src/types/index.js';

describe('remote MCP config', () => {
  let root: string;
  let projectDir: string;
  let oldHome: string | undefined;
  let oldSkillpkgHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skm-remote-mcp-'));
    projectDir = join(root, 'project');
    oldHome = process.env['HOME'];
    oldSkillpkgHome = process.env['SKILLPKG_HOME_DIR'];
    process.env['HOME'] = join(root, 'home');
    process.env['SKILLPKG_HOME_DIR'] = join(root, 'home');
    await mkdir(projectDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreEnv('HOME', oldHome);
    restoreEnv('SKILLPKG_HOME_DIR', oldSkillpkgHome);
    await rm(root, { recursive: true, force: true });
  });

  it('writes remote MCP servers using each agent native URL field', async () => {
    const mcp: McpRegistryEntry = {
      name: 'draw-io',
      type: 'http',
      url: 'https://mcp.draw.io/mcp',
      command: '',
      args: [],
      envKeys: [],
    };

    await new CodexAdapter().configureMCP(mcp, {}, 'project');
    await new ClaudeCodeAdapter().configureMCP(mcp, {}, 'project');
    await new CursorAdapter().configureMCP(mcp, {}, 'project');
    await new AntigravityCliAdapter().configureMCP(mcp, {}, 'project');

    expect(await readFile(join(projectDir, '.codex', 'config.toml'), 'utf-8'))
      .toContain('url = "https://mcp.draw.io/mcp"');

    const claude = await readJson(join(projectDir, '.mcp.json'));
    expect(claude['mcpServers']).toMatchObject({
      'draw-io': { type: 'http', url: 'https://mcp.draw.io/mcp' },
    });

    const cursor = await readJson(join(projectDir, '.cursor', 'mcp.json'));
    expect(cursor['mcpServers']).toMatchObject({
      'draw-io': { type: 'http', url: 'https://mcp.draw.io/mcp' },
    });

    const antigravity = await readJson(join(projectDir, '.agents', 'mcp_config.json'));
    expect(antigravity['mcpServers']).toMatchObject({
      'draw-io': { serverUrl: 'https://mcp.draw.io/mcp' },
    });
  });

  it('preserves legacy SSE transport where agent configs support a transport type', async () => {
    const mcp: McpRegistryEntry = {
      name: 'asana-com',
      type: 'sse',
      url: 'https://mcp.asana.com/sse',
      command: '',
      args: [],
      envKeys: [],
    };

    await new CodexAdapter().configureMCP(mcp, {}, 'project');
    await new ClaudeCodeAdapter().configureMCP(mcp, {}, 'project');
    await new CursorAdapter().configureMCP(mcp, {}, 'project');
    await new AntigravityCliAdapter().configureMCP(mcp, {}, 'project');

    expect(await readFile(join(projectDir, '.codex', 'config.toml'), 'utf-8'))
      .toContain('url = "https://mcp.asana.com/sse"');

    const claude = await readJson(join(projectDir, '.mcp.json'));
    expect(claude['mcpServers']).toMatchObject({
      'asana-com': { type: 'sse', url: 'https://mcp.asana.com/sse' },
    });

    const cursor = await readJson(join(projectDir, '.cursor', 'mcp.json'));
    expect(cursor['mcpServers']).toMatchObject({
      'asana-com': { type: 'sse', url: 'https://mcp.asana.com/sse' },
    });

    const antigravity = await readJson(join(projectDir, '.agents', 'mcp_config.json'));
    expect(antigravity['mcpServers']).toMatchObject({
      'asana-com': { serverUrl: 'https://mcp.asana.com/sse' },
    });
  });

  it('does not overwrite Claude global config when it cannot be parsed', async () => {
    const configPath = join(process.env['HOME'] as string, '.claude.json');
    await mkdir(join(process.env['HOME'] as string), { recursive: true });
    await writeFile(configPath, '{ invalid json');

    await expect(new ClaudeCodeAdapter().configureMCP({
      name: 'draw-io',
      command: 'npx',
      args: ['draw-io'],
      envKeys: [],
    }, {}, 'global')).rejects.toThrow(/Failed to read JSON config/);

    expect(await readFile(configPath, 'utf-8')).toBe('{ invalid json');
  });

  it('removes legacy Claude project MCP entries from ~/.claude.json', async () => {
    await new ClaudeCodeAdapter().configureMCP({
      name: 'draw-io',
      command: 'npx',
      args: ['draw-io'],
      envKeys: [],
    }, {}, 'project');

    const globalConfigPath = join(process.env['HOME'] as string, '.claude.json');
    await mkdir(join(process.env['HOME'] as string), { recursive: true });
    await writeFile(globalConfigPath, JSON.stringify({
      oauthAccount: { id: 'keep' },
      projects: {
        [projectDir]: {
          mcpServers: {
            'draw-io': { command: 'old', args: [] },
            keep: { command: 'node', args: ['keep.js'] },
          },
        },
      },
    }, null, 2));

    await new ClaudeCodeAdapter().removeMCP('draw-io', 'project');

    const projectConfig = await readJson(join(projectDir, '.mcp.json'));
    expect(projectConfig['mcpServers']).toEqual({});

    const globalConfig = await readJson(globalConfigPath);
    expect(globalConfig['oauthAccount']).toEqual({ id: 'keep' });
    expect((globalConfig['projects'] as Record<string, any>)[projectDir]['mcpServers']).toEqual({
      keep: { command: 'node', args: ['keep.js'] },
    });
  });
});

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
