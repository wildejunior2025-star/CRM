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
  telefone_contato: '',
  plano: 'padrao',
  valor_mensalidade: '',
  taxa_plataforma: '5',
  cor_primaria: '#863bff',
  logo_url: '',
  dominio_personalizado: '',
  vencimento: '',
  observacoes: '',
}

function WhatsAppIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  )
}

export default function SuperAdminEmpresas() {
  const [empresas, setEmpresas] = useState([])
  const [usuariosPorEmpresa, setUsuariosPorEmpresa] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [savingId, setSavingId] = useState(null)

  // Busca e filtro
  const [busca, setBusca] = useState('')
  const [filtroStatus, setFiltroStatus] = useState('todos')

  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)

  const [inviteLink, setInviteLink] = useState(null)
  const [inviteCopiado, setInviteCopiado] = useState(false)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [dropRect, setDropRect] = useState(null)
  const menuRef = useRef(null)

  // Edição inline de taxa
  const [editandoTaxaId, setEditandoTaxaId] = useState(null)
  const [taxaTemp, setTaxaTemp] = useState('')
  const taxaInputRef = useRef(null)

  // Modal de créditos WhatsApp
  const [creditModal, setCreditModal]   = useState(null) // { id, nome, creditos }
  const [creditQtd,   setCreditQtd]     = useState('100')
  const [savingCredit, setSavingCredit] = useState(false)

  // Cobrança por WhatsApp
  const [cobrando, setCobrando]   = useState(null) // empresaId
  const [cobrancaMsg, setCobrancaMsg] = useState({}) // { [empresaId]: 'ok' | 'erro: ...' }

  const hoje = new Date().toISOString().split('T')[0]

  async function renovarEmpresa(empresa) {
    const novoVencimento = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    setSavingId(empresa.id)
    setError(null)
    const { error } = await supabase.rpc('marcar_pagamento_empresa', {
      p_empresa_id: empresa.id,
      p_novo_status: 'ativo',
      p_novo_vencimento: novoVencimento,
    })
    setSavingId(null)
    if (error) { setError(error.message); return }
    await loadAll()
  }

  async function cobrarEmpresa(emp) {
    if (!emp.telefone_contato) {
      setCobrancaMsg(prev => ({ ...prev, [emp.id]: 'Cadastre o telefone da empresa primeiro (editar).' }))
      setTimeout(() => setCobrancaMsg(prev => { const n = { ...prev }; delete n[emp.id]; return n }), 4000)
      return
    }
    setCobrando(emp.id)
    const { data: { session } } = await supabase.auth.getSession()
    try {
      const res = await fetch('https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/cobrar-empresa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ empresa_id: emp.id }),
      })
      const json = await res.json()
      setCobrancaMsg(prev => ({ ...prev, [emp.id]: json.ok ? 'Enviado!' : ('Erro: ' + (json.error ?? 'falha')) }))
    } catch (e) {
      setCobrancaMsg(prev => ({ ...prev, [emp.id]: 'Erro: ' + String(e) }))
    }
    setCobrando(null)
    setTimeout(() => setCobrancaMsg(prev => { const n = { ...prev }; delete n[emp.id]; return n }), 4000)
  }

  async function adicionarCreditos() {
    const qtd = parseInt(creditQtd, 10)
    if (!qtd || qtd <= 0) return
    setSavingCredit(true)
    await supabase.rpc('adicionar_credito_whatsapp', {
      p_empresa_id: creditModal.id,
      p_quantidade: qtd,
    })
    setSavingCredit(false)
    setCreditModal(null)
    await loadAll()
  }

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
      telefone_contato: empresa.telefone_contato ?? '',
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
      telefone_contato: form.telefone_contato || null,
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

    // Guarda o nome da empresa para exibir no botão "Voltar ao Super Admin"
    localStorage.setItem('crm_superadmin_cliente_nome', emp.nome || 'empresa')

    const { data, error } = await supabase.functions.invoke('impersonate-empresa', {
      body: { empresa_id: emp.id, redirect_to: window.location.origin },
    })

    setSavingId(null)

    if (error || !data?.link) {
      localStorage.removeItem('crm_superadmin_backup')
      setError(error?.message ?? data?.error ?? 'Erro ao gerar link de acesso')
      return
    }

    // Troca a sessão NA MESMA ABA usando o token do magic link (verifyOtp), em vez
    // de redirecionar. O redirect levaria a outro subdomínio e o localStorage é por
    // origem — perderíamos o backup do super admin (e com ele o botão "Voltar").
    let tokenHash = null
    try { tokenHash = new URL(data.link).searchParams.get('token') } catch { /* link inesperado */ }

    if (tokenHash) {
      const { error: vErr } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
      if (!vErr) {
        // Agora autenticado como admin da empresa, mesma origem → backup preservado.
        window.location.href = '/'
        return
      }
      // Se o verifyOtp falhar, cai no fallback do redirect tradicional abaixo.
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

  async function excluirEmpresa(empresa) {
    if (!window.confirm(`Excluir "${empresa.nome}" permanentemente? Esta ação não pode ser desfeita.`)) return
    if (!window.confirm(`Tem certeza? Todos os dados da loja serão apagados.`)) return
    setSavingId(empresa.id)
    const { error } = await supabase.from('empresas').delete().eq('id', empresa.id)
    setSavingId(null)
    if (error) { setError(error.message); return }
    await loadAll()
  }

  const semCreditoWA = empresas.filter(
    e => ['ativo', 'trial'].includes(e.status) && (e.whatsapp_creditos ?? 0) === 0
  )

  const empresasFiltradas = empresas.filter(e => {
    if (filtroStatus !== 'todos' && e.status !== filtroStatus) return false
    if (busca) {
      const q = busca.toLowerCase()
      return (
        (e.nome ?? '').toLowerCase().includes(q) ||
        (e.email_contato ?? '').toLowerCase().includes(q) ||
        (e.telefone_contato ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div>
      <div className="page-header">
        <h1>Empresas</h1>
        <button className="btn btn-primary" onClick={openNew}>
          Nova empresa
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {semCreditoWA.length > 0 && (
        <div style={{
          marginBottom: 16,
          padding: '10px 14px',
          borderRadius: 10,
          background: 'rgba(239,68,68,.1)',
          border: '1px solid rgba(239,68,68,.3)',
          color: 'var(--danger)',
          fontSize: 13,
        }}>
          <strong>⚠️ {semCreditoWA.length} loja{semCreditoWA.length !== 1 ? 's' : ''} com crédito WhatsApp zerado:</strong>{' '}
          {semCreditoWA.map(e => e.nome).join(', ')}
        </div>
      )}

      {/* Busca e filtro */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Buscar empresa, e-mail ou telefone..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          style={{
            flex: 1, minWidth: 200, padding: '7px 12px',
            borderRadius: 8, border: '1.5px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)', fontSize: 13,
          }}
        />
        <select
          value={filtroStatus}
          onChange={e => setFiltroStatus(e.target.value)}
          style={{
            padding: '7px 10px', borderRadius: 8,
            border: '1.5px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)', fontSize: 13,
          }}
        >
          <option value="todos">Todos os status</option>
          <option value="trial">Trial</option>
          <option value="ativo">Ativo</option>
          <option value="atrasado">Atrasado</option>
          <option value="suspenso">Suspenso</option>
          <option value="cancelado">Cancelado</option>
        </select>
        <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {empresasFiltradas.length} de {empresas.length}
        </span>
      </div>

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
        ) : empresasFiltradas.length === 0 ? (
          <div className="empty-state">{empresas.length === 0 ? 'Nenhuma empresa cadastrada.' : 'Nenhuma empresa encontrada para o filtro aplicado.'}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th>E-mail</th>
                <th>Telefone</th>
                <th className="caixa-amount-col">Mensalidade</th>
                <th>Status</th>
                <th>Vencimento / Trial</th>
                <th className="caixa-amount-col">Taxa %</th>
                <th>Usuários</th>
                <th className="caixa-amount-col">Créditos WA</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {empresasFiltradas.map((emp) => (
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
                  <td>{emp.telefone_contato || '-'}</td>
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
                  <td className="caixa-amount-col">
                    <button
                      title="Adicionar créditos WhatsApp"
                      onClick={() => { setCreditModal({ id: emp.id, nome: emp.nome, creditos: emp.whatsapp_creditos ?? 0 }); setCreditQtd('100') }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: (emp.whatsapp_creditos ?? 0) === 0 ? 'var(--danger)' : (emp.whatsapp_creditos ?? 0) < 10 ? 'var(--warning, #f59e0b)' : 'var(--success)',
                        fontWeight: 700, fontSize: 14, padding: '2px 6px', borderRadius: 6,
                      }}
                    >
                      {emp.whatsapp_creditos ?? 0}
                    </button>
                  </td>
                  <td>
                    <div className="empresa-table-actions">
                      {(emp.status === 'ativo' || emp.status === 'atrasado') && emp.vencimento && emp.vencimento < hoje && (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          <button
                            title="Cobrar mensalidade por WhatsApp"
                            disabled={cobrando === emp.id}
                            onClick={() => cobrarEmpresa(emp)}
                            style={{
                              background: cobrando === emp.id ? 'var(--border)' : '#25d36622',
                              border: '1px solid #25d366',
                              color: '#25d366',
                              borderRadius: 8,
                              padding: '4px 8px',
                              cursor: cobrando === emp.id ? 'wait' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              fontSize: 12,
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <WhatsAppIcon />
                            {cobrando === emp.id ? '...' : 'Cobrar'}
                          </button>
                          {cobrancaMsg[emp.id] && (
                            <span style={{ fontSize: 11, color: cobrancaMsg[emp.id].startsWith('Erro') ? '#ef4444' : '#22c55e', maxWidth: 90, textAlign: 'center', lineHeight: 1.2 }}>
                              {cobrancaMsg[emp.id]}
                            </span>
                          )}
                        </div>
                      )}
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
                          onClick={(e) => {
                            if (openMenuId === emp.id) { setOpenMenuId(null); return }
                            const rect = e.currentTarget.getBoundingClientRect()
                            setDropRect(rect)
                            setOpenMenuId(emp.id)
                          }}
                        >
                          Mais ▾
                        </button>
                        {openMenuId === emp.id && dropRect && (
                          <div className="empresa-dropdown-menu" style={{
                            position: 'fixed',
                            top: dropRect.bottom + 4 > window.innerHeight - 200
                              ? dropRect.top - 4
                              : dropRect.bottom + 4,
                            right: window.innerWidth - dropRect.right,
                            transform: dropRect.bottom + 4 > window.innerHeight - 200 ? 'translateY(-100%)' : 'none',
                            zIndex: 9999,
                          }}>
                            <button onClick={() => { setInviteLink(`${window.location.origin}/cadastro-admin/${emp.id}`); setOpenMenuId(null) }}>
                              Link admin
                            </button>
                            <button onClick={() => { setCreditModal({ id: emp.id, nome: emp.nome, creditos: emp.whatsapp_creditos ?? 0 }); setCreditQtd('100'); setOpenMenuId(null) }}>
                              Créditos WhatsApp
                            </button>
                            <button disabled={savingId === emp.id} onClick={() => { renovarEmpresa(emp); setOpenMenuId(null) }}>
                              Renovar (+30 dias)
                            </button>
                            <button disabled={savingId === emp.id} onClick={() => { handleStatus(emp, 'suspenso'); setOpenMenuId(null) }}>
                              Suspender
                            </button>
                            <button className="danger" disabled={savingId === emp.id} onClick={() => { handleStatus(emp, 'cancelado'); setOpenMenuId(null) }}>
                              Cancelar assinatura
                            </button>
                            <button className="danger" disabled={savingId === emp.id} onClick={() => { setOpenMenuId(null); excluirEmpresa(emp) }}>
                              Excluir empresa
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

                <div className="form-field">
                  <label>E-mail de contato</label>
                  <input type="email" name="email_contato" value={form.email_contato} onChange={handleChange} />
                </div>

                <div className="form-field">
                  <label>WhatsApp de contato</label>
                  <input
                    name="telefone_contato"
                    value={form.telefone_contato}
                    onChange={handleChange}
                    placeholder="5511999990000"
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>
                    Com código do país. Usado para cobranças.
                  </span>
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

      {/* Modal de créditos WhatsApp */}
      {creditModal && (
        <div className="modal-overlay" onClick={() => setCreditModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h2>Créditos WhatsApp</h2>
            <p style={{ marginBottom: 4, color: 'var(--text-muted)', fontSize: 14 }}>
              Empresa: <strong style={{ color: 'var(--text)' }}>{creditModal.nome}</strong>
            </p>
            <p style={{ marginBottom: 20, color: 'var(--text-muted)', fontSize: 14 }}>
              Saldo atual: <strong style={{ color: creditModal.creditos === 0 ? 'var(--danger)' : 'var(--success)' }}>{creditModal.creditos} créditos</strong>
            </p>
            <div className="form-field" style={{ marginBottom: 20 }}>
              <label>Quantidade a adicionar</label>
              <input
                type="number"
                min="1"
                value={creditQtd}
                onChange={(e) => setCreditQtd(e.target.value)}
                style={{ marginTop: 6 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                1 crédito = 1 mensagem enviada. Sugerido: 100, 500 ou 1000.
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setCreditModal(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={adicionarCreditos} disabled={savingCredit}>
                {savingCredit ? 'Salvando...' : `Adicionar ${creditQtd || 0} créditos`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
