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

const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
const chave = s => semAcento(s).toLowerCase().replace(/\s+/g, ' ').trim()

// O checkout cola a lista de complementos no fim do nome — "Picolé (10× Limão,
// 20× Uva)" — e a comanda já imprime cada sabor na linha de baixo. Repetido, o
// nome estoura a largura da bobina e o cozinheiro lê a mesma coisa duas vezes.
// Só corta se TODO pedaço de dentro do parêntese bater com um complemento do
// item; assim "Sorvete CDBOM (Balde 10 litros)" continua inteiro.
function tiraListaColada(nome, complementos) {
  const m = nome.match(/^(.*?)\s*\(([^()]*)\)\s*$/)
  if (!m || !m[1].trim()) return nome
  const nomes = complementos.map(c => chave(c?.nome ?? c)).filter(Boolean)
  const partes = m[2].split(',')
    .map(s => chave(s).replace(/^\d+\s*[x×]?\s*/, ''))
    .filter(Boolean)
  if (!partes.length) return nome
  return partes.every(p => nomes.includes(p)) ? m[1].trim() : nome
}

export function separarItem(item) {
  let nome = String(item?.nome ?? '')
  let complementos = Array.isArray(item?.complementos) ? item.complementos : []

  const qtdItem = Number(item?.quantidade ?? item?.qtd ?? 1) || 1

  if (!complementos.length) {
    const m = nome.match(/^(.*)\((.+)\)\s*$/) // guloso: pega o ÚLTIMO parêntese
    if (m && m[2].includes(',')) {            // só separa se for lista (tem vírgula)
      nome = m[1].trim()
      // A mesa não tem coluna de complemento: o salão escreve a montagem dentro
      // do parêntese, e o número vem junto — "2× Queijo". Sem ler esse número o
      // papel saía "6 2× Queijo".
      complementos = m[2]
        .split(',')
        .map(s => {
          const t = s.trim()
          const mm = t.match(/^(\d+)\s*[x×]\s*(.+)$/)
          return mm ? { nome: mm[2].trim(), qtd: Number(mm[1]) || 1 } : { nome: t, qtd: 1 }
        })
        .filter(c => c.nome)
      // Absoluto ou por unidade? O nome não diz qual grupo era. Mas quando os
      // números somam a quantidade da linha (6 pastéis = 1+2+2+1 sabores), eles
      // JÁ são o total — é o grupo em modo_quantidade. Fora disso vale a regra
      // de sempre: 4 quentinhas com "2× Arroz" são 8 arroz.
      const soma = complementos.reduce((s, c) => s + c.qtd, 0)
      if (qtdItem > 1 && soma === qtdItem) {
        complementos = complementos.map(c => ({ ...c, absoluto: true }))
      }
    }
  } else {
    nome = tiraListaColada(nome, complementos)
  }

  complementos = complementos.map(c => {
    const q = Number(c?.qtd ?? 1) || 1
    return { ...c, qtdTotal: c?.absoluto ? q : q * qtdItem }
  })

  return { nome, complementos }
}
