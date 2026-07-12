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

function txt(s) {
  const clean = String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7F]/g, '')
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

function formaPagamento(p) {
  const f = p.forma_pagamento
  const ifood = p.origem === 'ifood'
  // PIX pelo Mercado Pago só aparece depois de pago → aprovado no MP conta como pago.
  const prepago = f === 'online' || (f === 'pix' && (p.pix_status === 'pago' || p.mp_payment_status === 'approved'))
  if (prepago) return { cobrar: false, label: ifood ? 'PAGO no iFood' : (f === 'pix' ? 'PAGO via PIX' : 'PAGO') }
  let nome = 'Dinheiro'
  if (['cartao', 'cartao', 'credito', 'debito'].includes(f)) nome = f === 'debito' ? 'Debito' : f === 'credito' ? 'Credito' : 'Cartao'
  else if (f === 'pix') nome = 'PIX (nao confirmado)'
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
    const nome = it.nome || 'Item'
    parts.push(BOLD(1), linha(qtd + 'x ' + nome), BOLD(0))
    const comps = Array.isArray(it.complementos) ? it.complementos : []
    for (const c of comps) {
      const cn = typeof c === 'string' ? c : (c?.nome ?? '')
      // Complemento multiplica pela qtd do prato (4 quentinhas → complemento x4).
      const cq = Number(c?.qtd ?? 1) * Number(qtd || 1)
      if (!cn) continue
      // Adicional pago (ex.: proteina/porcao extra) sai com o valor cobrado.
      const cp = Number(c?.preco ?? 0)
      if (cp > 0) parts.push(kv('   ' + cq + 'x ' + cn, '+' + money(cp * cq)))
      else parts.push(linha('   ' + cq + 'x ' + cn))
    }
    if (it.observacao) parts.push(linha('   obs: ' + it.observacao))
  }
  parts.push(divisor())

  // Totais
  if (p.subtotal != null) parts.push(kv('Subtotal', money(p.subtotal)))
  if ((p.tipo_entrega || 'entrega') !== 'retirada' && p.taxa_entrega != null)
    parts.push(kv('Taxa de entrega', money(p.taxa_entrega)))
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
  parts.push(BOLD(0), ALIGN(0))

  if (p.observacoes) { parts.push(divisor(), linha('OBS: ' + p.observacoes)) }

  // Rodape
  parts.push(divisor())
  parts.push(ALIGN(1), linha('Impressora FWC'))
  parts.push(FEED(4), CUT)
  return Buffer.concat(parts)
}

// Cupom de texto simples (cozinha, conta de mesa) — cada item do array vira uma linha.
function montarTexto(linhas, titulo) {
  const parts = [INIT]
  if (titulo) parts.push(ALIGN(1), SIZE(0x11), BOLD(1), linha(String(titulo).toUpperCase()), BOLD(0), SIZE(0), ALIGN(0), divisor())
  for (const l of (Array.isArray(linhas) ? linhas : [])) parts.push(linha(l))
  parts.push(divisor(), ALIGN(1), linha('Impressora FWC'), FEED(4), CUT)
  return Buffer.concat(parts)
}

module.exports = { montarCupom, montarTexto, LARGURA }
