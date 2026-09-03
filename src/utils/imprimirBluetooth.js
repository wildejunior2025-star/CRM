// ============================================================================
// Impressão via Web Bluetooth (BLE) — ISOLADO do sistema principal.
// Para a loja que imprime SÓ pelo celular numa térmica Bluetooth, usando o
// Chrome do Android. NÃO mexe em imprimirCupom.js (FWC/navegador) — é um
// caminho separado, ligado só pelo botão "Impressora celular" do gestor.
//
// ⚠️ Web Bluetooth só conversa com impressoras Bluetooth "BLE". Impressoras
// "Bluetooth Classic" (SPP) NÃO aparecem aqui — nesse caso, usar o app RawBT.
// ============================================================================
import { separarItem } from '../lib/itensPedido'

const ESC = 0x1b, GS = 0x1d

// Largura e fonte saem da MESMA configuração do painel que o cupom do PC usa
// ('painelConfig' no navegador). Antes a Bluetooth ignorava as duas — tinha 48
// colunas cravadas no código. Numa térmica de 58 mm (32 colunas) a linha do
// preço batia na borda e quebrava; e quem escolhia "fonte Grande" pra enxergar
// melhor não via diferença nenhuma. Os dois botões pareciam enfeite, mas eram
// só desligados deste caminho.
function painelConfig() {
  try { return JSON.parse(localStorage.getItem('painelConfig') || '{}') }
  catch { return {} }
}
const colunas = () => (painelConfig().larguraCupom === '58mm' ? 32 : 48)
const fonteGrande = () => (painelConfig().cupom || {}).fonte === 'grande'

// UUIDs comuns de módulos Bluetooth de impressora térmica (precisam estar no
// optionalServices pra o Web Bluetooth liberar o acesso ao serviço).
const SERVICOS = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ff12-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC/Microchip (BLE serial)
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ae30-0000-1000-8000-00805f9b34fb',
]

let _device = null
let _car = null
const LS_DEV = 'bt_printer_id' // id do aparelho autorizado — pra religar sozinho depois

const suporta = () => typeof navigator !== 'undefined' && !!navigator.bluetooth
const enc = (s) => new TextEncoder().encode(s)
// A térmica lê a tabela dela (CP437), não UTF-8: todo caractere fora do ASCII
// vira lixo no papel — foi o "2Ã-" no lugar de "2×" na comanda dos pastéis.
// Tirar acento não bastava, porque × e – não são acento. Aqui os símbolos
// comuns viram o parente ASCII e o resto cai fora, em vez de sujar a linha.
const trocaSimbolos = (s) => String(s ?? '')
  .replace(/[×✕✖]/g, 'x').replace(/[–—−]/g, '-')
  .replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'")
  .replace(/…/g, '...').replace(/[ºᵒ°]/g, 'o').replace(/ª/g, 'a')
  .replace(/€/g, 'EUR').replace(/[   ]/g, ' ')
const semAcento = (s) => trocaSimbolos(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^\x00-\x7F]/g, '')
const fmt = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',')

export const estaConectada = () => !!(_car && _device?.gatt?.connected)
export const nomeImpressora = () => _device?.name || null

// Bandeira lida pelo main.jsx: enquanto a impressora estiver ligada, o app NÃO
// se atualiza sozinho. Recarregar a página mata a conexão BLE e reparear exige
// um toque do dono — no meio do movimento a loja ficava sem imprimir sem saber
// por quê (era isso que derrubava a impressora a cada deploy).
function marcarEstado() {
  try { window.__fwcBtConectada = estaConectada() } catch { /* ok */ }
}

// ── Manter viva ─────────────────────────────────────────────────────────────
// A térmica cai sozinha: o Android desliga o GATT quando a aba sai da frente, e
// a própria impressora derruba o link depois de um tempo sem receber nada.
//
// Antes, quem religava era só o painel da Impressora — e ele só existe enquanto
// aquela aba está aberta. Bastava o dono ir em Mesas e voltar pro Salão pra
// impressora ficar "desligada" sem ninguém tentar religar (aconteceu com o
// Wilde 23/08/2026). Agora quem cuida disso é o módulo, o tempo todo, esteja
// qual aba estiver aberta.
let _religarTimer = null
let _vigiando = false

const temImpressoraConhecida = () => {
  if (_device) return true
  try { return !!localStorage.getItem(LS_DEV) } catch { return false }
}

function ouvirQueda(dev) {
  if (!dev || dev.__fwcOuvindo) return   // sem isto, cada religada empilhava um ouvinte novo
  dev.__fwcOuvindo = true
  dev.addEventListener('gattserverdisconnected', () => {
    _car = null
    marcarEstado()
    agendarReligar(0)
  })
  // Impressora ligada = estação de impressão = tela acesa.
  segurarTela()
}

function agendarReligar(tentativa = 0) {
  if (_religarTimer || !temImpressoraConhecida()) return
  const espera = Math.min(30_000, 1000 * 2 ** tentativa)  // 1s, 2s, 4s… até 30s
  _religarTimer = setTimeout(async () => {
    _religarTimer = null
    if (estaConectada()) return
    const ok = await reconectarSilencioso()
    if (!ok && tentativa < 6) agendarReligar(tentativa + 1)
  }, espera)
}

// ── Tela acesa enquanto a impressora estiver ligada ─────────────────────────
// O celular da impressora é a ESTAÇÃO: o garçom lança do aparelho dele e quem
// imprime é este. Só que Android com a tela apagada suspende a aba — e aba
// suspensa não recebe o aviso do pedido novo nem mantém a conexão Bluetooth.
// O papel simplesmente não sai, sem erro nenhum na tela.
//
// Enquanto a térmica estiver conectada, seguramos a tela acesa. É a mesma coisa
// que o app de GPS faz. Sem impressora conectada, o celular dorme normal.
let _telaPresa = null

async function segurarTela() {
  try {
    if (!('wakeLock' in navigator)) return          // navegador antigo: sem isso
    if (_telaPresa && !_telaPresa.released) return  // já está segura
    if (document.visibilityState !== 'visible') return
    _telaPresa = await navigator.wakeLock.request('screen')
    _telaPresa.addEventListener('release', () => { _telaPresa = null })
  } catch { /* negado pelo usuário/sistema — segue sem */ }
}

function soltarTela() {
  try { _telaPresa?.release() } catch { /* ok */ }
  _telaPresa = null
}

export const telaEstaPresa = () => !!(_telaPresa && !_telaPresa.released)

// Vigia global (uma vez só na vida da página).
function vigiar() {
  if (_vigiando || typeof window === 'undefined') return
  _vigiando = true
  const acordar = () => {
    if (!temImpressoraConhecida()) { soltarTela(); return }
    // O sistema solta a trava sozinho quando a tela some; reconquista ao voltar.
    if (estaConectada()) { segurarTela(); return }
    agendarReligar(0)
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acordar() })
  window.addEventListener('focus', acordar)
  window.addEventListener('online', acordar)
  // Batida de 20s: o evento de queda nem sempre chega quando o Android mata o
  // GATT em segundo plano — aí só olhando é que se descobre.
  setInterval(acordar, 20_000)
}

async function acharCaracteristica(server) {
  const servicos = await server.getPrimaryServices()
  for (const s of servicos) {
    let cars = []
    try { cars = await s.getCharacteristics() } catch { continue }
    for (const c of cars) if (c.properties.write || c.properties.writeWithoutResponse) return c
  }
  return null
}

// Precisa ser chamada a partir de um clique (gesto do usuário).
export async function conectarImpressoraCelular() {
  if (!suporta()) throw new Error('Este navegador não tem Bluetooth. Abra pelo Chrome no Android (não pelo app).')
  _device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICOS })
  try { localStorage.setItem(LS_DEV, _device.id) } catch { /* ok */ }
  ouvirQueda(_device)
  const server = await _device.gatt.connect()
  _car = await acharCaracteristica(server)
  marcarEstado()
  vigiar()
  if (!_car) throw new Error('Conectei, mas não achei o canal de impressão — pode ser Bluetooth "Classic". Nesse caso use o RawBT.')
  return true
}

// Religa SEM pedir de novo. Cobre os 2 casos de quando o Android derruba o BT:
//  - aba só suspensa (device ainda na memória) → reconecta o gatt
//  - aba recarregada (perdeu o device) → recupera pelo getDevices() (aparelhos
//    que o site já autorizou), sem o prompt de seleção.
// Retorna true se religou; false se não deu — nunca lança (não atrapalha nada).
export async function reconectarSilencioso() {
  if (!suporta()) return false
  if (estaConectada()) return true
  try {
    if (_device?.gatt) {
      ouvirQueda(_device)
      const server = await _device.gatt.connect()
      _car = await acharCaracteristica(server)
      marcarEstado()
      if (estaConectada()) { vigiar(); return true }
    }
    if (!navigator.bluetooth.getDevices) return false
    const salvos = await navigator.bluetooth.getDevices()
    if (!salvos?.length) return false
    let alvoId = null; try { alvoId = localStorage.getItem(LS_DEV) } catch { /* ok */ }
    const dev = salvos.find(d => d.id === alvoId) || salvos[0]
    if (!dev) return false
    _device = dev
    ouvirQueda(_device)
    const server = await _device.gatt.connect()
    _car = await acharCaracteristica(server)
    marcarEstado()
    if (estaConectada()) { vigiar(); return true }
    return false
  } catch { marcarEstado(); return false }
}

async function garantirConectado() {
  if (estaConectada()) return
  if (await reconectarSilencioso()) return   // tenta religar sozinho antes de pedir
  await conectarImpressoraCelular()
}

// BLE tem MTU pequeno — manda em pedaços.
// A térmica BLE engasga quando o pacote chega rápido demais: o navegador
// devolve NetworkError / InvalidStateError num pacote do meio e a impressão
// INTEIRA era dada como perdida — mesmo com o papel já saindo, porque a
// impressora imprime o que recebeu. Era isso que fazia o Salão gritar
// "o papel não saiu" com a comanda na mão do cozinheiro.
//
// Tenta o MESMO pacote de novo, com pausa crescente, antes de desistir.
async function escreverChunk(chunk, tentativas = 3) {
  for (let t = 1; t <= tentativas; t++) {
    try {
      if (_car.writeValueWithoutResponse) await _car.writeValueWithoutResponse(chunk)
      else await _car.writeValue(chunk)
      return
    } catch (e) {
      if (t === tentativas) throw e
      await new Promise(r => setTimeout(r, 60 * t))
    }
  }
}

async function escrever(bytes) {
  const TAM = 180
  for (let i = 0; i < bytes.length; i += TAM) {
    await escreverChunk(bytes.slice(i, i + TAM))
    await new Promise(r => setTimeout(r, 18)) // respiro entre pacotes
  }
}

// ── montagem do cupom em ESC/POS ────────────────────────────────────────
class B {
  constructor() {
    this.parts = []
    this.cols = colunas()
  }
  raw(a) { this.parts.push(new Uint8Array(a)); return this }
  txt(s) { this.parts.push(enc(semAcento(s))); return this }
  nl(n = 1) { return this.raw(Array(n).fill(0x0a)) }
  center() { return this.raw([ESC, 0x61, 1]) }
  left() { return this.raw([ESC, 0x61, 0]) }
  big(on) { return this.raw([GS, 0x21, on ? 0x11 : 0x00]) }
  bold(on) { return this.raw([ESC, 0x45, on ? 1 : 0]) }
  init() { return this.raw([ESC, 0x40]) }
  cut() { return this.raw([GS, 0x56, 0x00]) }
  line() { return this.txt('-'.repeat(this.cols)).nl() }
  row(a, b) {
    a = semAcento(a); b = semAcento(b)
    // Não cabe na largura? Quebra em duas linhas com o valor à direita, em vez
    // de deixar o papel embolar o nome com o preço.
    if (a.length + b.length + 1 > this.cols) {
      this.txt(a).nl()
      return this.txt(' '.repeat(Math.max(0, this.cols - b.length)) + b).nl()
    }
    return this.txt(a + ' '.repeat(this.cols - a.length - b.length) + b).nl()
  }
  // "Fonte grande" do painel: dobra a altura da letra sem dobrar a largura, que
  // em 32 colunas cortaria metade do nome do produto.
  alto(on) { return this.raw([GS, 0x21, on ? (fonteGrande() ? 0x01 : 0x00) : 0x00]) }
  build() { const len = this.parts.reduce((s, p) => s + p.length, 0); const u = new Uint8Array(len); let o = 0; for (const p of this.parts) { u.set(p, o); o += p.length } return u }
}

export function montarCupomBytes(pedido, empresa = {}) {
  const b = new B().init()
  const isRetirada = (pedido.tipo_entrega || 'entrega') === 'retirada'
  const numero = pedido.numero_pedido ?? String(pedido.id).slice(-4)
  const hora = new Date(pedido.created_at || Date.now()).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  b.center().big(true).txt(empresa.nome || 'Pedido').nl().big(false)
  if (empresa.telefone) b.txt(empresa.telefone).nl()
  b.left().line()
  b.bold(true).row('PEDIDO #' + numero, hora).bold(false)
  b.txt(isRetirada ? 'RETIRADA NA LOJA' : 'ENTREGA').nl()
  b.line()
  b.txt('Cliente: ' + (pedido.cliente_nome || '-')).nl()
  if (pedido.cliente_telefone) b.txt('Tel: ' + pedido.cliente_telefone).nl()
  if (!isRetirada) {
    const end = [pedido.endereco_rua, pedido.endereco_numero, pedido.endereco_complemento, pedido.endereco_bairro, pedido.endereco_cidade].filter(Boolean).join(', ')
    if (end) b.txt('End: ' + end).nl()
  }
  b.line()
  for (const item of (Array.isArray(pedido.itens) ? pedido.itens : [])) {
    const qtd = item.qtd ?? item.quantidade ?? 1
    const sub = item.subtotal != null ? Number(item.subtotal) : qtd * Number(item.preco ?? item.preco_unitario ?? 0)
    const { nome, complementos } = separarItem(item)
    b.alto(true).row(`${qtd} ${nome}`, fmt(sub)).alto(false)
    for (const c of complementos) {
      const cq = Number(c?.qtdTotal ?? 1)
      const cp = Number(c?.preco ?? 0)
      // Sem o "x", igual ao card do gestor: "5 Milho verde".
      b.txt(`  > ${cq} ${semAcento(c?.nome ?? c)}${cp > 0 ? ' +' + fmt(cp * cq) : ''}`).nl()
    }
    if (item.observacao) b.txt('  obs: ' + semAcento(item.observacao)).nl()
  }
  b.line()
  if (pedido.subtotal != null) b.row('Subtotal', fmt(pedido.subtotal))
  if (!isRetirada && pedido.taxa_entrega != null) b.row('Taxa entrega', fmt(pedido.taxa_entrega))
  b.big(true).row('TOTAL', fmt(pedido.total)).big(false)
  b.line()
  b.txt('Pagamento: ' + (pedido.forma_pagamento || '-')).nl()
  if (pedido.forma_pagamento === 'dinheiro') {
    const trocoPara = Number(pedido.troco_para || 0)
    if (trocoPara > 0) {
      // big() dobra a LARGURA e, em 32 colunas, cortaria a frase no meio.
      b.bold(true).alto(true).txt('LEVAR TROCO DE ' + fmt(Math.max(0, trocoPara - Number(pedido.total || 0)))).nl().alto(false).bold(false)
      b.txt('(cliente paga com ' + fmt(trocoPara) + ')').nl()
    } else b.txt('(troco nao informado - confirmar)').nl()
  }
  if (pedido.observacoes) b.txt('Obs: ' + semAcento(pedido.observacoes)).nl()
  if (pedido.codigo_entrega) b.line().center().txt('Codigo: ' + pedido.codigo_entrega).nl().left()
  b.line().center().txt('Obrigado pela preferencia!').nl().left()
  b.nl(4).cut()
  return b.build()
}

// Imprime um pedido na térmica Bluetooth. Conecta se ainda não estiver.
export async function imprimirPedidoCelular(pedido, empresa = {}) {
  await garantirConectado()
  await escrever(montarCupomBytes(pedido, empresa))
}

// Cupom de teste (pra validar a conexão).
export async function imprimirTesteCelular(empresa = {}) {
  await garantirConectado()
  const b = new B().init().center().big(true).txt(empresa.nome || 'TESTE').nl().big(false)
    .txt('Impressora celular OK!').nl().left().line().txt('Se voce leu isso, funcionou.').nl().nl(4).cut()
  await escrever(b.build())
}

// ── MESA / SALÃO ─────────────────────────────────────────────────────────────
// Só o delivery passava pela Bluetooth: a loja que imprime pelo celular ficava
// sem comanda de cozinha e sem conta de mesa, e ninguém entendia por quê (o
// caminho de mesa ia direto pro app FWC / navegador, que no celular não existe).
// Aqui vão as duas em ESC/POS, com o mesmo conteúdo das versões em HTML.

const formaLabel = (f) => ({
  dinheiro: 'Dinheiro', pix: 'PIX', credito: 'Credito', debito: 'Debito',
  cartao: 'Cartao', dividido: 'Dividido', fiado: 'Fiado',
}[String(f || '').toLowerCase()] || (f || ''))

// Comanda da COZINHA: só o que preparar, SEM preço (o preço sai depois, na
// conta). Item em letra grande — quem lê está de longe, no meio do movimento.
export function montarComandaMesaBytes({
  numeroMesa, rotulo = '', nomeLoja = '', area = '', atendente = '',
  pessoas = 0, rodape = '', obsGeral = '', itens = [],
}) {
  const titulo = rotulo || `Mesa: ${numeroMesa}`
  const hora = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const b = new B().init().center()
  if (nomeLoja) b.bold(true).txt(nomeLoja).nl().bold(false)
  b.big(true).txt(`~ ${titulo}${area ? ` (${area})` : ''} ~`).nl().big(false)
  b.txt(hora).nl()
  if (atendente) b.txt('Atendente: ' + atendente).nl()
  if (Number(pessoas) > 0) b.txt('Pessoas: ' + pessoas).nl()
  b.left().line()
  for (const it of itens) {
    const q = it.quantidade ?? it.qtd ?? 1
    // Os sabores saem em LINHA PRÓPRIA, como no cupom de delivery. Colados no
    // nome viravam um bloco só — "6 Porcao de Pastel (escolha os sabores)
    // (Carne Moida, 2x Queijo, 2x Frango...)" quebrando no meio da palavra, e
    // o cozinheiro não achava quantos de cada sabor eram.
    const { nome, complementos } = separarItem(it)
    b.big(true).bold(true).txt(`${q} ${semAcento(nome)}`).nl().bold(false).big(false)
    for (const c of complementos) {
      const cn = semAcento(c?.nome ?? c)
      if (!cn) continue
      // Alto (não largo) pra caber o sabor inteiro na linha e ainda ler de longe.
      b.alto(true).bold(true).txt(`  ${Number(c?.qtdTotal ?? 1)} ${cn}`).nl().bold(false).alto(false)
    }
    if (it.observacao) b.txt('   > ' + semAcento(it.observacao)).nl()
    b.nl()
  }
  if (!itens.length) b.txt('—').nl()
  if (obsGeral) b.line().txt(semAcento(obsGeral)).nl()
  if (rodape) b.line().center().txt(semAcento(rodape)).nl().left()
  b.nl(4).cut()
  return b.build()
}

// CONTA da mesa: com preços, taxa, total e divisão.
export function montarContaMesaBytes({
  numeroMesa, rotulo = '', itens = [], subtotal = 0, taxa = 0, total = 0,
  formaPagamento = '', pagamentos = [], empresa = {}, preConta = false,
}) {
  const titulo = (rotulo || `MESA ${numeroMesa}`).toUpperCase()
  const hora = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const b = new B().init().center().big(true).txt(empresa.nome || 'Conta').nl().big(false)
  if (preConta) b.bold(true).txt('** PRE-CONTA **').nl().bold(false)
  b.left().bold(true).txt(`${titulo} - ${hora}`).nl().bold(false)
  b.line()
  for (const it of itens) {
    const q = it.quantidade ?? it.qtd ?? 1
    const sub = it.subtotal != null
      ? Number(it.subtotal)
      : q * Number(it.preco_unitario ?? it.preco ?? 0)
    // Couvert e afins saem marcados, igual à conta impressa no PC (mig 0192).
    const isento = it.isento_taxa === true ? ' (isento de taxa)' : ''
    b.alto(true).row(`${q}x ${it.nome}${isento}`, fmt(sub)).alto(false)
  }
  if (!itens.length) b.txt('—').nl()
  b.line()
  b.row('Subtotal', fmt(subtotal))
  if (Number(taxa) > 0) b.row('Taxa de servico', fmt(taxa))
  b.big(true).row('TOTAL', fmt(total)).big(false)
  if (Array.isArray(pagamentos) && pagamentos.length > 1) {
    b.line().bold(true).txt('DIVISAO DA CONTA').nl().bold(false)
    pagamentos.forEach((p, i) => {
      b.row(`${p.nome || 'Pessoa ' + (i + 1)} (${formaLabel(p.forma)})`, fmt(p.valor))
    })
    b.bold(true).row('Total pago', fmt(pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0))).bold(false)
  } else if (formaPagamento && !preConta) {
    b.line().txt('Pagamento: ' + formaLabel(formaPagamento)).nl()
  }
  b.line().center()
  if (preConta) b.bold(true).txt('CONFERENCIA - NAO E COMPROVANTE').nl().bold(false).txt('Confira os itens antes de pagar').nl()
  else b.txt('Obrigado pela preferencia!').nl()
  b.left().nl(4).cut()
  return b.build()
}

export async function imprimirComandaMesaCelular(dados) {
  await garantirConectado()
  await escrever(montarComandaMesaBytes(dados))
}

export async function imprimirContaMesaCelular(dados) {
  await garantirConectado()
  await escrever(montarContaMesaBytes(dados))
}

// Atalho pra quem só quer saber "deu pra imprimir na térmica do celular?".
// Devolve false sem estourar quando não tem impressora ligada — aí quem chamou
// segue pro caminho normal (app FWC / navegador). É o que deixa a MESMA tela
// funcionar no PC da loja e no celular do dono sem dois códigos diferentes.
// Devolve O QUE ACONTECEU, não um sim/não:
//
//   'ok'        saiu o papel
//   'filtrado'  esta impressora não é a deste documento (aparelho marcado como
//               cozinha recebendo uma conta, ou comanda sem item do setor dele)
//   false       não deu: sem conexão ou erro no envio
//
// 'filtrado' continua sendo VERDADEIRO pra quem só testa `if (ok)` — quem chama
// não deve tentar de novo por outro caminho, senão sai via dupla. A diferença
// importa pra TELA: dizer "enviada pra impressora" quando o aparelho estava
// marcado como cozinha é mentira, e foi o que fez a segunda via "sumir" no bar.
export async function imprimirMesaSeConectada(tipo, dados) {
  // Sem conexão NADA foi enviado — este é o único caso em que dá pra afirmar
  // que não saiu papel.
  if (!estaConectada() && !(await reconectarSilencioso())) return false
  try {
    if (tipo === 'comanda') {
      const meus = itensDoSetor(dados.itens ?? [])
      if (!meus.length) return 'filtrado'
      await escrever(montarComandaMesaBytes({ ...dados, itens: meus }))
    } else {
      if (!imprimeConta()) return 'filtrado'   // conta é papel da frente
      await escrever(montarContaMesaBytes(dados))
    }
    return 'ok'
  } catch {
    // Erro DEPOIS de começar a enviar pra uma impressora conectada. A térmica
    // imprime o que recebe, então na prática o papel saiu (inteiro ou quase) —
    // era este caso que fazia o Salão gritar "não saiu" com a comanda já na mão
    // do cozinheiro. Não é sucesso, mas também não é motivo de alarme: quem
    // chamar decide, e o botão Reimprimir continua ali.
    return 'parcial'
  }
}

// ── Papel deste aparelho (mig 0184) ─────────────────────────────────────────
// Loja com duas térmicas: um celular fica na frente com a impressora do salão,
// outro na cozinha com a dela. Cada aparelho guarda no próprio navegador o que
// imprime — igual ao pareamento, que também é por aparelho.
//
// 'tudo' é o padrão e é o comportamento de sempre (uma impressora só). Ninguém
// que já usa precisa configurar nada.
const LS_SETOR = 'impressora_setor'   // 'tudo' | 'cozinha' | 'frente'

export function setorDaImpressora() {
  try {
    const v = localStorage.getItem(LS_SETOR)
    return v === 'cozinha' || v === 'frente' ? v : 'tudo'
  } catch { return 'tudo' }
}

export function definirSetorDaImpressora(v) {
  try { localStorage.setItem(LS_SETOR, v === 'cozinha' || v === 'frente' ? v : 'tudo') } catch { /* ok */ }
}

// Dos itens que acabaram de ser pedidos, quais são DESTA impressora?
//
// 'nenhum' fica de fora SEMPRE, até quando a loja tem uma impressora só: é a
// categoria que a loja marcou como "não precisa de papel" (o garçom pega a
// bebida e dá baixa no celular dele). Imprimir mesmo assim seria ignorar a
// escolha dela.
//
// Item sem setor (pedido antigo, produto sem categoria) conta como salão — a
// regra é "salão sai tudo, menos o que é da cozinha", então nada some.
const setorDoItem = (i) => (i.setor === 'cozinha' || i.setor === 'nenhum') ? i.setor : 'frente'

export function itensDoSetor(itens = []) {
  const papel = setorDaImpressora()
  const imprimiveis = itens.filter(i => setorDoItem(i) !== 'nenhum')
  if (papel === 'tudo') return imprimiveis
  return imprimiveis.filter(i => setorDoItem(i) === papel)
}

// Conta, pré-conta e fechamento são papel da FRENTE: quem cobra é o caixa, não
// a cozinha. Numa impressora só ('tudo'), sai aqui mesmo como sempre.
export const imprimeConta = () => setorDaImpressora() !== 'cozinha'

// ── O que ESTA impressora imprime, por origem ───────────────────────────────
// O app FWC do PC já tinha isso (guardado no config do app). A Bluetooth não
// respeitava — e nem tinha como: aqueles botões moram DENTRO do app, e no
// celular o app não existe. Então a Bluetooth ganha a lista dela, no próprio
// navegador, igual ao pareamento e ao setor.
//
// Serve pra loja com dois celulares: o da cozinha imprime só Mesa, o da frente
// imprime o resto. Origem que não está na lista imprime — o padrão é imprimir
// tudo, e ninguém precisa configurar nada.
const LS_ORIGENS = 'impressora_origens'

export function origensDaImpressora() {
  try { return JSON.parse(localStorage.getItem(LS_ORIGENS) || '{}') }
  catch { return {} }
}

export function definirOrigemDaImpressora(origem, ligada) {
  try {
    localStorage.setItem(LS_ORIGENS, JSON.stringify({ ...origensDaImpressora(), [origem]: !!ligada }))
  } catch { /* ok */ }
}

// Só `false` desliga. Origem desconhecida ou nunca mexida = imprime.
export function imprimeOrigem(origem) {
  const k = String(origem || '').toLowerCase()
  return origensDaImpressora()[k] !== false
}
