<script setup lang="ts">
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
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/instances'
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
    <a-card :title="t('app.title')" class="card">
      <a-form layout="vertical" :model="form" @finish="submit">
        <a-form-item :label="t('common.username')" name="username" :rules="[{ required: true, message: t('auth.enterUsername') }]">
          <a-input v-model:value="form.username" autocomplete="username" />
        </a-form-item>
        <a-form-item :label="t('common.password')" name="password" :rules="[{ required: true, message: t('auth.enterPassword') }]">
          <a-input-password v-model:value="form.password" autocomplete="current-password" />
        </a-form-item>
        <a-alert v-if="error" type="error" :message="error" show-icon style="margin-bottom: 16px" />
        <a-button type="primary" html-type="submit" block :loading="loading">{{ t('auth.login') }}</a-button>
      </a-form>
    </a-card>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.card { width: 100%; max-width: 380px; }
</style>
