import { describe, expect, it } from 'vitest';
import { getAllAdapters } from '../src/adapters/index.js';
import { ALL_AGENT_TYPES } from '../src/types/index.js';

describe('agent registry', () => {
  it('registers one adapter for every supported agent type', () => {
    const adapterNames = getAllAdapters().map((adapter) => adapter.name);

    expect(adapterNames.sort()).toEqual([...ALL_AGENT_TYPES].sort());
    expect(adapterNames).toContain('antigravity-cli');
    expect(adapterNames).not.toContain('gemini-cli');
  });
});
