// Impressão de cupom térmico.
//
// Dois modos:
//  1) QZ Tray (recomendado): app grátis instalado no PC. Permite listar as
//     impressoras, escolher qual usar e imprimir SILENCIOSO (sem janela).
//  2) Fallback do navegador (window.print num iframe oculto): usado quando
//     nenhuma impressora foi escolhida ou o QZ Tray não está rodando.

import { separarItem } from '../lib/itensPedido'

const QZ_CDN = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js'

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

function painelConfig() {
  try { return JSON.parse(localStorage.getItem('painelConfig') || '{}') }
  catch { return {} }
}

function larguraCupom() {
  return painelConfig().larguraCupom === '58mm' ? '58mm' : '80mm'
}

function impressoraEscolhida() {
  return painelConfig().impressora || null
}

export function autoImprimirAtivo() {
  return painelConfig().autoImprimir === true
}

function labelPagamento(pedido) {
  const p = pedido.forma_pagamento || ''
  if (p === 'pix') return (pedido.pix_status === 'pago' || pedido.mp_payment_status === 'approved') ? 'PIX (pago)' : 'PIX'
  if (p === 'dinheiro') return 'Dinheiro'
  // Formas que chegam dos pedidos do iFood
  if (p === 'online') return pedido.origem === 'ifood' ? 'PAGO ONLINE (iFood)' : 'Pago online'
  if (p === 'credito') return 'Cartão de crédito'
  if (p === 'debito') return 'Cartão de débito'
  if (p === 'cartao') return 'Cartão'
  if (p === 'vale') return 'Vale-refeição'
  return p || '—'
}

export function montarCupomHtml(pedido, empresa = {}) {
  const largura = larguraCupom()
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const isRetirada = (pedido.tipo_entrega || 'entrega') === 'retirada'
  const endereco = [
    pedido.endereco_rua,
    pedido.endereco_numero,
    pedido.endereco_complemento,
    pedido.endereco_bairro,
    pedido.endereco_cidade,
  ].filter(Boolean).join(', ')
  const numero = pedido.numero_pedido ?? String(pedido.id).slice(-4).toUpperCase()
  const data = new Date(pedido.created_at || Date.now()).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })

  // Configuração do cupom (escolhas da loja, salvas em painelConfig.cupom)
  const c = painelConfig().cupom || {}
  const fontePx = c.fonte === 'grande' ? 15 : 12
  const lgPx = fontePx + 3
  const showTel = c.telCliente !== false
  const showEnd = c.endereco !== false
  const showTaxa = c.taxa !== false
  const showObs = c.obs !== false
  const showCodigo = c.codigo !== false
  const showTotalItens = c.totalItens === true
  const totalItens = itens.reduce((s, it) => s + Number(it.qtd ?? it.quantidade ?? 1), 0)

  const itensHtml = itens.map(item => {
    const qtd = item.qtd ?? item.quantidade ?? 1
    const sub = item.subtotal != null
      ? Number(item.subtotal)
      : qtd * Number(item.preco ?? item.preco_unitario ?? 0)
    const { nome: nomeItem, complementos: comps } = separarItem(item)
    const compsHtml = comps.map(c => {
      // Complemento multiplica pela qtd do prato (4 quentinhas → complemento ×4).
      const cq = Number(c?.qtd ?? 1) * Number(qtd || 1)
      const cn = esc(c?.nome ?? c)
      // Adicional pago (ex.: proteína/porção extra) sai com o valor cobrado.
      const cp = Number(c?.preco ?? 0)
      const precoTxt = cp > 0 ? ` <span class="b">+${fmt(cp * cq)}</span>` : ''
      return `<div class="comp">▸ ${cq > 1 ? cq + 'x ' : ''}${cn}${precoTxt}</div>`
    }).join('')
    const obsHtml = item.observacao ? `<div class="comp">obs: ${esc(item.observacao)}</div>` : ''
    return `<li><div class="row"><span>${esc(qtd)}x ${esc(nomeItem)}</span><span>${fmt(sub)}</span></div>${compsHtml}${obsHtml}</li>`
  }).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>Pedido ${esc(numero)}</title>
<style>
  @page { size: ${largura} auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { width: ${largura}; padding: 4mm 3mm; font-family: 'Courier New', monospace; font-size: ${fontePx}px; line-height: 1.35; color: #000; }
  .center { text-align: center; }
  .b { font-weight: 700; }
  .lg { font-size: ${lgPx}px; }
  hr { border: none; border-top: 1px dashed #000; margin: 5px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row span:last-child { white-space: nowrap; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin-bottom: 4px; }
  .comp { padding-left: 12px; font-size: ${fontePx - 1}px; }
  .ifood { background: #000; color: #fff; text-align: center; font-weight: 800;
           padding: 5px 4px; margin: 0 0 5px; font-size: ${lgPx + 2}px; letter-spacing: 1px; }
</style></head><body>
  ${pedido.origem === 'ifood' ? `<div class="ifood">★ PEDIDO iFOOD ★${pedido.ifood_display_id ? ` Nº ${esc(pedido.ifood_display_id)}` : ''}</div>` : ''}
  <div class="center b lg">${esc(empresa.nome || 'Pedido')}</div>
  ${empresa.telefone ? `<div class="center">${esc(empresa.telefone)}</div>` : ''}
  <hr>
  <div class="row b"><span>PEDIDO #${esc(numero)}</span><span>${esc(data)}</span></div>
  <div class="b">${isRetirada ? 'RETIRADA NA LOJA' : 'ENTREGA'}</div>
  <hr>
  <div><span class="b">Cliente:</span> ${esc(pedido.cliente_nome || '—')}</div>
  ${pedido.cliente_telefone && showTel ? `<div><span class="b">Tel:</span> ${esc(pedido.cliente_telefone)}</div>` : ''}
  ${!isRetirada && endereco && showEnd ? `<div><span class="b">End:</span> ${esc(endereco)}</div>` : ''}
  <hr>
  <ul>${itensHtml || '<li>—</li>'}</ul>
  ${showTotalItens ? `<div class="row b"><span>Total de itens</span><span>${totalItens}</span></div>` : ''}
  <hr>
  ${pedido.subtotal != null ? `<div class="row"><span>Subtotal</span><span>${fmt(pedido.subtotal)}</span></div>` : ''}
  ${!isRetirada && pedido.taxa_entrega != null && showTaxa ? `<div class="row"><span>Taxa entrega</span><span>${fmt(pedido.taxa_entrega)}</span></div>` : ''}
  <div class="row b lg"><span>TOTAL</span><span>${fmt(pedido.total)}</span></div>
  <hr>
  <div><span class="b">Pagamento:</span> ${esc(labelPagamento(pedido))}</div>
  ${pedido.forma_pagamento === 'dinheiro' && Number(pedido.troco_para) > 0 ? `<div>Troco para ${fmt(pedido.troco_para)}</div>` : ''}
  ${pedido.observacoes && showObs ? `<div style="margin-top:4px"><span class="b">Obs:</span> ${esc(pedido.observacoes)}</div>` : ''}
  ${pedido.codigo_entrega && showCodigo ? `<hr><div class="center b">Código de entrega: ${esc(pedido.codigo_entrega)}</div>` : ''}
  <hr>
  <div class="center">Obrigado pela preferência!</div>
  <div style="height:10mm"></div>
</body></html>`
}

// ───────────────────────────── QZ Tray ─────────────────────────────
let _qzLoading = null

function carregarQzLib() {
  if (typeof window !== 'undefined' && window.qz) return Promise.resolve(window.qz)
  if (_qzLoading) return _qzLoading
  _qzLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = QZ_CDN
    s.async = true
    s.onload = () => resolve(window.qz)
    s.onerror = () => { _qzLoading = null; reject(new Error('Falha ao carregar a biblioteca do QZ Tray')) }
    document.head.appendChild(s)
  })
  return _qzLoading
}

async function qzConectar() {
  const qz = await carregarQzLib()
  if (!qz) throw new Error('QZ Tray indisponível')

  // Promise nativa
  if (qz.api?.setPromiseType) qz.api.setPromiseType(resolver => new Promise(resolver))
  // Modo não assinado: resolve certificado/assinatura vazios (QZ pede "Permitir" uma vez)
  if (qz.security?.setCertificatePromise) qz.security.setCertificatePromise(resolve => resolve())
  if (qz.security?.setSignaturePromise) qz.security.setSignaturePromise(() => resolve => resolve())

  if (!qz.websocket.isActive()) {
    await qz.websocket.connect({ retries: 1, delay: 1 })
  }
  return qz
}

// Lista as impressoras instaladas no PC (precisa do QZ Tray rodando).
// Retorna { printers: string[], padrao: string|null }
export async function qzListarImpressoras() {
  const qz = await qzConectar()
  let printers = []
  let padrao = null
  try { printers = await qz.printers.find() } catch { printers = [] }
  try { padrao = await qz.printers.getDefault() } catch { padrao = null }
  if (!Array.isArray(printers)) printers = [printers].filter(Boolean)
  return { printers, padrao }
}

// Indica se o QZ Tray está acessível (app rodando no PC).
export async function qzDisponivel() {
  try { await qzConectar(); return true }
  catch { return false }
}

async function imprimirViaQz(pedido, empresa, printerName) {
  const qz = await qzConectar()
  const larguraMm = larguraCupom() === '58mm' ? 58 : 80
  const config = qz.configs.create(printerName, {
    size: { width: larguraMm, height: null },
    units: 'mm',
    margins: 0,
    rasterize: true,
    colorType: 'blackwhite',
    scaleContent: true,
  })
  const data = [{ type: 'pixel', format: 'html', flavor: 'plain', data: montarCupomHtml(pedido, empresa) }]
  await qz.print(config, data)
}

// ──────────────────── Fallback do navegador (iframe) ────────────────────
function imprimirCupomNavegador(pedido, empresa = {}) {
  const html = montarCupomHtml(pedido, empresa)

  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)

  const doc = iframe.contentWindow.document
  doc.open()
  doc.write(html)
  doc.close()

  setTimeout(() => {
    try {
      iframe.contentWindow.focus()
      iframe.contentWindow.print()
    } catch {
      // ignora falhas de impressão (best-effort)
    }
    setTimeout(() => iframe.remove(), 1500)
  }, 300)
}

// Tenta imprimir pelo app Impressora FWC (127.0.0.1:9110) — a térmica configurada.
// Retorna true se o app imprimiu. Falha rápido se o app não estiver rodando
// (aí cai no QZ/navegador). É por aqui que TODA impressão vai pra térmica do FWC.
// Diz se o app Impressora FWC está rodando NESTE aparelho (127.0.0.1:9110).
// true = é o PC da loja (com térmica). false = celular/tablet sem impressora.
export async function appFwcDisponivel() {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    const r = await fetch('http://127.0.0.1:9110/api/status', { signal: ctrl.signal })
    clearTimeout(t)
    return r.ok
  } catch { return false }
}

async function imprimirViaAppFwc(rota, corpo) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 3500)
    const r = await fetch('http://127.0.0.1:9110/api/' + rota, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo), signal: ctrl.signal,
    })
    clearTimeout(t)
    const j = await r.json().catch(() => ({}))
    return !!(j && j.ok)
  } catch { return false }
}

// Imprime o cupom. Ordem: app Impressora FWC (térmica) → QZ Tray → navegador.
// opts.auto=true → impressão AUTOMÁTICA (pedido novo): o app respeita o dedupe por
// pedido, pra não bater 2 vias quando ele já imprimiu o mesmo pedido pelo tempo
// real. Sem opts.auto (reimpressão manual pelos botões) o app força a impressão.
export async function imprimirCupom(pedido, empresa = {}, opts = {}) {
  if (await imprimirViaAppFwc('imprimir', { pedido, auto: opts.auto === true })) return
  const printer = impressoraEscolhida()
  if (printer) {
    try {
      await imprimirViaQz(pedido, empresa, printer)
      return
    } catch {
      // QZ indisponível / falhou → usa o fallback do navegador
    }
  }
  imprimirCupomNavegador(pedido, empresa)
}

// ──────────────── Impressão genérica de HTML (qualquer cupom) ────────────────
async function imprimirHtmlViaQz(html, printerName) {
  const qz = await qzConectar()
  const larguraMm = larguraCupom() === '58mm' ? 58 : 80
  const config = qz.configs.create(printerName, {
    size: { width: larguraMm, height: null }, units: 'mm', margins: 0,
    rasterize: true, colorType: 'blackwhite', scaleContent: true,
  })
  await qz.print(config, [{ type: 'pixel', format: 'html', flavor: 'plain', data: html }])
}
function imprimirHtmlNavegador(html) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' })
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow.document
  doc.open(); doc.write(html); doc.close()
  setTimeout(() => {
    try { iframe.contentWindow.focus(); iframe.contentWindow.print() } catch { /* best-effort */ }
    setTimeout(() => iframe.remove(), 1500)
  }, 300)
}
// opts.soApp=true → imprime SÓ pelo app FWC (térmica da loja). Se o app não estiver
// disponível (ex.: garçom/admin logado no CELULAR), NÃO cai no navegador do aparelho.
// Usado na conta do salão: ela só pode sair na térmica da loja, nunca no celular.
export async function imprimirHtml(html, titulo, opts = {}) {
  // O app FWC imprime o HTML como TEXTO. Se mandar o <style>/<script>, o CSS sai
  // impresso como código. Então, SÓ pro app, tira esses blocos antes de enviar.
  // (O QZ e o navegador precisam do <style> pra renderizar — esses recebem o html cheio.)
  let htmlParaApp = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
  // O `titulo` sai grande/centralizado no topo (o app faz isso). Se o corpo já tem o
  // nome da loja (titulo-loja), tira dele pra não sair duas vezes na térmica.
  if (titulo) htmlParaApp = htmlParaApp.replace(/<div[^>]*class="[^"]*titulo-loja[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
  if (await imprimirViaAppFwc('imprimir-html', { html: htmlParaApp, titulo })) return true
  if (opts.soApp) return false // sem app FWC local (celular): não imprime no navegador do aparelho
  const printer = impressoraEscolhida()
  if (printer) {
    try { await imprimirHtmlViaQz(html, printer); return true } catch { /* fallback */ }
  }
  imprimirHtmlNavegador(html)
  return true
}

// Comanda de MESA: pede pro app FWC montar nativamente (nome da loja + MESA grandes,
// data, itens com valor). Se o app não responder (ou for versão antiga), cai no HTML
// pelo navegador/QZ. Assim o botão manual do gestor sai igual ao automático.
export async function imprimirComandaMesaApp({ numeroMesa, itens = [], nomeLoja = '', comandaId, area = '', atendente = '', pessoas = 0, rodape = '' }) {
  if (await imprimirViaAppFwc('imprimir-mesa', { numeroMesa, itens, nomeLoja, comandaId })) return
  imprimirHtml(montarComandaCozinhaHtml({ numeroMesa, itens, nomeLoja, area, atendente, pessoas, rodape }))
}

// Comanda da COZINHA (fonte grande) — "pedido sai na cozinha". SEM preço (o preço sai
// depois, na conta). Cabeçalho completo: loja, mesa+salão, data/hora com segundos,
// atendente, nº de pessoas; itens grandes com espaço; rodapé opcional da loja.
export function montarComandaCozinhaHtml({ numeroMesa, itens = [], obsGeral = '', nomeLoja = '', area = '', atendente = '', pessoas = 0, rodape = '' }) {
  const largura = larguraCupom()
  const hora = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  // Comanda da COZINHA: só o que preparar, SEM preço (o preço sai depois, na conta).
  // Cada item tem um tracejado embaixo (espaço bom entre um e outro).
  const linhas = itens.map(it => {
    const q = it.quantidade ?? it.qtd ?? 1
    return `<li><div class="it">${esc(q)} ${esc(it.nome)}</div>${it.observacao ? `<div class="obs">▸ ${esc(it.observacao)}</div>` : ''}<div class="sep"></div></li>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cozinha Mesa ${esc(numeroMesa)}</title>
<style>
  @page { size: ${largura} auto; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { width: ${largura}; padding: 5mm 3mm; font-family: 'Courier New', monospace; color: #000; }
  .loja { font-size: 18px; font-weight: 800; text-align: center; margin-bottom: 2px; }
  .mesa { font-size: 20px; font-weight: 800; text-align: center; }
  .cab { font-size: 14px; text-align: center; line-height: 1.5; margin-bottom: 4px; }
  hr { border: none; border-top: 2px dashed #000; margin: 8px 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin-bottom: 4px; }
  .it { font-size: 24px; font-weight: 800; line-height: 1.25; }
  .obs { font-size: 17px; padding-left: 12px; margin-top: 2px; }
  .sep { border-top: 1px dashed #000; margin: 10px 0 18px; }
  .rodape { text-align: center; font-size: 14px; margin-top: 8px; }
</style></head><body>
  ${nomeLoja ? `<div class="titulo-loja loja">${esc(nomeLoja)}</div>` : ''}
  <div class="mesa">~ Mesa: ${esc(numeroMesa)}${area ? ` (${esc(area)})` : ''} ~</div>
  <div class="cab">
    ${esc(hora)}
    ${atendente ? `<br>Atendente: ${esc(atendente)}` : ''}
    ${Number(pessoas) > 0 ? `<br>Pessoas: ${esc(pessoas)}` : ''}
  </div>
  <hr>
  <ul>${linhas || '<li>—</li>'}</ul>
  ${obsGeral ? `<div class="obs">${esc(obsGeral)}</div>` : ''}
  ${rodape ? `<div class="rodape">${esc(rodape)}</div>` : ''}
  <div style="height:12mm"></div>
</body></html>`
}

// Conta do PRESENCIAL (com preços, taxa e total)
const formaContaLabel = (f) => ({ dinheiro: 'Dinheiro', pix: 'PIX', cartao: 'Cartao', dividido: 'Dividido' }[String(f || '').toLowerCase()] || (f || ''))

export function montarContaPresencialHtml({ numeroMesa, itens = [], subtotal = 0, taxa = 0, total = 0, formaPagamento = '', pagamentos = [], empresa = {} }) {
  const largura = larguraCupom()
  const hora = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  // Mesmo tamanho de fonte do cupom de pedido/teste (respeita a config da loja).
  const fontePx = (painelConfig().cupom || {}).fonte === 'grande' ? 15 : 12
  const lgPx = fontePx + 3
  // Divisória em TRACINHOS (texto): o app FWC apaga <hr>, então itens e totais grudavam.
  const tracos = '-'.repeat(largura === '58mm' ? 32 : 42)
  const linhas = itens.map(it => {
    const q = it.quantidade ?? it.qtd ?? 1
    const sub = it.subtotal != null ? Number(it.subtotal) : q * Number(it.preco_unitario ?? it.preco ?? 0)
    return `<li><div class="row"><span>${esc(q)}x ${esc(it.nome)}</span> <span>${fmt(sub)}</span></div></li>`
  }).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Conta Mesa ${esc(numeroMesa)}</title>
<style>
  @page { size: ${largura} auto; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { width: ${largura}; padding: 4mm 3mm; font-family: 'Courier New', monospace; font-size: ${fontePx}px; line-height: 1.35; color: #000; }
  .center { text-align: center; } .b { font-weight: 700; } .lg { font-size: ${lgPx}px; }
  .hr { white-space: nowrap; overflow: hidden; margin: 3px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  ul { list-style: none; margin: 0; padding: 0; } li { margin-bottom: 3px; }
</style></head><body>
  <div class="titulo-loja center b lg">${esc(empresa.nome || 'Conta')}</div>
  <div class="b">MESA ${esc(numeroMesa)} - ${esc(hora)}</div>
  <div class="hr">${tracos}</div>
  <ul>${linhas || '<li>—</li>'}</ul>
  <div class="hr">${tracos}</div>
  <div class="row"><span>Subtotal</span> <span>${fmt(subtotal)}</span></div>
  ${Number(taxa) > 0 ? `<div class="row"><span>Taxa de serviço</span> <span>${fmt(taxa)}</span></div>` : ''}
  <div class="row b lg"><span>TOTAL</span> <span>${fmt(total)}</span></div>
  ${Array.isArray(pagamentos) && pagamentos.length > 1
    ? `<div class="hr">${tracos}</div><div class="b">DIVISAO DA CONTA</div>` +
      pagamentos.map((p, i) => `<div class="row"><span>Pessoa ${i + 1} (${esc(formaContaLabel(p.forma))})</span> <span>${fmt(p.valor)}</span></div>`).join('') +
      `<div class="row b"><span>Total pago</span> <span>${fmt(pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0))}</span></div>`
    : formaPagamento ? `<div class="hr">${tracos}</div><div><span class="b">Pagamento:</span> ${esc(formaContaLabel(formaPagamento))}</div>` : ''}
  <div class="hr">${tracos}</div>
  <div class="center">Obrigado pela preferencia!</div>
  <div style="height:10mm"></div>
</body></html>`
}
