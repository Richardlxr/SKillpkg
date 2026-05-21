/**
 * Replace directive resolver — Go mod style
 *
 * Applies `replace` directives from skillpkg.yaml to redirect skill sources.
 * This is the key mechanism for:
 *   1. Using a fork instead of the original
 *   2. Using a local directory during development
 *   3. Hotfixing a broken upstream dependency
 *
 * Inspired by Go's `go.mod` replace directive:
 *   replace github.com/original/pkg => github.com/my-fork/pkg v1.2.3
 *   replace github.com/broken/pkg => ../local-fix
 */
import type { ReplaceDirective, SkillDependency } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { isLocalPathSource, resolveLocalPathSource } from '../utils/path_source.js';

/**
 * Apply replace directives to a list of dependencies.
 * Returns the modified dependency list with sources redirected.
 */
export function applyReplaceDirectives(
  dependencies: SkillDependency[],
  directives: ReplaceDirective[],
  projectRoot: string
): SkillDependency[] {
  if (!directives.length) return dependencies;

  // Build a lookup map: normalized old source → directive
  const replaceMap = new Map<string, ReplaceDirective>();
  for (const d of directives) {
    replaceMap.set(normalizeSource(d.old), d);
  }

  return dependencies.map((dep) => {
    const key = normalizeSource(dep.source);
    const directive = replaceMap.get(key);

    if (!directive) return dep;

    logger.debug(`Replace: ${dep.source} => ${directive.new}`);

    // Check if the replacement is a local path
    const isLocalPath = isLocalPathSource(directive.new);

    const newSource = isLocalPath
      ? resolveLocalPathSource(directive.new, projectRoot)
      : directive.new;

    return {
      ...dep,
      source: newSource,
      version: directive.version || dep.version,
    };
  });
}

/**
 * Resolve a single source string through replace directives.
 * Used when the top-level install source itself may be replaced.
 */
export function resolveSource(
  source: string,
  directives: ReplaceDirective[],
  projectRoot: string
): { source: string; replaced: boolean } {
  for (const d of directives) {
    if (normalizeSource(source) === normalizeSource(d.old)) {
      const isLocal = isLocalPathSource(d.new);

      return {
        source: isLocal ? resolveLocalPathSource(d.new, projectRoot) : d.new,
        replaced: true,
      };
    }
  }

  return { source, replaced: false };
}

/** Normalize source for comparison */
function normalizeSource(src: string): string {
  return src
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}
