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
// Lojas que pedem ao motoboy o valor da corrida (Zebu, teste — mig 0344): o valor DIGITADO
// por ele vale no lugar de "taxa − desconto". Sem valor digitado, a regra de sempre.
// No banco: COALESCE(valor_entregador, GREATEST(0, taxa − desconto)) em entregadores_resumo/acertos.
export const temValorDigitado = pedido =>
  pedido?.valor_entregador != null && pedido.valor_entregador !== ''

// Texto curto de onde veio o valor da corrida e se foi EDITADO (mig 0345): o dono precisa ver
// quando o motoboy mudou o que o sistema calculou. `editado` pinta de laranja nas listas.
export function rotuloValorEntregador(pedido) {
  if (!temValorDigitado(pedido)) return null
  const calc = pedido.valor_entregador_calculado
  const rs = v => `R$ ${Number(v).toFixed(2).replace('.', ',')}`
  const sistema = calc != null ? ` (sistema calculou ${rs(calc)})` : ' (o sistema não conseguiu calcular)'
  switch (pedido.valor_entregador_origem) {
    // 'taxa' (mig 0393): o valor E a taxa que o cliente pagou. E o caso normal
    // desde que a tabela de km virou reserva — nao e edicao de ninguem.
    case 'taxa':      return { texto: '💵 taxa paga pelo cliente', editado: false }
    case 'calculado': return { texto: '📍 calculada pelo sistema', editado: false }
    case 'motoboy':   return { texto: `✏️ editada pelo motoboy${sistema}`, editado: true }
    case 'dono':      return { texto: `✏️ editada pelo dono${sistema}`, editado: true }
    default:          return { texto: '✍️ valor informado', editado: false }
  }
}

export function descontoDoPedido(descontos, pedido) {
  if (temValorDigitado(pedido)) return 0
  const d = String(pedido?.origem) === 'ifood' ? descontos?.ifood : descontos?.loja
  if (!d) return 0
  if (!d.pct) return d.valor
  const taxa = Number(pedido?.taxa_entrega) || 0
  return Math.round(taxa * Math.min(d.valor, 100)) / 100
}

// O que o motoqueiro recebe naquela corrida: a taxa cheia menos o que fica com a loja.
export function ganhoDaCorrida(descontos, pedido) {
  if (temValorDigitado(pedido)) return Math.max(0, Number(pedido.valor_entregador) || 0)
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
