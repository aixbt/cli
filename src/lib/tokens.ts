/**
 * Estimate token count from a data payload.
 * Uses byte-length heuristic (~4 chars per token for JSON/English).
 */
export function estimateTokenCount(data: unknown): number {
  try {
    const json = JSON.stringify(data)
    return Math.ceil((json?.length ?? 0) / 4)
  } catch {
    return 0
  }
}

/** Format a token count as a human-readable string (e.g., "1.5k" for >= 1000). */
export function formatTokenCount(data: unknown): string {
  const estimate = estimateTokenCount(data)
  return estimate >= 1000 ? `${(estimate / 1000).toFixed(1)}k` : String(estimate)
}
