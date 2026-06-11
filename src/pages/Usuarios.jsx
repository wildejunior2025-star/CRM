import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Usuarios.css'

const PERFIS = [
  { value: 'admin', label: 'Admin' },
  { value: 'vendedor', label: 'Vendedor' },
  { value: 'cliente', label: 'Cliente' },
]

export default function Usuarios() {
  const { user, profile, refreshProfile } = useAuth()
  const [perfis, setPerfis] = useState([])
  const [clientes, setClientes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [linkCopiado, setLinkCopiado] = useState(false)

  const linkConvite = profile?.empresa_id
    ? `${window.location.origin}/cadastro-cliente/${profile.empresa_id}`
    : null

  async function copiarLink() {
    if (!linkConvite) return
    await navigator.clipboard.writeText(linkConvite)
    setLinkCopiado(true)
    setTimeout(() => setLinkCopiado(false), 2000)
  }

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [perfisRes, clientesRes] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at'),
      supabase.from('clientes').select('id, nome').order('nome'),
    ])

    const firstError = perfisRes.error || clientesRes.error
    if (firstError) setError(firstError.message)

    setPerfis(perfisRes.data ?? [])
    setClientes(clientesRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function handlePerfilChange(profile, novoPerfil) {
    setSavingId(profile.id)
    setError(null)

    const updates = { perfil: novoPerfil }
    if (novoPerfil !== 'cliente') updates.cliente_id = null

    const { error } = await supabase.from('profiles').update(updates).eq('id', profile.id)

    setSavingId(null)

    if (error) {
      setError(error.message)
      return
    }

    setPerfis((prev) =>
      prev.map((p) => (p.id === profile.id ? { ...p, ...updates } : p))
    )

    if (profile.id === user?.id) await refreshProfile()
  }

  async function handleClienteChange(profile, clienteId) {
    setSavingId(profile.id)
    setError(null)

    const { error } = await supabase
      .from('profiles')
      .update({ cliente_id: clienteId || null })
      .eq('id', profile.id)

    setSavingId(null)

    if (error) {
      setError(error.message)
      return
    }

    setPerfis((prev) =>
      prev.map((p) => (p.id === profile.id ? { ...p, cliente_id: clienteId || null } : p))
    )

    if (profile.id === user?.id) await refreshProfile()
  }

  return (
    <div>
      <div className="page-header">
        <h1>Usuários</h1>
      </div>

      {error && <p className="error-text">{error}</p>}

      {linkConvite && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="form-field">
            <label>Link de cadastro para clientes</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={linkConvite} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={copiarLink}>
                {linkCopiado ? 'Copiado!' : 'Copiar'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : perfis.length === 0 ? (
          <div className="empty-state">Nenhum usuário encontrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Perfil</th>
                <th>Cliente vinculado</th>
              </tr>
            </thead>
            <tbody>
              {perfis.map((p) => (
                <tr key={p.id}>
                  <td>{p.nome ?? '-'}</td>
                  <td>{p.email ?? '-'}</td>
                  <td>
                    <select
                      value={p.perfil}
                      onChange={(e) => handlePerfilChange(p, e.target.value)}
                      disabled={savingId === p.id}
                    >
                      {PERFIS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {p.perfil === 'cliente' ? (
                      <select
                        value={p.cliente_id ?? ''}
                        onChange={(e) => handleClienteChange(p, e.target.value)}
                        disabled={savingId === p.id}
                      >
                        <option value="">Não vinculado</option>
                        {clientes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.nome}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="usr-muted">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
