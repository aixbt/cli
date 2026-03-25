import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import {
  writeDataFiles,
  getObservableSteps,
  buildInlinePromptForAnalysis,
  fmtTokens,
  processClaudeEvent,
} from '../../../src/lib/agents/invoke.js'
import type { StreamState } from '../../../src/lib/agents/invoke.js'
import type { RecipeComplete, RecipeStep } from '../../../src/types.js'

// -- fmtTokens --

describe('fmtTokens', () => {
  it('formats input only', () => {
    expect(fmtTokens(1500, 0)).toBe('1.5k in')
  })

  it('formats input and output', () => {
    expect(fmtTokens(200, 50)).toBe('200 in · 50 out')
  })

  it('formats with thinking tokens', () => {
    expect(fmtTokens(100000, 500, 2000)).toBe('100.0k in · 2.0k thinking · 500 out')
  })

  it('returns empty string when all zero', () => {
    expect(fmtTokens(0, 0)).toBe('')
  })

  it('skips thinking when zero', () => {
    expect(fmtTokens(1000, 100, 0)).toBe('1.0k in · 100 out')
  })
})

// -- writeDataFiles --

describe('writeDataFiles', () => {
  it('writes all files into a single directory', () => {
    const data = {
      signals: [{ id: 1 }, { id: 2 }],
      market_context: { btc: 50000 },
    }

    const { dir, files } = writeDataFiles(data)

    expect(dir).toMatch(/aixbt-/)
    expect(existsSync(dir)).toBe(true)

    // All files should be in the same directory
    const dirFiles = readdirSync(dir)
    expect(dirFiles.length).toBe(2)
    expect(files.size).toBe(2)

    // Verify file contents
    const marketFile = files.get('market_context')!
    expect(marketFile).toContain(dir)
    const content = JSON.parse(readFileSync(marketFile, 'utf-8'))
    expect(content).toEqual({ btc: 50000 })
  })

  it('chunks large arrays by byte size', () => {
    // Create array items that are ~15KB each so two items exceed 30KB chunk limit
    const bigItem = { data: 'x'.repeat(15_000) }
    const data = {
      signals: [bigItem, bigItem, bigItem],
    }

    const { files } = writeDataFiles(data)

    // Should produce multiple chunked files
    expect(files.size).toBeGreaterThan(1)
    const keys = [...files.keys()]
    expect(keys.some(k => k.startsWith('signals/'))).toBe(true)
  })

  it('does not chunk small arrays', () => {
    const data = {
      signals: [{ id: 1 }, { id: 2 }, { id: 3 }],
    }

    const { files } = writeDataFiles(data)

    expect(files.size).toBe(1)
    expect(files.has('signals')).toBe(true)
  })

  it('handles non-array data', () => {
    const data = {
      market_context: { btc: 50000, eth: 3000 },
    }

    const { files } = writeDataFiles(data)

    expect(files.size).toBe(1)
    expect(files.has('market_context')).toBe(true)
  })
})

// -- getObservableSteps --

describe('getObservableSteps', () => {
  const makeApiStep = (id: string): RecipeStep => ({ id, type: 'api', action: 'signals:list' }) as RecipeStep
  const makeAgentStep = (id: string): RecipeStep => ({ id, type: 'agent', instructions: '', returns: {}, context: [] }) as RecipeStep

  it('includes API steps with data', () => {
    const steps: RecipeStep[] = [makeApiStep('signals'), makeApiStep('projects')]
    const data = { signals: [1, 2], projects: [3, 4] }

    const result = getObservableSteps(data, steps)

    expect(result).toHaveLength(2)
    expect(result.map(r => r.stepId)).toEqual(['signals', 'projects'])
  })

  it('skips clusters step', () => {
    const steps: RecipeStep[] = [makeApiStep('signals'), makeApiStep('clusters')]
    const data = { signals: [1], clusters: [2] }

    const result = getObservableSteps(data, steps)

    expect(result).toHaveLength(1)
    expect(result[0].stepId).toBe('signals')
  })

  it('skips agent steps', () => {
    const steps: RecipeStep[] = [makeApiStep('signals'), makeAgentStep('picks')]
    const data = { signals: [1], picks: [2] }

    const result = getObservableSteps(data, steps)

    expect(result).toHaveLength(1)
    expect(result[0].stepId).toBe('signals')
  })

  it('skips _fallbackNotes', () => {
    const steps: RecipeStep[] = [makeApiStep('signals')]
    const data = { signals: [1], _fallbackNotes: ['note'] }

    const result = getObservableSteps(data, steps)

    expect(result).toHaveLength(1)
    expect(result[0].stepId).toBe('signals')
  })

  it('skips fallback results', () => {
    const steps: RecipeStep[] = [makeApiStep('signals'), makeApiStep('prices')]
    const data = { signals: [1], prices: { _fallback: true, message: 'no data' } }

    const result = getObservableSteps(data, steps)

    expect(result).toHaveLength(1)
    expect(result[0].stepId).toBe('signals')
  })

  it('includes steps not in recipe definition (extra data)', () => {
    const steps: RecipeStep[] = [makeApiStep('signals')]
    const data = { signals: [1], extra: [2] }

    const result = getObservableSteps(data, steps)

    // 'extra' has no matching step definition so skip filters don't apply
    expect(result).toHaveLength(2)
  })
})

// -- buildInlinePromptForAnalysis --

describe('buildInlinePromptForAnalysis', () => {
  const makeResult = (overrides?: Partial<RecipeComplete>): RecipeComplete => ({
    status: 'complete',
    recipe: 'test_recipe',
    version: '1',
    timestamp: '2025-01-01',
    data: { signals: [{ id: 1 }], market_context: { btc: 50000 } },
    tokenCount: 1000,
    ...overrides,
  })

  it('embeds data as XML sections', () => {
    const result = makeResult()
    const prompt = buildInlinePromptForAnalysis(result)

    expect(prompt).toContain('<data step="signals">')
    expect(prompt).toContain('</data>')
    expect(prompt).toContain('<data step="market_context">')
    expect(prompt).toContain('"btc": 50000')
  })

  it('excludes _fallbackNotes from data sections', () => {
    const result = makeResult({
      data: { signals: [1], _fallbackNotes: ['note'] },
    })
    const prompt = buildInlinePromptForAnalysis(result)

    expect(prompt).toContain('<data step="signals">')
    expect(prompt).not.toContain('<data step="_fallbackNotes">')
    // But fallbackNotes should appear in its own block
    expect(prompt).toContain('<fallback-notes>')
  })

  it('includes analysis instructions when present', () => {
    const result = makeResult({
      analysis: { instructions: 'Focus on momentum signals.' },
    })
    const prompt = buildInlinePromptForAnalysis(result)

    expect(prompt).toContain('<instructions>')
    expect(prompt).toContain('Focus on momentum signals.')
    expect(prompt).toContain('</instructions>')
  })

  it('includes output format when present', () => {
    const result = makeResult({
      analysis: { instructions: 'Analyze', output: 'Markdown table' },
    })
    const prompt = buildInlinePromptForAnalysis(result)

    expect(prompt).toContain('<output-format>')
    expect(prompt).toContain('Markdown table')
  })

  it('includes context hints when present', () => {
    const result = makeResult({
      contextHints: ['User is tracking DeFi projects'],
    })
    const prompt = buildInlinePromptForAnalysis(result)

    expect(prompt).toContain('<context>')
    expect(prompt).toContain('User is tracking DeFi projects')
  })
})

// -- processClaudeEvent --

describe('processClaudeEvent', () => {
  function makeState(overrides?: Partial<StreamState>): StreamState {
    return {
      phase: 'waiting',
      msgTextBuffer: '',
      totalInput: 0,
      totalOutput: 0,
      totalThinking: 0,
      ...overrides,
    }
  }

  it('tracks input tokens from message_start', () => {
    const state = makeState()

    processClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          usage: { input_tokens: 1000, cache_read_input_tokens: 500 },
        },
      },
    }, state)

    expect(state.totalInput).toBe(1500)
  })

  it('tracks thinking delta characters', () => {
    const state = makeState()

    processClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Let me analyze this data carefully.' },
      },
    }, state)

    expect(state.totalThinking).toBe(35)
  })

  it('accumulates text_delta in buffer when not in output phase', () => {
    const state = makeState({ phase: 'waiting' })

    processClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Reading signals' },
      },
    }, state)

    expect(state.msgTextBuffer).toBe('Reading signals')
  })

  it('does not extract bullets from text buffer', () => {
    const state = makeState({ phase: 'waiting' })

    processClaudeEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '• First observation\n- List item\n' },
      },
    }, state)

    // All text stays in buffer — no bullet extraction from opus
    expect(state.msgTextBuffer).toBe('• First observation\n- List item\n')
  })

  it('updates totals from result event', () => {
    const state = makeState()

    processClaudeEvent({
      type: 'result',
      usage: {
        input_tokens: 5000,
        cache_read_input_tokens: 150000,
        output_tokens: 2000,
      },
    }, state)

    expect(state.totalInput).toBe(155000)
    expect(state.totalOutput).toBe(2000)
  })

  it('ignores non-stream events', () => {
    const state = makeState()

    processClaudeEvent({ type: 'unknown_event' }, state)

    expect(state.totalInput).toBe(0)
  })
})
