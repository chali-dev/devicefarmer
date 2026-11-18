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

/**
 * Link to one device in 云机管理 (`/instances?id=`): the list shows only that device, highlighted. Used by device-name links
 * that mean "show this device"; it never opens remote control (the list's 控制 button / `/instances/:id` does that).
 */
export const deviceListLink = (id: string) => ({ path: '/instances', query: { id } })
