import type { LocationQuery } from 'vue-router'

/**
 * A single string query parameter (e.g. ?status=failed from a dashboard link), optionally restricted to
 * allowed values. List pages use it to preset their filters.
 */
export function queryParam<T extends string = string>(q: LocationQuery, key: string, allowed?: readonly T[]): T | undefined {
  const v = q[key]
  if (typeof v !== 'string' || !v) return undefined
  return !allowed || allowed.includes(v as T) ? (v as T) : undefined
}
