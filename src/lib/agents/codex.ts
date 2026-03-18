import { execSync } from 'node:child_process'
import type { AgentAdapter, InvokeOpts, AgentInvocation } from './types.js'

export const codexAdapter: AgentAdapter = {
  name: 'Codex',
  binary: 'codex',
  streamFormat: 'codex',
  supportsJsonSchema: true,

  checkAvailable(): boolean {
    try {
      execSync('which codex', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },

  buildInvocation(opts: InvokeOpts): AgentInvocation {
    const args: string[] = ['exec', '--full-auto', '--skip-git-repo-check']

    if (opts.systemPrompt) {
      args.push('-c', `instructions="${opts.systemPrompt}"`)
    }

    if (opts.streaming) {
      args.push('--json')
    }

    if (opts.jsonSchemaFile) {
      args.push('--output-schema', opts.jsonSchemaFile)
    }

    args.push(opts.prompt)

    return { cmd: 'codex', args }
  },

  parseResult(stdout: string): string {
    // Codex without --json outputs raw text on stdout.
    // With --json, parse the last agent_message from JSONL events.
    const lines = stdout.trim().split('\n')
    let lastMessage = ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        if (event.type === 'item.completed') {
          const item = event.item as Record<string, unknown>
          if (item?.type === 'agent_message' && typeof item.text === 'string') {
            lastMessage = item.text
          }
        }
      } catch { /* skip */ }
    }
    return lastMessage || stdout.trim()
  },
}
