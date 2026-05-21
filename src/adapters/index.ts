/**
 * Agent adapter registry — discovers and manages all agent adapters
 */
import type { AgentAdapter, AgentType } from '../types/index.js';
import { AntigravityAdapter } from './antigravity.js';
import { AntigravityCliAdapter } from './antigravity-cli.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { CursorAdapter } from './cursor.js';
import { logger } from '../utils/logger.js';

/** All registered adapters */
const adapters = new Map<AgentType, AgentAdapter>();
adapters.set('antigravity', new AntigravityAdapter());
adapters.set('antigravity-cli', new AntigravityCliAdapter());
adapters.set('claude-code', new ClaudeCodeAdapter());
adapters.set('codex', new CodexAdapter());
adapters.set('cursor', new CursorAdapter());

/** Get a specific adapter */
export function getAdapter(name: AgentType): AgentAdapter | undefined {
  return adapters.get(name);
}

/** Get all adapters */
export function getAllAdapters(): AgentAdapter[] {
  return Array.from(adapters.values());
}

/** Detect which agents are installed on this system */
export async function detectAgents(): Promise<AgentAdapter[]> {
  const detected: AgentAdapter[] = [];

  for (const adapter of adapters.values()) {
    try {
      if (await adapter.detect()) {
        detected.push(adapter);
      }
    } catch {
      logger.debug(`Failed to detect ${adapter.displayName}`);
    }
  }

  return detected;
}

/** Get adapters by name or 'all' */
export async function resolveAdapters(
  target: AgentType | 'all'
): Promise<AgentAdapter[]> {
  if (target === 'all') {
    return detectAgents();
  }
  const adapter = getAdapter(target);
  if (!adapter) {
    throw new Error(`Unknown agent: ${target}`);
  }
  if (!(await adapter.detect())) {
    logger.warn(`Agent ${adapter.displayName} is not detected on this system`);
  }
  return [adapter];
}
