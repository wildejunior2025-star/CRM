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
export function lerConfigCatraca() {
  try { return JSON.parse(localStorage.getItem(CHAVE)) || null } catch { return null }
}
export function salvarConfigCatraca(cfg) {
  try { localStorage.setItem(CHAVE, JSON.stringify(cfg)) } catch { /* só não lembra */ }
}

// Abre a catraca com a configuração salva (usada pela recepção).
export async function liberarCatraca() {
  const cfg = lerConfigCatraca()
  if (!cfg) return false
  if (!porta) {
    const p = await portaLembrada()
    if (!p) return false
    await abrirPorta(p, cfg.baudRate || 9600)
  }
  if (cfg.tipo === 'bytes') await enviarBytes(cfg.bytes)
  else await pulso({ dtr: cfg.dtr, rts: cfg.rts, ms: cfg.ms || 3000 })
  return true
}
