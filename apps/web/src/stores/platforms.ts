import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api/client'

export interface PlatformScope {
  /** Every enabled social platform (API config ENABLED_PLATFORMS). */
  enabled: { id: string; name: string }[]
  features: { trending: boolean; youtubeKey: boolean }
}

/** The web's single source for which platforms are on (GET /api/platforms); views filter with it, never by hard-coded ids. */
export const usePlatformsStore = defineStore('platforms', () => {
  const scope = ref<PlatformScope>({ enabled: [], features: { trending: false, youtubeKey: false } })
  let pending: Promise<void> | null = null

  /** Loads once; `force` reloads. */
  function load(force = false): Promise<void> {
    if (force || !pending) {
      pending = api<PlatformScope>('GET', '/api/platforms').then((r) => { scope.value = r }).catch((e) => { pending = null; throw e })
    }
    return pending
  }

  const isEnabled = (id: string) => scope.value.enabled.some((p) => p.id === id)

  return { scope, load, isEnabled }
})
