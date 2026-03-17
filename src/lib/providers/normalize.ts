export function flattenJsonApiResource(resource: unknown): Record<string, unknown> {
  if (typeof resource !== 'object' || resource === null) {
    return {}
  }
  const res = resource as Record<string, unknown>
  const attributes = (res.attributes ?? {}) as Record<string, unknown>
  return {
    ...attributes,
    id: res.id,
    type: res.type,
  }
}

export function flattenJsonApiResponse(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) {
    return body
  }
  const envelope = body as Record<string, unknown>
  const data = envelope.data
  if (Array.isArray(data)) {
    return data.map(flattenJsonApiResource)
  }
  if (typeof data === 'object' && data !== null) {
    return flattenJsonApiResource(data)
  }
  return body
}
