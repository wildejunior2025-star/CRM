// =====================================================================
// Conciliação iFood — módulo Financial (migrações 0260 e 0261)
// ---------------------------------------------------------------------
// acao "financeiro_sync"       { empresa_id?, dias? }
//   Lançamentos + vendas + liquidações das últimas semanas (seg-dom), o
//   arquivo mensal dos meses encerrados que ainda não baixou, e as conferências.
//   Sem empresa_id: todas as lojas (é o cron das 06:15).
//
// acao "conciliacao_mensal"    { empresa_id, competencia }   baixa o arquivo do mês agora
// acao "conciliacao_solicitar" { empresa_id, competencia }   pede o relatório sob demanda
// acao "conciliacao_status"    { empresa_id, competencia }   acompanha o pedido
//
// As ações com empresa_id exigem login DAQUELA loja (ou super admin, ou a chave
// de serviço). A função aceita chamada sem login porque o cron chama assim — mas
// sem login ela só roda a rotina de todas as lojas, nunca a de uma escolhida.
// =====================================================================
import { type CtxIfood, ErroIfood } from "./fin_http.ts"
import { buscarEventosDaSemana, linhasDeEventos } from "./fin_eventos.ts"
import { buscarVendasDaSemana, linhasDeVendas } from "./fin_vendas.ts"
import { buscarLiquidacaoDaSemana, linhasDeLiquidacao } from "./fin_liquidacoes.ts"
import { baixarRelatorioMensal, consultarRelatorio, solicitarRelatorio } from "./fin_conciliacao.ts"
import { gravarEmLotes, semanasDeLiquidacao } from "./fin_util.ts"

type GetToken = (sb: any, cfg: any) => Promise<string>

// Rotina de todas as lojas não roda de novo antes disto (protege o limite de
// chamadas do iFood de quem chamar a função repetidamente).
const INTERVALO_MIN_MS = 30 * 60 * 1000

// ── Quem está chamando ────────────────────────────────────────────────────────
export async function podeMexerNaEmpresa(req: Request, sb: any, empresaId: string): Promise<boolean> {
  if (!empresaId) return false
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  if (!jwt) return false
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  if (servico && jwt === servico) return true

  // Login de gente: a loja dona ou o super admin.
  const { data } = await sb.auth.getUser(jwt)
  const uid = data?.user?.id
  if (uid) {
    const { data: p } = await sb.from("profiles").select("empresa_id, perfil").eq("id", uid).maybeSingle()
    return !!p && (p.perfil === "super_admin" || p.empresa_id === empresaId)
  }

  // Não é login de pessoa: pode ser a chave de serviço em outro formato (a
  // variável do ambiente nem sempre vem igual à chave do painel). Em vez de
  // comparar texto, pergunta ao banco: ifood_app só é visível pra serviço e
  // super admin (RLS), então quem enxerga a linha tem esse poder.
  try {
    const url = Deno.env.get("SUPABASE_URL")
    const anon = Deno.env.get("SUPABASE_ANON_KEY")
    if (!url || !anon) return false
    const r = await fetch(`${url}/rest/v1/ifood_app?select=id&limit=1`, {
      headers: { apikey: anon, Authorization: `Bearer ${jwt}` },
    })
    if (!r.ok) return false
    const linhas = await r.json()
    return Array.isArray(linhas) && linhas.length > 0
  } catch {
    return false
  }
}

async function lojasDoIfood(sb: any, empresaId?: string) {
  let q = sb.from("ifood_config").select("*").eq("ativo", true).not("merchant_id", "is", null)
  if (empresaId) q = q.eq("empresa_id", empresaId)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

// Meses encerrados que ainda não têm arquivo pronto (olha os 2 últimos).
async function competenciasPendentes(sb: any, cfg: any) {
  const hoje = new Date()
  const comps: string[] = []
  for (let i = 1; i <= 2; i++) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1))
    comps.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  const { data } = await sb.from("ifood_conciliacao_mensal")
    .select("competencia, status, atualizado_em")
    .eq("empresa_id", cfg.empresa_id).eq("merchant_id", cfg.merchant_id).eq("origem", "mensal")
    .in("competencia", comps)
  const prontos = new Set((data ?? []).filter((r: any) => r.status === "pronto").map((r: any) => r.competencia))
  return comps.filter((c) => !prontos.has(c))
}

async function marcarStatus(sb: any, cfg: any, status: string, erro: string | null) {
  const upd = sb.from("ifood_config").update({
    financeiro_status: status,
    financeiro_sync_em: new Date().toISOString(),
    financeiro_erro: erro,
  })
  await (cfg.id ? upd.eq("id", cfg.id) : upd.eq("empresa_id", cfg.empresa_id))
}

// ── Rotina completa de uma loja do iFood ──────────────────────────────────────
async function sincronizarLoja(sb: any, getToken: GetToken, cfg: any, dias: number) {
  const ctx: CtxIfood = { sb, cfg, getToken }
  const res = {
    status: "ok" as "ok" | "sem_permissao" | "erro",
    lancamentos: 0, vendas: 0, semanas_liquidacao: 0, titulos: 0,
    relatorios: [] as { competencia: string; status: string; erro?: string }[],
    descartados: 0,
    erro: null as string | null,
  }

  try {
    const semanas = semanasDeLiquidacao(dias)
    const eventos = new Map<string, any>()
    const vendas = new Map<string, any>()
    const semanasLiq: any[] = []
    const titulos: any[] = []

    for (const s of semanas) {
      const ev = await linhasDeEventos(cfg, await buscarEventosDaSemana(ctx, s.ini, s.fim))
      for (const l of ev.linhas) eventos.set(l.chave, l)
      res.descartados += ev.descartados

      const vd = linhasDeVendas(cfg, await buscarVendasDaSemana(ctx, s.ini, s.fim))
      for (const l of vd.linhas) vendas.set(l.venda_id, l)
      res.descartados += vd.descartadas

      const lq = await linhasDeLiquidacao(cfg, s.ini, s.fim, await buscarLiquidacaoDaSemana(ctx, s.ini, s.fim))
      semanasLiq.push(lq.semana)
      titulos.push(...lq.titulos)
    }

    await gravarEmLotes(sb, "ifood_eventos_financeiros", [...eventos.values()], "empresa_id,chave")
    await gravarEmLotes(sb, "ifood_vendas", [...vendas.values()], "empresa_id,venda_id")
    await gravarEmLotes(sb, "ifood_liquidacao_semanas", semanasLiq, "empresa_id,merchant_id,semana_ini")
    await gravarEmLotes(sb, "ifood_liquidacoes", titulos, "empresa_id,chave")
    res.lancamentos = eventos.size
    res.vendas = vendas.size
    res.semanas_liquidacao = semanasLiq.length
    res.titulos = titulos.length

    for (const comp of await competenciasPendentes(sb, cfg)) {
      const r = await baixarRelatorioMensal(ctx, comp)
      res.relatorios.push({ competencia: comp, status: r.status, ...(r.erro ? { erro: r.erro } : {}) })
    }
  } catch (e) {
    if (e instanceof ErroIfood && e.status === 403) {
      res.status = "sem_permissao"
    } else {
      res.status = "erro"
      res.erro = String((e as Error)?.message ?? e).slice(0, 500)
    }
  }

  const aviso = res.status === "ok" && res.descartados
    ? `${res.descartados} registro(s) do iFood vieram incompletos e ficaram de fora.`
    : null
  await marcarStatus(sb, cfg, res.status, res.erro ?? aviso)
  return res
}

export async function runFinanceiroSync(
  req: Request, sb: any, getToken: GetToken,
  opts: { empresaId?: string; dias?: number } = {},
) {
  const dias = Math.min(Math.max(Number(opts.dias) || 42, 7), 120)

  if (opts.empresaId && !(await podeMexerNaEmpresa(req, sb, opts.empresaId))) {
    return { ok: false, error: "Sem permissão pra atualizar essa loja." }
  }

  let lojas = await lojasDoIfood(sb, opts.empresaId)
  if (!opts.empresaId) {
    const limite = Date.now() - INTERVALO_MIN_MS
    lojas = lojas.filter((c: any) => !c.financeiro_sync_em || new Date(c.financeiro_sync_em).getTime() < limite)
  }

  const resultados = []
  const empresas = new Set<string>()
  for (const cfg of lojas) {
    const r = await sincronizarLoja(sb, getToken, cfg, dias)
    resultados.push(r)
    if (r.status === "ok") empresas.add(cfg.empresa_id)
  }

  // Conferências por empresa, depois de TODAS as lojas dela gravarem.
  let semanas = 0
  for (const emp of empresas) {
    const { data } = await sb.rpc("recalcular_repasse_ifood", { p_empresa: emp })
    semanas += Number(data ?? 0)
  }

  // Sem id de merchant nem de empresa na resposta: a função aceita chamada sem login.
  return {
    ok: true,
    dias,
    lojas: resultados.length,
    sem_permissao: resultados.filter((r) => r.status === "sem_permissao").length,
    com_erro: resultados.filter((r) => r.status === "erro").length,
    resultados: resultados.map(({ erro: _e, ...r }) => r),
    semanas_atualizadas: semanas,
  }
}

// ── Relatório mensal: ações pedidas pela tela ─────────────────────────────────
async function porLoja(
  req: Request, sb: any, getToken: GetToken, empresaId: string,
  fn: (ctx: CtxIfood, cfg: any) => Promise<any>,
) {
  if (!(await podeMexerNaEmpresa(req, sb, empresaId))) {
    return { ok: false, error: "Sem permissão pra essa loja." }
  }
  const lojas = await lojasDoIfood(sb, empresaId)
  if (!lojas.length) return { ok: false, error: "Essa loja não tem iFood conectado." }
  const resultados = []
  for (const cfg of lojas) {
    try {
      resultados.push(await fn({ sb, cfg, getToken }, cfg))
    } catch (e) {
      resultados.push(e instanceof ErroIfood && e.status === 403
        ? { status: "sem_permissao", erro: "O iFood ainda não liberou o módulo financeiro pra esta loja." }
        : { status: "erro", erro: String((e as Error)?.message ?? e).slice(0, 300) })
    }
  }
  const { data } = await sb.rpc("recalcular_repasse_ifood", { p_empresa: empresaId })
  return { ok: true, resultados, semanas_atualizadas: Number(data ?? 0) }
}

export const runConciliacaoMensal = (req: Request, sb: any, getToken: GetToken, empresaId: string, competencia: string) =>
  porLoja(req, sb, getToken, empresaId, (ctx) => baixarRelatorioMensal(ctx, competencia))

export const runConciliacaoSolicitar = (req: Request, sb: any, getToken: GetToken, empresaId: string, competencia: string) =>
  porLoja(req, sb, getToken, empresaId, (ctx) => solicitarRelatorio(ctx, competencia))

export const runConciliacaoStatus = (req: Request, sb: any, getToken: GetToken, empresaId: string, competencia: string) =>
  porLoja(req, sb, getToken, empresaId, async (ctx, cfg) => {
    const { data } = await sb.from("ifood_conciliacao_mensal")
      .select("request_id, status")
      .eq("empresa_id", cfg.empresa_id).eq("merchant_id", cfg.merchant_id)
      .eq("competencia", competencia).eq("origem", "sob_demanda").maybeSingle()
    if (!data?.request_id) return { status: "nao_solicitado" }
    if (data.status === "pronto" || data.status === "erro") return { status: data.status }
    return await consultarRelatorio(ctx, competencia, data.request_id)
  })
