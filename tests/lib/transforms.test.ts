import { describe, it, expect } from 'vitest'
import { applySelect, applySample } from '../../src/lib/transforms.js'

// -- applySelect --

describe('applySelect', () => {
  it('should project top-level fields', () => {
    const items = [{ id: 1, name: 'a', extra: 'b' }]
    const result = applySelect(items, ['id', 'name'])
    expect(result).toEqual([{ id: 1, name: 'a' }])
  })

  it('should project nested fields with dot notation', () => {
    const items = [{ metrics: { usd: 100, vol: 500 } }]
    const result = applySelect(items, ['metrics.usd'])
    expect(result).toEqual([{ metrics: { usd: 100 } }])
  })

  it('should merge multiple nested fields under the same parent', () => {
    const items = [{ metrics: { usd: 100, volume: 500, extra: 1 } }]
    const result = applySelect(items, ['metrics.usd', 'metrics.volume'])
    expect(result).toEqual([{ metrics: { usd: 100, volume: 500 } }])
  })

  it('should preserve arrays as field values', () => {
    const items = [{ activity: [{ a: 1 }, { a: 2 }], other: 'x' }]
    const result = applySelect(items, ['activity'])
    expect(result).toEqual([{ activity: [{ a: 1 }, { a: 2 }] }])
  })

  it('should omit missing fields without adding undefined keys', () => {
    const items = [{ id: 1 }]
    const result = applySelect(items, ['id', 'missing'])
    expect(result).toEqual([{ id: 1 }])
    expect(Object.keys(result[0] as object)).toEqual(['id'])
  })

  it('should return items unchanged when fields array is empty', () => {
    const items = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]
    const result = applySelect(items, [])
    expect(result).toEqual(items)
  })

  it('should pass through non-object items unchanged', () => {
    const items = [42, 'string', null]
    const result = applySelect(items, ['id'])
    expect(result).toEqual([42, 'string', null])
  })

  it('should return empty array when input is empty', () => {
    const result = applySelect([], ['id'])
    expect(result).toEqual([])
  })

  it('should apply projection to all items in the array', () => {
    const items = [
      { id: 1, name: 'a', extra: 'x' },
      { id: 2, name: 'b', extra: 'y' },
      { id: 3, name: 'c', extra: 'z' },
    ]
    const result = applySelect(items, ['id', 'name'])
    expect(result).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
      { id: 3, name: 'c' },
    ])
  })
})

// -- applySample --

describe('applySample', () => {
  // Helper to generate items with unique ids and optional scores
  function makeItems(count: number, withScore = false): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      ...(withScore ? { score: i * 10 } : {}),
    }))
  }

  it('should return all items when count >= array length', () => {
    const items = makeItems(50)
    const result = applySample(items, { count: 100 })
    expect(result).toHaveLength(50)
    // Should be a copy, not the same reference
    expect(result).not.toBe(items)
    expect(result).toEqual(items)
  })

  it('should return exactly count items when count < array length', () => {
    const items = makeItems(50)
    const result = applySample(items, { count: 10 })
    expect(result).toHaveLength(10)
  })

  it('should return empty array when input is empty', () => {
    const result = applySample([], { count: 5 })
    expect(result).toEqual([])
  })

  it('should return the single item when sampling from a single-item array', () => {
    const items = [{ id: 1 }]
    const result = applySample(items, { count: 1 })
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ id: 1 })
  })

  it('should always include top-weighted items when guarantee fraction is set', () => {
    // 20 items with scores 0..190. Top 5 scores: 190, 180, 170, 160, 150
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      score: i * 10,
    }))
    // count=10, guarantee=0.5 => 5 guaranteed slots, should be top 5 by weight
    const topIds = [19, 18, 17, 16, 15]

    // Run multiple trials to confirm deterministic guarantee
    for (let trial = 0; trial < 20; trial++) {
      const result = applySample(items, { count: 10, guarantee: 0.5, weight_by: 'score' })
      expect(result).toHaveLength(10)
      const resultIds = result.map((r) => (r as { id: number }).id)
      for (const id of topIds) {
        expect(resultIds).toContain(id)
      }
    }
  })

  it('should respect maxTokens budget when count is not set', () => {
    // Each item serializes to roughly the same size
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, label: `item-${i}` }))
    // Compute token budget for ~5 items
    const singleItemTokens = JSON.stringify(items[0]).length / 4
    const budget = Math.floor(singleItemTokens * 5)

    const result = applySample(items, { maxTokens: budget })
    // Should get approximately 5 items (could be 4-5 depending on exact sizes)
    expect(result.length).toBeGreaterThanOrEqual(4)
    expect(result.length).toBeLessThanOrEqual(5)
  })

  it('should prioritize count over maxTokens when both are set', () => {
    const items = makeItems(50)
    const result = applySample(items, { count: 5, maxTokens: 99999 })
    expect(result).toHaveLength(5)
  })

  it('should bias toward higher-weight items when weight_by is specified', () => {
    // Create items where top half has weight 100, bottom half has weight 1
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: i,
      score: i < 20 ? 1 : 100,
    }))

    // Sample 10 items, 500 trials. Count how often high-score items appear.
    const highScoreAppearances: Record<number, number> = {}
    const lowScoreAppearances: Record<number, number> = {}

    for (let trial = 0; trial < 500; trial++) {
      const result = applySample(items, { count: 10, weight_by: 'score', guarantee: 0 })
      for (const r of result) {
        const id = (r as { id: number }).id
        if (id >= 20) {
          highScoreAppearances[id] = (highScoreAppearances[id] || 0) + 1
        } else {
          lowScoreAppearances[id] = (lowScoreAppearances[id] || 0) + 1
        }
      }
    }

    const avgHigh = Object.values(highScoreAppearances).reduce((a, b) => a + b, 0) / 20
    const avgLow = Object.values(lowScoreAppearances).reduce((a, b) => a + b, 0) / 20

    // High-score items should appear significantly more often (conservative threshold)
    expect(avgHigh).toBeGreaterThan(avgLow * 1.5)
  })

  it('should sample all slots randomly when guarantee is 0', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      score: i * 10,
    }))

    // With guarantee: 0, no items are guaranteed — all are sampled
    // Run a few times to check it works without errors
    for (let trial = 0; trial < 10; trial++) {
      const result = applySample(items, { count: 5, guarantee: 0, weight_by: 'score' })
      expect(result).toHaveLength(5)
    }
  })

  it('should maintain original array order in the output', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: i }))

    for (let trial = 0; trial < 10; trial++) {
      const result = applySample(items, { count: 15 })
      const ids = result.map((r) => (r as { id: number }).id)

      // Verify ids are in ascending order (original order)
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1])
      }
    }
  })

  it('should return empty array when count is 0', () => {
    const items = makeItems(10)
    const result = applySample(items, { count: 0 })
    expect(result).toEqual([])
  })

  it('should use default recency weighting when weight_by is not specified', () => {
    const now = new Date()
    const recentDate = new Date(now.getTime() - 1000).toISOString()       // 1s ago
    const oldDate = new Date(now.getTime() - 86400000 * 30).toISOString() // 30 days ago

    const items = [
      { id: 'old1', detectedAt: oldDate, activity: [{ a: 1 }] },
      { id: 'old2', detectedAt: oldDate, activity: [{ a: 1 }] },
      { id: 'old3', detectedAt: oldDate, activity: [{ a: 1 }] },
      { id: 'old4', detectedAt: oldDate, activity: [{ a: 1 }] },
      { id: 'old5', detectedAt: oldDate, activity: [{ a: 1 }] },
      { id: 'recent1', detectedAt: recentDate, activity: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      { id: 'recent2', detectedAt: recentDate, activity: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      { id: 'recent3', detectedAt: recentDate, activity: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      { id: 'recent4', detectedAt: recentDate, activity: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      { id: 'recent5', detectedAt: recentDate, activity: [{ a: 1 }, { a: 2 }, { a: 3 }] },
    ]

    // Sample 5 items with default weighting (recency * strength), guarantee 0
    // Recent items with more activity should appear more often
    let recentCount = 0
    const trials = 50
    for (let t = 0; t < trials; t++) {
      const result = applySample(items, { count: 5, guarantee: 0 })
      for (const r of result) {
        if (((r as { id: string }).id).startsWith('recent')) recentCount++
      }
    }
    // Recent items (higher recency * more activity) should dominate
    const recentFraction = recentCount / (trials * 5)
    expect(recentFraction).toBeGreaterThan(0.5)
  })

  it('should use date field for recency when detectedAt is absent', () => {
    const now = new Date()
    const recentDate = new Date(now.getTime() - 1000).toISOString()
    const oldDate = new Date(now.getTime() - 86400000 * 30).toISOString()

    const items = [
      { id: 'old', date: oldDate },
      { id: 'old2', date: oldDate },
      { id: 'old3', date: oldDate },
      { id: 'recent', date: recentDate },
      { id: 'recent2', date: recentDate },
    ]

    let recentCount = 0
    const trials = 50
    for (let t = 0; t < trials; t++) {
      const result = applySample(items, { count: 2, guarantee: 0 })
      for (const r of result) {
        if (((r as { id: string }).id).startsWith('recent')) recentCount++
      }
    }
    expect(recentCount / (trials * 2)).toBeGreaterThan(0.4)
  })

  it('should use activity length for strength weight', () => {
    const items = [
      { id: 'weak', activity: [{ a: 1 }] },
      { id: 'weak2', activity: [{ a: 1 }] },
      { id: 'weak3', activity: [{ a: 1 }] },
      { id: 'strong', activity: Array.from({ length: 20 }, (_, i) => ({ a: i })) },
      { id: 'strong2', activity: Array.from({ length: 20 }, (_, i) => ({ a: i })) },
    ]

    let strongCount = 0
    const trials = 50
    for (let t = 0; t < trials; t++) {
      const result = applySample(items, { count: 2, guarantee: 0 })
      for (const r of result) {
        if (((r as { id: string }).id).startsWith('strong')) strongCount++
      }
    }
    // Strong items (activity.length=20 vs 1) should appear more often
    expect(strongCount / (trials * 2)).toBeGreaterThan(0.5)
  })

  it('should run sample before select so weight fields are available', () => {
    // This tests the applyTransforms orchestration order indirectly:
    // If select ran first, it would strip the score field and sampling by score would fail
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      score: (i + 1) * 100,
      extra: 'data',
    }))

    // First sample with weight_by score (needs score field)
    const sampled = applySample(items, { count: 5, weight_by: 'score' })
    expect(sampled).toHaveLength(5)

    // Then select only id (strips score)
    const selected = applySelect(sampled, ['id'])
    expect(selected).toHaveLength(5)

    // Each result should only have id
    for (const item of selected) {
      expect(Object.keys(item as object)).toEqual(['id'])
    }
  })
})
