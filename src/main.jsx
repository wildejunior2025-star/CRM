import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
// Page.css é o estilo COMPARTILHADO (.btn, .btn-primary, .modal, .card...).
// 38 telas importam ele, mas nem todas — o Login, por exemplo, usa .btn-primary
// sem importar. Enquanto era tudo um arquivo só isso funcionava de carona: o
// estilo vinha junto de qualquer jeito. Com as telas em pedaços separados, o
// Page.css passou a viajar num pedaço que o Login não carrega, e o botão
// "Entrar" ficou cinza de navegador, sem estilo nenhum.
//
// Aqui ele vira global: entra sempre, em qualquer rota, como era antes.
import './components/Page.css'
import App from './App.jsx'

// ── Tela branca depois de um deploy ─────────────────────────────────────────
// Cada tela virou um pedaço de arquivo com nome próprio, e o nome muda a cada
// publicação. Se o aparelho ainda tem o HTML velho guardado (o PWA guarda), ele
// pede um pedaço que não existe mais no servidor: o pedido volta com a página
// de erro em HTML, o navegador recusa e a tela fica BRANCA, sem mensagem.
//
// Aqui a gente recarrega uma vez. Recarregar traz o HTML novo, com os nomes
// certos, e o app abre normal — a pessoa vê um piscar, não uma tela morta.
//
// A trava de 20s existe pra não entrar em laço: se o problema for outro (a
// internet caiu no meio do download, por exemplo), recarregar não resolve e
// ficaria recarregando pra sempre.
window.addEventListener('vite:preloadError', (evento) => {
  evento.preventDefault()
  const agora = Date.now()
  const ultima = Number(sessionStorage.getItem('fwc_reload_pedaco') || 0)
  if (agora - ultima < 20_000) return
  sessionStorage.setItem('fwc_reload_pedaco', String(agora))
  window.location.reload()
})

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

// Última vez que a pessoa mexeu na tela (captura na fase de captura pra pegar
// também o que acontece dentro de modal).
//
// Clique conta como mexer. Antes só digitar contava, e por isso o cliente que
// montava uma quentinha na Loja Online — que é só CLICAR nos complementos, sem
// digitar nada — era tratado como tela parada: a atualização entrou no meio da
// escolha e levou a sacola junto (aconteceu com o Wilde 23/08/2026 no Zebu).
let ultimoMexeu = 0
for (const evt of ['input', 'keydown', 'paste', 'pointerdown', 'click']) {
  document.addEventListener(evt, () => { ultimoMexeu = Date.now() }, true)
}
const ESFRIAR_MS = 3 * 60 * 1000   // 3 min sem mexer = pode recarregar

// Aparece de verdade na tela? O fundo escuro do menu do celular
// (.sidebar-overlay) fica SEMPRE no HTML, só apagado por opacity/pointer-events —
// contar com ele travaria a atualização pra sempre em todo celular.
function estaVisivel(el) {
  if (!el.getClientRects().length) return false
  const st = getComputedStyle(el)
  if (st.visibility === 'hidden' || st.display === 'none') return false
  if (Number(st.opacity) === 0 || st.pointerEvents === 'none') return false
  return true
}

// Está no meio de alguma coisa? (cursor num campo, mexeu faz pouco, tem um
// modal/gaveta aberto na frente, ou a tela avisou que está ocupada)
function ocupadoPreenchendo() {
  // Qualquer tela pode se declarar ocupada (a Loja Online faz isso enquanto o
  // cliente tem itens na sacola ou está montando um produto).
  if (window.__fwcOcupado === true) return true
  const el = document.activeElement
  const tag = el?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return true
  if (Date.now() - ultimoMexeu < ESFRIAR_MS) return true
  // Modal é modal em qualquer tela — e citar as classes UMA A UMA nunca deu
  // certo: cada tela batizou a sua (.modal-overlay no cadastro de clientes,
  // .pp-modal-overlay no painel, .sal-modal-overlay no salão, .dloja-overlay e
  // .loja-drawer-overlay na Loja Online). A que ficava de fora era sempre a
  // que dava problema: em 31/08/2026 o Wilde estava cadastrando um cliente
  // pelo Vender+ (.pp-modal-overlay, fora da lista) quando a versão nova
  // entrou, recarregou a página e fechou a venda inteira no meio.
  //
  // Agora vale qualquer coisa com "overlay" no nome — mas só se estiver
  // VISÍVEL na tela: overlay que existe no HTML e está escondido seguraria a
  // atualização pra sempre.
  return modalAberto()
}

// Tem modal/gaveta VISÍVEL na frente da pessoa? Overlay escondido no HTML não
// vale — senão ele seguraria a atualização pra sempre.
function modalAberto() {
  const modais = document.querySelectorAll(
    '[aria-modal="true"], [role="dialog"], dialog[open], [class*="overlay" i], .confirmar-fundo'
  )
  for (const el of modais) if (estaVisivel(el)) return true
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
    //
    // Exceção: quem está do lado do CLIENTE (cardápio da Loja Online) não tem
    // nada a ver com versão de sistema. Pra essa pessoa a barra roxa é só um
    // susto no meio do pedido — então a atualização espera calada.
    if (window.__fwcOcupado !== true) mostrarAvisoAtualizacao('preenchendo')
    if (esperandoTelaLivre) return
    // Teto de espera. "Ocupado" que nunca acaba deixava a tela presa numa versão
    // velha pra sempre — e o pior é que ninguém percebe: a pessoa acha que o
    // sistema é assim mesmo. Passados 20 minutos com a atualização parada, ela
    // entra assim que não houver NADA aberto na frente (modal, gaveta) e nenhuma
    // impressora pareada, mesmo com a tela se dizendo ocupada.
    const pedidoEm = Date.now()
    esperandoTelaLivre = setInterval(() => {
      const esperandoDemais = Date.now() - pedidoEm > 20 * 60 * 1000
      if (impressoraBtConectada()) return
      if (ocupadoPreenchendo() && !(esperandoDemais && !modalAberto())) return
      clearInterval(esperandoTelaLivre)
      esperandoTelaLivre = null
      aplicarAtualizacao()
    }, 20 * 1000)
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    const checar = () => registration.update().catch(() => {})
    checar()                             // checa JÁ ao abrir (não espera o 1º intervalo)
    // De 30 em 30 segundos era pedido demais: cada checagem é uma ida ao
    // servidor, e numa internet ruim ela briga com o trabalho de verdade
    // (carregar pedido, fechar conta). 5 minutos + a checagem de quando a
    // pessoa volta pra tela pega a versão nova igual, sem atrapalhar.
    setInterval(checar, 5 * 60 * 1000)
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
