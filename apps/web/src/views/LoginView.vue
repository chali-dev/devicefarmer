<script setup lang="ts">
import { CloudOutlined, LockOutlined, UserOutlined } from '@ant-design/icons-vue'
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { errorText } from '../api/client'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const form = reactive({ username: '', password: '' })
const loading = ref(false)
const error = ref('')

async function submit() {
  loading.value = true
  error.value = ''
  try {
    await auth.login(form.username, form.password)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
    await router.replace(redirect)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <div class="box">
      <div class="brand">
        <span class="logo"><CloudOutlined /></span>
        <h1 class="title">{{ t('app.title') }}</h1>
      </div>
      <a-card :bordered="false">
        <a-form layout="vertical" :model="form" @finish="submit">
          <a-form-item :label="t('common.username')" name="username" :rules="[{ required: true, message: t('auth.enterUsername') }]">
            <a-input v-model:value="form.username" size="large" autocomplete="username">
              <template #prefix><UserOutlined class="muted" /></template>
            </a-input>
          </a-form-item>
          <a-form-item :label="t('common.password')" name="password" :rules="[{ required: true, message: t('auth.enterPassword') }]">
            <a-input-password v-model:value="form.password" size="large" autocomplete="current-password">
              <template #prefix><LockOutlined class="muted" /></template>
            </a-input-password>
          </a-form-item>
          <a-alert v-if="error" type="error" :message="error" show-icon class="error" />
          <a-button type="primary" html-type="submit" size="large" block :loading="loading">{{ t('auth.login') }}</a-button>
        </a-form>
      </a-card>
    </div>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--cp-bg-layout); box-sizing: border-box; }
.box { width: 100%; max-width: 380px; }
.brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 24px; }
.logo {
  width: 36px; height: 36px; border-radius: var(--cp-radius-lg); background: var(--cp-primary); color: var(--cp-bg-container);
  display: inline-flex; align-items: center; justify-content: center; font-size: 20px;
}
.title { margin: 0; font-size: 22px; font-weight: 600; color: var(--cp-text); }
.error { margin-bottom: 16px; }
</style>
