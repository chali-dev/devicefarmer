import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, getToken, setToken } from '../api/client'
import type { User } from '../api/types'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getToken())
  const user = ref<User | null>(null)

  const isAdmin = computed(() => user.value?.role === 'admin')

  /** `captcha` = the verified puzzle answer (components/auth/PuzzleCaptcha.vue); omitted when the server has it off. */
  async function login(username: string, password: string, captcha?: { id: string; x: number; trail: [number, number][] } | null) {
    const r = await api<{ token: string; user: User }>('POST', '/api/auth/login', { username, password, ...(captcha ? { captcha } : {}) })
    token.value = r.token
    user.value = r.user
    setToken(r.token)
  }

  async function loadMe(): Promise<boolean> {
    if (!token.value) return false
    try {
      user.value = (await api<{ user: User }>('GET', '/api/auth/me')).user
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
    setToken(null)
  }

  return { token, user, isAdmin, login, loadMe, updateProfile, changePassword, logout }
})
