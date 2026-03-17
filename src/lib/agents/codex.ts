import { execSync } from 'node:child_process'
import type { AgentAdapter, InvokeOpts, AgentInvocation } from './types.js'

export const codexAdapter: AgentAdapter = {
  name: 'Codex',
  binary: 'codex',
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
    const args: string[] = ['exec', '--full-auto']

    if (opts.systemPrompt) {
      args.push('-c', `instructions="${opts.systemPrompt}"`)
    }

    if (opts.jsonSchemaFile) {
      args.push('--output-schema', opts.jsonSchemaFile)
    }

    args.push(opts.prompt)

    return { cmd: 'codex', args }
  },

  parseResult(stdout: string): string {
    // Codex with --json outputs JSONL. Without --json, stdout is the raw text.
    // Since we don't use --json (we capture stdout directly), just return trimmed output.
    // For structured steps, --output-schema enforces the shape and the final message is JSON.
    return stdout.trim()
  },
}
