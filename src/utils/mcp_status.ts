import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { pathExists } from './fs.js';
import { isLikelyLocalPath, normalizeSkillpkgDataPath } from './mcp_paths.js';

const execFileAsync = promisify(execFile);

export interface McpStatusService {
  name: string;
  command: string;
  args?: string[];
}

export interface McpStatusResult {
  available: boolean;
  detail: string;
}

export async function checkMcpService(service: McpStatusService): Promise<McpStatusResult> {
  const command = service.command;
  if (!(await commandAvailable(command))) {
    return {
      available: false,
      detail: `command not found: ${command}`,
    };
  }

  const entrypoint = entrypointArg(command, service.args || []);
  if (entrypoint && !(await pathExists(entrypoint))) {
    const migratedEntrypoint = await normalizeSkillpkgDataPath(entrypoint);
    const migrationDetail = migratedEntrypoint !== entrypoint
      ? `; migrated path exists: ${migratedEntrypoint}`
      : '';

    return {
      available: false,
      detail: `entrypoint not found: ${entrypoint}${migrationDetail}`,
    };
  }

  return {
    available: true,
    detail: command,
  };
}

async function commandAvailable(command: string): Promise<boolean> {
  if (!command) return false;
  if (isLikelyLocalPath(command) || command.includes('/') || command.includes('\\')) {
    return pathExists(command);
  }

  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(checker, [command], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function entrypointArg(command: string, args: string[]): string | null {
  const executable = basename(command).toLowerCase();
  if (['node', 'node.exe'].includes(executable)) {
    return firstPathArg(args, ['.js', '.mjs', '.cjs']);
  }

  if (['python', 'python3', 'python.exe', 'python3.exe'].includes(executable)) {
    return firstPathArg(args, ['.py']);
  }

  return null;
}

function firstPathArg(args: string[], extensions: string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (!isLikelyLocalPath(arg)) continue;
    const lower = arg.toLowerCase();
    if (extensions.some((ext) => lower.endsWith(ext))) return arg;
  }

  return null;
}
