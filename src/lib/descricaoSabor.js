// Descrição das opções de complemento (sabores de pizza, etc.).
//
// A opção "Mussarela (Promoção)" é, na prática, o produto "Mussarela" da categoria
// "Pizzas Promoção" — mas complemento_opcoes só guarda nome e preço. Então casamos a
// opção com o produto pelo nome e mostramos a descrição do produto ("Mussarela,
// creme cheddar, requeijão cremoso, molho de tomate, orégano.") embaixo do sabor.

const normal = s => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

// "Pizzas Tradicionais" casa com a pista "(Tradicional)"; "Pizzas Promoção" com "(Promoção)".
function casaCategoria(categoria, pista) {
  const raiz = normal(pista).slice(0, 6)
  if (raiz.length < 4) return false
  return normal(categoria).split(' ').some(t => t.startsWith(raiz) || raiz.startsWith(t.slice(0, 6)))
}

/**
 * Monta a função que devolve a descrição de uma opção a partir da lista de produtos da loja.
 * @param {Array<{nome: string, categoria?: string, descricao?: string}>} produtos
 * @returns {(nomeOpcao: string) => string|null}
 */
export function criarBuscadorDescricao(produtos) {
  const porNome = {}
  for (const p of (produtos ?? [])) {
    const desc = String(p?.descricao || '').trim()
    if (!desc) continue
    ;(porNome[normal(p.nome)] ??= []).push({ categoria: p.categoria, descricao: desc })
  }
  return function descricaoDaOpcao(nomeOpcao) {
    const nome = String(nomeOpcao || '')
    if (!nome) return null
    // Tira o sufixo entre parênteses do fim: "Mussarela (Promoção)" -> "Mussarela"
    const m = nome.match(/^(.*?)\s*\(([^()]*)\)\s*$/)
    const cands = porNome[normal(nome)] ?? (m ? porNome[normal(m[1])] : null)
    if (!cands?.length) return null
    if (cands.length > 1 && m) {
      const certo = cands.find(c => casaCategoria(c.categoria, m[2]))
      if (certo) return certo.descricao
    }
    return cands[0].descricao
  }
}

/**
 * Descrição de cada opção do grupo: manda o que a loja escreveu na própria opção;
 * se estiver vazio, cai na descrição do produto de mesmo nome.
 */
export function comDescricaoNasOpcoes(opcoes, descricaoDaOpcao) {
  return (opcoes ?? []).map(o => ({
    ...o,
    descricao: String(o.descricao || '').trim() || descricaoDaOpcao(o.nome),
  }))
}
