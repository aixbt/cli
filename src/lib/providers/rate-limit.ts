export interface ProviderRateTracker {
  providerName: string
  maxPerMinute: number
  timestamps: number[]
}

const trackers = new Map<string, ProviderRateTracker>()

export function getTracker(
  providerName: string,
  maxPerMinute: number,
): ProviderRateTracker {
  const existing = trackers.get(providerName)
  if (existing) return existing

  const tracker: ProviderRateTracker = {
    providerName,
    maxPerMinute,
    timestamps: [],
  }
  trackers.set(providerName, tracker)
  return tracker
}

function pruneWindow(tracker: ProviderRateTracker): void {
  const cutoff = Date.now() - 60_000
  let i = 0
  while (i < tracker.timestamps.length && tracker.timestamps[i] < cutoff) {
    i++
  }
  if (i > 0) {
    tracker.timestamps.splice(0, i)
  }
}

/**
 * Record a request and return ms to wait before sending it.
 * Checks the window BEFORE recording so concurrent callers
 * don't all sneak past the limit simultaneously.
 */
export function recordRequest(tracker: ProviderRateTracker): number {
  pruneWindow(tracker)

  const now = Date.now()

  // Enforce minimum spacing between calls (60s / maxPerMinute)
  // Prevents bursts that trigger server-side rate limits stricter than our window
  const minInterval = Math.ceil(60_000 / tracker.maxPerMinute)
  const lastTimestamp = tracker.timestamps[tracker.timestamps.length - 1]
  let spacingWait = 0
  if (lastTimestamp !== undefined) {
    const elapsed = now - lastTimestamp
    if (elapsed < minInterval) {
      spacingWait = minInterval - elapsed
    }
  }

  tracker.timestamps.push(now)

  if (tracker.timestamps.length >= tracker.maxPerMinute) {
    const oldestInWindow = tracker.timestamps[0]
    const waitUntil = oldestInWindow + 60_000
    const windowWait = Math.max(waitUntil - now, 0)
    return Math.max(windowWait, spacingWait)
  }

  return spacingWait
}

export function remainingInWindow(tracker: ProviderRateTracker): number {
  pruneWindow(tracker)
  return Math.max(0, tracker.maxPerMinute - tracker.timestamps.length)
}

export function deriveProviderConcurrency(tracker: ProviderRateTracker): number {
  const remaining = remainingInWindow(tracker)
  if (remaining <= 2) return 1
  // Low-limit providers (e.g. CoinGecko free at 10/min) need serial requests
  if (tracker.maxPerMinute <= 15) return 1
  if (remaining <= 10) return 2
  if (remaining <= 20) return 3
  // High-capacity providers (e.g. DexPaprika) can handle more parallelism
  if (tracker.maxPerMinute >= 60) return 10
  return 5
}

/**
 * If the rate window is nearly full, return ms to wait before the
 * oldest timestamp expires. Returns 0 if there's capacity.
 * Use as a pre-flight gate before starting a new foreach item.
 */
export function waitForCapacity(tracker: ProviderRateTracker, buffer = 2): number {
  pruneWindow(tracker)
  if (tracker.timestamps.length + buffer >= tracker.maxPerMinute) {
    const oldestInWindow = tracker.timestamps[0]
    if (oldestInWindow !== undefined) {
      const waitMs = oldestInWindow + 60_000 - Date.now()
      if (waitMs > 0) return waitMs
    }
  }
  return 0
}

export function resetAllTrackers(): void {
  trackers.clear()
}
