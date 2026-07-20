import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { CONDICOES_PAGAMENTO } from '../lib/constants'
import ClienteHistorico from './ClienteHistorico'
import '../components/Page.css'

const TIPOS_PADRAO = ['mercadinho', 'bar', 'restaurante', 'distribuidor', 'outro']
const DIAS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

const emptyForm = {
  nome: '',
  tipo: 'mercadinho',
  cnpj_cpf: '',
  telefone: '',
  cep: '',
  endereco: '',
  numero: '',
  bairro: '',
  cidade: '',
  estado: '',
  dia_visita: '',
  condicao_pagamento: 'a_vista',
  limite_credito: 0,
  desconto_percentual: 0,
  desconto_minimo_pedido: 0,
  observacoes: '',
  ativo: true,
}

export default function Clientes() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null
  // Preços especiais de parceria (cliente + produto → preço), usados pelo robô
  const [produtosLista, setProdutosLista] = useState([]) // [{id, nome, preco_venda}]
  const [precosEspeciais, setPrecosEspeciais] = useState([]) // [{produto_id, preco}]
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [clientes, setClientes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [mostrarInativos, setMostrarInativos] = useState(false)
  // Modal de confirmação de exclusão/arquivamento (substitui o confirm() do navegador)
  const [confirmar, setConfirmar] = useState(null) // { id, nome, fase: 'excluir' | 'arquivar' }
  const [processandoExcluir, setProcessandoExcluir] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [historicoCliente, setHistoricoCliente] = useState(null)

  const [tipos, setTipos] = useState(TIPOS_PADRAO)
  const [showTiposModal, setShowTiposModal] = useState(false)
  const [novoTipo, setNovoTipo] = useState('')
  const [savingTipo, setSavingTipo] = useState(false)

  async function loadTipos() {
    const { data } = await supabase.from('tipos_cliente').select('id, nome').order('nome')
    if (data && data.length > 0) setTipos(data.map(t => t.nome))
  }

  async function handleAddTipo() {
    const nome = novoTipo.trim().toLowerCase()
    if (!nome) return
    setSavingTipo(true)
    await supabase.rpc('add_tipo_cliente', { p_nome: nome })
    setNovoTipo('')
    await loadTipos()
    setSavingTipo(false)
  }

  async function handleDeleteTipo(nome) {
    await supabase.from('tipos_cliente').delete().eq('nome', nome)
    await loadTipos()
  }

  async function loadClientes() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('clientes')
      .select('*')
      .order('nome', { ascending: true })

    if (error) setError(error.message)
    else setClientes(data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadClientes()
    loadTipos()
  }, [])

  // Catálogo de produtos (pro seletor de preço especial)
  useEffect(() => {
    if (!empresaId) return
    supabase.from('produtos').select('id, nome, preco_venda').eq('empresa_id', empresaId).eq('ativo', true).order('nome')
      .then(({ data }) => setProdutosLista(data ?? []))
  }, [empresaId])

  function openNew() {
    setEditingId(null)
    setForm(emptyForm)
    setPrecosEspeciais([])
    setShowModal(true)
  }

  function openEdit(cliente) {
    setEditingId(cliente.id)
    setForm({
      nome: cliente.nome ?? '',
      tipo: cliente.tipo ?? 'mercadinho',
      cnpj_cpf: cliente.cnpj_cpf ?? '',
      telefone: cliente.telefone ?? '',
      cep: cliente.cep ?? '',
      endereco: cliente.endereco ?? '',
      numero: cliente.numero ?? '',
      bairro: cliente.bairro ?? '',
      cidade: cliente.cidade ?? '',
      estado: cliente.estado ?? '',
      dia_visita: cliente.dia_visita ?? '',
      condicao_pagamento: cliente.condicao_pagamento ?? 'a_vista',
      limite_credito: cliente.limite_credito ?? 0,
      desconto_percentual: cliente.desconto_percentual ?? 0,
      desconto_minimo_pedido: cliente.desconto_minimo_pedido ?? 0,
      observacoes: cliente.observacoes ?? '',
      ativo: cliente.ativo ?? true,
    })
    // carrega os preços especiais deste cliente
    setPrecosEspeciais([])
    supabase.from('precos_especiais_cliente').select('produto_id, preco').eq('cliente_id', cliente.id)
      .then(({ data }) => setPrecosEspeciais((data ?? []).map(p => ({ produto_id: p.produto_id, preco: p.preco }))))
    setShowModal(true)
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  // Busca o endereço pelo CEP (ViaCEP) e preenche rua/bairro/cidade/estado.
  async function buscarCep(valor) {
    const cep = String(valor || '').replace(/\D/g, '')
    if (cep.length !== 8) return
    setBuscandoCep(true)
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`)
      const d = await r.json()
      if (!d.erro) {
        setForm((prev) => ({
          ...prev,
          endereco: d.logradouro || prev.endereco,
          bairro: d.bairro || prev.bairro,
          cidade: d.localidade || prev.cidade,
          estado: d.uf || prev.estado,
        }))
      }
    } catch { /* ignora falha de rede */ }
    setBuscandoCep(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()

    // Telefone obrigatório: é o que diferencia dois clientes de mesmo nome e
    // permite cobrar fiado depois. Exige DDD + número (>=10 dígitos).
    if (form.telefone.replace(/\D/g, '').length < 10) {
      setError('Telefone com DDD é obrigatório.')
      return
    }

    setSaving(true)
    setError(null)

    const payload = {
      ...form,
      limite_credito: Number(form.limite_credito) || 0,
      desconto_percentual: Number(form.desconto_percentual) || 0,
      desconto_minimo_pedido: Number(form.desconto_minimo_pedido) || 0,
    }

    const { data: saved, error } = editingId
      ? await supabase.from('clientes').update(payload).eq('id', editingId).select('id').single()
      : await supabase.from('clientes').insert(payload).select('id').single()

    if (error) {
      setSaving(false)
      setError(error.message)
      return
    }

    // Reconcilia os preços especiais do cliente (apaga e regrava — simples e seguro)
    const cid = saved?.id ?? editingId
    if (cid) {
      try {
        await supabase.from('precos_especiais_cliente').delete().eq('cliente_id', cid)
        const vistos = new Set()
        const rows = []
        for (const pe of precosEspeciais) {
          if (!pe.produto_id || vistos.has(pe.produto_id)) continue
          const preco = Number(pe.preco)
          if (!(preco > 0)) continue
          vistos.add(pe.produto_id)
          rows.push({ empresa_id: empresaId, cliente_id: cid, produto_id: pe.produto_id, preco })
        }
        if (rows.length) await supabase.from('precos_especiais_cliente').insert(rows)
      } catch (err) {
        setSaving(false)
        setError('Cliente salvo, mas houve erro nos preços especiais: ' + (err?.message ?? err))
        return
      }
    }

    setSaving(false)
    setShowModal(false)
    loadClientes()
  }

  // Abre o modal bonito de confirmação (no lugar do confirm() feio do navegador)
  function pedirExcluir(cliente) {
    setError(null)
    setConfirmar({ id: cliente.id, nome: cliente.nome, fase: 'excluir' })
  }

  // Tenta excluir de fato; se o banco bloquear por ter vendas, muda o modal pra "arquivar".
  async function executarExcluir() {
    if (!confirmar) return
    const id = confirmar.id
    setProcessandoExcluir(true); setError(null)
    // Remove referências no carrinho antes de excluir o cliente
    await supabase.from('whatsapp_carrinho').update({ cliente_id: null }).eq('cliente_id', id)
    const { error } = await supabase.from('clientes').delete().eq('id', id)
    setProcessandoExcluir(false)
    if (!error) { setConfirmar(null); loadClientes(); return }
    // Cliente com vendas/pagamentos → não dá pra apagar sem perder o histórico.
    const temHistorico = /foreign key|constraint|violates/i.test(error.message || '')
    if (temHistorico) { setConfirmar({ ...confirmar, fase: 'arquivar' }); return }
    setError(error.message); setConfirmar(null)
  }

  async function executarArquivar() {
    if (!confirmar) return
    setProcessandoExcluir(true); setError(null)
    const { error } = await supabase.from('clientes').update({ ativo: false }).eq('id', confirmar.id)
    setProcessandoExcluir(false)
    if (error) { setError(error.message); setConfirmar(null); return }
    setConfirmar(null); loadClientes()
  }

  const filtered = clientes.filter((c) => {
    // Arquivados (ativo = false) ficam escondidos, a menos que o toggle esteja ligado.
    if (!mostrarInativos && c.ativo === false) return false
    const term = search.trim().toLowerCase()
    if (!term) return true
    return (
      c.nome?.toLowerCase().includes(term) ||
      c.cidade?.toLowerCase().includes(term) ||
      c.bairro?.toLowerCase().includes(term) ||
      c.cnpj_cpf?.toLowerCase().includes(term)
    )
  })

  return (
    <div>
      <div className="page-header">
        <h1>Clientes</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setShowTiposModal(true)}>
            Tipos de cliente
          </button>
          <button className="btn btn-primary" onClick={openNew}>
            + Novo cliente
          </button>
        </div>
      </div>

      <div className="toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <input
          placeholder="Buscar por nome, bairro, cidade ou documento..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={mostrarInativos} onChange={(e) => setMostrarInativos(e.target.checked)} />
          Mostrar arquivados
        </label>
      </div>

      {error && <p className="error-text">{error}</p>}

      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">Nenhum cliente encontrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th>Telefone</th>
                <th>Cidade / Bairro</th>
                <th>Dia de visita</th>
                <th>Pagamento</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id}>
                  <td>{c.nome}</td>
                  <td>{c.tipo}</td>
                  <td>{c.telefone}</td>
                  <td>
                    {c.cidade}
                    {c.bairro ? ` - ${c.bairro}` : ''}
                  </td>
                  <td>{c.dia_visita || '-'}</td>
                  <td>
                    {CONDICOES_PAGAMENTO.find((o) => o.value === c.condicao_pagamento)
                      ?.label || c.condicao_pagamento}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        c.ativo ? 'badge-success' : 'badge-danger'
                      }`}
                    >
                      {c.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setHistoricoCliente(c)}
                    >
                      Histórico
                    </button>{' '}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => openEdit(c)}
                    >
                      Editar
                    </button>{' '}
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => pedirExcluir(c)}
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {historicoCliente && (
        <ClienteHistorico
          cliente={historicoCliente}
          onClose={() => setHistoricoCliente(null)}
        />
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editingId ? 'Editar cliente' : 'Novo cliente'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Nome / Razão social</label>
                  <input
                    name="nome"
                    value={form.nome}
                    onChange={handleChange}
                    required
                  />
                </div>

                <div className="form-field">
                  <label>Tipo</label>
                  <select name="tipo" value={form.tipo} onChange={handleChange}>
                    {tipos.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>CNPJ / CPF</label>
                  <input
                    name="cnpj_cpf"
                    value={form.cnpj_cpf}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Telefone <span style={{ color: 'var(--danger, #dc2626)' }}>*</span></label>
                  <input
                    name="telefone"
                    value={form.telefone}
                    onChange={handleChange}
                    placeholder="(84) 99999-9999"
                    required
                  />
                </div>

                <div className="form-field">
                  <label>Dia de visita</label>
                  <select
                    name="dia_visita"
                    value={form.dia_visita}
                    onChange={handleChange}
                  >
                    <option value="">-</option>
                    {DIAS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>CEP {buscandoCep && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· buscando…</span>}</label>
                  <input
                    name="cep"
                    value={form.cep}
                    onChange={handleChange}
                    onBlur={e => buscarCep(e.target.value)}
                    placeholder="Digite o CEP (puxa rua/bairro)"
                    inputMode="numeric"
                  />
                </div>

                <div className="form-field">
                  <label>Número</label>
                  <input
                    name="numero"
                    value={form.numero}
                    onChange={handleChange}
                    placeholder="Nº"
                  />
                </div>

                <div className="form-field full">
                  <label>Endereço</label>
                  <input
                    name="endereco"
                    value={form.endereco}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Bairro</label>
                  <input
                    name="bairro"
                    value={form.bairro}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Cidade</label>
                  <input
                    name="cidade"
                    value={form.cidade}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Condição de pagamento</label>
                  <select
                    name="condicao_pagamento"
                    value={form.condicao_pagamento}
                    onChange={handleChange}
                  >
                    {CONDICOES_PAGAMENTO.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Limite de crédito (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="limite_credito"
                    value={form.limite_credito}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>Desconto autorizado (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    name="desconto_percentual"
                    value={form.desconto_percentual}
                    onChange={handleChange}
                    placeholder="0 = sem desconto"
                  />
                </div>

                <div className="form-field">
                  <label>Pedido mínimo para desconto (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="desconto_minimo_pedido"
                    value={form.desconto_minimo_pedido}
                    onChange={handleChange}
                    placeholder="0 = sempre aplica"
                  />
                </div>

                <div className="form-field full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <label>Preços especiais (parceria)</label>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 8px' }}>
                    Preço combinado só pra este cliente num produto (ex.: Quentinha M por R$15). Vale só pra ele, no <b>robô do WhatsApp</b>.
                  </div>
                  {precosEspeciais.length === 0 && (
                    <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum. Adicione abaixo se tiver acordo de preço.</div>
                  )}
                  {precosEspeciais.map((pe, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                      <select
                        value={pe.produto_id}
                        onChange={e => setPrecosEspeciais(prev => prev.map((x, j) => j === i ? { ...x, produto_id: e.target.value } : x))}
                        style={{ flex: 1, minWidth: 180 }}>
                        <option value="">Escolha o produto…</option>
                        {produtosLista.map(p => (
                          <option key={p.id} value={p.id}>{p.nome} (normal R$ {Number(p.preco_venda ?? 0).toFixed(2)})</option>
                        ))}
                      </select>
                      <input type="number" step="0.01" min="0" placeholder="R$ especial" style={{ width: 110 }}
                        value={pe.preco}
                        onChange={e => setPrecosEspeciais(prev => prev.map((x, j) => j === i ? { ...x, preco: e.target.value } : x))} />
                      <button type="button" className="btn btn-danger btn-sm"
                        onClick={() => setPrecosEspeciais(prev => prev.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                  <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }}
                    onClick={() => setPrecosEspeciais(prev => [...prev, { produto_id: '', preco: '' }])}>
                    + Adicionar preço especial
                  </button>
                </div>

                <div className="form-field full">
                  <label>Observações</label>
                  <textarea
                    name="observacoes"
                    rows={2}
                    value={form.observacoes}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label>
                    <input
                      type="checkbox"
                      name="ativo"
                      checked={form.ativo}
                      onChange={handleChange}
                    />{' '}
                    Ativo
                  </label>
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowModal(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showTiposModal && (
        <div className="modal-overlay" onClick={() => setShowTiposModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h2>Tipos de cliente</h2>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                value={novoTipo}
                onChange={(e) => setNovoTipo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddTipo())}
                placeholder="Ex: padaria, farmácia..."
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary btn-sm" onClick={handleAddTipo} disabled={savingTipo || !novoTipo.trim()}>
                + Adicionar
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tipos.map((t) => (
                <div key={t} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-hover, rgba(0,0,0,.04))', borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>{t}</span>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteTipo(t)}>
                    Remover
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowTiposModal(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmação de excluir / arquivar cliente (modal bonito no lugar do confirm feio) */}
      {confirmar && (
        <div className="modal-overlay" onClick={() => !processandoExcluir && setConfirmar(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            {confirmar.fase === 'excluir' ? (
              <>
                <h2 style={{ marginTop: 0 }}>Excluir cliente</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.5 }}>
                  Tem certeza que quer excluir <strong style={{ color: 'var(--text)' }}>{confirmar.nome || 'este cliente'}</strong>? Essa ação não pode ser desfeita.
                </p>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setConfirmar(null)} disabled={processandoExcluir}>Cancelar</button>
                  <button className="btn btn-danger" onClick={executarExcluir} disabled={processandoExcluir}>
                    {processandoExcluir ? 'Excluindo...' : 'Excluir'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 style={{ marginTop: 0 }}>Cliente com vendas</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--text)' }}>{confirmar.nome || 'Este cliente'}</strong> já tem vendas registradas, então não dá pra apagar de vez (apagaria o histórico de vendas).
                  <br /><br />
                  Deseja <strong style={{ color: 'var(--text)' }}>arquivar</strong>? Ele sai da lista, mas as vendas continuam guardadas. (Marque “Mostrar arquivados” pra vê-lo de novo.)
                </p>
                <div className="modal-actions">
                  <button className="btn btn-secondary" onClick={() => setConfirmar(null)} disabled={processandoExcluir}>Cancelar</button>
                  <button className="btn btn-primary" onClick={executarArquivar} disabled={processandoExcluir}>
                    {processandoExcluir ? 'Arquivando...' : 'Arquivar cliente'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
