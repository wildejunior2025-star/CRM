// Preço do produto conforme a QUANTIDADE que o cliente leva (atacado).
//
// A CD Bom (e toda loja que vende no atacado) anuncia dois preços pro mesmo
// produto: "R$ 1,00 a unidade, a partir de 10 sai a R$ 0,60". Até aqui isso só
// existia escrito na DESCRIÇÃO — o sistema cobrava sempre o valor do campo de
// preço. Como a loja põe o valor de atacado no campo, quem comprava 1 unidade
// pagava o preço de quem compra 10.
//
// As faixas vêm de `produtos.faixas_preco`, que a tela de Produtos já salva no
// formato [{ qtd_min, preco }]. Vale a MAIOR faixa que a quantidade alcança, e
// dá pra ter várias (10+ a R$ 0,60, 100+ a R$ 0,50).
//
// Faixa com qtd_min <= 1 é ignorada: ela valeria pra qualquer quantidade e
// viraria o preço normal, escondendo o valor do campo sem ninguém entender.

/** Faixas válidas, da maior qtd_min pra menor (a primeira que couber ganha). */
export function faixasOrdenadas(faixas) {
  return (Array.isArray(faixas) ? faixas : [])
    .map(f => ({ qtd_min: Number(f?.qtd_min) || 0, preco: Number(f?.preco) || 0 }))
    .filter(f => f.qtd_min > 1 && f.preco > 0)
    .sort((a, b) => b.qtd_min - a.qtd_min)
}

/**
 * Preço unitário para essa quantidade.
 *
 * Promoção (mig 0202) e faixa de atacado são os dois desconto, e podem estar
 * ligadas ao mesmo tempo. Quem manda é o MENOR preço que valer pra quantidade
 * pedida — cliente que leva dez não pode pagar mais caro por causa de uma
 * promoção que era pra ser vantagem.
 *
 * @param precoBase    preço cheio do produto (unidade avulsa)
 * @param faixas       produtos.faixas_preco
 * @param qtd          quantas unidades o cliente leva
 * @param promocional  produtos.preco_promocional (null = sem promoção)
 */
export function precoPorQuantidade(precoBase, faixas, qtd, promocional = null) {
  const base = Number(precoBase) || 0
  const n = Number(qtd) || 0
  const faixa = faixasOrdenadas(faixas).find(f => n >= f.qtd_min)
  const promo = Number(promocional) > 0 && Number(promocional) < base ? Number(promocional) : null

  if (faixa && promo != null) return Math.min(faixa.preco, promo)
  if (faixa) return faixa.preco
  if (promo != null) return promo
  return base
}

/**
 * O produto está em promoção? Devolve o preço antigo pra riscar na tela, ou
 * null. Só vale como promoção se for MENOR que o preço cheio: riscar um valor
 * e mostrar outro igual ao lado só confunde.
 */
export function precoRiscado(precoBase, promocional) {
  const base = Number(precoBase) || 0
  const promo = Number(promocional) || 0
  return promo > 0 && promo < base ? base : null
}

/**
 * A faixa que está valendo agora (ou null se está no preço cheio).
 * Serve pra tela explicar POR QUE o preço mudou: "a partir de 10 unidades".
 */
export function faixaAplicada(faixas, qtd) {
  const n = Number(qtd) || 0
  return faixasOrdenadas(faixas).find(f => n >= f.qtd_min) ?? null
}

/**
 * A menor faixa cadastrada — o primeiro degrau de desconto.
 * O card do produto usa pra chamar o cliente: "10+ por R$ 0,60".
 */
export function menorFaixa(faixas) {
  const ord = faixasOrdenadas(faixas)
  return ord.length ? ord[ord.length - 1] : null
}
