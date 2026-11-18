<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from 'vue-i18n'
import { api, errorText } from '../api/client'
import { dateLocale } from '../i18n'
import PageContainer from '../components/common/PageContainer.vue'
import { MENU_GROUPS, navLabel } from '../components/common/menu'

/**
 * 权限管理 (账号管理, admin): 角色菜单权限. The roles are fixed (admin / user); the admin ticks which business menus the
 * user role sees (GET/PUT /api/settings/role-menus). Admins always see everything; the dashboard is always on and
 * admin-only menus cannot be granted (shown greyed). The API enforces it too (403 rbac.menu_disabled).
 */
interface RoleMenus {
  menus: string[]; defaults: string[]; grantable: string[]; updatedAt: string | null
  fixed: { always: string[]; adminOnly: string[] }
}
const { t } = useI18n()
const state = ref<RoleMenus | null>(null)
const picked = ref<string[]>([])
const saving = ref(false)

function fill(r: RoleMenus) { state.value = r; picked.value = [...r.menus] }
onMounted(async () => { try { fill(await api<RoleMenus>('GET', '/api/settings/role-menus')) } catch (e) { message.error(errorText(e)) } })

/** Sidebar order: dashboard, then every group's items; each row says whether it can be granted. */
const rows = computed(() => {
  const s = state.value
  const kind = (k: string) => (!s ? 'adminOnly' : s.grantable.includes(k) ? 'grantable' : s.fixed.always.includes(k) ? 'always' : 'adminOnly')
  return [
    { group: null as string | null, items: [{ key: 'dashboard', kind: kind('dashboard') }] },
    ...MENU_GROUPS.map((g) => ({ group: g.flat ? null : g.key, items: g.items.map((it) => ({ key: it.key, kind: kind(it.key) })) })),
  ]
})
const changed = computed(() => !!state.value && [...picked.value].sort().join() !== [...state.value.menus].sort().join())
const isDefault = computed(() => !!state.value && [...picked.value].sort().join() === [...state.value.defaults].sort().join())

function toggle(key: string, on: boolean) {
  picked.value = on ? [...new Set([...picked.value, key])] : picked.value.filter((k) => k !== key)
}
async function save() {
  saving.value = true
  try {
    fill(await api<RoleMenus>('PUT', '/api/settings/role-menus', { menus: picked.value }))
    message.success(t('common.saved'))
  } catch (e) { message.error(errorText(e)) }
  finally { saving.value = false }
}
</script>

<template>
  <PageContainer :subtitle="t('roleMenus.subtitle')">
    <a-card :bordered="false">
      <a-spin :spinning="!state">
        <a-alert type="info" show-icon class="block" :message="t('roleMenus.hint')" />
        <table class="grid">
          <thead>
            <tr><th>{{ t('roleMenus.menu') }}</th><th class="c">{{ t('roleMenus.roleAdmin') }}</th><th class="c">{{ t('roleMenus.roleUser') }}</th></tr>
          </thead>
          <tbody>
            <template v-for="(r, ri) in rows" :key="ri">
              <tr v-if="r.group" class="group"><td colspan="3">{{ t(`nav.group.${r.group}`) }}</td></tr>
              <tr v-for="it in r.items" :key="it.key">
                <td :class="{ indent: r.group }">
                  {{ navLabel(it.key) }}
                  <a-tag v-if="it.kind === 'always'" class="tag">{{ t('roleMenus.always') }}</a-tag>
                  <a-tag v-else-if="it.kind === 'adminOnly'" class="tag">{{ t('roleMenus.adminOnly') }}</a-tag>
                </td>
                <td class="c"><a-checkbox :checked="true" disabled /></td>
                <td class="c">
                  <a-checkbox
                    v-if="it.kind === 'grantable'" :checked="picked.includes(it.key)" :aria-label="navLabel(it.key)"
                    @change="(e: any) => toggle(it.key, e.target.checked)"
                  />
                  <a-checkbox v-else :checked="it.kind === 'always'" disabled />
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <a-space wrap class="actions">
          <a-button type="primary" :loading="saving" :disabled="!changed" @click="save">{{ t('common.save') }}</a-button>
          <a-button :disabled="!state || isDefault" @click="picked = [...(state?.defaults ?? [])]">{{ t('roleMenus.restoreDefault') }}</a-button>
          <span v-if="state?.updatedAt" class="muted small">{{ t('settings.updatedAt', { at: new Date(state.updatedAt).toLocaleString(dateLocale()) }) }}</span>
        </a-space>
      </a-spin>
    </a-card>
  </PageContainer>
</template>

<style scoped>
.block { margin-bottom: 16px; }
.grid { width: 100%; max-width: 640px; border-collapse: collapse; }
.grid th, .grid td { padding: 8px 12px; border-bottom: 1px solid var(--cp-border-secondary); text-align: start; }
.grid th { font-weight: 600; color: var(--cp-text-secondary); }
.grid .c { text-align: center; width: 110px; }
.grid .group td { font-weight: 600; background: var(--cp-bg-layout); }
.indent { padding-inline-start: 28px !important; }
.tag { margin-inline-start: 8px; }
.actions { margin-top: 16px; }
</style>
