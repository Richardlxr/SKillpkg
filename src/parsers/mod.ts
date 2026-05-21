export interface ModSkill {
  source: string;
  version?: string;
}

export interface ModMcp {
  name: string;
}

export interface ModReplace {
  from: string;
  to: string;
}

export interface ModFile {
  module: string;
  skills: ModSkill[];
  mcps: ModMcp[];
  replaces: ModReplace[];
  /** Backward-compatible alias for the old skm.mod require format. */
  requires: ModSkill[];
}

type BlockDirective = 'require' | 'skill' | 'mcp' | 'replace';

export function parseModFile(content: string): ModFile {
  const skills: ModSkill[] = [];
  const result: ModFile = {
    module: '',
    skills,
    mcps: [],
    replaces: [],
    requires: skills,
  };
  const lines = content.split('\n');
  let activeBlock: BlockDirective | null = null;

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine.trim());
    if (!line) continue;

    if (activeBlock && line === ')') {
      activeBlock = null;
      continue;
    }

    if (activeBlock) {
      parseDirective(activeBlock, line, result);
      continue;
    }

    const block = line.match(/^(require|skill|mcp|replace)\s+\($/);
    if (block) {
      activeBlock = block[1] as BlockDirective;
      continue;
    }

    if (line.startsWith('module ')) {
      result.module = line.substring(7).trim();
      continue;
    }

    const directive = line.match(/^(require|skill|mcp|replace)\s+(.+)$/);
    if (directive) {
      parseDirective(directive[1] as BlockDirective, directive[2].trim(), result);
    }
  }

  return result;
}

export function generateModFile(mod: ModFile): string {
  const lines = [`module ${mod.module}`, ''];
  const skills = mod.skills?.length ? mod.skills : mod.requires || [];

  for (const skill of skills) {
    lines.push(`skill ${skill.source}${skill.version ? ' ' + skill.version : ''}`);
  }

  if (skills.length > 0 && mod.mcps.length > 0) {
    lines.push('');
  }

  for (const mcp of mod.mcps) {
    lines.push(`mcp ${mcp.name}`);
  }

  if ((skills.length > 0 || mod.mcps.length > 0) && mod.replaces.length > 0) {
    lines.push('');
  }

  for (const replacement of mod.replaces) {
    lines.push(`replace ${replacement.from} => ${replacement.to}`);
  }

  return lines.join('\n').trimEnd() + '\n';
}

function parseDirective(kind: BlockDirective, body: string, result: ModFile): void {
  if (kind === 'require' || kind === 'skill') {
    const parts = body.split(/\s+/);
    if (parts[0]) {
      result.skills.push({ source: parts[0], version: parts[1] });
    }
    return;
  }

  if (kind === 'mcp') {
    const [name] = body.split(/\s+/);
    if (name) {
      result.mcps.push({ name });
    }
    return;
  }

  const match = body.match(/^(\S+)\s+=>\s+(\S+)$/);
  if (match) {
    result.replaces.push({ from: match[1], to: match[2] });
  }
}

function stripInlineComment(line: string): string {
  if (line.startsWith('//') || line.startsWith('#')) return '';
  return line.replace(/\s+(\/\/|#).*$/, '').trim();
}
