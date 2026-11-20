<script setup lang="ts">
import type { Rule } from 'ant-design-vue/es/form'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 显示名称 + 邮箱 form items (个人资料 in the header, 用户管理's 新建 / 编辑). Put inside an `a-form` whose `:model`
 * holds `displayName` / `email`; the rules (same as the API: ≤ 40 chars, an email or empty) run with the form's validate().
 */
defineProps<{ model: { displayName: string; email: string } }>()
const { t } = useI18n()
const rules = computed<Record<'displayName' | 'email', Rule[]>>(() => ({
  displayName: [{ max: 40, message: t('profile.max40') }],
  email: [{ type: 'email', message: t('profile.badEmail'), trigger: 'blur' }],
}))
</script>

<template>
  <a-form-item :label="t('profile.displayName')" name="displayName" :rules="rules.displayName">
    <a-input v-model:value="model.displayName" :maxlength="40" :placeholder="t('profile.displayNamePlaceholder')" autocomplete="off" />
  </a-form-item>
  <a-form-item :label="t('profile.email')" name="email" :rules="rules.email">
    <a-input v-model:value="model.email" :maxlength="254" :placeholder="t('common.optional')" autocomplete="off" />
  </a-form-item>
</template>
