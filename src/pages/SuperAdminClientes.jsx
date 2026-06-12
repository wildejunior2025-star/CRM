import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

export default function SuperAdminClientes() {
  const [clientes, setClientes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busca, setBusca] = useState('')
  const [bloqueandoId, setBloqueandoId] = useState(null)
  const [acessandoId, setAcessandoId] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)

    // Busca todos os profiles com perfil='cliente' e empresa_id=null (clientes do marketplace)
    const { data, error } = await supabase
      .from('profiles')
      .select('id, nome, email, ativo, created_at')
      .eq('perfil', 'cliente')
      .is('empresa_id', null)
      .order('created_at', { ascending: false })

    if (error) setError(error.message)
    setClientes(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function toggleAtivo(cliente) {
    setBloqueandoId(cliente.id)
    const novoAtivo = !cliente.ativo
    const { error } = await supabase
      .from('profiles')
      .update({ ativo: novoAtivo })
      .eq('id', cliente.id)

    setBloqueandoId(null)
    if (error) { alert(error.message); return }
    setClientes(prev => prev.map(c => c.id === cliente.id ? { ...c, ativo: novoAtivo } : c))
  }

  async function acessarCliente(cliente) {
    setAcessandoId(cliente.id)
    setError(null)

    const { data: { session: currentSession } } = await supabase.auth.getSession()
    if (currentSession) {
      localStorage.setItem('crm_superadmin_backup', JSON.stringify({
        access_token: currentSession.access_token,
        refresh_token: currentSession.refresh_token,
      }))
      localStorage.setItem('crm_superadmin_cliente_nome', cliente.nome || cliente.email || 'Cliente')
    }

    const { data, error } = await supabase.functions.invoke('impersonate-user', {
      body: { user_id: cliente.id, redirect_to: `${window.location.origin}/portal` },
    })

    setAcessandoId(null)

    if (error || !data?.link) {
      localStorage.removeItem('crm_superadmin_backup')
      localStorage.removeItem('crm_superadmin_cliente_nome')
      setError(error?.message ?? data?.error ?? 'Erro ao gerar acesso')
      return
    }

    window.location.href = data.link
  }

  const clientesFiltrados = clientes.filter(c => {
    const q = busca.toLowerCase()
    return !q || c.nome?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)
  })

  return (
    <div>
      <div className="page-header">
        <h1>Clientes do Marketplace</h1>
        <span className="badge badge-neutral" style={{ fontSize: 14, padding: '4px 12px' }}>
          {clientes.length} cadastrados
        </span>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="card" style={{ marginBottom: 16, padding: '12px 16px' }}>
        <input
          type="search"
          placeholder="Buscar por nome ou e-mail..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 8,
            border: '1.5px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontSize: 14,
          }}
        />
      </div>

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : clientesFiltrados.length === 0 ? (
          <div className="empty-state">
            {busca ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Cadastro</th>
                <th>Status</th>
                <th>Ações</th>
              <th></th>
              </tr>
            </thead>
            <tbody>
              {clientesFiltrados.map(c => (
                <tr key={c.id} style={{ opacity: c.ativo === false ? 0.55 : 1 }}>
                  <td>{c.nome || '—'}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>{c.email || '—'}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {new Date(c.created_at).toLocaleDateString('pt-BR')}
                  </td>
                  <td>
                    <span className={`badge ${c.ativo !== false ? 'badge-success' : 'badge-danger'}`}>
                      {c.ativo !== false ? 'Ativo' : 'Bloqueado'}
                    </span>
                  </td>
                  <td>
                    <button
                      className={`btn btn-sm ${c.ativo !== false ? 'btn-secondary' : 'btn-primary'}`}
                      disabled={bloqueandoId === c.id}
                      onClick={() => toggleAtivo(c)}
                    >
                      {bloqueandoId === c.id
                        ? 'Aguarde...'
                        : c.ativo !== false ? 'Bloquear' : 'Desbloquear'}
                    </button>
                  </td>
                  <td>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={acessandoId === c.id}
                      onClick={() => acessarCliente(c)}
                    >
                      {acessandoId === c.id ? 'Acessando...' : 'Entrar como'}
                    </button>
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
