import { getProvider, parseSource } from '../providers/registry.js'
import { providerRequest } from '../providers/client.js'
import type { Params } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderMeta {
  source: string
  action: string
  params: Record<string, unknown>
}

export interface FallbackEntry {
  path: string[]
  providerMeta: ProviderMeta
}

// ---------------------------------------------------------------------------
// Stage 1: Scan — find _fallback entries in server response data
// ---------------------------------------------------------------------------

export function scanForFallbacks(data: Record<string, unknown>): FallbackEntry[] {
  const entries: FallbackEntry[] = []

  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue

    if (isFallbackEntry(value)) {
      const meta = extractProviderMeta(value as Record<string, unknown>)
      if (meta) entries.push({ path: [key], providerMeta: meta })
      continue
    }

    // Foreach arrays: each item might be a fallback
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i]
        if (!item || typeof item !== 'object') continue
        if (isFallbackEntry(item)) {
          const meta = extractProviderMeta(item as Record<string, unknown>)
          if (meta) entries.push({ path: [key, String(i)], providerMeta: meta })
          continue
        }
        // Defensive: check nested objects within array items
        scanNested(item as Record<string, unknown>, [key, String(i)], entries)
      }
      continue
    }

    // Defensive: nested objects at top level
    scanNested(value as Record<string, unknown>, [key], entries)
  }

  return entries
}

function isFallbackEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return obj._fallback === true && obj._providerMeta != null
}

function extractProviderMeta(obj: Record<string, unknown>): ProviderMeta | null {
  const meta = obj._providerMeta
  if (!meta || typeof meta !== 'object') return null
  const m = meta as Record<string, unknown>
  if (typeof m.source !== 'string' || !m.source || typeof m.action !== 'string' || !m.action) return null
  return {
    source: m.source,
    action: m.action,
    params: (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>,
  }
}

function scanNested(
  obj: Record<string, unknown>,
  basePath: string[],
  entries: FallbackEntry[],
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object') continue
    if (isFallbackEntry(value)) {
      const meta = extractProviderMeta(value as Record<string, unknown>)
      if (meta) entries.push({ path: [...basePath, key], providerMeta: meta })
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 2: Enrich — execute provider steps locally
// ---------------------------------------------------------------------------

const CONCURRENCY_LIMIT = 3

export async function enrichFallbacks(
  entries: FallbackEntry[],
): Promise<Map<string, unknown>> {
  const results = new Map<string, unknown>()
  if (entries.length === 0) return results

  // Simple semaphore: process all entries with bounded concurrency
  let nextIndex = 0
  const active = new Set<Promise<void>>()

  function enqueue(): void {
    while (active.size < CONCURRENCY_LIMIT && nextIndex < entries.length) {
      const entry = entries[nextIndex++]!
      const pathKey = entry.path.join('\0')
      const p = enrichSingle(entry.providerMeta)
        .then((data) => {
          results.set(pathKey, data)
        })
        .catch((err) => {
          console.warn(
            `[enrichment] Failed to enrich ${entry.providerMeta.source}:${entry.providerMeta.action}: ${err instanceof Error ? err.message : 'unknown error'}`,
          )
        })
        .then(() => {
          active.delete(p)
        })
      active.add(p)
    }
  }

  enqueue()
  while (active.size > 0) {
    await Promise.race(active)
    enqueue()
  }

  return results
}

async function enrichSingle(meta: ProviderMeta): Promise<unknown> {
  const { providerName, hint } = parseSource(meta.source)
  const provider = getProvider(providerName)

  const params = toParams(meta.params)

  const response = await providerRequest({
    provider,
    actionName: meta.action,
    params,
    hint,
  })

  return response.data
}

function toParams(raw: Record<string, unknown>): Params {
  const result: Params = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else {
      result[key] = JSON.stringify(value)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Stage 3: Merge — replace fallback entries with enriched data
// ---------------------------------------------------------------------------

export function mergeFallbacks(
  data: Record<string, unknown>,
  enriched: Map<string, unknown>,
): Record<string, unknown> {
  if (enriched.size === 0) return data

  const result: Record<string, unknown> = { ...data }

  for (const [pathKey, enrichedData] of enriched) {
    const parts = pathKey.split('\0')
    setAtPath(result, parts, enrichedData)
  }

  return result
}

function setAtPath(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (path.length === 0) return

  if (path.length === 1) {
    obj[path[0]!] = value
    return
  }

  // Navigate to the parent
  const key = path[0]!
  const child = obj[key]

  if (Array.isArray(child)) {
    const index = parseInt(path[1]!, 10)
    if (!Number.isNaN(index) && index >= 0 && index < child.length) {
      if (path.length === 2) {
        // Clone the array to avoid mutating the original
        const newArr = [...child]
        newArr[index] = value
        obj[key] = newArr
      } else {
        // Deeper path within an array item
        const newArr = [...child]
        const item = newArr[index]
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const clone = { ...(item as Record<string, unknown>) }
          setAtPath(clone, path.slice(2), value)
          newArr[index] = clone
          obj[key] = newArr
        }
      }
    }
  } else if (child && typeof child === 'object') {
    const clone = { ...(child as Record<string, unknown>) }
    setAtPath(clone, path.slice(1), value)
    obj[key] = clone
  }
}

// ---------------------------------------------------------------------------
// Stage 4: Strip _providerMeta from any remaining fallback entries
// ---------------------------------------------------------------------------

function stripProviderMeta(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (obj._fallback === true && obj._providerMeta) {
        const clean = { ...obj }
        delete clean._providerMeta
        result[key] = clean
      } else {
        result[key] = value
      }
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const obj = item as Record<string, unknown>
          if (obj._fallback === true && obj._providerMeta) {
            const clean = { ...obj }
            delete clean._providerMeta
            return clean
          }
        }
        return item
      })
    } else {
      result[key] = value
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Convenience: combined scan -> enrich -> merge pipeline
// ---------------------------------------------------------------------------

export async function enrichServerResponse(
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const entries = scanForFallbacks(data)
  if (entries.length === 0) return stripProviderMeta(data)

  const enriched = await enrichFallbacks(entries)
  const merged = mergeFallbacks(data, enriched)
  return stripProviderMeta(merged)
}
