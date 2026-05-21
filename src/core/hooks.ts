/**
 * Setup hooks runner — handles setup_command or setup.sh
 *
 * Security: scripts run in the skill directory with limited env.
 */
import { exec } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathExists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

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
  let cmdToRun = setupCommand;

  if (!cmdToRun) {
    if (platform() === 'win32' && await pathExists(join(cwd, 'setup.ps1'))) {
      cmdToRun = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1';
    } else if (platform() === 'win32' && await pathExists(join(cwd, 'setup.cmd'))) {
      cmdToRun = 'setup.cmd';
    } else if (platform() === 'win32' && await pathExists(join(cwd, 'setup.bat'))) {
      cmdToRun = 'setup.bat';
    } else if (await pathExists(join(cwd, 'setup.sh'))) {
      cmdToRun = 'bash setup.sh';
    } else {
      return true;
    }
  }

  logger.skill(skillName, `Running setup...`);
  logger.debug(`  cwd: ${cwd}`);
  logger.debug(`  cmd: ${cmdToRun}`);

  try {
    const { stdout, stderr } = await execAsync(cmdToRun, {
      cwd,
      timeout: 120_000,   // 120 second timeout
      env: {
        ...process.env,
        SKM_SKILL_NAME: skillName,
        SKM_SKILL_DIR: cwd,
      },
    });

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
