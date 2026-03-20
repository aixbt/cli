/** Check if a value is present and non-empty */
export function hasValue(v: unknown): v is string | number {
  return v !== undefined && v !== null && v !== '' && v !== 'undefined' && v !== 'null'
}
