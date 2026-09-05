import { useEffect, useMemo, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { calcIfoodLiquido, FORMA_ENTREGA_LABEL } from '../lib/ifoodLiquido'
import IfoodIcon from '../components/IfoodIcon'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const fmt = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const normForma = (f) => !f ? 'Outros' : f.startsWith('boleto') ? 'Boleto' : f === 'a_vista' ? 'À vista' : f === 'fiado' ? 'Fiado' : f
const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['mes', 'Mês'], ['custom', 'Personalizado']]

// Rótulo + ícone de cada forma de pagamento, pro detalhe que abre ao clicar no canal.
// 'online' = pago pelo próprio site (Pix ou cartão via Mercado Pago), o dinheiro
// não passa pela mão de ninguém na loja.
const FORMA_INFO = {
  dinheiro: { icon: '💵', label: 'Dinheiro' },
  cartao:   { icon: '💳', label: 'Cartão (maquineta)' },
  credito:  { icon: '💳', label: 'Cartão de crédito' },
  debito:   { icon: '💳', label: 'Cartão de débito' },
  pix:      { icon: '📱', label: 'Pix' },
  pix_entrega: { icon: '📱', label: 'Pix na entrega' },
  online:   { icon: '🌐', label: 'Pago online' },
  vale:     { icon: '🎟️', label: 'Vale' },
  a_vista:  { icon: '💰', label: 'À vista' },
  fiado:    { icon: '📒', label: 'Fiado' },
  outro:    { icon: '•',  label: 'Outro' },
}
const infoForma = (f) => FORMA_INFO[f] || { icon: '•', label: normForma(f) }

function rangeFor(periodo, custIni, custFim) {
  const now = new Date()
  const start = new Date(now)
  let prevStart, prevEnd
  if (periodo === 'custom') {
    const s = new Date(custIni + 'T00:00:00')
    const e = new Date((custFim || custIni) + 'T00:00:00'); e.setDate(e.getDate() + 1) // fim exclusivo
    const len = e - s
    return { start: s, now: e, prevStart: new Date(s.getTime() - len), prevEnd: new Date(s) }
  }
  if (periodo === 'hoje') {
    start.setHours(0, 0, 0, 0); prevEnd = new Date(start)
    prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 1)
  } else if (periodo === '7d') {
    start.setDate(start.getDate() - 7); prevEnd = new Date(start)
    prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 7)
  } else if (periodo === '30d') {
    start.setDate(start.getDate() - 30); prevEnd = new Date(start)
    prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 30)
  } else {
    start.setTime(new Date(now.getFullYear(), now.getMonth(), 1).getTime())
    prevEnd = new Date(start); prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  }
  return { start, now, prevStart, prevEnd }
}

// ── Gráficos ─────────────────────────────────────────────────────────────────
function AreaChart({ data }) {
  const W = 640, H = 160, P = 10
  const max = Math.max(1, ...data.map(d => d.value))
  const stepX = (W - P * 2) / Math.max(1, data.length - 1)
  const pts = data.map((d, i) => [P + i * stepX, H - P - (d.value / max) * (H - P * 2 - 12)])
  const line = pts.map((c, i) => (i ? 'L' : 'M') + c[0].toFixed(1) + ' ' + c[1].toFixed(1)).join(' ')
  const area = `${line} L ${pts.at(-1)[0].toFixed(1)} ${H - P} L ${pts[0][0].toFixed(1)} ${H - P} Z`
  const last = pts.at(-1)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} preserveAspectRatio="none">
      <defs><linearGradient id="dArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.45" /><stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
      </linearGradient></defs>
      <path d={area} fill="url(#dArea)" />
      <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="4.5" fill="var(--primary)" stroke="#fff" strokeWidth="2" />
    </svg>
  )
}
function BarsV({ data }) {
  const max = Math.max(1, ...data.map(d => d.value))
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 110 }}>
      {data.map((d, i) => (
        <div key={i} title={`${d.label}h: ${fmt(d.value)}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}>
          <div style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 3 : 0, background: 'var(--primary)', borderRadius: 3, opacity: d.value > 0 ? 1 : .25 }} />
        </div>
      ))}
    </div>
  )
}
function BarsH({ data, money = true, cor = 'var(--primary)' }) {
  const max = Math.max(1, ...data.map(d => d.value))
  if (!data.length) return <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sem dados no período.</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {data.map((d, i) => (
        <div key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '62%' }}>{d.label}</span>
            <strong>{money ? fmt(d.value) : d.value}</strong>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(d.value / max) * 100}%`, background: cor, borderRadius: 999, transition: 'width 400ms' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
function Delta({ atual, anterior }) {
  if (anterior <= 0) return atual > 0 ? <span style={{ fontSize: 12, fontWeight: 700, color: '#16a34a', marginLeft: 8 }}>novo</span> : null
  const pct = Math.round(((atual - anterior) / anterior) * 100)
  return <span style={{ fontSize: 12, fontWeight: 700, color: pct >= 0 ? '#16a34a' : '#ef4444', marginLeft: 8 }}>{pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}%</span>
}

const cardBox = { background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)', borderRadius: 14, padding: 18 }

// Nomes que não são pessoa e por isso ficam fora do ranking de clientes.
const GENERICOS = ['consumidor (mesa)', 'consumidor', 'cliente']

// Medalha do ranking: ouro/prata/bronze no pódio, cinza no resto.
const MEDALHA = ['#d4a017', '#9aa3ad', '#c1743a']
const posicao = (i) => ({
  width: 22, height: 22, borderRadius: 999, flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11.5, fontWeight: 800,
  background: i < 3 ? MEDALHA[i] : 'var(--border)',
  color: i < 3 ? '#fff' : 'var(--text-muted)',
})

export default function Dashboard() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  const [periodo, setPeriodo] = useState('hoje')
  const [custIni, setCustIni] = useState(ymd(new Date()))
  const [custFim, setCustFim] = useState(ymd(new Date()))
  const [vendas, setVendas] = useState([])
  const [pedidos, setPedidos] = useState([])
  const [itens, setItens] = useState([])
  const [nomes, setNomes] = useState({})
  const [clientesNovos, setClientesNovos] = useState([])
  const [funil, setFunil] = useState([])
  // sessao -> { nome, telefone, cep } de quem chegou no cadastro
  const [funilContato, setFunilContato] = useState({})
  const [verParados, setVerParados] = useState(false)   // etapas da Loja Online (mig 0216)
  const [verTop30, setVerTop30] = useState(false)       // popup com o ranking maior de produtos
  const [op, setOp] = useState({ clientesAtivos: 0, estoqueBaixo: 0, cascosPendentes: 0, fiado: 0 })
  const [meta, setMeta] = useState(0)
  const [ifoodRates, setIfoodRates] = useState({})
  const [usaEstoque, setUsaEstoque] = useState(true) // loja pode desligar em Estoque
  const [usaCasco, setUsaCasco] = useState(false)    // só distribuidora de bebida usa
  const [entExp, setEntExp] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refToken, setRefToken] = useState(null)
  const [copiado, setCopiado] = useState(false)
  const [enviandoResumo, setEnviandoResumo] = useState(false)
  const [resumoMsg, setResumoMsg] = useState(null)
  const timerRef = useRef(null)

  async function enviarResumo() {
    setEnviandoResumo(true); setResumoMsg(null)
    // forcar: o envio automático das 22h pula dia sem venda, mas quem clicou no
    // botão quer receber de qualquer jeito.
    const { data, error } = await supabase.functions.invoke('resumo-diario', { body: { empresa_id: empresaId, forcar: true } })
    setEnviandoResumo(false)
    if (error || !data?.ok) { setResumoMsg({ tipo: 'erro', txt: 'Erro ao enviar: ' + (error?.message ?? data?.error ?? 'falhou') }); return }
    if (data.enviadas > 0) { setResumoMsg({ tipo: 'ok', txt: 'Resumo enviado no seu WhatsApp! 📲' }); return }
    setResumoMsg({
      tipo: data.erro ? 'erro' : 'aviso',
      txt: data.erro ?? 'Não enviou — confira o telefone de contato da loja em Minha Loja.',
    })
  }
  async function enviarAlerta() {
    setEnviandoResumo(true); setResumoMsg(null)
    const { data, error } = await supabase.functions.invoke('alertas-loja', { body: { empresa_id: empresaId } })
    setEnviandoResumo(false)
    if (error || !data?.ok) { setResumoMsg({ tipo: 'erro', txt: 'Erro ao enviar: ' + (error?.message ?? data?.error ?? 'falhou') }); return }
    setResumoMsg(data.enviadas > 0
      ? { tipo: 'ok', txt: 'Alerta de estoque enviado no WhatsApp! 📦' }
      : { tipo: 'aviso', txt: 'Sem itens abaixo do mínimo (ou telefone de contato não configurado).' })
  }

  useEffect(() => {
    async function load() {
      setLoading(true)
      const desde = new Date(); desde.setHours(0, 0, 0, 0); desde.setDate(desde.getDate() - 62)
      const custDate = new Date(custIni + 'T00:00:00')   // se o filtro custom for mais antigo, busca desde lá
      if (custDate < desde) desde.setTime(custDate.getTime())
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: pf } = await supabase.from('profiles').select('ref_token').eq('id', user.id).single()
        if (pf?.ref_token) setRefToken(pf.ref_token)
      }
      const desdeISO = desde.toISOString()
      const [vData, pData, iData, cnData, nRes, caRes, saRes, csRes, fiRes, empRes, fnData, fcData] = await Promise.all([
        fetchAll(() => supabase.from('vendas').select('total, created_at, forma_pagamento, observacoes, cliente_id, clientes(nome)').neq('status', 'cancelado').gte('created_at', desdeISO).order('created_at', { ascending: false })).then(r => r.data),
        fetchAll(() => supabase.from('pedidos_delivery').select('total, created_at, origem, status, itens, subtotal, taxa_entrega, ifood_valores, forma_pagamento, cliente_id, cliente_nome, cliente_telefone').gte('created_at', desdeISO).order('created_at', { ascending: false })).then(r => r.data),
        fetchAll(() => supabase.from('venda_itens').select('produto_id, nome_produto, quantidade, subtotal, vendas!inner(created_at, status)').neq('vendas.status', 'cancelado').gte('vendas.created_at', desdeISO).order('id', { ascending: false })).then(r => r.data),
        fetchAll(() => supabase.from('clientes').select('created_at').gte('created_at', desdeISO).order('created_at', { ascending: false })).then(r => r.data),
        supabase.from('produtos').select('id, nome, controla_casco'),
        supabase.from('clientes').select('id', { count: 'exact', head: true }).eq('ativo', true),
        supabase.from('estoque_saldo').select('*'),
        supabase.from('casco_saldo').select('*'),
        supabase.from('clientes_saldo_fiado').select('saldo_fiado'),
        empresaId ? supabase.from('empresas').select('meta_faturamento_mensal, ifood_comissao_pct, ifood_transacao_pct, estoque_ativo, ifood_entrega_propria').eq('id', empresaId).single() : Promise.resolve({ data: null }),
        fetchAll(() => supabase.from('loja_funil').select('etapa, sessao, created_at, valor').gte('created_at', desdeISO).order('created_at', { ascending: false })).then(r => r.data),
        // Nome/telefone/CEP de quem chegou no cadastro (mig 0218) — é o que
        // permite ligar de volta pra quem travou na hora do endereço.
        fetchAll(() => supabase.from('loja_funil_contato').select('sessao, nome, telefone, cep, taxa').gte('created_at', desdeISO)).then(r => r.data),
      ])
      setVendas(vData ?? [])
      setPedidos(pData ?? [])
      setItens(iData ?? [])
      setNomes(Object.fromEntries((nRes.data ?? []).map(p => [p.id, p.nome])))
      setClientesNovos(cnData ?? [])
      setFunil(fnData ?? [])
      setFunilContato(Object.fromEntries((fcData ?? []).map(c => [c.sessao, c])))
      setOp({
        clientesAtivos: caRes.count ?? 0,
        // Sem mínimo definido não é "baixo" — senão a loja que nunca mexeu no
        // estoque via TODOS os produtos como alerta.
        estoqueBaixo: (saRes.data ?? []).filter(s => Number(s.estoque_minimo) > 0 && Number(s.quantidade_atual) <= Number(s.estoque_minimo)).length,
        cascosPendentes: (csRes.data ?? []).filter(c => Number(c.saldo_cascos) > 0).length,
        fiado: (fiRes.data ?? []).reduce((s, f) => s + Number(f.saldo_fiado), 0),
      })
      setMeta(Number(empRes.data?.meta_faturamento_mensal ?? 0))
      setIfoodRates({ comissao: empRes.data?.ifood_comissao_pct, transacao: empRes.data?.ifood_transacao_pct, entregaPropria: empRes.data?.ifood_entrega_propria !== false })
      setUsaEstoque(empRes.data?.estoque_ativo ?? true)
      setUsaCasco((nRes.data ?? []).some(p => p.controla_casco) || (csRes.data ?? []).some(c => Number(c.saldo_cascos) > 0))
      setLoading(false)
    }
    if (empresaId !== undefined) load()
  }, [empresaId, custIni])

  // Funil da Loja Online: quantas VISITAS chegaram em cada degrau no período.
  // Conta sessão distinta, não linha — quem voltou pra sacola três vezes é um
  // cliente só, e o relatório existe justamente pra contar gente.
  const fn = useMemo(() => {
    const { start, now } = rangeFor(periodo, custIni, custFim)
    const porEtapa = { abriu: new Set(), sacola: new Set(), endereco: new Set(), pedido: new Set() }
    for (const e of funil) {
      const t = new Date(e.created_at)
      if (t < start || t >= now) continue
      porEtapa[e.etapa]?.add(e.sessao)
    }
    // Quem chegou no endereço e NÃO fechou — com o que ele já tinha digitado.
    // É a lista que responde "são cinco pessoas ou uma tentando cinco vezes?".
    const parados = []
    for (const e of funil) {
      if (e.etapa !== 'endereco') continue
      const t = new Date(e.created_at)
      if (t < start || t >= now) continue
      if (porEtapa.pedido.has(e.sessao)) continue   // esse fechou, não parou
      const c = funilContato[e.sessao] ?? {}
      parados.push({
        sessao: e.sessao, quando: t, valor: e.valor,
        nome: c.nome ?? null, telefone: c.telefone ?? null, cep: c.cep ?? null,
        taxa: c.taxa == null ? null : Number(c.taxa),
      })
    }
    parados.sort((a, b) => b.quando - a.quando)

    const abriu = porEtapa.abriu.size
    const sacola = porEtapa.sacola.size
    const endereco = porEtapa.endereco.size
    const pedido = porEtapa.pedido.size
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)
    return {
      abriu, sacola, endereco, pedido,
      temDados: abriu + sacola + endereco + pedido > 0,
      // Onde cada um perdeu gente. É esta coluna que diz o que consertar.
      perdeuNaVitrine: abriu - sacola,
      perdeuNaSacola: sacola - endereco,
      perdeuNoCadastro: endereco - pedido,
      pctSacola: pct(sacola, abriu),
      pctEndereco: pct(endereco, sacola),
      pctPedido: pct(pedido, endereco),
      pctGeral: pct(pedido, abriu),
      parados,
    }
  }, [funil, funilContato, periodo, custIni, custFim])

  const m = useMemo(() => {
    const { start, now, prevStart, prevEnd } = rangeFor(periodo, custIni, custFim)
    const inRange = (ts, a, b) => { const t = new Date(ts); return t >= a && t < b }
    const validPed = p => !['cancelado', 'aguardando_pagamento'].includes(p.status)

    // eventos de venda no período (vendas + delivery)
    let fat = 0, n = 0, fatPrev = 0
    const canal = { ifood: 0, app: 0, wpp: 0, presencial: 0 }
    // Mesmo recorte do canal, mas quebrado por forma de pagamento — é o que
    // aparece quando você clica no card do canal.
    const formas = { ifood: {}, app: {}, wpp: {}, presencial: {} }
    const addForma = (ch, f, val) => {
      const k = f || 'outro'
      formas[ch][k] = (formas[ch][k] || 0) + val
    }
    const horas = Array.from({ length: 24 }, (_, h) => ({ label: h, value: 0 }))
    const ehHoje = periodo === 'hoje'
    const umDia = (now - start) <= 26 * 3600 * 1000            // período de 1 dia → gráfico por hora
    const porHora = ehHoje || (periodo === 'custom' && umDia)
    const buckets = []; const bIdx = {}
    if (porHora) for (let h = 0; h < 24; h++) { bIdx['h' + h] = buckets.length; buckets.push({ label: pad(h) + 'h', value: 0 }) }
    else {
      const d0 = new Date(start); d0.setHours(0, 0, 0, 0)
      for (let d = new Date(d0); d <= now; d.setDate(d.getDate() + 1)) {
        const k = new Date(d).toDateString(); bIdx[k] = buckets.length
        buckets.push({ label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, value: 0 })
      }
    }
    const addBucket = (ts, val) => {
      const dt = new Date(ts)
      const key = porHora ? 'h' + dt.getHours() : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).toDateString()
      if (bIdx[key] != null) buckets[bIdx[key]].value += val
      horas[dt.getHours()].value += val
    }
    for (const v of vendas) {
      const val = Number(v.total)
      if (inRange(v.created_at, start, now) || (ehHoje && new Date(v.created_at) >= start)) {
        if (new Date(v.created_at) >= start) {
          fat += val; n++; addBucket(v.created_at, val)
          if ((v.observacoes || '').startsWith('Presencial')) { canal.presencial += val; addForma('presencial', v.forma_pagamento, val) }
        }
      }
      if (inRange(v.created_at, prevStart, prevEnd)) fatPrev += val
    }
    const ifoodPeds = []
    for (const p of pedidos) {
      if (!validPed(p)) continue
      const val = Number(p.total)
      if (new Date(p.created_at) >= start && new Date(p.created_at) < now) {
        fat += val; n++; addBucket(p.created_at, val)
        if (p.origem === 'ifood') { canal.ifood += val; ifoodPeds.push(p); addForma('ifood', p.forma_pagamento, val) }
        else if (p.origem === 'app') { canal.app += val; addForma('app', p.forma_pagamento, val) }
        else if (p.origem === 'whatsapp' || p.origem === 'cardapio') { canal.wpp += val; addForma('wpp', p.forma_pagamento, val) }
      }
      if (inRange(p.created_at, prevStart, prevEnd)) fatPrev += val
    }
    const ifoodLiq = calcIfoodLiquido(ifoodPeds, ifoodRates)

    // top produtos (vendas + delivery), por nome
    // Valor E quantidade: no card cabem seis barras de R$, mas na lista maior
    // "saíram 148 unidades" diz do giro o que o faturamento sozinho não diz.
    const agg = {}
    const somar = (nm, valor, qtd) => {
      const l = (agg[nm] ??= { valor: 0, qtd: 0 })
      l.valor += Number(valor) || 0
      l.qtd += Number(qtd) || 0
    }
    for (const it of itens) {
      if (new Date(it.vendas.created_at) < start) continue
      // Produto excluído sai do mapa de nomes, mas a venda guardou o nome dele.
      const nm = nomes[it.produto_id] ?? it.nome_produto ?? 'Produto'
      somar(nm, it.subtotal, it.quantidade)
    }
    for (const p of pedidos) {
      if (!validPed(p) || new Date(p.created_at) < start || new Date(p.created_at) >= now) continue
      for (const it of (Array.isArray(p.itens) ? p.itens : [])) {
        const nm = it.nome ?? 'Item'
        somar(nm, it.subtotal ?? (it.preco_unitario || 0) * (it.quantidade || 1), it.quantidade ?? 1)
      }
    }
    const ordenados = Object.entries(agg)
      .map(([label, v]) => ({ label, value: v.valor, qtd: v.qtd }))
      .sort((a, b) => b.value - a.value)
    const top = ordenados.slice(0, 6)
    // O popup para no 30. Numa loja de 4 mil produtos, desenhar a lista inteira
    // trava a tela — e ninguém decide nada olhando o 800º lugar.
    const top30 = ordenados.slice(0, 30)
    const nProdutos = ordenados.length

    // ranking de clientes (balcão + delivery). Venda sem cliente identificado fica
    // de fora — senão "Consumidor" ganha de todo mundo e o ranking não serve pra nada.
    // "Consumidor (Mesa)" é cliente cadastrado de verdade (o genérico que o salão
    // usa pra fechar mesa), então precisa ser barrado pelo nome, igual ClientePicker.
    const cli = {}
    const addCli = (chave, nome, val, ts) => {
      if (!chave || GENERICOS.includes((nome || '').trim().toLowerCase())) return
      const c = cli[chave] || (cli[chave] = { nome: nome || 'Cliente', total: 0, compras: 0, ultima: null })
      if (nome && c.nome === 'Cliente') c.nome = nome
      c.total += val; c.compras++
      const t = new Date(ts)
      if (!c.ultima || t > c.ultima) c.ultima = t
    }
    for (const v of vendas) {
      if (new Date(v.created_at) < start || new Date(v.created_at) >= now) continue
      addCli(v.cliente_id, v.clientes?.nome, Number(v.total), v.created_at)
    }
    for (const p of pedidos) {
      if (!validPed(p) || new Date(p.created_at) < start || new Date(p.created_at) >= now) continue
      // delivery sem cadastro ainda dá pra agrupar pelo telefone
      addCli(p.cliente_id || (p.cliente_telefone ? 'tel:' + p.cliente_telefone : null), p.cliente_nome, Number(p.total), p.created_at)
    }
    const todosCli = Object.values(cli)
    const rank = todosCli.sort((a, b) => b.total - a.total).slice(0, 8)
    const rankQtd = todosCli.length
    const rankFat = todosCli.reduce((s, c) => s + c.total, 0)

    const novos = clientesNovos.filter(c => new Date(c.created_at) >= start).length
    const ticket = n > 0 ? fat / n : 0

    // faturamento do mês p/ meta
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1)
    let fatMes = 0
    for (const v of vendas) if (new Date(v.created_at) >= mStart) fatMes += Number(v.total)
    for (const p of pedidos) if (validPed(p) && new Date(p.created_at) >= mStart) fatMes += Number(p.total)

    return { fat, fatPrev, n, ticket, canal, formas, buckets, horas, top, top30, nProdutos, novos, fatMes, ifoodLiq, porHora, rank, rankQtd, rankFat }
  }, [periodo, custIni, custFim, vendas, pedidos, itens, nomes, clientesNovos, ifoodRates])

  async function salvarMeta(v) {
    const x = Math.max(0, Number(v) || 0); setMeta(x)
    if (empresaId) await supabase.from('empresas').update({ meta_faturamento_mensal: x }).eq('id', empresaId)
  }
  const metaPct = meta > 0 ? Math.min(100, Math.round((m.fatMes / meta) * 100)) : 0
  // Qual card de canal está aberto mostrando a quebra por forma de pagamento.
  const [canalAberto, setCanalAberto] = useState(null)
  const canais = [
    { key: 'app', icon: '📱', nome: 'App', value: m.canal.app },
    { key: 'wpp', icon: '💬', nome: 'WhatsApp + Loja Online', value: m.canal.wpp },
    { key: 'presencial', icon: '🍽️', nome: 'Presencial', value: m.canal.presencial },
  ]

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h1>Dashboard</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {periodo === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              <input type="date" value={custIni} max={custFim || ymd(new Date())}
                onChange={e => { setCustIni(e.target.value); if (e.target.value > custFim) setCustFim(e.target.value) }}
                style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
              <span>até</span>
              <input type="date" value={custFim} min={custIni} max={ymd(new Date())}
                onChange={e => setCustFim(e.target.value)}
                style={{ padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)', borderRadius: 999, padding: 4 }}>
            {PERIODOS.map(([id, lb]) => (
              <button key={id} type="button" onClick={() => setPeriodo(id)}
                style={{ padding: '6px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  background: periodo === id ? 'var(--primary)' : 'transparent', color: periodo === id ? '#fff' : 'var(--text-muted)' }}>
                {lb}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? <p style={{ color: 'var(--text-muted)' }}>Carregando…</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* KPIs principais */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
            <div style={cardBox}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: .5 }}>Faturamento</div>
              <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{fmt(m.fat)}<Delta atual={m.fat} anterior={m.fatPrev} /></div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>vs período anterior</div>
            </div>
            <div style={cardBox}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: .5 }}>Nº de vendas</div>
              <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{m.n}</div>
            </div>
            <div style={cardBox}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: .5 }}>Ticket médio</div>
              <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{fmt(m.ticket)}</div>
            </div>
            <div style={cardBox}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: .5 }}>Clientes novos</div>
              <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4 }}>{m.novos}</div>
            </div>
          </div>

          {/* Vendas por canal */}
          <div>
            <strong style={{ fontSize: 15, display: 'block', marginBottom: 10 }}>Vendas por canal</strong>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
              {canais.map(c => {
                const aberto = canalAberto === c.key
                const linhas = Object.entries(m.formas[c.key] || {}).sort((a, b) => b[1] - a[1])
                return (
                  <div key={c.nome}
                    onClick={() => setCanalAberto(aberto ? null : c.key)}
                    role="button" tabIndex={0} aria-expanded={aberto}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCanalAberto(aberto ? null : c.key) } }}
                    style={{ ...cardBox, cursor: 'pointer', borderColor: aberto ? 'var(--primary)' : 'var(--border)', transition: 'border-color .15s' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 24 }}>{c.icon}</span>
                      <span style={{ fontWeight: 700, fontSize: 13.5 }}>{c.nome}</span>
                      <span aria-hidden style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', transform: aberto ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▼</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, marginTop: 8 }}>{fmt(c.value)}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{m.fat > 0 ? Math.round(c.value / m.fat * 100) : 0}% do faturamento</div>

                    {aberto && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                        {linhas.length === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nenhuma venda neste canal no período.</div>
                        ) : (
                          <>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: .5, marginBottom: 8 }}>Como entrou</div>
                            {linhas.map(([forma, valor]) => {
                              const inf = infoForma(forma)
                              const pct = c.value > 0 ? Math.round(valor / c.value * 100) : 0
                              return (
                                <div key={forma} style={{ marginBottom: 8 }}>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
                                    <span aria-hidden>{inf.icon}</span>
                                    <span style={{ flex: 1 }}>{inf.label}</span>
                                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(valor)}</strong>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 32, textAlign: 'right' }}>{pct}%</span>
                                  </div>
                                  <div style={{ height: 4, borderRadius: 4, background: 'var(--border)', marginTop: 4, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: `${pct}%`, background: 'var(--primary)' }} />
                                  </div>
                                </div>
                              )
                            })}
                            {c.key === 'presencial' && (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                                Venda de mesa é registrada só como <strong>à vista</strong> ou <strong>fiado</strong> — o sistema não guarda se o à vista foi dinheiro ou cartão.
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* iFood — líquido estimado */}
          {m.canal.ifood > 0 && (
            <div style={cardBox}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <strong style={{ fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 7 }}><IfoodIcon size={20} /> iFood — quanto você recebe</strong>
                <span title="Estimado com base nas taxas do iFood (comissão sobre itens + transação no pago online). Bate ~99% com o extrato. Importe a planilha no Financeiro pra ver o valor exato."
                  style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 20, padding: '2px 8px', cursor: 'help' }}>estimado ⓘ</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>de {fmt(m.canal.ifood)} em vendas</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>💰 Você recebe</span>
                <span style={{ fontSize: 26, fontWeight: 900, color: '#16a34a' }}>{fmt(m.ifoodLiq.voceRecebe)}</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
                  <span>🏦 Repasse na conta</span><strong>{fmt(m.ifoodLiq.repasse)}</strong>
                </div>
                {m.ifoodLiq.recebidoEntrega > 0 && (
                  <div>
                    <div onClick={() => setEntExp(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, cursor: 'pointer', userSelect: 'none' }}>
                      <span>
                        <span style={{ display: 'inline-block', width: 14, color: 'var(--text-muted)', transform: entExp ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                        💵 Recebido na entrega <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· na mão · toque pra ver</span>
                      </span>
                      <strong>{fmt(m.ifoodLiq.recebidoEntrega)}</strong>
                    </div>
                    {entExp && (
                      <div style={{ margin: '6px 0 2px 20px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {Object.entries(m.ifoodLiq.entregaForma).sort((a, b) => b[1].total - a[1].total).map(([forma, d]) => (
                          <div key={forma} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)' }}>
                            <span>{FORMA_ENTREGA_LABEL[forma] || forma} <span style={{ fontSize: 11 }}>· {d.qtd} pedido{d.qtd !== 1 ? 's' : ''}</span></span>
                            <strong style={{ color: 'var(--text)' }}>{fmt(d.total)}</strong>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, color: '#ef4444', borderTop: '1px solid var(--border)', paddingTop: 9 }}>
                  <span>🔻 iFood ficou com</span>
                  <strong>{fmt(m.ifoodLiq.taxasTotal)} <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>({m.ifoodLiq.pctTaxa}%)</span></strong>
                </div>
              </div>
            </div>
          )}

          {/* Meta do mês */}
          <div style={cardBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <strong style={{ fontSize: 15 }}>🎯 Meta do mês</strong>
              <label style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                Meta R$
                <input type="number" min="0" step="100" value={meta} onChange={e => setMeta(e.target.value)} onBlur={e => salvarMeta(e.target.value)}
                  style={{ width: 110, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
              </label>
            </div>
            {meta > 0 ? (
              <>
                <div style={{ height: 14, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${metaPct}%`, background: metaPct >= 100 ? '#22c55e' : 'var(--primary)', borderRadius: 999, transition: 'width 500ms' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 13 }}>
                  <span>{fmt(m.fatMes)} <span style={{ color: 'var(--text-muted)' }}>de {fmt(meta)}</span></span>
                  <strong style={{ color: metaPct >= 100 ? '#16a34a' : 'var(--text)' }}>{metaPct}%</strong>
                </div>
              </>
            ) : <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Defina uma meta de faturamento pra acompanhar o progresso do mês.</p>}
          </div>

          {/* Faturamento (gráfico) */}
          <div style={cardBox}>
            <strong style={{ fontSize: 15, display: 'block', marginBottom: 10 }}>📈 Faturamento {ehLabel(periodo)}</strong>
            <AreaChart data={m.buckets} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              {m.buckets.filter((_, i) => i % Math.ceil(m.buckets.length / 6) === 0 || i === m.buckets.length - 1).map((b, i) => <span key={i}>{b.label}</span>)}
            </div>
          </div>

          {/* Horários de pico + Top produtos */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
            <div style={cardBox}>
              <strong style={{ fontSize: 15, display: 'block', marginBottom: 14 }}>⏰ Horários de pico</strong>
              <BarsV data={m.horas} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
              </div>
            </div>
            <div style={cardBox}>
              {/* Seis barras cabem no card; o resto do cardápio não. O botão do
                  lado abre até o 30º — é onde aparece o produto que quase não
                  vende, pergunta que o top 6 nunca responde. */}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
                <strong style={{ fontSize: 15 }}>🏆 Top produtos</strong>
                {m.nProdutos > m.top.length && (
                  <button type="button" onClick={() => setVerTop30(true)}
                    style={{
                      flexShrink: 0, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--primary)', fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit',
                    }}>
                    ver o top {Math.min(30, m.nProdutos)}
                  </button>
                )}
              </div>
              <BarsH data={m.top} />
            </div>
          </div>

          {/* Funil da Loja Online — onde o cliente desiste */}
          {/* Aparece SEMPRE, mesmo zerado. Escondido quando vazio, o dono não
              descobre que existe: procurou no Dashboard e não achou nada. */}
          {(
            <div style={{ ...cardBox, marginBottom: 16 }}>
              <strong style={{ fontSize: 15, display: 'block', marginBottom: 4 }}>🛒 Loja Online — onde o cliente parou</strong>
              <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 14px' }}>
                Cada pessoa que abriu o cardápio {ehLabel(periodo)} e até onde ela foi.
              </p>
              {!fn.temDados && (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px', padding: '10px 12px', background: 'var(--bg)', borderRadius: 8 }}>
                  Ninguém abriu o cardápio {ehLabel(periodo)} ainda. A contagem começou hoje —
                  os números aparecem sozinhos na primeira visita.
                </p>
              )}
              <FunilLinha rotulo="Abriu o cardápio" valor={fn.abriu} base={fn.abriu} perdeu={fn.perdeuNaVitrine} legenda="saíram sem botar nada na sacola" />
              <FunilLinha rotulo="Botou na sacola" valor={fn.sacola} base={fn.abriu} pct={fn.pctSacola} perdeu={fn.perdeuNaSacola} legenda="montaram a sacola e não foram pro endereço" />
              <FunilLinha
                rotulo="Foi pro endereço" valor={fn.endereco} base={fn.abriu} pct={fn.pctEndereco}
                perdeu={fn.perdeuNoCadastro} legenda="chegaram no cadastro e desistiram"
                aberto={verParados}
                onAbrir={fn.parados.length > 0 ? () => setVerParados(v => !v) : null}
              />
              {verParados && fn.parados.length > 0 && (
                <div style={{ margin: '2px 0 12px', padding: '10px 12px', background: 'var(--bg)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                    O que cada um já tinha digitado quando parou, a taxa de entrega que estava
                    aparecendo pra ele e o valor da sacola — aparece conforme ele foi
                    preenchendo, então quem saiu no começo fica em branco.
                    <b> Mesmo valor e mesmo telefone repetidos? É a mesma pessoa tentando de novo.</b>
                  </div>
                  {fn.parados.map(p => (
                    <div key={p.sessao} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--border)' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 42 }}>
                        {p.quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 110 }}>
                        {p.nome ?? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>sem nome ainda</span>}
                      </span>
                      {p.telefone ? (
                        <a
                          href={`https://wa.me/55${p.telefone}`}
                          target="_blank" rel="noreferrer"
                          style={{ fontSize: 12.5, fontWeight: 600, color: '#16a34a', textDecoration: 'none', whiteSpace: 'nowrap' }}
                        >
                          💬 {telBonito(p.telefone)}
                        </a>
                      ) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>sem telefone</span>}
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {p.cep ? `CEP ${p.cep.slice(0, 5)}-${p.cep.slice(5)}` : 'sem CEP'}
                      </span>
                      {/* Sacola + taxa: é a dupla que responde "desistiu por causa
                          do frete?". R$ 14 de sacola com R$ 10 de entrega conta uma
                          história que a sacola sozinha não conta. */}
                      {p.taxa != null && (
                        <span style={{ fontSize: 12, color: p.taxa > 0 ? 'var(--text-muted)' : '#16a34a', whiteSpace: 'nowrap' }}>
                          {p.taxa > 0 ? `taxa ${fmt(p.taxa)}` : 'sem taxa'}
                        </span>
                      )}
                      {p.valor != null && <strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmt(p.valor)}</strong>}
                    </div>
                  ))}
                </div>
              )}
              <FunilLinha rotulo="Fechou o pedido" valor={fn.pedido} base={fn.abriu} pct={fn.pctPedido} ultimo />
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 13 }}>
                De cada 100 que abriram o cardápio, <b>{fn.pctGeral}</b> fecharam pedido.
              </div>
            </div>
          )}

          {/* Operacional + Ranking de clientes */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
            <div style={cardBox}>
              <strong style={{ fontSize: 15, display: 'block', marginBottom: 12 }}>📦 Operação</strong>
              <Op label="Fiado em aberto" to="/financeiro" value={fmt(op.fiado)} />
              <Op label="Clientes ativos" to="/clientes" value={op.clientesAtivos} />
              {usaEstoque && <Op label="Estoque baixo" to="/estoque" value={op.estoqueBaixo} alerta={op.estoqueBaixo > 0} />}
              {usaCasco && <Op label="Cascos pendentes" to="/estoque" value={op.cascosPendentes} ultimo />}
            </div>
            <div style={cardBox}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
                <strong style={{ fontSize: 15 }}>🥇 Ranking de clientes</strong>
                <Link to="/clientes" style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)', textDecoration: 'none' }}>ver todos →</Link>
              </div>
              {m.rank.length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                  Nenhuma compra de cliente identificado {ehLabel(periodo)}. Venda de balcão sem cliente não entra no ranking.
                </p>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                    {m.rankQtd} {m.rankQtd === 1 ? 'cliente comprou' : 'clientes compraram'} {ehLabel(periodo)} · {fmt(m.rankFat)} no total
                  </div>
                  {m.rank.map((c, i) => (
                    <div key={i} style={{ padding: '9px 0', borderBottom: i === m.rank.length - 1 ? 'none' : '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={posicao(i)}>{i + 1}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.nome}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {c.compras} {c.compras === 1 ? 'compra' : 'compras'} · ticket {fmt(c.total / c.compras)}
                          </div>
                        </div>
                        <strong style={{ fontSize: 14 }}>{fmt(c.total)}</strong>
                      </div>
                      <div style={{ height: 5, borderRadius: 999, background: 'var(--border)', overflow: 'hidden', marginTop: 7 }}>
                        <div style={{ height: '100%', width: `${(c.total / m.rank[0].total) * 100}%`, background: 'var(--primary)', borderRadius: 999, transition: 'width 400ms' }} />
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 24, padding: '18px 20px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>🤖 Avisos no WhatsApp</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Automático: <strong>resumo do dia às 22:10</strong>
          {usaEstoque && <> e <strong>alerta de estoque às 8h</strong></>}. Quer testar agora?
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={enviarResumo} disabled={enviandoResumo} className="btn btn-primary">
            {enviandoResumo ? 'Enviando...' : '📲 Resumo do dia'}
          </button>
          {usaEstoque && (
            <button onClick={enviarAlerta} disabled={enviandoResumo} className="btn btn-secondary">
              {enviandoResumo ? 'Enviando...' : '📦 Alerta de estoque'}
            </button>
          )}
        </div>
        {resumoMsg && (
          <div style={{ marginTop: 10, fontSize: 13, color: resumoMsg.tipo === 'ok' ? 'var(--success)' : resumoMsg.tipo === 'aviso' ? '#f59e0b' : 'var(--danger)' }}>
            {resumoMsg.txt}
          </div>
        )}
      </div>

      {refToken && (() => {
        const link = `${window.location.origin}/entrar?ref=${refToken}`
        function copiar() { navigator.clipboard.writeText(link); setCopiado(true); clearTimeout(timerRef.current); timerRef.current = setTimeout(() => setCopiado(false), 2500) }
        return (
          <div className="card" style={{ marginTop: 24, padding: '18px 20px' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Seu link de indicação</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Compartilhe esse link. Quem se cadastrar pela sua indicação entra na sua rede e você ganha comissão nas vendas deles.</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', border: '1.5px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link}</div>
              <button onClick={copiar} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13, background: copiado ? '#16a34a' : 'var(--primary)', color: '#fff', whiteSpace: 'nowrap' }}>{copiado ? '✔ Copiado!' : 'Copiar link'}</button>
            </div>
          </div>
        )
      })()}

      {/* ── Ranking maior dos produtos ──
          O card mostra seis porque seis barras cabem na tela. Aqui vão até 30,
          que é o tanto que ainda se lê de uma vez — e para aí de propósito:
          numa loja de 4 mil produtos, desenhar a lista inteira trava o
          navegador e ninguém decide nada olhando o 800º lugar. */}
      {verTop30 && (
        <div className="modal-overlay" onClick={() => setVerTop30(false)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>🏆 Top {m.top30.length} produtos</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setVerTop30(false)}>Fechar</button>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 14px' }}>
              Os que mais faturaram {ehLabel(periodo)}, de {m.nProdutos} produtos diferentes que
              saíram no período. Balcão, mesa e delivery juntos.
            </p>

            <div style={{ maxHeight: '58vh', overflowY: 'auto' }}>
              {m.top30.map((d, i) => {
                const fatia = m.top30[0]?.value > 0 ? (d.value / m.top30[0].value) * 100 : 0
                const pctDoTotal = m.fat > 0 ? (d.value / m.fat) * 100 : 0
                return (
                  <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                    <span style={{ width: 30, flexShrink: 0, textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>
                      {i + 1}º
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</div>
                      <div style={{ height: 6, borderRadius: 999, background: 'var(--border)', overflow: 'hidden', marginTop: 5 }}>
                        <div style={{ height: '100%', width: `${fatia}%`, background: 'var(--primary)', borderRadius: 999 }} />
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 800 }}>{fmt(d.value)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {d.qtd > 0 ? `${Math.round(d.qtd)} un · ` : ''}{pctDoTotal.toFixed(1)}% do faturamento
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ehLabel(p) { return p === 'hoje' ? '(hoje, por hora)' : p === '7d' ? '(últimos 7 dias)' : p === '30d' ? '(últimos 30 dias)' : p === 'custom' ? '(período escolhido)' : '(mês)' }
// Uma linha do funil: quantos chegaram, que fatia é isso, e — o que importa —
// quantos ficaram pelo caminho dali pra frente.
// Telefone só de dígitos vira (84) 99999-8888 — o dono lê pelo formato, não
// por uma tira de onze números seguidos.
function telBonito(t) {
  const d = String(t ?? '').replace(/\D/g, '')
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return t
}

function FunilLinha({ rotulo, valor, base, pct, perdeu, legenda, ultimo, aberto, onAbrir }) {
  const largura = base > 0 ? Math.max(4, Math.round((valor / base) * 100)) : 0
  return (
    <div style={{ marginBottom: ultimo ? 0 : 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          {onAbrir && (
            <button
              type="button"
              onClick={onAbrir}
              title={aberto ? 'Esconder quem parou aqui' : 'Ver quem parou aqui'}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px 0 0',
                color: 'var(--primary)', fontSize: 12, fontWeight: 800,
                display: 'inline-block', transform: aberto ? 'rotate(90deg)' : 'none',
                transition: 'transform 150ms',
              }}
            >▶</button>
          )}
          {rotulo}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>
          {valor}
          {pct != null && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}> · {pct}% de quem chegou antes</span>}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 6, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ width: largura + '%', height: '100%', background: 'var(--primary)' }} />
      </div>
      {perdeu > 0 && (
        <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 4 }}>
          ↓ {perdeu} {legenda}
        </div>
      )}
    </div>
  )
}

function Op({ label, value, to, alerta, ultimo }) {
  return (
    <Link to={to} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: ultimo ? 'none' : '1px solid var(--border)', textDecoration: 'none', color: 'var(--text)' }}>
      <span style={{ fontSize: 13.5 }}>{label}</span>
      <strong style={{ fontSize: 15, color: alerta ? '#f59e0b' : 'var(--text)' }}>{value}</strong>
    </Link>
  )
}
