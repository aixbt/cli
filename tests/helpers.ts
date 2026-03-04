/**
 * Shared test utilities for @aixbt/cli test suite.
 */

export function statusTextFor(status: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    401: 'Unauthorized',
    402: 'Payment Required',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
  }
  return map[status] ?? 'Unknown'
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: statusTextFor(status),
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as Response
}

export function apiSuccess(data: unknown, headers?: Record<string, string>): Response {
  return jsonResponse(200, { status: 200, data }, headers)
}
