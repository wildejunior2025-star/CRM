// Cálculo do LÍQUIDO estimado do iFood (o que a loja recebe de verdade).
//
// As taxas abaixo foram CALIBRADAS com planilhas reais de repasse do iFood
// (dias 15, 16 e 17 de julho/2026). Validação cruzada deu erro < 1% no repasse do dia.
// Enquanto a integração financeira oficial (API de conciliação) não é homologada,
// esta estimativa é o que temos — e bate ~99% com o extrato.
//
// A mordida do iFood tem 2 partes:
//   • Comissão do plano  → ~11,7% sobre o VALOR DOS ITENS, em TODOS os pedidos.
//   • Taxa de transação  → ~4,5% sobre o VALOR PAGO, só nos pedidos pagos ONLINE
//                          (no pago-na-entrega/dinheiro o iFood não processa, não cobra).
export const IFOOD_COMISSAO_PCT  = 0.117
export const IFOOD_TRANSACAO_PCT = 0.0452

// pedidos: lista de pedidos_delivery do iFood, cada um com
//   { subtotal, taxa_entrega, total, ifood_valores: { incentivo_loja, pago_online } }
// rates (opcional): taxa calibrada da loja { comissao, transacao }; sem isso usa o padrão.
export function calcIfoodLiquido(pedidos = [], rates = {}) {
  const PCT_COMISSAO  = Number(rates.comissao)  > 0 ? Number(rates.comissao)  : IFOOD_COMISSAO_PCT
  const PCT_TRANSACAO = Number(rates.transacao) >= 0 && rates.transacao != null ? Number(rates.transacao) : IFOOD_TRANSACAO_PCT
  let vendas = 0            // o que os clientes pagaram (bruto)
  let comissao = 0          // comissão sobre os itens (todos os pedidos)
  let transacao = 0         // taxa de transação (só online)
  let repasse = 0           // líquido que cai na conta do iFood (só pedidos online)
  let recebidoEntrega = 0   // BRUTO recebido na mão (pago na entrega) — pra bater o caixa
  let comissaoEntrega = 0   // comissão desses pedidos, que o iFood cobra depois
  const entregaForma = {}   // quebra do "na entrega" por forma: { dinheiro:{qtd,total}, debito:{...}, ... }

  for (const p of pedidos) {
    const itens  = Number(p.subtotal || 0)
    const te     = Number(p.taxa_entrega || 0)
    const iv     = p.ifood_valores || {}
    const il     = Number(iv.incentivo_loja || 0)
    const pago   = Number(p.total || 0)
    const online = !!iv.pago_online

    const com   = PCT_COMISSAO * itens
    const trans = online ? PCT_TRANSACAO * pago : 0

    vendas    += pago
    comissao  += com
    transacao += trans

    if (online) {
      // repasse = itens + taxa de entrega (entrega própria volta inteira) − incentivo da loja − taxas
      repasse += itens + te - il - com - trans
    } else {
      recebidoEntrega += pago
      comissaoEntrega += com
      const f = p.forma_pagamento || 'outro'
      const b = entregaForma[f] || (entregaForma[f] = { qtd: 0, total: 0 })
      b.qtd += 1; b.total += pago
    }
  }

  const taxasTotal = comissao + transacao
  // Você recebe = o que cai na conta + o que entrou na mão − a comissão que ainda será cobrada da entrega
  const voceRecebe = repasse + recebidoEntrega - comissaoEntrega
  const pctTaxa = vendas > 0 ? Math.round((taxasTotal / vendas) * 100) : 0

  return { vendas, repasse, recebidoEntrega, comissaoEntrega, comissao, transacao, taxasTotal, voceRecebe, pctTaxa, entregaForma }
}

// rótulo amigável da forma de pagamento na entrega
export const FORMA_ENTREGA_LABEL = {
  dinheiro: '💵 Dinheiro',
  debito: '💳 Débito (maquininha)',
  credito: '💳 Crédito (maquininha)',
  outro: 'Outros',
}
