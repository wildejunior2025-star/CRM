// Quanto a LOJA fica de cada corrida do motoqueiro.
//
// São dois valores independentes, de propósito: tem loja que cobra só nas
// corridas do iFood (o Zebu) e tem loja que cobra só nas corridas do próprio
// delivery (a CD Bom, que nem tem iFood). Um interruptor só não atendia os dois.
//
// A mesma regra vive no banco em `desconto_entrega()` (migração 0255) — os
// acertos e o resumo por entregador são somados lá. Mexeu aqui, mexa lá.
export function descontosDoEntregador(perfil) {
  const n = v => Number(v) || 0
  const ifood = perfil?.entregador_desconto_ativo && n(perfil?.entregador_desconto_valor) > 0
    ? n(perfil.entregador_desconto_valor) : 0
  const loja = perfil?.entregador_desconto_loja_ativo && n(perfil?.entregador_desconto_loja_valor) > 0
    ? n(perfil.entregador_desconto_loja_valor) : 0
  return { ifood, loja }
}

// Pedido do iFood usa o valor do iFood; todo o resto (app, loja online,
// WhatsApp, balcão) usa o valor da loja.
export function descontoDoPedido(descontos, pedido) {
  return String(pedido?.origem) === 'ifood' ? (descontos?.ifood ?? 0) : (descontos?.loja ?? 0)
}

// O que o motoqueiro recebe naquela corrida: a taxa cheia menos o que fica com a loja.
export function ganhoDaCorrida(descontos, pedido) {
  return Math.max(0, (Number(pedido?.taxa_entrega) || 0) - descontoDoPedido(descontos, pedido))
}

// Rótulo curto pra explicar o abatimento na tela ("iFood −R$ 2,00").
export function rotuloDoDesconto(pedido) {
  return String(pedido?.origem) === 'ifood' ? 'iFood' : 'loja'
}
