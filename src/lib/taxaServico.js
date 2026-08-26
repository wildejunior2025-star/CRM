// Taxa de serviço da mesa: quanto ela dá e sobre o que ela incide.
//
// Nem tudo que está na conta entra na conta dos 10%. Categoria marcada como
// ISENTA (mig 0192) fica de fora — o caso que criou isto é o "Couvert
// artístico" da Saidera: aquilo é o cachê do músico, não serviço de mesa.
// Cobrar taxa em cima dele é, pro cliente, taxa sobre taxa.
//
// Quem manda de verdade é o banco (`fechar_conta_presencial` calcula igual a
// isto). Estas funções existem pra tela e pro papel mostrarem o MESMO número
// que vai ser cobrado — conta impressa diferente da conta na tela é briga no
// balcão.

/** O item é de categoria isenta? Vale pros dois formatos de item que rodam por aí. */
export function itemIsento(item) {
  return item?.isento_taxa === true
}

/** Quanto o item soma (aceita comanda_itens e o item do RPC da mesa). */
function valorDoItem(item) {
  const qtd = Number(item?.quantidade ?? item?.qtd ?? 1)
  const unit = Number(item?.preco_unitario ?? item?.preco ?? 0)
  return unit * qtd
}

/** Soma de tudo que está na conta. */
export function subtotalDeItens(itens) {
  return (itens ?? []).reduce((s, i) => s + valorDoItem(i), 0)
}

/** Soma só do que a taxa pega — o subtotal menos os isentos. */
export function baseDaTaxa(itens) {
  return (itens ?? []).reduce((s, i) => s + (itemIsento(i) ? 0 : valorDoItem(i)), 0)
}

/** A taxa em reais, já arredondada em centavos como o banco faz. */
export function calcularTaxa(itens, pct, aplicar = true) {
  if (!aplicar) return 0
  return Math.round(baseDaTaxa(itens) * (Number(pct) || 0) / 100 * 100) / 100
}

/** Tem algum isento na conta? (só então vale explicar isso no papel) */
export function temIsento(itens) {
  return (itens ?? []).some(itemIsento)
}

// O que aparece grudado no nome do item, na tela e no papel.
export const MARCA_ISENTO = '(isento de taxa)'
