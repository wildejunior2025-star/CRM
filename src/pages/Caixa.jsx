import { Fragment, useEffect, useState } from 'react'
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
  const [valorFechamentoPix, setValorFechamentoPix] = useState('')
  const [obsFechamento, setObsFechamento] = useState('')

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)

  const [editandoMovId, setEditandoMovId] = useState(null) // movimento com seletor de forma aberto
  const [salvandoMovForma, setSalvandoMovForma] = useState(false)

  // Histórico expandível: mostra o detalhamento por forma de pagamento de um caixa fechado.
  const [histAberto, setHistAberto] = useState(null)      // id do caixa expandido
  const [histResumo, setHistResumo] = useState({})        // { [caixaId]: resumo | 'loading' }
  async function toggleHist(c) {
    const abrir = histAberto !== c.id
    setHistAberto(abrir ? c.id : null)
    if (abrir && !histResumo[c.id]) {
      setHistResumo(m => ({ ...m, [c.id]: 'loading' }))
      const { data } = await supabase.from('caixa_resumo').select('*').eq('caixa_id', c.id).maybeSingle()
      setHistResumo(m => ({ ...m, [c.id]: data || {} }))
    }
  }

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
    setValorFechamentoPix('')
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
      p_valor_fechamento_pix: valorFechamentoPix === '' ? null : Number(valorFechamentoPix),
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

  // PIX hoje é igual dinheiro: esperado em PIX = recebido em PIX + suprimentos − sangrias (por PIX).
  const valorEsperadoPix = resumo
    ? Number(resumo.recebimentos_pix || 0) +
      Number(resumo.total_suprimentos_pix || 0) -
      Number(resumo.total_sangrias_pix || 0)
    : 0
  const diferencaFechamentoPix =
    showFechamento && valorFechamentoPix !== ''
      ? Number(valorFechamentoPix) - valorEsperadoPix
      : null

  // Faturamento total do caixa: soma de TODAS as formas (dinheiro + pix + cartão + transferência + fiado).
  const faturamentoTotal = resumo
    ? Number(resumo.recebimentos_dinheiro || 0) +
      Number(resumo.recebimentos_pix || 0) +
      Number(resumo.recebimentos_cartao || 0) +
      Number(resumo.recebimentos_transferencia || 0) +
      Number(resumo.vendas_fiado || 0)
    : 0

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
            <>
            {/* Faturamento total — soma de TODAS as formas, em destaque (cor diferente). */}
            <div className="card" style={{ marginBottom: 14, border: '2px solid var(--primary)', background: 'var(--primary-bg, rgba(124,58,237,.08))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1 }}>💰 Faturamento total (todas as formas)</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--primary)' }}>R$ {faturamentoTotal.toFixed(2)}</div>
            </div>
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
              <div className="card dashboard-card">
                <div className="label">Esperado em PIX</div>
                <div className="value">R$ {valorEsperadoPix.toFixed(2)}</div>
              </div>
            </div>
            </>
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
              {historico.map((c) => {
                const aberto = histAberto === c.id
                const r = histResumo[c.id]
                const nCols = isAdmin ? 6 : 5
                const espDin = r && r !== 'loading'
                  ? Number(c.valor_abertura || 0) + Number(r.recebimentos_dinheiro || 0) + Number(r.total_suprimentos_dinheiro ?? r.total_suprimentos ?? 0) - Number(r.total_sangrias_dinheiro ?? r.total_sangrias ?? 0)
                  : 0
                const espPix = r && r !== 'loading'
                  ? Number(r.recebimentos_pix || 0) + Number(r.total_suprimentos_pix || 0) - Number(r.total_sangrias_pix || 0)
                  : 0
                const fatTot = r && r !== 'loading'
                  ? Number(r.recebimentos_dinheiro || 0) + Number(r.recebimentos_pix || 0) + Number(r.recebimentos_cartao || 0) + Number(r.recebimentos_transferencia || 0) + Number(r.vendas_fiado || 0)
                  : 0
                const dif = (r && r !== 'loading' && c.valor_fechamento_informado != null) ? Number(c.valor_fechamento_informado) - espDin : null
                const difPix = (r && r !== 'loading' && c.valor_fechamento_pix != null) ? Number(c.valor_fechamento_pix) - espPix : null
                return (
                <Fragment key={c.id}>
                  <tr onClick={() => toggleHist(c)} style={{ cursor: 'pointer' }} title="Toque para ver o detalhamento por forma de pagamento">
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
                      <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 12 }}>{aberto ? '▲' : '▼'}</span>
                    </td>
                  </tr>
                  {aberto && (
                    <tr>
                      <td colSpan={nCols} style={{ background: 'var(--surface-hover)', padding: '12px 16px' }}>
                        {(!r || r === 'loading') ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Carregando detalhamento…</span>
                        ) : (
                          <>
                            {/* Faturamento total — todas as formas, em destaque */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '2px solid var(--primary)', background: 'var(--primary-bg, rgba(124,58,237,.08))' }}>
                              <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1 }}>💰 Faturamento total (todas as formas)</span>
                              <strong style={{ fontSize: 20, color: 'var(--primary)' }}>R$ {fatTot.toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                              {[
                                ['💵 Recebido em dinheiro', r.recebimentos_dinheiro],
                                ['📱 Recebido em PIX', r.recebimentos_pix],
                                ['💳 Recebido em cartão', r.recebimentos_cartao],
                                (Number(r.recebimentos_transferencia) > 0 ? ['🔁 Transferência', r.recebimentos_transferencia] : null),
                                ['🧾 Vendas no fiado', r.vendas_fiado],
                                ['➖ Sangrias', r.total_sangrias],
                                ['➕ Suprimentos', r.total_suprimentos],
                                ['🪙 Esperado em dinheiro', espDin],
                                ['🪙 Esperado em PIX', espPix],
                              ].filter(Boolean).map(([lb, v]) => (
                                <div key={lb} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 11px' }}>
                                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{lb}</div>
                                  <div style={{ fontSize: 16, fontWeight: 800 }}>R$ {Number(v || 0).toFixed(2)}</div>
                                </div>
                              ))}
                            </div>
                            {(Number(r.total_sangrias_pix) > 0 || Number(r.total_suprimentos_pix) > 0) && (
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                                {Number(r.total_sangrias_pix) > 0 && <>Sangrias por PIX: R$ {Number(r.total_sangrias_pix).toFixed(2)} (não abatem do dinheiro). </>}
                                {Number(r.total_suprimentos_pix) > 0 && <>Suprimentos por PIX: R$ {Number(r.total_suprimentos_pix).toFixed(2)}.</>}
                              </div>
                            )}
                            {dif !== null && (
                              <div style={{ marginTop: 10, fontSize: 13.5, fontWeight: 700 }}>
                                💵 Dinheiro contado: R$ {Number(c.valor_fechamento_informado).toFixed(2)} ·{' '}
                                <span style={{ color: Math.abs(dif) < 0.005 ? 'var(--success, #16a34a)' : (dif > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                                  Diferença: R$ {dif.toFixed(2)}{Math.abs(dif) < 0.005 ? ' (confere)' : dif > 0 ? ' (sobra)' : ' (falta)'}
                                </span>
                              </div>
                            )}
                            {difPix !== null && (
                              <div style={{ marginTop: 4, fontSize: 13.5, fontWeight: 700 }}>
                                📱 PIX conferido: R$ {Number(c.valor_fechamento_pix).toFixed(2)} ·{' '}
                                <span style={{ color: Math.abs(difPix) < 0.005 ? 'var(--success, #16a34a)' : (difPix > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                                  Diferença: R$ {difPix.toFixed(2)}{Math.abs(difPix) < 0.005 ? ' (confere)' : difPix > 0 ? ' (sobra)' : ' (falta)'}
                                </span>
                              </div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
                )
              })}
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
              Faturamento total: <strong style={{ color: 'var(--primary)' }}>R$ {faturamentoTotal.toFixed(2)}</strong><br />
              Esperado em dinheiro: <strong>R$ {valorEsperadoDinheiro.toFixed(2)}</strong><br />
              Esperado em PIX: <strong>R$ {valorEsperadoPix.toFixed(2)}</strong>
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
                      Diferença dinheiro: R$ {diferencaFechamento.toFixed(2)}
                      {diferencaFechamento > 0.005
                        ? ' (sobra)'
                        : diferencaFechamento < -0.005
                        ? ' (falta)'
                        : ' (confere)'}
                    </span>
                  </div>
                )}
                <div className="form-field full">
                  <label htmlFor="valor-fechamento-pix">Valor conferido em PIX (R$) <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85em' }}>opcional</span></label>
                  <input
                    id="valor-fechamento-pix"
                    name="valor_fechamento_pix"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorFechamentoPix}
                    onChange={(e) => setValorFechamentoPix(e.target.value)}
                    placeholder={`Esperado: ${valorEsperadoPix.toFixed(2)}`}
                  />
                </div>
                {diferencaFechamentoPix !== null && !Number.isNaN(diferencaFechamentoPix) && (
                  <div className="form-field full">
                    <span
                      className={`badge ${
                        Math.abs(diferencaFechamentoPix) < 0.005
                          ? 'badge-success'
                          : diferencaFechamentoPix > 0
                          ? 'badge-primary'
                          : 'badge-danger'
                      }`}
                    >
                      Diferença PIX: R$ {diferencaFechamentoPix.toFixed(2)}
                      {diferencaFechamentoPix > 0.005
                        ? ' (sobra)'
                        : diferencaFechamentoPix < -0.005
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
