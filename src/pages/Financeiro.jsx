import { useEffect, useRef, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { calcIfoodLiquido, FORMA_ENTREGA_LABEL } from '../lib/ifoodLiquido'
import IfoodIcon from '../components/IfoodIcon'
import { parseIfoodPlanilha } from '../lib/ifoodPlanilha'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Financeiro.css'

const fmtBRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const pad = n => String(n).padStart(2, '0')
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const ddmm = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`

// Ciclo do iFood: apuração de segunda a domingo; deposita na QUARTA seguinte
// (domingo que fecha a semana + 3 dias). Ex: semana 13–19/07 → paga 22/07.
function inicioSemana(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0)
  const dow = x.getDay()            // 0=domingo ... 6=sábado
  x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1))
  return x
}
const addDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['mes', 'Mês'], ['custom', 'Personalizado']]

// Devolve { start, end } (ISO) do período. end exclusivo; null = até agora.
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
  return { start: inicioDia(now).toISOString(), end: null } // hoje
}

export default function Financeiro() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [periodoD, setPeriodoD] = useState('mes')
  const [custIni, setCustIni]   = useState(ymd(new Date()))
  const [custFim, setCustFim]   = useState(ymd(new Date()))
  const [pedidos, setPedidos]   = useState([])
  const [loadingD, setLoadingD] = useState(true)

  // ── iFood: taxa calibrada + repasses importados + importação ──
  const [ifoodRates, setIfoodRates]   = useState({})
  const [repassesImp, setRepassesImp] = useState([])
  const [importing, setImporting]     = useState(false)
  const [importMsg, setImportMsg]     = useState(null)
  const [entExp, setEntExp]           = useState(false)
  const fileRef = useRef(null)

  async function loadDelivery() {
    setLoadingD(true)
    const { start, end } = rangeFin(periodoD, custIni, custFim)
    // Pagina pra não perder pedidos (Supabase corta em 1000/request).
    const pedRes = await fetchAll(() => {
      let q = supabase
        .from('pedidos_delivery')
        .select('origem, total, forma_pagamento, subtotal, taxa_entrega, ifood_valores')
        .neq('status', 'cancelado')
        .order('created_at', { ascending: false })
      if (start) q = q.gte('created_at', start)
      if (end)   q = q.lt('created_at', end)
      return q
    })
    setPedidos(pedRes.data ?? [])
    setLoadingD(false)
  }
  useEffect(() => { loadDelivery() }, [periodoD, custIni, custFim])

  // Taxa calibrada da loja + repasses reais já importados no período
  async function loadIfoodExtra() {
    if (!empresaId) return
    const { start, end } = rangeFin(periodoD, custIni, custFim)
    const [empRes, repRes] = await Promise.all([
      supabase.from('empresas').select('ifood_comissao_pct, ifood_transacao_pct').eq('id', empresaId).maybeSingle(),
      (() => {
        let q = supabase.from('ifood_repasses').select('*').order('dia', { ascending: true })
        if (start) q = q.gte('dia', start.slice(0, 10))
        if (end)   q = q.lt('dia', end.slice(0, 10))
        return q
      })(),
    ])
    setIfoodRates({ comissao: empRes.data?.ifood_comissao_pct, transacao: empRes.data?.ifood_transacao_pct })
    setRepassesImp(repRes.data ?? [])
  }
  useEffect(() => { loadIfoodExtra() }, [periodoD, custIni, custFim, empresaId])

  async function onImportarIfood(e) {
    const file = e.target.files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file || !empresaId) return
    setImporting(true); setImportMsg(null)
    try {
      const { dias, totais, calibracao, comparativo, meta } = await parseIfoodPlanilha(file)
      if (!dias.length) throw new Error('Não achei pedidos concluídos na planilha.')
      const rows = dias.map(d => ({ empresa_id: empresaId, ...d }))
      const { error: upErr } = await supabase.from('ifood_repasses').upsert(rows, { onConflict: 'empresa_id,dia' })
      if (upErr) throw upErr
      await supabase.from('empresas').update({
        ifood_comissao_pct: calibracao.comissao_pct,
        ifood_transacao_pct: calibracao.transacao_pct,
      }).eq('id', empresaId)
      setImportMsg({
        tipo: 'ok',
        dias: dias.length,
        pedidos: totais.pedidos,
        liquido: totais.valor_liquido,
        comissaoPct: Math.round(calibracao.comissao_pct * 1000) / 10,
        difTaxa: comparativo.taxaEstimada - comparativo.taxaReal,
        cancelados: meta.cancelados,
      })
      await loadIfoodExtra()
    } catch (err) {
      setImportMsg({ tipo: 'erro', txt: err.message || 'Falha ao ler a planilha.' })
    }
    setImporting(false)
  }

  // ── Vendas por canal (próprios) ──
  const pedWA  = pedidos.filter(p => p.origem === 'whatsapp')
  const pedApp = pedidos.filter(p => p.origem === 'app')
  const pedCat = pedidos.filter(p => !p.origem || p.origem === 'cardapio')
  const volWA  = pedWA.reduce((s, p)  => s + Number(p.total || 0), 0)
  const volApp = pedApp.reduce((s, p) => s + Number(p.total || 0), 0)
  const volCat = pedCat.reduce((s, p) => s + Number(p.total || 0), 0)
  const volTotal = volWA + volApp + volCat

  // ── iFood: líquido (importado = exato; senão estimado com a taxa calibrada) ──
  const pedIfood = pedidos.filter(p => p.origem === 'ifood')
  const ifoodEst = calcIfoodLiquido(pedIfood, ifoodRates)
  const imp = repassesImp.reduce((s, r) => ({
    valor_liquido: s.valor_liquido + Number(r.valor_liquido || 0),
    recebidoEntrega: s.recebidoEntrega + Number(r.recebido_entrega || 0),
    taxasTotal: s.taxasTotal + Number(r.taxas || 0),
    vendas: s.vendas + Number(r.vendas || 0),
  }), { valor_liquido: 0, recebidoEntrega: 0, taxasTotal: 0, vendas: 0 })
  const temImportado = repassesImp.length > 0
  const ifood = temImportado
    ? {
        repasse: imp.valor_liquido,
        recebidoEntrega: imp.recebidoEntrega,
        taxasTotal: imp.taxasTotal,
        voceRecebe: imp.valor_liquido + imp.recebidoEntrega,
        pctTaxa: imp.vendas > 0 ? Math.round(imp.taxasTotal / imp.vendas * 100) : 0,
      }
    : ifoodEst

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h1>Financeiro</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {periodoD === 'custom' && (
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
              <button key={id} type="button" onClick={() => setPeriodoD(id)}
                style={{ padding: '6px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  background: periodoD === id ? 'var(--primary)' : 'transparent', color: periodoD === id ? '#fff' : 'var(--text-muted)' }}>
                {lb}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── VENDAS POR CANAL ── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
        Vendas por canal
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 24 }}>
        {[
          { label: 'WhatsApp',     vol: volWA,  qtd: pedWA.length,  cor: '#25d366' },
          { label: 'App / Portal', vol: volApp, qtd: pedApp.length, cor: '#f97316' },
          { label: 'Catálogo',     vol: volCat, qtd: pedCat.length, cor: 'var(--primary)' },
        ].map(({ label, vol, qtd, cor }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: `4px solid ${cor}`, borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 900 }}>{fmtBRL(vol)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{qtd} pedido{qtd !== 1 ? 's' : ''}</div>
          </div>
        ))}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>Total (canal próprio)</div>
          <div style={{ fontSize: 20, fontWeight: 900 }}>{fmtBRL(volTotal)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{pedWA.length + pedApp.length + pedCat.length} pedido{(pedWA.length + pedApp.length + pedCat.length) !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {/* ── iFOOD — LÍQUIDO (importado = exato / senão estimado) ── */}
      {(pedIfood.length > 0 || temImportado) && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><IfoodIcon size={18} /> iFood — seu dinheiro</span>
            {temImportado ? (
              <span title="Valores exatos, do extrato do iFood que você importou."
                style={{ fontSize: 10, fontWeight: 700, color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 20, padding: '2px 8px', textTransform: 'none', letterSpacing: 0 }}>
                exato ✔ (importado)
              </span>
            ) : (
              <span title="Repasse estimado com base nas taxas do iFood (comissão + transação no pago online). Bate ~99% com o extrato. Importe a planilha pra ver o valor exato e calibrar a taxa da sua loja."
                style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 20, padding: '2px 8px', cursor: 'help', textTransform: 'none', letterSpacing: 0 }}>
                estimado ⓘ
              </span>
            )}
            <span style={{ flex: 1 }} />
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onImportarIfood} style={{ display: 'none' }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={importing}
              style={{ fontSize: 11, fontWeight: 700, color: 'var(--primary)', background: 'transparent', border: '1px solid var(--primary)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', textTransform: 'none', letterSpacing: 0 }}>
              {importing ? 'Importando…' : '📄 Importar planilha do iFood'}
            </button>
          </div>
          {importMsg && (
            <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
              background: importMsg.tipo === 'ok' ? 'rgba(22,163,74,.10)' : 'rgba(239,68,68,.10)',
              border: `1px solid ${importMsg.tipo === 'ok' ? 'rgba(22,163,74,.4)' : 'rgba(239,68,68,.4)'}` }}>
              {importMsg.tipo === 'ok' ? (
                <>
                  ✅ <strong>Planilha importada!</strong> {importMsg.dias} dia{importMsg.dias > 1 ? 's' : ''} · {importMsg.pedidos} pedidos · repasse real <strong>{fmtBRL(importMsg.liquido)}</strong>
                  {importMsg.cancelados > 0 && <span style={{ color: 'var(--text-muted)' }}> ({importMsg.cancelados} cancelados ignorados)</span>}
                  <br />
                  🎯 Nossa estimativa errou só <strong>{fmtBRL(Math.abs(importMsg.difTaxa))}</strong> em taxas. Taxa da sua loja calibrada em <strong>{importMsg.comissaoPct}%</strong> de comissão — as próximas estimativas já usam ela.
                </>
              ) : (
                <>⚠️ {importMsg.txt}</>
              )}
            </div>
          )}
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '6px 20px 4px', marginBottom: 28 }}>
            {/* 💵 Já na mão (recebido na entrega — bruto, pra bater o caixa) */}
            {ifood.recebidoEntrega > 0 && (
              <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div onClick={() => ifood.entregaForma && setEntExp(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: ifood.entregaForma ? 'pointer' : 'default', userSelect: 'none' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>
                      {ifood.entregaForma && <span style={{ display: 'inline-block', width: 14, color: 'var(--text-muted)', transform: entExp ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>}
                      💵 Já na sua mão
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>dinheiro/cartão na entrega — pra bater o caixa{ifood.entregaForma ? ' · toque pra abrir' : ''}</div>
                  </div>
                  <span style={{ fontSize: 22, fontWeight: 900 }}>{fmtBRL(ifood.recebidoEntrega)}</span>
                </div>
                {entExp && ifood.entregaForma && (
                  <div style={{ margin: '10px 0 2px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {Object.entries(ifood.entregaForma).sort((a, b) => b[1].total - a[1].total).map(([forma, d]) => (
                      <div key={forma} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)' }}>
                        <span>{FORMA_ENTREGA_LABEL[forma] || forma} <span style={{ fontSize: 11.5 }}>· {d.qtd} pedido{d.qtd !== 1 ? 's' : ''}</span></span>
                        <strong style={{ color: 'var(--text)' }}>{fmtBRL(d.total)}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* 🏦 iFood vai te pagar (repasse) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>🏦 iFood vai te pagar</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>repasse que cai na sua conta</div>
              </div>
              <span style={{ fontSize: 22, fontWeight: 900, color: 'var(--success)' }}>{temImportado ? '' : '≈ '}{fmtBRL(ifood.repasse)}</span>
            </div>
            {/* 🔻 iFood ficou com (o diferencial) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 0' }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--danger)' }}>🔻 iFood ficou com</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>comissão + taxa das suas vendas</div>
              </div>
              <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--danger)' }}>
                {fmtBRL(ifood.taxasTotal)} <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>({ifood.pctTaxa}%)</span>
              </span>
            </div>
          </div>
        </>
      )}

      {loadingD && <p style={{ color: 'var(--text-muted)' }}>Carregando…</p>}
    </div>
  )
}
