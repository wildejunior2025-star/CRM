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
  const [ads, setAds]         = useState({})      // { [semana_ini]: valor }
  const [abertoAtual, setAbertoAtual] = useState(false)
  const [entExp, setEntExp]   = useState(false)

  async function loadDelivery() {
    setLoadingD(true)
    const { start, end } = rangeFin(periodoD, custIni, custFim)
    const pedRes = await fetchAll(() => {
      let q = supabase.from('pedidos_delivery').select('origem, total')
        .neq('status', 'cancelado').order('created_at', { ascending: false })
      if (start) q = q.gte('created_at', start)
      if (end)   q = q.lt('created_at', end)
      return q
    })
    setPedidos(pedRes.data ?? [])
    setLoadingD(false)
  }
  useEffect(() => { loadDelivery() }, [periodoD, custIni, custFim])

  async function loadSemanas() {
    if (!empresaId) return
    const ini0 = inicioSemana()
    const desde = addDias(ini0, -7 * (NUM_SEMANAS - 1))
    const [empRes, adsRes, pedRes] = await Promise.all([
      supabase.from('empresas').select('ifood_comissao_pct, ifood_transacao_pct').eq('id', empresaId).maybeSingle(),
      supabase.from('ifood_anuncio').select('semana_ini, valor').eq('empresa_id', empresaId).gte('semana_ini', ymd(desde)),
      fetchAll(() => supabase.from('pedidos_delivery')
        .select('created_at, total, subtotal, taxa_entrega, ifood_valores, forma_pagamento')
        .eq('origem', 'ifood').neq('status', 'cancelado')
        .gte('created_at', desde.toISOString()).order('created_at', { ascending: false })),
    ])
    const rates = { comissao: empRes.data?.ifood_comissao_pct, transacao: empRes.data?.ifood_transacao_pct }
    const adMap = {}; for (const a of (adsRes.data ?? [])) adMap[a.semana_ini] = Number(a.valor || 0)

    const grupos = {}
    for (const p of (pedRes.data ?? [])) {
      const wi = inicioSemana(new Date(p.created_at)); const k = ymd(wi)
      ;(grupos[k] || (grupos[k] = { inicio: wi, peds: [] })).peds.push(p)
    }
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
    const arr = Object.values(grupos).map(g => {
      const pagamento = addDias(g.inicio, 9)
      return {
        iniYMD: ymd(g.inicio), inicio: g.inicio, fim: addDias(g.inicio, 6), pagamento,
        situacao: pagamento <= hoje ? 'pago' : 'em aberto',
        liq: calcIfoodLiquido(g.peds, rates), nped: g.peds.length,
      }
    }).sort((a, b) => b.inicio - a.inicio)
    setSemanas(arr); setAds(adMap)
  }
  useEffect(() => { loadSemanas() }, [empresaId])

  async function salvarAnuncio(iniYMD, val) {
    setAds(prev => ({ ...prev, [iniYMD]: val }))
    await supabase.from('ifood_anuncio').upsert(
      { empresa_id: empresaId, semana_ini: iniYMD, valor: val, atualizado_em: new Date().toISOString() },
      { onConflict: 'empresa_id,semana_ini' })
  }
  const aReceberDe = s => s.liq.repasse - (ads[s.iniYMD] || 0)

  // Vendas por canal próprio
  const pedWA  = pedidos.filter(p => p.origem === 'whatsapp')
  const pedApp = pedidos.filter(p => p.origem === 'app')
  const pedCat = pedidos.filter(p => !p.origem || p.origem === 'cardapio')
  const soma = arr => arr.reduce((s, p) => s + Number(p.total || 0), 0)
  const volTotal = soma(pedWA) + soma(pedApp) + soma(pedCat)

  const atual = semanas[0]
  const anteriores = semanas.slice(1)

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
            <span title="Vendas e taxas calculadas dos seus pedidos; o anúncio você informa (o iFood cobra à parte). Bate ~99% com o repasse do iFood."
              style={badge}>estimado ⓘ</span>
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid #16a34a', borderRadius: 12, padding: '4px 20px', marginBottom: 20 }}>
            {/* Headline (sempre visível) — clica pra abrir a quebra */}
            <div onClick={() => setAbertoAtual(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '14px 0', cursor: 'pointer', userSelect: 'none' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>
                  <span style={{ display: 'inline-block', width: 15, color: 'var(--text-muted)', transform: abertoAtual ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
                  = A receber na quarta
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, marginLeft: 15 }}>
                  semana {ddmm(atual.inicio)} a {ddmm(atual.fim)} · em aberto · {atual.nped} pedido{atual.nped !== 1 ? 's' : ''}
                </div>
              </div>
              <span style={{ fontSize: 24, fontWeight: 900, color: '#16a34a', whiteSpace: 'nowrap' }}>≈ {fmtBRL(aReceberDe(atual))}</span>
            </div>
            {!(ads[atual.iniYMD] > 0) && (
              <div style={{ fontSize: 11.5, color: '#f59e0b', padding: '0 0 12px', marginLeft: 15 }}>⚠️ Informe o anúncio da semana (toque pra abrir) — senão o valor fica alto.</div>
            )}
            {/* Quebra (abre na seta) */}
            {abertoAtual && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 2 }}>
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

      {/* ── SEMANAS ANTERIORES ── */}
      {anteriores.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
            Semanas anteriores
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 16px', marginBottom: 28 }}>
            {anteriores.map(s => (
              <div key={s.iniYMD} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{ddmm(s.inicio)} a {ddmm(s.fim)}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {s.situacao === 'pago'
                      ? <>✅ pago em {ddmm(s.pagamento)}</>
                      : <>🕒 cai {ddmm(s.pagamento)}</>} · {s.nped} pedidos
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span title="Anúncio da semana" style={{ fontSize: 11, color: 'var(--text-muted)' }}>📢</span>
                  <AnuncioInput small valor={ads[s.iniYMD] || 0} onSalvar={v => salvarAnuncio(s.iniYMD, v)} />
                </div>
                <div style={{ textAlign: 'right', minWidth: 110 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#16a34a' }}>≈ {fmtBRL(aReceberDe(s))}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{ads[s.iniYMD] > 0 ? 'a receber' : 'informe o anúncio'}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── VENDAS POR CANAL PRÓPRIO ── */}
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
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{pedWA.length + pedApp.length + pedCat.length} pedidos</div>
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
