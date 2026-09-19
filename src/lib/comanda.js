// Rótulo de uma comanda, do mesmo jeito em toda a tela e no papel.
//
// A comanda de BALCÃO (mig 0143) não pertence a mesa nenhuma e tem numeração
// própria, que zera todo dia. Ou seja: a "Comanda 3" e a "Mesa 3" podem existir
// ao mesmo tempo — é o rótulo que separa as duas no Salão, na Cozinha, no painel
// do gestor, na conta impressa e no histórico. Espelha rotulo_comanda() do banco.
export function rotuloComanda(c, { comNome = true } = {}) {
  if (!c) return 'Mesa —'
  if (c.tipo === 'balcao') {
    const nome = comNome ? String(c.nome_cliente ?? '').trim() : ''
    return `Comanda ${String(c.numero_mesa ?? '').padStart(2, '0')}${nome ? ` · ${nome}` : ''}`
  }
  return `Mesa ${c.numero_mesa ?? '—'}`
}

export const ehComandaBalcao = (c) => c?.tipo === 'balcao'

// JUNTA O MESMO PRODUTO NUMA LINHA SÓ.
//
// No banco cada lançamento é uma linha própria de comanda_itens, e tem que ser:
// é a linha que guarda QUEM lançou (o ponto do garçom, mig 0187), quando, e o
// status na cozinha. Mas na tela e no papel isso virava "1x Amstel, 1x Amstel,
// 1x Amstel" — a lista do tamanho do mundo (Saidera, 18/09). Aqui as linhas
// iguais viram uma só com a quantidade somada; `itens` guarda as de verdade,
// da mais antiga pra mais nova, pra quem precisar mexer nelas.
//
// Igual = mesmo produto, nome (que carrega a montagem), preço e isenção. A
// observação separa na tela ("sem gelo" não é a mesma cerveja pra quem serve),
// mas não na conta, onde ela nem aparece — `porObs: false`.
export function agruparItensComanda(itens, { porObs = true } = {}) {
  const grupos = new Map()
  const ordenados = [...(itens ?? [])].sort((a, b) => new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0))
  for (const it of ordenados) {
    const preco = Number(it.preco_unitario ?? it.preco ?? 0)
    const chave = [
      it.produto_id ?? '', String(it.nome ?? '').trim().toLowerCase(), preco.toFixed(2),
      it.isento_taxa === true ? 'i' : '',
      porObs ? String(it.observacao ?? '').trim().toLowerCase() : '',
      JSON.stringify(it.complementos ?? null),
    ].join('|')
    const q = Number(it.quantidade ?? it.qtd ?? 1)
    const g = grupos.get(chave)
    if (!g) {
      grupos.set(chave, {
        ...it, chave, quantidade: q, itens: [it],
        ...(it.subtotal != null ? { subtotal: Number(it.subtotal) } : {}),
      })
    } else {
      g.quantidade += q
      if (g.subtotal != null) g.subtotal += Number(it.subtotal ?? q * preco)
      g.itens.push(it)
    }
  }
  return [...grupos.values()]
}
