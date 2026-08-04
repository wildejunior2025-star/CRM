import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { calcIfoodLiquido } from '../lib/ifoodLiquido'
import ConsumoFuncionario from '../components/ConsumoFuncionario'
import '../components/Page.css'

// ── helpers ───────────────────────────────────────────────────────────
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const ddmm = (s) => new Date(s + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
const addDia = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d) }
const diaSemana = (s) => new Date(s + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'long' })
const mesLabel = (s) => new Date(s + 'T00:00:00').toLocaleDateString('pt-BR', { month: 'long', year: '2-digit' })
// Conversão pra unidade base (grama/ml/un), igual à Ficha Técnica.
const FATOR = { kg: 1000, g: 1, L: 1000, ml: 1, un: 1 }
const UNIDADES = ['kg', 'g', 'L', 'ml', 'un']
const emBase = (qtd, unidade) => Number(qtd || 0) * (FATOR[unidade] || 1)
const num = (s) => Number(String(s ?? '').replace(',', '.')) || 0

const CATEGORIAS = [
  ['aluguel', '🏠 Aluguel'], ['energia', '💡 Energia'], ['agua', '🚰 Água'],
  ['internet', '🌐 Internet'], ['gas', '🔥 Gás'], ['outros', '📦 Outros'],
]
const catLabel = (c) => (CATEGORIAS.find(([k]) => k === c)?.[1]) || '📦 Outros'
const PERFIL_LABEL = { admin: 'Gerente/Admin', vendedor: 'Vendedor', garcom: 'Garçom', cozinheiro: 'Cozinheiro', entregador: 'Entregador' }

// ── Vigência: o que valia num dia passado ────────────────────────────
// O que está cadastrado hoje vale também pros dias passados. NÃO dá pra usar
// o created_at como "data de entrada": ele é quando a pessoa foi digitada no
// sistema, não quando foi contratada — a loja cadastra tudo de uma vez no dia
// que começa a usar, e aí todo dia anterior apareceria com folha zero.
// O que muda a conta de um dia velho é só o que foi registrado explicitamente:
// saída (inativado_em) e mudança de valor (valor_historico). E quando o dia é
// fechado, ele congela e nada mais mexe nele.
const soData = (ts) => (ts ? String(ts).slice(0, 10) : null)
function vigenteNoDia(row, dia) {
  const saiu = soData(row.inativado_em)
  if (saiu) return dia < saiu
  return row.ativo !== false
}
// valor_historico: [{ ate: 'YYYY-MM-DD', valor: n }] — n valeu ATÉ `ate` (inclusive).
function valorNoDia(row, campo, dia) {
  const hist = Array.isArray(row.valor_historico) ? row.valor_historico : []
  const anteriores = hist
    .filter(h => h && h.ate && dia <= String(h.ate))
    .sort((a, b) => String(a.ate).localeCompare(String(b.ate)))
  if (anteriores.length) return Number(anteriores[0].valor || 0)
  return Number(row[campo] || 0)
}
// Anexa o valor antigo ao histórico quando ele muda hoje (valia até ontem).
function novoHistorico(row, campo, valorNovo, hojeYMD) {
  const antigo = Number(row[campo] || 0)
  if (Number(valorNovo) === antigo) return undefined      // nada mudou
  const hist = Array.isArray(row.valor_historico) ? row.valor_historico : []
  return [...hist, { ate: addDia(hojeYMD, -1), valor: antigo }]
}

// ── Dias que a loja abre ─────────────────────────────────────────────
// A grade semanal (Minha Loja → Horários) já diz em que dias a loja abre —
// índice 0 = domingo, igual ao getDay() do JS. Contar os dias reais do mês é
// melhor que um número fixo digitado: acerta mês a mês sozinho (agosto/26 tem
// 21 dias úteis, setembro tem 22) e some com o risco de ficar desatualizado.
const SIGLA_DIA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const gradeValida = (h) => Array.isArray(h) && h.length === 7 && h.some(d => d?.aberto)
function diasAbertosNoMes(diaYMD, horarios) {
  if (!gradeValida(horarios)) return null
  const [y, m] = diaYMD.split('-').map(Number)
  const ultimo = new Date(y, m, 0).getDate()
  let n = 0
  for (let d = 1; d <= ultimo; d++) if (horarios[new Date(y, m - 1, d).getDay()]?.aberto) n++
  return n || null
}
const abreNoDia = (diaYMD, horarios) =>
  !gradeValida(horarios) ? true : !!horarios[new Date(diaYMD + 'T00:00:00').getDay()]?.aberto
const diasQueAbre = (horarios) =>
  !gradeValida(horarios) ? '' : horarios.map((d, i) => (d?.aberto ? SIGLA_DIA[i] : null)).filter(Boolean).join(', ')

// custo por unidade base de uma ficha (custo total / rendimento em base)
function custoPorBaseFicha(ficha, itens) {
  const custoTotal = (itens || []).reduce((s, it) => s + emBase(it.quantidade, it.unidade) * Number(it.custo_unit || 0), 0)
  const rendBase = emBase(ficha.rendimento, ficha.unid_rendimento)
  return rendBase > 0 ? custoTotal / rendBase : 0
}

const emptyDespesa = { nome: '', categoria: 'energia', tipo: 'fixo', valor: '' }
const emptyFunc = { nome: '', cargo: '', salario_mensal: '' }
const emptyProd = () => ({ ficha_id: '', qtd_feita: '', qtd_sobrou: '', unidade: 'kg' })
const emptyImprev = { tipo: 'pedido', numero: '', descricao: '', valor: '', info: null }

export default function DespesasLucro({ empresaId }) {
  const hoje = new Date()
  const hojeYMD = ymd(hoje)

  const [dia, setDia] = useState(hojeYMD)  // dia que está sendo olhado (nunca no futuro)
  const ehHoje = dia === hojeYMD
  const ontemYMD = addDia(hojeYMD, -1)
  const rotuloDia = ehHoje ? 'de hoje' : dia === ontemYMD ? 'de ontem' : 'do dia'

  const [sub, setSub] = useState('hoje') // 'hoje' | 'historico'
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [despesas, setDespesas] = useState([])
  const [funcionarios, setFuncionarios] = useState([])
  const [producao, setProducao] = useState([])     // só de HOJE
  const [imprevistos, setImprevistos] = useState([]) // custos imprevistos de HOJE
  const [fichas, setFichas] = useState([])          // [{id, nome, custoPorBase}]
  const [usuarios, setUsuarios] = useState([])      // funcionários já cadastrados em Usuários
  const [historico, setHistorico] = useState([])    // fechamentos diários
  const [diasAbertos, setDiasAbertos] = useState(26)
  const [horarios, setHorarios] = useState(null)   // grade semanal da loja (Minha Loja → Horários)
  const [receitaDia, setReceitaDia] = useState({ proprios: 0, salao: 0, ifood: 0 })
  const [fechando, setFechando] = useState(false)
  const [histAberto, setHistAberto] = useState({}) // { [id]: bool } dias expandidos no histórico

  // modais
  const [showDespesa, setShowDespesa] = useState(false)
  const [despesaForm, setDespesaForm] = useState(emptyDespesa)
  const [despesaEdit, setDespesaEdit] = useState(null)
  const [showFunc, setShowFunc] = useState(false)
  const [funcForm, setFuncForm] = useState(emptyFunc)
  const [funcEdit, setFuncEdit] = useState(null)
  const [showProd, setShowProd] = useState(false)
  const [prodForm, setProdForm] = useState(emptyProd())
  const [showImprev, setShowImprev] = useState(false)
  const [imprevForm, setImprevForm] = useState(emptyImprev)
  const [buscandoPed, setBuscandoPed] = useState(false)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setLoading(true); setError(null)
    try {
      const ini = new Date(dia + 'T00:00:00')
      const fim = new Date(ini); fim.setDate(fim.getDate() + 1)

      // Traz inativos também: quem saiu depois ainda conta nos dias em que estava lá.
      const [dp, fn, pd, fi, fit, emp, ped, us, hi, im, vd] = await Promise.all([
        supabase.from('despesas_loja').select('*').eq('empresa_id', empresaId).order('valor', { ascending: false }),
        supabase.from('funcionarios').select('*').eq('empresa_id', empresaId).order('nome'),
        supabase.from('producao_diaria').select('*').eq('empresa_id', empresaId).eq('data', dia).order('created_at', { ascending: false }),
        supabase.from('fichas_tecnicas').select('*').eq('empresa_id', empresaId).order('nome'),
        supabase.from('ficha_itens').select('ficha_id, quantidade, unidade, custo_unit').eq('empresa_id', empresaId),
        supabase.from('empresas').select('dias_abertos_mes, ifood_comissao_pct, ifood_transacao_pct, ifood_entrega_propria, horarios_funcionamento').eq('id', empresaId).maybeSingle(),
        fetchAll(() => supabase.from('pedidos_delivery')
          .select('origem, total, taxa_entrega, subtotal, ifood_valores, forma_pagamento, status')
          .neq('status', 'cancelado').gte('created_at', ini.toISOString()).lt('created_at', fim.toISOString())),
        supabase.from('profiles').select('id, nome, perfil, cargo').eq('empresa_id', empresaId).eq('ativo', true)
          .in('perfil', ['admin', 'vendedor', 'garcom', 'cozinheiro', 'entregador']).order('nome'),
        supabase.from('historico_dia').select('*').eq('empresa_id', empresaId).order('data', { ascending: false }).limit(90),
        supabase.from('custos_imprevistos').select('*').eq('empresa_id', empresaId).eq('data', dia).order('created_at', { ascending: false }),
        // Vendas do SALÃO/balcão (fechar conta presencial) — não vivem em pedidos_delivery.
        supabase.from('vendas').select('total').eq('empresa_id', empresaId).neq('status', 'cancelado')
          .gte('created_at', ini.toISOString()).lt('created_at', fim.toISOString()),
      ])
      for (const r of [dp, fn, pd, fi, fit, ped, hi, im]) if (r.error) throw r.error

      setDespesas((dp.data || []).filter(d => vigenteNoDia(d, dia)))
      setFuncionarios((fn.data || []).filter(f => vigenteNoDia(f, dia)))
      setProducao(pd.data || [])
      setImprevistos(im.data || [])
      setUsuarios(us.error ? [] : (us.data || []))
      setHistorico(hi.data || [])
      setDiasAbertos(Number(emp.data?.dias_abertos_mes ?? 26) || 26)
      setHorarios(emp.data?.horarios_funcionamento ?? null)

      const itensPor = {}
      for (const it of (fit.data || [])) (itensPor[it.ficha_id] = itensPor[it.ficha_id] || []).push(it)
      setFichas((fi.data || []).map(f => ({ id: f.id, nome: f.nome, custoPorBase: custoPorBaseFicha(f, itensPor[f.id] || []) })))

      const peds = ped.data || []
      const proprios = peds.filter(p => ['whatsapp', 'app', 'cardapio'].includes(p.origem) || !p.origem)
        .reduce((s, p) => s + (Number(p.total || 0) - Number(p.taxa_entrega || 0)), 0)
      const rates = { comissao: emp.data?.ifood_comissao_pct, transacao: emp.data?.ifood_transacao_pct, entregaPropria: emp.data?.ifood_entrega_propria !== false }
      const ifoodLiq = calcIfoodLiquido(peds.filter(p => p.origem === 'ifood'), rates)
      const salao = (vd.error ? [] : (vd.data || [])).reduce((s, v) => s + Number(v.total || 0), 0)
      setReceitaDia({ proprios, salao, ifood: Number(ifoodLiq.voceRecebe || 0) })
    } catch (e) {
      setError(e.message || 'Erro ao carregar')
    } finally {
      setLoading(false)
    }
  }, [empresaId, dia])

  useEffect(() => { carregar() }, [carregar])

  // ── cálculos do DIA ──────────────────────────────────────────────
  // Usa o valor que valia NAQUELE dia, não o de hoje.
  const totalFixo = useMemo(() => despesas.reduce((s, d) => s + valorNoDia(d, 'valor', dia), 0), [despesas, dia])
  const totalFunc = useMemo(() => funcionarios.reduce((s, f) => s + valorNoDia(f, 'salario_mensal', dia), 0), [funcionarios, dia])
  const custoProdItem = (p) => emBase(Number(p.qtd_feita || 0) - Number(p.qtd_sobrou || 0), p.unidade) * Number(p.custo_unit || 0)
  const producaoHoje = useMemo(() => producao.reduce((s, p) => s + custoProdItem(p), 0), [producao])
  const imprevistoHoje = useMemo(() => imprevistos.reduce((s, i) => s + Number(i.valor || 0), 0), [imprevistos])

  // Divisor do rateio: conta os dias reais do mês pela grade da loja; só cai no
  // número digitado se a loja ainda não configurou os horários.
  const diasAuto = useMemo(() => diasAbertosNoMes(dia, horarios), [dia, horarios])
  const dias = Math.max(1, diasAuto ?? diasAbertos)
  const abre = abreNoDia(dia, horarios)
  // Num dia que a loja não abre o rateio é zero: o custo do mês já foi dividido
  // entre os dias em que ela abre, cobrar de novo aqui contaria duas vezes.
  const fixoPorDiaBase = totalFixo / dias
  const funcPorDiaBase = totalFunc / dias
  const fixoPorDia = abre ? fixoPorDiaBase : 0
  const funcPorDia = abre ? funcPorDiaBase : 0
  const receita = receitaDia.proprios + (receitaDia.salao || 0) + receitaDia.ifood
  const custosDia = fixoPorDia + funcPorDia + producaoHoje + imprevistoHoje
  const lucroDia = receita - custosDia

  // Dia já fechado: vale o retrato salvo. Recalcular seria errado — a produção
  // daquele dia foi apagada no fechamento, então daria custo zero.
  const fechado = useMemo(() => historico.find(h => h.data === dia) || null, [historico, dia])
  const v = fechado
    ? { receita: Number(fechado.receita_liquida || 0), fixo: Number(fechado.custo_fixo || 0), func: Number(fechado.custo_funcionarios || 0),
        prod: Number(fechado.custo_producao || 0), imprev: Number(fechado.custo_imprevisto || 0), lucro: Number(fechado.lucro || 0) }
    : { receita, fixo: fixoPorDia, func: funcPorDia, prod: producaoHoje, imprev: imprevistoHoje, lucro: lucroDia }
  const itensFechado = Array.isArray(fechado?.itens) ? fechado.itens : []
  const imprevFechado = Array.isArray(fechado?.imprevistos) ? fechado.imprevistos : []

  async function salvarDias(v) {
    const x = Math.max(1, Math.min(31, Math.round(Number(v) || 26)))
    setDiasAbertos(x)
    if (empresaId) await supabase.from('empresas').update({ dias_abertos_mes: x }).eq('id', empresaId)
  }

  // ── FECHAR O DIA: salva no histórico e limpa a produção do dia ──
  async function fecharDia() {
    if (!confirm(`Fechar o dia ${ddmm(dia)}?\n\nCongela o resumo desse dia no Histórico e LIMPA a produção dele (o valor não muda mais, mesmo que você mexa nos custos depois).`)) return
    setFechando(true)
    try {
      const itens = producao.map(p => ({ nome: p.nome, qtd_feita: Number(p.qtd_feita || 0), qtd_sobrou: Number(p.qtd_sobrou || 0), unidade: p.unidade, custo: custoProdItem(p) }))
      const impSnap = imprevistos.map(i => ({ descricao: i.descricao, valor: Number(i.valor || 0) }))
      const { error: upErr } = await supabase.from('historico_dia').upsert({
        empresa_id: empresaId, data: dia,
        receita_liquida: receita, receita_proprios: receitaDia.proprios + (receitaDia.salao || 0), receita_ifood: receitaDia.ifood,
        custo_fixo: fixoPorDia, custo_funcionarios: funcPorDia,
        custo_producao: producaoHoje, custo_imprevisto: imprevistoHoje,
        lucro: lucroDia, itens, imprevistos: impSnap,
      }, { onConflict: 'empresa_id,data' })
      if (upErr) throw upErr
      // limpa a produção e os imprevistos do dia (já estão no snapshot do histórico)
      const { error: delErr } = await supabase.from('producao_diaria').delete().eq('empresa_id', empresaId).eq('data', dia)
      if (delErr) throw delErr
      const { error: delImp } = await supabase.from('custos_imprevistos').delete().eq('empresa_id', empresaId).eq('data', dia)
      if (delImp) throw delImp
      await carregar()
      setSub('historico')
    } catch (e) {
      alert('Erro ao fechar o dia: ' + (e.message || e))
    } finally {
      setFechando(false)
    }
  }

  // ── CRUD: despesa ──
  function abrirNovaDespesa() { setDespesaEdit(null); setDespesaForm(emptyDespesa); setShowDespesa(true) }
  function abrirEditarDespesa(d) { setDespesaEdit(d); setDespesaForm({ nome: d.nome, categoria: d.categoria, tipo: d.tipo, valor: String(d.valor ?? '') }); setShowDespesa(true) }
  async function salvarDespesa(e) {
    e.preventDefault()
    if (!despesaForm.nome.trim()) return
    const payload = { empresa_id: empresaId, nome: despesaForm.nome.trim(), categoria: despesaForm.categoria, tipo: despesaForm.tipo, valor: num(despesaForm.valor) }
    // Mudou o valor? guarda o antigo com a data até quando ele valeu, senão os
    // dias já passados passariam a ser recalculados com o valor novo.
    if (despesaEdit) {
      const hist = novoHistorico(despesaEdit, 'valor', payload.valor, hojeYMD)
      if (hist) payload.valor_historico = hist
    }
    const q = despesaEdit ? supabase.from('despesas_loja').update(payload).eq('id', despesaEdit.id) : supabase.from('despesas_loja').insert(payload)
    const { error } = await q
    if (error) { alert('Erro: ' + error.message); return }
    setShowDespesa(false); carregar()
  }
  // Não apaga: marca a data em que o custo deixou de existir, pra não sumir dos dias passados.
  async function excluirDespesa(d) {
    if (!confirm(`Tirar "${d.nome}" da conta a partir de hoje?\n\nOs dias anteriores continuam contando com ele.`)) return
    await supabase.from('despesas_loja').update({ ativo: false, inativado_em: new Date().toISOString() }).eq('id', d.id)
    carregar()
  }

  // ── CRUD: funcionário ──
  function abrirNovoFunc() { setFuncEdit(null); setFuncForm(emptyFunc); setShowFunc(true) }
  function abrirEditarFunc(f) { setFuncEdit(f); setFuncForm({ nome: f.nome, cargo: f.cargo || '', salario_mensal: String(f.salario_mensal ?? '') }); setShowFunc(true) }
  async function salvarFunc(e) {
    e.preventDefault()
    if (!funcForm.nome.trim()) return
    const payload = { empresa_id: empresaId, nome: funcForm.nome.trim(), cargo: funcForm.cargo.trim() || null, salario_mensal: num(funcForm.salario_mensal) }
    // Aumento de salário vale de hoje em diante; o salário antigo fica guardado
    // pros dias em que ele era o que estava valendo.
    if (funcEdit) {
      const hist = novoHistorico(funcEdit, 'salario_mensal', payload.salario_mensal, hojeYMD)
      if (hist) payload.valor_historico = hist
    }
    const q = funcEdit ? supabase.from('funcionarios').update(payload).eq('id', funcEdit.id) : supabase.from('funcionarios').insert(payload)
    const { error } = await q
    if (error) { alert('Erro: ' + error.message); return }
    setShowFunc(false); carregar()
  }
  // Demissão: sai da folha de hoje em diante, mas continua contando nos dias em que trabalhou.
  async function excluirFunc(f) {
    if (!confirm(`Tirar "${f.nome}" da folha a partir de hoje?\n\nOs dias em que ele trabalhou continuam contando com o salário dele.`)) return
    await supabase.from('funcionarios').update({ ativo: false, inativado_em: new Date().toISOString() }).eq('id', f.id)
    carregar()
  }
  function puxarUsuario(uid) {
    const u = usuarios.find(x => x.id === uid)
    if (!u) return
    setFuncForm(f => ({ ...f, nome: u.nome || '', cargo: u.cargo || PERFIL_LABEL[u.perfil] || '' }))
  }
  const jaFunc = new Set(funcionarios.map(f => (f.nome || '').trim().toLowerCase()))
  const usuariosDisponiveis = usuarios.filter(u => u.nome && !jaFunc.has(u.nome.trim().toLowerCase()))

  // ── CRUD: produção diária ──
  function abrirNovaProd() { setProdForm(emptyProd()); setShowProd(true) }
  const fichaSel = fichas.find(f => f.id === prodForm.ficha_id)
  const prodPrevia = fichaSel ? emBase(num(prodForm.qtd_feita) - num(prodForm.qtd_sobrou), prodForm.unidade) * fichaSel.custoPorBase : 0
  async function salvarProd(e) {
    e.preventDefault()
    if (!prodForm.ficha_id || !fichaSel) { alert('Escolha o produto (ficha técnica).'); return }
    const payload = {
      empresa_id: empresaId, data: dia, ficha_id: prodForm.ficha_id, nome: fichaSel.nome,
      qtd_feita: num(prodForm.qtd_feita), qtd_sobrou: num(prodForm.qtd_sobrou),
      unidade: prodForm.unidade, custo_unit: fichaSel.custoPorBase,
    }
    const { error } = await supabase.from('producao_diaria').insert(payload)
    if (error) { alert('Erro: ' + error.message); return }
    setShowProd(false); carregar()
  }
  async function excluirProd(p) { if (!confirm(`Excluir o lançamento de ${p.nome}?`)) return; await supabase.from('producao_diaria').delete().eq('id', p.id); carregar() }
  async function excluirHistorico(h) { if (!confirm(`Excluir o dia ${ddmm(h.data)} do histórico?`)) return; await supabase.from('historico_dia').delete().eq('id', h.id); carregar() }

  // ── CRUD: custo imprevisto do dia ──
  function abrirNovoImprev() { setImprevForm(emptyImprev); setShowImprev(true) }
  // Busca um pedido pelo número e traz o valor + os itens pro form.
  async function buscarPedido() {
    const n = String(imprevForm.numero || '').trim()
    if (!n) { setImprevForm(f => ({ ...f, info: { erro: true, txt: 'Digite o número do pedido.' } })); return }
    setBuscandoPed(true)
    const { data, error } = await supabase.from('pedidos_delivery')
      .select('numero_pedido, cliente_nome, total, itens, origem, status, created_at')
      .eq('empresa_id', empresaId).eq('numero_pedido', n)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    setBuscandoPed(false)
    if (error || !data) { setImprevForm(f => ({ ...f, info: { erro: true, txt: 'Pedido não encontrado.' } })); return }
    const itensTxt = Array.isArray(data.itens) ? data.itens.map(it => `${it.quantidade ?? it.qtd ?? 1}x ${it.nome}`).join(', ') : ''
    setImprevForm(f => ({
      ...f,
      descricao: `Pedido #${data.numero_pedido} cancelado${data.cliente_nome ? ' — ' + data.cliente_nome : ''}${itensTxt ? ' (' + itensTxt + ')' : ''}`,
      valor: String(Number(data.total || 0)).replace('.', ','),
      info: { erro: false, txt: `✓ ${data.cliente_nome || 'Cliente'} · ${brl(data.total)}${data.status === 'cancelado' ? ' · cancelado' : ' · status: ' + (data.status || '?')}` },
    }))
  }
  async function salvarImprev(e) {
    e.preventDefault()
    if (!imprevForm.descricao.trim()) { alert('Descreva o imprevisto (ex.: pedido cancelado).'); return }
    const { error } = await supabase.from('custos_imprevistos').insert({ empresa_id: empresaId, data: dia, descricao: imprevForm.descricao.trim(), valor: num(imprevForm.valor) })
    if (error) { alert('Erro: ' + error.message); return }
    setShowImprev(false); carregar()
  }
  async function excluirImprev(i) { if (!confirm(`Excluir "${i.descricao}"?`)) return; await supabase.from('custos_imprevistos').delete().eq('id', i.id); carregar() }

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  const totalHistLucro = historico.reduce((s, h) => s + Number(h.lucro || 0), 0)

  return (
    <div>
      {/* sub-abas */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {[['hoje', '📊 Dia a dia'], ['historico', '📜 Histórico de despesas diárias']].map(([id, lb]) => (
          <button key={id} type="button" onClick={() => setSub(id)}
            style={{ padding: '7px 14px', borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
              background: sub === id ? 'var(--primary)' : 'transparent', color: sub === id ? '#fff' : 'var(--text-muted)' }}>
            {lb}
          </button>
        ))}
      </div>

      {error && <div className="card error-text" style={{ marginBottom: 16 }}>{error}</div>}
      {loading && <div className="card">Carregando…</div>}

      {/* ═══════════════ HOJE ═══════════════ */}
      {!loading && sub === 'hoje' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* escolher o dia + config dias abertos */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setDia(addDia(dia, -1))} title="Dia anterior" style={navBtn}>◀</button>
              <input type="date" value={dia} max={hojeYMD}
                onChange={e => { if (e.target.value && e.target.value <= hojeYMD) setDia(e.target.value) }}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }} />
              <button type="button" onClick={() => setDia(addDia(dia, 1))} disabled={ehHoje} title="Próximo dia"
                style={{ ...navBtn, opacity: ehHoje ? .35 : 1, cursor: ehHoje ? 'default' : 'pointer' }}>▶</button>
              {!ehHoje && <button type="button" onClick={() => setDia(hojeYMD)} style={chipBtn}>Hoje</button>}
              {dia !== ontemYMD && <button type="button" onClick={() => setDia(ontemYMD)} style={chipBtn}>Ontem</button>}
              <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize', marginLeft: 2 }}>{diaSemana(dia)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
              {diasAuto != null ? (
                <span title={`Contado pelos horários da loja: ${diasQueAbre(horarios)}. Muda sozinho a cada mês.`}>
                  A loja abre <strong style={{ color: 'var(--text)' }}>{diasAuto} dias</strong> em {mesLabel(dia)} · {diasQueAbre(horarios)}
                </span>
              ) : (<>
                Dias que a loja abre no mês
                <input type="number" min="1" max="31" value={diasAbertos} onChange={e => setDiasAbertos(e.target.value)} onBlur={e => salvarDias(e.target.value)}
                  style={{ width: 58, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', textAlign: 'center' }} />
              </>)}
            </div>
          </div>

          {!abre && !fechado && (
            <div style={{ padding: '10px 14px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, background: 'rgba(245,158,11,.10)', border: '1px solid rgba(245,158,11,.4)' }}>
              🚪 <strong style={{ textTransform: 'capitalize' }}>{diaSemana(dia)}</strong> a loja não abre. Custo fixo e folha não entram nesse dia — eles já estão divididos entre os {dias} dias em que ela abre.
            </div>
          )}

          {fechado && (
            <div style={{ padding: '10px 14px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, background: 'rgba(22,163,74,.10)', border: '1px solid rgba(22,163,74,.4)' }}>
              🔒 <strong>Dia fechado.</strong> Os valores abaixo são o retrato que foi congelado quando você fechou — não mudam mais, mesmo mexendo nos custos hoje.
            </div>
          )}

          {/* LUCRO REAL DO DIA */}
          <div style={{ background: 'var(--card)', border: `2px solid ${v.lucro >= 0 ? '#16a34a' : '#ef4444'}`, borderRadius: 14, padding: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
              💰 Lucro real {rotuloDia} ({ddmm(dia)}) {fechado && <span style={{ color: '#16a34a' }}>🔒</span>}
            </div>
            <Linha label="Faturamento líquido do dia (salão + delivery + iFood)" valor={brl(v.receita)} bold />
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '-4px 0 8px 2px' }}>
              {fechado
                ? <>próprios {brl(fechado.receita_proprios)} · iFood {brl(fechado.receita_ifood)}</>
                : <>salão {brl(receitaDia.salao || 0)} · delivery {brl(receitaDia.proprios)} · iFood {brl(receitaDia.ifood)}</>}
            </div>
            <Linha label={fechado ? '− Custos fixos (rateio do dia)' : !abre ? '− Custos fixos (loja fechada nesse dia)' : `− Custos fixos (rateio do dia: ${brl(totalFixo)}/${dias})`} valor={`− ${brl(v.fixo)}`} cor="var(--danger)" />
            <Linha label={fechado ? '− Funcionários (rateio do dia)' : !abre ? '− Funcionários (loja fechada nesse dia)' : `− Funcionários (rateio do dia: ${brl(totalFunc)}/${dias})`} valor={`− ${brl(v.func)}`} cor="var(--danger)" />
            <Linha label={`− Custo de produção ${rotuloDia}`} valor={`− ${brl(v.prod)}`} cor="var(--danger)" />
            <Linha label={`− Custos imprevistos ${rotuloDia}`} valor={`− ${brl(v.imprev)}`} cor="var(--danger)" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, marginTop: 6, borderTop: '2px solid var(--border)' }}>
              <span style={{ fontSize: 16, fontWeight: 900 }}>
                {v.lucro >= 0 ? `= Foi pro seu bolso ${ehHoje ? 'hoje' : 'nesse dia'}` : `= Prejuízo ${ehHoje ? 'hoje' : 'nesse dia'}`}
              </span>
              <span style={{ fontSize: 26, fontWeight: 900, color: v.lucro >= 0 ? '#16a34a' : '#ef4444' }}>{brl(v.lucro)}</span>
            </div>
          </div>

          {/* PRODUÇÃO DO DIA (com botão fechar o dia) */}
          <Secao titulo={`🍲 Custo de produção ${rotuloDia} (${ddmm(dia)})`}
            acao={!fechado && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={abrirNovaProd} disabled={fichas.length === 0}>+ Lançar produção</button>
              <button className="btn btn-sm" onClick={fecharDia} disabled={fechando}
                style={{ background: '#16a34a', color: '#fff' }}>{fechando ? 'Salvando…' : `💾 Fechar ${ehHoje ? 'o dia' : ddmm(dia)}`}</button>
            </div>}
            rodape={(fechado ? itensFechado.length > 0 : producao.length > 0) && <>Custo de produção {rotuloDia} <strong>{brl(v.prod)}</strong></>}>
            {fechado ? (
              itensFechado.length === 0
                ? <Vazio texto="Esse dia foi fechado sem lançamento de produção." />
                : itensFechado.map((p, i) => (
                  <ItemLinha key={i} titulo={p.nome}
                    sub={`fez ${p.qtd_feita}${p.unidade} · sobrou ${p.qtd_sobrou}${p.unidade} · usou ${Number(p.qtd_feita || 0) - Number(p.qtd_sobrou || 0)}${p.unidade}`}
                    valor={brl(p.custo)} />
                ))
            ) : (<>
              {fichas.length === 0 && <Vazio texto="Crie fichas técnicas primeiro (Catálogo → Ficha Técnica) pra puxar o custo por kg." />}
              {fichas.length > 0 && producao.length === 0 && <Vazio texto={`Lance a produção ${rotuloDia} (ex.: fiz 10kg de feijão, sobrou 2kg).`} />}
              {producao.map(p => {
                const consumido = Number(p.qtd_feita || 0) - Number(p.qtd_sobrou || 0)
                return (
                  <ItemLinha key={p.id} onDel={() => excluirProd(p)}
                    titulo={p.nome}
                    sub={`fez ${p.qtd_feita}${p.unidade} · sobrou ${p.qtd_sobrou}${p.unidade} · usou ${consumido}${p.unidade}`}
                    valor={brl(custoProdItem(p))} />
                )
              })}
            </>)}
          </Secao>

          {/* CUSTOS IMPREVISTOS DO DIA */}
          <Secao titulo={`⚠️ Custos imprevistos ${rotuloDia}`}
            acao={!fechado && <button className="btn btn-primary btn-sm" onClick={abrirNovoImprev}>+ Imprevisto</button>}
            rodape={(fechado ? imprevFechado.length > 0 : imprevistos.length > 0) && <>Imprevistos {rotuloDia} <strong>{brl(v.imprev)}</strong></>}>
            {fechado ? (
              imprevFechado.length === 0
                ? <Vazio texto="Nenhum imprevisto nesse dia." />
                : imprevFechado.map((i, k) => <ItemLinha key={k} titulo={i.descricao} valor={brl(i.valor)} />)
            ) : (
              imprevistos.length === 0
                ? <Vazio texto="Ex.: pedido cancelado que estragou o produto, algo que caiu/quebrou, compra de emergência…" />
                : imprevistos.map(i => (
                  <ItemLinha key={i.id} onDel={() => excluirImprev(i)} titulo={i.descricao} valor={brl(i.valor)} />
                ))
            )}
          </Secao>

          {/* CUSTOS FIXOS */}
          <Secao titulo={ehHoje ? '💡 Custos fixos e variáveis (mensais)' : `💡 Custos fixos que existiam em ${ddmm(dia)}`}
            acao={ehHoje && <button className="btn btn-primary btn-sm" onClick={abrirNovaDespesa}>+ Novo custo</button>}
            rodape={despesas.length > 0 && <>Total <strong>{brl(totalFixo)}</strong>/mês · <strong>{brl(fixoPorDiaBase)}</strong> por dia aberto ({dias} dias)</>}>
            {despesas.length === 0 ? <Vazio texto={ehHoje ? 'Cadastre aluguel, energia, água, internet…' : `Nenhum custo cadastrado até ${ddmm(dia)}.`} />
              : despesas.map(d => {
                const val = valorNoDia(d, 'valor', dia)
                const mudou = val !== Number(d.valor || 0)
                return (
                  <ItemLinha key={d.id} onEdit={ehHoje ? () => abrirEditarDespesa(d) : undefined} onDel={ehHoje ? () => excluirDespesa(d) : undefined}
                    titulo={<>{catLabel(d.categoria)} — {d.nome}</>}
                    sub={<>{d.tipo === 'variavel' ? 'variável' : 'fixo'}{mudou && ` · valor da época (hoje é ${brl(d.valor)})`}</>}
                    valor={brl(val) + '/mês'} />
                )
              })}
          </Secao>

          {/* FUNCIONÁRIOS */}
          <Secao titulo={ehHoje ? '👥 Funcionários' : `👥 Quem estava na folha em ${ddmm(dia)}`}
            acao={ehHoje && <button className="btn btn-primary btn-sm" onClick={abrirNovoFunc}>+ Funcionário</button>}
            rodape={funcionarios.length > 0 && <>Total <strong>{brl(totalFunc)}</strong>/mês · <strong>{brl(funcPorDiaBase)}</strong> por dia aberto ({dias} dias)</>}>
            {funcionarios.length === 0 ? <Vazio texto={ehHoje ? 'Cadastre cada funcionário com o salário.' : `Ninguém cadastrado na folha até ${ddmm(dia)}.`} />
              : funcionarios.map(f => {
                const sal = valorNoDia(f, 'salario_mensal', dia)
                const mudou = sal !== Number(f.salario_mensal || 0)
                return (
                  <ItemLinha key={f.id} onEdit={ehHoje ? () => abrirEditarFunc(f) : undefined} onDel={ehHoje ? () => excluirFunc(f) : undefined}
                    titulo={f.nome}
                    sub={<>{f.cargo || 'sem cargo'}{mudou && ` · salário da época (hoje é ${brl(f.salario_mensal)})`}</>}
                    valor={brl(sal) + '/mês'} />
                )
              })}
          </Secao>

          {/* CONSUMO DE FUNCIONÁRIOS (alimentação) — relatório à parte, não entra no lucro */}
          <ConsumoFuncionario empresaId={empresaId} />
        </div>
      )}

      {/* ═══════════════ HISTÓRICO ═══════════════ */}
      {!loading && sub === 'historico' && (
        <div>
          {historico.length === 0 ? (
            <div className="card empty-state"><strong>Nenhum dia fechado ainda</strong>
              <p>Feche um dia na aba "Dia a dia" pra ele aparecer aqui congelado. Sem fechar, você ainda consegue olhar qualquer dia por lá — só que o valor é recalculado na hora.</p></div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <strong style={{ fontSize: 15 }}>📜 Histórico de despesas diárias</strong>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Lucro acumulado <strong style={{ color: totalHistLucro >= 0 ? '#16a34a' : '#ef4444' }}>{brl(totalHistLucro)}</strong></span>
              </div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 16px' }}>
                {historico.map(h => {
                  const aberto = !!histAberto[h.id]
                  const custosTot = Number(h.custo_fixo) + Number(h.custo_funcionarios) + Number(h.custo_producao)
                  return (
                  <div key={h.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {/* cabeçalho clicável (setinha) */}
                      <div onClick={() => setHistAberto(m => ({ ...m, [h.id]: !m[h.id] }))} style={{ flex: 1, cursor: 'pointer', userSelect: 'none' }}>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>
                          <span style={{ display: 'inline-block', width: 15, color: 'var(--text-muted)', transform: aberto ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                          {ddmm(h.data)}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 15 }}>
                          receita {brl(h.receita_liquida)} · custos {brl(custosTot)} · toque pra ver a tabela
                        </div>
                      </div>
                      <strong style={{ fontSize: 16, color: Number(h.lucro) >= 0 ? '#16a34a' : '#ef4444', whiteSpace: 'nowrap' }}>{brl(h.lucro)}</strong>
                      <button className="btn btn-danger btn-sm" onClick={() => excluirHistorico(h)}>✕</button>
                    </div>

                    {/* tabela completa (abre na setinha) — igual ao card do dia */}
                    {aberto && (
                      <div style={{ marginTop: 8, marginLeft: 15, paddingTop: 6, borderTop: '1px dashed var(--border)' }}>
                        <Linha label="Faturamento líquido (salão + delivery + iFood)" valor={brl(h.receita_liquida)} bold />
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '-4px 0 8px 2px' }}>
                          salão+delivery {brl(h.receita_proprios)} · iFood {brl(h.receita_ifood)}
                        </div>
                        <Linha label="− Custos fixos (rateio do dia)" valor={`− ${brl(h.custo_fixo)}`} cor="var(--danger)" />
                        <Linha label="− Funcionários (rateio do dia)" valor={`− ${brl(h.custo_funcionarios)}`} cor="var(--danger)" />
                        <Linha label="− Custo de produção do dia" valor={`− ${brl(h.custo_producao)}`} cor="var(--danger)" />
                        {Array.isArray(h.itens) && h.itens.length > 0 && (
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 6px 12px' }}>
                            {h.itens.map((it, i) => (
                              <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span>▸ {it.nome} <span style={{ opacity: .8 }}>(fez {it.qtd_feita}{it.unidade} · sobrou {it.qtd_sobrou}{it.unidade})</span></span>
                                <span>{brl(it.custo)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <Linha label="− Custos imprevistos do dia" valor={`− ${brl(h.custo_imprevisto)}`} cor="var(--danger)" />
                        {Array.isArray(h.imprevistos) && h.imprevistos.length > 0 && (
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 6px 12px' }}>
                            {h.imprevistos.map((it, i) => (
                              <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span>▸ {it.descricao}</span><span>{brl(it.valor)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, marginTop: 4, borderTop: '2px solid var(--border)' }}>
                          <span style={{ fontSize: 14.5, fontWeight: 900 }}>{Number(h.lucro) >= 0 ? '= Foi pro seu bolso' : '= Prejuízo'}</span>
                          <span style={{ fontSize: 18, fontWeight: 900, color: Number(h.lucro) >= 0 ? '#16a34a' : '#ef4444' }}>{brl(h.lucro)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── MODAL: despesa ─── */}
      {showDespesa && (
        <Modal onClose={() => setShowDespesa(false)} onSubmit={salvarDespesa} titulo={despesaEdit ? 'Editar custo' : 'Novo custo'}>
          <div className="form-grid">
            <div className="form-field full"><label>Nome</label>
              <input autoFocus placeholder="Ex.: Conta de luz" value={despesaForm.nome} onChange={e => setDespesaForm(f => ({ ...f, nome: e.target.value }))} /></div>
            <div className="form-field"><label>Categoria</label>
              <select value={despesaForm.categoria} onChange={e => setDespesaForm(f => ({ ...f, categoria: e.target.value }))}>
                {CATEGORIAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></div>
            <div className="form-field"><label>Tipo</label>
              <select value={despesaForm.tipo} onChange={e => setDespesaForm(f => ({ ...f, tipo: e.target.value }))}>
                <option value="fixo">Fixo (todo mês igual)</option>
                <option value="variavel">Variável (muda todo mês)</option>
              </select></div>
            <div className="form-field full"><label>Valor por mês (R$)</label>
              <input inputMode="decimal" placeholder="Ex.: 350,00" value={despesaForm.valor} onChange={e => setDespesaForm(f => ({ ...f, valor: e.target.value }))} /></div>
          </div>
        </Modal>
      )}

      {/* ─── MODAL: funcionário ─── */}
      {showFunc && (
        <Modal onClose={() => setShowFunc(false)} onSubmit={salvarFunc} titulo={funcEdit ? 'Editar funcionário' : 'Novo funcionário'}>
          <div className="form-grid">
            {!funcEdit && usuariosDisponiveis.length > 0 && (
              <div className="form-field full">
                <label>Puxar de quem já é cadastrado (opcional)</label>
                <select defaultValue="" onChange={e => { puxarUsuario(e.target.value); e.target.value = '' }}>
                  <option value="">— escolher funcionário cadastrado —</option>
                  {usuariosDisponiveis.map(u => <option key={u.id} value={u.id}>{u.nome} ({u.cargo || PERFIL_LABEL[u.perfil] || 'funcionário'})</option>)}
                </select>
              </div>
            )}
            <div className="form-field full"><label>Nome</label>
              <input autoFocus placeholder="Ex.: Maria" value={funcForm.nome} onChange={e => setFuncForm(f => ({ ...f, nome: e.target.value }))} /></div>
            <div className="form-field"><label>Cargo (opcional)</label>
              <input placeholder="Ex.: Cozinheira" value={funcForm.cargo} onChange={e => setFuncForm(f => ({ ...f, cargo: e.target.value }))} /></div>
            <div className="form-field"><label>Salário por mês (R$)</label>
              <input inputMode="decimal" placeholder="Ex.: 1500,00" value={funcForm.salario_mensal} onChange={e => setFuncForm(f => ({ ...f, salario_mensal: e.target.value }))} /></div>
          </div>
        </Modal>
      )}

      {/* ─── MODAL: produção do dia ─── */}
      {showProd && (
        <Modal onClose={() => setShowProd(false)} onSubmit={salvarProd} titulo="Lançar produção de hoje" submitLabel="Salvar lançamento">
          <div className="form-grid">
            <div className="form-field full"><label>Produto (ficha técnica)</label>
              <select value={prodForm.ficha_id} onChange={e => setProdForm(f => ({ ...f, ficha_id: e.target.value }))}>
                <option value="">— escolher —</option>
                {fichas.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </select></div>
            <div className="form-field"><label>Quanto fez</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input inputMode="decimal" placeholder="Ex.: 10" value={prodForm.qtd_feita} onChange={e => setProdForm(f => ({ ...f, qtd_feita: e.target.value }))} style={{ flex: 1 }} />
                <select value={prodForm.unidade} onChange={e => setProdForm(f => ({ ...f, unidade: e.target.value }))} style={{ width: 70 }}>
                  {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div></div>
            <div className="form-field"><label>Quanto sobrou</label>
              <input inputMode="decimal" placeholder="Ex.: 2" value={prodForm.qtd_sobrou} onChange={e => setProdForm(f => ({ ...f, qtd_sobrou: e.target.value }))} /></div>
          </div>
          <div className="card" style={{ marginTop: 16, background: 'var(--bg)' }}>
            {fichaSel ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13 }}>Usou {Math.max(0, num(prodForm.qtd_feita) - num(prodForm.qtd_sobrou))}{prodForm.unidade} · custo do dia</span>
                <strong style={{ fontSize: 20, color: 'var(--primary)' }}>{brl(prodPrevia)}</strong>
              </div>
            ) : <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Escolha o produto pra ver o custo do dia.</span>}
          </div>
        </Modal>
      )}

      {/* ─── MODAL: custo imprevisto ─── */}
      {showImprev && (
        <Modal onClose={() => setShowImprev(false)} onSubmit={salvarImprev} titulo="Novo custo imprevisto">
          {/* modo: pedido cancelado x outro gasto */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {[['pedido', '🧾 Pedido cancelado'], ['outro', '✍️ Outro gasto']].map(([id, lb]) => (
              <button key={id} type="button" onClick={() => setImprevForm(f => ({ ...f, tipo: id, info: null }))}
                style={{ flex: 1, padding: '9px 8px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  background: imprevForm.tipo === id ? 'var(--primary)' : 'transparent', color: imprevForm.tipo === id ? '#fff' : 'var(--text)' }}>
                {lb}
              </button>
            ))}
          </div>

          {imprevForm.tipo === 'pedido' && (
            <div className="form-field full" style={{ marginBottom: 12 }}>
              <label>Número do pedido</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input autoFocus inputMode="numeric" placeholder="Ex.: 1234" value={imprevForm.numero}
                  onChange={e => setImprevForm(f => ({ ...f, numero: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); buscarPedido() } }} style={{ flex: 1 }} />
                <button type="button" className="btn btn-secondary" onClick={buscarPedido} disabled={buscandoPed}>{buscandoPed ? 'Buscando…' : 'Buscar'}</button>
              </div>
              {imprevForm.info && (
                <div style={{ fontSize: 12, marginTop: 6, color: imprevForm.info.erro ? 'var(--danger)' : 'var(--success)' }}>{imprevForm.info.txt}</div>
              )}
            </div>
          )}

          <div className="form-grid">
            <div className="form-field full"><label>{imprevForm.tipo === 'pedido' ? 'Descrição (veio do pedido — pode editar)' : 'O que aconteceu?'}</label>
              <input placeholder={imprevForm.tipo === 'pedido' ? 'Busque o pedido acima…' : 'Ex.: Copo quebrou, compra de gás de emergência…'}
                value={imprevForm.descricao} onChange={e => setImprevForm(f => ({ ...f, descricao: e.target.value }))} /></div>
            <div className="form-field full"><label>Valor perdido/gasto (R$)</label>
              <input inputMode="decimal" placeholder="Ex.: 25,00" value={imprevForm.valor} onChange={e => setImprevForm(f => ({ ...f, valor: e.target.value }))} /></div>
          </div>
          {imprevForm.tipo === 'pedido' && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
              💡 Veio o valor de venda do pedido. Se só o custo do produto foi perdido, ajuste o valor pra baixo.
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

// ── componentes auxiliares ────────────────────────────────────────────
const navBtn = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)', cursor: 'pointer', fontSize: 12, lineHeight: 1 }
const chipBtn = { padding: '6px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }

function Linha({ label, valor, cor, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
      <span style={{ fontSize: 13.5, color: cor || 'var(--text)', fontWeight: bold ? 700 : 400 }}>{label}</span>
      <strong style={{ fontSize: 14.5, color: cor || 'var(--text)' }}>{valor}</strong>
    </div>
  )
}
function Secao({ titulo, acao, rodape, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>{titulo}</strong>
        {acao}
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 16px' }}>
        {children}
      </div>
      {rodape && <div style={{ textAlign: 'right', fontSize: 13, color: 'var(--text-muted)', marginTop: 8, paddingRight: 4 }}>{rodape}</div>}
    </div>
  )
}
function ItemLinha({ titulo, sub, valor, onEdit, onDel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{titulo}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{sub}</div>}
      </div>
      <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{valor}</strong>
      <div style={{ display: 'flex', gap: 6 }}>
        {onEdit && <button className="btn btn-secondary btn-sm" onClick={onEdit}>Editar</button>}
        {onDel && <button className="btn btn-danger btn-sm" onClick={onDel}>✕</button>}
      </div>
    </div>
  )
}
function Vazio({ texto }) {
  return <div style={{ padding: '18px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{texto}</div>
}
function Modal({ titulo, onClose, onSubmit, submitLabel = 'Salvar', children }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal" onSubmit={onSubmit}>
        <h2>{titulo}</h2>
        {children}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary">{submitLabel}</button>
        </div>
      </form>
    </div>
  )
}
