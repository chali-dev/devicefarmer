import Antd from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { setUnauthorizedHandler } from './api/client'
import App from './App.vue'
import { i18n } from './i18n'
import router from './router'
import { useAuthStore } from './stores/auth'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(Antd)
app.use(i18n)

setUnauthorizedHandler(() => {
  useAuthStore().logout()
  if (router.currentRoute.value.name !== 'login') void router.push({ name: 'login' })
})

app.mount('#app')
