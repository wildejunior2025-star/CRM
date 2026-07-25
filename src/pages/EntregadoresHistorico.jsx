import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Entregadores.css'

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const num = v => Number(v || 0)

const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['tudo', 'Tudo'], ['datas', 'Escolher datas']]
const ORDENS = [['devendo', 'Quem devo mais'], ['corridas', 'Mais corridas'], ['nome', 'Nome']]

const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// Início e fim do período em ISO (null = sem limite). O corte é o mesmo no resumo
// do banco e na lista de corridas, senão os dois números não fecham.
function faixaDe(periodo, de, ate) {
  if (periodo === 'hoje') { const d = new Date(); d.setHours(0, 0, 0, 0); return { desde: d.toISOString(), ate: null } }
  if (periodo === '7d') return { desde: new Date(Date.now() - 7 * 86400000).toISOString(), ate: null }
  if (periodo === '30d') return { desde: new Date(Date.now() - 30 * 86400000).toISOString(), ate: null }
  if (periodo === 'datas') {
    return {
      desde: de ? new Date(`${de}T00:00:00`).toISOString() : null,
      ate: ate ? new Date(`${ate}T23:59:59.999`).toISOString() : null,
    }
  }
  return { desde: null, ate: null }
}

const rotuloPeriodo = (periodo, de, ate) => {
  if (periodo !== 'datas') return (PERIODOS.find(p => p[0] === periodo) || [])[1]
  const br = s => s ? s.split('-').reverse().join('/') : ''
  if (de && ate) return `${br(de)} a ${br(ate)}`
  if (de) return `desde ${br(de)}`
  if (ate) return `até ${br(ate)}`
  return 'Escolher datas'
}

// Seletor de período — os mesmos botões na lista e no detalhe.
function FiltroPeriodo({ periodo, setPeriodo, de, setDe, ate, setAte }) {
  return (
    <div className="ent-periodo">
      <div className="ent-seg">
        {PERIODOS.map(([val, lab]) => (
          <button key={val} type="button" className={periodo === val ? 'on' : ''} onClick={() => setPeriodo(val)}>{lab}</button>
        ))}
      </div>
      {periodo === 'datas' && (
        <div className="ent-datas">
          <label>De <input type="date" value={de} max={ate || hojeISO()} onChange={e => setDe(e.target.value)} /></label>
          <label>Até <input type="date" value={ate} min={de || undefined} max={hojeISO()} onChange={e => setAte(e.target.value)} /></label>
        </div>
      )}
    </div>
  )
}

// Como o cliente pagou: se o entregador ficou com o dinheiro na mão, é repasse pra loja.
// PIX confirmado e pedido pago online (iFood) já caíram na conta — não se repassa.
function cobranca(p) {
  const f = p.forma_pagamento, ehIfood = p.origem === 'ifood'
  if (f === 'dinheiro') return { tipo: 'dinheiro', label: 'Dinheiro' + (ehIfood ? ' (via iFood)' : '') }
  if (['cartao', 'cartão', 'credito', 'debito'].includes(f)) {
    const n = f === 'debito' ? 'Débito' : f === 'credito' ? 'Crédito' : 'Cartão'
    return { tipo: 'cartao', label: n + (ehIfood ? ' (via iFood)' : ' (maquininha)') }
  }
  if (f === 'pix') {
    return (p.pix_status === 'pago' || p.mp_payment_status === 'approved')
      ? { tipo: 'conta', label: 'PIX pago' }
      : { tipo: 'pix', label: 'PIX não confirmado' }
  }
  if (ehIfood && f !== 'online') return { tipo: 'dinheiro', label: (f || 'via iFood') + ' (via iFood)' }
  return { tipo: 'conta', label: ehIfood ? 'Pago no iFood' : (f || 'Pago') }
}

const iniciais = nome => (nome || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('')

const dataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

const FORMAS = [['dinheiro', '💵 Dinheiro'], ['cartao', '💳 Cartão'], ['pix', '📱 PIX']]

// Corrida que o motoqueiro já pegou mas ainda não concluiu.
const STATUS_LABEL = {
  confirmado: 'Aceito',
  em_preparo: 'Na cozinha',
  pronto: 'Pronto, com ele',
  saiu_entrega: 'Em rota',
}

// Confirmação da casa — o confirm() do navegador é feio e não mostra o resumo.
function Confirmacao({ pedido, ocupado, onFechar }) {
  const [opcao, setOpcao] = useState(false)
  useEffect(() => {
    const esc = e => { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onFechar])
  useEffect(() => { setOpcao(false) }, [pedido])
  if (!pedido) return null
  const perigo = pedido.perigo
  return (
    <div className="ent-conf-overlay" onClick={onFechar} role="presentation">
      <div className="ent-conf" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className={`ent-conf-icone ${perigo ? 'perigo' : ''}`}>{perigo ? '↩️' : '💰'}</div>
        <h2>{pedido.titulo}</h2>
        {pedido.texto && <p>{pedido.texto}</p>}
        {pedido.resumo?.length > 0 && (
          <div className="ent-conf-resumo">
            {pedido.resumo.map(([lab, val]) => (
              <div key={lab}><span>{lab}</span><strong>{val}</strong></div>
            ))}
          </div>
        )}
        {pedido.alerta && (
          <div className="ent-conf-alerta">
            <div className="cab">⚠️ {pedido.alerta.titulo}</div>
            <p>{pedido.alerta.texto}</p>
            <div className="itens">
              {pedido.alerta.itens.map(it => (
                <div key={it.chave}>
                  <span>{it.titulo}</span>
                  <span className="c-muted">{it.detalhe}</span>
                  <strong>{it.valor}</strong>
                </div>
              ))}
            </div>
            <label className="ent-conf-opcao">
              <input type="checkbox" checked={opcao} onChange={e => setOpcao(e.target.checked)} />
              <span>{pedido.alerta.opcao}</span>
            </label>
          </div>
        )}
        <div className="ent-conf-acoes">
          <button type="button" className="btn btn-secondary" onClick={onFechar} disabled={ocupado}>Cancelar</button>
          <button type="button" className={`btn ${perigo ? 'btn-danger' : 'btn-ok'}`} disabled={ocupado} autoFocus
            onClick={async () => { const fn = pedido.acao; await fn(opcao); onFechar() }}>
            {ocupado ? 'Salvando…' : (pedido.botao || 'Confirmar')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function EntregadoresHistorico() {
  const { empresa } = useAuth()
  const [resumo, setResumo] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(null)
  const [periodo, setPeriodo] = useState('hoje')
  const [de, setDe] = useState(hojeISO())
  const [ate, setAte] = useState(hojeISO())
  const [busca, setBusca] = useState('')
  const [soDevendo, setSoDevendo] = useState(false)
  const [ordem, setOrdem] = useState('devendo')
  const [salvando, setSalvando] = useState(false)
  const [confirmacao, setConfirmacao] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [aba, setAba] = useState('acerto')
  const [acertos, setAcertos] = useState([])
  const [carregandoAcertos, setCarregandoAcertos] = useState(false)

  const avisar = useCallback((texto, erro = false) => {
    setAviso({ texto, erro })
    setTimeout(() => setAviso(a => (a?.texto === texto ? null : a)), 3200)
  }, [])

  const carregarResumo = useCallback(async () => {
    if (!empresa) return
    setLoading(true)
    const faixa = faixaDe(periodo, de, ate)
    const { data } = await supabase.rpc('entregadores_resumo', { p_empresa_id: empresa.id, p_desde: faixa.desde, p_ate: faixa.ate })
    setResumo(data || [])
    setLoading(false)
  }, [empresa, periodo, de, ate])

  useEffect(() => { carregarResumo() }, [carregarResumo])

  // Histórico: o período aqui filtra pela DATA DO PAGAMENTO, não pela da corrida.
  const carregarAcertos = useCallback(async () => {
    if (!empresa) return
    setCarregandoAcertos(true)
    const faixa = faixaDe(periodo, de, ate)
    const { data } = await supabase.rpc('entregadores_acertos', { p_empresa_id: empresa.id, p_desde: faixa.desde, p_ate: faixa.ate })
    setAcertos(data || [])
    setCarregandoAcertos(false)
  }, [empresa, periodo, de, ate])

  useEffect(() => { if (aba === 'historico') carregarAcertos() }, [aba, carregarAcertos])

  // Desfaz um acerto inteiro: as corridas daquele minuto voltam pra "a pagar".
  async function desfazerAcerto(a) {
    if (salvando) return false
    setSalvando(true)
    const fim = new Date(new Date(a.pago_em).getTime() + 60000).toISOString()
    const { error } = await supabase.from('pedidos_delivery').update(patchDe(false))
      .eq('empresa_id', empresa.id).eq('entregador_id', a.entregador_id)
      .gte('entregador_pago_em', a.pago_em).lt('entregador_pago_em', fim)
    setSalvando(false)
    if (error) { avisar('Não deu pra desfazer: ' + error.message, true); return false }
    return true
  }

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase()
    let arr = resumo.filter(e => (!q || (e.nome || '').toLowerCase().includes(q)) && (!soDevendo || num(e.valor_pendente) > 0))
    if (ordem === 'nome') arr = [...arr].sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
    else if (ordem === 'corridas') arr = [...arr].sort((a, b) => num(b.corridas) - num(a.corridas))
    else arr = [...arr].sort((a, b) => num(b.valor_pendente) - num(a.valor_pendente))
    return arr
  }, [resumo, busca, soDevendo, ordem])

  const totais = useMemo(() => resumo.reduce((t, e) => ({
    pagar: t.pagar + num(e.valor_pendente),
    corridas: t.corridas + num(e.corridas),
    pendentes: t.pendentes + num(e.corridas_pendentes),
    dinheiro: t.dinheiro + num(e.repasse_dinheiro),
    cartao: t.cartao + num(e.repasse_cartao),
    pix: t.pix + num(e.repasse_pix),
    emRota: t.emRota + num(e.em_andamento),
    emRotaValor: t.emRotaValor + num(e.valor_em_andamento),
  }), { pagar: 0, corridas: 0, pendentes: 0, dinheiro: 0, cartao: 0, pix: 0, emRota: 0, emRotaValor: 0 }), [resumo])

  const repasseTotal = totais.dinheiro + totais.cartao + totais.pix

  const patchDe = pago => (pago
    ? { entregador_pago: true, entregador_pago_em: new Date().toISOString() }
    : { entregador_pago: false, entregador_pago_em: null })

  // Marca/desmarca corridas como acertadas.
  async function marcarPago(ids, pago) {
    if (!ids?.length || salvando) return false
    setSalvando(true)
    const { error } = await supabase.from('pedidos_delivery').update(patchDe(pago)).in('id', ids)
    setSalvando(false)
    if (error) { avisar('Não deu pra salvar: ' + error.message, true); return false }
    return true
  }

  // Antes de acertar, lista as corridas que o motoqueiro pegou mas ainda não
  // concluiu, pra loja conferir se aquele pedido foi pago ou não.
  async function alertaEmRota(entregadorId, qtd) {
    const faixa = faixaDe(periodo, de, ate)
    let q = supabase.from('pedidos_delivery')
      .select('id, numero_pedido, cliente_nome, total, taxa_entrega, status, forma_pagamento, created_at')
      .eq('empresa_id', empresa.id).eq('entregador_id', entregadorId)
      .neq('status', 'entregue').neq('status', 'cancelado')
      .or('entregador_pago.is.null,entregador_pago.eq.false')
    if (faixa.desde) q = q.gte('created_at', faixa.desde)
    if (faixa.ate) q = q.lte('created_at', faixa.ate)
    const { data } = await q.order('created_at')
    const itens = (data || []).map(p => ({
      chave: p.id,
      titulo: `#${p.numero_pedido ?? p.id.slice(-4).toUpperCase()} · ${p.cliente_nome || '—'}`,
      detalhe: `${STATUS_LABEL[p.status] || p.status} · ${fmt(p.total)}`,
      valor: fmt(p.taxa_entrega),
    }))
    return {
      titulo: `${qtd} corrida${qtd === 1 ? '' : 's'} ainda não concluída${qtd === 1 ? '' : 's'}`,
      texto: 'Confira com o entregador se o cliente já pagou. Elas não entram no acerto a menos que você marque abaixo.',
      itens,
      opcao: `Incluir essas ${qtd} corridas no pagamento`,
    }
  }

  // Acerto em lote: atualiza pelo filtro em vez de mandar centenas de ids na URL.
  async function acertarTudo(entregadorId, incluirEmAndamento = false) {
    if (salvando) return false
    setSalvando(true)
    const faixa = faixaDe(periodo, de, ate)
    let q = supabase.from('pedidos_delivery').update(patchDe(true))
      .eq('empresa_id', empresa.id).eq('entregador_id', entregadorId)
      .or('entregador_pago.is.null,entregador_pago.eq.false')
    // Por padrão só corrida concluída é acertada; a loja pode incluir as em rota.
    q = incluirEmAndamento ? q.neq('status', 'cancelado') : q.eq('status', 'entregue')
    if (faixa.desde) q = q.gte('created_at', faixa.desde)
    if (faixa.ate) q = q.lte('created_at', faixa.ate)
    const { error } = await q
    setSalvando(false)
    if (error) { avisar('Não deu pra salvar: ' + error.message, true); return false }
    return true
  }

  // Modal e aviso ficam fora do fluxo da página, então valem pras duas telas.
  const avulsos = (
    <>
      <Confirmacao pedido={confirmacao} ocupado={salvando} onFechar={() => setConfirmacao(null)} />
      {aviso && <div className={`ent-toast ${aviso.erro ? 'erro' : ''}`}>{aviso.texto}</div>}
    </>
  )

  if (loading && !resumo.length) {
    return (
      <div className="ent-wrap">
        <div className="page-header"><h1>Entregadores</h1></div>
        <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '70%' }} /></div>
      </div>
    )
  }

  if (sel) {
    return (
      <>
        <DetalheEntregador
          empresa={empresa}
          id={sel}
          entregador={resumo.find(e => e.entregador_id === sel)}
          periodo={periodo}
          setPeriodo={setPeriodo}
          de={de}
          setDe={setDe}
          ate={ate}
          setAte={setAte}
          salvando={salvando}
          onVoltar={() => setSel(null)}
          marcarPago={marcarPago}
          acertarTudo={acertarTudo}
          recarregarResumo={carregarResumo}
          pedirConfirmacao={setConfirmacao}
          avisar={avisar}
        />
        {avulsos}
      </>
    )
  }

  const labelPeriodo = rotuloPeriodo(periodo, de, ate)

  return (
    <div className="ent-wrap">
      <div className="page-header">
        <h1>Entregadores</h1>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { carregarResumo(); if (aba === 'historico') carregarAcertos() }} disabled={loading}>
          {loading ? 'Atualizando…' : '↻ Atualizar'}
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: -12, marginBottom: 16, maxWidth: 680 }}>
        {aba === 'acerto'
          ? 'Acerto de contas: o que a loja deve de corrida e o que o entregador tem em mãos pra repassar.'
          : 'Todo pagamento feito nesta tela, com data e hora. O período filtra pela data do pagamento.'}
      </p>

      <div className="ent-abas">
        <button type="button" className={aba === 'acerto' ? 'on' : ''} onClick={() => setAba('acerto')}>Acerto</button>
        <button type="button" className={aba === 'historico' ? 'on' : ''} onClick={() => setAba('historico')}>Histórico de pagamentos</button>
      </div>

      <div className="ent-toolbar">
        <FiltroPeriodo periodo={periodo} setPeriodo={setPeriodo} de={de} setDe={setDe} ate={ate} setAte={setAte} />
        {aba === 'acerto' && <>
          <input className="ent-search" placeholder="Buscar entregador…" value={busca} onChange={e => setBusca(e.target.value)} />
          <label className={`ent-toggle ${soDevendo ? 'on' : ''}`}>
            <input type="checkbox" checked={soDevendo} onChange={e => setSoDevendo(e.target.checked)} />
            Só quem tem pendência
          </label>
          <div className="ent-seg">
            {ORDENS.map(([val, lab]) => (
              <button key={val} type="button" className={ordem === val ? 'on' : ''} onClick={() => setOrdem(val)}>{lab}</button>
            ))}
          </div>
        </>}
      </div>

      {aba === 'historico' && (
        <HistoricoPagamentos
          acertos={acertos}
          carregando={carregandoAcertos}
          labelPeriodo={labelPeriodo}
          salvando={salvando}
          onVerEntregador={setSel}
          onDesfazer={a => setConfirmacao({
            titulo: 'Desfazer esse pagamento?',
            texto: `As ${num(a.corridas)} corridas voltam pra lista de "a pagar" de ${a.nome}.`,
            botao: 'Desfazer pagamento',
            perigo: true,
            resumo: [['Pago em', dataHora(a.pago_em)], ['Corridas', `${num(a.corridas)}`], ['Valor', fmt(a.valor)]],
            acao: async () => { if (await desfazerAcerto(a)) { carregarAcertos(); carregarResumo(); avisar('Pagamento desfeito.') } },
          })}
        />
      )}

      {aba === 'acerto' && <>
      <div className="ent-stats">
        <div className="ent-stat ent-stat--warn">
          <div className="lab">A pagar aos entregadores</div>
          <div className="val c-warn">{fmt(totais.pagar)}</div>
          <div className="sub">{totais.pendentes} corrida{totais.pendentes === 1 ? '' : 's'} sem acerto</div>
        </div>
        <div className="ent-stat ent-stat--ok">
          <div className="lab">A repassar pra loja</div>
          <div className="val c-ok">{fmt(repasseTotal)}</div>
          <div className="sub">
            {fmt(totais.dinheiro)} dinheiro · {fmt(totais.cartao)} cartão{totais.pix > 0 ? ` · ${fmt(totais.pix)} PIX` : ''}
          </div>
        </div>
        <div className="ent-stat ent-stat--info">
          <div className="lab">Saldo do acerto</div>
          <div className="val c-info">{fmt(repasseTotal - totais.pagar)}</div>
          <div className="sub">{repasseTotal >= totais.pagar ? 'sobra pra loja depois de pagar as corridas' : 'a loja ainda desembolsa essa diferença'}</div>
        </div>
        <div className="ent-stat">
          <div className="lab">Corridas · {labelPeriodo}</div>
          <div className="val">{totais.corridas}</div>
          <div className="sub">
            {totais.emRota > 0
              ? <span className="c-info">🛵 {totais.emRota} em rota agora ({fmt(totais.emRotaValor)})</span>
              : `${lista.length} entregador${lista.length === 1 ? '' : 'es'} na lista`}
          </div>
        </div>
      </div>

      {lista.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 22 }}>🛵</div>
          <strong>{resumo.length ? 'Nada com esse filtro' : 'Nenhum entregador'}</strong>
          <p>{resumo.length ? 'Tente outro período ou limpe a busca.' : 'Cadastre em Funcionários (perfil Entregador).'}</p>
        </div>
      ) : (
        <div className="ent-grid">
          {lista.map(e => {
            const pendente = num(e.valor_pendente)
            const repasse = num(e.repasse_dinheiro) + num(e.repasse_cartao) + num(e.repasse_pix)
            const emRota = num(e.em_andamento)
            return (
              <div key={e.entregador_id} className={`ent-card ${pendente === 0 && emRota === 0 ? 'ent-card--quitado' : ''}`}>
                <div className="ent-card-top">
                  <div className="ent-avatar">{iniciais(e.nome)}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="ent-nome">{e.nome || 'Entregador'}</div>
                    <div className="ent-sub">
                      {e.ativo ? '' : 'Inativo · '}
                      {num(e.corridas)} corrida{num(e.corridas) === 1 ? '' : 's'}
                      {e.ultima_corrida ? ` · última ${new Date(e.ultima_corrida).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}` : ''}
                    </div>
                  </div>
                </div>

                <div className={`ent-money ${pendente === 0 ? 'zero' : ''}`}>
                  <div>
                    <span className="cap">A pagar</span>
                    <span className={`big ${pendente === 0 ? 'c-ok' : 'c-warn'}`}>{pendente === 0 ? 'Tudo certo' : fmt(pendente)}</span>
                  </div>
                  <div className="qtd">{num(e.corridas_pendentes)} corrida{num(e.corridas_pendentes) === 1 ? '' : 's'}<br />sem acerto</div>
                </div>

                {emRota > 0 && (
                  <div className="ent-rota">
                    🛵 <strong>{emRota} corrida{emRota === 1 ? '' : 's'} em rota agora</strong>
                    <span>{fmt(e.valor_em_andamento)} · entra no acerto quando concluir</span>
                  </div>
                )}

                <div className="ent-box">
                  <div className="ent-box-head">
                    <span className="cap">Recebeu e deve repassar</span>
                    <span className={`tot ${repasse > 0 ? 'c-ok' : 'c-muted'}`}>{fmt(repasse)}</span>
                  </div>
                  <div className="ent-formas">
                    {FORMAS.map(([k, lab]) => (
                      <div key={k} className="ent-forma">
                        <span>{lab}</span>
                        <strong>{fmt(e[`repasse_${k}`])}</strong>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="ent-acoes">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSel(e.entregador_id)}>Ver corridas</button>
                  <button
                    type="button"
                    className="btn btn-ok btn-sm"
                    disabled={pendente === 0 || salvando}
                    onClick={async () => setConfirmacao({
                      titulo: `Acertar com ${e.nome}?`,
                      texto: 'As corridas ficam marcadas como pagas. Dá pra desfazer uma a uma em "Ver corridas".',
                      botao: 'Confirmar pagamento',
                      resumo: [
                        ['Corridas a pagar', `${num(e.corridas_pendentes)}`],
                        ['Valor pra ele', fmt(pendente)],
                        ['Ele repassa pra loja', fmt(repasse)],
                      ],
                      alerta: emRota > 0 ? await alertaEmRota(e.entregador_id, emRota) : null,
                      acao: async incluir => {
                        if (await acertarTudo(e.entregador_id, incluir)) {
                          carregarResumo()
                          avisar(`Acerto de ${e.nome} registrado · ${fmt(pendente)}`)
                        }
                      },
                    })}
                  >
                    Acertar tudo
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      </>}
      {avulsos}
    </div>
  )
}

// ───────────────────────── Histórico de pagamentos ─────────────────────────

function HistoricoPagamentos({ acertos, carregando, labelPeriodo, salvando, onVerEntregador, onDesfazer }) {
  const total = acertos.reduce((s, a) => s + num(a.valor), 0)
  const corridas = acertos.reduce((s, a) => s + num(a.corridas), 0)

  if (carregando && !acertos.length) {
    return <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '60%' }} /></div>
  }

  return (
    <>
      <div className="ent-stats">
        <div className="ent-stat ent-stat--ok">
          <div className="lab">Pago aos entregadores · {labelPeriodo}</div>
          <div className="val c-ok">{fmt(total)}</div>
          <div className="sub">{corridas} corrida{corridas === 1 ? '' : 's'} em {acertos.length} pagamento{acertos.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {acertos.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 22 }}>🧾</div>
          <strong>Nenhum pagamento no período</strong>
          <p>Escolha outro período ou "Tudo" pra ver os acertos anteriores.</p>
        </div>
      ) : (
        <div className="data-table">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th>Pago em</th>
                <th>Entregador</th>
                <th>Corridas</th>
                <th style={{ textAlign: 'right' }}>Valor</th>
                <th>Período das corridas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {acertos.map(a => (
                <tr key={`${a.entregador_id}-${a.pago_em}`}>
                  <td style={{ whiteSpace: 'nowrap', fontWeight: 700 }}>{dataHora(a.pago_em)}</td>
                  <td>
                    <button type="button" className="ent-link" onClick={() => onVerEntregador(a.entregador_id)}>{a.nome}</button>
                  </td>
                  <td>{num(a.corridas)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800 }} className="c-ok">{fmt(a.valor)}</td>
                  <td className="c-muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                    {new Date(a.primeira).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} a {new Date(a.ultima).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={salvando} onClick={() => onDesfazer(a)}>Desfazer</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ─────────────────────────── Detalhe de um entregador ───────────────────────────

// `id` vem separado de `entregador` de propósito: se o filtro de período tirar
// esse entregador do resumo, a tela de detalhe continua funcionando.
function DetalheEntregador({ empresa, id, entregador, periodo, setPeriodo, de, setDe, ate, setAte, salvando, onVoltar, marcarPago, acertarTudo, recarregarResumo, pedirConfirmacao, avisar }) {
  const [pedidos, setPedidos] = useState([])
  const [perfil, setPerfil] = useState(null)
  const [carregando, setCarregando] = useState(true)

  const carregar = useCallback(async () => {
    if (!empresa || !id) return
    setCarregando(true)
    const faixa = faixaDe(periodo, de, ate)
    const [{ data: pd }, { data: pf }] = await Promise.all([
      fetchAll(() => {
        let q = supabase.from('pedidos_delivery')
          .select('id, numero_pedido, cliente_nome, total, taxa_entrega, forma_pagamento, pix_status, mp_payment_status, created_at, origem, status, entregador_pago, entregador_pago_em')
          .eq('empresa_id', empresa.id).eq('entregador_id', id).neq('status', 'cancelado')
        if (faixa.desde) q = q.gte('created_at', faixa.desde)
        if (faixa.ate) q = q.lte('created_at', faixa.ate)
        return q.order('created_at', { ascending: false })
      }),
      supabase.from('profiles').select('nome, entregador_desconto_ativo, entregador_desconto_valor').eq('id', id).maybeSingle(),
    ])
    setPedidos(pd || [])
    setPerfil(pf || null)
    setCarregando(false)
  }, [empresa, id, periodo, de, ate])

  useEffect(() => { carregar() }, [carregar])

  const descValor = (perfil?.entregador_desconto_ativo && num(perfil?.entregador_desconto_valor) > 0) ? num(perfil.entregador_desconto_valor) : 0
  const ganho = p => Math.max(0, num(p.taxa_entrega) - (p.origem === 'ifood' ? descValor : 0))
  const somaGanho = arr => arr.reduce((s, p) => s + ganho(p), 0)

  const concluidas = pedidos.filter(p => p.status === 'entregue')
  const emRota = pedidos.filter(p => p.status !== 'entregue' && !p.entregador_pago)
  const pendentes = concluidas.filter(p => !p.entregador_pago)
  const pagos = pedidos.filter(p => p.entregador_pago)

  // Quanto ele tem em mãos, por forma de pagamento (só das corridas não acertadas).
  const emMaos = pendentes.reduce((acc, p) => {
    const t = cobranca(p).tipo
    if (t !== 'conta') acc[t] = (acc[t] || 0) + num(p.total)
    return acc
  }, {})
  const totalEmMaos = FORMAS.reduce((s, [k]) => s + num(emMaos[k]), 0)
  const aPagar = somaGanho(pendentes)
  const saldo = totalEmMaos - aPagar

  const dataDe = p => new Date(p.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
  const porData = arr => { const g = {}; for (const p of arr) (g[dataDe(p)] ??= []).push(p); return Object.entries(g) }

  async function pagar(ids, pago, ok) {
    if (await marcarPago(ids, pago)) { await carregar(); recarregarResumo(); if (ok) avisar(ok) }
  }

  function copiarRecibo() {
    const nome = perfil?.nome || entregador?.nome || 'Entregador'
    const linhas = [
      `*Acerto — ${nome}*`,
      `Período: ${rotuloPeriodo(periodo, de, ate)}`,
      '',
      `Corridas a pagar: ${pendentes.length} = ${fmt(aPagar)}`,
      ...FORMAS.filter(([k]) => num(emMaos[k]) > 0).map(([k, lab]) => `${lab.replace(/^\S+\s/, '')} recebido: ${fmt(emMaos[k])}`),
      `Total recebido dos clientes: ${fmt(totalEmMaos)}`,
      '',
      saldo >= 0 ? `➡️ Entregador repassa à loja: ${fmt(saldo)}` : `➡️ Loja paga ao entregador: ${fmt(-saldo)}`,
    ]
    navigator.clipboard?.writeText(linhas.join('\n'))
      .then(() => avisar('Recibo copiado! É só colar no WhatsApp.'))
      .catch(() => avisar('Não consegui copiar automaticamente.', true))
  }

  const Corrida = (p, pago) => {
    const cb = cobranca(p)
    const naConta = cb.tipo === 'conta'
    const aberta = p.status !== 'entregue'
    return (
      <div key={p.id} className={`ent-corrida ${aberta ? 'ent-corrida--aberta' : ''}`}>
        <div className="ent-corrida-top">
          <span className="ent-corrida-num">
            #{p.numero_pedido ?? p.id.slice(-4).toUpperCase()}
            {aberta && <span className="ent-chip ent-chip--rota" style={{ marginLeft: 6 }}>{STATUS_LABEL[p.status] || p.status}</span>}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13 }} className={pago ? 'c-ok' : 'c-warn'}>{fmt(ganho(p))}</strong>
            {pago
              ? <button type="button" className="ent-chip ent-chip--ok" style={{ border: 'none', cursor: 'pointer' }}
                  title="Desfazer pagamento" disabled={salvando}
                  onClick={() => pedirConfirmacao({
                    titulo: 'Desfazer esse pagamento?',
                    texto: 'A corrida volta pra lista de "a pagar".',
                    botao: 'Desfazer',
                    perigo: true,
                    resumo: [['Corrida', `#${p.numero_pedido ?? p.id.slice(-4).toUpperCase()}`], ['Valor', fmt(ganho(p))]],
                    acao: () => pagar([p.id], false, 'Pagamento desfeito.'),
                  })}>✓ Pago ✕</button>
              : <button type="button" className="btn btn-ok btn-sm" style={{ fontSize: 11, padding: '4px 9px' }} disabled={salvando}
                  onClick={() => pagar([p.id], true, `Corrida paga · ${fmt(ganho(p))}`)}>Pagar</button>}
          </div>
        </div>
        <div className="ent-corrida-meta">
          {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
          {p.origem === 'ifood' && descValor > 0 ? ` · iFood −${fmt(descValor)}` : ''}
        </div>
        {pago && p.entregador_pago_em && (
          <div className="ent-corrida-meta c-ok">🧾 Pago em {dataHora(p.entregador_pago_em)}</div>
        )}
        <div className="ent-corrida-pag">
          <span className={aberta ? 'c-info' : naConta ? 'c-ok' : 'c-warn'}>
            {aberta ? '🛵 Ainda não entregue' : naConta ? '✓ Já na conta' : '💵 Recebeu na entrega'} · {cb.label}
          </span>
          <span>{fmt(p.total)}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="ent-wrap">
      <button type="button" className="btn btn-secondary btn-sm" style={{ marginBottom: 12 }} onClick={onVoltar}>← Todos os entregadores</button>

      <div className="ent-det-head">
        <div className="ent-avatar">{iniciais(perfil?.nome || entregador?.nome)}</div>
        <h1>{perfil?.nome || entregador?.nome || 'Entregador'}</h1>
        <div style={{ marginLeft: 'auto' }}>
          <FiltroPeriodo periodo={periodo} setPeriodo={setPeriodo} de={de} setDe={setDe} ate={ate} setAte={setAte} />
        </div>
      </div>

      {carregando ? (
        <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '60%' }} /></div>
      ) : (
        <>
          <div className="ent-stats">
            <div className="ent-stat ent-stat--warn">
              <div className="lab">A receber (corridas)</div>
              <div className="val c-warn">{fmt(aPagar)}</div>
              <div className="sub">{pendentes.length} sem acerto</div>
            </div>
            <div className="ent-stat ent-stat--ok">
              <div className="lab">Já pago</div>
              <div className="val c-ok">{fmt(somaGanho(pagos))}</div>
              <div className="sub">{pagos.length} corrida{pagos.length === 1 ? '' : 's'}</div>
            </div>
            <div className="ent-stat ent-stat--info">
              <div className="lab">Recebeu dos clientes</div>
              <div className="val c-info">{fmt(totalEmMaos)}</div>
              <div className="sub">
                {FORMAS.filter(([k]) => num(emMaos[k]) > 0).map(([k, lab]) => `${fmt(emMaos[k])} ${lab.replace(/^\S+\s/, '').toLowerCase()}`).join(' · ') || 'nada em mãos'}
              </div>
            </div>
            <div className="ent-stat">
              <div className="lab">Corridas</div>
              <div className="val">{pedidos.length}</div>
              <div className="sub">{emRota.length > 0 ? <span className="c-info">🛵 {emRota.length} em rota agora</span> : 'no período'}</div>
            </div>
          </div>

          <div className="ent-saldo">
            {FORMAS.map(([k, lab]) => (
              <div key={k} className="ent-saldo-linha">
                <span>{lab} recebido dos clientes</span>
                <strong>{fmt(emMaos[k])}</strong>
              </div>
            ))}
            <div className="ent-saldo-linha">
              <span>− Corridas a pagar ({pendentes.length})</span>
              <strong className="c-warn">− {fmt(aPagar)}</strong>
            </div>
            <div className="ent-saldo-total">
              <span>{saldo >= 0 ? 'Entregador repassa à loja' : 'Loja paga ao entregador'}</span>
              <span className={`v ${saldo >= 0 ? 'c-ok' : 'c-warn'}`}>{fmt(Math.abs(saldo))}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={copiarRecibo}>📋 Copiar recibo</button>
              <button type="button" className="btn btn-ok btn-sm" disabled={!pendentes.length || salvando}
                onClick={() => pedirConfirmacao({
                  titulo: `Acertar com ${perfil?.nome || entregador?.nome || 'o entregador'}?`,
                  texto: 'As corridas do período ficam marcadas como pagas. Dá pra desfazer uma a uma.',
                  botao: 'Confirmar pagamento',
                  resumo: [
                    ['Corridas a pagar', `${pendentes.length}`],
                    ['Valor pra ele', fmt(aPagar)],
                    [saldo >= 0 ? 'Ele repassa pra loja' : 'Loja completa em dinheiro', fmt(Math.abs(saldo))],
                  ],
                  alerta: emRota.length === 0 ? null : {
                    titulo: `${emRota.length} corrida${emRota.length === 1 ? '' : 's'} ainda não concluída${emRota.length === 1 ? '' : 's'}`,
                    texto: 'Confira com o entregador se o cliente já pagou. Elas não entram no acerto a menos que você marque abaixo.',
                    itens: emRota.map(p => ({
                      chave: p.id,
                      titulo: `#${p.numero_pedido ?? p.id.slice(-4).toUpperCase()} · ${p.cliente_nome || '—'}`,
                      detalhe: `${STATUS_LABEL[p.status] || p.status} · ${fmt(p.total)}`,
                      valor: fmt(ganho(p)),
                    })),
                    opcao: `Incluir essas ${emRota.length} corridas no pagamento`,
                  },
                  acao: async incluir => {
                    if (await acertarTudo(id, incluir)) { await carregar(); recarregarResumo(); avisar(`Acerto registrado · ${fmt(aPagar)}`) }
                  },
                })}>
                Acertar tudo · {fmt(aPagar)}
              </button>
            </div>
          </div>

          {emRota.length > 0 && (
            <>
              <div className="ent-sec c-info">
                🛵 Em rota agora · {emRota.length} corrida{emRota.length === 1 ? '' : 's'} · {fmt(somaGanho(emRota))}
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
                  entram no acerto quando o entregador concluir
                </span>
              </div>
              <div className="ent-corridas">{emRota.map(p => Corrida(p, false))}</div>
            </>
          )}

          <div className="ent-sec c-warn">A pagar · {fmt(aPagar)}</div>
          {pendentes.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Tudo acertado. 🎉</div>
            : porData(pendentes).map(([data, ps]) => (
              <div key={data}>
                <div className="ent-dia">
                  <span>{data} · {ps.length} corrida{ps.length === 1 ? '' : 's'} · {fmt(somaGanho(ps))}</span>
                  <button type="button" className="btn btn-ok btn-sm" style={{ fontSize: 11, padding: '4px 9px' }} disabled={salvando}
                    onClick={() => pedirConfirmacao({
                      titulo: `Pagar as corridas de ${data}?`,
                      texto: 'Só as corridas desse dia são marcadas como pagas.',
                      botao: 'Confirmar pagamento',
                      resumo: [['Corridas', `${ps.length}`], ['Valor', fmt(somaGanho(ps))]],
                      acao: () => pagar(ps.map(p => p.id), true, `${ps.length} corridas pagas · ${fmt(somaGanho(ps))}`),
                    })}>
                    Pagar o dia
                  </button>
                </div>
                <div className="ent-corridas">{ps.map(p => Corrida(p, false))}</div>
              </div>
            ))}

          <div className="ent-sec c-ok">Pagas · {fmt(somaGanho(pagos))}</div>
          {pagos.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhuma corrida paga no período.</div>
            : porData(pagos).map(([data, ps]) => (
              <div key={data}>
                <div className="ent-dia"><span>{data} · {ps.length} corrida{ps.length === 1 ? '' : 's'} · {fmt(somaGanho(ps))}</span></div>
                <div className="ent-corridas">{ps.map(p => Corrida(p, true))}</div>
              </div>
            ))}
        </>
      )}
    </div>
  )
}
