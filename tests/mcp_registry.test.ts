import { describe, expect, it } from 'vitest';
import { parsePythonProjectMetadata } from '../src/core/mcp_registry.js';

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
