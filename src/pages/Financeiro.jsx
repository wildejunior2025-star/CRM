import { useEffect, useRef, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { calcIfoodLiquido, FORMA_ENTREGA_LABEL } from '../lib/ifoodLiquido'
import IfoodIcon from '../components/IfoodIcon'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Financeiro.css'

const fmtBRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const pad = n => String(n).padStart(2, '0')
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const ddmm = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
const parseValor = s => {
  let x = String(s ?? '').trim().replace(/[^\d.,]/g, '')
  if (!x) return 0
  if (x.includes(',')) x = x.replace(/\./g, '').replace(',', '.')
  return Number(x) || 0
}

// Ciclo iFood: apuração seg–dom; deposita na QUARTA seguinte (domingo + 3).
function inicioSemana(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0)
  const dow = x.getDay()
  x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1))
  return x
}
const addDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

// Período de apuração do iFood: semana seg–dom, mas cortada no início do mês
// (o iFood reseta o período dia 1). Ex: 01–05/07 (parcial), 06–12, 13–19.
function periodoIfood(d = new Date()) {
  const seg = inicioSemana(d)
  const dom = addDias(seg, 6)
  const mesIni = new Date(d.getFullYear(), d.getMonth(), 1); mesIni.setHours(0, 0, 0, 0)
  const mesFim = new Date(d.getFullYear(), d.getMonth() + 1, 0); mesFim.setHours(0, 0, 0, 0)
  return { ini: seg < mesIni ? mesIni : seg, fim: dom > mesFim ? mesFim : dom, seg }
}

const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['mes', 'Mês'], ['custom', 'Personalizado']]

function rangeFin(periodo, custIni, custFim) {
  const now = new Date()
  const inicioDia = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
  if (periodo === '7d')  { const s = inicioDia(now); s.setDate(s.getDate() - 7);  return { start: s.toISOString(), end: null } }
  if (periodo === '30d') { const s = inicioDia(now); s.setDate(s.getDate() - 30); return { start: s.toISOString(), end: null } }
  if (periodo === 'mes') { return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), end: null } }
  if (periodo === 'custom') {
    const s = new Date(custIni + 'T00:00:00')
    const e = new Date((custFim || custIni) + 'T00:00:00'); e.setDate(e.getDate() + 1)
    return { start: s.toISOString(), end: e.toISOString() }
  }
  return { start: inicioDia(now).toISOString(), end: null }
}

const NUM_SEMANAS = 5

export default function Financeiro() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [periodoD, setPeriodoD] = useState('mes')
  const [custIni, setCustIni]   = useState(ymd(new Date()))
  const [custFim, setCustFim]   = useState(ymd(new Date()))
  const [pedidos, setPedidos]   = useState([])
  const [loadingD, setLoadingD] = useState(true)

  // ── iFood: semanas (a receber na quarta) + anúncio por semana ──
  const [semanas, setSemanas] = useState([])     // [{iniYMD, inicio, fim, pagamento, situacao, liq, nped}]
  const [mesFiltro, setMesFiltro] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` })  // padrão = mês atual; '' = recentes. Filtra SÓ as "semanas anteriores"
  const [semanasMes, setSemanasMes] = useState(null)  // semanas do mês filtrado (null = sem filtro)
  const [ads, setAds]         = useState({})      // { [periodo_ini]: valor } (anúncio digitado)
  const [repImp, setRepImp]   = useState({})      // { [periodo_ini]: {valor_repasse, situacao, ...} } (PDF importado)
  const [abertoAtual, setAbertoAtual] = useState(false)
  const [abertoAnt, setAbertoAnt] = useState({})   // { [iniYMD]: bool } semanas anteriores expandidas
  const [abertoCanal, setAbertoCanal] = useState({})   // { [canal]: bool } cards de canal próprio expandidos
  const [entExp, setEntExp]   = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState(null)
  const fileRef = useRef(null)

  async function loadDelivery() {
    setLoadingD(true)
    const { start, end } = rangeFin(periodoD, custIni, custFim)
    const pedRes = await fetchAll(() => {
      let q = supabase.from('pedidos_delivery').select('origem, total, subtotal, taxa_entrega')
        .neq('status', 'cancelado').order('created_at', { ascending: false })
      if (start) q = q.gte('created_at', start)
      if (end)   q = q.lt('created_at', end)
      return q
    })
    setPedidos(pedRes.data ?? [])
    setLoadingD(false)
  }
  useEffect(() => { loadDelivery() }, [periodoD, custIni, custFim])

  // Busca as semanas do iFood num intervalo [desde, ateh). ateh null = até hoje.
  async function fetchSemanas(desde, ateh) {
    const anuQ = supabase.from('ifood_anuncio').select('semana_ini, valor').eq('empresa_id', empresaId).gte('semana_ini', ymd(desde))
    const impQ = supabase.from('ifood_repasse_semanal').select('*').eq('empresa_id', empresaId).gte('periodo_ini', ymd(desde))
    const [empRes, adsRes, impRes, pedRes] = await Promise.all([
      supabase.from('empresas').select('ifood_comissao_pct, ifood_transacao_pct').eq('id', empresaId).maybeSingle(),
      ateh ? anuQ.lt('semana_ini', ymd(ateh)) : anuQ,
      ateh ? impQ.lt('periodo_ini', ymd(ateh)) : impQ,
      fetchAll(() => {
        let q = supabase.from('pedidos_delivery')
          .select('created_at, total, subtotal, taxa_entrega, ifood_valores, forma_pagamento')
          .eq('origem', 'ifood').neq('status', 'cancelado')
          .gte('created_at', desde.toISOString()).order('created_at', { ascending: false })
        if (ateh) q = q.lt('created_at', ateh.toISOString())
        return q
      }),
    ])
    const rates = { comissao: empRes.data?.ifood_comissao_pct, transacao: empRes.data?.ifood_transacao_pct }
    const adMap = {}; for (const a of (adsRes.data ?? [])) adMap[a.semana_ini] = Number(a.valor || 0)
    const impMap = {}; for (const r of (impRes.data ?? [])) impMap[r.periodo_ini] = r

    const grupos = {}
    for (const p of (pedRes.data ?? [])) {
      const per = periodoIfood(new Date(p.created_at)); const k = ymd(per.ini)
      ;(grupos[k] || (grupos[k] = { per, peds: [] })).peds.push(p)
    }
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
    const arr = Object.values(grupos).map(g => {
      const pagamento = addDias(g.per.seg, 9) // segunda da semana + 9 = quarta seguinte
      return {
        iniYMD: ymd(g.per.ini), inicio: g.per.ini, fim: g.per.fim, pagamento,
        situacao: pagamento <= hoje ? 'pago' : 'em aberto',
        liq: calcIfoodLiquido(g.peds, rates), nped: g.peds.length,
      }
    })
    // semanas com repasse importado mas sem pedidos no banco também aparecem
    for (const k of Object.keys(impMap)) {
      if (arr.some(s => s.iniYMD === k)) continue
      const r = impMap[k]
      const ini = new Date(r.periodo_ini + 'T00:00:00')
      const fim = r.periodo_fim ? new Date(r.periodo_fim + 'T00:00:00') : addDias(ini, 6)
      const pagamento = r.previsao_pagamento ? new Date(r.previsao_pagamento + 'T00:00:00') : addDias(inicioSemana(ini), 9)
      arr.push({ iniYMD: k, inicio: ini, fim, pagamento, situacao: r.situacao || 'pago', liq: calcIfoodLiquido([], rates), nped: 0 })
    }
    arr.sort((a, b) => b.inicio - a.inicio)
    return { arr, adMap, impMap }
  }

  async function loadSemanas() {
    if (!empresaId) return
    const desde = addDias(inicioSemana(), -7 * (NUM_SEMANAS - 1))
    const { arr, adMap, impMap } = await fetchSemanas(desde, null)
    setSemanas(arr); setAds(adMap); setRepImp(impMap)
  }
  useEffect(() => { loadSemanas() }, [empresaId])

  // Filtro por mês (só afeta a tabela "Semanas anteriores")
  async function loadSemanasMes(mes) {
    if (!empresaId || !mes) { setSemanasMes(null); return }
    const [y, m] = mes.split('-').map(Number)
    const desde = new Date(y, m - 1, 1); desde.setHours(0, 0, 0, 0)
    const ateh  = new Date(y, m, 1);     ateh.setHours(0, 0, 0, 0)   // início do mês seguinte (exclusivo)
    const { arr, adMap, impMap } = await fetchSemanas(desde, ateh)
    setSemanasMes(arr)
    setAds(prev => ({ ...prev, ...adMap }))       // mescla p/ o anúncio/exato bater nas semanas do mês
    setRepImp(prev => ({ ...prev, ...impMap }))
  }
  useEffect(() => { loadSemanasMes(mesFiltro) }, [empresaId, mesFiltro])

  async function salvarAnuncio(iniYMD, val) {
    setAds(prev => ({ ...prev, [iniYMD]: val }))
    await supabase.from('ifood_anuncio').upsert(
      { empresa_id: empresaId, semana_ini: iniYMD, valor: val, atualizado_em: new Date().toISOString() },
      { onConflict: 'empresa_id,semana_ini' })
  }

  async function onImportarPdf(e) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file || !empresaId) return
    setImporting(true); setImportMsg(null)
    try {
      const { parseRepassePdf } = await import('../lib/ifoodRepassePdf')
      const r = await parseRepassePdf(file)
      if (!r.periodo_ini || !(r.valor_repasse > 0)) throw new Error('Não consegui ler o valor do repasse nesse PDF.')
      const { data: salvo, error: upErr } = await supabase.from('ifood_repasse_semanal').upsert({
        empresa_id: empresaId, periodo_ini: r.periodo_ini, periodo_fim: r.periodo_fim,
        previsao_pagamento: r.previsao_pagamento, situacao: r.situacao,
        vendas: r.vendas, anuncio: r.anuncio, valor_repasse: r.valor_repasse,
        comissoes: r.comissoes, promocoes: r.promocoes, recebido_direto: r.recebido_direto,
        importado_em: new Date().toISOString(),
      }, { onConflict: 'empresa_id,periodo_ini' }).select().maybeSingle()
      if (upErr) throw new Error(`Não consegui salvar o repasse: ${upErr.message}`)
      if (!salvo) throw new Error('O repasse não foi salvo (sem permissão pra gravar nesta loja). Confira se você está logado na loja certa.')
      // guarda o anúncio junto (pra também alimentar a estimativa)
      if (r.anuncio > 0) await salvarAnuncio(r.periodo_ini, r.anuncio)
      setImportMsg({ tipo: 'ok', txt: `Repasse de ${r.periodo_ini.split('-').reverse().join('/')} importado — R$ ${r.valor_repasse.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (exato).` })
      await loadSemanas()
      await loadSemanasMes(mesFiltro)
    } catch (err) {
      setImportMsg({ tipo: 'erro', txt: err.message || 'Falha ao ler o PDF.' })
    }
    setImporting(false)
  }

  // a receber: se tem PDF importado da semana → valor EXATO; senão estimativa − anúncio
  const aReceberDe = s => repImp[s.iniYMD] ? Number(repImp[s.iniYMD].valor_repasse) : s.liq.repasse - (ads[s.iniYMD] || 0)
  const ehExato = s => !!repImp[s.iniYMD]

  // Vendas por canal próprio
  const pedWA  = pedidos.filter(p => p.origem === 'whatsapp')
  const pedApp = pedidos.filter(p => p.origem === 'app')
  const pedCat = pedidos.filter(p => !p.origem || p.origem === 'cardapio')
  const soma = arr => arr.reduce((s, p) => s + Number(p.total || 0), 0)
  const somaTaxa = arr => arr.reduce((s, p) => s + Number(p.taxa_entrega || 0), 0)
  const volTotal = soma(pedWA) + soma(pedApp) + soma(pedCat)
  const taxaTotal = somaTaxa(pedWA) + somaTaxa(pedApp) + somaTaxa(pedCat)

  const atual = semanas[0]
  const anteriores = semanas.slice(1)

  // iFood JÁ recebido = dinheiro na mão (entrega) + repasses das semanas já pagas (a receber na quarta NÃO entra)
  const ifoodRecebido = semanas.reduce((s, w) => {
    const transf = w.situacao === 'pago' ? aReceberDe(w) : 0   // repasse que já caiu no banco
    const mao = Number(w.liq?.recebidoEntrega || 0)            // dinheiro/cartão recebido na entrega
    return s + transf + mao
  }, 0)
  const liquidoProprios = volTotal - taxaTotal
  const liquidoGeral = liquidoProprios + ifoodRecebido

  // Opções do filtro de mês (últimos 8 meses) — só afeta a tabela "Semanas anteriores"
  const mesesOpcoes = (() => {
    const arr = []; const now = new Date()
    for (let i = 0; i < 8; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      arr.push([`${d.getFullYear()}-${pad(d.getMonth() + 1)}`, d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })])
    }
    return arr
  })()
  const labelMes = mesFiltro ? (mesesOpcoes.find(([v]) => v === mesFiltro)?.[1] || mesFiltro) : ''

  // Renderiza uma linha de semana (usada nas "anteriores" e no filtro por mês)
  const renderSemanaRow = s => {
    const aberta = !!abertoAnt[s.iniYMD]
    return (
      <div key={s.iniYMD} style={{ borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center', padding: '12px 0' }}>
          <div onClick={() => setAbertoAnt(m => ({ ...m, [s.iniYMD]: !m[s.iniYMD] }))} style={{ cursor: 'pointer', userSelect: 'none' }}>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>
              <span style={{ display: 'inline-block', width: 14, color: 'var(--text-muted)', transform: aberta ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
              {ddmm(s.inicio)} a {ddmm(s.fim)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, marginLeft: 14 }}>
              {s.situacao === 'pago'
                ? <>✅ pago em {ddmm(s.pagamento)}</>
                : <>🕒 cai {ddmm(s.pagamento)}</>} · {s.nped} pedidos
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, visibility: ehExato(s) ? 'hidden' : 'visible' }}>
            <span title="Anúncio da semana" style={{ fontSize: 11, color: 'var(--text-muted)' }}>📢</span>
            <AnuncioInput small valor={ads[s.iniYMD] || 0} onSalvar={v => salvarAnuncio(s.iniYMD, v)} />
          </div>
          <div style={{ textAlign: 'right', minWidth: 110 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#16a34a' }}>{ehExato(s) ? '' : '≈ '}{fmtBRL(aReceberDe(s))}</div>
            <div style={{ fontSize: 10, color: ehExato(s) ? 'var(--success)' : 'var(--text-muted)' }}>{ehExato(s) ? 'exato ✔' : (ads[s.iniYMD] > 0 ? 'a receber' : 'informe o anúncio')}</div>
          </div>
        </div>
        {aberta && (
          <div style={{ marginLeft: 14, paddingBottom: 6 }}>
            <QuebraRepasse s={s} rep={repImp[s.iniYMD]} anuncio={ads[s.iniYMD] || 0} aReceber={aReceberDe(s)} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h1>Financeiro</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {periodoD === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
              <input type="date" value={custIni} max={custFim || ymd(new Date())}
                onChange={e => { setCustIni(e.target.value); if (e.target.value > custFim) setCustFim(e.target.value) }}
                style={inpDate} />
              <span>até</span>
              <input type="date" value={custFim} min={custIni} max={ymd(new Date())}
                onChange={e => setCustFim(e.target.value)} style={inpDate} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)', borderRadius: 999, padding: 4 }}>
            {PERIODOS.map(([id, lb]) => (
              <button key={id} type="button" onClick={() => setPeriodoD(id)}
                style={{ padding: '6px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  background: periodoD === id ? 'var(--primary)' : 'transparent', color: periodoD === id ? '#fff' : 'var(--text-muted)' }}>
                {lb}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── iFOOD — A RECEBER NA QUARTA (semana atual) ── */}
      {atual && atual.nped > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><IfoodIcon size={18} /> iFood — a receber na quarta ({ddmm(atual.pagamento)})</span>
            {ehExato(atual)
              ? <span title="Valor exato, do PDF de repasse que você importou." style={{ ...badge, color: 'var(--success)', borderColor: 'var(--success)' }}>exato ✔</span>
              : <span title="Vendas e taxas calculadas dos seus pedidos; o anúncio você informa. Importe o PDF do repasse pra ficar exato." style={badge}>estimado ⓘ</span>}
            <span style={{ flex: 1 }} />
            <input ref={fileRef} type="file" accept=".pdf" onChange={onImportarPdf} style={{ display: 'none' }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={importing}
              style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', background: 'transparent', border: '1px solid var(--primary)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', textTransform: 'none', letterSpacing: 0 }}>
              {importing ? 'Lendo PDF…' : '📄 Importar PDF do repasse'}
            </button>
          </div>
          {importMsg && (
            <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
              background: importMsg.tipo === 'ok' ? 'rgba(22,163,74,.10)' : 'rgba(239,68,68,.10)',
              border: `1px solid ${importMsg.tipo === 'ok' ? 'rgba(22,163,74,.4)' : 'rgba(239,68,68,.4)'}` }}>
              {importMsg.tipo === 'ok' ? '✅ ' : '⚠️ '}{importMsg.txt}
            </div>
          )}
          <div style={{ background: 'var(--card)', border: '1px solid #16a34a', borderRadius: 12, padding: '4px 20px', marginBottom: 20 }}>
            {/* Headline (sempre visível) — clica pra abrir a quebra */}
            <div onClick={() => setAbertoAtual(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '14px 0', cursor: 'pointer', userSelect: 'none' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>
                  <span style={{ display: 'inline-block', width: 15, color: 'var(--text-muted)', transform: abertoAtual ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                  = A receber na quarta
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, marginLeft: 15 }}>
                  {ddmm(atual.inicio)} a {ddmm(atual.fim)} · {ehExato(atual) ? (repImp[atual.iniYMD].situacao || 'em aberto') : 'em aberto'} · {atual.nped} pedido{atual.nped !== 1 ? 's' : ''}
                </div>
              </div>
              <span style={{ fontSize: 24, fontWeight: 900, color: '#16a34a', whiteSpace: 'nowrap' }}>{ehExato(atual) ? '' : '≈ '}{fmtBRL(aReceberDe(atual))}</span>
            </div>
            {!ehExato(atual) && !(ads[atual.iniYMD] > 0) && (
              <div style={{ fontSize: 11.5, color: '#f59e0b', padding: '0 0 12px', marginLeft: 15 }}>⚠️ Informe o anúncio (toque pra abrir) ou importe o PDF do repasse — senão o valor fica alto.</div>
            )}
            {/* Quebra (abre na seta) */}
            {abertoAtual && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 2 }}>
                {ehExato(atual) ? (
                  <QuebraRepasse rep={repImp[atual.iniYMD]} aReceber={aReceberDe(atual)} semTotal />
                ) : (
                  <>
                    <Linha label="Vendas (itens + entrega)" valor={fmtBRL(atual.liq.vendasOnline)} />
                    <Linha label="− Comissão + taxa" valor={`− ${fmtBRL(atual.liq.comissaoOnline)}`} cor="var(--danger)" />
                    <Linha label="− Promoções (seus cupons)" valor={`− ${fmtBRL(atual.liq.promocoesOnline)}`} cor="var(--danger)" />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0 14px' }}>
                      <div>
                        <div style={{ fontSize: 13.5, color: 'var(--danger)' }}>− 📢 Anúncios <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(você informa — o iFood cobra à parte)</span></div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>pegue no "Pacote de anúncios" do app do iFood</div>
                      </div>
                      <AnuncioInput valor={ads[atual.iniYMD] || 0} onSalvar={v => salvarAnuncio(atual.iniYMD, v)} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Já na sua mão (recebido na entrega — semana atual) */}
          {atual.liq.recebidoEntrega > 0 && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '4px 20px', marginBottom: 24 }}>
              <div onClick={() => setEntExp(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', cursor: 'pointer', userSelect: 'none' }}>
                <div style={{ fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ display: 'inline-block', width: 14, color: 'var(--text-muted)', transform: entExp ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                  <IfoodIcon size={16} /> Recebido na entrega iFood <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>· esta semana · toque pra abrir</span>
                </div>
                <span style={{ fontSize: 20, fontWeight: 900 }}>{fmtBRL(atual.liq.recebidoEntrega)}</span>
              </div>
              {entExp && (
                <div style={{ margin: '2px 0 12px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {Object.entries(atual.liq.entregaForma).sort((a, b) => b[1].total - a[1].total).map(([forma, d]) => (
                    <div key={forma} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)' }}>
                      <span>{FORMA_ENTREGA_LABEL[forma] || forma} <span style={{ fontSize: 11.5 }}>· {d.qtd} pedido{d.qtd !== 1 ? 's' : ''}</span></span>
                      <strong style={{ color: 'var(--text)' }}>{fmtBRL(d.total)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── SEMANAS ANTERIORES (com filtro por mês) ── */}
      {semanas.length > 0 && (() => {
        // a semana atual já aparece no card "a receber na quarta" — tira da lista pra não duplicar
        const lista = (mesFiltro ? (semanasMes || []) : anteriores).filter(s => s.iniYMD !== atual?.iniYMD)
        const totalMes = lista.reduce((a, s) => a + aReceberDe(s), 0)
        return (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
              {mesFiltro ? `Repasses de ${labelMes}` : 'Semanas anteriores'}
            </span>
            <span style={{ flex: 1 }} />
            <select value={mesFiltro} onChange={e => setMesFiltro(e.target.value)}
              style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', background: 'var(--input-bg, var(--bg))', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', textTransform: 'capitalize' }}>
              <option value="">Recentes</option>
              {mesesOpcoes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {lista.length > 0 ? (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 16px', marginBottom: mesFiltro ? 10 : 28 }}>
              {lista.map(renderSemanaRow)}
            </div>
          ) : (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 16px', marginBottom: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Nenhum repasse do iFood em {labelMes}.
            </div>
          )}
          {mesFiltro && lista.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px', marginBottom: 28 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>Total do mês ({lista.length} semana{lista.length !== 1 ? 's' : ''})</span>
              <strong style={{ fontSize: 18, fontWeight: 900, color: '#16a34a' }}>{fmtBRL(totalMes)}</strong>
            </div>
          )}
        </>
        )
      })()}

      {/* ── VENDAS POR CANAL PRÓPRIO ── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
        Vendas por canal próprio
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 24, alignItems: 'start' }}>
        {[
          { key: 'wa',  label: 'WhatsApp',     peds: pedWA,  cor: '#25d366' },
          { key: 'app', label: 'App / Portal', peds: pedApp, cor: '#f97316' },
          { key: 'cat', label: 'Catálogo',     peds: pedCat, cor: 'var(--primary)' },
        ].map(({ key, label, peds, cor }) => {
          const vol = soma(peds), taxa = somaTaxa(peds), liq = vol - taxa, aberto = !!abertoCanal[key]
          return (
          <div key={key} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: `4px solid ${cor}`, borderRadius: 12, padding: '14px 16px' }}>
            <div onClick={() => setAbertoCanal(m => ({ ...m, [key]: !m[key] }))} style={{ cursor: 'pointer', userSelect: 'none' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                <span style={{ display: 'inline-block', width: 13, color: 'var(--text-muted)', transform: aberto ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                {label}
              </div>
              <div style={{ fontSize: 20, fontWeight: 900, color: '#16a34a' }}>{fmtBRL(liq)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{peds.length} pedido{peds.length !== 1 ? 's' : ''} · líquido</div>
            </div>
            {aberto && (
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)' }}>
                  <span>Total (com taxa)</span><strong style={{ color: 'var(--text)' }}>{fmtBRL(vol)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--danger)' }}>
                  <span>− Taxa de entrega</span><strong>− {fmtBRL(taxa)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 800, paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
                  <span>= Líquido (mercadoria)</span><strong style={{ color: '#16a34a' }}>{fmtBRL(liq)}</strong>
                </div>
              </div>
            )}
          </div>
          )
        })}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>Total líquido recebido</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: '#16a34a' }}>{fmtBRL(liquidoGeral)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>canais próprios + iFood já recebido</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>próprios <strong style={{ color: 'var(--text)' }}>{fmtBRL(liquidoProprios)}</strong></span>
            <span><IfoodIcon size={11} /> iFood recebido <strong style={{ color: 'var(--text)' }}>{fmtBRL(ifoodRecebido)}</strong></span>
          </div>
        </div>
      </div>

      {loadingD && <p style={{ color: 'var(--text-muted)' }}>Carregando…</p>}
    </div>
  )
}

const inpDate = { padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }
const badge = { fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 20, padding: '2px 8px', cursor: 'help', textTransform: 'none', letterSpacing: 0 }

function Linha({ label, valor, cor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13.5, color: cor || 'var(--text)' }}>{label}</span>
      <strong style={{ fontSize: 14, color: cor || 'var(--text)' }}>{valor}</strong>
    </div>
  )
}

// Quebra do repasse iFood de uma semana.
// - PDF importado (rep) → valores EXATOS do repasse (batem centavo com o iFood)
// - sem PDF → estimativa dos pedidos (s.liq) + anúncio digitado
function QuebraRepasse({ s, rep, anuncio = 0, aReceber, semTotal }) {
  const exato = !!rep
  let vendas, comissoes, promocoes, anuncios, recebidoDireto = 0, ajuste = 0
  if (exato) {
    vendas         = Number(rep.vendas || 0)
    comissoes      = Number(rep.comissoes || 0)
    promocoes      = Number(rep.promocoes || 0)
    anuncios       = Number(rep.anuncio || 0)
    recebidoDireto = Number(rep.recebido_direto || 0)
    // resíduo pra fechar EXATO no repasse (cancelamentos, ajustes, arredondamentos)
    ajuste = aReceber - (vendas - comissoes - promocoes - anuncios - recebidoDireto)
  } else {
    vendas    = s.liq.vendasOnline
    comissoes = s.liq.comissaoOnline
    promocoes = s.liq.promocoesOnline
    anuncios  = anuncio
  }
  return (
    <>
      <Linha label="Vendas (itens + entrega)" valor={fmtBRL(vendas)} />
      <Linha label="− Comissão + taxa" valor={`− ${fmtBRL(comissoes)}`} cor="var(--danger)" />
      <Linha label="− Promoções (seus cupons)" valor={`− ${fmtBRL(promocoes)}`} cor="var(--danger)" />
      <Linha label="− 📢 Anúncios" valor={`− ${fmtBRL(anuncios)}`} cor="var(--danger)" />
      {exato && recebidoDireto > 0 && (
        <Linha label="− Já recebido na entrega" valor={`− ${fmtBRL(recebidoDireto)}`} cor="var(--danger)" />
      )}
      {exato && Math.abs(ajuste) >= 0.01 && (
        <Linha label={ajuste >= 0 ? '+ Ajustes' : '− Ajustes / débitos'}
          valor={`${ajuste >= 0 ? '+' : '−'} ${fmtBRL(Math.abs(ajuste))}`}
          cor={ajuste >= 0 ? 'var(--success)' : 'var(--danger)'} />
      )}
      {!semTotal && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0 4px' }}>
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>= {exato ? 'Repasse' : 'A receber'}</span>
          <strong style={{ fontSize: 15, fontWeight: 900, color: '#16a34a' }}>{exato ? '' : '≈ '}{fmtBRL(aReceber)}</strong>
        </div>
      )}
    </>
  )
}

// Campo de anúncio por semana (estado local; salva no blur)
function AnuncioInput({ valor, onSalvar, small }) {
  const [v, setV] = useState(valor > 0 ? String(valor).replace('.', ',') : '')
  const [saving, setSaving] = useState(false)
  useEffect(() => { setV(valor > 0 ? String(valor).replace('.', ',') : '') }, [valor])
  async function salvar() {
    setSaving(true)
    await onSalvar(parseValor(v))
    setSaving(false)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>R$</span>
      <input value={v} onChange={e => setV(e.target.value)} onBlur={salvar}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
        placeholder="0,00" inputMode="decimal"
        style={{ width: small ? 78 : 100, textAlign: 'right', padding: small ? '4px 6px' : '5px 8px', borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--danger)', fontWeight: 700, fontSize: small ? 13 : 14 }} />
      {saving && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>…</span>}
    </div>
  )
}
