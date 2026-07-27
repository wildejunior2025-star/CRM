// Quanto os complementos escolhidos somam no preço do item.
//
// Cada grupo decide COMO cobra (coluna `regra_preco`, migration 0120):
//
//   'somar'  padrão de sempre — cada opção escolhida soma. Adicional de lanche,
//            borda, bebida.
//
//   'maior'  pizza meio a meio — vale só a opção mais cara do grupo. Os sabores
//            entram com o preço cheio, então Especial R$45 + Promoção R$30,99
//            dá R$45,00, e duas da Promoção dão R$30,99.
//
// A regra é por grupo, então a mesma pizza pode cobrar os sabores pelo maior e
// a borda por soma, no mesmo pedido.
//
// Usado pela Loja Online, pela Nova venda do gestor, pelo cardápio de mesa e
// pelo salão — todos calculam o mesmo preço a partir daqui. O robô do WhatsApp
// NÃO usa (ele monta o preço por conta própria): loja que cobrar pelo maior e
// vender pelo robô sairia com preço somado.

/** É um grupo que cobra pelo sabor mais caro? */
export function cobraPeloMaior(grupo) {
  return grupo?.regra_preco === 'maior'
}

/**
 * Adicional total dos complementos escolhidos.
 *
 * @param grupos  grupos do produto (precisam trazer `id` e `regra_preco`)
 * @param itens   escolhas: [{ grupoId, preco, qtd? }]
 */
export function adicionalComplementos(grupos, itens) {
  const porGrupo = new Map()
  for (const item of itens ?? []) {
    const lista = porGrupo.get(item.grupoId) ?? []
    lista.push(item)
    porGrupo.set(item.grupoId, lista)
  }

  let total = 0
  for (const [grupoId, lista] of porGrupo) {
    const grupo = (grupos ?? []).find(g => String(g.id) === String(grupoId))
    const precos = lista.map(i => Number(i.preco) || 0)
    if (cobraPeloMaior(grupo)) {
      // Quantidade não faz sentido aqui (é meia pizza, não item repetido).
      total += precos.length ? Math.max(...precos) : 0
    } else {
      total += lista.reduce((s, i) => s + (Number(i.preco) || 0) * Number(i.qtd ?? 1), 0)
    }
  }
  return total
}

/**
 * Separa as opções do grupo em blocos pelo sufixo entre parênteses do fim do nome:
 * "Marguerita (Promoção)" e "Marguerita (Tradicional)" viram dois blocos, "Promoção"
 * e "Tradicional", e o nome mostrado perde o sufixo (o subtítulo já diz de onde é).
 *
 * É só ORGANIZAÇÃO VISUAL: continua tudo dentro do mesmo grupo, então a regra de
 * "escolha 2 sabores" segue valendo pro conjunto — diferente de quebrar em grupos
 * de verdade (Borda Salgada/Borda Doce), onde daria pra escolher um de cada.
 *
 * Sem sufixo, ou com um sufixo só, devolve um bloco único sem título (lista normal).
 */
export function blocosDeOpcoes(opcoes) {
  const lista = opcoes ?? []
  const sufixo = o => (String(o?.nome || '').match(/\(([^()]*)\)\s*$/)?.[1] ?? '').trim()
  const distintos = new Set(lista.map(sufixo).filter(Boolean))
  if (distintos.size < 2) return [{ titulo: null, opcoes: lista }]
  const blocos = []
  for (const o of lista) {
    const t = sufixo(o) || 'Outros'
    let bloco = blocos.find(b => b.titulo === t)
    if (!bloco) blocos.push(bloco = { titulo: t, opcoes: [] })
    // nomeCurto é só pra tela: o carrinho e a cozinha continuam com o nome inteiro.
    bloco.opcoes.push({ ...o, nomeCurto: String(o.nome).replace(/\s*\([^()]*\)\s*$/, '').trim() || o.nome })
  }
  return blocos
}

/**
 * Como mostrar o preço de uma opção na lista.
 * Grupo que soma mostra "+ R$ 5,00"; grupo que cobra pelo maior mostra
 * "R$ 35,00" — ali o valor não é acréscimo, é o preço daquele sabor.
 */
export function rotuloPrecoOpcao(grupo, precoAdicional, fmt) {
  const v = Number(precoAdicional) || 0
  if (v <= 0) return null
  return cobraPeloMaior(grupo) ? `R$ ${fmt(v)}` : `+ R$ ${fmt(v)}`
}
