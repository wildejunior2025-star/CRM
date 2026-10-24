import { partesPagamento, ehDividido, textoPagamento } from './pagamentoPartes'

// Como o cliente pagou: se o entregador ficou com o dinheiro na mão, é repasse pra loja.
// PIX confirmado e pedido pago online (iFood) já caíram na conta — não se repassa.
// Pagamento em duas formas (mig 0274): cada parte cai no seu balde. Só o que é
// dinheiro/cartão/PIX não confirmado fica "na mão" do motoqueiro.
export function partesCobranca(p) {
  return partesPagamento(p).map(x => ({
    ...cobranca({ ...p, forma_pagamento: x.forma, pagamentos: null }),
    valor: x.valor,
  }))
}

export function cobranca(p) {
  if (ehDividido(p)) {
    const partes = partesCobranca(p)
    return { tipo: partes.every(x => x.tipo === 'conta') ? 'conta' : 'dividido', label: textoPagamento(p) }
  }
  const f = p.forma_pagamento, ehIfood = p.origem === 'ifood'
  if (f === 'dinheiro') return { tipo: 'dinheiro', label: 'Dinheiro' + (ehIfood ? ' (via iFood)' : '') }
  if (['cartao', 'cartão', 'credito', 'debito'].includes(f)) {
    const n = f === 'debito' ? 'Débito' : f === 'credito' ? 'Crédito' : 'Cartão'
    return { tipo: 'cartao', label: n + (ehIfood ? ' (via iFood)' : ' (maquininha)') }
  }
  // Cartão de benefício (mig 0385): passa na maquininha do motoqueiro, como o cartão.
  if (['pluxee', 'alelo', 'vr', 'ticket'].includes(f)) {
    return { tipo: 'cartao', label: ({ pluxee: 'Pluxee', alelo: 'Alelo', vr: 'VR', ticket: 'Ticket' })[f] + (ehIfood ? ' (via iFood)' : ' (maquininha)') }
  }
  if (f === 'pix') {
    return (p.pix_status === 'pago' || p.mp_payment_status === 'approved')
      ? { tipo: 'conta', label: 'PIX pago' }
      : { tipo: 'pix', label: 'PIX não confirmado' }
  }
  // Pago na porta, mas na chave da LOJA: não passou pela mão do motoqueiro.
  if (f === 'pix_entrega') return { tipo: 'conta', label: 'PIX na entrega' }
  if (ehIfood && f !== 'online') return { tipo: 'dinheiro', label: (f || 'via iFood') + ' (via iFood)' }
  return { tipo: 'conta', label: ehIfood ? 'Pago no iFood' : (f || 'Pago') }
}
