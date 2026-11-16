import { computed, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import antdZhCN from 'ant-design-vue/es/locale/zh_CN'
import antdEnUS from 'ant-design-vue/es/locale/en_US'
import zhCN, { type Messages } from './zh-CN'
import en from './en'

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

export const i18n = createI18n<[Messages], Locale, false>({
  legacy: false,
  locale: initialLocale(),
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN, en },
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

export function setLocale(l: Locale) {
  locale.value = l
  try { localStorage.setItem(STORAGE_KEY, l) } catch { /* storage unavailable */ }
}

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
