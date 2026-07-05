import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Usuarios.css'

// Perfis de equipe (cliente é gerenciado na tela "Clientes")
const PERFIS = [
  { value: 'admin', label: 'Admin' },
  { value: 'vendedor', label: 'Vendedor' },
  { value: 'garcom', label: 'Garçom' },
  { value: 'cozinheiro', label: 'Cozinheiro' },
  { value: 'entregador', label: 'Entregador' },
]

const emptyVendorForm = { nome: '', email: '', senha: '', telefone: '', perfil: 'entregador' }

export default function Usuarios() {
  const { user, profile, empresa, refreshProfile } = useAuth()
  const [perfis, setPerfis] = useState([])
  const [filaAtiva, setFilaAtiva] = useState(false)
  const [filaSaving, setFilaSaving] = useState(false)
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
    if (!profile?.empresa_id) { setLoading(false); return }
    setLoading(true)
    setError(null)

    // Só a equipe DESTA loja — clientes ficam na tela "Clientes"
    const { data, error } = await supabase
      .from('profiles').select('*')
      .eq('empresa_id', profile.empresa_id)
      .in('perfil', ['admin', 'vendedor', 'garcom', 'cozinheiro', 'entregador'])
      .not('ativo', 'is', false) // esconde funcionários excluídos (soft delete)
      .order('created_at')

    if (error) setError(error.message)
    setPerfis(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [profile?.empresa_id])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setFilaAtiva(!!empresa?.fila_entregador_ativa) }, [empresa?.fila_entregador_ativa])

  async function toggleFila() {
    if (!profile?.empresa_id) return
    const novo = !filaAtiva
    setFilaAtiva(novo)
    setFilaSaving(true)
    const { error } = await supabase.from('empresas').update({ fila_entregador_ativa: novo }).eq('id', profile.empresa_id)
    if (error) { setFilaAtiva(!novo); setError(error.message) }
    setFilaSaving(false)
  }

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

  // E5 — desconto por entrega do entregador (liga/desliga e valor)
  async function saveDesconto(p, patch) {
    const novo = {
      entregador_desconto_ativo: patch.ativo ?? p.entregador_desconto_ativo ?? false,
      entregador_desconto_valor: patch.valor ?? p.entregador_desconto_valor ?? 0,
    }
    setPerfis(prev => prev.map(x => (x.id === p.id ? { ...x, ...novo } : x)))
    const { error } = await supabase.from('profiles').update(novo).eq('id', p.id)
    if (error) setError(error.message)
  }

  // Excluir funcionário = soft delete (ativo=false). Não apaga de verdade pra não
  // quebrar o histórico de pedidos (entregador_id) nem o login; ele só sai da loja.
  async function handleExcluir(p) {
    if (p.id === user?.id) { setError('Você não pode excluir a si mesmo.'); return }
    if (!confirm(`Excluir o funcionário "${p.nome || p.email}"?\nEle perde o acesso à loja. O histórico de pedidos é mantido.`)) return
    setSavingId(p.id)
    setError(null)
    const { error } = await supabase.from('profiles').update({ ativo: false }).eq('id', p.id)
    setSavingId(null)
    if (error) { setError(error.message); return }
    setPerfis(prev => prev.filter(x => x.id !== p.id))
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
        body: JSON.stringify({ nome: vendorForm.nome, email: vendorForm.email, password: vendorForm.senha, telefone: vendorForm.telefone || undefined, perfil: vendorForm.perfil }),
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
        <h1>Funcionários</h1>
        <button
          className="btn btn-primary"
          onClick={() => { setVendorForm(emptyVendorForm); setVendorError(null); setShowVendorModal(true) }}
        >
          + Novo Colaborador
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* Fila de entregadores (E4) — por ordem de chegada / Online */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        border: '1px solid var(--border, #e5e7eb)', borderRadius: 12, padding: '12px 16px', marginBottom: 12,
        background: 'var(--surface, #fff)',
      }}>
        <div>
          <div style={{ fontWeight: 700 }}>🛵 Fila de entregadores (ordem de chegada)</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted, #6b7280)', marginTop: 2 }}>
            Ligado: o motoqueiro fica <strong>Online</strong> ao chegar e entra na fila; só quem está na vez aceita.
            Desligado: qualquer entregador pega qualquer pedido (pool livre).
          </div>
        </div>
        <button type="button" onClick={toggleFila} disabled={filaSaving}
          style={{
            flexShrink: 0, width: 52, height: 30, borderRadius: 999, border: 'none', cursor: 'pointer',
            background: filaAtiva ? '#16a34a' : '#9ca3af', position: 'relative', transition: 'background .15s',
          }} aria-pressed={filaAtiva} title={filaAtiva ? 'Ligado' : 'Desligado'}>
          <span style={{
            position: 'absolute', top: 3, left: filaAtiva ? 25 : 3, width: 24, height: 24,
            borderRadius: '50%', background: '#fff', transition: 'left .15s',
          }} />
        </button>
      </div>

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
                <th>Desconto/entrega</th>
                <th></th>
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
                    {p.perfil === 'entregador' ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={!!p.entregador_desconto_ativo}
                          onChange={(e) => saveDesconto(p, { ativo: e.target.checked })}
                          title="Descontar um valor por cada entrega deste motoqueiro"
                        />
                        {p.entregador_desconto_ativo && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            R$
                            <input
                              type="number" min="0" step="0.50"
                              value={p.entregador_desconto_valor ?? 0}
                              onChange={(e) => setPerfis(prev => prev.map(x => x.id === p.id ? { ...x, entregador_desconto_valor: e.target.value } : x))}
                              onBlur={(e) => saveDesconto(p, { valor: Number(e.target.value) || 0 })}
                              style={{ width: 72 }}
                            />
                          </span>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted, #9ca3af)' }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      onClick={() => handleExcluir(p)}
                      disabled={savingId === p.id || p.id === user?.id}
                      title={p.id === user?.id ? 'Você não pode se excluir' : 'Excluir funcionário'}
                      style={{
                        background: 'none', border: '1px solid var(--danger, #ef4444)', color: 'var(--danger, #ef4444)',
                        borderRadius: 8, cursor: p.id === user?.id ? 'not-allowed' : 'pointer', padding: '4px 10px',
                        fontSize: 12.5, fontWeight: 700, opacity: p.id === user?.id ? 0.4 : 1,
                      }}
                    >
                      Excluir
                    </button>
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
            <h2>Novo Colaborador</h2>
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
                <label>Perfil / Função</label>
                <select
                  value={vendorForm.perfil}
                  onChange={(e) => setVendorForm((p) => ({ ...p, perfil: e.target.value }))}
                >
                  {PERFIS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
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
                  {creatingVendor ? 'Criando...' : 'Criar colaborador'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
