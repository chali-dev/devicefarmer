import { reactive } from 'vue'
import { ApiError, getToken, responseError } from '../../api/client'
import type { ContentMedia, MediaCropAspect, MediaFormatLimit, MediaItem, MediaLimits, MediaProcessOptions } from '../../api/types'

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
/** The fields a content keeps of an asset (content_media item). */
export const toContentMedia = (m: MediaItem): ContentMedia => ({
  id: m.id, name: m.name, fileType: m.fileType, status: m.status, ownerType: m.ownerType, width: m.width, height: m.height, duration: m.duration, thumbnailUrl: m.thumbnailUrl,
})

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

/** Editor presets: free, 'original' (locked to the source's own ratio) and the fixed ratios. */
export type EditorAspect = 'free' | MediaCropAspect
export const EDITOR_ASPECTS: EditorAspect[] = ['free', 'original', '1:1', '4:5', '9:16', '16:9', '1.91:1']
export type EditorSize = 'original' | 1080 | 720
export type EditorQuality = 'original' | 'high' | 'medium' | 'low'
export interface EditSettings { aspect: EditorAspect; maxSize: EditorSize; quality: EditorQuality }
/** Fractions (0..1) of the orientation-corrected source. */
export interface Rect { x: number; y: number; w: number; h: number }
/** A picked file waiting in the editor (MediaUploader owns the list, MediaEditor edits it in place). */
export interface PendingFile {
  uid: number; file: File; url: string; video: boolean; processable: boolean; formatId: string
  settings: EditSettings; rect: Rect | null; dims: { w: number; h: number } | null
  meta: UploadMeta
}
/** Stored with the upload (same fields as the 编辑素材 dialog; no tags since 2026-11-18). Public media is always visible to every user. */
export interface UploadMeta { name: string; categoryId: string | undefined }
/** File name without its extension (the server's default name). */
export const fileStem = (name: string) => name.replace(/\.[^.]{1,8}$/, '') || name
/** Multipart fields for the metadata. */
export function metaFields(m: UploadMeta): Record<string, string> {
  const f: Record<string, string> = {}
  const name = m.name.trim()
  if (name) f.name = name
  if (m.categoryId) f.categoryId = m.categoryId
  return f
}
/** Source pixels. */
export interface Box { x: number; y: number; w: number; h: number }

/** Pixel ratio (w/h) the crop box is locked to; null = free. */
export function lockedRatio(aspect: EditorAspect, w: number, h: number): number | null {
  if (aspect === 'free') return null
  return aspect === 'original' ? w / h : ASPECTS[aspect]
}
const fixedAspect = (a: EditorAspect): MediaCropAspect | undefined => (a === 'free' || a === 'original' ? undefined : a)

/** Largest centred box of the ratio (the whole source when free), as fractions. */
export function defaultRect(w: number, h: number, ratio: number | null): Rect {
  let bw = 1, bh = 1
  if (ratio) { if (w / h > ratio) bw = (h * ratio) / w; else bh = w / ratio / h }
  return { x: (1 - bw) / 2, y: (1 - bh) / 2, w: bw, h: bh }
}

/** Rectangle → pixel box exactly like the server's rectBox (rounded, clamped, even for video, snapped to a fixed aspect). */
export function rectBox(w: number, h: number, c: Rect, aspect: MediaCropAspect | undefined, even: boolean): Box {
  const ev = (v: number) => (even ? v - (v % 2) : v)
  const min = even ? 2 : 1
  const maxW = ev(w), maxH = ev(h)
  let bw = Math.min(Math.max(ev(Math.round(c.w * w)), min), maxW)
  let bh = Math.min(Math.max(ev(Math.round(c.h * h)), min), maxH)
  const r = aspect ? ASPECTS[aspect] : null
  if (r) {
    const nw = even ? 2 * Math.round((bh * r) / 2) : Math.round(bh * r)
    if (nw <= maxW) bw = Math.max(min, nw)
    else { bw = maxW; bh = Math.min(maxH, Math.max(min, even ? 2 * Math.round(bw / r / 2) : Math.round(bw / r))) }
  }
  const x = ev(Math.min(Math.max(Math.round(c.x * w), 0), w - bw))
  const y = ev(Math.min(Math.max(Math.round(c.y * h), 0), h - bh))
  return { x, y, w: bw, h: bh }
}

/** Server rule: shorter side ≤ maxSize and longer side ≤ 2 × maxSize, never upscaled; even for video. */
export function targetSize(w: number, h: number, maxSize: number | undefined, even: boolean) {
  const s = maxSize ? Math.min(1, maxSize / Math.min(w, h), (2 * maxSize) / Math.max(w, h)) : 1
  let tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s))
  if (even) { tw = Math.max(2, 2 * Math.round(tw / 2)); th = Math.max(2, 2 * Math.round(th / 2)) }
  return { w: tw, h: th }
}

/** What the server will do with these settings on a w×h source. */
export function plan(w: number, h: number, s: EditSettings, rect: Rect | null, video: boolean) {
  const box = rectBox(w, h, rect ?? defaultRect(w, h, lockedRatio(s.aspect, w, h)), fixedAspect(s.aspect), video)
  const even = (v: number) => (video ? v - (v % 2) : v)
  const crop = box.x > 0 || box.y > 0 || box.w < even(w) || box.h < even(h)
  const out = targetSize(box.w, box.h, s.maxSize === 'original' ? undefined : s.maxSize, video)
  const cropped = box.w !== w || box.h !== h
  const resized = out.w !== box.w || out.h !== box.h
  const any = crop || s.maxSize !== 'original' || s.quality !== 'original'
  return { box, out, crop, cropped, resized, any }
}

/** The upload's `process` field (null = stored as uploaded). Without known dimensions a fixed preset falls back to the centred legacy form. */
export function processOptions(s: EditSettings, rect: Rect | null, dims: { w: number; h: number } | null, video: boolean): MediaProcessOptions | null {
  const o: MediaProcessOptions = {}
  const fa = fixedAspect(s.aspect)
  if (dims) {
    const p = plan(dims.w, dims.h, s, rect, video)
    if (p.crop) o.crop = { x: p.box.x / dims.w, y: p.box.y / dims.h, w: p.box.w / dims.w, h: p.box.h / dims.h, ...(fa ? { aspect: fa } : {}) }
  } else if (fa) o.crop = { aspect: fa, x: 0.5, y: 0.5 }
  if (s.maxSize !== 'original') o.maxSize = s.maxSize
  if (s.quality !== 'original') o.quality = s.quality
  return Object.keys(o).length ? o : null
}

/** Canvas approximation of the server's sharp encode (same quality numbers; sharp uses mozjpeg, so its JPEGs are usually a bit smaller). */
const IMAGE_Q = { high: 0.9, medium: 0.8, low: 0.65 } as const
export async function encodePreview(src: CanvasImageSource, box: Box, out: { w: number; h: number }, formatId: string, quality: EditorQuality): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = out.w
  canvas.height = out.h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, out.w, out.h)
  const q = IMAGE_Q[quality === 'original' ? 'high' : quality]
  const type = formatId === 'png' ? 'image/png' : formatId === 'webp' ? 'image/webp' : 'image/jpeg'
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, q))
}

const extOfFile = (file: File) => /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''

export function formatOf(file: File, limits: MediaLimits | null): MediaFormatLimit | undefined {
  const ext = extOfFile(file)
  return limits ? [...limits.image.formats, ...limits.video.formats].find((f) => f.exts.includes(ext)) : undefined
}

export function isVideoFile(file: File, limits: MediaLimits | null): boolean {
  return limits ? limits.video.formats.some((f) => f.exts.includes(extOfFile(file))) : file.type.startsWith('video/')
}
