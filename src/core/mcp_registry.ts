import type { McpRegistryEntry } from '../types/index.js';

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

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathExists, readJsonFile } from '../utils/fs.js';

/**
 * Resolve an MCP config by name or Git URL.
 * If the name is in the registry, returns the registered config.
 * If it's a Git URL, clones, builds, and returns absolute path.
 * Otherwise, builds a generic fallback config assuming it is an npm package.
 */
export async function getMcpConfig(name: string): Promise<McpRegistryEntry> {
  // Handle names with @version, but preserve scoped packages (e.g. @org/pkg@1.0.0)
  const atIndex = name.lastIndexOf('@');
  const pkgName = atIndex > 0 ? name.substring(0, atIndex) : name;
  
  if (MCP_REGISTRY[pkgName]) {
    return MCP_REGISTRY[pkgName];
  }

  const isScopedNpmPackage = pkgName.startsWith('@') && pkgName.split('/').length === 2;

  // If it's a URL or github shorthand, attempt to build from source.
  // Scoped npm packages such as @modelcontextprotocol/server-memory also contain
  // a slash, but should go through the npx fallback instead.
  if (name.includes('://') || name.startsWith('github:') || (!isScopedNpmPackage && name.split('/').length >= 2)) {
    try {
      const builtConfig = await buildMcpFromSource(name);
      if (builtConfig) return builtConfig;
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

  return {
    name: pkgName,
    command: 'npx',
    args: ['-y', name],
    envKeys: []
  };
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
  const name = extractTomlStringAssignment(projectSection, 'name') || fallbackName;
  const scriptName = extractFirstTomlKey(scriptsSection) || name;

  return { name, scriptName };
}

async function buildMcpFromSource(source: string): Promise<McpRegistryEntry | null> {
  const { parseSourceString } = await import('../parsers/index.js');
  const { cloneOrPull } = await import('../utils/git.js');
  const { getDefaultConfig, getDataDir } = await import('../utils/platform.js');
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);
  const ora = (await import('ora')).default;
  const chalk = (await import('chalk')).default;

  const { repoUrl, skillPath } = parseSourceString(source);
  if (!isCloneableGitSource(repoUrl)) return null;

  // Global cache directory for MCPs
  const config = getDefaultConfig();
  const mcpCacheBase = join(getDataDir(), 'mcp-cache');
  const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'unknown';

  const spinner = ora(`Fetching custom MCP from ${repoUrl}...`).start();
  try {
    const clonedDir = await cloneOrPull(repoUrl, mcpCacheBase);
    let workDir = skillPath ? join(clonedDir, skillPath) : clonedDir;

    if (!(await pathExists(workDir))) {
      throw new Error(`The specified path '${skillPath || ''}' does not exist in the repository.`);
    }

    let pkgJsonPath = join(workDir, 'package.json');
    let pyprojectPath = join(workDir, 'pyproject.toml');
    let goModPath = join(workDir, 'go.mod');

    // Monorepo detection: if no project at current workDir, scan subdirectories
    if (!(await pathExists(pkgJsonPath)) && !(await pathExists(pyprojectPath)) && !(await pathExists(goModPath))) {
      const fs = await import('node:fs/promises');
      const subdirs = await fs.readdir(workDir, { withFileTypes: true });
      const projects: { path: string; name: string; type: string }[] = [];

      for (const dir of subdirs) {
        if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === 'node_modules') continue;
        const subPath = join(workDir, dir.name);

        if (await pathExists(join(subPath, 'package.json'))) {
          // Verify it's a valid application (has bin or main, or index.js)
          const pkg = await readJsonFile<any>(join(subPath, 'package.json'));
          const hasEntryPoint = pkg?.bin || pkg?.main || await pathExists(join(subPath, 'index.js')) || await pathExists(join(subPath, 'dist', 'index.js')) || await pathExists(join(subPath, 'src', 'index.js'));
          if (hasEntryPoint) {
            projects.push({ path: subPath, name: dir.name, type: 'Node.js' });
          }
        } else if (await pathExists(join(subPath, 'pyproject.toml'))) {
          projects.push({ path: subPath, name: dir.name, type: 'Python (uv)' });
        } else if (await pathExists(join(subPath, 'go.mod'))) {
          projects.push({ path: subPath, name: dir.name, type: 'Go' });
        }
      }

      // Sort projects deterministically to avoid random OS readdir orders
      projects.sort((a, b) => a.name.localeCompare(b.name));

      if (projects.length > 0) {
        spinner.stop();
        const inquirer = (await import('inquirer')).default;
        const { logger } = await import('../utils/logger.js');
        
        let selectedPath = projects[0].path;
        if (projects.length > 1) {
          const { choice } = await inquirer.prompt([{
            type: 'list',
            name: 'choice',
            message: chalk.cyan(`Multiple MCP projects found in this repository. Which one would you like to install?`),
            choices: projects.map(p => ({
              name: `${p.name} (${p.type})`,
              value: p.path
            }))
          }]);
          selectedPath = choice;
        } else {
          logger.info(`Detected monorepo. Auto-selecting the only project found: ${chalk.cyan(projects[0].name)}`);
          selectedPath = projects[0].path;
        }
        
        workDir = selectedPath;
        pkgJsonPath = join(workDir, 'package.json');
        pyprojectPath = join(workDir, 'pyproject.toml');
        goModPath = join(workDir, 'go.mod');
        spinner.start(`Building ${projects.find(p => p.path === selectedPath)?.name || 'project'}...`);
      }
    }

    if (await pathExists(pkgJsonPath)) {
      spinner.text = chalk.blue('📦 Installing Node.js dependencies...');
      await execAsync('npm install --ignore-scripts', { cwd: workDir });

      const pkg: any = await readJsonFile(pkgJsonPath);
      
      // Try common build/setup scripts
      const buildScripts = ['build', 'compile', 'prepare', 'prepack', 'prestart'];
      for (const script of buildScripts) {
        if (pkg?.scripts?.[script]) {
          spinner.text = chalk.blue(`🔨 Running ${script} script...`);
          await execAsync(`npm run ${script}`, { cwd: workDir });
          // If we found a primary build script, we can stop
          if (script === 'build' || script === 'compile') break;
        }
      }

      // Find entry point
      let entryPoint = '';
      if (pkg?.bin) {
        entryPoint = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0] as string;
      } else if (pkg?.main) {
        entryPoint = pkg.main;
      } else {
        // Fallbacks
        if (await pathExists(join(workDir, 'dist', 'index.js'))) entryPoint = 'dist/index.js';
        else if (await pathExists(join(workDir, 'build', 'index.js'))) entryPoint = 'build/index.js';
        else if (await pathExists(join(workDir, 'index.js'))) entryPoint = 'index.js';
      }

      if (!entryPoint) {
        throw new Error('Could not find bin, main, or dist/index.js in package.json');
      }

      const absoluteEntryPoint = join(workDir, entryPoint);
      if (!(await pathExists(absoluteEntryPoint))) {
         throw new Error(`Resolved entry point does not exist: ${absoluteEntryPoint}`);
      }

      spinner.succeed(chalk.green(`Successfully built custom Node.js MCP: ${pkg.name || repoName}`));
      return {
        name: pkg.name || repoName,
        command: 'node',
        args: [absoluteEntryPoint],
        envKeys: [] // Ask user later or default to empty
      };
    } else if (await pathExists(pyprojectPath)) {
      spinner.text = chalk.blue('🐍 Setting up Python environment with uv...');
      
      try {
        await execAsync('uv sync', { cwd: workDir });
      } catch (e: any) {
        throw new Error(`uv sync failed: ${e.message}. Is 'uv' installed?`);
      }

      // Read pyproject.toml to find the project name
      const fs = await import('node:fs/promises');
      const pyprojectContent = await fs.readFile(pyprojectPath, 'utf-8');
      
      const { name: mcpName, scriptName } = parsePythonProjectMetadata(pyprojectContent, repoName);

      spinner.succeed(chalk.green(`Successfully setup custom Python MCP: ${mcpName}`));
      return {
        name: mcpName,
        command: 'uv',
        args: ['--directory', workDir, 'run', scriptName],
        envKeys: []
      };
    } else if (await pathExists(goModPath)) {
      spinner.text = chalk.blue('🐹 Building Go project...');
      
      try {
        await execAsync('go build -o mcp-server', { cwd: workDir });
      } catch (e: any) {
        throw new Error(`Go build failed: ${e.message}`);
      }

      const absoluteEntryPoint = join(workDir, 'mcp-server');
      if (!(await pathExists(absoluteEntryPoint))) {
         throw new Error(`Go build did not produce an mcp-server executable`);
      }

      spinner.succeed(chalk.green(`Successfully built custom Go MCP: ${repoName}`));
      return {
        name: repoName,
        command: absoluteEntryPoint,
        args: [],
        envKeys: []
      };
    }

    spinner.warn(chalk.yellow(`Could not detect project type (Node.js/Python uv/Go) for auto-build. Falling back...`));
    return null;
  } catch (e: any) {
    spinner.fail(chalk.red(`Failed to setup MCP: ${e.message}`));
    throw e;
  }
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
