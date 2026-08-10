import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

// ── Atualização do app ──────────────────────────────────────────────────────
// O app se atualiza sozinho: celular preso em cache antigo já deu dor de cabeça
// demais. A checagem continua ao abrir, a cada 30s e quando o app volta ao foco.
//
// Mas atualizar RECARREGA a página, e recarregar no meio do serviço estraga
// coisa. Por isso a versão nova espera quando:
//
// 1) A impressora Bluetooth do celular está conectada. Recarregar mata a conexão
//    BLE (o aparelho vive na memória da aba) e reparear exige um toque do dono,
//    porque o navegador não deixa código chamar requestDevice sozinho. Era isso
//    que derrubava a impressora da pizzaria a cada deploy, no meio do movimento.
//
// 2) A pessoa está preenchendo alguma coisa (aconteceu com o Wilde 10/08/2026:
//    a tela recarregou sozinha duas vezes no meio do cadastro e apagou tudo).
//    Formulário aberto some sem aviso e a pessoa tem que digitar de novo.
//
// Nos dois casos aparece um aviso pra atualizar na hora que quiser — e, no caso
// do formulário, o app tenta de novo sozinho quando a tela ficar parada.
const impressoraBtConectada = () => window.__fwcBtConectada === true

// Última vez que a pessoa digitou/mexeu num campo (captura na fase de captura
// pra pegar também o que acontece dentro de modal).
let ultimoMexeu = 0
for (const evt of ['input', 'keydown', 'paste']) {
  document.addEventListener(evt, () => { ultimoMexeu = Date.now() }, true)
}
const ESFRIAR_MS = 3 * 60 * 1000   // 3 min sem digitar = pode recarregar

// Está no meio de alguma coisa? (cursor num campo, digitou faz pouco, ou tem
// um modal aberto na frente — que é sempre formulário ou confirmação)
function ocupadoPreenchendo() {
  const el = document.activeElement
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return true
  if (Date.now() - ultimoMexeu < ESFRIAR_MS) return true
  if (document.querySelector('.modal-overlay, dialog[open], .confirmar-fundo')) return true
  return false
}

let updateSW = () => {}
let esperandoTelaLivre = null   // timer que fica tentando quando a tela desocupar

function aplicarAtualizacao() {
  if (esperandoTelaLivre) { clearInterval(esperandoTelaLivre); esperandoTelaLivre = null }
  document.getElementById('fwc-update-bar')?.remove()
  try { updateSW(true) } catch { /* ignora */ }
  // Cinto de segurança: se o service worker não devolver o controle, recarrega.
  setTimeout(() => window.location.reload(), 5000)
}

function mostrarAvisoAtualizacao(motivo = 'impressora') {
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
  texto.innerHTML = motivo === 'impressora'
    ? 'Tem versão nova do sistema.<br>' +
      '<span style="font-weight:400;opacity:.75">Atualizar desliga a impressora do celular — ' +
      'depois é só tocar em Conectar de novo. Pode deixar pro fim do movimento.</span>'
    : 'Tem versão nova do sistema.<br>' +
      '<span style="font-weight:400;opacity:.75">Não vou atualizar agora pra não apagar o que você está ' +
      'preenchendo. Termine e salve — ela entra sozinha depois.</span>'

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
    // Impressora BT: só o dono decide (recarregar derruba o pareamento).
    if (impressoraBtConectada()) { mostrarAvisoAtualizacao('impressora'); return }
    if (!ocupadoPreenchendo()) { aplicarAtualizacao(); return }

    // Está preenchendo: avisa e fica de olho. Assim que a tela ficar parada
    // (nada digitado por 3 min, sem modal aberto), atualiza sozinho.
    mostrarAvisoAtualizacao('preenchendo')
    if (esperandoTelaLivre) return
    esperandoTelaLivre = setInterval(() => {
      if (impressoraBtConectada() || ocupadoPreenchendo()) return
      clearInterval(esperandoTelaLivre)
      esperandoTelaLivre = null
      aplicarAtualizacao()
    }, 20 * 1000)
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
