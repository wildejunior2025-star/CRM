import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'
import './SuperAdminEmpresas.css'

const STATUS_LABELS = {
  trial: 'Trial',
  ativo: 'Ativo',
  atrasado: 'Atrasado',
  suspenso: 'Suspenso',
  cancelado: 'Cancelado',
}

const STATUS_BADGES = {
  trial: 'badge-primary',
  ativo: 'badge-success',
  atrasado: 'badge-warning',
  suspenso: 'badge-danger',
  cancelado: 'badge-neutral',
}

const emptyForm = {
  nome: '',
  email_contato: '',
  plano: 'padrao',
  valor_mensalidade: '',
  taxa_plataforma: '5',
  cor_primaria: '#863bff',
  logo_url: '',
  dominio_personalizado: '',
  vencimento: '',
  observacoes: '',
}

export default function SuperAdminEmpresas() {
  const [empresas, setEmpresas] = useState([])
  const [usuariosPorEmpresa, setUsuariosPorEmpresa] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [savingId, setSavingId] = useState(null)

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)

  const [inviteLink, setInviteLink] = useState(null)
  const [inviteCopiado, setInviteCopiado] = useState(false)
  const [openMenuId, setOpenMenuId] = useState(null)
  const menuRef = useRef(null)

  // Edição inline de taxa
  const [editandoTaxaId, setEditandoTaxaId] = useState(null)
  const [taxaTemp, setTaxaTemp] = useState('')
  const taxaInputRef = useRef(null)

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [empresasRes, profilesRes] = await Promise.all([
      supabase.from('empresas').select('*').order('created_at'),
      supabase.from('profiles').select('empresa_id'),
    ])

    const firstError = empresasRes.error || profilesRes.error
    if (firstError) setError(firstError.message)

    setEmpresas(empresasRes.data ?? [])

    const counts = {}
    for (const p of profilesRes.data ?? []) {
      if (!p.empresa_id) continue
      counts[p.empresa_id] = (counts[p.empresa_id] ?? 0) + 1
    }
    setUsuariosPorEmpresa(counts)
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [])

  function openNew() {
    setEditingId(null)
    setForm(emptyForm)
    setShowModal(true)
  }

  function openEdit(empresa) {
    setEditingId(empresa.id)
    setForm({
      nome: empresa.nome ?? '',
      email_contato: empresa.email_contato ?? '',
      plano: empresa.plano ?? 'padrao',
      valor_mensalidade: empresa.valor_mensalidade ?? '',
      taxa_plataforma: empresa.taxa_plataforma ?? '5',
      cor_primaria: empresa.cor_primaria ?? '#863bff',
      logo_url: empresa.logo_url ?? '',
      dominio_personalizado: empresa.dominio_personalizado ?? '',
      vencimento: empresa.vencimento ?? '',
      observacoes: empresa.observacoes ?? '',
    })
    setShowModal(true)
  }

  function handleChange(e) {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    const payload = {
      nome: form.nome,
      email_contato: form.email_contato || null,
      plano: form.plano,
      valor_mensalidade: form.valor_mensalidade === '' ? 0 : Number(form.valor_mensalidade),
      taxa_plataforma: form.taxa_plataforma === '' ? 5 : Number(form.taxa_plataforma),
      cor_primaria: form.cor_primaria || null,
      logo_url: form.logo_url || null,
      dominio_personalizado: form.dominio_personalizado || null,
      vencimento: form.vencimento || null,
      observacoes: form.observacoes || null,
    }

    if (editingId) {
      const { error } = await supabase.from('empresas').update(payload).eq('id', editingId)
      if (error) { setError(error.message); return }
      setShowModal(false)
      await loadAll()
    } else {
      const { data, error } = await supabase
        .from('empresas')
        .insert({ ...payload, status: 'trial', trial_fim: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) })
        .select('id')
        .single()

      if (error) { setError(error.message); return }

      setShowModal(false)
      await loadAll()
      setInviteLink(`${window.location.origin}/cadastro-admin/${data.id}`)
    }
  }

  async function acessarEmpresa(emp) {
    setSavingId(emp.id)
    setError(null)

    // Salva sessão atual antes de impersonar — o magic link sobrescreve o localStorage
    const { data: { session: currentSession } } = await supabase.auth.getSession()
    if (currentSession) {
      localStorage.setItem('crm_superadmin_backup', JSON.stringify({
        access_token: currentSession.access_token,
        refresh_token: currentSession.refresh_token,
      }))
    }

    const { data, error } = await supabase.functions.invoke('impersonate-empresa', {
      body: { empresa_id: emp.id, redirect_to: window.location.origin },
    })

    setSavingId(null)

    if (error || !data?.link) {
      localStorage.removeItem('crm_superadmin_backup')
      setError(error?.message ?? data?.error ?? 'Erro ao gerar link de acesso')
      return
    }

    window.location.href = data.link
  }

  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  async function copiarLink() {
    if (!inviteLink) return
    await navigator.clipboard.writeText(inviteLink)
    setInviteCopiado(true)
    setTimeout(() => setInviteCopiado(false), 2000)
  }

  function abrirEditTaxa(emp) {
    setEditandoTaxaId(emp.id)
    setTaxaTemp(String(Number(emp.taxa_plataforma ?? 5)))
    setTimeout(() => taxaInputRef.current?.select(), 30)
  }

  async function salvarTaxa(empresaId) {
    const valor = parseFloat(taxaTemp)
    if (isNaN(valor) || valor < 0 || valor > 100) {
      setEditandoTaxaId(null)
      return
    }
    setSavingId(empresaId)
    const { error } = await supabase
      .from('empresas')
      .update({ taxa_plataforma: valor })
      .eq('id', empresaId)
    setSavingId(null)
    setEditandoTaxaId(null)
    if (error) { setError(error.message); return }
    setEmpresas(prev => prev.map(e => e.id === empresaId ? { ...e, taxa_plataforma: valor } : e))
  }

  async function handleStatus(empresa, novoStatus) {
    let novoVencimento = null

    if (novoStatus === 'ativo') {
      const sugestao = empresa.vencimento || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const input = window.prompt('Nova data de vencimento (AAAA-MM-DD):', sugestao)
      if (input === null) return
      novoVencimento = input
    } else {
      const confirmMsg =
        novoStatus === 'suspenso'
          ? `Suspender o acesso de "${empresa.nome}"?`
          : `Cancelar a assinatura de "${empresa.nome}"?`
      if (!window.confirm(confirmMsg)) return
    }

    setSavingId(empresa.id)
    setError(null)

    const { error } = await supabase.rpc('marcar_pagamento_empresa', {
      p_empresa_id: empresa.id,
      p_novo_status: novoStatus,
      p_novo_vencimento: novoVencimento,
    })

    setSavingId(null)
    if (error) { setError(error.message); return }
    await loadAll()
  }

  return (
    <div>
      <div className="page-header">
        <h1>Empresas</h1>
        <button className="btn btn-primary" onClick={openNew}>
          Nova empresa
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {inviteLink && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>Empresa criada! Envie este link para o administrador criar a conta de acesso:</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              readOnly
              value={inviteLink}
              onFocus={(e) => e.target.select()}
              style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={copiarLink}>
              {inviteCopiado ? 'Copiado!' : 'Copiar'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setInviteLink(null)}>
              Fechar
            </button>
          </div>
        </div>
      )}

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : empresas.length === 0 ? (
          <div className="empty-state">Nenhuma empresa cadastrada.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Contato</th>
                <th>Plano</th>
                <th className="caixa-amount-col">Mensalidade</th>
                <th>Status</th>
                <th>Vencimento / Trial</th>
                <th className="caixa-amount-col">Taxa %</th>
                <th>Usuários</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {empresas.map((emp) => (
                <tr key={emp.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {emp.cor_primaria && (
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: emp.cor_primaria, flexShrink: 0, display: 'inline-block' }} title={emp.cor_primaria} />
                      )}
                      {emp.nome}
                      {emp.dominio_personalizado && (
                        <span style={{ color: 'var(--text-muted)', marginLeft: 2, display: 'inline-flex', alignItems: 'center' }} title={emp.dominio_personalizado}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                          </svg>
                        </span>
                      )}
                    </div>
                  </td>
                  <td>{emp.email_contato || '-'}</td>
                  <td>{emp.plano}</td>
                  <td className="caixa-amount-col">
                    {Number(emp.valor_mensalidade ?? 0).toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    })}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGES[emp.status] ?? 'badge-neutral'}`}>
                      {STATUS_LABELS[emp.status] ?? emp.status}
                    </span>
                  </td>
                  <td>{emp.vencimento || emp.trial_fim || '-'}</td>
                  <td className="caixa-amount-col">
                    {editandoTaxaId === emp.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          ref={taxaInputRef}
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={taxaTemp}
                          onChange={e => setTaxaTemp(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') salvarTaxa(emp.id)
                            if (e.key === 'Escape') setEditandoTaxaId(null)
                          }}
                          onBlur={() => salvarTaxa(emp.id)}
                          style={{
                            width: 60,
                            padding: '4px 6px',
                            borderRadius: 6,
                            border: '1.5px solid var(--primary)',
                            background: 'var(--bg)',
                            color: 'var(--text)',
                            fontSize: 13,
                            textAlign: 'right',
                          }}
                        />
                        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>%</span>
                      </div>
                    ) : (
                      <button
                        title="Clique para editar a taxa"
                        onClick={() => abrirEditTaxa(emp)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--primary)',
                          fontWeight: 700,
                          fontSize: 14,
                          padding: '2px 6px',
                          borderRadius: 6,
                          transition: 'background 120ms',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--primary-bg)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        {Number(emp.taxa_plataforma ?? 5).toFixed(1)}%
                      </button>
                    )}
                  </td>
                  <td>{usuariosPorEmpresa[emp.id] ?? 0}</td>
                  <td>
                    <div className="empresa-table-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => openEdit(emp)}>
                        Editar
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={savingId === emp.id}
                        onClick={() => acessarEmpresa(emp)}
                      >
                        {savingId === emp.id ? 'Aguarde...' : 'Acessar'}
                      </button>
                      <div className="empresa-dropdown" ref={openMenuId === emp.id ? menuRef : null}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setOpenMenuId(openMenuId === emp.id ? null : emp.id)}
                        >
                          Mais ▾
                        </button>
                        {openMenuId === emp.id && (
                          <div className="empresa-dropdown-menu">
                            <button onClick={() => { setInviteLink(`${window.location.origin}/cadastro-admin/${emp.id}`); setOpenMenuId(null) }}>
                              Link admin
                            </button>
                            <button disabled={savingId === emp.id} onClick={() => { handleStatus(emp, 'ativo'); setOpenMenuId(null) }}>
                              Marcar pagamento
                            </button>
                            <button disabled={savingId === emp.id} onClick={() => { handleStatus(emp, 'suspenso'); setOpenMenuId(null) }}>
                              Suspender
                            </button>
                            <button className="danger" disabled={savingId === emp.id} onClick={() => { handleStatus(emp, 'cancelado'); setOpenMenuId(null) }}>
                              Cancelar assinatura
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? 'Editar empresa' : 'Nova empresa'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Nome da empresa</label>
                  <input name="nome" value={form.nome} onChange={handleChange} required />
                </div>

                <div className="form-field full">
                  <label>E-mail de contato</label>
                  <input type="email" name="email_contato" value={form.email_contato} onChange={handleChange} />
                </div>

                <div className="form-field">
                  <label>Plano</label>
                  <input name="plano" value={form.plano} onChange={handleChange} />
                </div>

                <div className="form-field">
                  <label>Mensalidade (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="valor_mensalidade"
                    value={form.valor_mensalidade}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Taxa plataforma (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    name="taxa_plataforma"
                    value={form.taxa_plataforma}
                    onChange={handleChange}
                    placeholder="5"
                  />
                </div>

                {editingId && (
                  <div className="form-field">
                    <label>Vencimento</label>
                    <input type="date" name="vencimento" value={form.vencimento ?? ''} onChange={handleChange} />
                  </div>
                )}

                <div className="form-field full">
                  <label>Domínio personalizado do app</label>
                  <input
                    name="dominio_personalizado"
                    value={form.dominio_personalizado}
                    onChange={handleChange}
                    placeholder="pedidos.nomeda loja.com.br"
                  />
                </div>

                <div className="form-field">
                  <label>Cor principal do app</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="color"
                      value={form.cor_primaria || '#863bff'}
                      onChange={e => setForm(p => ({ ...p, cor_primaria: e.target.value }))}
                      style={{ width: 40, height: 36, padding: 2, borderRadius: 6, border: '1.5px solid var(--border)', cursor: 'pointer' }}
                    />
                    <input
                      name="cor_primaria"
                      value={form.cor_primaria}
                      onChange={handleChange}
                      placeholder="#863bff"
                      style={{ flex: 1 }}
                    />
                  </div>
                </div>

                <div className="form-field">
                  <label>URL da logo</label>
                  <input
                    name="logo_url"
                    value={form.logo_url}
                    onChange={handleChange}
                    placeholder="https://..."
                  />
                </div>

                <div className="form-field full">
                  <label>Observações</label>
                  <textarea name="observacoes" value={form.observacoes} onChange={handleChange} rows={3} />
                </div>
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingId ? 'Salvar' : 'Criar empresa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
