import 'ant-design-vue/dist/reset.css'
import './styles/global.css'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { installAntd } from './antd'
import { setUnauthorizedHandler } from './api/client'
import App from './App.vue'
import { i18n, i18nReady } from './i18n'
import router from './router'
import { useAuthStore } from './stores/auth'

const app = createApp(App)
app.use(createPinia())
app.use(router)
installAntd(app)
app.use(i18n)

setUnauthorizedHandler(() => {
  useAuthStore().logout()
  if (router.currentRoute.value.name !== 'login') void router.push({ name: 'login' })
})

void i18nReady.then(() => app.mount('#app'))
