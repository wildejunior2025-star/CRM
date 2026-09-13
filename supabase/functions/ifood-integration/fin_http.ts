// Chamada à API Financial do iFood com a resiliência que a homologação exige:
//   - 429 (limite de chamadas) e 5xx: espera crescente com um sorteio pequeno e
//     tenta de novo, respeitando X-RateLimit-Reset / Retry-After quando vierem;
//   - tempo esgotado: mesma coisa;
//   - 401: o token venceu antes da hora — renova UMA vez e repete;
//   - o resto (400, 403, 404, 409) volta pra quem chamou decidir, com o corpo.
//
// Loja de teste do iFood usa o header x-request-homologation: true, sem o qual
// a API de teste devolve 204 (vazio).

export const IFOOD = "https://merchant-api.ifood.com.br"

const TENTATIVAS = 4
const TIMEOUT_MS = 25_000
const ESPERA_MAX_MS = 15_000

export type CtxIfood = {
  sb: any
  cfg: any
  getToken: (sb: any, cfg: any) => Promise<string>
  token?: string
}

export class ErroIfood extends Error {
  status: number
  corpo: string
  constructor(status: number, corpo: string, mensagem: string) {
    super(mensagem)
    this.status = status
    this.corpo = corpo
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))
const espera = (tentativa: number) =>
  Math.min(ESPERA_MAX_MS, 1000 * 2 ** tentativa) + Math.floor(Math.random() * 400)

export async function chamarIfood(
  ctx: CtxIfood,
  metodo: "GET" | "POST",
  caminho: string,
  corpo?: unknown,
): Promise<Response> {
  let renovouToken = false

  for (let t = 0; t < TENTATIVAS; t++) {
    if (!ctx.token) ctx.token = await ctx.getToken(ctx.sb, ctx.cfg)

    const headers: Record<string, string> = { Authorization: `Bearer ${ctx.token}` }
    if (ctx.cfg?.ambiente === "teste") headers["x-request-homologation"] = "true"
    if (corpo !== undefined) headers["Content-Type"] = "application/json"

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    let r: Response
    try {
      r = await fetch(`${IFOOD}${caminho}`, {
        method: metodo,
        headers,
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
        signal: ac.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      if (t === TENTATIVAS - 1) {
        throw new ErroIfood(0, String((e as Error)?.message ?? e), "O iFood não respondeu a tempo.")
      }
      await esperar(espera(t))
      continue
    }
    clearTimeout(timer)

    if (r.status === 401 && !renovouToken) {
      renovouToken = true
      ctx.cfg.access_token = null
      ctx.cfg.token_expira_em = null
      ctx.token = undefined
      continue
    }

    if (r.status === 429 || r.status >= 500) {
      const texto = await r.text()
      if (t === TENTATIVAS - 1) {
        throw new ErroIfood(
          r.status, texto,
          r.status === 429 ? "O iFood limitou as consultas agora — tente de novo em alguns minutos." : "O iFood está instável agora.",
        )
      }
      const aviso = Number(r.headers.get("x-ratelimit-reset") ?? r.headers.get("retry-after"))
      await esperar(Number.isFinite(aviso) && aviso > 0 ? Math.min(aviso * 1000, ESPERA_MAX_MS) : espera(t))
      continue
    }

    return r
  }
  throw new ErroIfood(0, "", "Não consegui falar com o iFood.")
}

// GET que devolve JSON, ou null quando o iFood responde 204 (sem dados).
// 403 vira ErroIfood com status 403 — quem chama transforma em "sem_permissao".
export async function getJson(ctx: CtxIfood, caminho: string): Promise<any | null> {
  const r = await chamarIfood(ctx, "GET", caminho)
  if (r.status === 204) return null
  const texto = await r.text()
  if (!r.ok) throw new ErroIfood(r.status, texto, mensagemDe(r.status, texto))
  try {
    return texto ? JSON.parse(texto) : null
  } catch {
    throw new ErroIfood(r.status, texto, "O iFood devolveu uma resposta que não é JSON.")
  }
}

export function mensagemDe(status: number, corpo: string): string {
  let msg = ""
  try {
    const j = JSON.parse(corpo)
    msg = j?.error?.message ?? j?.message ?? ""
  } catch { /* corpo não é JSON */ }
  if (status === 403) return "O iFood ainda não liberou o módulo financeiro pra esta loja."
  if (status === 404) return `Consulta não encontrada no iFood${msg ? `: ${msg}` : "."}`
  if (status === 400) return `O iFood recusou a consulta${msg ? `: ${msg}` : "."}`
  return `iFood ${status}${msg ? `: ${msg}` : ""}`
}
