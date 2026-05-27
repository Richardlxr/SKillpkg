import { createHash } from 'node:crypto';

const VALID_MCP_SERVER_NAME = /^[a-zA-Z0-9_-]+$/;

export function toMcpServerName(name: string): string {
  if (VALID_MCP_SERVER_NAME.test(name)) return name;

  const withoutScopeMarker = name.startsWith('@') ? name.slice(1) : name;
  const sanitized = withoutScopeMarker
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (sanitized && VALID_MCP_SERVER_NAME.test(sanitized)) {
    return sanitized;
  }

  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `mcp-${digest}`;
}

export function mcpServerNameCandidates(name: string): string[] {
  return Array.from(new Set([name, toMcpServerName(name)]));
}

export function looksLikeMcpAppName(name: string): boolean {
  return /(?:^|[/_#-])mcp-app(?:$|[/_-])/i.test(name);
}
