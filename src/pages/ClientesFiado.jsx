import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import { recadoDeErro } from '../lib/erroRede'

const fmtBRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
// Aceita "12,50" e "12.50" (mesma regra do Financeiro): vírgula manda, ponto vira milhar.
const parseValor = s => {
  let x = String(s ?? '').trim().replace(/[^\d.,]/g, '')
  if (!x) return 0
  if (x.includes(',')) x = x.replace(/\./g, '').replace(',', '.')
  return Number(x) || 0
}
const dataHora = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const semAcento = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
// Link de cobrança no WhatsApp: só dígitos, com 55 na frente se vier sem.
const zap = (tel) => {
  const d = String(tel ?? '').replace(/\D/g, '')
  if (d.length < 10) return null
  return `https://wa.me/${d.startsWith('55') ? d : '55' + d}`
}

// Quem está devendo e quanto. O saldo vem da view clientes_saldo_fiado:
//   Σ vendas (forma_pagamento <> 'a_vista')  −  Σ pagamentos
// A view alertas_fiado é essa mesma conta já com o nome do cliente e só quem
// deve (saldo > 0), ordenada do maior pro menor. As duas são security_invoker,
// então a RLS separa por empresa — o admin só enxerga os clientes da loja dele.
// Formas aceitas em `pagamentos`. O caixa soma cada uma num card diferente
// (recebimentos_dinheiro, _pix, _cartao, _transferencia), por isso a forma é
// escolhida e não chutada — chutar "dinheiro" bagunçaria a conferência do caixa.
const FORMAS = [
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'pix', label: 'PIX' },
  { id: 'credito', label: 'Crédito' },
  { id: 'debito', label: 'Débito' },
  { id: 'transferencia', label: 'Transferência' },
]

// Marca o recebimento de fiado e separa do pagamento de mesa no histórico.
const OBS_FIADO = 'Recebimento de fiado'

// Quais pedidos ainda estão em aberto.
//
// O recebimento de fiado é do CLIENTE, não do pedido: a linha em `pagamentos`
// entra sem venda_id e abate do saldo inteiro. Por isso a lista de compras
// mostra "fiado" até nos pedidos que já foram quitados — não existe no banco a
// informação de qual pedido cada pagamento cobriu.
//
// Aqui a gente reconstrói isso do jeito que qualquer caderninho faz: o que foi
// pago cobre os pedidos MAIS ANTIGOS primeiro. O que sobra é o que ainda deve —
// e é isso que vai na cobrança, senão o cliente recebe cobrança de pedido que
// ele já pagou, que é o jeito mais rápido de perder o cliente.
function pedidosEmAberto(vendasFiado, saldo) {
  const antigas = [...vendasFiado].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const somaTudo = antigas.reduce((s, v) => s + Number(v.total || 0), 0)
  let jaPago = Math.max(0, somaTudo - Number(saldo || 0))   // quanto os recebimentos cobriram
  const abertos = []
  for (const v of antigas) {
    const total = Number(v.total || 0)
    if (jaPago >= total - 0.005) { jaPago -= total; continue }   // esse já foi quitado
    abertos.push({ ...v, falta: Math.round((total - jaPago) * 100) / 100 })
    jaPago = 0
  }
  return abertos
}

const soDia = iso => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
// Chave do dia com ano: fiado de todo dia acumula meses, e "18/08" sozinho
// juntaria a compra do ano passado com a de agora.
const chaveDia = iso => new Date(iso).toLocaleDateString('pt-BR')

// De onde veio a venda. Não existe coluna de canal: quem grava escreve na
// observação ("Balcao - Pedido #12", "Presencial · Mesa 4 · Garçom: X"), então
// o rótulo sai dela. Sem pista, não mostra nada em vez de chutar.
function canalDaVenda(obs) {
  const o = semAcento(obs)
  if (!o) return null
  if (o.startsWith('balcao')) return 'Balcão'
  if (o.startsWith('delivery')) return 'Delivery'
  if (o.startsWith('mesa')) return 'Mesa'
  const mesa = /mesa\s*(\S+)/.exec(o)
  if (o.startsWith('presencial') && mesa) return `Mesa ${mesa[1]}`
  const com = /comanda\s*(\S+)/.exec(o)
  if (o.startsWith('presencial') && com) return `Comanda ${com[1]}`
  if (o.startsWith('presencial')) return 'Salão'
  return null
}

const PERIODOS = [
  { id: 'tudo', label: 'Todo o período' },
  { id: '7', label: 'Últimos 7 dias' },
  { id: '30', label: 'Últimos 30 dias' },
  { id: 'mes', label: 'Este mês' },
]
function desdeDoPeriodo(id) {
  const agora = new Date()
  if (id === 'mes') return new Date(agora.getFullYear(), agora.getMonth(), 1)
  if (id === '7' || id === '30') return new Date(agora.getTime() - Number(id) * 86400000)
  return null
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const nomeDoItem = i => i.produtos?.nome ?? i.nome_produto ?? 'item'
// O que veio dentro do item (acompanhamentos, adicionais): "2× Bacon, Alface".
const complementosDoItem = i => (Array.isArray(i.complementos) ? i.complementos : [])
  .map(c => `${Number(c.qtd) > 1 ? Number(c.qtd) + '× ' : ''}${c.nome}${Number(c.preco) > 0 ? ` (+${fmtBRL(c.preco)})` : ''}`)
  .join(', ')

// Extrato pra imprimir ou salvar em PDF: cada compra com seus itens e preços,
// os pagamentos e o saldo — o papel que o cliente pede pra conferir a conta.
function imprimirExtrato({ cliente, nomeLoja, periodoLabel, vendas, pagamentos, saldo }) {
  const fiados = vendas.filter(v => v.forma_pagamento !== 'a_vista')
  const totalCompras = fiados.reduce((s, v) => s + Number(v.total || 0), 0)
  const blocos = [...fiados].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(v => `
    <div class="v">
      <div class="h"><b>${esc(canalDaVenda(v.observacoes) ?? 'Fiado')}</b><span>${esc(dataHora(v.created_at))}</span></div>
      ${(v.venda_itens ?? []).map(i => `<div class="i"><span>${esc(Number(i.quantidade))}× ${esc(nomeDoItem(i))}</span><span>${fmtBRL(i.preco_unitario)}${Number(i.quantidade) !== 1 ? ' un · ' + fmtBRL(i.subtotal) : ''}</span></div>${complementosDoItem(i) ? `<div class="c">${esc(complementosDoItem(i))}</div>` : ''}`).join('')}
      <div class="t"><span>Total</span><span>${fmtBRL(v.total)}</span></div>
    </div>`).join('')
  const pag = pagamentos.map(p => `<div class="i"><span>${esc(dataHora(p.created_at))} · ${esc(FORMAS.find(f => f.id === p.forma_pagamento)?.label ?? p.forma_pagamento)}</span><span>${fmtBRL(p.valor)}</span></div>`).join('')
  const w = window.open('', '_blank')
  if (!w) { window.alert('O navegador bloqueou a janela. Libere pop-ups e tente de novo.'); return }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Extrato — ${esc(cliente)}</title>
    <style>body{font-family:Arial,sans-serif;max-width:640px;margin:20px auto;padding:0 14px;color:#111;font-size:14px}
    h1{font-size:18px;margin:0}.s{color:#555;margin:2px 0 14px}.v{border:1px solid #ccc;border-radius:8px;padding:8px 10px;margin-bottom:8px;break-inside:avoid}
    .h,.i,.t{display:flex;justify-content:space-between;gap:8px;padding:2px 0}.h{border-bottom:1px solid #eee;margin-bottom:4px}.t{border-top:1px solid #eee;margin-top:4px;font-weight:700}
    .c{color:#555;font-size:12.5px;padding:0 0 3px 14px}.r{margin-top:14px;font-size:15px}.r div{display:flex;justify-content:space-between;padding:2px 0}h2{font-size:13px;margin:16px 0 4px;color:#555}</style></head><body>
    <h1>${esc(nomeLoja)}</h1><div class="s">Extrato de fiado · <b>${esc(cliente)}</b><br>${esc(periodoLabel)} · emitido em ${esc(dataHora(new Date().toISOString()))}</div>
    ${blocos || '<p>Nenhuma compra no período.</p>'}
    ${pag ? `<h2>PAGAMENTOS</h2>${pag}` : ''}
    <div class="r"><div><span>Compras no período</span><b>${fmtBRL(totalCompras)}</b></div>
    <div><span>Saldo devedor atual</span><b>${fmtBRL(saldo)}</b></div></div>
    <script>window.onload=function(){window.print()}<\/script></body></html>`)
  w.document.close()
}

// Quanto falta em cada fiado, por id. Quem não aparece no mapa já foi pago.
// Mesma reconstrução do pedidosEmAberto — é o que permite escrever "pago" na
// linha, já que o banco não guarda qual pedido cada recebimento cobriu.
function faltaPorVenda(vendas, saldo) {
  const fiados = (vendas ?? []).filter(v => v.forma_pagamento !== 'a_vista')
  return new Map(pedidosEmAberto(fiados, saldo).map(a => [a.id, a.falta]))
}

// A cobrança detalha SÓ O ÚLTIMO DIA.
//
// A comanda do fiado já sai no WhatsApp na hora em que a conta fecha (edge
// function fiado-comanda-notify): o cliente confere no dia, com a memória
// fresca, e a partir dali aquele dia está conferido. Repetir aqui item por item
// de duas semanas vira parede de texto — ninguém lê, e o que interessa (quanto
// ele deve) fica escondido lá no fim. O que ainda não foi conferido é a compra
// do dia; o resto ele vê no link, com tudo, inclusive as contas já pagas.
function textoCobranca({ nomeCliente, nomeLoja, abertos, saldo, token }) {
  const primeiro = String(nomeCliente ?? '').trim().split(' ')[0]
  const nome = primeiro ? primeiro.charAt(0).toUpperCase() + primeiro.slice(1) : 'Oi'

  const ordenados = [...abertos].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const diaChave = chaveDia(ordenados[0].created_at)
  const doDia = ordenados.filter(v => chaveDia(v.created_at) === diaChave)
  const anteriores = ordenados.filter(v => chaveDia(v.created_at) !== diaChave)
  const somaAnteriores = anteriores.reduce((s, v) => s + Number(v.falta || 0), 0)
  // Na maioria das vezes a cobrança sai logo depois de fechar a conta: pro
  // cliente, aquilo é "a compra de agora", não "a última compra" — falar da
  // data de um pedido que ele acabou de fazer soa como cobrança de coisa velha.
  // Até 3h depois é agora; no mesmo dia é hoje; passou disso, entra a data.
  const minutos = (Date.now() - new Date(ordenados[0].created_at).getTime()) / 60000
  const cabecalho = minutos <= 180
    ? 'Sua compra de agora:'
    : (diaChave === chaveDia(new Date().toISOString())
        ? 'Sua compra de hoje:'
        : `Sua última compra no fiado foi em *${soDia(ordenados[0].created_at)}*:`)

  const linhas = doDia.map(v => {
    const itens = (v.venda_itens ?? [])
      .map(i => `${Number(i.quantidade) % 1 === 0 ? Number(i.quantidade) : i.quantidade}x ${i.produtos?.nome ?? i.nome_produto ?? 'item'}`)
      .join(', ')
    const parcial = Math.abs(v.falta - Number(v.total)) > 0.005 ? ' (falta desse)' : ''
    return `• ${itens || 'conta'} — *${fmtBRL(v.falta)}*${parcial}`
  }).join('\n')

  return [
    `Oi ${nome}, tudo bem? 😊`,
    `Aqui é da *${nomeLoja}*.`,
    '',
    cabecalho,
    '',
    linhas,
    // Os dias anteriores entram como uma linha só de valor: já foram conferidos
    // na hora, não precisam ser relidos item por item.
    anteriores.length ? `\nDos dias anteriores (já conferidos): *${fmtBRL(somaAnteriores)}*` : null,
    '',
    `*Total em aberto: ${fmtBRL(saldo)}*`,
    token ? `\nAs contas anteriores e o histórico completo estão no seu link:\nhttps://lojaonline.fwcinter.com/c/${token}` : null,
    '',
    'Se já pagou alguma coisa e a gente não deu baixa, me avisa que eu acerto aqui. 🙏',
    '',
    'Obrigado, viu! Qualquer coisa é só chamar 😊',
  ].filter(l => l !== null).join('\n')
}

export default function ClientesFiado({ empresaId }) {
  // Esta tela abre no Financeiro (ADM) e também no Salão (garçom). Só o ADM apaga
  // dívida — a função no banco recusa de qualquer jeito, isto é só pra não mostrar
  // um botão que o garçom não pode usar.
  const { profile } = useAuth()
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'
  const [linhas, setLinhas] = useState([])
  const [historico, setHistorico] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const [busca, setBusca] = useState('')
  // Linha aberta pra receber: { cliente_id, valor(string), forma }
  const [recebendo, setRecebendo] = useState(null)
  const [salvando, setSalvando] = useState(false)
  // Histórico de compras aberto ao clicar no nome: { [cliente_id]: [vendas] | 'carregando' }
  const [compras, setCompras] = useState({})
  // Os pagamentos daquele cliente: { cliente_id: [{valor, forma, data}] }.
  // Andam junto com `compras` — abrem e fecham no mesmo clique do nome.
  const [pagos, setPagos] = useState({})
  // Clientes JÁ QUITADOS que a busca achou (não vêm na lista de devedores).
  const [quitados, setQuitados] = useState([])
  // Telefone em edição: { cliente_id, valor }. Cliente cadastrado às pressas no
  // balcão costuma ficar sem telefone — e sem telefone não dá pra cobrar no zap.
  const [editTel, setEditTel] = useState(null)
  // Cobrança montada e pronta pra mandar: { nome, telefone, texto }
  const [cobranca, setCobranca] = useState(null)
  const [montandoCob, setMontandoCob] = useState(null)
  const [nomeLoja, setNomeLoja] = useState('')
  const [salvandoTel, setSalvandoTel] = useState(false)
  // Recebimento com a forma trocada na hora do aperto: id do pagamento em edição.
  const [formaEdit, setFormaEdit] = useState(null)
  // Filtro de período do histórico de compras (vale pra todos os clientes abertos).
  const [periodo, setPeriodo] = useState('tudo')

  // Grava o telefone de quem foi cadastrado sem ele.
  async function salvarTelefone(clienteId) {
    const tel = String(editTel?.valor ?? '').trim()
    if (tel.replace(/\D/g, '').length < 10) {
      window.alert('Digite o telefone com DDD (10 ou 11 números).')
      return
    }
    setSalvandoTel(true)
    const { error } = await supabase.from('clientes').update({ telefone: tel }).eq('id', clienteId)
    setSalvandoTel(false)
    if (error) { window.alert(recadoDeErro(error, 'salvar o telefone')); return }
    setEditTel(null)
    await load()
  }

  // Apaga um fiado lançado errado (conta salva sem querer, valor trocado...).
  // Quem decide se pode é o banco (mig 0146): só ADM, só fiado, e só se ninguém
  // já tiver lançado recebimento em cima dessa dívida.
  // Recebeu no PIX e anotou dinheiro (ou o contrário)? O valor está certo, só a
  // forma está errada — e é a forma que decide em qual card do caixa o dinheiro
  // entra. Trocar aqui acerta a conferência sem apagar e relançar o recebimento.
  async function trocarFormaPagamento(pagamento, novaForma) {
    if (novaForma === pagamento.forma_pagamento) return
    const { error } = await supabase.from('pagamentos')
      .update({ forma_pagamento: novaForma }).eq('id', pagamento.id)
    if (error) { window.alert(recadoDeErro(error, 'trocar a forma')); return }
    setFormaEdit(null)
    await load()
  }

  async function apagarFiado(venda, clienteId) {
    const motivo = window.prompt(
      `Apagar este fiado de ${fmtBRL(venda.total)}?\n\nEle vai sumir da dívida do cliente.\nEscreva o porquê (fica registrado):`,
      'lançamento errado',
    )
    if (motivo === null) return
    const { error } = await supabase.rpc('cancelar_venda_fiado', { p_venda_id: venda.id, p_motivo: motivo })
    if (error) { window.alert('Não deu pra apagar: ' + error.message); return }
    setCompras(p => { const n = { ...p }; delete n[clienteId]; return n })
    await load()
  }

  // Puxa o que o cliente comprou (vendas + itens) sob demanda ao clicar no nome.
  // Só busca uma vez por cliente; clicar de novo fecha.
  async function verCompras(clienteId) {
    if (compras[clienteId]) {
      setCompras(p => { const n = { ...p }; delete n[clienteId]; return n })
      setPagos(p => { const n = { ...p }; delete n[clienteId]; return n })
      return
    }
    setCompras(p => ({ ...p, [clienteId]: 'carregando' }))
    // As COMPRAS e os PAGAMENTOS juntos: a lista de compras sozinha só dizia o
    // que a pessoa comeu. Quando ela pagava, o pedido virava "fiado pago" e
    // sumia a informação que interessa — QUANDO pagou e QUANTO. Isso não estava
    // em tela nenhuma: pra saber, tinha que abrir o banco.
    const [vd, pg] = await Promise.all([
      supabase.from('vendas')
        .select('id, total, forma_pagamento, created_at, observacoes, venda_itens(quantidade, preco_unitario, subtotal, nome_produto, complementos, produtos(nome))')
        .eq('empresa_id', empresaId)
        .eq('cliente_id', clienteId)
        .neq('status', 'cancelado')
        .order('created_at', { ascending: false })
        // 30 cortava fiado antigo em cliente de todo dia, e sem TODOS os fiados a
        // conta de quem já pagou sai errada (ver faltaPorVenda).
        .limit(200),
      supabase.from('pagamentos')
        .select('id, valor, forma_pagamento, created_at')
        .eq('empresa_id', empresaId)
        .eq('cliente_id', clienteId)
        .eq('observacao', OBS_FIADO)
        .order('created_at', { ascending: false })
        .limit(200),
    ])
    setCompras(p => ({ ...p, [clienteId]: vd.error ? [] : (vd.data ?? []) }))
    setPagos(p => ({ ...p, [clienteId]: pg.error ? [] : (pg.data ?? []) }))
  }

  async function load() {
    setLoading(true); setErro(null)
    // alertas_fiado não traz telefone/limite; busca os dados do cliente à parte
    // e junta por id (a view não tem FK, então não dá pra embutir no select).
    const [fi, cl, pg] = await Promise.all([
      supabase.from('alertas_fiado').select('cliente_id, cliente_nome, saldo_fiado'),
      supabase.from('clientes').select('id, telefone, limite_credito, token').eq('empresa_id', empresaId),
      // Só os recebimentos de fiado. `pagamentos` também guarda a mesa fechada em
      // dinheiro/PIX/cartão (vem da fechar_conta_presencial, com observação
      // "Presencial · Mesa N"), e misturar as duas coisas aqui daria a impressão
      // de que todo mundo pagou fiado. O marcador é a observação que gravamos
      // no `receber()` — se mudar lá, mude aqui.
      supabase.from('pagamentos')
        .select('id, valor, forma_pagamento, created_at, observacao, clientes(nome)')
        .eq('empresa_id', empresaId)
        .eq('observacao', OBS_FIADO)
        .order('created_at', { ascending: false })
        .limit(50),
    ])
    if (fi.error) { setErro(fi.error.message); setLoading(false); return }
    const extra = Object.fromEntries((cl.data ?? []).map(c => [c.id, c]))
    setLinhas((fi.data ?? []).map(f => ({
      ...f,
      saldo_fiado: Number(f.saldo_fiado || 0),
      telefone: extra[f.cliente_id]?.telefone ?? null,
      limite: Number(extra[f.cliente_id]?.limite_credito || 0),
      token: extra[f.cliente_id]?.token ?? null,
    })))
    setHistorico(pg.data ?? [])
    setLoading(false)
  }

  useEffect(() => { if (empresaId) load() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!empresaId) return
    supabase.from('empresas').select('nome').eq('id', empresaId).maybeSingle()
      .then(({ data }) => setNomeLoja(data?.nome ?? 'nossa loja'))
  }, [empresaId])

  // Registra o recebimento. É a linha em `pagamentos` que abate o saldo: a view
  // clientes_saldo_fiado faz "vendas − pagamentos", então quem quita some da lista
  // sozinho. Pagou só uma parte? Continua na lista, com o resto.
  async function receber(linha) {
    const valor = Math.round(parseValor(recebendo?.valor) * 100) / 100
    if (!(valor > 0)) { window.alert('Digite um valor maior que zero.'); return }
    if (valor > linha.saldo_fiado + 0.005) {
      window.alert(`O valor é maior do que a dívida (${fmtBRL(linha.saldo_fiado)}).`)
      return
    }
    setSalvando(true)
    // caixa_id não vai aqui de propósito: a coluna tem DEFAULT current_caixa_id(),
    // então o recebimento cai sozinho no caixa aberto de quem está registrando.
    const { error } = await supabase.from('pagamentos').insert({
      empresa_id: empresaId,
      cliente_id: linha.cliente_id,
      forma_pagamento: recebendo.forma,
      valor,
      observacao: OBS_FIADO,
    })
    setSalvando(false)
    if (error) { window.alert(recadoDeErro(error, 'registrar o pagamento')); return }
    setRecebendo(null)
    await load()
  }

  // Monta a cobrança de um cliente: busca os pedidos fiado, descobre quais
  // ainda estão em aberto (ver pedidosEmAberto) e escreve o texto.
  async function abrirCobranca(l) {
    setMontandoCob(l.cliente_id)
    const { data, error } = await supabase.from('vendas')
      .select('id, total, created_at, forma_pagamento, venda_itens(quantidade, nome_produto, produtos(nome))')
      .eq('empresa_id', empresaId)
      .eq('cliente_id', l.cliente_id)
      .neq('status', 'cancelado')
      .neq('forma_pagamento', 'a_vista')
      .order('created_at', { ascending: false })
      .limit(60)
    setMontandoCob(null)
    if (error) { window.alert('Não deu pra montar a cobrança: ' + error.message); return }

    const abertos = pedidosEmAberto(data ?? [], l.saldo_fiado)
    if (!abertos.length) { window.alert('Não achei pedido em aberto pra esse cliente.'); return }

    setCobranca({
      cliente_id: l.cliente_id,
      nome: l.cliente_nome,
      telefone: l.telefone,
      texto: textoCobranca({
        nomeCliente: l.cliente_nome, nomeLoja, abertos, saldo: l.saldo_fiado, token: l.token,
      }),
    })
  }

  const filtradas = useMemo(() => {
    const q = semAcento(busca)
    return q ? linhas.filter(l => semAcento(l.cliente_nome).includes(q)) : linhas
  }, [linhas, busca])

  // Quem QUITOU some desta tela: a lista vem de `alertas_fiado`, que só traz
  // saldo > 0. Faz sentido pra cobrança — mas então não tinha como conferir
  // quando e quanto um cliente pagou depois que ele acertou tudo, que é
  // justamente quando alguém pergunta.
  //
  // Só busca quando o nome digitado não achou ninguém devendo: é uma consulta a
  // mais, e o uso normal da tela é ver quem deve.
  useEffect(() => {
    const q = busca.trim()
    if (q.length < 2 || filtradas.length > 0) { setQuitados([]); return }
    let cancelado = false
    const t = setTimeout(async () => {
      const { data: cli } = await supabase.from('clientes')
        .select('id, nome, telefone, token')
        .eq('empresa_id', empresaId)
        .ilike('nome', `%${q}%`)
        .limit(20)
      if (cancelado || !cli?.length) { if (!cancelado) setQuitados([]); return }
      // A view de saldo só tem linha pra quem TEM histórico de fiado — é ela
      // que separa "cliente que já comprou fiado e pagou" de "cliente comum".
      const { data: sal } = await supabase.from('clientes_saldo_fiado')
        .select('cliente_id, saldo_fiado')
        .in('cliente_id', cli.map(c => c.id))
      if (cancelado) return
      const temFiado = new Set((sal ?? []).map(s => s.cliente_id))
      setQuitados(cli.filter(c => temFiado.has(c.id)).map(c => ({
        cliente_id: c.id, cliente_nome: c.nome, telefone: c.telefone,
        token: c.token, saldo_fiado: 0, limite: 0,
      })))
    }, 350)
    return () => { cancelado = true; clearTimeout(t) }
  }, [busca, filtradas.length, empresaId])

  const total = filtradas.reduce((s, l) => s + l.saldo_fiado, 0)
  const acimaDoLimite = filtradas.filter(l => l.limite > 0 && l.saldo_fiado > l.limite).length

  if (loading) return <div className="empty-state">Carregando...</div>
  if (erro) return <p className="error-text">Erro ao carregar: {erro}</p>

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
          <div className="label">Total a receber</div>
          <div className="value">{fmtBRL(total)}</div>
        </div>
        <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
          <div className="label">Clientes devendo</div>
          <div className="value">{filtradas.length}</div>
        </div>
        {acimaDoLimite > 0 && (
          <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
            <div className="label">Acima do limite</div>
            <div className="value" style={{ color: '#d97706' }}>{acimaDoLimite}</div>
          </div>
        )}
      </div>

      {linhas.length > 3 && (
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar cliente..."
          style={{ width: '100%', maxWidth: 320, padding: '9px 12px', marginBottom: 12, borderRadius: 8, boxSizing: 'border-box',
            border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14 }} />
      )}

      <div className="data-table">
        {filtradas.length === 0 ? (
          <div className="empty-state">
            {busca ? 'Nenhum cliente com esse nome.' : 'Ninguém devendo no fiado. 🎉'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th style={{ textAlign: 'right' }}>Deve</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {[...filtradas, ...quitados].map(l => {
                const estourou = l.limite > 0 && l.saldo_fiado > l.limite
                const link = zap(l.telefone)
                const aberto = recebendo?.cliente_id === l.cliente_id
                return (
                  <Fragment key={l.cliente_id}>
                    <tr>
                      <td>
                        {/* Nome clicável: abre/fecha o histórico de compras */}
                        <button type="button" onClick={() => verCompras(l.cliente_id)}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                            fontWeight: 600, fontSize: 14.5, color: 'var(--primary)' }}>
                          {compras[l.cliente_id] ? '▾ ' : '▸ '}{l.cliente_nome}
                        </button>
                        {l.telefone ? (
                          link
                            ? <a href={link} target="_blank" rel="noreferrer"
                                style={{ fontSize: 12.5, color: 'var(--primary)', textDecoration: 'none' }}>
                                💬 {l.telefone}
                              </a>
                            : <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{l.telefone}</span>
                        ) : editTel?.cliente_id === l.cliente_id ? (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
                            <input value={editTel.valor} type="tel" inputMode="tel" autoFocus
                              placeholder="Telefone com DDD"
                              onChange={e => setEditTel(t => ({ ...t, valor: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') salvarTelefone(l.cliente_id) }}
                              style={{ width: 150, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)',
                                background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }} />
                            <button type="button" onClick={() => salvarTelefone(l.cliente_id)} disabled={salvandoTel}
                              style={{ padding: '5px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                                background: 'var(--primary)', color: '#fff', fontSize: 12, fontWeight: 800 }}>
                              {salvandoTel ? '...' : 'Salvar'}
                            </button>
                            <button type="button" onClick={() => setEditTel(null)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16 }}>×</button>
                          </div>
                        ) : (
                          // Cadastrou no aperto e não pegou o telefone? Põe agora.
                          <button type="button" onClick={() => setEditTel({ cliente_id: l.cliente_id, valor: '' })}
                            style={{ display: 'block', background: 'none', border: 'none', padding: 0, marginTop: 2,
                              cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12.5, textDecoration: 'underline' }}>
                            ➕ pôr o telefone
                          </button>
                        )}
                        {estourou && (
                          <div style={{ fontSize: 12, color: '#d97706', fontWeight: 700 }}>
                            ⚠️ passou do limite de {fmtBRL(l.limite)}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800, whiteSpace: 'nowrap' }}>
                        {fmtBRL(l.saldo_fiado)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button"
                          onClick={() => setRecebendo(aberto ? null : {
                            cliente_id: l.cliente_id,
                            valor: l.saldo_fiado.toFixed(2).replace('.', ','),
                            forma: 'dinheiro',
                          })}
                          style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
                            border: `1px solid ${aberto ? 'var(--border)' : 'var(--success, #16a34a)'}`,
                            background: 'transparent', color: aberto ? 'var(--text-muted)' : 'var(--success, #16a34a)',
                            fontSize: 12.5, fontWeight: 700 }}>
                          {aberto ? 'Cancelar' : '✓ Pago'}
                        </button>
                        {/* Cobrança pronta: o texto já sai com os pedidos que
                            ainda estão em aberto, não com todos os fiados. */}
                        <button type="button"
                          onClick={() => abrirCobranca(l)}
                          disabled={montandoCob === l.cliente_id}
                          title={l.telefone ? 'Montar a mensagem de cobrança' : 'Põe o telefone primeiro'}
                          style={{ marginLeft: 8, padding: '6px 12px', borderRadius: 8, whiteSpace: 'nowrap',
                            cursor: montandoCob === l.cliente_id ? 'wait' : 'pointer',
                            border: '1px solid var(--primary)', background: 'transparent',
                            color: 'var(--primary)', fontSize: 12.5, fontWeight: 700 }}>
                          {montandoCob === l.cliente_id ? '...' : '📣 Cobrar'}
                        </button>
                      </td>
                    </tr>

                    {aberto && (
                      <tr>
                        <td colSpan={3} style={{ background: 'rgba(22,163,74,.06)' }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '4px 0' }}>
                            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Recebeu quanto?</span>
                            <input value={recebendo.valor} inputMode="decimal" autoFocus
                              onChange={e => setRecebendo(r => ({ ...r, valor: e.target.value }))}
                              style={{ width: 110, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--border)',
                                background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14, fontWeight: 700 }} />

                            <select value={recebendo.forma}
                              onChange={e => setRecebendo(r => ({ ...r, forma: e.target.value }))}
                              style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid var(--border)',
                                background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13.5 }}>
                              {FORMAS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                            </select>

                            <button type="button" onClick={() => receber(l)} disabled={salvando}
                              style={{ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: salvando ? 'wait' : 'pointer',
                                background: 'var(--success, #16a34a)', color: '#fff', fontSize: 13, fontWeight: 800, opacity: salvando ? .6 : 1 }}>
                              {salvando ? 'Salvando...' : 'Confirmar'}
                            </button>

                            {parseValor(recebendo.valor) > 0 && parseValor(recebendo.valor) < l.saldo_fiado && (
                              <span style={{ fontSize: 12.5, color: '#d97706', fontWeight: 700 }}>
                                fica devendo {fmtBRL(l.saldo_fiado - parseValor(recebendo.valor))}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}

                    {/* Histórico de compras do cliente (abre ao clicar no nome) */}
                    {compras[l.cliente_id] && (
                      <tr>
                        <td colSpan={3} style={{ background: 'var(--card, rgba(124,58,237,.04))' }}>
                          {compras[l.cliente_id] === 'carregando' ? (
                            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>Carregando compras...</div>
                          ) : compras[l.cliente_id].length === 0 ? (
                            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>Nenhuma compra registrada.</div>
                          ) : (
                            <div style={{ padding: '2px 0' }}>
                              {/* Fecha a conta em três números. Sem isto a tela só
                                  contava o que a pessoa comeu: o quanto ela já
                                  pagou, e quando, não aparecia em lugar nenhum. */}
                              {(() => {
                                const comprou = compras[l.cliente_id]
                                  .filter(v => v.forma_pagamento !== 'a_vista')
                                  .reduce((s, v) => s + Number(v.total || 0), 0)
                                const lista = pagos[l.cliente_id] ?? []
                                const pagou = lista.reduce((s, p) => s + Number(p.valor || 0), 0)
                                const desde = desdeDoPeriodo(periodo)
                                const noPeriodo = compras[l.cliente_id].filter(v => !desde || new Date(v.created_at) >= desde)
                                const totalPeriodo = noPeriodo.filter(v => v.forma_pagamento !== 'a_vista')
                                  .reduce((s, v) => s + Number(v.total || 0), 0)
                                return (
                                  <>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, padding: '8px 0 10px',
                                      borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                                      <span>Comprou no fiado <strong>{fmtBRL(comprou)}</strong></span>
                                      <span style={{ color: 'var(--success, #16a34a)' }}>Já pagou <strong>{fmtBRL(pagou)}</strong></span>
                                      <span style={{ color: l.saldo_fiado > 0.005 ? '#d97706' : 'var(--success, #16a34a)' }}>
                                        {l.saldo_fiado > 0.005 ? <>Ainda deve <strong>{fmtBRL(l.saldo_fiado)}</strong></> : <strong>Quitado ✅</strong>}
                                      </span>
                                    </div>

                                    <div style={{ padding: '8px 0 10px', borderBottom: '1px solid var(--border)' }}>
                                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>
                                        PAGAMENTOS
                                      </div>
                                      {lista.length === 0 ? (
                                        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nunca pagou nada ainda.</div>
                                      ) : lista.map(p => (
                                        <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '3px 0' }}>
                                          <span style={{ color: 'var(--text-muted)' }}>
                                            {dataHora(p.created_at)} · {FORMAS.find(f => f.id === p.forma_pagamento)?.label ?? p.forma_pagamento}
                                          </span>
                                          <strong style={{ color: 'var(--success, #16a34a)' }}>{fmtBRL(p.valor)}</strong>
                                        </div>
                                      ))}
                                    </div>

                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '10px 0 2px' }}>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>COMPRAS</span>
                                      <select value={periodo} onChange={e => setPeriodo(e.target.value)}
                                        style={{ padding: '4px 8px', borderRadius: 7, fontSize: 12.5, border: '1px solid var(--border)',
                                          background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }}>
                                        {PERIODOS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                                      </select>
                                      <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                        {noPeriodo.length} {noPeriodo.length === 1 ? 'compra' : 'compras'} · <strong>{fmtBRL(totalPeriodo)}</strong>
                                      </span>
                                      <button type="button"
                                        onClick={() => imprimirExtrato({
                                          cliente: l.cliente_nome, nomeLoja, saldo: l.saldo_fiado,
                                          periodoLabel: PERIODOS.find(p => p.id === periodo)?.label ?? '',
                                          vendas: noPeriodo, pagamentos: lista,
                                        })}
                                        style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 12.5,
                                          fontWeight: 700, border: '1px solid var(--primary)', background: 'transparent', color: 'var(--primary)' }}>
                                        🖨️ Extrato
                                      </button>
                                    </div>
                                  </>
                                )
                              })()}

                              {(() => { const falta = faltaPorVenda(compras[l.cliente_id], l.saldo_fiado); const desde = desdeDoPeriodo(periodo); return compras[l.cliente_id].filter(v => !desde || new Date(v.created_at) >= desde).map(v => {
                                const canal = canalDaVenda(v.observacoes)
                                const emAberto = falta.get(v.id)                       // undefined = quitado
                                const ehFiado  = v.forma_pagamento !== 'a_vista'
                                const parcial  = emAberto !== undefined && emAberto < Number(v.total) - 0.005
                                return (
                                <div key={v.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                                    <span style={{ color: 'var(--text-muted)' }}>
                                      {dataHora(v.created_at)}
                                      {canal && <span style={{ fontWeight: 600 }}> · {canal}</span>}
                                      {ehFiado && (
                                        emAberto === undefined
                                          ? <span style={{ color: 'var(--success, #16a34a)', fontWeight: 700 }}> · fiado pago</span>
                                          : parcial
                                            ? <span style={{ color: '#d97706', fontWeight: 700 }}> · falta {fmtBRL(emAberto)}</span>
                                            : <span style={{ color: '#d97706', fontWeight: 700 }}> · fiado</span>
                                      )}
                                    </span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                                      <span style={{ fontWeight: 700 }}>{fmtBRL(v.total)}</span>
                                      {/* Fiado lançado errado: o ADM apaga aqui (mig 0146). */}
                                      {ehAdmin && v.forma_pagamento === 'fiado' && emAberto !== undefined && (
                                        <button type="button" onClick={() => apagarFiado(v, l.cliente_id)}
                                          title="Apagar este fiado (lançamento errado)"
                                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                            fontSize: 14, lineHeight: 1, color: 'var(--danger)' }}>
                                          🗑️
                                        </button>
                                      )}
                                    </span>
                                  </div>
                                  {(v.venda_itens ?? []).length > 0 && (
                                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                                      {v.venda_itens.map((it, i) => (
                                        <div key={i} style={{ marginBottom: 2 }}>
                                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                            <span>{Number(it.quantidade)}× {nomeDoItem(it)}</span>
                                            <span style={{ whiteSpace: 'nowrap' }}>
                                              {Number(it.quantidade) !== 1 && <>{fmtBRL(it.preco_unitario)} un · </>}{fmtBRL(it.subtotal ?? it.preco_unitario * it.quantidade)}
                                            </span>
                                          </div>
                                          {complementosDoItem(it) && (
                                            <div style={{ fontSize: 12, paddingLeft: 14 }}>{complementosDoItem(it)}</div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ) }) })()}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Histórico: pra onde some quem pagou. Sem isso, quitar a dívida faria o
          cliente sumir da tela sem deixar rastro nenhum. */}
      <div style={{ fontSize: 15, fontWeight: 800, margin: '26px 0 10px' }}>
        ✅ Pagamentos recebidos
      </div>
      <div className="data-table">
        {historico.length === 0 ? (
          <div className="empty-state">Nenhum pagamento registrado ainda.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Quando</th>
                <th>Forma</th>
                <th style={{ textAlign: 'right' }}>Valor</th>
              </tr>
            </thead>
            <tbody>
              {historico.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.clientes?.nome ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 13 }}>{dataHora(p.created_at)}</td>
                  <td style={{ fontSize: 13 }}>
                    {/* Anotou dinheiro e foi PIX? O ADM troca aqui — o valor não muda,
                        só em qual card do caixa ele entra. */}
                    {formaEdit === p.id ? (
                      <select autoFocus value={p.forma_pagamento}
                        onChange={e => trocarFormaPagamento(p, e.target.value)}
                        onBlur={() => setFormaEdit(null)}
                        style={{ padding: '4px 6px', borderRadius: 6, fontSize: 12.5,
                          border: '1.5px solid var(--primary)', background: 'var(--bg)', color: 'var(--text)' }}>
                        {FORMAS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                      </select>
                    ) : ehAdmin ? (
                      <button type="button" onClick={() => setFormaEdit(p.id)}
                        title="Trocar a forma deste recebimento"
                        style={{ padding: '3px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
                          border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text)' }}>
                        {FORMAS.find(f => f.id === p.forma_pagamento)?.label ?? p.forma_pagamento} ✎
                      </button>
                    ) : (
                      FORMAS.find(f => f.id === p.forma_pagamento)?.label ?? p.forma_pagamento
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--success, #16a34a)' }}>
                    {fmtBRL(p.valor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Cobrança pronta ──
          O texto sai montado e editável. Mandar pelo WhatsApp abre a conversa
          com o cliente no aparelho da loja — assim a mensagem sai do número da
          loja, que é o número que o cliente conhece. */}
      {cobranca && (
        <div onClick={() => setCobranca(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--card, var(--bg))', border: '1px solid var(--border)', borderRadius: 14,
              width: 'min(560px, 100%)', maxHeight: '90vh', overflow: 'auto', padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3 style={{ margin: 0, fontSize: 17 }}>Cobrar {cobranca.nome}</h3>
              <button type="button" onClick={() => setCobranca(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 20 }}>×</button>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>
              Só entram os pedidos que ainda estão em aberto. Pode editar antes de mandar.
            </p>

            <textarea value={cobranca.texto}
              onChange={e => setCobranca(c => ({ ...c, texto: e.target.value }))}
              rows={14}
              style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid var(--border)',
                background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13.5,
                lineHeight: 1.5, fontFamily: 'inherit', resize: 'vertical' }} />

            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {zap(cobranca.telefone) ? (
                <a href={`${zap(cobranca.telefone)}?text=${encodeURIComponent(cobranca.texto)}`}
                  target="_blank" rel="noreferrer"
                  onClick={() => setCobranca(null)}
                  style={{ flex: '1 1 200px', textAlign: 'center', padding: '11px 14px', borderRadius: 10,
                    background: '#25D366', color: '#05230f', fontWeight: 800, fontSize: 14, textDecoration: 'none' }}>
                  💬 Mandar no WhatsApp
                </a>
              ) : (
                <span style={{ flex: '1 1 200px', textAlign: 'center', padding: '11px 14px', borderRadius: 10,
                  border: '1px dashed var(--border)', color: 'var(--text-muted)', fontSize: 13 }}>
                  Sem telefone cadastrado
                </span>
              )}
              <button type="button"
                onClick={async () => {
                  try { await navigator.clipboard.writeText(cobranca.texto); window.alert('Texto copiado.') }
                  catch { window.alert('Não deu pra copiar — selecione o texto e copie na mão.') }
                }}
                style={{ padding: '11px 14px', borderRadius: 10, border: '1px solid var(--border)',
                  background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                Copiar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
