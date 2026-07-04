import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import './RaioEntrega.css'

const DIAS_SEMANA = ['Domingo', 'Segunda-Feira', 'Terça-Feira', 'Quarta-Feira', 'Quinta-Feira', 'Sexta-Feira', 'Sábado']

function horariosVazios() {
  return DIAS_SEMANA.map(() => ({ aberto: false, periodos: [] }))
}

// Normaliza o que vier do banco para a grade de 7 dias.
function normalizaHorarios(raw, aberturaLegado, fechamentoLegado) {
  if (Array.isArray(raw) && raw.length === 7) {
    return raw.map(d => ({
      aberto: !!d?.aberto,
      periodos: Array.isArray(d?.periodos) ? d.periodos.map(p => ({ i: p?.i ?? '', f: p?.f ?? '' })) : [],
    }))
  }
  const a = (aberturaLegado ?? '').slice(0, 5)
  const f = (fechamentoLegado ?? '').slice(0, 5)
  if (a && f) return DIAS_SEMANA.map(() => ({ aberto: true, periodos: [{ i: a, f }] }))
  return horariosVazios()
}

export default function HorariosLoja() {
  const { profile } = useAuth()
  const [empresaId, setEmpresaId] = useState(null)
  const [horarios, setHorarios] = useState(horariosVazios)
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState(null)
  const [copiaDe, setCopiaDe] = useState(null)          // idx do dia que está sendo copiado (ou null)
  const [copiaSel, setCopiaSel] = useState(() => new Set())

  useEffect(() => {
    if (!profile?.empresa_id) return
    supabase
      .from('empresas')
      .select('id, horario_abertura, horario_fechamento, horarios_funcionamento')
      .eq('id', profile.empresa_id)
      .single()
      .then(({ data }) => {
        if (!data) return
        setEmpresaId(data.id)
        setHorarios(normalizaHorarios(data.horarios_funcionamento, data.horario_abertura, data.horario_fechamento))
      })
  }, [profile?.empresa_id])

  function toggleDia(idx) {
    setHorarios(hs => hs.map((d, i) => {
      if (i !== idx) return d
      const aberto = !d.aberto
      const periodos = aberto && d.periodos.length === 0 ? [{ i: '08:00', f: '18:00' }] : d.periodos
      return { ...d, aberto, periodos }
    }))
  }
  function addPeriodo(idx) {
    setHorarios(hs => hs.map((d, i) => (i === idx ? { ...d, periodos: [...d.periodos, { i: '', f: '' }] } : d)))
  }
  function removePeriodo(idx, pi) {
    setHorarios(hs => hs.map((d, i) => (i === idx ? { ...d, periodos: d.periodos.filter((_, j) => j !== pi) } : d)))
  }
  function setPeriodoCampo(idx, pi, campo, val) {
    setHorarios(hs => hs.map((d, i) => (i === idx ? { ...d, periodos: d.periodos.map((p, j) => (j === pi ? { ...p, [campo]: val } : p)) } : d)))
  }
  function toggleCopiaDia(j) {
    setCopiaSel(s => { const n = new Set(s); n.has(j) ? n.delete(j) : n.add(j); return n })
  }
  function copiarParaDias(sourceIdx, destIdxs) {
    setHorarios(hs => {
      const base = hs[sourceIdx]
      return hs.map((d, i) => (destIdxs.includes(i)
        ? { aberto: base.aberto, periodos: base.periodos.map(p => ({ ...p })) }
        : d))
    })
  }
  function abrirCopia(idx) {
    setCopiaDe(prev => (prev === idx ? null : idx))
    setCopiaSel(new Set())
  }

  async function handleSalvar() {
    if (!empresaId) return
    setSalvando(true); setMsg(null)
    const { error } = await supabase.from('empresas')
      .update({ horarios_funcionamento: horarios })
      .eq('id', empresaId)
    setSalvando(false)
    if (error) { setMsg({ type: 'error', text: `Erro: ${error.message}` }); return }
    setMsg({ type: 'success', text: 'Horários salvos com sucesso.' })
    setTimeout(() => setMsg(null), 3000)
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Horários de Funcionamento</h1>
      </div>

      <div className="card">
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
          Defina os dias e períodos em que a loja fica <strong>aberta</strong> para receber pedidos. Fora desses horários ela aparece como fechada na Loja Online.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {horarios.map((dia, idx) => (
            <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: dia.aberto ? 10 : 0 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{DIAS_SEMANA[idx]}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: dia.aberto ? 'var(--success)' : 'var(--text-muted)' }}>
                    {dia.aberto ? 'Aberta' : 'Fechada'}
                  </span>
                  <button type="button" className={`re-switch ${dia.aberto ? 'on' : 'off'}`} onClick={() => toggleDia(idx)} aria-label="Abrir/fechar dia">
                    <span className="re-switch-thumb" />
                  </button>
                </div>
              </div>

              {dia.aberto && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {dia.periodos.map((p, pi) => (
                    <div key={pi} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input type="time" value={p.i} onChange={e => setPeriodoCampo(idx, pi, 'i', e.target.value)} style={{ width: 118 }} />
                      <span style={{ color: 'var(--text-muted)' }}>às</span>
                      <input type="time" value={p.f} onChange={e => setPeriodoCampo(idx, pi, 'f', e.target.value)} style={{ width: 118 }} />
                      <button type="button" className="btn btn-secondary btn-sm" title="Remover período" onClick={() => removePeriodo(idx, pi)} style={{ padding: '4px 9px' }}>🗑</button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 10, marginTop: 2, flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => addPeriodo(idx)} style={{ padding: '4px 10px' }}>+ Período</button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => abrirCopia(idx)} style={{ padding: '4px 10px' }} title="Copiar este horário para outros dias">⧉ Copiar para outros dias</button>
                  </div>

                  {copiaDe === idx && (
                    <div style={{ marginTop: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)' }}>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Copiar o horário de <strong>{DIAS_SEMANA[idx]}</strong> para:</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
                        {DIAS_SEMANA.map((nome, j) => (j === idx ? null : (
                          <label key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                            <input type="checkbox" checked={copiaSel.has(j)} onChange={() => toggleCopiaDia(j)} />
                            {nome.replace('-Feira', '')}
                          </label>
                        )))}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="btn btn-primary btn-sm" disabled={copiaSel.size === 0}
                          onClick={() => { copiarParaDias(idx, [...copiaSel]); setCopiaDe(null) }} style={{ padding: '4px 12px' }}>
                          Copiar{copiaSel.size > 0 ? ` (${copiaSel.size})` : ''}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCopiaDe(null)} style={{ padding: '4px 12px' }}>Cancelar</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {msg && (
        <div className={`re-msg ${msg.type}`} style={{ marginTop: 14 }}>{msg.text}</div>
      )}

      <div style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={handleSalvar} disabled={salvando}>
          {salvando ? 'Salvando...' : 'Salvar horários'}
        </button>
      </div>
    </div>
  )
}
