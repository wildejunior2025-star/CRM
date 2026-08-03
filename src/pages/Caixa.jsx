import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Caixa.css'

const STATUS_BADGE = {
  aberto: 'badge-success',
  fechado: 'badge-neutral',
}

export default function Caixa() {
  const { user, profile } = useAuth()
  const isAdmin = profile?.perfil === 'admin'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [caixaAtual, setCaixaAtual] = useState(null)
  const [resumo, setResumo] = useState(null)
  const [movimentos, setMovimentos] = useState([])
  const [historico, setHistorico] = useState([])
  const [usuarios, setUsuarios] = useState([])

  const [showAbertura, setShowAbertura] = useState(false)
  const [valorAbertura, setValorAbertura] = useState('')
  const [obsAbertura, setObsAbertura] = useState('')

  const [showMovimento, setShowMovimento] = useState(null) // 'sangria' | 'suprimento' | null
  const [valorMovimento, setValorMovimento] = useState('')
  const [obsMovimento, setObsMovimento] = useState('')
  const [formaMovimento, setFormaMovimento] = useState('dinheiro') // 'dinheiro' | 'pix'

  const [showFechamento, setShowFechamento] = useState(false)
  const [valorFechamento, setValorFechamento] = useState('')
  const [obsFechamento, setObsFechamento] = useState('')

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)

  const [editandoMovId, setEditandoMovId] = useState(null) // movimento com seletor de forma aberto
  const [salvandoMovForma, setSalvandoMovForma] = useState(false)

  // Corrige a forma (dinheiro/pix) de uma sangria/suprimento já registrado.
  async function trocarFormaMovimento(m, forma) {
    if (forma === (m.forma ?? 'dinheiro')) { setEditandoMovId(null); return }
    setSalvandoMovForma(true)
    const { error: rpcError } = await supabase.rpc('alterar_forma_movimento_caixa', {
      p_id: m.id, p_forma: forma,
    })
    setSalvandoMovForma(false)
    setEditandoMovId(null)
    if (rpcError) { window.alert('Não deu pra trocar a forma: ' + rpcError.message); return }
    loadAll()
  }

  async function loadAll() {
    setLoading(true)
    setError(null)

    // Caixa aberto é SEMPRE o do usuário logado — inclusive pro admin. Antes o admin
    // via o caixa aberto por qualquer um da loja, e aí esta tela dizia "aberto"
    // enquanto o Salão dizia "abra o caixa" (a venda usa current_caixa_id(), que é o
    // caixa de quem está logado). O histórico abaixo continua mostrando todos pro admin.
    const caixaAtivaQuery = supabase
      .from('caixas').select('*')
      .eq('aberto_por', user.id).eq('status', 'aberto').limit(1)

    const [caixaRes, historicoRes, usuariosRes] = await Promise.all([
      caixaAtivaQuery,
      supabase.from('caixas').select('*').order('aberto_em', { ascending: false }).limit(20),
      isAdmin ? supabase.from('profiles').select('id, nome, email') : Promise.resolve({ data: [] }),
    ])

    const firstError = caixaRes.error || historicoRes.error || usuariosRes.error
    if (firstError) setError(firstError.message)

    setCaixaAtual(caixaRes.data?.[0] ?? null)
    setHistorico(historicoRes.data ?? [])
    setUsuarios(usuariosRes.data ?? [])

    if (caixaRes.data?.[0]) {
      const [resumoRes, movimentosRes] = await Promise.all([
        supabase.from('caixa_resumo').select('*').eq('caixa_id', caixaRes.data[0].id).maybeSingle(),
        supabase
          .from('caixa_movimentos')
          .select('*')
          .eq('caixa_id', caixaRes.data[0].id)
          .order('created_at', { ascending: false }),
      ])
      setResumo(resumoRes.data ?? null)
      setMovimentos(movimentosRes.data ?? [])
    } else {
      setResumo(null)
      setMovimentos([])
    }

    setLoading(false)
  }

  useEffect(() => {
    if (user?.id) loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  function nomeUsuario(id) {
    const u = usuarios.find((x) => x.id === id)
    return u?.nome || u?.email || '-'
  }

  function openAbertura() {
    setValorAbertura('')
    setObsAbertura('')
    setFormError(null)
    setShowAbertura(true)
  }

  async function handleAbrir(e) {
    e.preventDefault()
    setFormError(null)

    const valor = Number(valorAbertura)
    if (!(valor >= 0)) {
      setFormError('Informe um valor de abertura válido.')
      return
    }

    setSaving(true)
    const { error: rpcError } = await supabase.rpc('abrir_caixa', {
      p_valor_abertura: valor,
      p_observacoes: obsAbertura || null,
    })
    setSaving(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    setShowAbertura(false)
    loadAll()
  }

  function openMovimento(tipo) {
    setValorMovimento('')
    setObsMovimento('')
    setFormaMovimento('dinheiro')
    setFormError(null)
    setShowMovimento(tipo)
  }

  async function handleMovimento(e) {
    e.preventDefault()
    setFormError(null)

    const valor = Number(valorMovimento)
    if (!(valor > 0)) {
      setFormError('Informe um valor válido.')
      return
    }

    setSaving(true)
    const { error: rpcError } = await supabase.rpc('registrar_movimento_caixa', {
      p_caixa_id: caixaAtual.id,
      p_tipo: showMovimento,
      p_valor: valor,
      p_observacao: obsMovimento || null,
      p_forma: formaMovimento,
    })
    setSaving(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    setShowMovimento(null)
    loadAll()
  }

  function openFechamento() {
    setValorFechamento('')
    setObsFechamento('')
    setFormError(null)
    setShowFechamento(true)
  }

  async function handleFechar(e) {
    e.preventDefault()
    setFormError(null)

    const valor = Number(valorFechamento)
    if (!(valor >= 0)) {
      setFormError('Informe um valor de fechamento válido.')
      return
    }

    setSaving(true)
    const { error: rpcError } = await supabase.rpc('fechar_caixa', {
      p_caixa_id: caixaAtual.id,
      p_valor_fechamento: valor,
      p_observacoes: obsFechamento || null,
    })
    setSaving(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    setShowFechamento(false)
    loadAll()
  }

  // Só o que é EM DINHEIRO mexe no caixa físico. Sangria/suprimento por PIX não entra
  // aqui (fica registrado, mas não altera o dinheiro esperado na gaveta).
  const valorEsperadoDinheiro = resumo
    ? Number(caixaAtual.valor_abertura) +
      Number(resumo.recebimentos_dinheiro) +
      Number(resumo.total_suprimentos_dinheiro ?? resumo.total_suprimentos) -
      Number(resumo.total_sangrias_dinheiro ?? resumo.total_sangrias)
    : 0

  const diferencaFechamento =
    showFechamento && valorFechamento !== ''
      ? Number(valorFechamento) - valorEsperadoDinheiro
      : null

  return (
    <div>
      <div className="page-header">
        <h1>Caixa</h1>
        {!loading && !caixaAtual && (
          <button className="btn btn-primary" onClick={openAbertura}>
            + Abrir caixa
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <div className="empty-state">Carregando...</div>
      ) : !caixaAtual ? (
        <div className="card empty-state">Você não tem nenhum caixa aberto no momento.</div>
      ) : (
        <>
          <div className="card caixa-info-card" style={{ marginBottom: 20 }}>
            <div>
              <div className="label">Caixa aberto em</div>
              <div className="value-sm">{new Date(caixaAtual.aberto_em).toLocaleString('pt-BR')}</div>
            </div>
            <div>
              <div className="label">Valor de abertura</div>
              <div className="value-sm">R$ {Number(caixaAtual.valor_abertura).toFixed(2)}</div>
            </div>
            {caixaAtual.observacoes_abertura && (
              <div>
                <div className="label">Observações</div>
                <div className="value-sm">{caixaAtual.observacoes_abertura}</div>
              </div>
            )}
          </div>

          <div className="caixa-actions" style={{ marginBottom: 20 }}>
            <button className="btn btn-secondary" onClick={() => openMovimento('sangria')}>
              - Registrar sangria
            </button>
            <button className="btn btn-secondary" onClick={() => openMovimento('suprimento')}>
              + Registrar suprimento
            </button>
            <button className="btn btn-danger" onClick={openFechamento}>
              Fechar caixa
            </button>
          </div>

          {resumo && (
            <div className="dashboard-grid" style={{ marginBottom: 24 }}>
              {/* Fora daqui de propósito (a view caixa_resumo continua calculando tudo):
                  "Vendas à vista" repetia "Recebimentos em dinheiro" pro lojista, e
                  boleto/transferência não existem na operação — é tudo PIX. */}
              <div className="card dashboard-card">
                <div className="label">Vendas fiado</div>
                <div className="value">R$ {Number(resumo.vendas_fiado).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Recebimentos em dinheiro</div>
                <div className="value">R$ {Number(resumo.recebimentos_dinheiro).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Recebimentos Pix</div>
                <div className="value">R$ {Number(resumo.recebimentos_pix).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Recebimentos cartão</div>
                <div className="value">R$ {Number(resumo.recebimentos_cartao).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Sangrias</div>
                <div className="value">R$ {Number(resumo.total_sangrias).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Suprimentos</div>
                <div className="value">R$ {Number(resumo.total_suprimentos).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Esperado em dinheiro</div>
                <div className="value">R$ {valorEsperadoDinheiro.toFixed(2)}</div>
              </div>
            </div>
          )}

          <h2 className="caixa-table-title">Sangrias e suprimentos</h2>
          <div className="data-table" style={{ marginBottom: 24 }}>
            {movimentos.length === 0 ? (
              <div className="empty-state">Nenhum movimento registrado.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Tipo</th>
                    <th>Forma</th>
                    <th className="caixa-amount-col">Valor</th>
                    <th>Observação</th>
                  </tr>
                </thead>
                <tbody>
                  {movimentos.map((m) => (
                    <tr key={m.id}>
                      <td>{new Date(m.created_at).toLocaleString('pt-BR')}</td>
                      <td>
                        <span
                          className={`badge ${m.tipo === 'sangria' ? 'badge-danger' : 'badge-success'}`}
                        >
                          {m.tipo === 'sangria' ? 'Sangria' : 'Suprimento'}
                        </span>
                      </td>
                      <td>
                        {editandoMovId === m.id ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            {[['dinheiro', '💵 Dinheiro'], ['pix', '📱 PIX']].map(([id, lbl]) => (
                              <button key={id} type="button" disabled={salvandoMovForma}
                                onClick={() => trocarFormaMovimento(m, id)}
                                style={{ padding: '4px 9px', borderRadius: 7, cursor: salvandoMovForma ? 'wait' : 'pointer', fontWeight: 700, fontSize: 12.5,
                                  border: `1.5px solid ${(m.forma ?? 'dinheiro') === id ? 'var(--primary)' : 'var(--border)'}`,
                                  background: (m.forma ?? 'dinheiro') === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                                {lbl}
                              </button>
                            ))}
                            <button type="button" onClick={() => setEditandoMovId(null)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>✕</button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setEditandoMovId(m.id)} title="Trocar a forma"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1px dashed var(--border)',
                              borderRadius: 7, padding: '3px 8px', cursor: 'pointer', color: 'var(--text)', font: 'inherit' }}>
                            {(m.forma ?? 'dinheiro') === 'pix' ? '📱 PIX' : '💵 Dinheiro'}
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>✎</span>
                          </button>
                        )}
                      </td>
                      <td className="caixa-amount-col">R$ {Number(m.valor).toFixed(2)}</td>
                      <td>{m.observacao ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <h2 className="caixa-table-title">Histórico de caixas</h2>
      <div className="data-table">
        {historico.length === 0 ? (
          <div className="empty-state">Nenhum caixa registrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                {isAdmin && <th>Usuário</th>}
                <th>Abertura</th>
                <th>Fechamento</th>
                <th className="caixa-amount-col">Valor abertura</th>
                <th className="caixa-amount-col">Valor fechamento</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {historico.map((c) => (
                <tr key={c.id}>
                  {isAdmin && <td>{nomeUsuario(c.aberto_por)}</td>}
                  <td>{new Date(c.aberto_em).toLocaleString('pt-BR')}</td>
                  <td>{c.fechado_em ? new Date(c.fechado_em).toLocaleString('pt-BR') : '-'}</td>
                  <td className="caixa-amount-col">R$ {Number(c.valor_abertura).toFixed(2)}</td>
                  <td className="caixa-amount-col">
                    {c.valor_fechamento_informado != null
                      ? `R$ ${Number(c.valor_fechamento_informado).toFixed(2)}`
                      : '-'}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[c.status] ?? 'badge-neutral'}`}>
                      {c.status === 'aberto' ? 'Aberto' : 'Fechado'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAbertura && (
        <div className="modal-overlay" onClick={() => setShowAbertura(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Abrir caixa</h2>
            <form onSubmit={handleAbrir}>
              <div className="form-grid">
                <div className="form-field full">
                  <label htmlFor="valor-abertura">Valor de abertura (R$)</label>
                  <input
                    id="valor-abertura"
                    name="valor_abertura"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorAbertura}
                    onChange={(e) => setValorAbertura(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="form-field full">
                  <label htmlFor="obs-abertura">Observações</label>
                  <textarea
                    id="obs-abertura"
                    name="observacoes"
                    rows={2}
                    value={obsAbertura}
                    onChange={(e) => setObsAbertura(e.target.value)}
                  />
                </div>
              </div>

              {formError && <p className="error-text">{formError}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowAbertura(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Abrindo...' : 'Abrir caixa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showMovimento && (
        <div className="modal-overlay" onClick={() => setShowMovimento(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{showMovimento === 'sangria' ? 'Registrar sangria' : 'Registrar suprimento'}</h2>
            <form onSubmit={handleMovimento}>
              <div className="form-grid">
                <div className="form-field full">
                  <label htmlFor="valor-movimento">Valor (R$)</label>
                  <input
                    id="valor-movimento"
                    name="valor"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={valorMovimento}
                    onChange={(e) => setValorMovimento(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="form-field full">
                  <label>{showMovimento === 'sangria' ? 'Saiu como' : 'Entrou como'}</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[['dinheiro', '💵 Dinheiro'], ['pix', '📱 PIX']].map(([id, lbl]) => (
                      <button key={id} type="button" onClick={() => setFormaMovimento(id)}
                        style={{ flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                          border: `1.5px solid ${formaMovimento === id ? 'var(--primary)' : 'var(--border)'}`,
                          background: formaMovimento === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                    {formaMovimento === 'pix'
                      ? 'Por PIX não altera o dinheiro esperado na gaveta — só fica registrado.'
                      : 'Em dinheiro entra/sai da gaveta e ajusta o esperado em dinheiro.'}
                  </span>
                </div>
                <div className="form-field full">
                  <label htmlFor="obs-movimento">Observação</label>
                  <textarea
                    id="obs-movimento"
                    name="observacao"
                    rows={2}
                    value={obsMovimento}
                    onChange={(e) => setObsMovimento(e.target.value)}
                  />
                </div>
              </div>

              {formError && <p className="error-text">{formError}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowMovimento(null)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando...' : 'Confirmar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showFechamento && (
        <div className="modal-overlay" onClick={() => setShowFechamento(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Fechar caixa</h2>
            <p className="caixa-esperado">
              Valor esperado em dinheiro: <strong>R$ {valorEsperadoDinheiro.toFixed(2)}</strong>
            </p>
            <form onSubmit={handleFechar}>
              <div className="form-grid">
                <div className="form-field full">
                  <label htmlFor="valor-fechamento">Valor contado em dinheiro (R$)</label>
                  <input
                    id="valor-fechamento"
                    name="valor_fechamento"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorFechamento}
                    onChange={(e) => setValorFechamento(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                {diferencaFechamento !== null && !Number.isNaN(diferencaFechamento) && (
                  <div className="form-field full">
                    <span
                      className={`badge ${
                        Math.abs(diferencaFechamento) < 0.005
                          ? 'badge-success'
                          : diferencaFechamento > 0
                          ? 'badge-primary'
                          : 'badge-danger'
                      }`}
                    >
                      Diferença: R$ {diferencaFechamento.toFixed(2)}
                      {diferencaFechamento > 0.005
                        ? ' (sobra)'
                        : diferencaFechamento < -0.005
                        ? ' (falta)'
                        : ' (confere)'}
                    </span>
                  </div>
                )}
                <div className="form-field full">
                  <label htmlFor="obs-fechamento">Observações</label>
                  <textarea
                    id="obs-fechamento"
                    name="observacoes"
                    rows={2}
                    value={obsFechamento}
                    onChange={(e) => setObsFechamento(e.target.value)}
                  />
                </div>
              </div>

              {formError && <p className="error-text">{formError}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowFechamento(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-danger" disabled={saving}>
                  {saving ? 'Fechando...' : 'Fechar caixa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
