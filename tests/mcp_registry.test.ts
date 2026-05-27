import { describe, expect, it } from 'vitest';
import {
  getMcpConfig,
  isRemoteMcpEndpoint,
  isUnsupportedMcpAppPackage,
  looksLikeMcpAppPackageName,
  parsePythonProjectMetadata,
  remoteMcpTransport,
} from '../src/core/mcp_registry.js';
import { toMcpServerName } from '../src/utils/mcp_names.js';

describe('MCP server names', () => {
  it('converts scoped npm package names into valid MCP server ids', () => {
    expect(toMcpServerName('@drawio/mcp')).toBe('drawio-mcp');
    expect(toMcpServerName('@drawio/mcp-app')).toBe('drawio-mcp-app');
    expect(toMcpServerName('brave-search')).toBe('brave-search');
  });

  it('keeps the package spec in npx args but uses a safe server id', async () => {
    await expect(getMcpConfig('@drawio/mcp@1.2.7')).resolves.toMatchObject({
      name: 'drawio-mcp',
      command: 'npx',
      args: ['-y', '@drawio/mcp@1.2.7'],
    });
  });

  it('treats MCP endpoint URLs as remote MCP servers instead of Git repos', async () => {
    await expect(getMcpConfig('https://mcp.draw.io/mcp')).resolves.toMatchObject({
      name: 'draw-io',
      type: 'http',
      url: 'https://mcp.draw.io/mcp',
    });
    await expect(getMcpConfig('https://example.com/mcp-app/mcp')).resolves.toMatchObject({
      name: 'example-com-mcp-app',
      type: 'http',
      url: 'https://example.com/mcp-app/mcp',
    });
    await expect(getMcpConfig('https://mcp.hubspot.com/anthropic')).resolves.toMatchObject({
      name: 'hubspot-com-anthropic',
      type: 'http',
      url: 'https://mcp.hubspot.com/anthropic',
    });
    await expect(getMcpConfig('https://mcp.asana.com/sse')).resolves.toMatchObject({
      name: 'asana-com',
      type: 'sse',
      url: 'https://mcp.asana.com/sse',
    });
  });

  it('does not confuse Git URLs with remote MCP endpoints', () => {
    expect(isRemoteMcpEndpoint('https://mcp.draw.io/mcp')).toBe(true);
    expect(isRemoteMcpEndpoint('https://mcp.hubspot.com/anthropic')).toBe(true);
    expect(isRemoteMcpEndpoint('https://mcp.asana.com/sse')).toBe(true);
    expect(isRemoteMcpEndpoint('https://github.com/jgraph/drawio-mcp.git#mcp-app-server')).toBe(false);
    expect(remoteMcpTransport('https://mcp.draw.io/mcp')).toBe('http');
    expect(remoteMcpTransport('https://mcp.hubspot.com/anthropic')).toBe('http');
    expect(remoteMcpTransport('https://mcp.asana.com/sse')).toBe('sse');
  });
});

describe('MCP App package detection', () => {
  it('detects packages that are likely MCP App or HTTP servers', () => {
    expect(looksLikeMcpAppPackageName('@drawio/mcp-app')).toBe(true);
    expect(looksLikeMcpAppPackageName('@drawio/mcp')).toBe(false);
    expect(isUnsupportedMcpAppPackage({
      name: '@drawio/mcp-app',
      dependencies: { '@modelcontextprotocol/ext-apps': '^1.1.2' },
    })).toBe(true);
  });

  it('rejects MCP App packages because skm only configures stdio clients', async () => {
    await expect(getMcpConfig('@drawio/mcp-app')).rejects.toThrow(/stdio MCP clients only/);
  });
});

describe('parsePythonProjectMetadata', () => {
  it('reads hyphenated script names from project.scripts', () => {
    const metadata = parsePythonProjectMetadata(`
[build-system]
requires = ["hatchling"]

[project]
name = "qgis-mcp"
version = "0.3.0"

[project.scripts]
qgis-mcp-server = "qgis_mcp.server:main"

[dependency-groups]
dev = ["pytest"]
`, 'fallback');

    expect(metadata).toEqual({
      name: 'qgis-mcp',
      scriptName: 'qgis-mcp-server',
    });
  });

  it('falls back to the project name when no script is declared', () => {
    const metadata = parsePythonProjectMetadata(`
[project]
name = "demo-mcp"
`, 'fallback');

    expect(metadata).toEqual({
      name: 'demo-mcp',
      scriptName: 'demo-mcp',
    });
  });
});
