import { useEffect, useState } from 'react'
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
// aceita "2.688,00", "2688,50" ou "2688.5"
const parseValor = s => {
  let x = String(s ?? '').trim().replace(/[^\d.,]/g, '')
  if (!x) return 0
  if (x.includes(',')) x = x.replace(/\./g, '').replace(',', '.')
  return Number(x) || 0
}

// Ciclo do iFood: apuração de segunda a domingo; deposita na QUARTA seguinte
// (domingo que fecha a semana + 3 dias). Ex: semana 13–19/07 → paga 22/07.
function inicioSemana(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0)
  const dow = x.getDay()
  x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1))
  return x
}
const addDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

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

export default function Financeiro() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [periodoD, setPeriodoD] = useState('mes')
  const [custIni, setCustIni]   = useState(ymd(new Date()))
  const [custFim, setCustFim]   = useState(ymd(new Date()))
  const [pedidos, setPedidos]   = useState([])
  const [loadingD, setLoadingD] = useState(true)

  // ── iFood: semana atual (a receber na quarta) + anúncio informado ──
  const [ifoodRates, setIfoodRates] = useState({})
  const [semana, setSemana]         = useState(null)
  const [anuncioVal, setAnuncioVal] = useState(0)
  const [anuncioInput, setAnuncioInput] = useState('')
  const [salvandoAnuncio, setSalvandoAnuncio] = useState(false)
  const [entExp, setEntExp]         = useState(false)

  // Vendas por canal (próprios) — respeita o filtro de período
  async function loadDelivery() {
    setLoadingD(true)
    const { start, end } = rangeFin(periodoD, custIni, custFim)
    const pedRes = await fetchAll(() => {
      let q = supabase.from('pedidos_delivery')
        .select('origem, total')
        .neq('status', 'cancelado').order('created_at', { ascending: false })
      if (start) q = q.gte('created_at', start)
      if (end)   q = q.lt('created_at', end)
      return q
    })
    setPedidos(pedRes.data ?? [])
    setLoadingD(false)
  }
  useEffect(() => { loadDelivery() }, [periodoD, custIni, custFim])

  // Semana atual do iFood (a receber na quarta) — independe do filtro
  async function loadSemana() {
    if (!empresaId) return
    const ini = inicioSemana()
    const iniYMD = ymd(ini)
    const [empRes, anuRes, pedRes] = await Promise.all([
      supabase.from('empresas').select('ifood_comissao_pct, ifood_transacao_pct').eq('id', empresaId).maybeSingle(),
      supabase.from('ifood_anuncio').select('valor').eq('empresa_id', empresaId).eq('semana_ini', iniYMD).maybeSingle(),
      fetchAll(() => supabase.from('pedidos_delivery')
        .select('total, subtotal, taxa_entrega, ifood_valores, forma_pagamento')
        .eq('origem', 'ifood').neq('status', 'cancelado')
        .gte('created_at', ini.toISOString()).order('created_at', { ascending: false })),
    ])
    const rates = { comissao: empRes.data?.ifood_comissao_pct, transacao: empRes.data?.ifood_transacao_pct }
    setIfoodRates(rates)
    const liq = calcIfoodLiquido(pedRes.data ?? [], rates)
    setSemana({ ...liq, inicio: ini, pedidos: (pedRes.data ?? []).length })
    const val = Number(anuRes.data?.valor ?? 0)
    setAnuncioVal(val)
    setAnuncioInput(val > 0 ? String(val).replace('.', ',') : '')
  }
  useEffect(() => { loadSemana() }, [empresaId])

  async function salvarAnuncio() {
    if (!empresaId || !semana) return
    const val = parseValor(anuncioInput)
    setAnuncioVal(val)
    setSalvandoAnuncio(true)
    await supabase.from('ifood_anuncio').upsert(
      { empresa_id: empresaId, semana_ini: ymd(semana.inicio), valor: val, atualizado_em: new Date().toISOString() },
      { onConflict: 'empresa_id,semana_ini' })
    setSalvandoAnuncio(false)
  }

  // Vendas por canal
  const pedWA  = pedidos.filter(p => p.origem === 'whatsapp')
  const pedApp = pedidos.filter(p => p.origem === 'app')
  const pedCat = pedidos.filter(p => !p.origem || p.origem === 'cardapio')
  const soma = arr => arr.reduce((s, p) => s + Number(p.total || 0), 0)
  const volTotal = soma(pedWA) + soma(pedApp) + soma(pedCat)

  const aReceber = semana ? semana.repasse - anuncioVal : 0
  const pagamento = semana ? addDias(semana.inicio, 9) : null   // domingo(+6) → quarta(+3)
  const fimSem = semana ? addDias(semana.inicio, 6) : null

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

      {/* ── iFOOD — A RECEBER NA QUARTA (semana atual) ── */}
      {semana && semana.pedidos > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><IfoodIcon size={18} /> iFood — a receber na quarta ({ddmm(pagamento)})</span>
            <span title="Vendas e taxas calculadas dos seus pedidos; o anúncio você informa (o iFood cobra à parte). Bate ~99% com o repasse do iFood."
              style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 20, padding: '2px 8px', cursor: 'help', textTransform: 'none', letterSpacing: 0 }}>estimado ⓘ</span>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid #16a34a', borderRadius: 12, padding: '8px 20px 4px', marginBottom: 24 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', padding: '6px 0 10px' }}>
              semana {ddmm(semana.inicio)} a {ddmm(fimSem)} · em aberto · {semana.pedidos} pedido{semana.pedidos !== 1 ? 's' : ''}
            </div>
            {/* Vendas */}
            <Linha label="Vendas (itens + entrega)" valor={fmtBRL(semana.vendasOnline)} />
            <Linha label="− Comissão + taxa" valor={`− ${fmtBRL(semana.comissaoOnline)}`} cor="var(--danger)" />
            <Linha label="− Promoções (seus cupons)" valor={`− ${fmtBRL(semana.promocoesOnline)}`} cor="var(--danger)" />
            {/* Anúncio — editável */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize: 13.5, color: 'var(--danger)' }}>− 📢 Anúncios <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(você informa — o iFood cobra à parte)</span></div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>pegue o valor do "Pacote de anúncios" no app do iFood</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>R$</span>
                <input value={anuncioInput} onChange={e => setAnuncioInput(e.target.value)} onBlur={salvarAnuncio}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} placeholder="0,00" inputMode="decimal"
                  style={{ width: 100, textAlign: 'right', padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--danger)', fontWeight: 700, fontSize: 14 }} />
              </div>
            </div>
            {/* A receber */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0 12px' }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>= A receber na quarta {salvandoAnuncio && <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>salvando…</span>}</span>
              <span style={{ fontSize: 24, fontWeight: 900, color: '#16a34a' }}>≈ {fmtBRL(aReceber)}</span>
            </div>
            {anuncioVal === 0 && (
              <div style={{ fontSize: 11.5, color: '#f59e0b', paddingBottom: 10 }}>⚠️ Informe o anúncio da semana pra ficar certo (senão o valor fica alto).</div>
            )}
          </div>

          {/* Já na sua mão (recebido na entrega — semana) */}
          {semana.recebidoEntrega > 0 && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '4px 20px', marginBottom: 28 }}>
              <div onClick={() => setEntExp(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', cursor: 'pointer', userSelect: 'none' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>
                    <span style={{ display: 'inline-block', width: 14, color: 'var(--text-muted)', transform: entExp ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                    💵 Já na sua mão <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 }}>· na entrega, esta semana · toque pra abrir</span>
                  </div>
                </div>
                <span style={{ fontSize: 20, fontWeight: 900 }}>{fmtBRL(semana.recebidoEntrega)}</span>
              </div>
              {entExp && (
                <div style={{ margin: '2px 0 12px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {Object.entries(semana.entregaForma).sort((a, b) => b[1].total - a[1].total).map(([forma, d]) => (
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

      {/* ── VENDAS POR CANAL (canal próprio, respeita o filtro) ── */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
        Vendas por canal próprio
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 24 }}>
        {[
          { label: 'WhatsApp',     vol: soma(pedWA),  qtd: pedWA.length,  cor: '#25d366' },
          { label: 'App / Portal', vol: soma(pedApp), qtd: pedApp.length, cor: '#f97316' },
          { label: 'Catálogo',     vol: soma(pedCat), qtd: pedCat.length, cor: 'var(--primary)' },
        ].map(({ label, vol, qtd, cor }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: `4px solid ${cor}`, borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 900 }}>{fmtBRL(vol)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{qtd} pedido{qtd !== 1 ? 's' : ''}</div>
          </div>
        ))}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>Total</div>
          <div style={{ fontSize: 20, fontWeight: 900 }}>{fmtBRL(volTotal)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{pedWA.length + pedApp.length + pedCat.length} pedido{(pedWA.length + pedApp.length + pedCat.length) !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {loadingD && <p style={{ color: 'var(--text-muted)' }}>Carregando…</p>}
    </div>
  )
}

function Linha({ label, valor, cor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 13.5, color: cor || 'var(--text)' }}>{label}</span>
      <strong style={{ fontSize: 14, color: cor || 'var(--text)' }}>{valor}</strong>
    </div>
  )
}
