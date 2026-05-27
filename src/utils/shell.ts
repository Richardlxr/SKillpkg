export function windowsShellCompatibilityIssue(command: string): string | null {
  if (process.platform !== 'win32') return null;

  const shellCommand = command.trim();
  if (!shellCommand) return null;

  const unixCommand = shellCommand.match(/(?:^|[;&|()]\s*)(cp|rm|mv|chmod|chown|ln|sed|grep|awk|cat|touch)(?=\s|$)/);
  if (unixCommand) return `Unix shell command "${unixCommand[1]}"`;
  if (/(?:^|[;&|()]\s*)mkdir\s+-p(?=\s|$)/.test(shellCommand)) return 'Unix shell command "mkdir -p"';
  if (/(?:^|[;&|()]\s*)export\s+[A-Za-z_][A-Za-z0-9_]*=/.test(shellCommand)) return 'Unix shell syntax "export VAR=..."';

  return null;
}
