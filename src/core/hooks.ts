/**
 * Setup hooks runner — handles setup_command or setup.sh
 *
 * Security: scripts run in the skill directory with limited env.
 */
import { exec, execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathExists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { windowsShellCompatibilityIssue } from '../utils/shell.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type HookCommand =
  | { display: string; shell: true; command: string }
  | { display: string; shell?: false; command: string; args: string[] };

/**
 * Run a setup command or setup.sh if present.
 * Returns true if the hook succeeded or doesn't exist,
 * false if it failed.
 */
export async function runSetup(
  setupCommand: string | undefined,
  cwd: string,
  skillName: string
): Promise<boolean> {
  const hook = await resolveSetupHook(setupCommand, cwd);

  if (!hook) {
    return true;
  }

  const issue = hook.shell ? windowsShellCompatibilityIssue(hook.command) : null;
  if (issue) {
    logger.error(
      `Setup failed for "${skillName}": setup_command uses ${issue}, which is not available in Windows cmd.exe. ` +
      `Use setup.ps1/setup.cmd/setup.bat for Windows or make setup_command cross-platform.`
    );
    return false;
  }

  logger.skill(skillName, `Running setup...`);
  logger.debug(`  cwd: ${cwd}`);
  logger.debug(`  cmd: ${hook.display}`);

  try {
    const execOptions = {
      cwd,
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...process.env,
        SKM_SKILL_NAME: skillName,
        SKM_SKILL_DIR: cwd,
      },
    };
    const { stdout, stderr } = hook.shell
      ? await execAsync(hook.command, execOptions)
      : await execFileAsync(hook.command, hook.args, execOptions);

    if (stdout.trim()) {
      for (const line of stdout.trim().split('\n')) {
        logger.debug(`  [setup] ${line}`);
      }
    }
    if (stderr.trim()) {
      for (const line of stderr.trim().split('\n')) {
        logger.warn(`  [setup] ${line}`);
      }
    }

    return true;
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`Setup failed for "${skillName}": ${msg}`);
    return false;
  }
}

async function resolveSetupHook(
  setupCommand: string | undefined,
  cwd: string
): Promise<HookCommand | null> {
  if (setupCommand) {
    return { display: setupCommand, shell: true, command: setupCommand };
  }

  const currentPlatform = platform();
  if (currentPlatform === 'win32' && await pathExists(join(cwd, 'setup.ps1'))) {
    return {
      display: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1',
      command: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'setup.ps1'],
    };
  }

  if (currentPlatform === 'win32' && await pathExists(join(cwd, 'setup.cmd'))) {
    return {
      display: 'cmd.exe /d /s /c setup.cmd',
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'setup.cmd'],
    };
  }

  if (currentPlatform === 'win32' && await pathExists(join(cwd, 'setup.bat'))) {
    return {
      display: 'cmd.exe /d /s /c setup.bat',
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'setup.bat'],
    };
  }

  if (await pathExists(join(cwd, 'setup.sh'))) {
    return {
      display: 'bash setup.sh',
      command: 'bash',
      args: ['setup.sh'],
    };
  }

  return null;
}
