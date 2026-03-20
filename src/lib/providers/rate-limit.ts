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

  tracker.timestamps.push(Date.now())

  if (tracker.timestamps.length >= tracker.maxPerMinute) {
    const oldestInWindow = tracker.timestamps[0]
    const waitUntil = oldestInWindow + 60_000
    const waitMs = waitUntil - Date.now()
    return Math.max(waitMs, 0)
  }

  return 0
}

export function remainingInWindow(tracker: ProviderRateTracker): number {
  pruneWindow(tracker)
  return Math.max(0, tracker.maxPerMinute - tracker.timestamps.length)
}

export function deriveProviderConcurrency(tracker: ProviderRateTracker): number {
  const remaining = remainingInWindow(tracker)
  if (remaining <= 2) return 1
  if (remaining <= 10) return 2
  if (remaining <= 20) return 3
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
