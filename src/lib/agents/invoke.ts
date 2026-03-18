import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import type { AgentAdapter } from './types.js'
import type { RecipeAwaitingAgent, RecipeComplete } from '../../types.js'
import { CliError } from '../errors.js'
import { getConfigDir } from '../config.js'
import { fmt } from '../output.js'

const AGENT_LABEL_BG = '#e8723a'
const OUTPUT_LABEL_BG = '#4a7af5'

function writeTempFile(prefix: string, data: string): string {
  const tmpBase = join(getConfigDir(), 'tmp')
  mkdirSync(tmpBase, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(tmpBase, 'aixbt-'))
  const file = join(dir, `${prefix}.json`)
  writeFileSync(file, data, { mode: 0o600 })
  return file
}

function cleanupTempFile(file: string): void {
  try { unlinkSync(file) } catch { /* ignore */ }
}

function buildPromptForStep(result: RecipeAwaitingAgent, dataFile: string): string {
  return [
    `Read the AIXBT recipe data from ${dataFile}`,
    '',
    `<task>`,
    result.task,
    `</task>`,
    '',
    `<instructions>`,
    result.instructions,
    `</instructions>`,
    '',
    `<returns>`,
    `Respond with a JSON object matching this schema:`,
    JSON.stringify(result.returns, null, 2),
    `</returns>`,
  ].join('\n')
}

function buildPromptForAnalysis(result: RecipeComplete, dataFile: string): string {
  const parts = [
    `Read the AIXBT recipe data from ${dataFile}`,
    '',
  ]

  if (result.analysis?.task) {
    parts.push(`<task>`, result.analysis.task, `</task>`, '')
  }

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

/** Invoke the agent for an intermediate recipe step. Returns parsed JSON response. */
export async function invokeAgentForStep(
  adapter: AgentAdapter,
  result: RecipeAwaitingAgent,
): Promise<Record<string, unknown>> {
  const dataFile = writeTempFile('recipe-data', JSON.stringify(result.data, null, 2))
  let schemaFile: string | undefined

  try {
    const prompt = buildPromptForStep(result, dataFile)

    if (adapter.supportsJsonSchema) {
      schemaFile = writeTempFile('schema', JSON.stringify(result.returns))
    }

    const invocation = adapter.buildInvocation({
      dataFile,
      prompt,
      systemPrompt: 'You are analyzing AIXBT recipe output. Follow the instructions precisely. Return only valid JSON.',
      jsonSchemaFile: schemaFile,
    })

    const stdout = await spawnAgent(adapter, invocation.args, invocation.env)
    const text = adapter.parseResult(stdout)

    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      // Try extracting JSON from code fences or first {...} block
      const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (fenceMatch) {
        return JSON.parse(fenceMatch[1]) as Record<string, unknown>
      }
      const braceMatch = text.match(/\{[\s\S]*\}/)
      if (braceMatch) {
        return JSON.parse(braceMatch[0]) as Record<string, unknown>
      }
      throw new CliError(
        `${adapter.name} returned unparseable response for step "${result.step}". Raw output:\n${text.slice(0, 500)}`,
        'AGENT_PARSE_FAILED',
      )
    }
  } finally {
    cleanupTempFile(dataFile)
    if (schemaFile) cleanupTempFile(schemaFile)
  }
}

/** Invoke the agent for final analysis. Streams output to stdout. */
export async function invokeAgentForAnalysis(
  adapter: AgentAdapter,
  result: RecipeComplete,
): Promise<void> {
  const dataFile = writeTempFile('recipe-data', JSON.stringify(result.data, null, 2))

  try {
    const prompt = buildPromptForAnalysis(result, dataFile)

    const invocation = adapter.buildInvocation({
      dataFile,
      prompt,
      streaming: true,
      systemPrompt: result.analysis?.instructions
        ? 'You are analyzing AIXBT recipe output. Follow the analysis instructions precisely.'
        : undefined,
    })

    await streamAgentAnalysis(adapter, invocation.args, invocation.env)
  } finally {
    cleanupTempFile(dataFile)
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function streamAgentAnalysis(
  adapter: AgentAdapter,
  args: string[],
  env?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...env },
    })

    let buffer = ''
    let phase: 'waiting' | 'thinking' | 'output' = 'waiting'
    let seenToolUse = false
    let msgHasToolUse = false
    let msgText = ''

    // Spinner while waiting for first output
    let frame = 0
    const spinner = setInterval(() => {
      if (phase === 'waiting') {
        process.stderr.write(`\r${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} Thinking...`)
      }
    }, 80)

    function showThinkingBullet(text: string) {
      const trimmed = text.trim()
      if (!trimmed) return
      if (phase === 'waiting') {
        clearInterval(spinner)
        process.stderr.write('\r\x1b[K')
        process.stderr.write(`${fmt.tag(` ${adapter.binary.toUpperCase()} `, AGENT_LABEL_BG)}\n`)
        phase = 'thinking'
      }
      let line = trimmed.split('\n')[0]
      if (line.length > 100) line = line.slice(0, 97) + '...'
      process.stderr.write(`  ${chalk.dim('•')} ${chalk.dim(line)}\n`)
    }

    function startOutput() {
      if (phase !== 'output') {
        if (phase === 'waiting') {
          clearInterval(spinner)
          process.stderr.write('\r\x1b[K')
        }
        process.stderr.write(`${fmt.tag(' OUTPUT ', OUTPUT_LABEL_BG)}\n`)
        phase = 'output'
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          if (event.type !== 'stream_event') continue
          const inner = event.event as Record<string, unknown> | undefined
          if (!inner) continue

          switch (inner.type) {
            case 'message_start':
              msgHasToolUse = false
              msgText = ''
              break

            case 'content_block_start': {
              const block = inner.content_block as Record<string, unknown> | undefined
              if (block?.type === 'tool_use') {
                msgHasToolUse = true
                seenToolUse = true
                if (msgText) {
                  showThinkingBullet(msgText)
                  msgText = ''
                }
              }
              break
            }

            case 'content_block_delta': {
              const delta = inner.delta as { type?: string; text?: string } | undefined
              if (delta?.type === 'text_delta' && delta.text) {
                if (msgHasToolUse) {
                  // Known thinking message — buffer for bullet
                  msgText += delta.text
                } else if (seenToolUse) {
                  // Previous messages had tool_use, this one doesn't — stream as output
                  startOutput()
                  process.stdout.write(delta.text)
                } else {
                  // First message, undecided — buffer until we know
                  msgText += delta.text
                }
              }
              break
            }

            case 'message_stop':
              if (msgHasToolUse) {
                if (msgText) {
                  showThinkingBullet(msgText)
                  msgText = ''
                }
              } else if (msgText) {
                startOutput()
                process.stdout.write(msgText)
                msgText = ''
              }
              break
          }
        } catch {
          // skip unparseable lines
        }
      }
    })

    child.on('error', (err) => {
      clearInterval(spinner)
      reject(new CliError(
        `Failed to spawn ${adapter.name}: ${err.message}`,
        'AGENT_SPAWN_FAILED',
      ))
    })

    child.on('close', (code) => {
      clearInterval(spinner)
      if (phase === 'output') process.stdout.write('\n')
      if (phase === 'waiting') process.stderr.write('\r\x1b[K')
      if (code !== 0) {
        reject(new CliError(
          `${adapter.name} exited with error: exit code ${code}`,
          'AGENT_EXECUTION_FAILED',
        ))
        return
      }
      resolve()
    })
  })
}
