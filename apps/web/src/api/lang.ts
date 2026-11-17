import { dateLocale } from '../i18n'

/** Display name of a BCP-47 language code in the UI language (e.g. "hi" → "印地语" / "Hindi"); falls back to the code. */
export function langName(code: string): string {
  try { return new Intl.DisplayNames([dateLocale()], { type: 'language' }).of(code) ?? code } catch { return code }
}

/** Canonical BCP-47 form (zh-cn → zh-CN), or null when invalid. */
export function canonicalLang(code: string): string | null {
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code.trim())) return null
  try { return Intl.getCanonicalLocales(code.trim())[0] ?? null } catch { return null }
}
