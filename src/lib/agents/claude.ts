import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { AgentAdapter, InvokeOpts, AgentInvocation } from './types.js'

const DEFAULT_ALLOWED_TOOLS = ['Read', 'WebSearch', 'WebFetch', 'Bash(aixbt:*)']

export const claudeAdapter: AgentAdapter = {
  name: 'Claude Code',
  binary: 'claude',
  streamFormat: 'claude',
  supportsJsonSchema: true,
  supportsStdin: true,

  checkAvailable(): boolean {
    try {
      execSync('which claude', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },

  buildInvocation(opts: InvokeOpts): AgentInvocation {
    const useJson = !!opts.jsonSchemaFile
    let outputFormat = useJson ? 'json' : 'text'
    const tools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS
    const args: string[] = []

    if (opts.useStdin) {
      args.push('-p')
    } else {
      args.push('-p', opts.prompt)
    }

    args.push('--allowedTools', ...tools)

    if (opts.streaming && !useJson) {
      outputFormat = 'stream-json'
      args.push('--output-format', outputFormat, '--verbose', '--include-partial-messages')
    } else {
      args.push('--output-format', outputFormat)
    }

    if (opts.systemPrompt) {
      args.push('--append-system-prompt', opts.systemPrompt)
    }

    if (opts.jsonSchemaFile) {
      args.push('--json-schema', readFileSync(opts.jsonSchemaFile, 'utf-8'))
    }

    return { cmd: 'claude', args }
  },

  parseResult(stdout: string): string {
    // When using --output-format json, Claude returns JSON with a .result field.
    // When using text mode, stdout is the raw text.
    try {
      const parsed = JSON.parse(stdout) as { result?: string }
      if (parsed.result !== undefined) return parsed.result
    } catch {
      // Not JSON — return raw text
    }
    return stdout.trim()
  },
}
