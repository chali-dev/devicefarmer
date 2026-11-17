import { reactive } from 'vue'
import { ApiError, getToken, responseError } from '../../api/client'
import type { MediaCropAspect, MediaItem, MediaLimits } from '../../api/types'

/** <img>/<video> can't send the Authorization header: fetch → Blob (→ object URL). */
export async function fetchAuthBlob(url: string): Promise<Blob> {
  const token = getToken()
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw await responseError(res)
  return res.blob()
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

export function fmtDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return ''
  const total = Math.round(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export const STATUS_COLOR: Record<MediaItem['status'], string> = { processing: 'processing', ready: 'success', failed: 'error', disabled: 'default' }

/** Thumbnail object URLs keyed by asset id + updatedAt, fetched 4 at a time. */
export function useThumbs() {
  const urls = reactive(new Map<string, string>())
  const failed = new Set<string>()
  let disposed = false
  const key = (m: MediaItem) => `${m.id}:${m.updatedAt}`
  async function load(items: MediaItem[]) {
    const todo = items.filter((m) => m.thumbnailUrl && !urls.has(key(m)) && !failed.has(key(m)))
    const worker = async () => {
      for (let m = todo.shift(); m; m = todo.shift()) {
        try {
          const blob = await fetchAuthBlob(m.thumbnailUrl!)
          if (disposed) return
          urls.set(key(m), URL.createObjectURL(blob))
        } catch { failed.add(key(m)) }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
  }
  const get = (m: MediaItem) => urls.get(key(m))
  function dispose() {
    disposed = true
    for (const u of urls.values()) URL.revokeObjectURL(u)
    urls.clear()
  }
  return { load, get, dispose }
}

/** Client-side pre-check against GET /api/media/limits; returns an error text key + params, or null. */
export function precheck(file: File, limits: MediaLimits): { key: string; params: Record<string, string | number> } | null {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''
  for (const kind of ['image', 'video'] as const) {
    if (limits[kind].formats.some((f) => f.exts.includes(ext))) {
      return file.size > limits[kind].maxMb * 1048576 ? { key: 'media.precheckSize', params: { max: limits[kind].maxMb } } : null
    }
  }
  return { key: 'media.precheckType', params: { exts: allExts(limits) } }
}

export const allExts = (limits: MediaLimits, kind?: 'image' | 'video') =>
  (kind ? [kind] : (['image', 'video'] as const)).flatMap((k) => limits[k].formats.flatMap((f) => f.exts)).join(' / ')

export const acceptAttr = (limits: MediaLimits) =>
  (['image', 'video'] as const).flatMap((k) => limits[k].formats.flatMap((f) => [...f.exts.map((e) => `.${e}`), ...f.mimes])).join(',')

/** Multipart upload with progress (fetch has no upload progress). Fields go before the file. */
export function xhrUpload(fields: Record<string, string>, file: File, onProgress: (pct: number) => void): { promise: Promise<MediaItem>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<MediaItem>((resolve, reject) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    fd.append('file', file, file.name)
    xhr.open('POST', '/api/media/upload')
    const token = getToken()
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100))) }
    xhr.onload = () => {
      let data: { item?: MediaItem; error?: string; message?: string; code?: string; params?: Record<string, string | number> } = {}
      try { data = JSON.parse(xhr.responseText) } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.item) { onProgress(100); resolve(data.item) }
      else reject(new ApiError(xhr.status, data.error ?? data.message ?? `HTTP ${xhr.status}`, data.code, data.params))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network error'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted'))
    xhr.send(fd)
  })
  return { promise, abort: () => xhr.abort() }
}

// ---------------------------------------------------------------- crop / compress (mirrors api media/transform.ts)
export const ASPECTS: Record<MediaCropAspect, number | null> = { original: null, '1:1': 1, '4:5': 4 / 5, '9:16': 9 / 16, '16:9': 16 / 9, '1.91:1': 1.91 }

/** Crop box as fractions of the source, centred on pos and clamped inside. */
export function cropFraction(w: number, h: number, aspect: MediaCropAspect, pos: { x: number; y: number }) {
  const r = ASPECTS[aspect]
  let bw = 1, bh = 1
  if (r) { if (w / h > r) bw = (h * r) / w; else bh = w / r / h }
  const left = Math.min(Math.max(pos.x - bw / 2, 0), 1 - bw)
  const top = Math.min(Math.max(pos.y - bh / 2, 0), 1 - bh)
  return { left, top, w: bw, h: bh }
}

/** Expected output size (same rules as the server: shorter side ≤ maxSize, longer ≤ 2×, no upscaling, even for video). */
export function outputSize(w: number, h: number, aspect: MediaCropAspect, maxSize: number | null, video: boolean) {
  const r = ASPECTS[aspect]
  let bw = w, bh = h
  if (r) { if (w / h > r) bw = Math.round(h * r); else bh = Math.round(w / r) }
  if (video) { bw -= bw % 2; bh -= bh % 2 }
  const s = maxSize ? Math.min(1, maxSize / Math.min(bw, bh), (2 * maxSize) / Math.max(bw, bh)) : 1
  let tw = Math.max(1, Math.round(bw * s)), th = Math.max(1, Math.round(bh * s))
  if (video) { tw = 2 * Math.round(tw / 2); th = 2 * Math.round(th / 2) }
  return { w: tw, h: th }
}

const extOfFile = (file: File) => /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''

export function isProcessable(file: File, limits: MediaLimits | null): boolean {
  const ext = extOfFile(file)
  return Boolean(limits && [...limits.image.formats, ...limits.video.formats].some((f) => f.processable && f.exts.includes(ext)))
}

export function isVideoFile(file: File, limits: MediaLimits | null): boolean {
  return limits ? limits.video.formats.some((f) => f.exts.includes(extOfFile(file))) : file.type.startsWith('video/')
}
