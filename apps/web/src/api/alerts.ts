import type { RouteLocationRaw } from 'vue-router'
import { t, te } from '../i18n'
import { codeText } from './client'
import type { AppNotification } from './types'

/**
 * Rendering of in-app alerts (告警通知). The API stores kind + short params (names, handles, status /
 * reason / error codes); texts live in `alerts.kinds.<kind>.problem|recovered`, words in `alerts.words`.
 */
const word = (v: string | number) => (te(`alerts.words.${v}`) ? t(`alerts.words.${v}`) : String(v))
/** i18n key of a kind ('device.down' → 'device_down': vue-i18n splits keys on dots). */
export const kindKey = (kind: string) => kind.replace(/\./g, '_')

export function alertText(n: Pick<AppNotification, 'kind' | 'recovered' | 'params'>): string {
  const key = `alerts.kinds.${kindKey(n.kind)}.${n.recovered ? 'recovered' : 'problem'}`
  if (!te(key)) return n.kind
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries(n.params ?? {})) {
    params[k] = k === 'type' ? (te(`tasks.types.${v}`) ? t(`tasks.types.${v}`) : String(v)) : ['name', 'handle', 'title', 'label', 'platform'].includes(k) ? String(v) : word(v)
  }
  for (const k of ['name', 'handle', 'title', 'label', 'platform', 'status', 'reason', 'type']) params[k] ??= '—'
  return t(key, params)
}

/** Translated error code of the alert (e.g. publish.device_offline), if any. */
export function alertDetail(n: Pick<AppNotification, 'params' | 'recovered'>): string | null {
  const code = n.params?.code
  return !n.recovered && typeof code === 'string' && code ? codeText(code, {}, code) : null
}

/** Where clicking the alert leads (same targets as the Telegram links built by the API). */
export function alertLink(n: Pick<AppNotification, 'refType' | 'refId' | 'params'>): RouteLocationRaw | null {
  if (!n.refId) return null
  if (n.refType === 'instance') return `/instances/${n.refId}`
  if (n.refType === 'social_account') return { path: '/social', query: { q: String(n.params?.handle ?? '') } }
  if (n.refType === 'publish') return { path: '/publish', query: { task: n.refId } }
  if (n.refType === 'task') return { path: '/tasks', query: { task: n.refId } }
  if (n.refType === 'alert_channel') return '/alert-channels'
  return null
}
