/**
 * Logging utility with colored output
 */
import chalk from 'chalk';
import ora, { type Options as OraOptions } from 'ora';
import Table from 'cli-table3';
import boxen, { type Options as BoxenOptions } from 'boxen';

let jsonMode = false;

export const logger = {
  setJsonMode(isJson: boolean) {
    jsonMode = isJson;
  },
  isJsonMode(): boolean {
    return jsonMode;
  },
  json(data: unknown) {
    if (jsonMode) {
      console.log(JSON.stringify(data, null, 2));
    }
  },
  info(msg: string) {
    if (jsonMode) return;
    console.log(`  ${chalk.blue.bold('ℹ')} ${msg}`);
  },
  success(msg: string) {
    if (jsonMode) return;
    console.log(`  ${chalk.green.bold('✔')} ${msg}`);
  },
  warn(msg: string) {
    if (jsonMode) return;
    console.log(`  ${chalk.yellow.bold('⚠')} ${chalk.yellow(msg)}`);
  },
  error(msg: string) {
    if (jsonMode) return;
    console.error(`  ${chalk.red.bold('✖')} ${chalk.red(msg)}`);
  },
  debug(msg: string) {
    if (jsonMode) return;
    if (process.env['SKILLPKG_DEBUG']) {
      console.log(`  ${chalk.gray.bold('⊙')} ${chalk.gray(msg)}`);
    }
  },
  skill(name: string, action: string) {
    if (jsonMode) return;
    console.log(`  ${chalk.cyan.bold('◆')} ${chalk.bold(name)} ${chalk.gray(`— ${action}`)}`);
  },
  agent(name: string, action: string) {
    if (jsonMode) return;
    console.log(`  ${chalk.magenta.bold('▸')} ${chalk.bold(name)} ${chalk.gray(`— ${action}`)}`);
  },
  table(head: string[], rows: any[][]) {
    if (jsonMode) return;
    const table = new Table({
      head: head.map(h => chalk.bold.cyan(h)),
      style: {
        head: [],
        border: ['gray'],
      },
      chars: {
        'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
        'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
        'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
        'right': '│', 'right-mid': '┤', 'middle': '│'
      }
    });
    table.push(...rows);
    console.log(table.toString());
  },
  box(text: string, options?: BoxenOptions) {
    if (jsonMode) return;
    console.log(boxen(text, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'cyan',
      ...options
    }));
  },
  blank() {
    if (jsonMode) return;
    console.log();
  },
  spinner(text: string, options?: OraOptions) {
    return ora({
      text: ` ${text}`,
      color: 'cyan',
      spinner: 'dots',
      ...options
    });
  }
};
