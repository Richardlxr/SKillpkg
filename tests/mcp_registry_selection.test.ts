import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECT_ALL_CHOICE_VALUE } from '../src/utils/searchable_selection.js';

const mocks = vi.hoisted(() => ({
  cloneOrPull: vi.fn(),
  getCommitSha: vi.fn(),
  execFile: vi.fn(),
  prompt: vi.fn(),
}));

vi.mock('../src/utils/git.js', () => ({
  cloneOrPull: mocks.cloneOrPull,
  getCommitSha: mocks.getCommitSha,
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

vi.mock('inquirer', () => ({
  default: {
    prompt: mocks.prompt,
  },
}));

describe('MCP project selection', () => {
  let root: string;
  let repoDir: string;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(async () => {
    vi.restoreAllMocks();
    mocks.cloneOrPull.mockReset();
    mocks.getCommitSha.mockReset();
    mocks.execFile.mockReset();
    mocks.prompt.mockReset();
    restorePlatform(platformDescriptor);

    root = await mkdtemp(join(tmpdir(), 'skm-mcp-selection-'));
    repoDir = join(root, 'repo');
    await writeNodeMcp(join(repoDir, 'alpha'), '@acme/alpha-mcp');
    await writeNodeMcp(join(repoDir, 'beta'), '@acme/beta-mcp');

    mocks.cloneOrPull.mockResolvedValue(repoDir);
    mocks.getCommitSha.mockResolvedValue('abc1234');
    mocks.execFile.mockImplementation((_cmd: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, '', '');
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restorePlatform(platformDescriptor);
    await rm(root, { recursive: true, force: true });
  });

  it('lets users search and select all matching MCP projects from a monorepo', async () => {
    const { getMcpConfigs } = await import('../src/core/mcp_registry.js');
    mocks.prompt
      .mockResolvedValueOnce({ mcpProjectSearch: '' })
      .mockResolvedValueOnce({ selectedMcpProjects: [SELECT_ALL_CHOICE_VALUE] });

    const configs = await getMcpConfigs('https://github.com/acme/mcps');

    expect(configs).toHaveLength(2);
    expect(configs.map((config) => config.name)).toEqual(['acme-alpha-mcp', 'acme-beta-mcp']);
    expect(configs.map((config) => config.source)).toEqual([
      'https://github.com/acme/mcps#alpha',
      'https://github.com/acme/mcps#beta',
    ]);

    const checkboxQuestion = mocks.prompt.mock.calls[1][0][0];
    expect(checkboxQuestion.name).toBe('selectedMcpProjects');
    expect(checkboxQuestion.choices[0]).toMatchObject({
      name: 'Select all 2 shown',
      value: SELECT_ALL_CHOICE_VALUE,
    });
  });

  it('filters MCP project choices by search text before selection', async () => {
    const { getMcpConfigs } = await import('../src/core/mcp_registry.js');
    mocks.prompt
      .mockResolvedValueOnce({ mcpProjectSearch: 'beta' })
      .mockResolvedValueOnce({ selectedMcpProjects: [join(repoDir, 'beta')] });

    const configs = await getMcpConfigs('https://github.com/acme/mcps');

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      name: 'acme-beta-mcp',
      source: 'https://github.com/acme/mcps#beta',
    });

    const checkboxQuestion = mocks.prompt.mock.calls[1][0][0];
    expect(checkboxQuestion.message).toContain('1 of 2 MCP projects matching "beta"');
    expect(checkboxQuestion.choices).toHaveLength(1);
    expect(checkboxQuestion.choices[0].name).toContain('@acme/beta-mcp');
  });

  it('does not run package lifecycle scripts when an entry point already exists', async () => {
    const { getMcpConfigs } = await import('../src/core/mcp_registry.js');
    const directRepo = join(root, 'direct-repo');
    await writeNodeMcp(directRepo, '@drawio/mcp', {
      scripts: {
        prepack: 'cp ../shared/xml-reference.md src/xml-reference.md',
      },
      main: 'src/index.js',
    });
    await writeFile(join(directRepo, 'src', 'index.js'), 'console.log("mcp");\n');
    mocks.cloneOrPull.mockResolvedValue(directRepo);
    mocks.execFile.mockImplementation((cmd: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (cmd.includes('npm') && args.includes('prepack')) {
        callback(new Error('cp is not recognized'), '', 'cp is not recognized');
        return;
      }
      callback(null, '', '');
    });

    const configs = await getMcpConfigs('https://github.com/jgraph/drawio-mcp.git');

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      name: 'drawio-mcp',
      command: 'node',
      args: [join(directRepo, 'src', 'index.js')],
    });
    expect(mocks.execFile.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['npm', ['install', '--ignore-scripts']],
    ]);
  });

  it('preflights Unix-only package scripts on Windows instead of running them through cmd.exe', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { getMcpConfigs } = await import('../src/core/mcp_registry.js');
    const directRepo = join(root, 'windows-unix-script');
    await writeNodeMcp(directRepo, '@acme/windows-mcp', {
      main: 'dist/index.js',
      scripts: {
        build: 'cp src/index.js dist/index.js',
      },
      writeEntry: false,
    });
    mocks.cloneOrPull.mockResolvedValue(directRepo);

    await expect(getMcpConfigs('https://github.com/acme/windows-mcp.git'))
      .rejects.toThrow(/Failed to build MCP from URL/);

    expect(mocks.execFile.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['npm.cmd', ['install', '--ignore-scripts']],
    ]);
  });

  it('uses Windows executable conventions for Go MCP builds', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { getMcpConfigs } = await import('../src/core/mcp_registry.js');
    const goRepo = join(root, 'go-repo');
    await mkdir(goRepo, { recursive: true });
    await writeFile(join(goRepo, 'go.mod'), 'module example.com/mcp\n\ngo 1.22\n');
    mocks.cloneOrPull.mockResolvedValue(goRepo);
    mocks.execFile.mockImplementation((cmd: string, args: string[], options: { cwd: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (cmd === 'go.exe' && args.includes('mcp-server.exe')) {
        writeFileSync(join(options.cwd, 'mcp-server.exe'), '');
      }
      callback(null, '', '');
    });

    const configs = await getMcpConfigs('https://github.com/acme/go-mcp.git');

    expect(configs[0]).toMatchObject({
      name: 'go-mcp',
      command: join(goRepo, 'mcp-server.exe'),
    });
    expect(mocks.execFile.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['go.exe', ['build', '-o', 'mcp-server.exe']],
    ]);
  });
});

async function writeNodeMcp(
  path: string,
  name: string,
  options: { main?: string; scripts?: Record<string, string>; writeEntry?: boolean } = {}
): Promise<void> {
  await mkdir(path, { recursive: true });
  const main = options.main || 'index.js';
  await writeFile(join(path, 'package.json'), JSON.stringify({
    name,
    main,
    scripts: options.scripts,
  }, null, 2));
  await mkdir(join(path, 'src'), { recursive: true });
  if (options.writeEntry !== false) {
    await mkdir(join(path, main.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(path, main), 'console.log("mcp");\n');
  }
}

function restorePlatform(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(process, 'platform', descriptor);
  }
}
