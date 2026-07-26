import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

// ── Atualização do app ──────────────────────────────────────────────────────
// O app se atualiza sozinho: celular preso em cache antigo já deu dor de cabeça
// demais. A checagem continua ao abrir, a cada 30s e quando o app volta ao foco.
//
// A ÚNICA exceção é a impressora Bluetooth do celular. Recarregar a página mata
// a conexão BLE (o aparelho vive na memória da aba) e reparear exige um toque do
// dono, porque o navegador não deixa código chamar requestDevice sozinho. Era
// isso que derrubava a impressora da pizzaria a cada deploy, no meio do
// movimento e sem explicação.
//
// Com a impressora ligada, a versão nova fica ESPERANDO e aparece um aviso pra
// ele atualizar na hora que quiser. Como a impressora só conecta depois que a
// tela abre, a atualização entra sozinha na próxima vez que ele abrir o app.
const impressoraBtConectada = () => window.__fwcBtConectada === true

let updateSW = () => {}

function aplicarAtualizacao() {
  try { updateSW(true) } catch { /* ignora */ }
  // Cinto de segurança: se o service worker não devolver o controle, recarrega.
  setTimeout(() => window.location.reload(), 5000)
}

function mostrarAvisoAtualizacao() {
  if (document.getElementById('fwc-update-bar')) return

  const barra = document.createElement('div')
  barra.id = 'fwc-update-bar'
  Object.assign(barra.style, {
    position: 'fixed', left: '12px', right: '12px', bottom: '12px', zIndex: '99999',
    display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
    padding: '12px 14px', borderRadius: '12px',
    background: '#1f1b2e', color: '#fff',
    border: '1px solid #7c3aed', boxShadow: '0 8px 30px rgba(0,0,0,.45)',
    font: '600 13px/1.35 system-ui, -apple-system, sans-serif',
  })

  const texto = document.createElement('span')
  texto.style.flex = '1 1 200px'
  texto.innerHTML =
    'Tem versão nova do sistema.<br>' +
    '<span style="font-weight:400;opacity:.75">Atualizar desliga a impressora do celular — ' +
    'depois é só tocar em Conectar de novo. Pode deixar pro fim do movimento.</span>'

  const depois = document.createElement('button')
  depois.type = 'button'
  depois.textContent = 'Depois'
  Object.assign(depois.style, {
    padding: '9px 14px', borderRadius: '9px', cursor: 'pointer',
    border: '1px solid #3a3a4a', background: 'transparent', color: '#fff',
    font: '600 13px system-ui, sans-serif',
  })
  depois.onclick = () => barra.remove()

  const agora = document.createElement('button')
  agora.type = 'button'
  agora.textContent = 'Atualizar agora'
  Object.assign(agora.style, {
    padding: '9px 16px', borderRadius: '9px', cursor: 'pointer',
    border: 'none', background: '#7c3aed', color: '#fff',
    font: '700 13px system-ui, sans-serif',
  })
  agora.onclick = () => { agora.textContent = 'Atualizando...'; aplicarAtualizacao() }

  barra.append(texto, depois, agora)
  document.body.appendChild(barra)
}

updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (impressoraBtConectada()) mostrarAvisoAtualizacao()
    else aplicarAtualizacao()
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    const checar = () => registration.update().catch(() => {})
    checar()                        // checa JÁ ao abrir (não espera o 1º intervalo)
    setInterval(checar, 30 * 1000)  // e a cada 30s
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checar()
    })
  },
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
