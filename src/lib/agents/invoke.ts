import { spawn, execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import chalk from 'chalk'
import type { AgentAdapter } from './types.js'
import type { RecipeAwaitingAgent, RecipeComplete, ParallelAgentMeta, RecipeStep } from '../../types.js'
import { isAgentStep } from '../../types.js'
import { CliError } from '../errors.js'
import { fmt, wrapIndented } from '../output.js'

const AGENT_SYSTEM_PROMPT = [
  'You are analyzing AIXBT recipe output.',
  'AIXBT is a crypto intelligence platform that tracks discussions on X.',
  'It organizes tracked accounts into clusters (independent community segments via social graph analysis), detects signals (discrete verified facts about projects, not opinions), and scores momentum (rate of new cluster convergence, measuring breadth of attention, not volume).',
  'When using tools, briefly describe what you are about to do (e.g. "Reading signals data").',
  'Once all tool calls are complete and you begin your final response, go straight into the analysis.',
  'No preamble, no "here is the analysis", no summary of what you just read — just the analysis itself.',
  'Never use em-dashes. Use commas, periods, or restructure the sentence.',
  'Do not mention all-time high (ATH) prices unless the asset has recently broken its ATH. Most assets are well below ATH, so commenting on the distance from ATH is not insightful.',
].join(' ')



function buildContextBlock(contextHints?: string[]): string {
  if (!contextHints || contextHints.length === 0) return ''
  return ['<context>', ...contextHints, '</context>', ''].join('\n')
}

/**
 * Create a temp working directory for agent sessions.
 * Using a cwd under ~/.aixbt/tmp/ prevents Claude Code from
 * inheriting the user's project CLAUDE.md (different path).
 */
function createAgentWorkdir(): string {
  return mkdtempSync(join(tmpdir(), 'aixbt-agent-'))
}

const BRAND_PURPLE = '#b07de3'

export const AGENT_COLORS: Record<string, string> = {
  claude: '#da7756',
  codex: '#10a37f',
}

function writeTempFile(prefix: string, data: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aixbt-'))
  const file = join(dir, `${prefix}.json`)
  writeFileSync(file, data, { mode: 0o600 })
  return file
}

function cleanupTempFile(file: string): void {
  try { unlinkSync(file) } catch { /* ignore */ }
}

function buildPromptForStep(result: RecipeAwaitingAgent, dataFiles: Map<string, string>): string {
  const parts = [
    `Read ALL of the AIXBT recipe data files below in parallel. Large datasets are split into numbered chunks (e.g. signals/001, signals/002). Read every file — do not skip or sample.`,
    '',
  ]

  for (const [stepId, filePath] of dataFiles) {
    parts.push(`- ${stepId}: ${filePath}`)
  }

  const contextBlock = buildContextBlock(result.contextHints)
  parts.push(
    '',
    ...(contextBlock ? [contextBlock] : []),
    `<instructions>`,
    result.instructions,
    `</instructions>`,
    '',
    `<returns>`,
    `Respond with a JSON object matching this schema:`,
    JSON.stringify(result.returns, null, 2),
    `</returns>`,
  )

  return parts.join('\n')
}

function buildPromptForAnalysis(result: RecipeComplete, dataFiles: Map<string, string>): string {
  const parts = [
    `Read ALL of the AIXBT recipe data files below in parallel. Large datasets are split into numbered chunks (e.g. signals/001, signals/002). Read every file — do not skip or sample.`,
    '',
  ]

  for (const [stepId, filePath] of dataFiles) {
    parts.push(`- ${stepId}: ${filePath}`)
  }
  parts.push('')

  const contextBlock = buildContextBlock(result.contextHints)
  if (contextBlock) parts.push(contextBlock)

  if (result.analysis?.instructions) {
    parts.push(`<instructions>`, result.analysis.instructions, `</instructions>`, '')
  }

  if (result.analysis?.output) {
    parts.push(`<output-format>`, result.analysis.output, `</output-format>`, '')
  }

  return parts.join('\n')
}

/** @internal Exported for testing. */
export function buildInlinePromptForAnalysis(result: RecipeComplete): string {
  const parts = [
    `Analyze the following AIXBT recipe data. All data is provided inline below.`,
    '',
  ]

  for (const [stepId, stepData] of Object.entries(result.data)) {
    if (stepId === '_fallbackNotes') continue
    parts.push(`<data step="${stepId}">`)
    parts.push(JSON.stringify(stepData, null, 2))
    parts.push(`</data>`)
    parts.push('')
  }

  if (result.data._fallbackNotes) {
    parts.push(`<fallback-notes>`)
    parts.push(JSON.stringify(result.data._fallbackNotes, null, 2))
    parts.push(`</fallback-notes>`)
    parts.push('')
  }

  const contextBlock = buildContextBlock(result.contextHints)
  if (contextBlock) parts.push(contextBlock)

  if (result.analysis?.instructions) {
    parts.push(`<instructions>`, result.analysis.instructions, `</instructions>`, '')
  }

  if (result.analysis?.output) {
    parts.push(`<output-format>`, result.analysis.output, `</output-format>`, '')
  }

  return parts.join('\n')
}

function spawnAgent(
  adapter: AgentAdapter,
  args: string[],
  env?: Record<string, string>,
  opts?: { inherit?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.binary, args, {
      stdio: opts?.inherit
        ? ['ignore', 'inherit', 'inherit']
        : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })

    let stdout = ''
    let stderr = ''

    if (!opts?.inherit) {
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    }

    child.on('error', (err) => {
      reject(new CliError(
        `Failed to spawn ${adapter.name}: ${err.message}`,
        'AGENT_SPAWN_FAILED',
      ))
    })

    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || `exit code ${code}`
        reject(new CliError(
          `${adapter.name} exited with error: ${detail}`,
          'AGENT_EXECUTION_FAILED',
        ))
        return
      }
      resolve(stdout)
    })
  })
}

/** Parse JSON from agent text output, handling code fences and bare JSON. */
function parseAgentJson(text: string, stepId: string, adapterName: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
    if (fenceMatch) {
      return JSON.parse(fenceMatch[1]) as Record<string, unknown>
    }
    const braceMatch = text.match(/\{[\s\S]*\}/)
    if (braceMatch) {
      return JSON.parse(braceMatch[0]) as Record<string, unknown>
    }
    throw new CliError(
      `${adapterName} returned unparseable response for step "${stepId}". Raw output:\n${text.slice(0, 500)}`,
      'AGENT_PARSE_FAILED',
    )
  }
}

/** Invoke the agent for an intermediate recipe step. Returns parsed JSON response. */
export async function invokeAgentForStep(
  adapter: AgentAdapter,
  result: RecipeAwaitingAgent,
  opts?: { allowedTools?: string[] },
): Promise<Record<string, unknown>> {
  const { files: dataFiles } = writeDataFiles(result.data)
  let schemaFile: string | undefined

  try {
    const prompt = buildPromptForStep(result, dataFiles)

    if (adapter.supportsJsonSchema) {
      schemaFile = writeTempFile('schema', JSON.stringify(result.returns))
    }

    const invocation = adapter.buildInvocation({
      dataFile: '',
      prompt,
      systemPrompt: `${AGENT_SYSTEM_PROMPT} Follow the instructions precisely. Return only valid JSON.`,
      jsonSchemaFile: schemaFile,
      allowedTools: opts?.allowedTools,
    })

    const stdout = await spawnAgent(adapter, invocation.args, invocation.env)
    const text = adapter.parseResult(stdout)
    return parseAgentJson(text, result.step, adapter.name)
  } finally {
    for (const file of dataFiles.values()) cleanupTempFile(file)
    if (schemaFile) cleanupTempFile(schemaFile)
  }
}

// -- Parallel agent execution --

export interface ParallelAgentCallbacks {
  onItemComplete?: (index: number, total: number, failed: boolean) => void
}

function buildPromptForParallelItem(
  result: RecipeAwaitingAgent,
  parallel: ParallelAgentMeta,
  itemIndex: number,
  dataFiles: Map<string, string>,
): string {
  const parts = [
    `Read ALL of the AIXBT recipe data files below in parallel. Read every file — do not skip or sample.`,
    '',
    `This is item ${itemIndex + 1} of ${parallel.items.length}. Analyze this specific item only.`,
    '',
  ]

  for (const [stepId, filePath] of dataFiles) {
    parts.push(`- ${stepId}: ${filePath}`)
  }

  const contextBlock = buildContextBlock(result.contextHints)
  parts.push(
    '',
    ...(contextBlock ? [contextBlock] : []),
    `<instructions>`,
    result.instructions,
    `</instructions>`,
    '',
    `<returns>`,
    `Respond with a JSON object matching this schema:`,
    JSON.stringify(result.returns, null, 2),
    `</returns>`,
  )

  return parts.join('\n')
}

/** Write data files for a single parallel agent invocation (one item). */
function writeParallelItemFiles(
  item: unknown,
  itemIndex: number,
  parallel: ParallelAgentMeta,
  allData: Record<string, unknown>,
): Map<string, string> {
  const files = new Map<string, string>()

  // Write the item itself
  files.set('_item', writeTempFile('item', JSON.stringify(item, null, 2)))

  // Per-item context: slice by position
  for (const stepId of parallel.perItemContext) {
    const stepData = allData[stepId]
    if (Array.isArray(stepData) && itemIndex < stepData.length) {
      files.set(stepId, writeTempFile(stepId, JSON.stringify(stepData[itemIndex], null, 2)))
    }
  }

  // Shared context: write full data (use writeDataFiles chunking)
  for (const stepId of parallel.sharedContext) {
    const stepData = allData[stepId]
    if (stepData !== undefined) {
      files.set(stepId, writeTempFile(stepId, JSON.stringify(stepData, null, 2)))
    }
  }

  // Fallback notes
  if (allData._fallbackNotes) {
    files.set('_fallbackNotes', writeTempFile('fallbackNotes', JSON.stringify(allData._fallbackNotes, null, 2)))
  }

  return files
}

/** Invoke parallel agents for a fan-out step. Returns array of results. */
export async function invokeParallelAgents(
  adapter: AgentAdapter,
  result: RecipeAwaitingAgent,
  opts?: { allowedTools?: string[]; callbacks?: ParallelAgentCallbacks },
): Promise<Record<string, unknown>[]> {
  const parallel = result.parallel!
  const items = parallel.items
  const concurrency = parallel.concurrency
  const results: (Record<string, unknown> | { _error: true; index: number; error: string })[] = new Array(items.length)

  let completed = 0

  // Process items in batches
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency)
    const batchPromises = batch.map(async (item, batchIdx) => {
      const itemIndex = offset + batchIdx
      const itemFiles = writeParallelItemFiles(item, itemIndex, parallel, result.data)
      let schemaFile: string | undefined

      try {
        const prompt = buildPromptForParallelItem(result, parallel, itemIndex, itemFiles)

        if (adapter.supportsJsonSchema) {
          schemaFile = writeTempFile('schema', JSON.stringify(result.returns))
        }

        const invocation = adapter.buildInvocation({
          dataFile: '',
          prompt,
          systemPrompt: `${AGENT_SYSTEM_PROMPT} Follow the instructions precisely. Return only valid JSON.`,
          jsonSchemaFile: schemaFile,
          allowedTools: opts?.allowedTools,
        })

        const stdout = await spawnAgent(adapter, invocation.args, invocation.env)
        const text = adapter.parseResult(stdout)
        const parsed = parseAgentJson(text, `${result.step}[${itemIndex}]`, adapter.name)

        completed++
        opts?.callbacks?.onItemComplete?.(completed, items.length, false)
        return { index: itemIndex, result: parsed }
      } catch (err) {
        completed++
        opts?.callbacks?.onItemComplete?.(completed, items.length, true)
        const error = err instanceof Error ? err.message : String(err)
        return { index: itemIndex, result: { _error: true as const, index: itemIndex, error } }
      } finally {
        for (const file of itemFiles.values()) cleanupTempFile(file)
        if (schemaFile) cleanupTempFile(schemaFile)
      }
    })

    const batchResults = await Promise.all(batchPromises)
    for (const { index, result: itemResult } of batchResults) {
      results[index] = itemResult
    }
  }

  return results as Record<string, unknown>[]
}

// Target ~30KB per file — small enough for a single Read call
const CHUNK_BYTES = 30_000

/** Write a JSON file into an existing directory. */
function writeDataFile(dir: string, name: string, data: string): string {
  const file = join(dir, `${name}.json`)
  writeFileSync(file, data, { mode: 0o600 })
  return file
}

/**
 * Write recipe data as files into a single temp directory, chunking large
 * arrays by size so each file is small enough for a single Read call.
 */
/** @internal Exported for testing. */
export function writeDataFiles(data: Record<string, unknown>): { dir: string; files: Map<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'aixbt-'))
  const files = new Map<string, string>()

  for (const [stepId, stepData] of Object.entries(data)) {
    if (!Array.isArray(stepData)) {
      files.set(stepId, writeDataFile(dir, stepId, JSON.stringify(stepData, null, 2)))
      continue
    }

    // Chunk arrays by byte size
    let chunk: unknown[] = []
    let chunkBytes = 0
    let chunkIdx = 1

    for (const item of stepData) {
      const itemJson = JSON.stringify(item)
      if (chunk.length > 0 && chunkBytes + itemJson.length > CHUNK_BYTES) {
        const idx = String(chunkIdx++).padStart(3, '0')
        files.set(`${stepId}/${idx}`, writeDataFile(dir, `${stepId}-${idx}`, JSON.stringify(chunk, null, 2)))
        chunk = []
        chunkBytes = 0
      }
      chunk.push(item)
      chunkBytes += itemJson.length
    }

    if (chunk.length > 0) {
      if (chunkIdx === 1) {
        files.set(stepId, writeDataFile(dir, stepId, JSON.stringify(chunk, null, 2)))
      } else {
        const idx = String(chunkIdx).padStart(3, '0')
        files.set(`${stepId}/${idx}`, writeDataFile(dir, `${stepId}-${idx}`, JSON.stringify(chunk, null, 2)))
      }
    }
  }

  return { dir, files }
}

/** Steps to skip for the observer — reference data, not actionable. */
const OBSERVER_SKIP_STEPS = new Set(['clusters'])

/** @internal Exported for testing. */
export function getObservableSteps(
  data: Record<string, unknown>,
  steps: RecipeStep[],
): Array<{ stepId: string; data: unknown }> {
  const stepMap = new Map(steps.map(s => [s.id, s]))
  const observable: Array<{ stepId: string; data: unknown }> = []

  for (const [stepId, stepData] of Object.entries(data)) {
    if (stepId === '_fallbackNotes') continue

    // Skip known reference steps
    const step = stepMap.get(stepId)
    if (step && OBSERVER_SKIP_STEPS.has(stepId)) continue
    if (step && isAgentStep(step)) continue

    // Skip fallback results
    if (typeof stepData === 'object' && stepData !== null && (stepData as Record<string, unknown>)._fallback) continue

    observable.push({ stepId, data: stepData })
  }

  return observable
}

/**
 * Spawn parallel haiku calls to observe recipe data sections.
 * Each section gets its own independent haiku call with inline data.
 * Observations are pushed into the provided array as they complete.
 * Failures are silently ignored (the observer is non-critical).
 */
function spawnObserverCalls(
  data: Record<string, unknown>,
  steps: RecipeStep[],
  bullets: string[],
  cwd?: string,
): Promise<void> {
  const sections = getObservableSteps(data, steps)
  if (sections.length === 0) return Promise.resolve()

  // Observer always uses claude/haiku — skip if claude isn't available
  try { execSync('which claude', { stdio: 'ignore' }) } catch { return Promise.resolve() }

  const systemPrompt = 'You are scanning AIXBT crypto intelligence data. Respond with ONE short sentence (max 100 characters). Focus on: what projects or signals stand out, risk events (exploits, hacks, whale exits), or unusual patterns. Ignore momentum scores and price data. No preamble, no labels, no step names.'

  const promises = sections.map(({ stepId, data: sectionData }) => {
    return new Promise<void>((resolve) => {
      const json = JSON.stringify(sectionData, null, 2)
      const prompt = `<data step="${stepId}">\n${json}\n</data>\n\nOne-line observation about this ${stepId} data:`

      const args = [
        '-p',
        '--model', 'haiku',
        '--output-format', 'json',
        '--tools', '',
        '--append-system-prompt', systemPrompt,
      ]

      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        ...(cwd ? { cwd } : {}),
      })

      // Pipe prompt via stdin
      if (child.stdin) {
        child.stdin.write(prompt)
        child.stdin.end()
      }

      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })

      child.on('close', () => {
        try {
          const parsed = JSON.parse(stdout) as { result?: string }
          const text = (parsed.result ?? stdout).trim()
          if (text) {
            // Strip stepId prefix that haiku sometimes echoes back (e.g. "market_context: ...")
            const cleaned = text.replace(new RegExp(`^${stepId}:\\s*`, 'i'), '')
            bullets.push(cleaned.length > 400 ? cleaned.slice(0, 400) : cleaned)
          }
        } catch { /* ignore parse failures */ }
        resolve()
      })
      child.on('error', () => resolve())
    })
  })

  return Promise.all(promises).then(() => {})
}

/** Invoke the agent for final analysis. Streams output to stdout. */
export async function invokeAgentForAnalysis(
  adapter: AgentAdapter,
  result: RecipeComplete,
  opts?: { allowedTools?: string[]; recipeSteps?: RecipeStep[]; observe?: boolean },
): Promise<void> {
  // Write temp files into a single directory for retrospection
  const { dir: dataDir, files: dataFiles } = writeDataFiles(result.data)

  // Show DATA label with path
  process.stderr.write(`  ${chalk.dim('↓')}\n`)
  process.stderr.write(`${chalk.hex('#5ba8a0')('DATA')} ${chalk.dim(dataDir)}\n`)

  // Create isolated workdir with AIXBT CLAUDE.md (avoids inheriting user's project CLAUDE.md)
  const agentWorkdir = createAgentWorkdir()

  const useStdin = adapter.supportsStdin

  // Build prompt: inline via stdin if supported, otherwise file-read prompt
  const stdinData = useStdin ? buildInlinePromptForAnalysis(result) : undefined
  const fileReadPrompt = useStdin ? '' : buildPromptForAnalysis(result, dataFiles)

  // Spawn parallel haiku observer calls (non-blocking, fire-and-forget)
  const observerBullets: string[] = []
  const observerDone = (opts?.observe !== false && opts?.recipeSteps)
    ? spawnObserverCalls(result.data, opts.recipeSteps, observerBullets, agentWorkdir)
    : Promise.resolve()

  try {
    const invocation = adapter.buildInvocation({
      dataFile: '',
      prompt: fileReadPrompt,
      streaming: true,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      allowedTools: opts?.allowedTools,
      useStdin,
    })

    const env = { ...invocation.env }
    await streamAgentAnalysis(adapter, invocation.args, env, observerBullets, stdinData, agentWorkdir)
  } finally {
    await observerDone
  }
}

/** Invoke the agent for final analysis and return the text (no streaming display). */
export async function captureAgentAnalysis(
  adapter: AgentAdapter,
  result: RecipeComplete,
  opts?: { allowedTools?: string[] },
): Promise<{ text: string; dataDir: string }> {
  const { dir: dataDir, files: dataFiles } = writeDataFiles(result.data)

  try {
    const prompt = buildPromptForAnalysis(result, dataFiles)

    const invocation = adapter.buildInvocation({
      dataFile: '',
      prompt,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      allowedTools: opts?.allowedTools,
    })

    const stdout = await spawnAgent(adapter, invocation.args, invocation.env)
    return { text: adapter.parseResult(stdout), dataDir }
  } catch (err) {
    // Clean up on failure only — on success, caller owns the files
    for (const file of dataFiles.values()) cleanupTempFile(file)
    throw err
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** @internal Exported for testing. */
export function fmtTokens(input: number, output: number, thinking?: number): string {
  const f = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  const parts: string[] = []
  if (input > 0) parts.push(`${f(input)} in`)
  if (thinking && thinking > 0) parts.push(`${f(thinking)} thinking`)
  if (output > 0) parts.push(`${f(output)} out`)
  return parts.join(' · ')
}

/** @internal Exported for testing. */
export interface StreamState {
  phase: 'waiting' | 'processing' | 'output'
  msgTextBuffer: string
  totalInput: number
  totalOutput: number
  totalThinking: number
}

/** @internal Exported for testing. */
export function processClaudeEvent(
  event: Record<string, unknown>,
  state: StreamState,
): void {
  // Final result event — accurate totals
  if (event.type === 'result') {
    const usage = event.usage as Record<string, number> | undefined
    if (usage) {
      state.totalInput = (usage.input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0)
      state.totalOutput = usage.output_tokens ?? 0
    }
    return
  }

  if (event.type !== 'stream_event') return
  const inner = event.event as Record<string, unknown> | undefined
  if (!inner) return

  // Token tracking
  if (inner.type === 'message_start') {
    const msg = inner.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, number> | undefined
    if (usage) {
      state.totalInput = (usage.input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0)
    }
  }
  if (inner.type === 'message_delta') {
    const usage = inner.usage as { output_tokens?: number } | undefined
    if (usage?.output_tokens) state.totalOutput += usage.output_tokens
  }

  if (inner.type === 'content_block_delta') {
    const delta = inner.delta as Record<string, unknown> | undefined
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      state.totalThinking += delta.thinking.length
    } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      if (state.phase === 'output') {
        process.stdout.write(delta.text)
      } else {
        state.msgTextBuffer += delta.text
      }
    }
  }
}

/** Process a Codex JSONL event line. */
function processCodexEvent(
  event: Record<string, unknown>,
  state: StreamState,
): void {
  if (event.type === 'turn.completed') {
    const usage = event.usage as Record<string, number> | undefined
    if (usage) {
      state.totalInput = (usage.input_tokens ?? 0)
        + (usage.cached_input_tokens ?? 0)
      state.totalOutput = usage.output_tokens ?? 0
    }
    return
  }

  // Buffer latest agent message text (last one becomes final output)
  if (event.type === 'item.completed') {
    const item = event.item as Record<string, unknown> | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      state.msgTextBuffer = item.text
    }
  }
}

function streamAgentAnalysis(
  adapter: AgentAdapter,
  args: string[],
  env?: Record<string, string>,
  observerBullets?: string[],
  stdinData?: string,
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.binary, args, {
      stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      ...(cwd ? { cwd } : {}),
    })

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData)
      child.stdin.end()
    }

    // Show arrow connector + agent name (AIXBT line already shown by caller)
    const agentColor = AGENT_COLORS[adapter.binary] ?? '#888888'
    const agentName = chalk.hex(agentColor)(adapter.binary.toUpperCase())
    process.stderr.write(`  ${chalk.dim('↓')}\n`)
    process.stderr.write(`${agentName}\n`)

    const state: StreamState = {
      phase: 'waiting',
      msgTextBuffer: '',
      totalInput: 0,
      totalOutput: 0,
      totalThinking: 0,
    }
    let stderrOutput = ''

    const processEvent = adapter.streamFormat === 'codex' ? processCodexEvent : processClaudeEvent

    let frame = 0
    let observerDrained = 0
    const spinner = setInterval(() => {
      if (state.phase === 'waiting' || state.phase === 'processing') {
        // Drain any observer bullets that have arrived
        if (observerBullets) {
          while (observerDrained < observerBullets.length) {
            showStatusBullet(observerBullets[observerDrained++])
          }
        }
        // Estimate thinking tokens (~4 chars per token)
        const thinkingTokens = state.totalThinking > 0 ? Math.ceil(state.totalThinking / 4) : 0
        const tokens = fmtTokens(state.totalInput, state.totalOutput, thinkingTokens)
        const suffix = tokens ? ` ${chalk.dim(tokens)}` : ''
        const label = state.totalThinking > 0 ? 'reasoning...' : 'thinking...'
        process.stderr.write(`\r  ${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${label}${suffix}`)
      }
    }, 80)

    function showStatusBullet(text: string) {
      const line = text.trim().replace(/:$/, '')
      if (!line) return
      process.stderr.write('\r\x1b[K')
      const cols = process.stderr.columns || 80
      const prefix = '  • '
      const indent = '    '
      const wrapped = wrapIndented(chalk.dim(line), indent, prefix.length, cols)
      process.stderr.write(`  ${chalk.dim('•')} ${wrapped}\n`)
      state.phase = 'processing'
    }

    let streamBuffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      streamBuffer += chunk.toString()
      const lines = streamBuffer.split('\n')
      streamBuffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          processEvent(event, state)
        } catch {
          // skip unparseable lines
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => { stderrOutput += chunk.toString() })

    child.on('error', (err) => {
      clearInterval(spinner)
      reject(new CliError(
        `Failed to spawn ${adapter.name}: ${err.message}`,
        'AGENT_SPAWN_FAILED',
      ))
    })

    child.on('close', (code) => {
      clearInterval(spinner)
      // Remaining buffered text is the final output.
      if (state.msgTextBuffer && state.phase !== 'output') {
        const text = state.msgTextBuffer.trim()
        if (text) {
          process.stderr.write('\r\x1b[K')
          const thinkingTokens = state.totalThinking > 0 ? Math.ceil(state.totalThinking / 4) : 0
          const tokens = fmtTokens(state.totalInput, state.totalOutput, thinkingTokens)
          const tokenSuffix = tokens ? ` ${chalk.dim(tokens)}` : ''
          process.stderr.write(`\n${fmt.tag('OUTPUT', BRAND_PURPLE)}${tokenSuffix}\n\n`)
          process.stdout.write(state.msgTextBuffer)
          state.phase = 'output'
        }
      }

      if (state.phase === 'output') process.stdout.write('\n')
      if (state.phase === 'waiting' || state.phase === 'processing') process.stderr.write('\r\x1b[K')

      if (code !== 0) {
        const detail = stderrOutput.trim() || `exit code ${code}`
        reject(new CliError(
          `${adapter.name} exited with error: ${detail}`,
          'AGENT_EXECUTION_FAILED',
        ))
        return
      }
      resolve()
    })
  })
}
