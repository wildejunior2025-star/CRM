import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import FeriadosLoja from '../components/FeriadosLoja'
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
  // Pedido agendado (mig 0222): mora aqui porque quem decide isso está mexendo
  // justamente na grade de horário da loja.
  const [ag, setAg] = useState({ ativo: false, dias: 2, antecedencia: 60, libera: 45 })
  // Janelas de entrega do agendamento (mig 0225): [{ i, f, limite }]. Valem em
  // todo dia que a loja abre — a grade acima é que decide quais dias.
  const [faixas, setFaixas] = useState([])

  useEffect(() => {
    if (!profile?.empresa_id) return
    supabase
      .from('empresas')
      .select('id, horario_abertura, horario_fechamento, horarios_funcionamento, agendamento_ativo, agendamento_dias, agendamento_antecedencia_min, agendamento_libera_min, agendamento_faixas')
      .eq('id', profile.empresa_id)
      .single()
      .then(({ data }) => {
        if (!data) return
        setEmpresaId(data.id)
        setHorarios(normalizaHorarios(data.horarios_funcionamento, data.horario_abertura, data.horario_fechamento))
        setAg({
          ativo: !!data.agendamento_ativo,
          dias: Number(data.agendamento_dias ?? 2),
          antecedencia: Number(data.agendamento_antecedencia_min ?? 60),
          libera: Number(data.agendamento_libera_min ?? 45),
        })
        setFaixas(Array.isArray(data.agendamento_faixas) ? data.agendamento_faixas : [])
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
      .update({
        horarios_funcionamento: horarios,
        agendamento_ativo: ag.ativo,
        agendamento_dias: Math.max(0, Math.min(30, Number(ag.dias) || 0)),
        agendamento_antecedencia_min: Math.max(0, Math.min(1440, Number(ag.antecedencia) || 0)),
        agendamento_libera_min: Math.max(0, Math.min(1440, Number(ag.libera) || 0)),
        // Faixa sem começo ou sem fim não vale nada: sai na hora de salvar em
        // vez de virar horário fantasma no cardápio.
        agendamento_faixas: faixas
          .filter(f => f.i && f.f)
          .map(f => ({ i: f.i, f: f.f, limite: Math.max(0, Number(f.limite) || 0) })),
      })
      .eq('id', empresaId)
    setSalvando(false)
    if (error) { setMsg({ type: 'error', text: `Erro: ${error.message}` }); return }
    setMsg({ type: 'success', text: 'Horários e agendamento salvos.' })
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

      {/* Pedido agendado: o cliente escolhe dia e hora dentro da grade acima.
          Nasceu de quem decide o almoço às 8h da manhã, com a loja fechada — o
          cardápio não deixava nem montar a sacola. */}
      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, margin: '0 0 6px' }}>🗓️ Pedido agendado</h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px' }}>
          Deixa o cliente marcar dia e hora na Loja Online — inclusive com a loja fechada.
          Ele só consegue escolher horário em que a loja abre (a grade acima manda, e feriado/folga também).
          No painel o pedido fica numa aba <strong>Agendados</strong>: não toca e não imprime até perto da hora.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
          <input type="checkbox" checked={ag.ativo} onChange={e => setAg(a => ({ ...a, ativo: e.target.checked }))} />
          Aceitar pedidos agendados
        </label>

        {ag.ativo && (
          <>
          {/* Janelas de entrega. É aqui que a loja diz o que consegue cumprir:
              "08:00 às 18:00, até 10 pedidos" (sem prometer hora cravada) ou
              faixas curtas de meia em meia hora, se ela trabalha assim.
              Usa a mesma grade das faixas por km (RaioEntrega.css) — é a
              mesma ideia de tabela, e o lojista já conhece o desenho. */}
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 4px' }}>Janelas de entrega</h3>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 14px', lineHeight: 1.55, maxWidth: 620 }}>
              O cliente escolhe uma <strong>janela</strong>, não uma hora exata — assim ninguém cobra
              entrega “às 14:30 em ponto”. O <strong>limite</strong> de cada janela deve ser pensado no seu
              <strong> dia mais forte</strong>: no dia fraco ele nem chega perto. Limite <strong>0</strong> = sem limite.
            </p>

            {faixas.length === 0 ? (
              <div style={{
                padding: '12px 14px', borderRadius: 10, marginBottom: 12,
                background: 'rgba(234,179,8,.10)', border: '1px solid rgba(234,179,8,.35)',
                fontSize: 12.5, color: '#eab308', lineHeight: 1.5,
              }}>
                Sem janela cadastrada o cliente <strong>não consegue agendar</strong>. Adicione pelo menos uma.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 620 }}>
                <div className="re-faixas-header">
                  <span className="re-faixas-col-label">De</span>
                  <span className="re-faixas-col-label">Até</span>
                  <span className="re-faixas-col-label">Máx. de pedidos</span>
                  <span />
                </div>
                {faixas.map((f, i) => (
                  <div className="re-faixas-row" key={i}>
                    <input type="time" value={f.i ?? ''} aria-label="Começo da janela"
                      onChange={e => setFaixas(fs => fs.map((x, j) => (j === i ? { ...x, i: e.target.value } : x)))} />
                    <input type="time" value={f.f ?? ''} aria-label="Fim da janela"
                      onChange={e => setFaixas(fs => fs.map((x, j) => (j === i ? { ...x, f: e.target.value } : x)))} />
                    <input type="number" min="0" inputMode="numeric" value={f.limite ?? 0} aria-label="Máximo de pedidos"
                      onChange={e => setFaixas(fs => fs.map((x, j) => (j === i ? { ...x, limite: e.target.value } : x)))} />
                    <button type="button" className="re-faixas-remove" title="Remover janela"
                      onClick={() => setFaixas(fs => fs.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
              </div>
            )}

            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
              onClick={() => setFaixas(fs => [...fs, { i: '08:00', f: '18:00', limite: 10 }])}>
              + Adicionar janela
            </button>
          </div>

          <div className="re-ag-opcoes">
            <label>
              <span className="re-faixas-col-label">Até quantos dias à frente</span>
              <input type="number" min="0" max="30" value={ag.dias}
                onChange={e => setAg(a => ({ ...a, dias: e.target.value }))} />
              <small>0 = só hoje · 2 = hoje, amanhã e depois</small>
            </label>
            <label>
              <span className="re-faixas-col-label">Antecedência mínima</span>
              <input type="number" min="0" max="1440" step="15" value={ag.antecedencia}
                onChange={e => setAg(a => ({ ...a, antecedencia: e.target.value }))} />
              <small>em minutos — ninguém agenda pra daqui a 5 min</small>
            </label>
            <label>
              <span className="re-faixas-col-label">Cai na cozinha</span>
              <input type="number" min="0" max="1440" step="5" value={ag.libera}
                onChange={e => setAg(a => ({ ...a, libera: e.target.value }))} />
              <small>minutos antes da janela começar — aí ele imprime</small>
            </label>
          </div>
          </>
        )}
      </div>

      {msg && (
        <div className={`re-msg ${msg.type}`} style={{ marginTop: 14 }}>{msg.text}</div>
      )}

      <div style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={handleSalvar} disabled={salvando}>
          {salvando ? 'Salvando...' : 'Salvar horários e agendamento'}
        </button>
      </div>

      {/* Exceções por data (feriado, folga). Salva sozinho, sem o botão acima. */}
      <FeriadosLoja empresaId={empresaId} grade={horarios} />
    </div>
  )
}
