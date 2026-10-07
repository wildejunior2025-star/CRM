// API Settlements — a consolidação semanal: quanto o iFood vai transferir, em
// quais títulos (REPASSE, BOLETO, REGISTRO_RECEBIVEIS), com que status e, quando
// pago, pra qual conta.
// Rota: GET /financial/v3.0/merchants/{id}/settlements?beginCalculationDate&endCalculationDate
// (a outra forma aceita é por beginPaymentDate/endPaymentDate).
//
// O ambiente de teste do iFood devolve a lista VAZIA, então o formato dos títulos
// vem do guia de mapeamento (closingItems[].amount/status/type). Tudo que não é
// conhecido fica no `bruto` pra ajustar quando vier o primeiro dado real.
import { type CtxIfood, getJson } from "./fin_http.ts"
import { dataValida, numOuNull, sha256 } from "./fin_util.ts"

// Campos de conta bancária: nome de campo varia, então pega o que PARECE banco.
const PARECE_BANCO = /bank|banco|agenc|branch|account|conta|ispb|pix|document/i

function dadosBancarios(item: any) {
  const achados: Record<string, unknown> = {}
  const visitar = (obj: any, prefixo = "") => {
    if (!obj || typeof obj !== "object") return
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) visitar(v, `${prefixo}${k}.`)
      else if (PARECE_BANCO.test(k) || PARECE_BANCO.test(prefixo)) achados[`${prefixo}${k}`] = v
    }
  }
  visitar(item)
  return Object.keys(achados).length ? achados : null
}

export async function buscarLiquidacaoDaSemana(ctx: CtxIfood, ini: string, fim: string) {
  return await getJson(ctx,
    `/financial/v3.0/merchants/${ctx.cfg.merchant_id}/settlements?beginCalculationDate=${ini}&endCalculationDate=${fim}`)
}

// API Anticipations — a loja que antecipa recebe antes e paga uma taxa; o que
// cai na conta é o valor já descontado. Sem antecipação a resposta vem vazia.
export async function buscarAntecipacaoDaSemana(ctx: CtxIfood, ini: string, fim: string) {
  return await getJson(ctx,
    `/financial/v3.0/merchants/${ctx.cfg.merchant_id}/anticipations?beginCalculationDate=${ini}&endCalculationDate=${fim}`)
}

export function resumoDaAntecipacao(j: any) {
  const settlements = Array.isArray(j?.settlements) ? j.settlements : []
  // Um item por periodo de apuracao: o portal do iFood mostra exatamente isso
  // (previsao de pagamento ANTECIPADA, subtotal, taxa e o que cai na conta).
  // A API Settlements devolve a data sem antecipacao (D+30), por isso a data boa
  // pro lojista so existe aqui.
  const itens = settlements.flatMap((s: any) => {
    const ini = dataValida(s?.period?.beginDate ?? s?.startDateCalculation ?? s?.beginDate)
    const fim = dataValida(s?.period?.endDate ?? s?.endDateCalculation ?? s?.endDate)
    const lista = Array.isArray(s?.closingItems) && s.closingItems.length ? s.closingItems : [s]
    return lista.map((it: any) => ({
      periodo_ini: dataValida(it?.period?.beginDate ?? it?.beginDate) ?? ini,
      periodo_fim: dataValida(it?.period?.endDate ?? it?.endDate) ?? fim,
      pagamento: dataValida(
        it?.anticipatedPaymentDate ?? it?.anticipationPaymentDate ?? it?.paymentDate ??
        it?.expectedPaymentDate ?? s?.anticipatedPaymentDate ?? s?.paymentDate ?? s?.expectedPaymentDate),
      pagamento_normal: dataValida(it?.originalPaymentDate ?? s?.originalPaymentDate),
      taxa: numOuNull(it?.feeAmount ?? it?.anticipationFee),
      taxa_pct: numOuNull(it?.feePercentage),
      liquido: numOuNull(it?.anticipatedPaymentAmount ?? it?.netAmount),
      subtotal: numOuNull(it?.originalPaymentAmount ?? it?.amount ?? it?.originalAmount ?? it?.grossAmount),
      status: it?.status ?? s?.status ?? null,
      conta: it?.accountDetails ?? dadosBancarios(it),
      bruto: it,
    }))
  })
  if (!itens.length) return { antecipado: null, taxa: null, itens: null }
  const taxa = itens.reduce((soma: number, it: any) => soma + (it.taxa ?? 0), 0)
  const liquido = numOuNull(j?.balance)
    ?? itens.reduce((soma: number, it: any) => soma + (it.liquido ?? 0), 0)
  return { antecipado: Math.round(liquido * 100) / 100, taxa: Math.round(taxa * 100) / 100, itens }
}

export async function linhasDeLiquidacao(cfg: any, semanaIni: string, semanaFim: string, j: any) {
  const settlements = Array.isArray(j?.settlements) ? j.settlements : []
  const titulos: any[] = []

  for (const s of settlements) {
    const pIni = dataValida(s?.period?.beginDate ?? s?.startDateCalculation ?? s?.beginDate) ?? semanaIni
    const pFim = dataValida(s?.period?.endDate ?? s?.endDateCalculation ?? s?.endDate) ?? semanaFim
    const itens = Array.isArray(s?.closingItems) && s.closingItems.length ? s.closingItems : [s]
    let n = 0
    for (const it of itens) {
      const status = it?.status ?? s?.status ?? null
      const base = JSON.stringify([
        cfg.merchant_id, pIni, pFim, it?.id ?? it?.titleId ?? it?.number ?? null,
        it?.type ?? s?.type ?? null, numOuNull(it?.amount ?? s?.amount), n++,
      ])
      titulos.push({
        empresa_id: cfg.empresa_id,
        merchant_id: cfg.merchant_id,
        chave: await sha256(base),
        semana_ini: semanaIni,
        periodo_ini: pIni,
        periodo_fim: pFim,
        data_pagamento: dataValida(it?.paymentDate ?? it?.expectedPaymentDate ?? s?.paymentDate ?? s?.expectedPaymentDate),
        tipo: it?.type ?? s?.type ?? null,
        status,
        valor: numOuNull(it?.amount ?? s?.amount),
        // Dados bancários só quando o pagamento aconteceu (critério do iFood).
        dados_bancarios: String(status).toUpperCase() === "SUCCEED" ? dadosBancarios(it) : null,
        bruto: { settlement: s, item: it },
        sincronizado_em: new Date().toISOString(),
      })
    }
  }

  // Na prática o `balance` vem 0 mesmo quando houve repasse: quem carrega o
  // valor são os títulos de SALDO POSITIVO. Os de REGISTRO_RECEBIVEIS e
  // RENEGOCIADA repetem o mesmo dinheiro (parte do repasse vai pro banco por
  // acordo de recebíveis) — somar todos contaria em dobro.
  const saldoDosTitulos = titulos
    .filter((t) => /SALDO POSITIVO|REPASSE/i.test(String(t.tipo ?? "")))
    .reduce((soma, t) => soma + (t.valor ?? 0), 0)
  const balance = numOuNull(j?.balance) ?? 0

  const semana = {
    empresa_id: cfg.empresa_id,
    merchant_id: cfg.merchant_id,
    semana_ini: semanaIni,
    semana_fim: semanaFim,
    saldo: balance !== 0 ? balance : Math.round(saldoDosTitulos * 100) / 100,
    qtd_titulos: titulos.length,
    consultado_em: new Date().toISOString(),
  }
  return { semana, titulos }
}
