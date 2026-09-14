// Quanto a LOJA fica de cada corrida do motoqueiro.
//
// São dois valores independentes, de propósito: tem loja que cobra só nas
// corridas do iFood (o Zebu) e tem loja que cobra só nas corridas do próprio
// delivery (a CD Bom, que nem tem iFood). Um interruptor só não atendia os dois.
//
// Cada um pode ser em R$ fixo ou em % da taxa de entrega da corrida (mig 0268).
//
// A mesma regra vive no banco em `desconto_entrega()` (migrações 0255/0268) — os
// acertos e o resumo por entregador são somados lá. Mexeu aqui, mexa lá.
export function descontosDoEntregador(perfil) {
  const n = v => Number(v) || 0
  const um = (ativo, valor, tipo) => (ativo && n(valor) > 0
    ? { valor: n(valor), pct: tipo === 'percentual' }
    : null)
  return {
    ifood: um(perfil?.entregador_desconto_ativo, perfil?.entregador_desconto_valor, perfil?.entregador_desconto_tipo),
    loja: um(perfil?.entregador_desconto_loja_ativo, perfil?.entregador_desconto_loja_valor, perfil?.entregador_desconto_loja_tipo),
  }
}

// Pedido do iFood usa o desconto do iFood; todo o resto (app, loja online,
// WhatsApp, balcão) usa o da loja. Porcentagem é da taxa, arredondada no centavo.
export function descontoDoPedido(descontos, pedido) {
  const d = String(pedido?.origem) === 'ifood' ? descontos?.ifood : descontos?.loja
  if (!d) return 0
  if (!d.pct) return d.valor
  const taxa = Number(pedido?.taxa_entrega) || 0
  return Math.round(taxa * Math.min(d.valor, 100)) / 100
}

// O que o motoqueiro recebe naquela corrida: a taxa cheia menos o que fica com a loja.
export function ganhoDaCorrida(descontos, pedido) {
  return Math.max(0, (Number(pedido?.taxa_entrega) || 0) - descontoDoPedido(descontos, pedido))
}

// Rótulo curto pra explicar o abatimento na tela ("iFood −R$ 2,00").
export function rotuloDoDesconto(pedido) {
  return String(pedido?.origem) === 'ifood' ? 'iFood' : 'loja'
}

// "R$ 2,00" ou "10%" — como o desconto foi combinado.
export function textoDoDesconto(d) {
  if (!d) return ''
  if (d.pct) return `${String(d.valor).replace('.', ',')}%`
  return `R$ ${d.valor.toFixed(2).replace('.', ',')}`
}
