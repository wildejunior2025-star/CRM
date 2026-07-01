// Normaliza um item de pedido pra exibição, separando o nome dos complementos.
//
// Pedidos NOVOS já vêm com `complementos` estruturados. Pedidos ANTIGOS (feitos
// antes do ajuste) trazem tudo colado no nome, ex.:
//   "Quentinha (M) (Feijão Preto, Arroz, Farofa)"
// Aqui, quando não há `complementos`, separamos o último parêntese que contém
// vírgulas (lista de adicionais) — sem quebrar nomes com tamanho, ex. "(G)".
export function separarItem(item) {
  let nome = String(item?.nome ?? '')
  let complementos = Array.isArray(item?.complementos) ? item.complementos : []

  if (!complementos.length) {
    const m = nome.match(/^(.*)\((.+)\)\s*$/) // guloso: pega o ÚLTIMO parêntese
    if (m && m[2].includes(',')) {            // só separa se for lista (tem vírgula)
      nome = m[1].trim()
      complementos = m[2]
        .split(',')
        .map(s => ({ nome: s.trim(), qtd: 1 }))
        .filter(c => c.nome)
    }
  }

  return { nome, complementos }
}
