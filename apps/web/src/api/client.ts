import { t, te } from '../i18n'

const TOKEN_KEY = 'cloudphone.token'

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* storage unavailable */ }
}

export type ErrorParams = Record<string, string | number>

export class ApiError extends Error {
  readonly status: number
  /** Stable message code from the API (e.g. 'auth.wrong_password'), translated as `errors.<code>`. */
  readonly code?: string
  readonly params?: ErrorParams
  constructor(status: number, message: string, code?: string, params?: ErrorParams) {
    super(message)
    this.status = status
    this.code = code
    this.params = params
  }
}

/** Text of a coded message in the current UI language, or `fallback` when the code is unknown. */
export function codeText(code: string | undefined | null, params: ErrorParams | undefined, fallback: string): string {
  return code && te(`errors.${code}`) ? t(`errors.${code}`, params ?? {}) : fallback
}

/** User-facing text for any error: the translated API code when known, else the raw message. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return codeText(e.code, e.params, e.message)
  return e instanceof Error ? e.message : String(e)
}

/** Builds an ApiError from a failed fetch response body (for callers that don't use api()). */
export async function responseError(res: Response, fallbackKey = 'common.requestFailed'): Promise<ApiError> {
  const data = await res.json().catch(() => ({}))
  return new ApiError(res.status, data.error ?? data.message ?? t(fallbackKey, { status: res.status }), data.code, data.params)
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn }

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken()
  const isForm = body instanceof FormData
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  if (res.status === 401 && path !== '/api/auth/login') onUnauthorized?.()
  if (res.status === 204) return undefined as T
  if (!res.ok) throw await responseError(res)
  const data = await res.json().catch(() => ({}))
  return data as T
}

/** WebSocket URL on the same origin (proxied to the API in dev). */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}
