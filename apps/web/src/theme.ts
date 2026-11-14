import { computed, ref } from 'vue'
import { theme as antdTheme } from 'ant-design-vue'

export type ThemeMode = 'system' | 'light' | 'dark'
const STORAGE_KEY = 'cloudphone.theme'

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'system' || saved === 'light' || saved === 'dark') return saved
  } catch { /* storage unavailable */ }
  return 'system'
}

export const themeMode = ref<ThemeMode>(initialMode())

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
const systemDark = ref(media?.matches ?? false)
media?.addEventListener('change', (e) => { systemDark.value = e.matches })

export const isDark = computed(() => themeMode.value === 'dark' || (themeMode.value === 'system' && systemDark.value))

export function setThemeMode(m: ThemeMode) {
  themeMode.value = m
  try { localStorage.setItem(STORAGE_KEY, m) } catch { /* storage unavailable */ }
}

/** `theme` prop for <a-config-provider>. */
export const antdThemeConfig = computed(() => ({
  algorithm: isDark.value ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
}))
