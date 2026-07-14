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
//
// IMPORTANTE: só recarrega quando é uma ATUALIZAÇÃO de verdade (já havia um SW
// controlando a página). Na PRIMEIRA visita, o clientsClaim faz o SW assumir o
// controle e dispara um controllerchange sem controller anterior — se recarregasse
// aí, o usuário NOVO levaria um reload logo que entra (parece que "fechou sozinho").
if ('serviceWorker' in navigator) {
  const tinhaControllerAoAbrir = !!navigator.serviceWorker.controller
  let recarregando = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!tinhaControllerAoAbrir) return   // primeira instalação — não recarrega
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
