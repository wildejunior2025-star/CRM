import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const MOTIVOS = {
  entrada: ['compra', 'devolucao', 'ajuste_inventario'],
  saida: ['venda', 'perda', 'ajuste_inventario'],
  ajuste: ['ajuste_inventario'],
}

export default function Estoque() {
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
  }, [])

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
        next.motivo = MOTIVOS[value][0]
      }
      return next
    })
  }

  async function handleMovSubmit(e) {
    e.preventDefault()
    setSavingMov(true)
    setError(null)

    const { error } = await supabase.from('estoque_movimentos').insert({
      produto_id: movForm.produto_id,
      tipo: movForm.tipo,
      quantidade: Number(movForm.quantidade),
      motivo: movForm.motivo,
      observacao: movForm.observacao || null,
    })

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

  return (
    <div>
      <div className="page-header">
        <h1>Estoque</h1>
        <div>
          <button className="btn btn-secondary" onClick={openCascoModal}>
            + Movimento de casco
          </button>{' '}
          <button className="btn btn-primary" onClick={openMovModal}>
            + Movimento de estoque
          </button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

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
                const baixo = Number(s.quantidade_atual) <= Number(s.estoque_minimo)
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

      {showMovModal && (
        <div className="modal-overlay" onClick={() => setShowMovModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Novo movimento de estoque</h2>
            <form onSubmit={handleMovSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Produto</label>
                  <select
                    name="produto_id"
                    value={movForm.produto_id}
                    onChange={handleMovChange}
                    required
                  >
                    {produtos.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
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
                    {MOTIVOS[movForm.tipo].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Quantidade</label>
                  <input
                    type="number"
                    step="0.01"
                    name="quantidade"
                    value={movForm.quantidade}
                    onChange={handleMovChange}
                    required
                  />
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
