// API Financial Events — lançamento a lançamento (débito, crédito, informativo).
// Rota: GET /financial/v3.0/merchants/{id}/financial-events?beginDate&endDate&page&size
// Limite do iFood: 33 dias por consulta. Aqui é sempre UMA semana (seg-dom).
import { type CtxIfood, getJson } from "./fin_http.ts"
import { dataValida, numOuNull, sha256 } from "./fin_util.ts"

const MAX_PAGINAS = 50
const TAMANHO = 100

// Os campos que o iFood pode mudar DEPOIS no mesmo lançamento (a data prevista
// do repasse anda quando atrasa) ficam fora da chave: se entrassem, a mudança
// criaria uma segunda linha e o repasse contaria o lançamento duas vezes.
async function chaveBase(ev: any, merchantId: string) {
  return sha256(JSON.stringify([
    merchantId, ev?.name ?? null, ev?.description ?? null, ev?.trigger ?? null,
    ev?.product ?? null, ev?.competence ?? null,
    ev?.period?.beginDate ?? null, ev?.period?.endDate ?? null, ev?.period?.idSaldo ?? null,
    ev?.reference?.type ?? null, ev?.reference?.id ?? null, ev?.reference?.date ?? null,
    ev?.amount?.value ?? null, ev?.payment?.method ?? null, ev?.payment?.liability ?? null,
    ev?.billing?.baseValue ?? null, ev?.billing?.feePercentage ?? null,
  ]))
}

// Validação de integridade: lançamento sem tipo ou sem valor numérico não entra
// na conta — é descartado e contado, pra aparecer no status em vez de sumir.
function valido(ev: any) {
  return typeof ev?.name === "string" && ev.name.trim() !== "" && numOuNull(ev?.amount?.value) !== null
}

export async function buscarEventosDaSemana(ctx: CtxIfood, ini: string, fim: string) {
  const eventos: any[] = []
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const j = await getJson(ctx,
      `/financial/v3.0/merchants/${ctx.cfg.merchant_id}/financial-events?beginDate=${ini}&endDate=${fim}&page=${p}&size=${TAMANHO}`)
    const lista = Array.isArray(j?.financialEvents) ? j.financialEvents : []
    eventos.push(...lista)
    if (!j?.hasNextPage || lista.length === 0) break
  }
  return eventos
}

export async function linhasDeEventos(cfg: any, eventos: any[]) {
  const vistos = new Map<string, number>()
  const linhas: any[] = []
  let descartados = 0
  for (const ev of eventos) {
    if (!valido(ev)) { descartados++; continue }
    const h = await chaveBase(ev, cfg.merchant_id)
    // Idênticos na MESMA resposta viram #0, #1…; em semanas diferentes, mesma chave.
    const n = vistos.get(h) ?? 0
    vistos.set(h, n + 1)
    linhas.push({
      empresa_id: cfg.empresa_id,
      merchant_id: cfg.merchant_id,
      chave: `${h}#${n}`,
      nome: ev.name.trim(),
      descricao: ev?.description ?? null,
      gatilho: ev?.trigger ?? null,
      produto: ev?.product ?? null,
      competencia: ev?.competence ?? null,
      periodo_ini: dataValida(ev?.period?.beginDate),
      periodo_fim: dataValida(ev?.period?.endDate),
      id_saldo: ev?.period?.idSaldo != null ? String(ev.period.idSaldo) : null,
      referencia_tipo: ev?.reference?.type ?? null,
      referencia_id: ev?.reference?.id ?? null,
      referencia_em: ev?.reference?.date ?? null,
      valor: numOuNull(ev?.amount?.value)!,
      impacta_repasse: ev?.hasTransferImpact !== false,
      previsao_pagamento: dataValida(ev?.settlement?.expectedDate),
      metodo_pagamento: ev?.payment?.method ?? null,
      responsavel: ev?.payment?.liability ?? null,
      base_calculo: numOuNull(ev?.billing?.baseValue),
      percentual: numOuNull(ev?.billing?.feePercentage),
      bruto: ev,
      sincronizado_em: new Date().toISOString(),
    })
  }
  return { linhas, descartados }
}
