import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '../api/client'
import type { PlatformInfo } from '../api/types'

export interface PlatformScope {
  /** Enabled platforms with an official-API adapter. */
  platforms: PlatformInfo[]
  /** Every enabled social platform (API config ENABLED_PLATFORMS). */
  enabled: { id: string; name: string }[]
  features: { trending: boolean; youtubeKey: boolean; trackedCollector: boolean }
}

/** The web's single source for which platforms are on (GET /api/platforms); views filter with it, never by hard-coded ids. */
export const usePlatformsStore = defineStore('platforms', () => {
  const scope = ref<PlatformScope>({ platforms: [], enabled: [], features: { trending: false, youtubeKey: false, trackedCollector: false } })
  let pending: Promise<void> | null = null

  /** Loads once; `force` reloads (e.g. after app settings changed the capabilities). */
  function load(force = false): Promise<void> {
    if (force || !pending) {
      pending = api<PlatformScope>('GET', '/api/platforms').then((r) => { scope.value = r }).catch((e) => { pending = null; throw e })
    }
    return pending
  }

  const isEnabled = (id: string) => scope.value.enabled.some((p) => p.id === id)
  /** Platforms whose official API collects own-account stats (账号分析). */
  const statsPlatforms = computed(() => scope.value.platforms.filter((p) => p.capabilities.accountStats).map((p) => p.id))

  return { scope, load, isEnabled, statsPlatforms }
})
