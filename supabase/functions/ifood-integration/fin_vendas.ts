// API Sales — o pedido inteiro do ponto de vista financeiro: status, forma de
// pagamento e quem recebeu, valor bruto, taxas e o saldo líquido oficial.
// Rota: GET /financial/v3.0/merchants/{id}/sales?beginSalesDate&endSalesDate&page
// Pagina com page / pageCount.
import { type CtxIfood, getJson } from "./fin_http.ts"
import { numOuNull, redondo } from "./fin_util.ts"

const MAX_PAGINAS = 50

const RESPONSAVEL: Record<string, string> = { IFOOD: "iFood", MERCHANT: "loja" }
const METODO: Record<string, string> = {
  PIX: "PIX", CREDIT: "crédito", DEBIT: "débito", CASH: "dinheiro",
  MEAL_VOUCHER: "vale-refeição", FOOD_VOUCHER: "vale-alimentação", BANK_PAY: "débito online",
  DIGITAL_WALLET: "carteira digital",
}

export async function buscarVendasDaSemana(ctx: CtxIfood, ini: string, fim: string) {
  const vendas: any[] = []
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const j = await getJson(ctx,
      `/financial/v3.0/merchants/${ctx.cfg.merchant_id}/sales?beginSalesDate=${ini}&endSalesDate=${fim}&page=${p}`)
    const lista = Array.isArray(j?.sales) ? j.sales : []
    vendas.push(...lista)
    const paginas = Number(j?.pageCount)
    if (lista.length === 0 || !Number.isFinite(paginas) || p >= paginas) break
  }
  return vendas
}

export function linhasDeVendas(cfg: any, vendas: any[]) {
  const porId = new Map<string, any>()
  let descartadas = 0
  for (const v of vendas) {
    if (typeof v?.id !== "string" || !v.id) { descartadas++; continue }
    const metodos = (Array.isArray(v?.payments?.methods) ? v.payments.methods : [])
    const pago = metodos.reduce((s: number, m: any) => s + (numOuNull(m?.value) ?? 0), 0)
    const entradas = Array.isArray(v?.billingSummary?.billingEntries) ? v.billingSummary.billingEntries : []
    const taxas = entradas.reduce((s: number, e: any) => {
      const n = numOuNull(e?.value) ?? 0
      return n < 0 ? s + Math.abs(n) : s
    }, 0)
    porId.set(v.id, {
      empresa_id: cfg.empresa_id,
      merchant_id: cfg.merchant_id,
      venda_id: v.id,
      numero_curto: v?.shortId != null ? String(v.shortId) : null,
      criado_em: v?.createdAt ?? null,
      status: v?.currentStatus ?? null,
      canal: v?.salesChannel ?? null,
      tipo: v?.type ?? null,
      valor_itens: numOuNull(v?.saleGrossValue?.bag),
      taxa_entrega: numOuNull(v?.saleGrossValue?.deliveryFee),
      taxa_servico: numOuNull(v?.saleGrossValue?.serviceFee),
      beneficios: numOuNull(v?.benefits?.totalValue),
      pago_total: redondo(pago),
      metodos: metodos
        .map((m: any) => `${METODO[m?.method] ?? m?.method ?? "?"} (${RESPONSAVEL[m?.liability] ?? m?.liability ?? "?"})`)
        .join(", ") || null,
      comissoes_taxas: redondo(taxas),
      saldo: numOuNull(v?.billingSummary?.saleBalance),
      bruto: v,
      sincronizado_em: new Date().toISOString(),
    })
  }
  return { linhas: [...porId.values()], descartadas }
}
