// Monta o cupom em ESC/POS (bytes) a partir de um pedido do nosso sistema.
// Térmica 80mm ~ 48 colunas. Acentos são removidos (evita lixo em codepage).
const ESC = 0x1B, GS = 0x1D
const INIT   = Buffer.from([ESC, 0x40])
const CUT    = Buffer.from([GS, 0x56, 0x00])          // corte total
const FEED   = n => Buffer.from([ESC, 0x64, n])        // avança n linhas
const ALIGN  = n => Buffer.from([ESC, 0x61, n])        // 0 esq, 1 centro, 2 dir
const SIZE   = n => Buffer.from([GS, 0x21, n])         // GS ! — largura(bits4-7)/altura(bits0-3)
const BOLD   = on => Buffer.from([ESC, 0x45, on ? 1 : 0])
const NL     = Buffer.from('\n', 'latin1')
// 80mm Font A. A MP-4200 (e a maioria das térmicas 80mm) quebra em 42 colunas —
// se passar disso, o valor "R$ x,xx" quebra pra linha de baixo. 42 = fica certo.
const LARGURA = 42

// Simbolo fora do ASCII sumia calado ("2x Queijo" virava "2 Queijo"). Agora
// vira o parente ASCII antes do corte.
const trocaSimbolos = (s) => String(s ?? '')
  .replace(/[×✕✖]/g, 'x').replace(/[–—−]/g, '-')
  .replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'")
  .replace(/…/g, '...').replace(/[º°]/g, 'o').replace(/ª/g, 'a')

function txt(s) {
  const clean = trocaSimbolos(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7F]/g, '')
  return Buffer.from(clean, 'latin1')
}
function linha(s = '') { return Buffer.concat([txt(s), NL]) }
function divisor() { return linha('-'.repeat(LARGURA)) }
function money(v) { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',') }
// linha "label .... valor" alinhada à direita
function kv(label, valor) {
  const l = String(label), v = String(valor)
  const espacos = Math.max(1, LARGURA - l.length - v.length)
  return linha(l + ' '.repeat(espacos) + v)
}

// ── Nome x complementos ─────────────────────────────────────────
// Copia fiel de src/lib/itensPedido.js (esse .exe e um app a parte, nao da pra
// importar o modulo do site). Se mexer la, mexe aqui. Duas regras:
//
// 1) `qtd` do complemento e POR UNIDADE: 4 quentinhas com 2 arroz = 8 arroz.
//    Mas grupo em modo_quantidade (migration 0200) e o contrario: os sabores
//    DIVIDEM o total. 45 picoles com 10 leite condensado tem quantidade 45 no
//    item (pro estoque baixar certo) e 10 no complemento — multiplicar imprimia
//    450 na comanda. Esses vem marcados com `absoluto: true`.
//
// 2) O checkout cola a lista de sabores no fim do nome e a comanda ja imprime
//    cada um na linha de baixo. Tira o parentese, mas so quando TODO pedaco de
//    dentro bate com um complemento — "Sorvete CDBOM (Balde 10 litros)" fica.
const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
const chave = s => semAcento(s).toLowerCase().replace(/\s+/g, ' ').trim()

function tiraListaColada(nome, complementos) {
  const m = nome.match(/^(.*?)\s*\(([^()]*)\)\s*$/)
  if (!m || !m[1].trim()) return nome
  const nomes = complementos.map(c => chave(c && c.nome ? c.nome : c)).filter(Boolean)
  const partes = m[2].split(',')
    .map(s => chave(s).replace(/^\d+\s*[x×]?\s*/, ''))
    .filter(Boolean)
  if (!partes.length) return nome
  return partes.every(p => nomes.includes(p)) ? m[1].trim() : nome
}

function separarItem(item) {
  let nome = String((item && item.nome) || '')
  let complementos = Array.isArray(item && item.complementos) ? item.complementos : []

  const qtdItem = Number((item && (item.quantidade ?? item.qtd)) ?? 1) || 1

  if (!complementos.length) {
    const m = nome.match(/^(.*)\((.+)\)\s*$/)  // guloso: pega o ULTIMO parentese
    if (m && m[2].includes(',')) {              // so separa se for lista (tem virgula)
      nome = m[1].trim()
      // A mesa nao tem coluna de complemento: o salao escreve a montagem dentro
      // do parentese com o numero junto ("2x Queijo"). Sem ler esse numero o
      // papel saia "6 2x Queijo".
      complementos = m[2].split(',').map(s => {
        const t = s.trim()
        const mm = t.match(/^(\d+)\s*[x×]\s*(.+)$/)
        return mm ? { nome: mm[2].trim(), qtd: Number(mm[1]) || 1 } : { nome: t, qtd: 1 }
      }).filter(c => c.nome)
      // Quando os numeros somam a quantidade da linha (6 pasteis = 1+2+2+1),
      // eles JA sao o total — grupo em modo_quantidade.
      const soma = complementos.reduce((s, c) => s + c.qtd, 0)
      if (qtdItem > 1 && soma === qtdItem) complementos = complementos.map(c => ({ ...c, absoluto: true }))
    }
  } else {
    nome = tiraListaColada(nome, complementos)
  }

  complementos = complementos.map(c => {
    if (typeof c === 'string') c = { nome: c, qtd: 1 }
    const q = Number((c && c.qtd) ?? 1) || 1
    return { ...c, qtdTotal: c && c.absoluto ? q : q * qtdItem }
  })

  return { nome, complementos }
}

function formaPagamento(p) {
  const f = p.forma_pagamento
  const ifood = p.origem === 'ifood'
  // PIX pelo Mercado Pago só aparece depois de pago → aprovado no MP conta como pago.
  const prepago = f === 'online' || (f === 'pix' && (p.pix_status === 'pago' || p.mp_payment_status === 'approved'))
  if (prepago) return { cobrar: false, label: ifood ? 'PAGO no iFood' : (f === 'pix' ? 'PAGO via PIX' : 'PAGO') }
  let nome = 'Dinheiro'
  if (['cartao', 'cartao', 'credito', 'debito'].includes(f)) nome = f === 'debito' ? 'Debito' : f === 'credito' ? 'Credito' : 'Cartao'
  else if (f === 'pix') nome = 'PIX (nao confirmado)'
  // Cliente paga na porta, na chave da loja — o motoqueiro so confere.
  else if (f === 'pix_entrega') nome = 'PIX na entrega'
  else if (f === 'vale') nome = 'Vale'
  return { cobrar: true, label: nome + (ifood ? ' (via iFood)' : '') }
}

function montarCupom(pedido, empresa) {
  const p = pedido, e = empresa || {}
  const parts = [INIT]

  // Cabecalho — nome da loja grande
  parts.push(ALIGN(1), SIZE(0x11), BOLD(1))
  parts.push(linha((e.nome || 'PEDIDO').toUpperCase()))
  parts.push(BOLD(0), SIZE(0))

  const ehIfood = p.origem === 'ifood'
  const codLoja = '#' + (p.numero_pedido ?? String(p.id).slice(-4))
  parts.push(SIZE(0x11), BOLD(1))
  if (ehIfood && p.ifood_display_id) {
    // Pedido do iFood: imprime o código do iFood E o número da loja, juntos.
    parts.push(linha('iFood #' + p.ifood_display_id))
    parts.push(linha('Loja ' + codLoja))
  } else {
    parts.push(linha(codLoja))
  }
  parts.push(BOLD(0), SIZE(0))
  const tipo = (p.tipo_entrega || 'entrega') === 'retirada' ? 'RETIRADA' : 'ENTREGA'
  parts.push(linha(tipo))
  parts.push(ALIGN(0))
  parts.push(divisor())

  // Cliente
  parts.push(BOLD(1), linha(p.cliente_nome || 'Cliente'), BOLD(0))
  if (p.cliente_telefone) parts.push(linha('Tel: ' + p.cliente_telefone))
  if ((p.tipo_entrega || 'entrega') !== 'retirada') {
    const end = [p.endereco_rua, p.endereco_numero].filter(Boolean).join(', ')
    if (end) parts.push(linha(end))
    const bc = [p.endereco_bairro, p.endereco_cidade].filter(Boolean).join(' - ')
    if (bc) parts.push(linha(bc))
    if (p.endereco_complemento) parts.push(linha('Compl: ' + p.endereco_complemento))
  }
  parts.push(divisor())

  // Itens
  const itens = Array.isArray(p.itens) ? p.itens : []
  for (const it of itens) {
    const qtd = it.quantidade ?? it.qtd ?? 1
    const { nome, complementos: comps } = separarItem(it)
    // Sem "x" tambem na linha do item: "20 Picole". Fica igual a comanda da
    // cozinha (que sempre imprimiu assim) e igual ao card do gestor.
    parts.push(BOLD(1), linha(qtd + ' ' + (nome || 'Item')), BOLD(0))
    for (const c of comps) {
      const cn = c.nome
      const cq = c.qtdTotal
      if (!cn) continue
      // Adicional pago (ex.: proteina/porcao extra) sai com o valor cobrado.
      const cp = Number(c?.preco ?? 0)
      // Sem o "x" na linha do complemento: "5 Milho verde", igual ao card do
      // gestor. O "x" fica só na linha do item ("20x Picole"), que e o que
      // multiplica de verdade — no complemento ele confundia quem le o papel.
      if (cp > 0) parts.push(kv('   ' + cq + ' ' + cn, '+' + money(cp * cq)))
      else parts.push(linha('   ' + cq + ' ' + cn))
    }
    if (it.observacao) parts.push(linha('   obs: ' + it.observacao))
  }
  parts.push(divisor())

  // Totais
  if (p.subtotal != null) parts.push(kv('Subtotal', money(p.subtotal)))
  if ((p.tipo_entrega || 'entrega') !== 'retirada' && p.taxa_entrega != null)
    parts.push(kv('Taxa de entrega', money(p.taxa_entrega)))
  // Taxa do cartao repassada e cashback abatido. Sem estas duas linhas o papel
  // mostrava subtotal + entrega e um TOTAL que nao fechava com a soma — quem
  // recebe o pedido na porta acha que o sistema errou a conta.
  if (Number(p.acrescimo || 0) > 0) parts.push(kv('Taxa do cartao', money(p.acrescimo)))
  if (Number(p.cashback_usado || 0) > 0) parts.push(kv('Cashback do cliente', '-' + money(p.cashback_usado)))
  if (Number(p.desconto || 0) > 0) parts.push(kv('Desconto', '-' + money(p.desconto)))
  parts.push(SIZE(0x01), BOLD(1), kv('TOTAL', money(p.total)), BOLD(0), SIZE(0))

  // Pagamento — deixa MUITO claro se cobra ou ja pagou
  parts.push(NL)
  const pg = formaPagamento(p)
  parts.push(ALIGN(1), BOLD(1), SIZE(0x01))
  if (pg.cobrar) {
    parts.push(linha('*** COBRAR NA ENTREGA ***'))
    parts.push(SIZE(0), linha(pg.label + ' - ' + money(p.total)))
  } else {
    parts.push(linha('*** JA PAGO ***'))
    parts.push(SIZE(0), linha(pg.label))
  }
  // Chave PIX da loja no cupom: e o que o motoqueiro mostra pro cliente pagar.
  if (p.forma_pagamento === 'pix_entrega' && e.chave_pix) {
    parts.push(SIZE(0), linha('Chave PIX: ' + e.chave_pix))
    if (e.pix_nome) parts.push(linha(e.pix_nome))
  }
  parts.push(BOLD(0), ALIGN(0))

  if (p.observacoes) { parts.push(divisor(), linha('OBS: ' + p.observacoes)) }

  // Rodape
  parts.push(divisor())
  parts.push(ALIGN(1), linha('Impressora FWC'))
  parts.push(FEED(4), CUT)
  return Buffer.concat(parts)
}

// Cupom de texto simples (cozinha, conta de mesa) — cada item do array vira uma linha.
function montarTexto(linhas, titulo, topo) {
  const parts = [INIT]
  // `topo`: linha centralizada acima do título (ex.: nome do restaurante na comanda de mesa).
  if (topo) parts.push(ALIGN(1), BOLD(1), linha(String(topo)), BOLD(0), ALIGN(0))
  if (titulo) parts.push(ALIGN(1), SIZE(0x11), BOLD(1), linha(String(titulo).toUpperCase()), BOLD(0), SIZE(0), ALIGN(0), divisor())
  // Linha pode ser string (normal) ou { t, big } — `big` sai em fonte GRANDE
  // (largura E altura dobradas + negrito): item da comanda de mesa bem grande, ocupando
  // a largura do papel, pro cozinheiro ver de longe. Nome longo quebra sozinho na térmica.
  for (const l of (Array.isArray(linhas) ? linhas : [])) {
    if (l && typeof l === 'object') {
      if (l.big) parts.push(SIZE(0x11), BOLD(1), linha(String(l.t ?? '')), BOLD(0), SIZE(0))
      else parts.push(linha(String(l.t ?? '')))
    } else {
      parts.push(linha(l))
    }
  }
  parts.push(divisor(), ALIGN(1), linha('Impressora FWC'), FEED(4), CUT)
  return Buffer.concat(parts)
}

// Comanda da COZINHA (mesa) — layout completo pro cozinheiro: nome da loja, mesa (+salao),
// data/hora com segundos, atendente, nº de pessoas, itens GRANDES com espaço entre eles,
// e um rodapé opcional da loja. SEM preço (o preço sai depois, na conta).
function montarComandaMesa({ nomeLoja = '', numero = '?', area = '', atendente = '', pessoas = 0, itens = [], rodape = '', sufixo = '' }) {
  const d = new Date(), p2 = n => String(n).padStart(2, '0')
  const dataHora = p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
  const parts = [INIT]
  // Cabecalho — nome da loja GRANDE (fonte dupla), igual ao cupom de delivery.
  if (nomeLoja) parts.push(ALIGN(1), SIZE(0x11), BOLD(1), linha(String(nomeLoja).toUpperCase()), BOLD(0), SIZE(0))
  const mesaTxt = '~ Mesa: ' + numero + (area ? ' (' + area + ')' : '') + (sufixo || '') + ' ~'
  parts.push(ALIGN(1), BOLD(1), linha(mesaTxt), BOLD(0), ALIGN(0))
  parts.push(linha(dataHora))
  if (atendente) parts.push(linha('Atendente: ' + atendente))
  if (Number(pessoas) > 0) parts.push(linha('Pessoas: ' + pessoas))
  parts.push(divisor())
  // Itens grandes, com um divisor + linha em branco entre um e outro (bastante espaco).
  const lista = Array.isArray(itens) ? itens : []
  lista.forEach((it) => {
    const q = it.quantidade ?? it.qtd ?? 1
    parts.push(FEED(1)) // espaço ANTES do item — cada pedido vira um bloco maior
    // Sabor em linha propria, igual ao cupom de delivery aqui em cima: colado no
    // nome ("6 Pastel (Carne, 2x Queijo, 2x Frango)") a cozinha nao le quantos
    // de cada sao, e a frase ainda quebra no meio da palavra.
    const { nome: nomeIt, complementos: compsIt } = separarItem(it)
    parts.push(SIZE(0x11), BOLD(1), linha(q + ' ' + (nomeIt || 'Item')), BOLD(0), SIZE(0))
    for (const c of compsIt) {
      if (!c || !c.nome) continue
      parts.push(SIZE(0x01), BOLD(1), linha('  ' + (c.qtdTotal ?? 1) + ' ' + c.nome), BOLD(0), SIZE(0))
    }
    // Observação também GRANDE (fonte alta + negrito), pra cozinha ler fácil.
    if (it.observacao) parts.push(SIZE(0x01), BOLD(1), linha('obs: ' + it.observacao), BOLD(0), SIZE(0))
    // Espaço + tracejado + espaço: separa BEM cada pedido (comanda maior por item).
    parts.push(FEED(1), divisor(), FEED(2))
  })
  if (!lista.length) parts.push(linha('(sem itens)'))
  // Rodape da loja (ex.: versiculo) — centralizado; senao, nada.
  if (rodape) parts.push(ALIGN(1), linha(String(rodape)), ALIGN(0))
  // O cliente prefere SOBRAR papel a sair "miudo": com poucos itens, empurra papel
  // em branco no fim pra a comanda sair num tamanho bom (mesmo que sobre papel).
  // Metade do espaço de antes (estava exagerado). 1 item:+4, 2:+0, 3+:0.
  const feedExtra = Math.max(0, 8 - (lista.length || 1) * 4)
  parts.push(FEED(4 + feedExtra), CUT)
  return Buffer.concat(parts)
}

module.exports = { montarCupom, montarTexto, montarComandaMesa, LARGURA }
