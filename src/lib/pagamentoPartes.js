// Pagamento do pedido de delivery em PARTES (mig 0274).
//
// Pedido comum tem uma forma só (`forma_pagamento`); o dividido tem
// `forma_pagamento = 'dividido'` e a lista em `pagamentos`. Toda tela que
// precisa saber "quanto em cada forma" passa por `partesPagamento`, que devolve
// a lista nos dois casos — assim ninguém precisa tratar o dividido à parte, e
// ninguém conta o total inteiro numa forma que só pagou metade.

export const NOME_FORMA = {
  dinheiro: 'Dinheiro',
  pix: 'PIX',
  pix_entrega: 'PIX na entrega',
  credito: 'Crédito',
  debito: 'Débito',
  cartao: 'Cartão',
  'cartão': 'Cartão',
  online: 'Pago online',
  vale: 'Vale',
  outro: 'Outro',
  dividido: 'Dividido',
}

export const nomeForma = f => NOME_FORMA[f] ?? (f || '—')

/** [{ forma, valor, troco_para }] — uma parte só quando o pedido não é dividido. */
export function partesPagamento(p) {
  if (Array.isArray(p?.pagamentos) && p.pagamentos.length) {
    return p.pagamentos.map(x => ({
      forma: x.forma,
      valor: Number(x.valor) || 0,
      troco_para: x.troco_para != null ? Number(x.troco_para) : null,
    }))
  }
  return [{
    forma: p?.forma_pagamento || '',
    valor: Number(p?.total) || 0,
    troco_para: p?.forma_pagamento === 'dinheiro' && p?.troco_para != null ? Number(p.troco_para) : null,
  }]
}

export const ehDividido = p => Array.isArray(p?.pagamentos) && p.pagamentos.length > 1

export const pixConfirmado = p => p?.pix_status === 'pago' || p?.mp_payment_status === 'approved'

/** O pedido tem uma parte (ou é inteiro) no PIX online do Mercado Pago? */
export const temPixOnline = p => partesPagamento(p).some(x => x.forma === 'pix')

/** Esta parte já está paga antes da entrega? (iFood online ou PIX confirmado) */
export function partePaga(p, parte) {
  if (parte.forma === 'online') return true
  if (parte.forma === 'pix') return pixConfirmado(p)
  return false
}

/** Quanto ainda falta cobrar do cliente na porta. */
export function aCobrarNaEntrega(p) {
  return Math.round(partesPagamento(p)
    .filter(x => !partePaga(p, x))
    .reduce((s, x) => s + x.valor, 0) * 100) / 100
}

/** Troco que o motoqueiro leva (0 = não precisa). */
export function trocoALevar(parte) {
  if (parte.forma !== 'dinheiro' || !(parte.troco_para > 0)) return 0
  return Math.max(0, Math.round((parte.troco_para - parte.valor) * 100) / 100)
}

const brl = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',')

/** "Dinheiro R$ 30,00 + PIX R$ 20,00" (pedido comum: só o nome da forma). */
export function textoPagamento(p) {
  if (!ehDividido(p)) return nomeForma(p?.forma_pagamento)
  return partesPagamento(p).map(x => `${nomeForma(x.forma)} ${brl(x.valor)}`).join(' + ')
}
