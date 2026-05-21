import { describe, it, expect } from 'vitest';
import { formatSourceForDisplay, parseSourceString } from '../src/parsers/index.js';
import { generateModFile, parseModFile } from '../src/parsers/mod.js';

describe('parseSourceString', () => {
  it('should parse owner/repo format', () => {
    const res = parseSourceString('owner/repo');
    expect(res.repoUrl).toBe('https://github.com/owner/repo');
    expect(res.version).toBeUndefined();
    expect(res.skillPath).toBeUndefined();
  });

  it('should parse owner/repo/path format', () => {
    const res = parseSourceString('owner/repo/sub/path');
    expect(res.repoUrl).toBe('https://github.com/owner/repo');
    expect(res.skillPath).toBe('sub/path');
    expect(res.version).toBeUndefined();
  });

  it('should parse version pinning', () => {
    const res = parseSourceString('owner/repo@v1.0.0');
    expect(res.repoUrl).toBe('https://github.com/owner/repo');
    expect(res.version).toBe('v1.0.0');
  });

  it('should parse full URL', () => {
    const res = parseSourceString('https://github.com/owner/repo');
    expect(res.repoUrl).toBe('https://github.com/owner/repo');
  });

  it('should parse github colon shorthand', () => {
    const res = parseSourceString('github:owner/repo');
    expect(res.repoUrl).toBe('https://github.com/owner/repo');
  });

  it('should preserve host-qualified repository paths', () => {
    const res = parseSourceString('gitlab.com/example-org/workflow-skill');
    expect(res.repoUrl).toBe('https://gitlab.com/example-org/workflow-skill');
    expect(res.skillPath).toBeUndefined();
  });

  it('should preserve SSH scp-style URLs with fragment version refs', () => {
    const res = parseSourceString('git@gitlab.com:example-org/workflow-skill.git#v1.0.0');
    expect(res.repoUrl).toBe('git@gitlab.com:example-org/workflow-skill.git');
    expect(res.version).toBe('v1.0.0');
    expect(res.skillPath).toBeUndefined();
  });

  it('should preserve SSH scp-style URLs with at-sign version refs', () => {
    const res = parseSourceString('git@gitlab.com:example-org/workflow-skill.git@v1.0.0');
    expect(res.repoUrl).toBe('git@gitlab.com:example-org/workflow-skill.git');
    expect(res.version).toBe('v1.0.0');
  });

  it('should preserve non-GitHub HTTPS URLs with fragment version refs', () => {
    const res = parseSourceString('https://gitlab.com/example-org/workflow-skill.git#v1.0.0');
    expect(res.repoUrl).toBe('https://gitlab.com/example-org/workflow-skill.git');
    expect(res.version).toBe('v1.0.0');
  });

  it('should keep URL fragments as subpaths when they are not version refs', () => {
    const res = parseSourceString('https://github.com/jgraph/drawio-mcp#mcp-tool-server');
    expect(res.repoUrl).toBe('https://github.com/jgraph/drawio-mcp');
    expect(res.skillPath).toBe('mcp-tool-server');
    expect(res.version).toBeUndefined();
  });
});

describe('formatSourceForDisplay', () => {
  it('keeps GitHub shorthand display unchanged', () => {
    expect(formatSourceForDisplay('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('keeps non-GitHub hosts visible', () => {
    expect(formatSourceForDisplay('https://gitlab.com/example-org/workflow-skill')).toBe(
      'gitlab.com/example-org/workflow-skill'
    );
  });
});

describe('skm.mod parser', () => {
  it('parses the new skill and mcp directives', () => {
    const mod = parseModFile(`
module my-project

skill github.com/owner/pdf-tools v1.0.0
skill github.com/other/data-analyzer
mcp @modelcontextprotocol/server-memory
replace github.com/original/skill => github.com/my-fork/skill
`);

    expect(mod.module).toBe('my-project');
    expect(mod.skills).toEqual([
      { source: 'github.com/owner/pdf-tools', version: 'v1.0.0' },
      { source: 'github.com/other/data-analyzer', version: undefined },
    ]);
    expect(mod.requires).toBe(mod.skills);
    expect(mod.mcps).toEqual([{ name: '@modelcontextprotocol/server-memory' }]);
    expect(mod.replaces).toEqual([
      { from: 'github.com/original/skill', to: 'github.com/my-fork/skill' },
    ]);
  });

  it('keeps old require directives as skills for backward compatibility', () => {
    const mod = parseModFile(`
module old-project

require (
  github.com/owner/legacy v0.1.0
)
`);

    expect(mod.skills).toEqual([{ source: 'github.com/owner/legacy', version: 'v0.1.0' }]);
  });

  it('generates the new manifest format', () => {
    const content = generateModFile({
      module: 'my-project',
      skills: [{ source: 'github.com/owner/pdf-tools', version: 'v1.0.0' }],
      mcps: [{ name: '@playwright/mcp' }],
      replaces: [{ from: 'github.com/original/skill', to: '../skill' }],
      requires: [],
    });

    expect(content).toBe([
      'module my-project',
      '',
      'skill github.com/owner/pdf-tools v1.0.0',
      '',
      'mcp @playwright/mcp',
      '',
      'replace github.com/original/skill => ../skill',
      '',
    ].join('\n'));
  });
});
