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

const emptyVendorForm = { nome: '', email: '', senha: '', telefone: '' }

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

  // Modal "Novo Vendedor"
  const [showVendorModal, setShowVendorModal] = useState(false)
  const [vendorForm, setVendorForm] = useState(emptyVendorForm)
  const [vendorError, setVendorError] = useState(null)
  const [creatingVendor, setCreatingVendor] = useState(false)
  const [mostrarSenha, setMostrarSenha] = useState(false)

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

  async function handleCreateVendor(e) {
    e.preventDefault()
    setVendorError(null)

    if (vendorForm.senha.length < 6) {
      setVendorError('A senha deve ter no mínimo 6 caracteres.')
      return
    }

    setCreatingVendor(true)

    const { data: { session } } = await supabase.auth.getSession()
    try {
      const res = await fetch('https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/create-vendor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ nome: vendorForm.nome, email: vendorForm.email, password: vendorForm.senha, telefone: vendorForm.telefone || undefined }),
      })
      const json = await res.json()
      if (!json.ok) {
        setVendorError(json.error ?? 'Erro desconhecido ao criar vendedor.')
        return
      }
      setShowVendorModal(false)
      setVendorForm(emptyVendorForm)
      await loadAll()
    } catch (err) {
      setVendorError(String(err))
    } finally {
      setCreatingVendor(false)
    }
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
        <h1>Vendedores</h1>
        <button
          className="btn btn-primary"
          onClick={() => { setVendorForm(emptyVendorForm); setVendorError(null); setShowVendorModal(true) }}
        >
          + Novo Vendedor
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}


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
      {showVendorModal && (
        <div className="modal-overlay" onClick={() => setShowVendorModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h2>Novo Vendedor</h2>
            <form onSubmit={handleCreateVendor}>
              <div className="form-field">
                <label>Nome</label>
                <input
                  required
                  value={vendorForm.nome}
                  onChange={(e) => setVendorForm((p) => ({ ...p, nome: e.target.value }))}
                  placeholder="Nome completo"
                />
              </div>
              <div className="form-field">
                <label>E-mail</label>
                <input
                  required
                  type="email"
                  value={vendorForm.email}
                  onChange={(e) => setVendorForm((p) => ({ ...p, email: e.target.value }))}
                  placeholder="vendedor@exemplo.com"
                />
              </div>
              <div className="form-field">
                <label>Senha inicial</label>
                <div style={{ position: 'relative' }}>
                  <input
                    required
                    type={mostrarSenha ? 'text' : 'password'}
                    minLength={6}
                    value={vendorForm.senha}
                    onChange={(e) => setVendorForm((p) => ({ ...p, senha: e.target.value }))}
                    placeholder="Mínimo 6 caracteres"
                    style={{ paddingRight: 44, width: '100%' }}
                  />
                  <button
                    type="button"
                    onClick={() => setMostrarSenha(v => !v)}
                    style={{
                      position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', padding: 4, display: 'flex',
                    }}
                    tabIndex={-1}
                  >
                    {mostrarSenha ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <div className="form-field">
                <label>Telefone / WhatsApp <span style={{ fontWeight: 400, color: 'var(--text-muted, #888)' }}>(opcional)</span></label>
                <input
                  type="tel"
                  value={vendorForm.telefone}
                  onChange={(e) => setVendorForm((p) => ({ ...p, telefone: e.target.value }))}
                  placeholder="(84) 99999-9999"
                />
              </div>
              {vendorError && <p className="error-text">{vendorError}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowVendorModal(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={creatingVendor}>
                  {creatingVendor ? 'Criando...' : 'Criar vendedor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
