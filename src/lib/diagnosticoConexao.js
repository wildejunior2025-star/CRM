// ── Quem é o culpado quando a tela não carrega? ──────────────────────────────
//
// "Carregando..." pra sempre é a pior mensagem possível: a pessoa não sabe se é
// o wi-fi da loja, se é o computador dela, se é o sistema ou se alguém mexeu em
// alguma coisa. Em 28/08/2026 a Supabase teve uma queda e a Estação ficou meia
// hora nesse escuro.
//
// O truque pra saber de quem é a culpa: além do banco, testar O PRÓPRIO SITE
// (/api/ping, que o Worker responde sem encostar no banco).
//
//   site responde + banco não  →  o servidor do banco caiu. Não tem o que fazer daqui.
//   nem o site responde        →  a internet de quem está usando é que caiu.
//
// Sem esse segundo teste, um wi-fi ruim viraria "servidor fora do ar" — e aí a
// loja para de procurar o problema onde ele realmente está.

const TIMEOUT_MS = 8000

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// Tenta alcançar um endereço com prazo. Qualquer coisa que não seja uma resposta
// boa dentro do prazo conta como "não alcancei" — inclusive o pedido pendurado,
// que foi exatamente o que aconteceu na queda (a requisição nunca voltava).
async function alcanca(url, opcoes = {}) {
  const ctrl = new AbortController()
  const prazo = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal, ...opcoes })
    return r.ok
  } catch {
    return false
  } finally {
    clearTimeout(prazo)
  }
}

// 'sem-internet' | 'fora-do-ar'
export async function diagnosticar() {
  // O navegador já sabe quando não tem rede nenhuma (cabo fora, wi-fi caído).
  // Vale como atalho, mas não dá pra confiar só nele: ele diz "online" também
  // quando o aparelho está num wi-fi que não chega na internet.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'sem-internet'

  const siteResponde = await alcanca(`/api/ping?t=${Date.now()}`)
  return siteResponde ? 'fora-do-ar' : 'sem-internet'
}

// O erro que voltou é "não deu pra falar com o servidor"? Serve pra não mostrar
// "Failed to fetch" pra ninguém — e, pior, pra não acusar a pessoa de errar o
// apelido/senha quando na verdade o pedido nem chegou ao servidor.
export function pareceQuedaDeRede(erro) {
  if (erro?.name === 'AuthRetryableFetchError' || erro?.name === 'TypeError') return true
  const m = String(erro?.message ?? erro ?? '').toLowerCase()
  return (
    m.includes('failed to fetch') ||
    m.includes('fetch failed') ||
    m.includes('networkerror') ||
    m.includes('network request failed') ||
    m.includes('load failed') ||
    m.includes('timeout') ||
    m.includes('502') || m.includes('503') || m.includes('504') || m.includes('521')
  )
}

// Frase pronta pra mostrar num formulário, já sabendo de quem é a culpa.
export async function mensagemDeQueda() {
  const motivo = await diagnosticar()
  return motivo === 'sem-internet'
    ? '📶 Você está sem internet. Confere o wi-fi ou os dados do celular e tente de novo.'
    : '🔧 O servidor está fora do ar — não é o seu computador nem a sua internet. Tente de novo daqui a alguns minutos.'
}

// O banco voltou? Usado pra religar a tela sozinha, sem a pessoa ficar
// apertando "Tentar de novo". O /auth/v1/health é a resposta mais barata que o
// Supabase tem — não lê nenhuma tabela.
export async function servidorVoltou() {
  if (!SUPABASE_URL) return false
  return alcanca(`${SUPABASE_URL}/auth/v1/health`, {
    headers: { apikey: SUPABASE_ANON_KEY },
  })
}
