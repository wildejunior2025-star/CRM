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
  const [busca, setBusca] = useState('')
  const [pagina, setPagina] = useState(1)
  const POR_PAGINA = 15

  const linkCliente = profile?.empresa_id
    ? `${window.location.origin}/cadastro-cliente/${profile.empresa_id}`
    : null
  const linkVendedor = profile?.empresa_id
    ? `${window.location.origin}/cadastro-vendedor/${profile.empresa_id}`
    : null

  const [linkVendedorCopiado, setLinkVendedorCopiado] = useState(false)

  async function copiarLink() {
    if (!linkCliente) return
    await navigator.clipboard.writeText(linkCliente)
    setLinkCopiado(true)
    setTimeout(() => setLinkCopiado(false), 2000)
  }

  async function copiarLinkVendedor() {
    if (!linkVendedor) return
    await navigator.clipboard.writeText(linkVendedor)
    setLinkVendedorCopiado(true)
    setTimeout(() => setLinkVendedorCopiado(false), 2000)
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

  const perfisFiltered = perfis.filter((p) => {
    const term = busca.trim().toLowerCase()
    if (!term) return true
    return p.nome?.toLowerCase().includes(term) || p.email?.toLowerCase().includes(term)
  })
  const totalPaginasUsr = Math.ceil(perfisFiltered.length / POR_PAGINA)
  const paginaUsr = Math.min(pagina, totalPaginasUsr || 1)
  const perfisVisiveis = perfisFiltered.slice((paginaUsr - 1) * POR_PAGINA, paginaUsr * POR_PAGINA)

  return (
    <div>
      <div className="page-header">
        <h1>Usuários</h1>
      </div>

      {error && <p className="error-text">{error}</p>}

      {(linkCliente || linkVendedor) && (
        <div className="card" style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {linkCliente && (
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>Link de cadastro para clientes</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input readOnly value={linkCliente} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-secondary btn-sm" onClick={copiarLink}>
                  {linkCopiado ? 'Copiado!' : 'Copiar'}
                </button>
              </div>
            </div>
          )}
          {linkVendedor && (
            <div className="form-field" style={{ marginBottom: 0 }}>
              <label>Link de cadastro para vendedores</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input readOnly value={linkVendedor} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-secondary btn-sm" onClick={copiarLinkVendedor}>
                  {linkVendedorCopiado ? 'Copiado!' : 'Copiar'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="toolbar">
        <input
          placeholder="Buscar por nome ou e-mail..."
          value={busca}
          onChange={(e) => { setBusca(e.target.value); setPagina(1) }}
        />
      </div>

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : perfisFiltered.length === 0 ? (
          <div className="empty-state">Nenhum usuário encontrado.</div>
        ) : (
          <>
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
              {perfisVisiveis.map((p) => (
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
          {totalPaginasUsr > 1 && (
            <div className="pagination">
              <button className="btn btn-secondary btn-sm" disabled={paginaUsr === 1} onClick={() => setPagina(p => p - 1)}>
                Anterior
              </button>
              <span className="pagination-info">{paginaUsr} / {totalPaginasUsr}</span>
              <button className="btn btn-secondary btn-sm" disabled={paginaUsr === totalPaginasUsr} onClick={() => setPagina(p => p + 1)}>
                Próxima
              </button>
            </div>
          )}
          </>
        )}
      </div>
    </div>
  )
}
