import type { AgentAdapter } from './types.js'
import { claudeAdapter } from './claude.js'
import { codexAdapter } from './codex.js'
import { CliError } from '../errors.js'

const ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
}

/** Resolve an agent target string to its adapter. */
export function resolveAdapter(target: string): AgentAdapter {
  const adapter = ADAPTERS[target]
  if (!adapter) {
    const available = Object.keys(ADAPTERS).join(', ')
    throw new CliError(
      `Unknown agent "${target}". Available agents: ${available}`,
      'UNKNOWN_AGENT',
    )
  }
  return adapter
}

/** Resolve the agent target from flag > env > config. Returns undefined if none set. */
export function resolveAgentTarget(flag?: string, configAgent?: string): string | undefined {
  return flag || process.env.AIXBT_AGENT || configAgent || undefined
}
