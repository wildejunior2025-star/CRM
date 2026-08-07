// Endereço do app Impressora FWC neste aparelho.
//
// Era `http://localhost:9110` fixo em todo lugar. Só que "localhost" pode resolver
// pra ::1 (IPv6) e o app escuta em 127.0.0.1 (IPv4) — quando isso acontece, o
// navegador não conecta e o gestor jura que o app está fechado, mesmo com ele
// rodando e respondendo quando você digita o endereço na mão.
//
// Aqui a gente descobre qual dos dois responde e guarda. Só troca se cair.

const BASES = ['http://localhost:9110', 'http://127.0.0.1:9110']
let baseOk = null   // a que respondeu por último

export function fwcBases() {
  // A que funcionou vem primeiro; a outra fica de reserva.
  return baseOk ? [baseOk, ...BASES.filter(b => b !== baseOk)] : BASES
}

export function fwcBaseAtual() {
  return baseOk || BASES[0]
}

// Chama o app tentando os dois endereços. Devolve a Response da primeira que
// responder; joga o último erro se nenhuma responder.
export async function fwcFetch(rota, { timeout = 3000, ...opts } = {}) {
  let ultimoErro
  for (const base of fwcBases()) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeout)
    try {
      const r = await fetch(base + rota, { signal: ctrl.signal, ...opts })
      baseOk = base
      return r
    } catch (e) {
      ultimoErro = e
    } finally { clearTimeout(t) }
  }
  throw ultimoErro || new Error('sem resposta do app')
}

// Mensagem em português pro que o navegador devolveu — "Failed to fetch" não
// ajuda ninguém no balcão da loja.
export function explicaErroFwc(e) {
  const msg = String(e?.message || e || '')
  if (/abort/i.test(msg) || e?.name === 'AbortError') {
    return 'O app não respondeu a tempo. Costuma ser o navegador segurando o acesso à rede local, ou antivírus na porta 9110.'
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'O navegador não conseguiu chegar no app (porta 9110). Veja a permissão "Rede local" e o antivírus.'
  }
  return msg
}
