import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

function ItemSearch({ items, value, onChange, placeholder = 'Buscar...' }) {
  const [busca, setBusca] = useState('')
  const [aberto, setAberto] = useState(false)
  const selecionado = items.find((i) => i.id === value)
  const filtrados = busca.trim()
    ? items.filter((i) => i.nome.toLowerCase().includes(busca.toLowerCase())).slice(0, 12)
    : items.slice(0, 12)
  function handleSelect(id) { onChange(id); setBusca(''); setAberto(false) }
  const displayValue = aberto ? busca : (selecionado?.nome ?? '')
  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        placeholder={placeholder}
        value={displayValue}
        onChange={(e) => { setBusca(e.target.value); setAberto(true) }}
        onFocus={() => { setBusca(''); setAberto(true) }}
        onBlur={() => setTimeout(() => setAberto(false), 150)}
        autoComplete="off"
        style={{ width: '100%' }}
      />
      {aberto && filtrados.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
          background: 'var(--surface, #fff)', border: '1px solid var(--border)',
          borderRadius: 6, zIndex: 200, maxHeight: 220, overflowY: 'auto',
          boxShadow: '0 4px 16px rgba(0,0,0,.15)',
        }}>
          {filtrados.map((i) => (
            <div key={i.id} onMouseDown={() => handleSelect(i.id)} style={{
              padding: '8px 12px', cursor: 'pointer', fontSize: 14,
              color: 'var(--text)', borderBottom: '1px solid var(--border)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover,rgba(0,0,0,.05))'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {i.nome}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const MOTIVOS_PADRAO = {
  entrada: ['compra', 'devolucao', 'ajuste_inventario'],
  saida: ['venda', 'perda', 'ajuste_inventario'],
  // "Ajuste" não tinha motivo nenhum: a lista só ia até saída, então o campo
  // abria vazio. Aqui o motivo responde "por que a contagem não bateu".
  ajuste: ['ajuste_inventario', 'quebra', 'perda', 'erro_de_lancamento', 'sobra'],
}

export default function Estoque() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  // Loja que não conta estoque (restaurante, lanchonete): desligado, nenhum
  // movimento é gravado (trigger da migration 0126) e a tela some daqui.
  const [usaEstoque, setUsaEstoque] = useState(true)
  const [salvandoUso, setSalvandoUso] = useState(false)
  const [saldo, setSaldo] = useState([])
  const [produtos, setProdutos] = useState([])
  const [clientes, setClientes] = useState([])
  const [cascoSaldo, setCascoSaldo] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [showMovModal, setShowMovModal] = useState(false)
  const [movForm, setMovForm] = useState({
    produto_id: '',
    tipo: 'entrada',
    quantidade: '',
    motivo: 'compra',
    observacao: '',
  })
  const [savingMov, setSavingMov] = useState(false)

  const [showCascoModal, setShowCascoModal] = useState(false)
  const [cascoForm, setCascoForm] = useState({
    cliente_id: '',
    produto_id: '',
    tipo: 'entrega',
    quantidade: '',
    observacao: '',
  })
  const [savingCasco, setSavingCasco] = useState(false)

  const [motivos, setMotivos] = useState(MOTIVOS_PADRAO)
  const [showMotivosModal, setShowMotivosModal] = useState(false)
  const [motivoTab, setMotivoTab] = useState('entrada')
  const [novoMotivo, setNovoMotivo] = useState('')
  const [savingMotivo, setSavingMotivo] = useState(false)

  async function loadMotivos() {
    const { data } = await supabase.from('motivos_estoque').select('tipo, nome').order('nome')
    if (data && data.length > 0) {
      // A tabela só guarda motivo de entrada/saída; o de ajuste é fixo, então
      // preserva o padrão em vez de trocar o objeto inteiro e zerar a lista.
      setMotivos({
        entrada: data.filter(m => m.tipo === 'entrada').map(m => m.nome),
        saida: data.filter(m => m.tipo === 'saida').map(m => m.nome),
        ajuste: MOTIVOS_PADRAO.ajuste,
      })
    }
  }

  async function handleAddMotivo() {
    const nome = novoMotivo.trim().toLowerCase()
    if (!nome) return
    setSavingMotivo(true)
    await supabase.rpc('add_motivo_estoque', { p_tipo: motivoTab, p_nome: nome })
    setNovoMotivo('')
    await loadMotivos()
    setSavingMotivo(false)
  }

  async function handleDeleteMotivo(tipo, nome) {
    await supabase.from('motivos_estoque').delete().eq('tipo', tipo).eq('nome', nome)
    await loadMotivos()
  }

  async function carregarUsoEstoque() {
    if (!empresaId) return
    const { data } = await supabase.from('empresas').select('estoque_ativo').eq('id', empresaId).single()
    if (data) setUsaEstoque(data.estoque_ativo ?? true)
  }

  async function alternarUsoEstoque() {
    if (!empresaId || salvandoUso) return
    const novo = !usaEstoque
    setSalvandoUso(true)
    const { error: err } = await supabase.from('empresas').update({ estoque_ativo: novo }).eq('id', empresaId)
    setSalvandoUso(false)
    if (err) { setError(err.message); return }
    setUsaEstoque(novo)
    setError(null)
    if (novo) loadAll()
  }

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [saldoRes, produtosRes, clientesRes, cascoRes] = await Promise.all([
      supabase.from('estoque_saldo').select('*').order('nome'),
      supabase
        .from('produtos')
        .select('id, nome, controla_casco')
        .eq('ativo', true)
        .order('nome'),
      supabase.from('clientes').select('id, nome').eq('ativo', true).order('nome'),
      supabase.from('casco_saldo').select('*').order('cliente_nome'),
    ])

    const firstError =
      saldoRes.error || produtosRes.error || clientesRes.error || cascoRes.error
    if (firstError) setError(firstError.message)

    setSaldo(saldoRes.data ?? [])
    setProdutos(produtosRes.data ?? [])
    setClientes(clientesRes.data ?? [])
    setCascoSaldo((cascoRes.data ?? []).filter((c) => c.saldo_cascos !== 0))

    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    loadMotivos()
  }, [])

  useEffect(() => { carregarUsoEstoque() }, [empresaId])

  function openMovModal() {
    setMovForm({
      produto_id: produtos[0]?.id ?? '',
      tipo: 'entrada',
      quantidade: '',
      motivo: 'compra',
      observacao: '',
    })
    setShowMovModal(true)
  }

  function handleMovChange(e) {
    const { name, value } = e.target
    setMovForm((prev) => {
      const next = { ...prev, [name]: value }
      if (name === 'tipo') {
        next.motivo = (motivos[value] ?? MOTIVOS_PADRAO[value] ?? [])[0] ?? ''
      }
      return next
    })
  }

  // Saldo que a tela mostra hoje pro produto escolhido (base do ajuste).
  function saldoDoProduto(produtoId) {
    const linha = saldo.find((s) => s.produto_id === produtoId)
    return Number(linha?.quantidade_atual ?? 0)
  }

  async function handleMovSubmit(e) {
    e.preventDefault()
    setSavingMov(true)
    setError(null)

    // Ajuste é contagem, não soma: o dono digita o que TEM na prateleira e a
    // gente grava só a diferença. Antes o "ajuste" entrava somando igualzinho a
    // uma entrada — quem contava 10 e digitava 10 ficava com 20.
    let linha
    if (movForm.tipo === 'ajuste') {
      const contado = Number(movForm.quantidade)
      const diferenca = contado - saldoDoProduto(movForm.produto_id)
      if (diferenca === 0) {
        setSavingMov(false)
        setShowMovModal(false)
        return
      }
      linha = {
        produto_id: movForm.produto_id,
        tipo: diferenca > 0 ? 'entrada' : 'saida',
        quantidade: Math.abs(diferenca),
        motivo: movForm.motivo || 'ajuste_inventario',
        observacao: movForm.observacao || `Ajuste de inventário: contado ${contado}`,
      }
    } else {
      linha = {
        produto_id: movForm.produto_id,
        tipo: movForm.tipo,
        quantidade: Number(movForm.quantidade),
        motivo: movForm.motivo,
        observacao: movForm.observacao || null,
      }
    }

    const { error } = await supabase.from('estoque_movimentos').insert(linha)

    setSavingMov(false)

    if (error) {
      setError(error.message)
      return
    }

    setShowMovModal(false)
    loadAll()
  }

  function openCascoModal() {
    setCascoForm({
      cliente_id: clientes[0]?.id ?? '',
      produto_id: produtos.find((p) => p.controla_casco)?.id ?? '',
      tipo: 'entrega',
      quantidade: '',
      observacao: '',
    })
    setShowCascoModal(true)
  }

  function handleCascoChange(e) {
    const { name, value } = e.target
    setCascoForm((prev) => ({ ...prev, [name]: value }))
  }

  async function handleCascoSubmit(e) {
    e.preventDefault()
    setSavingCasco(true)
    setError(null)

    const { error } = await supabase.from('casco_movimentos').insert({
      cliente_id: cascoForm.cliente_id,
      produto_id: cascoForm.produto_id,
      tipo: cascoForm.tipo,
      quantidade: Number(cascoForm.quantidade),
      observacao: cascoForm.observacao || null,
    })

    setSavingCasco(false)

    if (error) {
      setError(error.message)
      return
    }

    setShowCascoModal(false)
    loadAll()
  }

  const produtosComCasco = produtos.filter((p) => p.controla_casco)
  // Casco (vasilhame que volta) é coisa de distribuidora de bebida: o cliente
  // leva a garrafa e devolve depois. Restaurante não tem isso, e a seção só
  // ocupava espaço. Só aparece pra quem marcou "controla casco" em algum
  // produto — ou pra quem ainda tem casco pendente de antes.
  const usaCasco = produtosComCasco.length > 0 || cascoSaldo.length > 0

  return (
    <div>
      <div className="page-header">
        <h1>Estoque</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={`btn ${usaEstoque ? 'btn-secondary' : 'btn-primary'}`}
            onClick={alternarUsoEstoque}
            disabled={salvandoUso}
            title={usaEstoque
              ? 'Desligar o controle de estoque desta loja'
              : 'Voltar a controlar estoque nesta loja'}
          >
            {salvandoUso ? 'Salvando...' : usaEstoque ? '🚫 Não trabalho com estoque' : '📦 Voltar a usar estoque'}
          </button>
          {usaEstoque && (
            <>
              <button className="btn btn-secondary" onClick={() => setShowMotivosModal(true)}>
                Motivos
              </button>
              {usaCasco && (
                <button className="btn btn-secondary" onClick={openCascoModal}>
                  + Movimento de casco
                </button>
              )}
              <button className="btn btn-primary" onClick={openMovModal}>
                + Movimento de estoque
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* Loja sem estoque: nada de tabela zerada e "estoque baixo" em tudo. */}
      {!usaEstoque && (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>🚫📦</div>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>
            Esta loja não trabalha com estoque
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 auto', maxWidth: 460 }}>
            As vendas não descontam mais nada e você não recebe alerta de estoque baixo.
            Os produtos continuam normais no cardápio e no gestor — só o controle de quantidade
            fica desligado. É só clicar em <strong>Voltar a usar estoque</strong> pra ligar de novo.
          </p>
        </div>
      )}

      {usaEstoque && (<>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Saldo por produto</h2>
      <div className="data-table" style={{ marginBottom: 24 }}>
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : saldo.length === 0 ? (
          <div className="empty-state">Nenhum produto cadastrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th>Categoria</th>
                <th>Estoque atual</th>
                <th>Estoque mínimo</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {saldo.map((s) => {
                // Sem mínimo definido não existe "baixo": era por isso que a
                // tela pintava TODA linha de vermelho quando mínimo era 0.
                const baixo = Number(s.estoque_minimo) > 0 && Number(s.quantidade_atual) <= Number(s.estoque_minimo)
                return (
                  <tr key={s.produto_id}>
                    <td>{s.nome}</td>
                    <td>{s.categoria}</td>
                    <td>{s.quantidade_atual}</td>
                    <td>{s.estoque_minimo}</td>
                    <td>
                      <span
                        className={`badge ${baixo ? 'badge-danger' : 'badge-success'}`}
                      >
                        {baixo ? 'Estoque baixo' : 'Ok'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      </>)}

      {usaEstoque && usaCasco && (<>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>
        Vasilhame (casco) pendente com clientes
      </h2>
      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : cascoSaldo.length === 0 ? (
          <div className="empty-state">Nenhum casco pendente.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Produto</th>
                <th>Saldo de cascos</th>
              </tr>
            </thead>
            <tbody>
              {cascoSaldo.map((c) => (
                <tr key={`${c.cliente_id}-${c.produto_id}`}>
                  <td>{c.cliente_nome}</td>
                  <td>{c.produto_nome}</td>
                  <td>
                    <span
                      className={`badge ${
                        c.saldo_cascos > 0 ? 'badge-warning' : 'badge-success'
                      }`}
                    >
                      {c.saldo_cascos}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </>)}

      {showMovModal && (
        <div className="modal-overlay" onClick={() => setShowMovModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Novo movimento de estoque</h2>
            <form onSubmit={handleMovSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Produto</label>
                  <ItemSearch
                    items={produtos}
                    value={movForm.produto_id}
                    onChange={(id) => setMovForm((p) => ({ ...p, produto_id: id }))}
                    placeholder="Buscar produto..."
                  />
                </div>

                <div className="form-field">
                  <label>Tipo</label>
                  <select name="tipo" value={movForm.tipo} onChange={handleMovChange}>
                    <option value="entrada">Entrada</option>
                    <option value="saida">Saída</option>
                    <option value="ajuste">Ajuste</option>
                  </select>
                </div>

                <div className="form-field">
                  <label>Motivo</label>
                  <select
                    name="motivo"
                    value={movForm.motivo}
                    onChange={handleMovChange}
                  >
                    {(motivos[movForm.tipo] ?? MOTIVOS_PADRAO[movForm.tipo] ?? []).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>
                    {movForm.tipo === 'ajuste' ? 'Quantidade contada' : 'Quantidade'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    name="quantidade"
                    value={movForm.quantidade}
                    onChange={handleMovChange}
                    required
                  />
                  {movForm.tipo === 'ajuste' && movForm.produto_id && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Digite quanto tem de verdade na prateleira. O sistema tem{' '}
                      <strong>{saldoDoProduto(movForm.produto_id)}</strong> e grava só a diferença.
                    </span>
                  )}
                </div>

                <div className="form-field full">
                  <label>Observação</label>
                  <input
                    name="observacao"
                    value={movForm.observacao}
                    onChange={handleMovChange}
                  />
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowMovModal(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingMov}>
                  {savingMov ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showMotivosModal && (
        <div className="modal-overlay" onClick={() => setShowMotivosModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h2>Motivos de movimentação</h2>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {['entrada', 'saida'].map(t => (
                <button
                  key={t}
                  className={`btn btn-sm ${motivoTab === t ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => { setMotivoTab(t); setNovoMotivo('') }}
                >
                  {t === 'entrada' ? 'Entrada' : 'Saída'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                value={novoMotivo}
                onChange={(e) => setNovoMotivo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddMotivo())}
                placeholder={`Novo motivo de ${motivoTab === 'entrada' ? 'entrada' : 'saída'}...`}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary btn-sm" onClick={handleAddMotivo} disabled={savingMotivo || !novoMotivo.trim()}>
                + Adicionar
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(motivos[motivoTab] ?? []).map((m) => (
                <div key={m} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-hover, rgba(0,0,0,.04))', borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>{m}</span>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteMotivo(motivoTab, m)}>
                    Remover
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowMotivosModal(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      {showCascoModal && (
        <div className="modal-overlay" onClick={() => setShowCascoModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Novo movimento de casco</h2>
            <form onSubmit={handleCascoSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Cliente</label>
                  <select
                    name="cliente_id"
                    value={cascoForm.cliente_id}
                    onChange={handleCascoChange}
                    required
                  >
                    {clientes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field full">
                  <label>Produto (com controle de casco)</label>
                  <select
                    name="produto_id"
                    value={cascoForm.produto_id}
                    onChange={handleCascoChange}
                    required
                  >
                    {produtosComCasco.length === 0 && (
                      <option value="">Nenhum produto com controle de casco</option>
                    )}
                    {produtosComCasco.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Tipo</label>
                  <select
                    name="tipo"
                    value={cascoForm.tipo}
                    onChange={handleCascoChange}
                  >
                    <option value="entrega">Entrega ao cliente</option>
                    <option value="devolucao">Devolução do cliente</option>
                  </select>
                </div>

                <div className="form-field">
                  <label>Quantidade</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    name="quantidade"
                    value={cascoForm.quantidade}
                    onChange={handleCascoChange}
                    required
                  />
                </div>

                <div className="form-field full">
                  <label>Observação</label>
                  <input
                    name="observacao"
                    value={cascoForm.observacao}
                    onChange={handleCascoChange}
                  />
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCascoModal(false)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={savingCasco || produtosComCasco.length === 0}
                >
                  {savingCasco ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
