import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const STATUS_COR = {
  livre:     { bg: 'rgba(34,197,94,.12)',  border: '#22c55e', label: 'Livre' },
  ocupada:   { bg: 'rgba(239,68,68,.12)',  border: '#ef4444', label: 'Ocupada' },
  conta:     { bg: 'rgba(234,179,8,.14)',  border: '#eab308', label: 'Fechando conta' },
  reservada: { bg: 'rgba(59,130,246,.12)', border: '#3b82f6', label: 'Reservada' },
}

export default function PresencialMesas() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [mesas, setMesas]     = useState([])
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro]       = useState(null)

  // form nova mesa
  const [numero, setNumero]         = useState('')
  const [nome, setNome]             = useState('')
  const [capacidade, setCapacidade] = useState(4)

  async function carregar() {
    if (!empresaId) return
    const { data } = await supabase.from('mesas')
      .select('*').eq('empresa_id', empresaId).order('numero')
    setMesas(data ?? [])
    setLoading(false)
    // sugere o próximo número
    const max = (data ?? []).reduce((m, x) => Math.max(m, x.numero), 0)
    setNumero(String(max + 1))
  }

  useEffect(() => { carregar() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  async function adicionar(e) {
    e.preventDefault()
    setErro(null)
    const n = parseInt(numero, 10)
    if (!n || n < 1) { setErro('Informe o número da mesa.'); return }
    if (mesas.some(m => m.numero === n)) { setErro(`Já existe a mesa ${n}.`); return }
    setSalvando(true)
    const { error } = await supabase.from('mesas').insert({
      empresa_id: empresaId,
      numero: n,
      nome: nome.trim() || null,
      capacidade: parseInt(capacidade, 10) || 4,
    })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setNome(''); setCapacidade(4)
    carregar()
  }

  async function remover(id) {
    if (!window.confirm('Remover esta mesa?')) return
    await supabase.from('mesas').delete().eq('id', id)
    carregar()
  }

  async function alternarAtiva(m) {
    await supabase.from('mesas').update({ ativa: !m.ativa }).eq('id', m.id)
    carregar()
  }

  if (loading) return <div className="page"><p>Carregando...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Mesas</h1>
          <p className="page-subtitle">Cadastre as mesas do seu salão.</p>
        </div>
      </div>

      {/* Form nova mesa */}
      <form className="card" onSubmit={adicionar} style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-field" style={{ width: 90 }}>
            <label>Número *</label>
            <input type="number" min="1" value={numero} onChange={e => setNumero(e.target.value)} />
          </div>
          <div className="form-field" style={{ flex: 1, minWidth: 160 }}>
            <label>Nome / apelido (opcional)</label>
            <input type="text" placeholder="Ex: Varanda, Balcão 1" value={nome} onChange={e => setNome(e.target.value)} />
          </div>
          <div className="form-field" style={{ width: 120 }}>
            <label>Lugares</label>
            <input type="number" min="1" value={capacidade} onChange={e => setCapacidade(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={salvando} style={{ height: 40 }}>
            {salvando ? 'Adicionando...' : '+ Adicionar mesa'}
          </button>
        </div>
        {erro && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>{erro}</div>}
      </form>

      {/* Grid de mesas */}
      {mesas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          Nenhuma mesa cadastrada ainda. Adicione a primeira acima. 🪑
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
          {mesas.map(m => {
            const cor = STATUS_COR[m.status] ?? STATUS_COR.livre
            return (
              <div key={m.id} style={{
                borderRadius: 12, padding: 14, position: 'relative',
                border: `2px solid ${m.ativa ? cor.border : 'var(--border)'}`,
                background: m.ativa ? cor.bg : 'transparent',
                opacity: m.ativa ? 1 : 0.55,
              }}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>Mesa {m.numero}</div>
                {m.nome && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{m.nome}</div>}
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  👥 {m.capacidade} lugares · {m.ativa ? cor.label : 'Inativa'}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => alternarAtiva(m)}
                    style={{ flex: 1, fontSize: 12, padding: '5px 0', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>
                    {m.ativa ? 'Desativar' : 'Ativar'}
                  </button>
                  <button type="button" onClick={() => remover(m.id)} aria-label="Remover"
                    style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)' }}>
                    🗑
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
