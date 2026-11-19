import { computed, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import antdZhCN from 'ant-design-vue/es/locale/zh_CN'
import antdEnUS from 'ant-design-vue/es/locale/en_US'
import zhCN, { type Messages } from './zh-CN'

export type Locale = 'zh-CN' | 'en'
export const LOCALES: { value: Locale; label: string }[] = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
]

const STORAGE_KEY = 'cloudphone.locale'

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh-CN' || saved === 'en') return saved
  } catch { /* storage unavailable */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : ''
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

// Chinese (the fallback) is bundled; English is a separate chunk loaded before it is shown (loadLocale).
export const i18n = createI18n<[Messages], Locale, false>({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN } as Record<Locale, Messages>,
  // Some texts show URL templates such as https://<host>; they are rendered as text, not HTML.
  warnHtmlMessage: false,
})

/** Global translate for code outside components (label helpers, stores). Reactive to the locale. */
export const t = i18n.global.t
export const te = i18n.global.te

export const locale = computed<Locale>({
  get: () => i18n.global.locale.value as Locale,
  set: (l) => { i18n.global.locale.value = l },
})

/** Loads a locale's messages once (English is lazy) and switches to it. */
async function loadLocale(l: Locale) {
  if (!i18n.global.availableLocales.includes(l)) i18n.global.setLocaleMessage(l, (await import('./en')).default)
  locale.value = l
}

export async function setLocale(l: Locale) {
  await loadLocale(l)
  try { localStorage.setItem(STORAGE_KEY, l) } catch { /* storage unavailable */ }
}

/** Resolves once the initial UI language is loaded; main.ts mounts the app after it. */
export const i18nReady: Promise<void> = loadLocale(initialLocale()).catch(() => undefined)

/** Ant Design locale for <a-config-provider>. */
export const antdLocale = computed(() => (locale.value === 'en' ? antdEnUS : antdZhCN))

// Keep <html lang>, the document title and dayjs (date pickers) in sync with the UI language.
watch(locale, (l) => {
  dayjs.locale(l === 'en' ? 'en' : 'zh-cn')
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l
    document.title = t('app.title')
  }
}, { immediate: true })

/** BCP 47 tag for Date/Number toLocale*String(): follows the UI language, not the browser's. */
export const dateLocale = (): string => i18n.global.locale.value

/** Date and time in the UI language; '—' when there is none. */
export const fmtDateTime = (d: string | number | Date | null | undefined): string => (d ? new Date(d).toLocaleString(dateLocale()) : '—')
