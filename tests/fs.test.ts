import { describe, expect, it } from 'vitest';
import { directorySymlinkType } from '../src/utils/fs.js';

describe('filesystem helpers', () => {
  it('uses Windows junctions for directory links', () => {
    expect(directorySymlinkType('win32')).toBe('junction');
    expect(directorySymlinkType('darwin')).toBe('dir');
    expect(directorySymlinkType('linux')).toBe('dir');
  });
});
