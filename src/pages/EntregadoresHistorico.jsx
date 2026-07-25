import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Entregadores.css'

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const num = v => Number(v || 0)

const PERIODOS = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['tudo', 'Tudo']]
const ORDENS = [['devendo', 'Quem devo mais'], ['corridas', 'Mais corridas'], ['nome', 'Nome']]

// Início do período no formato ISO (null = tudo). O corte é o mesmo no resumo do
// banco e na lista de corridas, senão os dois números não fecham.
function desdeDe(periodo) {
  if (periodo === 'hoje') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString() }
  if (periodo === '7d') return new Date(Date.now() - 7 * 86400000).toISOString()
  if (periodo === '30d') return new Date(Date.now() - 30 * 86400000).toISOString()
  return null
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

const FORMAS = [['dinheiro', '💵 Dinheiro'], ['cartao', '💳 Cartão'], ['pix', '📱 PIX']]

export default function EntregadoresHistorico() {
  const { empresa } = useAuth()
  const [resumo, setResumo] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(null)
  const [periodo, setPeriodo] = useState('tudo')
  const [busca, setBusca] = useState('')
  const [soDevendo, setSoDevendo] = useState(false)
  const [ordem, setOrdem] = useState('devendo')
  const [salvando, setSalvando] = useState(false)

  const carregarResumo = useCallback(async () => {
    if (!empresa) return
    setLoading(true)
    const { data } = await supabase.rpc('entregadores_resumo', { p_empresa_id: empresa.id, p_desde: desdeDe(periodo) })
    setResumo(data || [])
    setLoading(false)
  }, [empresa, periodo])

  useEffect(() => { carregarResumo() }, [carregarResumo])

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
  }), { pagar: 0, corridas: 0, pendentes: 0, dinheiro: 0, cartao: 0, pix: 0 }), [resumo])

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
    if (error) { alert('Não deu pra salvar: ' + error.message); return false }
    return true
  }

  // Acerto em lote: atualiza pelo filtro em vez de mandar centenas de ids na URL.
  async function acertarTudo(entregadorId) {
    if (salvando) return false
    setSalvando(true)
    const desde = desdeDe(periodo)
    let q = supabase.from('pedidos_delivery').update(patchDe(true))
      .eq('empresa_id', empresa.id).eq('entregador_id', entregadorId).eq('status', 'entregue')
      .or('entregador_pago.is.null,entregador_pago.eq.false')
    if (desde) q = q.gte('created_at', desde)
    const { error } = await q
    setSalvando(false)
    if (error) { alert('Não deu pra salvar: ' + error.message); return false }
    return true
  }

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
      <DetalheEntregador
        empresa={empresa}
        id={sel}
        entregador={resumo.find(e => e.entregador_id === sel)}
        periodo={periodo}
        setPeriodo={setPeriodo}
        salvando={salvando}
        onVoltar={() => setSel(null)}
        marcarPago={marcarPago}
        acertarTudo={acertarTudo}
        recarregarResumo={carregarResumo}
      />
    )
  }

  const labelPeriodo = (PERIODOS.find(p => p[0] === periodo) || [])[1]

  return (
    <div className="ent-wrap">
      <div className="page-header">
        <h1>Entregadores</h1>
        <button type="button" className="btn btn-secondary btn-sm" onClick={carregarResumo} disabled={loading}>
          {loading ? 'Atualizando…' : '↻ Atualizar'}
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: -12, marginBottom: 16, maxWidth: 680 }}>
        Acerto de contas: o que a loja deve de corrida e o que o entregador tem em mãos pra repassar.
      </p>

      <div className="ent-toolbar">
        <div className="ent-seg">
          {PERIODOS.map(([val, lab]) => (
            <button key={val} type="button" className={periodo === val ? 'on' : ''} onClick={() => setPeriodo(val)}>{lab}</button>
          ))}
        </div>
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
      </div>

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
          <div className="sub">{lista.length} entregador{lista.length === 1 ? '' : 'es'} na lista</div>
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
            return (
              <div key={e.entregador_id} className={`ent-card ${pendente === 0 ? 'ent-card--quitado' : ''}`}>
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
                    onClick={async () => {
                      if (!confirm(`Marcar as ${num(e.corridas_pendentes)} corridas de ${e.nome} como pagas (${fmt(pendente)})?`)) return
                      if (await acertarTudo(e.entregador_id)) carregarResumo()
                    }}
                  >
                    Acertar tudo
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── Detalhe de um entregador ───────────────────────────

// `id` vem separado de `entregador` de propósito: se o filtro de período tirar
// esse entregador do resumo, a tela de detalhe continua funcionando.
function DetalheEntregador({ empresa, id, entregador, periodo, setPeriodo, salvando, onVoltar, marcarPago, acertarTudo, recarregarResumo }) {
  const [pedidos, setPedidos] = useState([])
  const [perfil, setPerfil] = useState(null)
  const [carregando, setCarregando] = useState(true)

  const carregar = useCallback(async () => {
    if (!empresa || !id) return
    setCarregando(true)
    const desde = desdeDe(periodo)
    const [{ data: pd }, { data: pf }] = await Promise.all([
      fetchAll(() => {
        let q = supabase.from('pedidos_delivery')
          .select('id, numero_pedido, cliente_nome, total, taxa_entrega, forma_pagamento, pix_status, mp_payment_status, created_at, origem, entregador_pago, entregador_pago_em')
          .eq('empresa_id', empresa.id).eq('entregador_id', id).eq('status', 'entregue')
        if (desde) q = q.gte('created_at', desde)
        return q.order('created_at', { ascending: false })
      }),
      supabase.from('profiles').select('nome, entregador_desconto_ativo, entregador_desconto_valor').eq('id', id).maybeSingle(),
    ])
    setPedidos(pd || [])
    setPerfil(pf || null)
    setCarregando(false)
  }, [empresa, id, periodo])

  useEffect(() => { carregar() }, [carregar])

  const descValor = (perfil?.entregador_desconto_ativo && num(perfil?.entregador_desconto_valor) > 0) ? num(perfil.entregador_desconto_valor) : 0
  const ganho = p => Math.max(0, num(p.taxa_entrega) - (p.origem === 'ifood' ? descValor : 0))
  const somaGanho = arr => arr.reduce((s, p) => s + ganho(p), 0)

  const pendentes = pedidos.filter(p => !p.entregador_pago)
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

  async function pagar(ids, pago, pergunta) {
    if (pergunta && !confirm(pergunta)) return
    if (await marcarPago(ids, pago)) { await carregar(); recarregarResumo() }
  }

  function copiarRecibo() {
    const nome = perfil?.nome || entregador?.nome || 'Entregador'
    const linhas = [
      `*Acerto — ${nome}*`,
      `Período: ${(PERIODOS.find(p => p[0] === periodo) || [])[1]}`,
      '',
      `Corridas a pagar: ${pendentes.length} = ${fmt(aPagar)}`,
      ...FORMAS.filter(([k]) => num(emMaos[k]) > 0).map(([k, lab]) => `${lab.replace(/^\S+\s/, '')} recebido: ${fmt(emMaos[k])}`),
      `Total recebido dos clientes: ${fmt(totalEmMaos)}`,
      '',
      saldo >= 0 ? `➡️ Entregador repassa à loja: ${fmt(saldo)}` : `➡️ Loja paga ao entregador: ${fmt(-saldo)}`,
    ]
    navigator.clipboard?.writeText(linhas.join('\n'))
      .then(() => alert('Recibo copiado! É só colar no WhatsApp.'))
      .catch(() => alert('Não consegui copiar automaticamente.'))
  }

  const Corrida = (p, pago) => {
    const cb = cobranca(p)
    const naConta = cb.tipo === 'conta'
    return (
      <div key={p.id} className="ent-corrida">
        <div className="ent-corrida-top">
          <span className="ent-corrida-num">#{p.numero_pedido ?? p.id.slice(-4).toUpperCase()}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13 }} className={pago ? 'c-ok' : 'c-warn'}>{fmt(ganho(p))}</strong>
            {pago
              ? <button type="button" className="ent-chip ent-chip--ok" style={{ border: 'none', cursor: 'pointer' }}
                  title="Desfazer pagamento" disabled={salvando}
                  onClick={() => pagar([p.id], false, 'Desfazer o pagamento dessa corrida?')}>✓ Pago ✕</button>
              : <button type="button" className="btn btn-ok btn-sm" style={{ fontSize: 11, padding: '4px 9px' }} disabled={salvando}
                  onClick={() => pagar([p.id], true)}>Pagar</button>}
          </div>
        </div>
        <div className="ent-corrida-meta">
          {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
          {p.origem === 'ifood' && descValor > 0 ? ` · iFood −${fmt(descValor)}` : ''}
        </div>
        <div className="ent-corrida-pag">
          <span className={naConta ? 'c-ok' : 'c-warn'}>{naConta ? '✓ Já na conta' : '💵 Recebeu na entrega'} · {cb.label}</span>
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
        <div className="ent-seg" style={{ marginLeft: 'auto' }}>
          {PERIODOS.map(([val, lab]) => (
            <button key={val} type="button" className={periodo === val ? 'on' : ''} onClick={() => setPeriodo(val)}>{lab}</button>
          ))}
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
              <div className="sub">no período</div>
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
                onClick={async () => {
                  if (!confirm(`Marcar as ${pendentes.length} corridas como pagas (${fmt(aPagar)})?`)) return
                  if (await acertarTudo(id)) { await carregar(); recarregarResumo() }
                }}>
                Acertar tudo · {fmt(aPagar)}
              </button>
            </div>
          </div>

          <div className="ent-sec c-warn">A pagar · {fmt(aPagar)}</div>
          {pendentes.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Tudo acertado. 🎉</div>
            : porData(pendentes).map(([data, ps]) => (
              <div key={data}>
                <div className="ent-dia">
                  <span>{data} · {ps.length} corrida{ps.length === 1 ? '' : 's'} · {fmt(somaGanho(ps))}</span>
                  <button type="button" className="btn btn-ok btn-sm" style={{ fontSize: 11, padding: '4px 9px' }} disabled={salvando}
                    onClick={() => pagar(ps.map(p => p.id), true, `Pagar as ${ps.length} corridas de ${data} (${fmt(somaGanho(ps))})?`)}>
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
