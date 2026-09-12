// =====================================================================
// Repasse do iFood pela API Financial v3.0 (migração 0260)
// ---------------------------------------------------------------------
// acao "financeiro_sync" -> { empresa_id?, dias? }
//   Busca os lançamentos financeiros de cada loja conectada, grava crus em
//   ifood_eventos_financeiros e soma por semana em ifood_repasse_semanal —
//   a tabela que a tela Financeiro já lê (é a mesma do PDF importado).
//
// O que se sabe da API (testado em 12/09/2026):
//   - A rota é /financial/v3.0/merchants/{id}/financial-events (com hífen; a
//     versão camelCase "financialEvents" dá 404).
//   - Pagina com page/size/hasNextPage.
//   - O escopo que libera é `conciliator`. Sem ele: 403.
//   - No app de TESTE, o header x-request-homologation: true devolve um
//     exemplo FIXO, igual pra qualquer data ou página. Serve pra validar o
//     formato e a gravação, não o filtro de datas.
//
// O que NÃO se sabe ainda (só vai aparecer com dado real de produção):
//   - Sobre qual data o beginDate/endDate filtra (apuração, pedido ou repasse).
//     Por isso a janela é pedida em fatias de 7 dias e cada lançamento é
//     deduplicado pela chave — pedir a mesma coisa duas vezes não duplica.
//   - Todos os nomes de lançamento que existem. As quebras (comissão, anúncio)
//     são a melhor leitura; o valor do repasse soma tudo que impacta o repasse,
//     que não depende de nome.
// =====================================================================

const IFOOD = "https://merchant-api.ifood.com.br"
const FATIA_DIAS = 7
const MAX_PAGINAS = 50
const TAMANHO_PAGINA = 100

type Cfg = {
  id?: string
  empresa_id: string
  merchant_id: string | null
  ambiente: string
  apelido?: string | null
}

type Resultado = {
  empresa_id: string
  merchant_id: string | null
  loja: string | null
  status: "ok" | "sem_permissao" | "erro"
  lancamentos: number
  erro?: string
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const addDias = (d: Date, n: number) => new Date(d.getTime() + n * 86400000)
const numOuNull = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Chave do lançamento. Ficam de FORA os campos que o iFood pode mudar depois no
// mesmo lançamento (a data prevista do repasse, por exemplo, anda quando o
// repasse atrasa): se entrassem no hash, a mudança criaria uma segunda linha e
// o repasse contaria o lançamento duas vezes. Eles são atualizados na linha.
async function hashDoEvento(ev: any, merchantId: string): Promise<string> {
  const base = JSON.stringify([
    merchantId,
    ev?.name ?? null,
    ev?.description ?? null,
    ev?.trigger ?? null,
    ev?.product ?? null,
    ev?.competence ?? null,
    ev?.period?.beginDate ?? null,
    ev?.period?.endDate ?? null,
    ev?.period?.idSaldo ?? null,
    ev?.reference?.type ?? null,
    ev?.reference?.id ?? null,
    ev?.reference?.date ?? null,
    ev?.amount?.value ?? null,
    ev?.payment?.method ?? null,
    ev?.payment?.liability ?? null,
    ev?.billing?.baseValue ?? null,
    ev?.billing?.feePercentage ?? null,
  ])
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base))
  return Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

// Uma fatia de datas, todas as páginas. Devolve a lista ou "sem_permissao".
async function buscarFatia(
  token: string, cfg: Cfg, ini: string, fim: string,
): Promise<any[] | "sem_permissao"> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  // Loja de teste do iFood: sem este header a API devolve 204 (sem dados).
  if (cfg.ambiente === "teste") headers["x-request-homologation"] = "true"

  const todos: any[] = []
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const url = `${IFOOD}/financial/v3.0/merchants/${cfg.merchant_id}/financial-events`
      + `?beginDate=${ini}&endDate=${fim}&page=${pagina}&size=${TAMANHO_PAGINA}`
    const r = await fetch(url, { headers })
    if (r.status === 403) return "sem_permissao"
    if (r.status === 204) break
    if (!r.ok) throw new Error(`financial-events ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json().catch(() => null)
    const lista = Array.isArray(j?.financialEvents) ? j.financialEvents : []
    todos.push(...lista)
    if (!j?.hasNextPage || lista.length === 0) break
  }
  return todos
}

async function linhasDaFatia(cfg: Cfg, eventos: any[]) {
  // Lançamentos idênticos na MESMA resposta viram chaves diferentes (#0, #1…).
  // Idênticos em fatias diferentes caem na mesma chave — é o mesmo lançamento
  // aparecendo em duas janelas que se encostam.
  const vistos = new Map<string, number>()
  const linhas = []
  for (const ev of eventos) {
    const h = await hashDoEvento(ev, cfg.merchant_id!)
    const n = vistos.get(h) ?? 0
    vistos.set(h, n + 1)
    linhas.push({
      empresa_id: cfg.empresa_id,
      merchant_id: cfg.merchant_id,
      chave: `${h}#${n}`,
      nome: String(ev?.name ?? "DESCONHECIDO"),
      descricao: ev?.description ?? null,
      gatilho: ev?.trigger ?? null,
      produto: ev?.product ?? null,
      competencia: ev?.competence ?? null,
      periodo_ini: ev?.period?.beginDate ?? null,
      periodo_fim: ev?.period?.endDate ?? null,
      id_saldo: ev?.period?.idSaldo != null ? String(ev.period.idSaldo) : null,
      referencia_tipo: ev?.reference?.type ?? null,
      referencia_id: ev?.reference?.id ?? null,
      referencia_em: ev?.reference?.date ?? null,
      valor: numOuNull(ev?.amount?.value) ?? 0,
      impacta_repasse: ev?.hasTransferImpact !== false,
      previsao_pagamento: ev?.settlement?.expectedDate ?? null,
      metodo_pagamento: ev?.payment?.method ?? null,
      responsavel: ev?.payment?.liability ?? null,
      base_calculo: numOuNull(ev?.billing?.baseValue),
      percentual: numOuNull(ev?.billing?.feePercentage),
      bruto: ev,
      sincronizado_em: new Date().toISOString(),
    })
  }
  return linhas
}

export async function runFinanceiroSync(
  sb: any,
  getToken: (sb: any, cfg: any) => Promise<string>,
  opts: { empresaId?: string; dias?: number } = {},
) {
  const dias = Math.min(Math.max(Number(opts.dias) || 45, 1), 180)

  let q = sb.from("ifood_config").select("*").eq("ativo", true).not("merchant_id", "is", null)
  if (opts.empresaId) q = q.eq("empresa_id", opts.empresaId)
  const { data: configs, error } = await q
  if (error) return { ok: false, error: error.message }

  const hoje = new Date()
  const inicio = addDias(hoje, -dias)
  const resultados: Resultado[] = []
  const empresasComDados = new Set<string>()

  for (const cfg of (configs ?? []) as Cfg[]) {
    const res: Resultado = {
      empresa_id: cfg.empresa_id, merchant_id: cfg.merchant_id, loja: cfg.apelido ?? null,
      status: "ok", lancamentos: 0,
    }
    try {
      const token = await getToken(sb, cfg)
      let semPermissao = false
      const porChave = new Map<string, any>()

      // Fatias de 7 dias, do mais antigo pro mais novo.
      for (let a = inicio; a <= hoje; a = addDias(a, FATIA_DIAS)) {
        const b = addDias(a, FATIA_DIAS - 1) > hoje ? hoje : addDias(a, FATIA_DIAS - 1)
        const eventos = await buscarFatia(token, cfg, ymd(a), ymd(b))
        if (eventos === "sem_permissao") { semPermissao = true; break }
        for (const linha of await linhasDaFatia(cfg, eventos)) porChave.set(linha.chave, linha)
      }

      if (semPermissao) {
        res.status = "sem_permissao"
      } else {
        const linhas = [...porChave.values()]
        for (let i = 0; i < linhas.length; i += 500) {
          const { error: upErr } = await sb.from("ifood_eventos_financeiros")
            .upsert(linhas.slice(i, i + 500), { onConflict: "empresa_id,chave" })
          if (upErr) throw new Error(`gravar lançamentos: ${upErr.message}`)
        }
        res.lancamentos = linhas.length
        if (linhas.length) empresasComDados.add(cfg.empresa_id)
      }
    } catch (e) {
      res.status = "erro"
      res.erro = String((e as Error)?.message ?? e).slice(0, 500)
    }

    // Status fica na linha da loja do iFood: o Financeiro mostra se está
    // sincronizando, esperando liberação do iFood ou com erro.
    const upd = sb.from("ifood_config").update({
      financeiro_status: res.status,
      financeiro_sync_em: new Date().toISOString(),
      financeiro_erro: res.erro ?? null,
    })
    await (cfg.id ? upd.eq("id", cfg.id) : upd.eq("empresa_id", cfg.empresa_id))
    resultados.push(res)
  }

  // Soma por semana. Depois de gravar TODAS as lojas do iFood da empresa, pra
  // uma empresa com duas lojas não recalcular com metade dos lançamentos.
  const semanas: Record<string, number | string> = {}
  for (const emp of empresasComDados) {
    const { data, error: rpcErr } = await sb.rpc("recalcular_repasse_ifood", { p_empresa: emp })
    semanas[emp] = rpcErr ? `erro: ${rpcErr.message}` : Number(data ?? 0)
  }

  // A função aceita chamada sem login (o cron chama assim), então a resposta
  // não carrega id de merchant nem de empresa: só o que a tela precisa saber.
  return {
    ok: true,
    dias,
    lojas: resultados.length,
    sem_permissao: resultados.filter((r) => r.status === "sem_permissao").length,
    com_erro: resultados.filter((r) => r.status === "erro").length,
    resultados: resultados.map((r) => ({ status: r.status, lancamentos: r.lancamentos })),
    semanas_atualizadas: Object.values(semanas).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0),
  }
}
