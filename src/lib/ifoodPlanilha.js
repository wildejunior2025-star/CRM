// Lê a planilha de pedidos do iFood (Financeiro -> Extrato -> exportar .xlsx) e:
//  1) agrega o repasse REAL por dia (pra guardar e mostrar exato)
//  2) calibra a taxa daquela loja (cada loja tem plano de comissão diferente)
//
// A lib xlsx é carregada por import dinâmico — só pesa quando o dono importa.

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim()

// acha o índice da coluna cujo cabeçalho contém TODOS os termos
function achaCol(headers, ...termos) {
  return headers.findIndex(h => { const n = norm(h); return termos.every(t => n.includes(t)) })
}

function ehOnline(forma) {
  const f = norm(forma)
  return !(f.includes('NA ENTREGA') || f === 'DINHEIRO')
}

function num(v) {
  if (typeof v === 'number') return v
  if (v == null) return 0
  return Number(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '')) || 0
}

// Ajuste por mínimos quadrados: taxa = comissao%*itens + transacao%*pago(se online)
function calibrar(orders) {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0
  for (const o of orders) {
    const x1 = o.itens, x2 = o.online ? o.pago : 0, y = o.fee
    s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; s1y += x1 * y; s2y += x2 * y
  }
  const det = s11 * s22 - s12 * s12
  let c = 0.117, t = 0.0452
  if (Math.abs(det) > 1e-6) {
    c = (s1y * s22 - s2y * s12) / det
    t = (s11 * s2y - s12 * s1y) / det
  }
  if (!(c > 0.05 && c < 0.35)) c = 0.117   // sanidade
  if (!(t >= 0 && t < 0.10)) t = 0.0452
  return { comissao_pct: Number(c.toFixed(4)), transacao_pct: Number(t.toFixed(4)) }
}

export async function parseIfoodPlanilha(file) {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
  if (!linhas.length) throw new Error('Planilha vazia.')

  const H = linhas[0]
  const cItem  = achaCol(H, 'VALOR', 'ITENS')
  const cPago  = achaCol(H, 'TOTAL', 'PAGO')
  const cTxEnt = achaCol(H, 'TAXA', 'ENTREGA')
  const cIncLj = achaCol(H, 'INCENTIVO', 'LOJA')
  const cComis = achaCol(H, 'TAXAS', 'COMISS')
  const cLiq   = achaCol(H, 'VALOR', 'LIQUIDO')
  const cStat  = achaCol(H, 'STATUS')
  const cForma = achaCol(H, 'FORMA', 'PAGAMENTO')
  const cData  = achaCol(H, 'DATA', 'HORA')

  if (cLiq < 0 || cComis < 0 || cItem < 0)
    throw new Error('Não reconheci as colunas da planilha do iFood. Confira se exportou o relatório de PEDIDOS.')

  const porDia = {}
  const orders = []   // pra calibrar (só concluídos)
  let totalLinhas = 0, cancelados = 0

  for (let i = 1; i < linhas.length; i++) {
    const r = linhas[i]
    if (!r || r[cLiq] == null && r[cItem] == null) continue
    totalLinhas++
    const status = norm(r[cStat])
    const concluido = status.includes('CONCLU')
    if (!concluido) { cancelados++; continue }

    const dataStr = String(r[cData] ?? '')
    const m = dataStr.match(/(\d{2})\/(\d{2})\/(\d{4})/)
    const dia = m ? `${m[3]}-${m[2]}-${m[1]}` : 'sem-data'

    const itens = num(r[cItem])
    const pago  = num(r[cPago])
    const txEnt = cTxEnt >= 0 ? num(r[cTxEnt]) : 0
    const incLj = cIncLj >= 0 ? num(r[cIncLj]) : 0
    const comis = Math.abs(num(r[cComis]))       // guardado positivo
    const liq   = num(r[cLiq])
    const online = ehOnline(r[cForma])

    const d = porDia[dia] || (porDia[dia] = { dia, pedidos: 0, vendas: 0, itens: 0, taxas: 0, valor_liquido: 0, recebido_entrega: 0 })
    d.pedidos++
    d.vendas += pago
    d.itens  += itens
    d.taxas  += comis
    d.valor_liquido += liq
    if (!online) d.recebido_entrega += pago

    orders.push({ itens, pago, online, fee: comis })
  }

  const dias = Object.values(porDia)
    .filter(d => d.dia !== 'sem-data')
    .map(d => ({
      ...d,
      vendas: +d.vendas.toFixed(2), itens: +d.itens.toFixed(2), taxas: +d.taxas.toFixed(2),
      valor_liquido: +d.valor_liquido.toFixed(2), recebido_entrega: +d.recebido_entrega.toFixed(2),
    }))
    .sort((a, b) => a.dia.localeCompare(b.dia))

  const totais = dias.reduce((s, d) => ({
    pedidos: s.pedidos + d.pedidos, vendas: s.vendas + d.vendas, itens: s.itens + d.itens,
    taxas: s.taxas + d.taxas, valor_liquido: s.valor_liquido + d.valor_liquido,
    recebido_entrega: s.recebido_entrega + d.recebido_entrega,
  }), { pedidos: 0, vendas: 0, itens: 0, taxas: 0, valor_liquido: 0, recebido_entrega: 0 })

  // Comparativo: o quanto NOSSA fórmula padrão estimaria de taxa vs o real (pra provar a precisão)
  const taxaReal = orders.reduce((s, o) => s + o.fee, 0)
  const taxaEstimada = orders.reduce((s, o) => s + (0.117 * o.itens + (o.online ? 0.0452 * o.pago : 0)), 0)

  return {
    dias, totais,
    calibracao: calibrar(orders),
    comparativo: { taxaReal: +taxaReal.toFixed(2), taxaEstimada: +taxaEstimada.toFixed(2) },
    meta: { totalLinhas, cancelados },
  }
}
