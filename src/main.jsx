import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

// Service worker com atualização automática: checa nova versão ao abrir,
// a cada 60s e quando o app volta ao foco. Em autoUpdate o app recarrega
// sozinho ao detectar versão nova — evita ficar preso em cache antigo no celular.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    const checar = () => registration.update().catch(() => {})
    setInterval(checar, 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checar()
    })
  },
})

// Quando o service worker NOVO assume o controle (atualização chegou), recarrega
// a página automaticamente — assim o celular pega a versão nova SEM ninguém
// precisar limpar cache. Vale pra todas as atualizações daqui pra frente.
if ('serviceWorker' in navigator) {
  let recarregando = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recarregando) return
    recarregando = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
