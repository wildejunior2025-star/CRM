// ============================================================================
// Impressão via Web Bluetooth (BLE) — ISOLADO do sistema principal.
// Para a loja que imprime SÓ pelo celular numa térmica Bluetooth, usando o
// Chrome do Android. NÃO mexe em imprimirCupom.js (FWC/QZ/navegador) — é um
// caminho separado, ligado só pelo botão "Impressora celular" do gestor.
//
// ⚠️ Web Bluetooth só conversa com impressoras Bluetooth "BLE". Impressoras
// "Bluetooth Classic" (SPP) NÃO aparecem aqui — nesse caso, usar o app RawBT.
// ============================================================================
import { separarItem } from '../lib/itensPedido'

const LARGURA = 48 // 80mm = 48 colunas
const ESC = 0x1b, GS = 0x1d

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
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
const fmt = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',')

export const estaConectada = () => !!(_car && _device?.gatt?.connected)
export const nomeImpressora = () => _device?.name || null

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
  _device.addEventListener('gattserverdisconnected', () => { _car = null })
  const server = await _device.gatt.connect()
  _car = await acharCaracteristica(server)
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
      const server = await _device.gatt.connect()
      _car = await acharCaracteristica(server)
      if (estaConectada()) return true
    }
    if (!navigator.bluetooth.getDevices) return false
    const salvos = await navigator.bluetooth.getDevices()
    if (!salvos?.length) return false
    let alvoId = null; try { alvoId = localStorage.getItem(LS_DEV) } catch { /* ok */ }
    const dev = salvos.find(d => d.id === alvoId) || salvos[0]
    if (!dev) return false
    _device = dev
    _device.addEventListener('gattserverdisconnected', () => { _car = null })
    const server = await _device.gatt.connect()
    _car = await acharCaracteristica(server)
    return estaConectada()
  } catch { return false }
}

async function garantirConectado() {
  if (estaConectada()) return
  if (await reconectarSilencioso()) return   // tenta religar sozinho antes de pedir
  await conectarImpressoraCelular()
}

// BLE tem MTU pequeno — manda em pedaços.
async function escrever(bytes) {
  const TAM = 180
  for (let i = 0; i < bytes.length; i += TAM) {
    const chunk = bytes.slice(i, i + TAM)
    if (_car.writeValueWithoutResponse) await _car.writeValueWithoutResponse(chunk)
    else await _car.writeValue(chunk)
    await new Promise(r => setTimeout(r, 18)) // respiro entre pacotes
  }
}

// ── montagem do cupom em ESC/POS ────────────────────────────────────────
class B {
  constructor() { this.parts = [] }
  raw(a) { this.parts.push(new Uint8Array(a)); return this }
  txt(s) { this.parts.push(enc(semAcento(s))); return this }
  nl(n = 1) { return this.raw(Array(n).fill(0x0a)) }
  center() { return this.raw([ESC, 0x61, 1]) }
  left() { return this.raw([ESC, 0x61, 0]) }
  big(on) { return this.raw([GS, 0x21, on ? 0x11 : 0x00]) }
  bold(on) { return this.raw([ESC, 0x45, on ? 1 : 0]) }
  init() { return this.raw([ESC, 0x40]) }
  cut() { return this.raw([GS, 0x56, 0x00]) }
  line() { return this.txt('-'.repeat(LARGURA)).nl() }
  row(a, b) { a = semAcento(a); b = semAcento(b); const e = Math.max(1, LARGURA - a.length - b.length); return this.txt(a + ' '.repeat(e) + b).nl() }
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
    b.row(`${qtd}x ${nome}`, fmt(sub))
    for (const c of complementos) {
      const cq = Number(c?.qtd ?? 1) * Number(qtd || 1)
      const cp = Number(c?.preco ?? 0)
      b.txt(`  > ${cq > 1 ? cq + 'x ' : ''}${semAcento(c?.nome ?? c)}${cp > 0 ? ' +' + fmt(cp * cq) : ''}`).nl()
    }
    if (item.observacao) b.txt('  obs: ' + semAcento(item.observacao)).nl()
  }
  b.line()
  if (pedido.subtotal != null) b.row('Subtotal', fmt(pedido.subtotal))
  if (!isRetirada && pedido.taxa_entrega != null) b.row('Taxa entrega', fmt(pedido.taxa_entrega))
  b.big(true).row('TOTAL', fmt(pedido.total)).big(false)
  b.line()
  b.txt('Pagamento: ' + (pedido.forma_pagamento || '-')).nl()
  if (pedido.forma_pagamento === 'dinheiro' && Number(pedido.troco_para) > 0) b.txt('Troco para ' + fmt(pedido.troco_para)).nl()
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
