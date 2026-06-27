import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

// ── Reservas ────────────────────────────────────────────────
const OCASIOES = [
  { value: 'normal',      label: 'Normal',       icon: '🍽️' },
  { value: 'aniversario', label: 'Aniversário',  icon: '🎂' },
  { value: 'comemoracao', label: 'Comemoração',  icon: '🎉' },
  { value: 'reuniao',     label: 'Reunião',      icon: '💼' },
  { value: 'outro',       label: 'Outro',        icon: '📌' },
]
const ocasiaoInfo = (v) => OCASIOES.find(o => o.value === v) ?? OCASIOES[0]

const RES_STATUS = {
  pendente:       { label: 'Pendente',         bg: 'rgba(234,179,8,.14)',  cor: '#a16207' },
  confirmada:     { label: 'Confirmada',       bg: 'rgba(59,130,246,.14)', cor: '#1d4ed8' },
  cumprida:       { label: 'Compareceu',       bg: 'rgba(34,197,94,.14)',  cor: '#16a34a' },
  cancelada:      { label: 'Cancelada',        bg: 'rgba(239,68,68,.12)',  cor: '#dc2626' },
  nao_compareceu: { label: 'Não compareceu',   bg: 'rgba(148,163,184,.18)',cor: '#64748b' },
}

const FILA_STATUS = {
  aguardando: { label: 'Aguardando', bg: 'rgba(234,179,8,.14)',  cor: '#a16207' },
  chamado:    { label: 'Chamado',    bg: 'rgba(59,130,246,.14)', cor: '#1d4ed8' },
}

const hojeISO = () => new Date().toISOString().slice(0, 10)

function fmtData(d) {
  if (!d) return ''
  const dt = new Date(`${d}T00:00:00`)
  return dt.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
}
function fmtHora(h) {
  return h ? String(h).slice(0, 5) : ''
}
function esperaMin(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
}

export default function PresencialReservas() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [aba, setAba] = useState('reservas')
  const [mesas, setMesas] = useState([])
  const [reservas, setReservas] = useState([])
  const [fila, setFila] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const [verPassadas, setVerPassadas] = useState(false)

  // form reserva
  const [rNome, setRNome] = useState('')
  const [rTel, setRTel] = useState('')
  const [rData, setRData] = useState(hojeISO())
  const [rHora, setRHora] = useState('19:00')
  const [rPessoas, setRPessoas] = useState(2)
  const [rMesa, setRMesa] = useState('')
  const [rOcasiao, setROcasiao] = useState('normal')
  const [rObs, setRObs] = useState('')
  const [rSalvando, setRSalvando] = useState(false)

  // form fila
  const [fNome, setFNome] = useState('')
  const [fTel, setFTel] = useState('')
  const [fPessoas, setFPessoas] = useState(2)
  const [fObs, setFObs] = useState('')
  const [fSalvando, setFSalvando] = useState(false)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    const [mesasRes, reservasRes, filaRes] = await Promise.all([
      supabase.from('mesas').select('id, numero, nome, capacidade').eq('empresa_id', empresaId).eq('ativa', true).order('numero'),
      supabase.from('reservas').select('*').eq('empresa_id', empresaId).order('data_reserva').order('hora_reserva'),
      supabase.from('fila_espera').select('*').eq('empresa_id', empresaId).in('status', ['aguardando', 'chamado']).order('created_at'),
    ])
    setMesas(mesasRes.data ?? [])
    setReservas(reservasRes.data ?? [])
    setFila(filaRes.data ?? [])
    setLoading(false)
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  // ── Ações reservas ──
  async function addReserva(e) {
    e.preventDefault()
    setErro(null)
    if (!rNome.trim()) { setErro('Informe o nome do cliente.'); return }
    if (!rData || !rHora) { setErro('Informe data e horário.'); return }
    setRSalvando(true)
    const { error } = await supabase.from('reservas').insert({
      empresa_id: empresaId,
      cliente_nome: rNome.trim(),
      cliente_telefone: rTel.trim() || null,
      data_reserva: rData,
      hora_reserva: rHora,
      num_pessoas: parseInt(rPessoas, 10) || 1,
      mesa_id: rMesa || null,
      ocasiao: rOcasiao,
      observacoes: rObs.trim() || null,
    })
    setRSalvando(false)
    if (error) { setErro(error.message); return }
    setRNome(''); setRTel(''); setRPessoas(2); setRMesa(''); setROcasiao('normal'); setRObs('')
    carregar()
  }

  async function mudarStatusReserva(r, novo) {
    await supabase.from('reservas').update({ status: novo }).eq('id', r.id)
    // Mantém a mesa em sincronia: confirmar reserva com mesa → reservada; ao encerrar → livre
    if (r.mesa_id) {
      if (novo === 'confirmada') {
        await supabase.from('mesas').update({ status: 'reservada' }).eq('id', r.mesa_id).eq('status', 'livre')
      } else if (['cumprida', 'cancelada', 'nao_compareceu'].includes(novo)) {
        await supabase.from('mesas').update({ status: 'livre' }).eq('id', r.mesa_id).eq('status', 'reservada')
      }
    }
    carregar()
  }

  async function excluirReserva(id) {
    if (!window.confirm('Excluir esta reserva?')) return
    await supabase.from('reservas').delete().eq('id', id)
    carregar()
  }

  // ── Ações fila ──
  async function addFila(e) {
    e.preventDefault()
    setErro(null)
    if (!fNome.trim()) { setErro('Informe o nome do cliente.'); return }
    setFSalvando(true)
    const { error } = await supabase.from('fila_espera').insert({
      empresa_id: empresaId,
      cliente_nome: fNome.trim(),
      cliente_telefone: fTel.trim() || null,
      num_pessoas: parseInt(fPessoas, 10) || 1,
      observacoes: fObs.trim() || null,
    })
    setFSalvando(false)
    if (error) { setErro(error.message); return }
    setFNome(''); setFTel(''); setFPessoas(2); setFObs('')
    carregar()
  }

  async function mudarStatusFila(item, novo) {
    const patch = { status: novo }
    if (novo === 'chamado') patch.chamado_at = new Date().toISOString()
    await supabase.from('fila_espera').update(patch).eq('id', item.id)
    carregar()
  }

  if (loading) return <div className="page"><p>Carregando...</p></div>

  const hoje = hojeISO()
  const reservasVisiveis = verPassadas ? reservas : reservas.filter(r => r.data_reserva >= hoje)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Reservas e fila</h1>
          <p className="page-subtitle">Agende mesas e gerencie a fila de espera do salão.</p>
        </div>
      </div>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {[
          { id: 'reservas', label: `Reservas${reservasVisiveis.length ? ` (${reservasVisiveis.length})` : ''}` },
          { id: 'fila', label: `Fila de espera${fila.length ? ` (${fila.length})` : ''}` },
        ].map(t => (
          <button key={t.id} type="button" onClick={() => { setAba(t.id); setErro(null) }}
            style={{
              padding: '8px 16px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
              border: `1.5px solid ${aba === t.id ? 'var(--primary)' : 'var(--border)'}`,
              background: aba === t.id ? 'rgba(134,59,255,.12)' : 'transparent',
              color: aba === t.id ? 'var(--primary)' : 'var(--text)',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {erro && <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--danger)' }}>{erro}</div>}

      {/* ───────── ABA RESERVAS ───────── */}
      {aba === 'reservas' && (
        <>
          <form className="card" onSubmit={addReserva} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-field" style={{ flex: 1, minWidth: 160 }}>
                <label>Cliente *</label>
                <input value={rNome} onChange={e => setRNome(e.target.value)} placeholder="Nome de quem reservou" />
              </div>
              <div className="form-field" style={{ width: 150 }}>
                <label>Telefone</label>
                <input value={rTel} onChange={e => setRTel(e.target.value)} placeholder="(opcional)" />
              </div>
              <div className="form-field" style={{ width: 150 }}>
                <label>Data *</label>
                <input type="date" value={rData} min={hoje} onChange={e => setRData(e.target.value)} />
              </div>
              <div className="form-field" style={{ width: 110 }}>
                <label>Horário *</label>
                <input type="time" value={rHora} onChange={e => setRHora(e.target.value)} />
              </div>
              <div className="form-field" style={{ width: 90 }}>
                <label>Pessoas</label>
                <input type="number" min="1" value={rPessoas} onChange={e => setRPessoas(e.target.value)} />
              </div>
              <div className="form-field" style={{ width: 150 }}>
                <label>Mesa (opcional)</label>
                <select value={rMesa} onChange={e => setRMesa(e.target.value)}>
                  <option value="">A definir</option>
                  {mesas.map(m => (
                    <option key={m.id} value={m.id}>Mesa {m.numero}{m.nome ? ` · ${m.nome}` : ''} ({m.capacidade}p)</option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ width: 150 }}>
                <label>Ocasião</label>
                <select value={rOcasiao} onChange={e => setROcasiao(e.target.value)}>
                  {OCASIOES.map(o => <option key={o.value} value={o.value}>{o.icon} {o.label}</option>)}
                </select>
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 160 }}>
                <label>Observações</label>
                <input value={rObs} onChange={e => setRObs(e.target.value)} placeholder="Ex: perto da janela, bolo às 21h..." />
              </div>
              <button type="submit" className="btn btn-primary" disabled={rSalvando} style={{ height: 40 }}>
                {rSalvando ? 'Salvando...' : '+ Reservar'}
              </button>
            </div>
          </form>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <label style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={verPassadas} onChange={e => setVerPassadas(e.target.checked)} />
              Mostrar reservas passadas
            </label>
          </div>

          {reservasVisiveis.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
              Nenhuma reserva {verPassadas ? 'cadastrada' : 'a partir de hoje'}. 📅
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {reservasVisiveis.map(r => {
                const st = RES_STATUS[r.status] ?? RES_STATUS.pendente
                const oc = ocasiaoInfo(r.ocasiao)
                const mesa = mesas.find(m => m.id === r.mesa_id)
                const encerrada = ['cumprida', 'cancelada', 'nao_compareceu'].includes(r.status)
                return (
                  <div key={r.id} className="card" style={{ padding: 14, opacity: encerrada ? 0.7 : 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ fontWeight: 800, fontSize: 16 }}>
                        {oc.value !== 'normal' && <span style={{ marginRight: 4 }}>{oc.icon}</span>}
                        {r.cliente_nome}
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: st.bg, color: st.cor, whiteSpace: 'nowrap' }}>
                        {st.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
                      <span>📅 {fmtData(r.data_reserva)} · {fmtHora(r.hora_reserva)}</span>
                      <span>👥 {r.num_pessoas}</span>
                      {mesa && <span>🪑 Mesa {mesa.numero}</span>}
                      {oc.value !== 'normal' && <span>{oc.icon} {oc.label}</span>}
                    </div>
                    {r.cliente_telefone && (
                      <div style={{ fontSize: 13, marginTop: 4 }}>
                        <a href={`tel:${r.cliente_telefone}`} style={{ color: 'var(--primary)' }}>📞 {r.cliente_telefone}</a>
                      </div>
                    )}
                    {r.observacoes && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>“{r.observacoes}”</div>}

                    {/* Ações */}
                    <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                      {r.status === 'pendente' && (
                        <button type="button" onClick={() => mudarStatusReserva(r, 'confirmada')}
                          style={btnAcao('#1d4ed8')}>Confirmar</button>
                      )}
                      {(r.status === 'pendente' || r.status === 'confirmada') && (
                        <>
                          <button type="button" onClick={() => mudarStatusReserva(r, 'cumprida')}
                            style={btnAcao('#16a34a')}>Compareceu</button>
                          <button type="button" onClick={() => mudarStatusReserva(r, 'nao_compareceu')}
                            style={btnAcao('#64748b')}>Faltou</button>
                          <button type="button" onClick={() => mudarStatusReserva(r, 'cancelada')}
                            style={btnAcao('#dc2626')}>Cancelar</button>
                        </>
                      )}
                      {encerrada && (
                        <button type="button" onClick={() => excluirReserva(r.id)}
                          style={btnAcao('#dc2626', true)}>Excluir</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ───────── ABA FILA ───────── */}
      {aba === 'fila' && (
        <>
          <form className="card" onSubmit={addFila} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="form-field" style={{ flex: 1, minWidth: 160 }}>
                <label>Cliente *</label>
                <input value={fNome} onChange={e => setFNome(e.target.value)} placeholder="Nome de quem está esperando" />
              </div>
              <div className="form-field" style={{ width: 150 }}>
                <label>Telefone</label>
                <input value={fTel} onChange={e => setFTel(e.target.value)} placeholder="(opcional)" />
              </div>
              <div className="form-field" style={{ width: 90 }}>
                <label>Pessoas</label>
                <input type="number" min="1" value={fPessoas} onChange={e => setFPessoas(e.target.value)} />
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 160 }}>
                <label>Observações</label>
                <input value={fObs} onChange={e => setFObs(e.target.value)} placeholder="Ex: aceita mesa externa" />
              </div>
              <button type="submit" className="btn btn-primary" disabled={fSalvando} style={{ height: 40 }}>
                {fSalvando ? 'Salvando...' : '+ Entrar na fila'}
              </button>
            </div>
          </form>

          {fila.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
              Ninguém na fila no momento. ✅
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {fila.map((item, i) => {
                const st = FILA_STATUS[item.status] ?? FILA_STATUS.aguardando
                const espera = esperaMin(item.created_at)
                return (
                  <div key={item.id} className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                      background: 'var(--primary)', color: '#fff', fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
                    }}>{i + 1}</div>
                    <div style={{ flex: 1, minWidth: 150 }}>
                      <div style={{ fontWeight: 800, fontSize: 16 }}>{item.cliente_nome}</div>
                      <div style={{ fontSize: 13, color: 'var(--text-muted)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <span>👥 {item.num_pessoas}</span>
                        <span>⏱ {espera} min na fila</span>
                        {item.cliente_telefone && <a href={`tel:${item.cliente_telefone}`} style={{ color: 'var(--primary)' }}>📞 {item.cliente_telefone}</a>}
                      </div>
                      {item.observacoes && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2 }}>“{item.observacoes}”</div>}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: st.bg, color: st.cor, whiteSpace: 'nowrap' }}>
                      {st.label}
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {item.status === 'aguardando' && (
                        <button type="button" onClick={() => mudarStatusFila(item, 'chamado')} style={btnAcao('#1d4ed8')}>Chamar</button>
                      )}
                      <button type="button" onClick={() => mudarStatusFila(item, 'sentou')} style={btnAcao('#16a34a')}>Sentou</button>
                      <button type="button" onClick={() => mudarStatusFila(item, 'desistiu')} style={btnAcao('#dc2626')}>Desistiu</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function btnAcao(cor, outline = false) {
  return {
    fontSize: 12.5, fontWeight: 700, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
    border: `1.5px solid ${cor}`,
    background: outline ? 'transparent' : cor,
    color: outline ? cor : '#fff',
  }
}
