#!/usr/bin/env node
/**
 * skillpkg — Cross-platform AI Agent Skills Package Manager
 *
 * CLI design inspired by:
 *   - npm: install, uninstall, list, link, outdated, init, search
 *   - conda: agents (environments), channels, sync
 *   - Go modules: tidy, verify, replace, mod graph (tree)
 */
import { Command } from 'commander';
import { createRequire } from 'node:module';
import chalk from 'chalk';
import { installSkill, uninstallSkill, listSkills, showSkillInfo, showSkillStatus } from './core/installer.js';
import {
  initManifest,
  checkOutdated,
  showTree,
  linkSkill,
  tidySkills,
  verifySkills,
  updateSkills,
  cleanCache,
  trackSkills,
} from './core/commands.js';
import { searchSkills, previewSkill } from './core/search.js';
import {
  listMcpServices,
  checkMcpStatus,
  addMcpService,
  removeMcpService,
  syncMcpServices,
  promoteMcpService,
  demoteMcpService,
} from './core/mcp.js';
import { configureGitPreference } from './core/git_config.js';
import { syncAgents, showAgentConfig, promoteSkillToGlobal, demoteSkillToProject } from './core/sync.js';
import { assignInteractive } from './core/assign.js';
import { getAllAdapters } from './adapters/index.js';
import { closeDb } from './db/index.js';
import { logger } from './utils/logger.js';
import { defaultInstallScopeForCwd } from './utils/platform.js';
import type { AgentType, InstallMode, InstallScope } from './types/index.js';

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require('../package.json') as { version: string };

const program = new Command();

function installModeOption(value: unknown): InstallMode | undefined {
  if (!value) return undefined;
  if (value === 'copy' || value === 'symlink-cache' || value === 'symlink-dev') {
    return value;
  }
  throw new Error(`Invalid install mode: ${String(value)}`);
}

const BRAND = `
   ${chalk.cyan.bold('⚡ skillpkg')} ${chalk.gray(`v${pkgVersion}`)}
   ${chalk.gray('Cross-platform AI Agent Skills Package Manager')}
`;

program
  .name('skm')
  .description(BRAND)
  .version(pkgVersion)
  .addHelpText('before', BRAND);

// ── install ────────────────────────────────────────────────────
program
  .command('install [source] [skill-name]')
  .alias('i')
  .description('Install a skill from a Git repo, local path, or from skm.mod')
  .option('--replace', 'Replace existing skill with same name from different source')
  .option('--alias <name>', 'Install under a different name')
  .option('--scope <scope>', 'Installation scope: global or project')
  .option('--mode <mode>', 'Installation mode: copy, symlink-cache, or symlink-dev')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .option('--no-deps', 'Skip dependency installation')
  .option('--no-scripts', 'Skip lifecycle hooks')
  .option('--save', 'Save project install to skm.mod')
  .option('--no-save', 'Do not save project install to skm.mod')
  .option('-f, --force', 'Force install even if already exists')
  .option('-y, --yes', 'Automatically answer yes to prompts (select all if multiple skills found)')
  .action(async (source: string | undefined, _skillName: string | undefined, opts: Record<string, unknown>) => {
    if (!source) {
      const { installFromMod } = await import('./core/installer.js');
      await installFromMod({
        scope: (opts['scope'] as InstallScope) || 'project',
        mode: installModeOption(opts['mode']),
        agent: (opts['agent'] as AgentType | 'all') || 'all',
        noDeps: opts['deps'] === false,
        noScripts: opts['scripts'] === false,
        force: opts['force'] as boolean,
        yes: opts['yes'] as boolean,
        save: false,
      });
      return;
    }
    const scope = (opts['scope'] as InstallScope | undefined) || await defaultInstallScopeForCwd();
    await installSkill(source, {
      replace: opts['replace'] as boolean,
      alias: opts['alias'] as string | undefined,
      scope,
      mode: installModeOption(opts['mode']),
      agent: (opts['agent'] as AgentType | 'all') || 'all',
      noDeps: opts['deps'] === false,
      noScripts: opts['scripts'] === false,
      force: opts['force'] as boolean,
      yes: opts['yes'] as boolean,
      save: opts['save'] as boolean | undefined,
    });
  });

// ── uninstall ──────────────────────────────────────────────────
program
  .command('uninstall <skill-name>')
  .alias('rm')
  .description('Uninstall a skill')
  .option('--scope <scope>', 'Scope to uninstall from: global or project')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .option('--no-scripts', 'Skip lifecycle hooks')
  .option('--no-save', 'Do not remove project install from skm.mod')
  .action(async (skillName: string, opts: Record<string, unknown>) => {
    await uninstallSkill(skillName, {
      scope: opts['scope'] as string,
      agent: opts['agent'] as string,
      noScripts: opts['scripts'] === false,
      save: opts['save'] as boolean | undefined,
    });
  });

// ── update ─────────────────────────────────────────────────────
program
  .command('update [skill-name]')
  .alias('up')
  .description('Update one or all skills to their latest version')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .option('-y, --yes', 'Automatically answer yes to prompts')
  .action(async (skillName: string | undefined, opts: Record<string, unknown>) => {
    await updateSkills(skillName, { agent: opts['agent'] as string, yes: opts['yes'] as boolean });
  });

// ── list ───────────────────────────────────────────────────────
program
  .command('list')
  .alias('ls')
  .description('List installed skills')
  .option('--scope <scope>', 'Filter by scope')
  .option('--json', 'Output in JSON format')
  .action(async (opts: Record<string, unknown>) => {
    if (opts['json']) logger.setJsonMode(true);
    await listSkills(opts['scope'] as string | undefined);
  });

// ── assign ─────────────────────────────────────────────────────
program
  .command('assign')
  .description('Interactively assign a skill or MCP service to specific agents')
  .option('--scope <scope>', 'Only show skills from this scope: global or project')
  .action(async (opts: Record<string, unknown>) => {
    await assignInteractive({ scope: opts['scope'] as InstallScope | undefined });
  });

// ── info ───────────────────────────────────────────────────────
program
  .command('info <skill-name>')
  .description('Show detailed information about an installed skill')
  .option('--json', 'Output in JSON format')
  .action(async (skillName: string, opts: Record<string, unknown>) => {
    if (opts['json']) logger.setJsonMode(true);
    await showSkillInfo(skillName);
  });

// ── status ─────────────────────────────────────────────────────
program
  .command('status')
  .description('Show project-aware skill status across scopes and agents')
  .option('--scope <scope>', 'Filter by scope')
  .option('--json', 'Output in JSON format')
  .action(async (opts: Record<string, unknown>) => {
    if (opts['json']) logger.setJsonMode(true);
    await showSkillStatus(opts['scope'] as string | undefined);
  });

// ── search ─────────────────────────────────────────────────────
program
  .command('search <query>')
  .alias('s')
  .description('Search for skills on GitHub')
  .option('-n, --limit <n>', 'Maximum results', '15')
  .option('--json', 'Output in JSON format')
  .action(async (query: string, opts: Record<string, unknown>) => {
    if (opts['json']) logger.setJsonMode(true);
    await searchSkills(query, { limit: Number(opts['limit']) || 15 });
  });

// ── preview ────────────────────────────────────────────────────
program
  .command('preview <source>')
  .description('Preview a skill before installing (security review)')
  .action(async (source: string) => {
    await previewSkill(source);
  });

// ── init ───────────────────────────────────────────────────────
program
  .command('init [name]')
  .description('Initialize a new skillpkg.yaml manifest')
  .option('-y, --yes', 'Use default values (non-interactive)')
  .action(async (name: string | undefined, opts: Record<string, unknown>) => {
    await initManifest(name, !opts['yes']);
  });

// ── link ───────────────────────────────────────────────────────
program
  .command('link [path]')
  .description('Link a local skill for development (symlink)')
  .option('--scope <scope>', 'Installation scope', 'global')
  .option('--mode <mode>', 'Installation mode: copy or symlink-dev')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .option('--save', 'Save project link to skm.mod')
  .option('--no-save', 'Do not save project link to skm.mod')
  .option('-y, --yes', 'Automatically answer yes to prompts')
  .action(async (path: string | undefined, opts: Record<string, unknown>) => {
    await linkSkill(path || '.', {
      scope: (opts['scope'] as InstallScope) || 'global',
      mode: installModeOption(opts['mode']),
      agent: opts['agent'] as string,
      yes: opts['yes'] as boolean,
      save: opts['save'] as boolean | undefined,
    });
  });

// ── track ──────────────────────────────────────────────────────
program
  .command('track [skill-name]')
  .description('Adopt untracked native skills into centralized management without assigning them')
  .action(async (skillName?: string) => { await trackSkills(skillName); });

// ── outdated ───────────────────────────────────────────────────
program
  .command('outdated')
  .description('Check for outdated skills (compare local vs remote HEAD)')
  .action(async () => { await checkOutdated(); });

// ── tree ───────────────────────────────────────────────────────
program
  .command('tree')
  .description('Display dependency tree')
  .action(async () => { await showTree(); });

// ── tidy ───────────────────────────────────────────────────────
program
  .command('tidy')
  .description('Remove unused lockfile entries and sync state')
  .option('--unify', 'Migrate project skills into .agents/skills and create compatibility symlinks')
  .action(async (opts: Record<string, unknown>) => { await tidySkills({ unify: Boolean(opts['unify']) }); });

// ── verify ─────────────────────────────────────────────────────
program
  .command('verify')
  .description('Verify integrity of installed skills')
  .action(async () => { await verifySkills(); });

// ── agents ─────────────────────────────────────────────────────
const agentsCmd = program
  .command('agents')
  .description('Manage detected AI agents');

agentsCmd
  .command('list', { isDefault: true })
  .description('List detected AI agents on this system')
  .action(async () => {
    logger.blank();
    logger.info('Scanning for installed agents...');
    logger.blank();
    const all = getAllAdapters();
    const tableHead = ['Agent', 'Status', 'Skills Directory'];
    const tableRows: string[][] = [];

    for (const adapter of all) {
      const detected = await adapter.detect();
      const status = detected ? chalk.green('✔ detected') : chalk.gray('✖ not found');
      const dir = detected ? chalk.gray(adapter.getSkillsDir('global')) : '—';
      tableRows.push([adapter.displayName, status, dir]);
    }
    logger.table(tableHead, tableRows);
    logger.blank();
  });

agentsCmd
  .command('sync')
  .description('Sync managed skills and MCP services across agents')
  .option('--scope <scope>', 'Scope to sync', 'global')
  .option('--agent <agent>', 'Target agent (or "all")')
  .action(async (opts: Record<string, unknown>) => {
    await syncAgents({
      scope: opts['scope'] as InstallScope,
      agent: opts['agent'] as AgentType | 'all' | undefined,
    });
  });

agentsCmd
  .command('config <agent-name>')
  .description('Show detailed config for a specific agent')
  .action(async (agentName: string) => {
    await showAgentConfig(agentName);
  });

// ── mcp ────────────────────────────────────────────────────────
const mcpCmd = program
  .command('mcp')
  .description('Manage MCP service configurations');

mcpCmd
  .command('add <name>')
  .description('Install an MCP service independently')
  .option('--scope <scope>', 'Installation scope: global or project', 'global')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .option('--save', 'Save project MCP install to skm.mod')
  .option('--no-save', 'Do not save project MCP install to skm.mod')
  .action(async (name: string, opts: Record<string, unknown>) => {
    await addMcpService(name, {
      scope: opts['scope'] as InstallScope,
      agent: opts['agent'] as AgentType | 'all',
      save: opts['save'] as boolean | undefined,
    });
  });

mcpCmd
  .command('remove <name>')
  .alias('rm')
  .description('Remove an independently installed MCP service')
  .option('--scope <scope>', 'Scope to remove from', 'global')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .option('--save', 'Remove project MCP install from skm.mod')
  .option('--no-save', 'Do not remove project MCP install from skm.mod')
  .action(async (name: string, opts: Record<string, unknown>) => {
    await removeMcpService(
      name,
      opts['agent'] as string,
      (opts['scope'] as InstallScope) || 'global',
      { save: opts['save'] as boolean | undefined }
    );
  });

mcpCmd
  .command('sync')
  .description('Apply managed MCP services for a scope to one or all agents')
  .option('--scope <scope>', 'Scope to sync', 'global')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .action(async (opts: Record<string, unknown>) => {
    await syncMcpServices({
      scope: opts['scope'] as InstallScope,
      agent: opts['agent'] as AgentType | 'all',
    });
  });

mcpCmd
  .command('list', { isDefault: true })
  .description('List all configured MCP services')
  .action(async () => { await listMcpServices(); });

mcpCmd
  .command('status')
  .description('Check MCP service availability')
  .action(async () => { await checkMcpStatus(); });

// ── promote ───────────────────────────────────────────────────
const promoteCmd = program
  .command('promote')
  .description('Promote project-scoped skills or MCP services to global scope');

promoteCmd
  .command('skill <skill-name>')
  .description('Copy a project skill to global scope')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .option('--remove-project', 'Remove the project-scoped install after promoting to all agents')
  .action(async (skillName: string, opts: Record<string, unknown>) => {
    await promoteSkillToGlobal(skillName, {
      agent: opts['agent'] as AgentType | 'all',
      removeProject: Boolean(opts['removeProject']),
    });
  });

// ── demote ────────────────────────────────────────────────────
const demoteCmd = program
  .command('demote')
  .description('Demote global-scoped skills or MCP services to project scope');

demoteCmd
  .command('skill <skill-name>')
  .description('Demote a global skill to project scope')
  .option('--mode <mode>', 'Installation mode: copy, symlink-cache, or symlink-dev')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .action(async (skillName: string, opts: Record<string, unknown>) => {
    await demoteSkillToProject(skillName, {
      mode: installModeOption(opts['mode']),
      agent: opts['agent'] as AgentType | 'all',
    });
  });

demoteCmd
  .command('mcp <name>')
  .description('Demote a global MCP service to project scope')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .action(async (name: string, opts: Record<string, unknown>) => {
    await demoteMcpService(name, {
      agent: opts['agent'] as AgentType | 'all',
    });
  });

promoteCmd
  .command('mcp <name>')
  .description('Promote a project MCP service to global scope')
  .option('--agent <agent>', 'Target agent (or "all")', 'all')
  .action(async (name: string, opts: Record<string, unknown>) => {
    await promoteMcpService(name, {
      agent: opts['agent'] as AgentType | 'all',
    });
  });

// ── history ────────────────────────────────────────────────────
program
  .command('history <skill-name>')
  .description('Show replacement history for a skill')
  .action(async (skillName: string) => {
    const { getDb } = await import('./db/index.js');
    const db = await getDb();
    const history = db
      .prepare('SELECT * FROM replace_history WHERE skill_name = ? ORDER BY replaced_at DESC')
      .all(skillName) as Record<string, unknown>[];

    if (history.length === 0) {
      logger.info(`No replacement history for "${skillName}"`);
      return;
    }

    logger.blank();
    logger.info(`Replacement history for "${skillName}":`);
    logger.blank();
    
    for (const h of history) {
      let hText = `${chalk.bold('Date:')}   ${h['replaced_at']}\n`;
      hText += `${chalk.bold('From:')}   ${h['old_source']} ${chalk.gray(`(${(h['old_commit'] as string).substring(0, 7)})`)}\n`;
      hText += `${chalk.bold('To:')}     ${chalk.cyan(h['new_source'] as string)} ${chalk.gray(`(${(h['new_commit'] as string).substring(0, 7)})`)}`;
      logger.box(hText, { padding: 0, margin: { left: 2, top: 0, bottom: 1, right: 0 }, borderStyle: 'none' });
    }
  });

// ── cache ──────────────────────────────────────────────────────
const cacheCmd = program
  .command('cache')
  .description('Manage the skillpkg cache');

cacheCmd
  .command('clean')
  .description('Clean the global git cache directory')
  .action(async () => { await cleanCache(); });

// ── config ─────────────────────────────────────────────────────
const configCmd = program
  .command('config')
  .description('Manage skillpkg preferences');

configCmd
  .command('git [preference]')
  .description('Set git tracking preference: auto, track, or ask')
  .action(async (preference?: string) => { await configureGitPreference(preference); });

// ── cleanup on exit ────────────────────────────────────────────
process.on('exit', () => closeDb());
process.on('SIGINT', () => { closeDb(); process.exit(0); });

// ── run ────────────────────────────────────────────────────────
program.parse();
