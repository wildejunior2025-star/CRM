import { criarBuscadorDescricao, comDescricaoNasOpcoes } from './descricaoSabor'
import { fetchAll } from './supabaseClient'

// Cardápio que o cliente vê SEM login: usado no QR da mesa e no link do cliente.
//
// Lê direto pela anon key (estoque_catalogo, categorias, produtos e os grupos de
// complemento têm grant/policy pro anônimo) — as duas telas mostram exatamente o
// mesmo cardápio, então a montagem mora aqui e não em cada página.

// Grupo que só tem "Sem cebola"/"Não quero" não é escolha de verdade: some do
// cardápio pra não fazer o cliente abrir um modal que não muda nada.
const soSemOpcao = nome => /^\s*sem\s|n[ãa]o\s*quero/i.test(String(nome || ''))

export async function carregarCardapio(supabase, empresaId) {
  // fetchAll pagina de 1000 em 1000: loja de deposito passa de 4 mil itens e tanto
  // o limite antigo de 500 quanto o corte do PostgREST sumiam com o resto do cardapio.
  const { data: produtos } = await fetchAll(() => supabase
    .from('estoque_catalogo')
    .select('produto_id, nome, preco_venda, categoria, foto_url, ordem')
    .eq('empresa_id', empresaId)
    // Mesma ordem que o dono montou na tela de Produtos (mig 0201): sem isso o
    // cardapio da mesa sairia alfabetico e o do celular na ordem escolhida.
    .order('categoria').order('ordem', { nullsFirst: false }).order('nome').order('produto_id'))

  // Ordem personalizada das categorias (a mesma da loja online)
  const { data: cats } = await supabase
    .from('categorias').select('nome, ordem').eq('empresa_id', empresaId)
  const catOrdem = {}
  for (const c of (cats ?? [])) catOrdem[c.nome] = c.ordem ?? 999

  const ids = (produtos ?? []).map(p => p.produto_id)
  const compMap = {}
  if (ids.length) {
    // Sabor de pizza também é produto: a descrição dele vira o "o que vem dentro".
    const { data: descData } = await fetchAll(() => supabase.from('produtos')
      .select('nome, categoria, descricao').eq('empresa_id', empresaId).eq('ativo', true).order('id'))
    const descricaoDaOpcao = criarBuscadorDescricao(descData)

    // O .in() viaja na URL: com milhares de ids de uma vez o request estoura o
    // tamanho maximo, entao pergunta de 300 em 300 e junta.
    const vinc = []
    for (let i = 0; i < ids.length; i += 300) {
      const { data: lote } = await fetchAll(() => supabase
        .from('produto_complemento_grupos')
        .select('produto_id, ordem, min_override, max_override, complemento_grupos(id, nome, min, max, disponivel, regra_preco, complemento_opcoes(id, nome, descricao, preco_adicional, ordem, disponivel))')
        .in('produto_id', ids.slice(i, i + 300))
        .order('ordem').order('produto_id'))
      vinc.push(...(lote ?? []))
    }

    for (const v of (vinc ?? [])) {
      const g = v.complemento_grupos
      if (!g || g.disponivel === false) continue      // grupo pausado some do cardápio
      const opcoes = comDescricaoNasOpcoes(
        (g.complemento_opcoes ?? [])
          .filter(o => o.disponivel !== false)
          .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)),
        descricaoDaOpcao,
      )
      if (!opcoes.some(o => !soSemOpcao(o.nome))) continue
      ;(compMap[v.produto_id] ??= []).push({
        id: g.id, nome: g.nome,
        min: v.min_override ?? g.min ?? 0,
        max: v.max_override ?? g.max ?? 1,
        regra_preco: g.regra_preco ?? 'somar',
        opcoes,
      })
    }
  }

  return { produtos: produtos ?? [], catOrdem, compMap }
}

// Itens do carrinho -> payload das RPCs mesa_pedir / cliente_pedir. O nome já vai
// com a montagem entre parênteses ("Quentinha (Arroz, Frango)") porque comanda_itens
// guarda uma linha só por item — é assim que a cozinha lê o que foi escolhido.
export function itensParaPedido(itens) {
  return itens.map(i => {
    const comps = i.complementos ?? []
    const nome = comps.length ? `${i.nome} (${comps.map(c => c.nome).join(', ')})` : i.nome
    return { produto_id: i.produto_id ?? i.id, nome, preco: i.preco, qtd: i.qtd }
  })
}
