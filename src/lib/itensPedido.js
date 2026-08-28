// Normaliza um item de pedido pra exibição, separando o nome dos complementos.
//
// Pedidos NOVOS já vêm com `complementos` estruturados. Pedidos ANTIGOS (feitos
// antes do ajuste) trazem tudo colado no nome, ex.:
//   "Quentinha (M) (Feijão Preto, Arroz, Farofa)"
// Aqui, quando não há `complementos`, separamos o último parêntese que contém
// vírgulas (lista de adicionais) — sem quebrar nomes com tamanho, ex. "(G)".
//
// ── Quantidade do complemento: por unidade x absoluta ──────────────────────
// `qtd` sempre quis dizer "quanto vai em CADA unidade do item": 4 quentinhas
// com 2 arroz = 8 arroz. Quem mostra multiplicava por conta própria, cada um no
// seu arquivo (cupom, Bluetooth, painel, entregador, cozinha).
//
// O grupo em `modo_quantidade` (migration 0200) inverte isso: os sabores
// DIVIDEM o total em vez de multiplicar. Um pedido de 600 picolés com 500 de
// leite condensado tem quantidade 600 no item — porque é assim que o estoque dá
// baixa certa — e 500 no complemento. Multiplicar imprimiria 300.000 na comanda.
// Esses vêm marcados com `absoluto: true`.
//
// Pra ninguém ter que lembrar dessa regra em cinco lugares, a conta é feita
// UMA vez aqui e sai pronta em `qtdTotal`. Quem exibe só lê.

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

  const qtdItem = Number(item?.quantidade ?? item?.qtd ?? 1) || 1
  complementos = complementos.map(c => {
    const q = Number(c?.qtd ?? 1) || 1
    return { ...c, qtdTotal: c?.absoluto ? q : q * qtdItem }
  })

  return { nome, complementos }
}
