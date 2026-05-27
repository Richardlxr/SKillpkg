import type { McpRegistryEntry } from '../types/index.js';
import { looksLikeMcpAppName, toMcpServerName } from '../utils/mcp_names.js';
import { promptForSearchableSelection } from '../utils/searchable_selection.js';

/**
 * Built-in registry of known MCP servers.
 * This provides the command, args, and required environment variables for popular MCP servers.
 */
export const MCP_REGISTRY: Record<string, McpRegistryEntry> = {
  'wps-office': {
    name: 'wps-office',
    command: 'npx',
    args: ['-y', 'wps-office-mcp'],
    envKeys: []
  },
  'github': {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN']
  },
  'sqlite': {
    name: 'sqlite',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    envKeys: []
  },
  'postgres': {
    name: 'postgres',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    envKeys: ['POSTGRES_URL']
  },
  'puppeteer': {
    name: 'puppeteer',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envKeys: []
  },
  'memory': {
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envKeys: []
  },
  'brave-search': {
    name: 'brave-search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envKeys: ['BRAVE_API_KEY']
  }
};

import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { windowsShellCompatibilityIssue } from '../utils/shell.js';

/**
 * Resolve an MCP config by name or Git URL.
 * If the name is in the registry, returns the registered config.
 * If it's a Git URL, clones, builds, and returns absolute path.
 * Otherwise, builds a generic fallback config assuming it is an npm package.
 */
export async function getMcpConfig(name: string): Promise<McpRegistryEntry> {
  const configs = await getMcpConfigs(name);
  if (configs.length === 0) {
    throw new Error(`Could not resolve MCP config for '${name}'.`);
  }
  return configs[0];
}

export async function getMcpConfigs(name: string): Promise<McpRegistryEntry[]> {
  // Handle names with @version, but preserve scoped packages (e.g. @org/pkg@1.0.0)
  const atIndex = name.lastIndexOf('@');
  const pkgName = atIndex > 0 ? name.substring(0, atIndex) : name;
  
  if (MCP_REGISTRY[pkgName]) {
    return [MCP_REGISTRY[pkgName]];
  }

  if (isRemoteMcpEndpoint(name)) {
    return [{
      name: nameFromRemoteMcpUrl(name),
      type: remoteMcpTransport(name) || 'http',
      url: name,
      command: '',
      args: [],
      envKeys: [],
    }];
  }

  if (looksLikeMcpAppPackageName(pkgName)) {
    throw new Error(
      `MCP package '${pkgName}' appears to be an MCP App/HTTP server. ` +
      `skm currently configures stdio MCP clients only. Use a stdio MCP package or server subdirectory instead.`
    );
  }

  const isScopedNpmPackage = pkgName.startsWith('@') && pkgName.split('/').length === 2;

  // If it's a URL or github shorthand, attempt to build from source.
  // Scoped npm packages such as @modelcontextprotocol/server-memory also contain
  // a slash, but should go through the npx fallback instead.
  if (name.includes('://') || name.startsWith('github:') || (!isScopedNpmPackage && name.split('/').length >= 2)) {
    try {
      const builtConfigs = await buildMcpsFromSource(name);
      if (builtConfigs && builtConfigs.length > 0) return builtConfigs;
    } catch (e: any) {
      const chalk = (await import('chalk')).default;
      console.warn(chalk.yellow(`\n⚠️  Failed to build MCP from source '${name}': ${e.message}`));
      // For URLs, we should NOT fall back to npx unless it's a github: shorthand that npx might handle
      if (name.includes('://')) {
        throw new Error(`Failed to build MCP from URL '${name}'. See above for details.`);
      }
    }
  }

  // Generic fallback (only for package names or github shorthand)
  if (name.includes('://')) {
    throw new Error(`Could not detect project type for MCP URL '${name}'. Please ensure the repository contains a package.json, pyproject.toml, or go.mod.`);
  }

  return [{
    name: toMcpServerName(pkgName),
    command: 'npx',
    args: ['-y', name],
    envKeys: []
  }];
}

export function looksLikeMcpAppPackageName(name: string): boolean {
  return looksLikeMcpAppName(name);
}

export function isRemoteMcpEndpoint(source: string): boolean {
  return remoteMcpTransport(source) !== null;
}

export function remoteMcpTransport(source: string): 'http' | 'sse' | null {
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (isLikelyGitHostUrl(url)) return null;

    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    if (path === '/sse' || path.endsWith('/sse')) return 'sse';
    if (path === '/mcp' || path.endsWith('/mcp')) return 'http';
    return 'http';
  } catch {
    return null;
  }
}

function isLikelyGitHostUrl(url: URL): boolean {
  return (
    ['github.com', 'gitlab.com', 'bitbucket.org'].includes(url.hostname.toLowerCase()) ||
    url.pathname.endsWith('.git')
  );
}

function nameFromRemoteMcpUrl(source: string): string {
  const url = new URL(source);
  const host = url.hostname.replace(/^mcp\./i, '');
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/^\/+/, '')
    .replace(/\/(?:mcp|sse)$/i, '')
    .replace(/^(?:mcp|sse)$/i, '');
  return toMcpServerName(path ? `${host}-${path}` : host);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTomlSection(content: string, sectionName: string): string | null {
  const escaped = escapeRegex(sectionName);
  const match = content.match(new RegExp(`(?:^|\\r?\\n)\\[${escaped}\\]\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[|$)`));
  return match?.[1] ?? null;
}

function extractTomlStringAssignment(section: string | null, key: string): string | null {
  if (!section) return null;
  const escaped = escapeRegex(key);
  const match = section.match(new RegExp(`^\\s*${escaped}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match?.[1] ?? null;
}

function extractFirstTomlKey(section: string | null): string | null {
  if (!section) return null;
  const match = section.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/m);
  return match?.[1] || match?.[2] || match?.[3] || null;
}

export function parsePythonProjectMetadata(
  pyprojectContent: string,
  fallbackName: string
): { name: string; scriptName: string } {
  const projectSection = extractTomlSection(pyprojectContent, 'project');
  const scriptsSection = extractTomlSection(pyprojectContent, 'project.scripts');
  const rawName = extractTomlStringAssignment(projectSection, 'name') || fallbackName;
  const name = toMcpServerName(rawName);
  const scriptName = extractFirstTomlKey(scriptsSection) || rawName;

  return { name, scriptName };
}

type PackageJsonLike = {
  name?: string;
  description?: string;
  bin?: string | Record<string, string>;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export function isUnsupportedMcpAppPackage(pkg: PackageJsonLike | null | undefined): boolean {
  if (!pkg) return false;
  const dependencies = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  return (
    '@modelcontextprotocol/ext-apps' in dependencies ||
    looksLikeMcpAppPackageName(pkg.name || '') ||
    /\bMCP App\b/i.test(pkg.description || '')
  );
}

interface McpProjectCandidate {
  path: string;
  name: string;
  type: string;
}

async function buildMcpsFromSource(source: string): Promise<McpRegistryEntry[] | null> {
  const { parseSourceString } = await import('../parsers/index.js');
  const { cloneOrPull, getCommitSha } = await import('../utils/git.js');
  const { getDataDir } = await import('../utils/platform.js');
  const { computeIntegrity } = await import('./sumfile.js');
  const ora = (await import('ora')).default;
  const chalk = (await import('chalk')).default;

  const { repoUrl, skillPath } = parseSourceString(source);
  if (!isCloneableGitSource(repoUrl)) return null;

  // Global cache directory for MCPs
  const mcpCacheBase = join(getDataDir(), 'mcp-cache');
  const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'unknown';

  const spinner = ora(`Fetching custom MCP from ${repoUrl}...`).start();
  let fetching = true;
  try {
    const clonedDir = await cloneOrPull(repoUrl, mcpCacheBase);
    const commit = await getCommitSha(clonedDir);
    const workDir = skillPath ? join(clonedDir, skillPath) : clonedDir;

    if (!(await pathExists(workDir))) {
      throw new Error(`The specified path '${skillPath || ''}' does not exist in the repository.`);
    }

    const projects = await discoverMcpProjects(workDir, repoName);
    if (projects.length === 0) {
      spinner.warn(chalk.yellow(`Could not detect project type (Node.js/Python uv/Go) for auto-build. Falling back...`));
      return null;
    }

    spinner.stop();
    fetching = false;

    const selectedProjects = await selectMcpProjects(projects, chalk);
    const configs: McpRegistryEntry[] = [];
    for (const project of selectedProjects) {
      const config = await buildMcpProject(project.path, project.name);
      configs.push({
        ...config,
        source: sourceForMcpProject(source, clonedDir, project.path),
        resolvedVersion: commit,
        integrity: await computeIntegrity(project.path),
      });
    }

    return configs;
  } catch (e: any) {
    if (fetching) {
      spinner.fail(chalk.red(`Failed to setup MCP: ${e.message}`));
    }
    throw e;
  }
}

async function discoverMcpProjects(workDir: string, fallbackName: string): Promise<McpProjectCandidate[]> {
  const direct = await detectMcpProject(workDir, fallbackName, false);
  if (direct) return [direct];

  const fs = await import('node:fs/promises');
  const subdirs = await fs.readdir(workDir, { withFileTypes: true });
  const projects: McpProjectCandidate[] = [];

  for (const dir of subdirs) {
    if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === 'node_modules') continue;

    const project = await detectMcpProject(join(workDir, dir.name), dir.name, true);
    if (project) projects.push(project);
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

async function detectMcpProject(
  projectPath: string,
  fallbackName: string,
  skipUnsupported: boolean
): Promise<McpProjectCandidate | null> {
  const pkgJsonPath = join(projectPath, 'package.json');
  if (await pathExists(pkgJsonPath)) {
    const pkg: any = await readJsonFile(pkgJsonPath);
    if (isUnsupportedMcpAppPackage(pkg)) {
      if (skipUnsupported) return null;
      throw new Error(
        `Node package '${pkg?.name || fallbackName}' appears to be an MCP App/HTTP server. ` +
        `skm currently configures stdio MCP clients only. Choose a stdio server such as mcp-tool-server.`
      );
    }

    const hasEntryPoint = Boolean(
      pkg?.bin ||
      pkg?.main ||
      await pathExists(join(projectPath, 'index.js')) ||
      await pathExists(join(projectPath, 'dist', 'index.js')) ||
      await pathExists(join(projectPath, 'src', 'index.js'))
    );
    if (!hasEntryPoint && skipUnsupported) {
      return null;
    }

    return { path: projectPath, name: pkg?.name || fallbackName, type: 'Node.js' };
  }

  if (await pathExists(join(projectPath, 'pyproject.toml'))) {
    return { path: projectPath, name: fallbackName, type: 'Python (uv)' };
  }

  if (await pathExists(join(projectPath, 'go.mod'))) {
    return { path: projectPath, name: fallbackName, type: 'Go' };
  }

  return null;
}

async function selectMcpProjects(
  projects: McpProjectCandidate[],
  chalk: typeof import('chalk').default
): Promise<McpProjectCandidate[]> {
  if (projects.length === 1) {
    const { logger } = await import('../utils/logger.js');
    logger.info(`Detected monorepo. Auto-selecting the only project found: ${chalk.cyan(projects[0].name)}`);
    return projects;
  }

  const selectedPaths = await promptForSearchableSelection({
    choices: projects.map((project) => ({
      name: `${project.name} (${project.type})`,
      value: project.path,
      searchable: `${project.name} ${project.type} ${project.path}`,
    })),
    itemLabel: 'MCP projects',
    queryName: 'mcpProjectSearch',
    selectionName: 'selectedMcpProjects',
    searchMessage: (total) => `Search MCP projects by name/path/type (${total} found, leave blank for all):`,
    selectMessage: (matched, total, query) => query
      ? `Found ${matched} of ${total} MCP projects matching "${query}". Select which ones to install:`
      : `Found ${total} MCP projects in this repository. Select which ones to install:`,
    noMatchesMessage: (query) => `No MCP projects matched "${query}". Try another keyword or leave blank to show all.`,
    includeSelectAll: true,
  });

  const selected = new Set(selectedPaths);
  return projects.filter((project) => selected.has(project.path));
}

async function buildMcpProject(workDir: string, repoName: string): Promise<McpRegistryEntry> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const ora = (await import('ora')).default;
  const chalk = (await import('chalk')).default;

  const pkgJsonPath = join(workDir, 'package.json');
  const pyprojectPath = join(workDir, 'pyproject.toml');
  const goModPath = join(workDir, 'go.mod');
  const spinner = ora(`Building ${repoName}...`).start();

  try {
    if (await pathExists(pkgJsonPath)) {
      const pkg: any = await readJsonFile(pkgJsonPath);
      if (isUnsupportedMcpAppPackage(pkg)) {
        throw new Error(
          `Node package '${pkg?.name || repoName}' appears to be an MCP App/HTTP server. ` +
          `skm currently configures stdio MCP clients only. Choose a stdio server such as mcp-tool-server.`
        );
      }

      spinner.text = chalk.blue('Installing Node.js dependencies...');
      await execFileAsync(npmExecutable(), ['install', '--ignore-scripts'], { cwd: workDir, windowsHide: true });

      let entryPoint = await findNodeEntryPoint(workDir, pkg);
      if (!entryPoint) {
        for (const script of ['build', 'compile']) {
          const scriptCommand = pkg?.scripts?.[script];
          if (!scriptCommand) continue;

          assertPackageScriptCanRun(script, scriptCommand);
          spinner.text = chalk.blue(`Running ${script} script...`);
          await execFileAsync(npmExecutable(), ['run', script], { cwd: workDir, windowsHide: true });
          entryPoint = await findNodeEntryPoint(workDir, pkg);
          if (entryPoint) break;
        }
      }

      if (!entryPoint) {
        for (const script of ['prepare', 'prepack', 'prestart']) {
          const scriptCommand = pkg?.scripts?.[script];
          if (!scriptCommand) continue;

          assertPackageScriptCanRun(script, scriptCommand);
          spinner.text = chalk.blue(`Running ${script} script...`);
          await execFileAsync(npmExecutable(), ['run', script], { cwd: workDir, windowsHide: true });
          entryPoint = await findNodeEntryPoint(workDir, pkg);
          if (entryPoint) break;
        }
      }

      if (!entryPoint) {
        throw new Error('Could not find an existing bin, main, dist/index.js, build/index.js, index.js, or src/index.js entry point');
      }

      const absoluteEntryPoint = join(workDir, entryPoint);
      spinner.succeed(chalk.green(`Successfully built custom Node.js MCP: ${pkg.name || repoName}`));
      return {
        name: toMcpServerName(pkg.name || repoName),
        command: 'node',
        args: [absoluteEntryPoint],
        envKeys: [],
      };
    }

    if (await pathExists(pyprojectPath)) {
      spinner.text = chalk.blue('Setting up Python environment with uv...');

      try {
        await execFileAsync(nativeExecutable('uv'), ['sync'], { cwd: workDir, windowsHide: true });
      } catch (e: any) {
        throw new Error(`uv sync failed: ${e.message}. Is 'uv' installed?`);
      }

      const fs = await import('node:fs/promises');
      const pyprojectContent = await fs.readFile(pyprojectPath, 'utf-8');
      const { name: mcpName, scriptName } = parsePythonProjectMetadata(pyprojectContent, repoName);

      spinner.succeed(chalk.green(`Successfully setup custom Python MCP: ${mcpName}`));
      return {
        name: mcpName,
        command: 'uv',
        args: ['--directory', workDir, 'run', scriptName],
        envKeys: [],
      };
    }

    if (await pathExists(goModPath)) {
      spinner.text = chalk.blue('Building Go project...');
      const outputName = goMcpBinaryName();

      try {
        await execFileAsync(nativeExecutable('go'), ['build', '-o', outputName], { cwd: workDir, windowsHide: true });
      } catch (e: any) {
        throw new Error(`Go build failed: ${e.message}`);
      }

      const absoluteEntryPoint = join(workDir, outputName);
      if (!(await pathExists(absoluteEntryPoint))) {
        throw new Error(`Go build did not produce ${outputName}`);
      }

      spinner.succeed(chalk.green(`Successfully built custom Go MCP: ${repoName}`));
      return {
        name: toMcpServerName(repoName),
        command: absoluteEntryPoint,
        args: [],
        envKeys: [],
      };
    }

    throw new Error(`Could not detect project type for ${workDir}`);
  } catch (e: any) {
    spinner.fail(chalk.red(`Failed to setup MCP: ${e.message}`));
    throw e;
  }
}

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function nativeExecutable(command: string): string {
  return process.platform === 'win32' ? `${command}.exe` : command;
}

function goMcpBinaryName(): string {
  return process.platform === 'win32' ? 'mcp-server.exe' : 'mcp-server';
}

function assertPackageScriptCanRun(scriptName: string, scriptCommand: string): void {
  const issue = windowsShellCompatibilityIssue(scriptCommand);
  if (!issue) return;

  throw new Error(
    `Package script "${scriptName}" uses ${issue}, which is not available in Windows cmd.exe. ` +
    `The package needs a cross-platform script, a committed JavaScript entry point, or a prebuilt npm MCP package.`
  );
}

async function findNodeEntryPoint(workDir: string, pkg: PackageJsonLike): Promise<string> {
  const candidates: string[] = [];
  if (pkg?.bin) {
    candidates.push(...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin) as string[]));
  }

  if (pkg?.main) {
    candidates.push(pkg.main);
  }

  candidates.push('dist/index.js', 'build/index.js', 'index.js', 'src/index.js');
  for (const candidate of candidates) {
    if (candidate && await pathExists(join(workDir, candidate))) return candidate;
  }

  return '';
}

function sourceForMcpProject(source: string, clonedDir: string, workDir: string): string {
  const relativeProjectPath = relative(clonedDir, workDir).split(/[\\/]+/).filter(Boolean).join('/');
  if (!relativeProjectPath) return source;

  const baseSource = source.includes('#') ? source.substring(0, source.indexOf('#')) : source;
  return `${baseSource}#${relativeProjectPath}`;
}

function isCloneableGitSource(repoUrl: string): boolean {
  return (
    /^https?:\/\//i.test(repoUrl) ||
    /^(?:ssh|git):\/\//i.test(repoUrl) ||
    /^(?:[^@\s/:]+@)?[^:\s]+:.+/.test(repoUrl)
  );
}


/**
 * Prompt the user for required environment variables for an MCP service.
 */
export async function promptForMcpEnv(config: McpRegistryEntry): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (!config.envKeys || config.envKeys.length === 0) {
    return env;
  }
  
  const chalk = (await import('chalk')).default;
  const inquirer = (await import('inquirer')).default;
  
  console.log(chalk.yellow(`\n⚠️  MCP Service '${config.name}' requires the following environment variables:`));
  
  for (const key of config.envKeys) {
    const answer = await inquirer.prompt([{
      type: 'input',
      name: key,
      message: `${key}:`,
      default: process.env[key] || ''
    }]);
    
    if (answer[key]) {
      env[key] = answer[key];
    }
  }
  
  return env;
}
