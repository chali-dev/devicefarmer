import { api, getToken, responseError } from './client'

/** Downloads a full-resolution PNG screenshot of a running device. */
export async function downloadScreenshot(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/instances/${id}/screenshot`, { headers: { authorization: `Bearer ${getToken()}` } })
  if (!res.ok) throw await responseError(res, 'detail.screenshotFailed')
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  a.click()
  URL.revokeObjectURL(url)
}

/** Uploads a file into the phone's shared storage (Pictures / Movies / Download by type). */
export function uploadDeviceFile(id: string, file: File): Promise<{ path: string; folder: string }> {
  const fd = new FormData()
  fd.append('file', file, file.name)
  return api('POST', `/api/instances/${id}/files`, fd)
}
