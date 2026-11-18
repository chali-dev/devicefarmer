import { api } from '../../api/client'
import type { PersonaDetail } from '../../api/types'

/**
 * Persona details (GET /api/personas/:id: style, 范例, length table) for the persona cards of the post editor and the
 * reply composers, cached per page load; the persona form drops an entry after saving.
 */
const cache = new Map<string, Promise<PersonaDetail>>()

export function loadPersona(id: string): Promise<PersonaDetail> {
  let p = cache.get(id)
  if (!p) {
    p = api<PersonaDetail>('GET', `/api/personas/${id}`)
    p.catch(() => cache.delete(id))
    cache.set(id, p)
  }
  return p
}

export function forgetPersona(id?: string) {
  if (id) cache.delete(id)
  else cache.clear()
}

/** Banned words found in the text (case-insensitive substring, same rule as the API's persona.banned_word check). */
export function bannedHits(words: string[] | undefined, text: string): string[] {
  const hay = text.toLowerCase()
  return (words ?? []).filter((w) => w.trim() && hay.includes(w.trim().toLowerCase()))
}

/** Characters as people count them (emoji and CJK = 1). */
export const charCount = (s: string) => [...s.trim()].length
