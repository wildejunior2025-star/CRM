// NOTA FISCAL ELETRÔNICA — leitura da chave, do XML e casamento dos itens com o cadastro da loja.
//
// Tudo aqui é PURO (sem rede, sem React): é o que a tela "Lançar compra" usa pra transformar uma nota
// em linhas da compra. Quem busca o XML é a função nfe-por-chave (Focus); quem lê foto é a IA
// (ler-nota-estoque). Os dois caminhos terminam nos mesmos formatos daqui.

const so = (s) => String(s ?? '').replace(/\D/g, '')
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
/** O nome da nota sem acento/pontuação — a MESMA chave da ligação (item_apelidos) e do robô. */
export const normApelido = (s) => norm(s).replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').trim()
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100

// ── chave de acesso ───────────────────────────────────────────────────────────
/** Dígito verificador da chave (módulo 11, pesos 2..9 da direita pra esquerda). */
export function chaveValida(c) {
  if (!/^\d{44}$/.test(c)) return false
  let soma = 0
  let peso = 2
  for (let i = 42; i >= 0; i--) {
    soma += Number(c[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const r = soma % 11
  return (r === 0 || r === 1 ? 0 : 11 - r) === Number(c[43])
}

/**
 * Acha a chave num texto qualquer: os 44 números digitados (com espaço ou ponto), colados, bipados do
 * código de barras do DANFE, ou o texto do QR da NFC-e (um endereço com `p=<chave>|2|1|...`).
 * Devolve o que a própria chave já conta, ou null se não for uma chave válida.
 */
export function lerChave(texto) {
  const bruto = String(texto ?? '')
  const candidatos = []
  const soNumeros = so(bruto)
  if (soNumeros.length === 44) candidatos.push(soNumeros)
  for (const m of bruto.matchAll(/\d{44}/g)) candidatos.push(m[0])
  const chave = candidatos.find(chaveValida)
  if (!chave) return null
  return {
    chave,
    uf: chave.slice(0, 2),
    mes: `20${chave.slice(2, 4)}-${chave.slice(4, 6)}`,       // AAMM de emissão
    cnpj: chave.slice(6, 20),                                  // do EMITENTE (o fornecedor)
    modelo: chave.slice(20, 22),                               // 55 = NF-e, 65 = NFC-e
    serie: String(Number(chave.slice(22, 25))),
    numero: String(Number(chave.slice(25, 34))),
  }
}

export const fmtCnpj = (c) => {
  const d = so(c)
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d
}

// ── XML da NF-e ───────────────────────────────────────────────────────────────
const FORMA_TPAG = {
  '01': 'dinheiro', '02': 'cheque', '03': 'credito', '04': 'debito', '05': 'credito', '15': 'boleto',
  '16': 'transferencia', '17': 'pix', '18': 'transferencia', '99': 'outro',
}
const txt = (el, tag) => el?.getElementsByTagName(tag)[0]?.textContent?.trim() ?? ''
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0 }

/**
 * Lê o XML de uma NF-e e devolve só o que a compra precisa. Null se não for um XML de NF-e.
 * Cada item traz o TOTAL da linha já com desconto/frete/seguro/outros do próprio item — é esse o valor
 * que o dono pagou por aquela linha, e o que fecha com o total da nota.
 */
export function parseNFeXml(xml) {
  if (!xml || typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) return null
  const inf = doc.getElementsByTagName('infNFe')[0]
  if (!inf) return null
  const ide = inf.getElementsByTagName('ide')[0]
  const emit = inf.getElementsByTagName('emit')[0]
  const itens = [...inf.getElementsByTagName('det')].map((det) => {
    const p = det.getElementsByTagName('prod')[0]
    const qCom = num(txt(p, 'qCom'))
    const vUnCom = num(txt(p, 'vUnCom'))
    const vProd = num(txt(p, 'vProd'))
    const total = r2(vProd - num(txt(p, 'vDesc')) + num(txt(p, 'vFrete')) + num(txt(p, 'vSeg')) + num(txt(p, 'vOutro')))
    return {
      codigo: txt(p, 'cProd'), ean: so(txt(p, 'cEAN')), descricao: txt(p, 'xProd'), ncm: txt(p, 'NCM'),
      uCom: txt(p, 'uCom'), quantidade: qCom, custo_unit: vUnCom, total,
      uTrib: txt(p, 'uTrib'), qTrib: num(txt(p, 'qTrib')),
    }
  })
  const tot = inf.getElementsByTagName('ICMSTot')[0]
  const duplicatas = [...inf.getElementsByTagName('dup')].map((d) => ({ vencimento: txt(d, 'dVenc'), valor: num(txt(d, 'vDup')) }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.vencimento) && d.valor > 0)
  const pagamentos = [...inf.getElementsByTagName('detPag')].map((d) => ({ tPag: txt(d, 'tPag'), valor: num(txt(d, 'vPag')) }))
  const dh = txt(ide, 'dhEmi') || txt(ide, 'dEmi')
  return {
    chave: so(inf.getAttribute('Id')),
    numero: String(Number(txt(ide, 'nNF')) || ''),
    data: /^\d{4}-\d{2}-\d{2}/.test(dh) ? dh.slice(0, 10) : null,
    emitente: { nome: txt(emit, 'xNome'), cnpj: so(txt(emit, 'CNPJ')) },
    itens,
    total: num(txt(tot, 'vNF')),
    duplicatas,
    pagamentos,
  }
}

/** Como a nota foi (ou vai ser) paga, pelo que o XML diz. `pago: null` = não dá pra saber. */
export function pagamentoDaNota(nfe) {
  if (nfe.duplicatas.length) return { pago: false, forma: null }
  const pg = nfe.pagamentos.filter((p) => p.tPag && p.tPag !== '90')
  if (pg.length === 1) return { pago: true, forma: FORMA_TPAG[pg[0].tPag] ?? 'outro' }
  return { pago: null, forma: null }
}

// ── casar o item da nota com o item da loja ───────────────────────────────────
const PARES = new Set(['de', 'da', 'do', 'das', 'dos', 'c', 'com', 's', 'sem', 'e', 'a', 'o', 'kg', 'un', 'cx', 'pct', 'g', 'ml', 'l', 'lt'])
const tokens = (s) => normApelido(s).split(' ').filter((t) => t.length > 1 && !PARES.has(t))

/** 0..1 — quanto do que a nota escreveu aparece no nome do item (e vice-versa). */
function parecido(a, b) {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) {
    // "coxa" casa com "coxas", "frango" com "frang": um começa com o outro (palavras de 3+ letras)
    if (B.has(t) || [...B].some((u) => t.length >= 4 && u.length >= 4 && (u.startsWith(t) || t.startsWith(u)))) inter++
  }
  return inter / (A.size + B.size - inter)
}

/**
 * O item da nota → item da loja. Ordem, da mais segura pra menos:
 *   1. ligação que a loja já fez (item_apelidos)        — o dono disse que é esse
 *   2. código de barras (EAN) igual ao do produto
 *   3. nome igual (sem acento/pontuação)
 * Sem nenhum dos três, NÃO adivinha: devolve achado=null e até 3 SUGESTÕES pro dono confirmar com um toque.
 */
export function casarItem(it, { produtos, materias, apelidos }) {
  const chave = normApelido(it.descricao)
  const pelaLigacao = (apelidos || []).find((a) => a.apelido_norm === chave)
  const porId = (tipo, id) => (tipo === 'produto' ? produtos : materias).find((x) => x.id === id)
  if (pelaLigacao) {
    const x = porId(pelaLigacao.tipo, pelaLigacao.item_id)
    if (x) return { achado: { tipo: pelaLigacao.tipo, id: x.id, via: 'ligação' }, sugestoes: [] }
  }
  const ean = so(it.ean)
  if (ean.length >= 8 && !/^0+$/.test(ean)) {
    const alvo = ean.replace(/^0+/, '')
    const p = produtos.find((x) => x.codigo_barras && so(x.codigo_barras).replace(/^0+/, '') === alvo)
    if (p) return { achado: { tipo: 'produto', id: p.id, via: 'código de barras' }, sugestoes: [] }
  }
  const igual = [...materias.map((x) => ({ ...x, tipo: 'materia' })), ...produtos.map((x) => ({ ...x, tipo: 'produto' }))]
    .find((x) => normApelido(x.nome) === chave)
  if (igual) return { achado: { tipo: igual.tipo, id: igual.id, via: 'nome' }, sugestoes: [] }

  const todos = [...materias.map((x) => ({ tipo: 'materia', id: x.id, nome: x.nome })), ...produtos.map((x) => ({ tipo: 'produto', id: x.id, nome: x.nome }))]
  const sugestoes = todos.map((x) => ({ ...x, s: parecido(it.descricao, x.nome) }))
    .filter((x) => x.s >= 0.34).sort((a, b) => b.s - a.s).slice(0, 3).map(({ s, ...x }) => x) // eslint-disable-line no-unused-vars
  return { achado: null, sugestoes }
}

/**
 * Converte o item da nota pro jeito que a LINHA da compra guarda (embalagem, quantidade, valor).
 *  - caixa/fardo/pacote de PRODUTO: fica em "caixa" (o estoque conta unidade, o dinheiro é o da caixa).
 *    As unidades por caixa vêm da própria nota (quantidade tributável ÷ comercial) ou do cadastro.
 *  - g↔kg e ml↔L: converte, porque a nota e o cadastro às vezes usam unidades diferentes.
 *  - qualquer outra diferença de unidade vira AVISO (a gente não adivinha quantidade).
 * `total` só é devolvido quando qtd × valor NÃO fecha com o total da linha impresso (aí o total manda).
 */
export function extraDaLinha(n, base) {
  const uCom = String(n.uCom || n.unidade || '').toUpperCase()
  const qOrig = Number(n.quantidade) || 0
  const vOrig = Number(n.custo_unit) || 0
  let qtd = qOrig
  let custo = vOrig
  let emb = 'un'
  let porCx
  let avisoNota = null

  if (base.tipo === 'produto' && /^(CX|CAIXA|FD|FARDO|PCT|PACOTE)$/.test(uCom)) {
    const unidadesNaNota = /^(UN|UND|UNID|UNIDADE)$/.test(String(n.uTrib || '').toUpperCase()) && n.qTrib > qOrig && qOrig > 0
      ? Math.round(n.qTrib / qOrig) : 0
    const por = unidadesNaNota || Math.max(1, Number(base.porCx) || 1)
    if (por > 1) { emb = 'cx'; porCx = por }
    else avisoNota = `A nota vem em ${uCom.toLowerCase()}, mas não sei quantas unidades tem cada uma. Confira a quantidade.`
  } else if (base.tipo === 'materia') {
    const alvo = String(base.unidade || '').toUpperCase()
    if (uCom && alvo && uCom !== alvo) {
      if (uCom === 'G' && alvo === 'KG') { qtd = qOrig / 1000; custo = vOrig * 1000 }
      else if (uCom === 'KG' && alvo === 'G') { qtd = qOrig * 1000; custo = vOrig / 1000 }
      else if (uCom === 'ML' && alvo === 'L') { qtd = qOrig / 1000; custo = vOrig * 1000 }
      else if (uCom === 'L' && alvo === 'ML') { qtd = qOrig * 1000; custo = vOrig / 1000 }
      else avisoNota = `A nota vende em ${uCom.toLowerCase()} e este item está em ${alvo.toLowerCase()}. Confira a quantidade.`
    }
  }
  const lt = Number(n.total)
  const travado = Number.isFinite(lt) && lt > 0 && Math.abs(r2(qtd * custo) - lt) > 0.005
  return {
    emb, porCx, qtd, custo: Math.round(custo * 10000) / 10000,
    total: travado ? String(lt).replace('.', ',') : null,
    avisoNota,
  }
}
