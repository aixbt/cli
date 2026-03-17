import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentAdapter } from './types.js'
import type { RecipeAwaitingAgent, RecipeComplete } from '../../types.js'
import { CliError } from '../errors.js'

function writeTempFile(prefix: string, data: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aixbt-'))
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
      systemPrompt: result.analysis?.instructions
        ? 'You are analyzing AIXBT recipe output. Follow the analysis instructions precisely.'
        : undefined,
    })

    // Stream output directly to the user's terminal
    await spawnAgent(adapter, invocation.args, invocation.env, { inherit: true })
  } finally {
    cleanupTempFile(dataFile)
  }
}
