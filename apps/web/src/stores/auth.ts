import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, getToken, setToken } from '../api/client'
import type { User } from '../api/types'
import { MENU_KEYS } from '../components/common/menu'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getToken())
  const user = ref<User | null>(null)
  /** Sidebar keys this user may open (GET /api/auth/me → menus, 角色菜单权限); null = not loaded yet. */
  const menus = ref<string[] | null>(null)

  const isAdmin = computed(() => user.value?.role === 'admin')
  /** False only for a known menu key switched off for the user role; other paths are not menus and stay open. */
  function menuAllowed(key: string): boolean {
    if (isAdmin.value || !menus.value || !MENU_KEYS.includes(key)) return true
    return menus.value.includes(key)
  }

  /** `captcha` = the verified puzzle answer (components/auth/PuzzleCaptcha.vue); omitted when the server has it off. */
  async function login(username: string, password: string, captcha?: { id: string; x: number; trail: [number, number][] } | null) {
    const r = await api<{ token: string; user: User; menus?: string[] }>('POST', '/api/auth/login', { username, password, ...(captcha ? { captcha } : {}) })
    token.value = r.token
    user.value = r.user
    menus.value = r.menus ?? null
    setToken(r.token)
  }

  async function loadMe(): Promise<boolean> {
    if (!token.value) return false
    try {
      const r = await api<{ user: User; menus?: string[] }>('GET', '/api/auth/me')
      user.value = r.user
      menus.value = r.menus ?? null
      return true
    } catch {
      logout()
      return false
    }
  }

  async function updateProfile(body: { displayName?: string; email?: string }): Promise<User> {
    const r = await api<{ user: User }>('PATCH', '/api/auth/me', body)
    user.value = r.user
    return r.user
  }

  async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await api<void>('POST', '/api/auth/password', { currentPassword, newPassword })
  }

  function logout() {
    token.value = null
    user.value = null
    menus.value = null
    setToken(null)
  }

  return { token, user, menus, isAdmin, menuAllowed, login, loadMe, updateProfile, changePassword, logout }
})
