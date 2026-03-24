/** Options passed to an agent adapter to build an invocation. */
export interface InvokeOpts {
  /** Path to a temp JSON file containing the recipe data. */
  dataFile: string
  /** The instruction/task prompt for the agent. */
  prompt: string
  /** Optional system prompt (e.g. analysis instructions). */
  systemPrompt?: string
  /** Path to a temp JSON schema file for structured returns. */
  jsonSchemaFile?: string
  /** Request streaming output (stream-json) for incremental rendering. */
  streaming?: boolean
  /** Allowed tools for the agent session. */
  allowedTools?: string[]
  /** When true, prompt will be piped via stdin instead of -p arg. */
  useStdin?: boolean
}

/** Result of building an agent invocation command. */
export interface AgentInvocation {
  cmd: string
  args: string[]
  env?: Record<string, string>
}

/** Stream event format emitted by an agent's --json/streaming mode. */
export type StreamFormat = 'claude' | 'codex'

/** Adapter interface for agent integrations. */
export interface AgentAdapter {
  /** Display name (e.g. "Claude Code"). */
  name: string
  /** Binary name on PATH (e.g. "claude"). */
  binary: string
  /** Stream event format for parsing JSONL output. */
  streamFormat: StreamFormat
  /** Check if the agent binary is available. */
  checkAvailable(): boolean
  /** Build the command invocation for a given set of options. */
  buildInvocation(opts: InvokeOpts): AgentInvocation
  /** Extract the text response from the agent's stdout. */
  parseResult(stdout: string): string
  /** Whether the agent supports native JSON schema enforcement. */
  supportsJsonSchema: boolean
}
