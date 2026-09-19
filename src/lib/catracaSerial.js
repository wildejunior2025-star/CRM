// Catraca eletromecânica ligada no PC por cabo USB-serial (a da primeira
// academia: SCA usava o driver "scaEletroMecanica", porta COM3, adaptador
// FTDI). Não tem protocolo: o PC liga um pino de sinal do cabo (DTR ou RTS)
// por alguns segundos, o relé fecha e a trava solta.
//
// Usa a Web Serial do Chrome no computador (não existe no iPad/celular).
// A primeira vez precisa escolher a porta num toque; depois o Chrome lembra.

export const serialSuportado = () => typeof navigator !== 'undefined' && 'serial' in navigator

let porta = null

// Porta já autorizada antes (sem pedir de novo).
export async function portaLembrada() {
  if (!serialSuportado()) return null
  const portas = await navigator.serial.getPorts()
  return portas[0] || null
}

// Pede pra escolher a porta (tem que ser no toque de um botão).
export async function escolherPorta() {
  return navigator.serial.requestPort()
}

export async function abrirPorta(p, baudRate = 9600) {
  if (porta === p && p.readable) return p
  if (porta && porta !== p) await fecharPorta()
  await p.open({ baudRate })
  porta = p
  // Ao abrir, o Windows costuma ligar DTR e RTS sozinho — o que pode soltar a
  // trava sem ninguém pedir. Desliga os dois logo de cara.
  await p.setSignals({ dataTerminalReady: false, requestToSend: false })
  return p
}

export async function fecharPorta() {
  if (!porta) return
  try { await porta.close() } catch { /* já fechada */ }
  porta = null
}

export function portaAberta() {
  return porta
}

// Liga o(s) pino(s) por `ms` milissegundos e desliga.
export async function pulso({ dtr = false, rts = false, ms = 3000 } = {}) {
  if (!porta) throw new Error('Porta da catraca não está aberta.')
  await porta.setSignals({ dataTerminalReady: dtr, requestToSend: rts })
  await new Promise(r => setTimeout(r, ms))
  await porta.setSignals({ dataTerminalReady: false, requestToSend: false })
}

// Manda bytes crus (pra catraca que abre com comando em vez de pino).
export async function enviarBytes(bytes) {
  if (!porta) throw new Error('Porta da catraca não está aberta.')
  const w = porta.writable.getWriter()
  try { await w.write(new Uint8Array(bytes)) } finally { w.releaseLock() }
}

// Configuração que funcionou, guardada neste computador.
const CHAVE = 'academia_catraca_config'
// O que destravou a catraca eletromecânica da primeira academia no teste de
// 19/09/2026 (botão "DTR + RTS juntos"). Vale quando ninguém guardou outro.
const PADRAO = { tipo: 'pino', dtr: true, rts: true, ms: 3000, baudRate: 9600, nome: 'DTR + RTS juntos' }
export function lerConfigCatraca() {
  try { return JSON.parse(localStorage.getItem(CHAVE)) || PADRAO } catch { return PADRAO }
}
export function salvarConfigCatraca(cfg) {
  try { localStorage.setItem(CHAVE, JSON.stringify(cfg)) } catch { /* só não lembra */ }
}

// Deixa a porta da catraca aberta e pronta (a recepção chama ao começar).
// Erro vem com o motivo em português pra aparecer na tela.
export async function conectarCatraca() {
  const cfg = lerConfigCatraca()
  if (!serialSuportado()) throw new Error('Este navegador não fala com a catraca (use o Chrome do computador).')
  if (!cfg) throw new Error('Catraca não configurada neste computador. Vá em "Catraca" e aperte "foi esse!".')
  if (porta) return
  const p = await portaLembrada()
  if (!p) throw new Error('A porta da catraca não foi escolhida neste computador. Vá em "Catraca" e escolha a porta.')
  try {
    await abrirPorta(p, cfg.baudRate || 9600)
  } catch (e) {
    throw new Error('Não consegui abrir a porta da catraca. O SCA ou outra aba está usando? Feche e tente de novo.', { cause: e })
  }
}

// Abre a catraca com a configuração salva (usada pela recepção).
export async function liberarCatraca() {
  await conectarCatraca()
  const cfg = lerConfigCatraca()
  if (cfg.tipo === 'bytes') await enviarBytes(cfg.bytes)
  else await pulso({ dtr: cfg.dtr, rts: cfg.rts, ms: cfg.ms || 3000 })
}
