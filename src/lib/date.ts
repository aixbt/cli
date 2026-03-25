export const RELATIVE_TIME_REGEX = /^-(\d+)(h|d|m)$/

export function resolveRelativeTime(expr: string): string {
  const match = RELATIVE_TIME_REGEX.exec(expr)
  if (!match) return expr
  const amount = parseInt(match[1], 10)
  const unit = match[2]
  const now = new Date()
  switch (unit) {
    case 'h': now.setTime(now.getTime() - amount * 60 * 60 * 1000); break
    case 'd': now.setTime(now.getTime() - amount * 24 * 60 * 60 * 1000); break
    case 'm': now.setTime(now.getTime() - amount * 60 * 1000); break
  }
  return now.toISOString()
}

export function resolveDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  return resolveRelativeTime(value)
}
