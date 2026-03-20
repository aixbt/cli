import type { ExecutionContext } from '../../types.js'
import { TEMPLATE_REGEX } from '../../types.js'
import { getNestedValue } from '../transforms.js'
import { isErrorMarker } from './foreach.js'

export const RELATIVE_TIME_REGEX = /^-(\d+)(h|d|m)$/

export function resolveExpression(
  expr: string,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): unknown {
  const trimmed = expr.trim()

  // params.X
  if (trimmed.startsWith('params.')) {
    const paramName = trimmed.slice('params.'.length)
    return ctx.params[paramName]
  }

  // item or item.X
  if (trimmed === 'item') {
    return foreachItem
  }
  if (trimmed.startsWith('item.')) {
    const path = trimmed.slice('item.'.length)
    return getNestedValue(foreachItem, path)
  }

  // Step references: step_id, step_id.data, step_id.data[*].field, step_id.data.nested.path
  // Also: step_id[*].field — shorthand pluck
  const bracketIdx = trimmed.indexOf('[*].')
  let stepId: string

  if (bracketIdx !== -1 && (trimmed.indexOf('.') === -1 || bracketIdx < trimmed.indexOf('.'))) {
    // step_id[*].field — shorthand pluck
    stepId = trimmed.slice(0, bracketIdx)
    const stepResult = ctx.results.get(stepId)
    if (!stepResult) return undefined
    const field = trimmed.slice(bracketIdx + '[*].'.length)
    if (!Array.isArray(stepResult.data)) return undefined
    return stepResult.data
      .filter((item: unknown) => !isErrorMarker(item))
      .map((item: unknown) => getNestedValue(item, field))
  }

  const dotIndex = trimmed.indexOf('.')
  stepId = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex)
  const stepResult = ctx.results.get(stepId)

  if (!stepResult) {
    return undefined
  }

  // Bare step_id
  if (dotIndex === -1) {
    return stepResult.data
  }

  const rest = trimmed.slice(dotIndex + 1)

  // If rest doesn't start with "data", treat as shorthand for data.X
  // This allows step_id.field as shorthand for step_id.data.field
  // (e.g., picks.projectIds resolves to picks.data.projectIds)
  if (!rest.startsWith('data')) {
    return getNestedValue(stepResult.data, rest)
  }

  // step_id.data
  if (rest === 'data') {
    return stepResult.data
  }

  // step_id.data[*].field — pluck operation
  if (rest.startsWith('data[*].')) {
    const field = rest.slice('data[*].'.length)
    if (!Array.isArray(stepResult.data)) {
      return undefined
    }
    return stepResult.data
      .filter((item: unknown) => !isErrorMarker(item))
      .map((item: unknown) => getNestedValue(item, field))
  }

  // step_id.data.nested.path
  if (rest.startsWith('data.')) {
    const nestedPath = rest.slice('data.'.length)
    return getNestedValue(stepResult.data, nestedPath)
  }

  return undefined
}

function resolveString(
  str: string,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): unknown {
  // Check for standalone relative time expression first
  if (RELATIVE_TIME_REGEX.test(str)) {
    return resolveRelativeTime(str)
  }

  // Check if entire string is a single template expression — preserve type
  const singleMatch = /^\{([^}]+)\}$/.exec(str)
  if (singleMatch) {
    const resolved = resolveExpression(singleMatch[1], ctx, foreachItem)
    // If the resolved value is a relative time string, convert it
    if (typeof resolved === 'string' && RELATIVE_TIME_REGEX.test(resolved)) {
      return resolveRelativeTime(resolved)
    }
    return resolved
  }

  // Mixed string interpolation
  return str.replace(TEMPLATE_REGEX, (_, expr: string) => {
    const resolved = resolveExpression(expr, ctx, foreachItem)
    return String(resolved ?? '')
  })
}

export function resolveValue(
  value: unknown,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): unknown {
  if (typeof value === 'string') {
    return resolveString(value, ctx, foreachItem)
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, ctx, foreachItem))
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveValue(val, ctx, foreachItem)
    }
    return result
  }

  // numbers, booleans, null, undefined — pass through
  return value
}

export function resolveActionPath(
  actionPath: string,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): { method: string; path: string } {
  const spaceIndex = actionPath.indexOf(' ')

  let method: string
  let path: string

  if (spaceIndex === -1) {
    method = 'GET'
    path = actionPath
  } else {
    method = actionPath.slice(0, spaceIndex).toUpperCase()
    path = actionPath.slice(spaceIndex + 1)
  }

  // Resolve templates in the path
  const resolved = resolveString(path, ctx, foreachItem)
  return { method, path: String(resolved) }
}

/**
 * Substitute {name} path placeholders from resolved params.
 * Mutates params by removing consumed path params.
 */
export function substitutePathParams(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  return path.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    if (value !== undefined && value !== '') {
      delete params[name]
      return encodeURIComponent(String(value))
    }
    return match
  })
}

export function resolveRelativeTime(expr: string): string {
  const match = RELATIVE_TIME_REGEX.exec(expr)
  if (!match) {
    return expr
  }

  const amount = parseInt(match[1], 10)
  const unit = match[2]

  const now = new Date()

  switch (unit) {
    case 'h':
      now.setTime(now.getTime() - amount * 60 * 60 * 1000)
      break
    case 'd':
      now.setTime(now.getTime() - amount * 24 * 60 * 60 * 1000)
      break
    case 'm':
      now.setTime(now.getTime() - amount * 60 * 1000)
      break
  }

  return now.toISOString()
}

export function flattenParams(
  params: Record<string, unknown> | undefined,
  ctx: ExecutionContext,
  foreachItem?: unknown,
): Record<string, string | number | boolean | undefined> {
  const result: Record<string, string | number | boolean | undefined> = {}
  if (!params) return result
  const resolved = resolveValue(params, ctx, foreachItem) as Record<string, unknown>
  for (const [key, val] of Object.entries(resolved)) {
    if (Array.isArray(val)) {
      result[key] = val.join(',')
    } else if (val === null || val === undefined) {
      result[key] = undefined
    } else {
      result[key] = val as string | number | boolean
    }
  }
  return result
}
