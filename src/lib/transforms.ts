import type { SampleTransform } from '../types.js'

// -- Helpers --

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setNestedValue(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.')
  let current = target
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

// -- Select transform --

export function applySelect(items: unknown[], fields: string[]): unknown[] {
  if (fields.length === 0) return items

  return items.map((item) => {
    if (item === null || item === undefined || typeof item !== 'object') {
      return item
    }

    const projected: Record<string, unknown> = {}
    for (const field of fields) {
      const value = getNestedValue(item, field)
      if (value !== undefined) {
        if (field.includes('.')) {
          setNestedValue(projected, field, value)
        } else {
          projected[field] = value
        }
      }
    }
    return projected
  })
}

// -- Sample transform --

interface WeightedItem {
  item: unknown
  weight: number
  index: number
}

function resolveTargetCount(items: unknown[], config: SampleTransform): number {
  if (config.count !== undefined) {
    return config.count
  }

  if (config.maxTokens !== undefined) {
    let totalTokens = 0
    let count = 0
    for (const item of items) {
      const itemTokens = JSON.stringify(item).length / 4
      if (totalTokens + itemTokens > config.maxTokens && count > 0) break
      totalTokens += itemTokens
      count++
    }
    return count
  }

  return items.length
}

function computeWeights(items: unknown[], weightBy?: string): number[] {
  if (weightBy) {
    return items.map((item) => {
      const val = getNestedValue(item, weightBy)
      if (typeof val !== 'number' || isNaN(val)) return 1
      return val < 0 ? 0 : val
    })
  }

  // Default weighting: recency * strength (matching rxbt.services pattern)
  const now = Date.now()

  return items.map((item) => {
    if (item === null || item === undefined || typeof item !== 'object') {
      return 1
    }

    const obj = item as Record<string, unknown>

    // Recency weight from date fields
    const dateValue: unknown = obj.detectedAt ?? obj.date ?? obj.createdAt
    let recencyWeight = 1
    if (dateValue !== undefined) {
      const age = now - new Date(dateValue as string).getTime()
      recencyWeight = 1 / (age + 1)
    }

    // Strength weight from activity array
    let strengthWeight = 1
    if (Array.isArray(obj.activity) && obj.activity.length > 0) {
      strengthWeight = obj.activity.length
    }

    return recencyWeight * strengthWeight
  })
}

function weightedSampleWithoutReplacement(
  pool: WeightedItem[],
  count: number,
): WeightedItem[] {
  const totalWeight = pool.reduce((sum, w) => sum + w.weight, 0)

  // Zero total weight: uniform random shuffle fallback
  if (totalWeight === 0) {
    const shuffled = [...pool]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled.slice(0, count)
  }

  const selected: WeightedItem[] = []
  const remaining = [...pool]

  for (let i = 0; i < count && remaining.length > 0; i++) {
    const currentTotal = remaining.reduce((sum, w) => sum + w.weight, 0)

    if (currentTotal === 0) {
      // Floating point fallback: pick last unselected
      selected.push(remaining.pop()!)
      continue
    }

    const r = Math.random() * currentTotal
    let cumulative = 0
    let pickedIndex = remaining.length - 1 // fallback to last

    for (let j = 0; j < remaining.length; j++) {
      cumulative += remaining[j].weight
      if (r < cumulative) {
        pickedIndex = j
        break
      }
    }

    selected.push(remaining[pickedIndex])
    remaining.splice(pickedIndex, 1)
  }

  return selected
}

export function applySample(items: unknown[], config: SampleTransform): unknown[] {
  const targetCount = resolveTargetCount(items, config)

  if (targetCount >= items.length) {
    return [...items]
  }

  if (targetCount <= 0) {
    return []
  }

  const weights = computeWeights(items, config.weight_by)
  const weighted: WeightedItem[] = items.map((item, index) => ({
    item,
    weight: weights[index],
    index,
  }))

  // Guarantee top-weighted items
  const guaranteeFraction = config.guarantee ?? 0.3
  const guaranteedCount = Math.min(
    Math.ceil(targetCount * guaranteeFraction),
    items.length,
  )

  // Sort by weight descending for guaranteed selection
  const sorted = [...weighted].sort((a, b) => b.weight - a.weight)
  const guaranteed = sorted.slice(0, guaranteedCount)
  const guaranteedIndices = new Set(guaranteed.map((w) => w.index))

  // Remaining pool excludes guaranteed items
  const remainingPool = weighted.filter((w) => !guaranteedIndices.has(w.index))
  const remainingSlots = targetCount - guaranteedCount

  // Sample remaining slots
  const sampled = remainingSlots > 0
    ? weightedSampleWithoutReplacement(remainingPool, remainingSlots)
    : []

  // Combine and restore original order
  const result = [...guaranteed, ...sampled]
  result.sort((a, b) => a.index - b.index)

  return result.map((w) => w.item)
}
