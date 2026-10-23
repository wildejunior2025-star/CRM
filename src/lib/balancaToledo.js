// Balança Toledo Prix (3 Fit / 3 Plus) ligada no PC — venda por quilo.
//
// A do Agv Grill é uma Prix 3 Fit de 12/2023, ligada por cabo USB. A balança
// não tem porta serial nativa: a saída dela é TTL e o cabo da Toledo converte
// pra USB, que no Windows vira uma porta COM. Quem lê essa porta aqui é o
// próprio Chrome, pela Web Serial — mesmo caminho da catraca da academia
// (ver catracaSerial.js). Não precisa instalar nada no computador da loja.
//
// PROTOCOLO (manual do usuário 3 Fit, seção 5.3)
//
// Prt1, Prt3 e Prt5 respondem IGUAL ao pedido de peso, e é de propósito que
// este arquivo não escolhe entre eles: a loja já usa a balança num sistema
// antigo, e mexer no parâmetro C14 pra forçar um protocolo quebraria o que
// está funcionando lá. Mandando ENQ e lendo o quadro, serve nos três.
//
//   PC manda:      ENQ (0x05)
//   Balança devolve: [STX] 5 caracteres [ETX]
//                    "14385"  -> 14,385 kg   (2 inteiros + 3 decimais)
//                    "IIIII"  -> peso instável (ainda balançando)
//                    "NNNNN"  -> peso negativo
//                    "SSSSS"  -> sobrecarga
//
// Só no Prt5 (e aí vale a pena pedir pro lojista mudar o C14):
//
//   Preço por quilo: [STX] 6 caracteres [ETX]  -> "001658" = R$ 16,58
//   Tara do prato:   [SOH] 6 caracteres [ETX]  -> "000360" = 360 g
//   Resposta:        ACK (0x06) deu certo | NACK (0x21) deu erro
//
// Mandar o preço faz o VISOR DA BALANÇA mostrar Preço/kg e Preço Total pro
// cliente — que é o que ele vê hoje e esperaria continuar vendo. E a tara
// desconta o prato, que senão o cliente paga pela louça todo dia.

const ENQ = 0x05
const STX = 0x02
const ETX = 0x03
const SOH = 0x01
const ACK = 0x06
const NACK = 0x21

export const serialSuportado = () => typeof navigator !== 'undefined' && 'serial' in navigator

let porta = null
let leitor = null
let buffer = []            // bytes recebidos que ainda não viraram resposta
let esperando = null       // { resolve, reject, timer, querACK }

// A velocidade vem do parâmetro C15 da balança: 2400, 4800 ou 9600. Não dá
// pra adivinhar — quem configurou a balança sabe, e a tela guarda a escolha.
export const VELOCIDADES = [9600, 4800, 2400]

export async function portaLembrada() {
  if (!serialSuportado()) return null
  const portas = await navigator.serial.getPorts()
  return portas[0] || null
}

export async function escolherPorta() {
  return navigator.serial.requestPort()
}

export async function abrir(p, baudRate = 9600) {
  if (porta === p && p.readable) return p
  if (porta && porta !== p) await fechar()
  // 8 bits, sem paridade, 1 stop bit: é o que o manual define pros protocolos
  // de peso (e o padrão de fábrica da balança).
  await p.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' })
  porta = p
  lerSempre()
  return p
}

export async function fechar() {
  try { await leitor?.cancel() } catch { /* já cancelado */ }
  leitor = null
  try { await porta?.close() } catch { /* já fechada */ }
  porta = null
  buffer = []
}

export const portaAberta = () => porta

// Lê a porta pra sempre, num laço só. Não dá pra abrir um leitor por pergunta:
// a Web Serial trava o `readable` enquanto um leitor existe, e o segundo
// `getReader()` estouraria. Então o laço acumula bytes e quem perguntou é
// avisado quando o quadro fecha.
async function lerSempre() {
  while (porta?.readable) {
    leitor = porta.readable.getReader()
    try {
      for (;;) {
        const { value, done } = await leitor.read()
        if (done) break
        if (value) { for (const b of value) buffer.push(b); tentarResponder() }
      }
    } catch { /* porta caiu: sai e deixa o laço de fora decidir */ }
    finally { try { leitor.releaseLock() } catch { /* ok */ } }
    if (!porta) break
  }
}

// Vê se o que chegou já é uma resposta inteira.
function tentarResponder() {
  if (!esperando) { if (buffer.length > 64) buffer = [] ; return }

  if (esperando.querACK) {
    const i = buffer.findIndex((b) => b === ACK || b === NACK)
    if (i < 0) return
    const ok = buffer[i] === ACK
    buffer = buffer.slice(i + 1)
    concluir(ok ? { ok: true } : { ok: false, erro: 'A balança recusou (NACK).' })
    return
  }

  const ini = buffer.indexOf(STX)
  if (ini < 0) { if (buffer.length > 64) buffer = []; return }
  const fim = buffer.indexOf(ETX, ini + 1)
  if (fim < 0) return

  const corpo = buffer.slice(ini + 1, fim).map((b) => String.fromCharCode(b)).join('')
  buffer = buffer.slice(fim + 1)
  concluir(interpretarPeso(corpo))
}

function concluir(resultado) {
  const e = esperando
  esperando = null
  if (!e) return
  clearTimeout(e.timer)
  e.resolve(resultado)
}

// "14385" -> 14,385 kg. As letras são os estados que o manual define.
export function interpretarPeso(corpo) {
  const s = String(corpo || '').trim()
  if (/^I+$/.test(s)) return { ok: false, estado: 'instavel', erro: 'Peso ainda balançando.' }
  if (/^N+$/.test(s)) return { ok: false, estado: 'negativo', erro: 'Peso negativo — zere a balança.' }
  if (/^S+$/.test(s)) return { ok: false, estado: 'sobrecarga', erro: 'Peso acima do limite da balança.' }
  if (!/^\d{5,6}$/.test(s)) return { ok: false, estado: 'ruido', erro: `Resposta que não entendi: "${s}".` }
  // 5 dígitos = 2 inteiros + 3 decimais. Algumas versões mandam 6; o peso
  // continua com 3 casas no fim, então dividir por mil vale nos dois casos.
  return { ok: true, estado: 'estavel', kg: Number(s) / 1000 }
}

async function escrever(bytes) {
  if (!porta?.writable) throw new Error('A balança não está conectada.')
  const w = porta.writable.getWriter()
  try { await w.write(new Uint8Array(bytes)) } finally { w.releaseLock() }
}

function aguardar({ querACK = false, ms = 1500 } = {}) {
  if (esperando) return Promise.resolve({ ok: false, erro: 'Já tem uma leitura em andamento.' })
  return new Promise((resolve) => {
    esperando = {
      resolve, querACK,
      timer: setTimeout(() => {
        esperando = null
        resolve({ ok: false, estado: 'sem_resposta', erro: 'A balança não respondeu. Confira o cabo e a velocidade (C15).' })
      }, ms),
    }
  })
}

// Uma pergunta só. Devolve { ok, kg } ou { ok: false, estado, erro }.
export async function pedirPeso() {
  buffer = []
  const resposta = aguardar({ ms: 1500 })
  await escrever([ENQ])
  return resposta
}

// PESO BOM É PESO PARADO.
//
// O prato acabou de ser posto na balança e ela ainda oscila — perguntar uma
// vez só devolveria "instável" na maioria das vezes, e o atendente ia achar
// que está quebrado. Pergunta de novo até parar, e só desiste depois de uns
// segundos. Peso zerado também não serve: é prato que ninguém colocou ainda.
export async function pesarEstavel({ tentativas = 12, intervalo = 300 } = {}) {
  let ultimo = null
  for (let i = 0; i < tentativas; i++) {
    ultimo = await pedirPeso()
    if (ultimo.ok && ultimo.kg > 0) return ultimo
    if (ultimo.estado === 'sem_resposta') return ultimo   // cabo/porta: insistir não resolve
    await new Promise((r) => setTimeout(r, intervalo))
  }
  if (ultimo?.ok && ultimo.kg === 0) return { ok: false, estado: 'zero', erro: 'A balança está zerada — coloque o prato.' }
  return ultimo ?? { ok: false, erro: 'Não consegui ler a balança.' }
}

// Manda o preço do quilo pro visor da balança (só Prt5). 6 caracteres: 4 da
// parte inteira e 2 dos centavos, com os zeros à esquerda.
export async function enviarPrecoKg(reais) {
  const centavos = Math.round(Number(reais || 0) * 100)
  if (!Number.isFinite(centavos) || centavos < 0 || centavos > 999999) {
    return { ok: false, erro: 'Preço por quilo fora do que a balança aceita.' }
  }
  buffer = []
  const resposta = aguardar({ querACK: true, ms: 1200 })
  await escrever([STX, ...String(centavos).padStart(6, '0').split('').map((c) => c.charCodeAt(0)), ETX])
  return resposta
}

// Tara em GRAMAS (o peso do prato). Mesmo formato de 6 caracteres.
export async function enviarTara(gramas) {
  const g = Math.round(Number(gramas || 0))
  if (!Number.isFinite(g) || g < 0 || g > 999999) return { ok: false, erro: 'Tara fora do que a balança aceita.' }
  buffer = []
  const resposta = aguardar({ querACK: true, ms: 1200 })
  await escrever([SOH, ...String(g).padStart(6, '0').split('').map((c) => c.charCodeAt(0)), ETX])
  return resposta
}
