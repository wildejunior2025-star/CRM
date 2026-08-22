import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

// Indicação e cashback da loja (mig 0174).
//
// Programa POR LOJA: o cliente indica um amigo, e na PRIMEIRA compra do amigo
// os dois ganham crédito pra gastar ali dentro. Uma vez só — aquele par nunca
// mais rende. Ninguém ganha desconto na hora, de propósito: assim a loja não
// perde margem na venda, ela compra uma segunda visita. E crédito que nunca é
// gasto nunca vira despesa.
//
// A chave mestra nasce DESLIGADA em toda loja. Enquanto ela estiver desligada,
// nada do programa existe — nem crédito nascendo, nem linha no caixa, nem
// despesa no fechamento. É o que deixa testar numa loja só sem risco pras
// outras.

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

// Os ajustes numéricos, num só lugar pra tela e o salvar não saírem de sincronia.
const AJUSTES = [
  {
    campo: 'pct_indicacao', label: 'Quem indica ganha (%)', sufixo: '%', step: '0.5', max: 100,
    ajuda: 'Sobre a primeira compra de cada pessoa que ele trouxer.',
  },
  {
    campo: 'pct_cashback', label: 'Quem foi indicado ganha (%)', sufixo: '%', step: '0.5', max: 100,
    ajuda: 'Sobre a própria primeira compra. Zero desliga só esta ponta.',
  },
  {
    campo: 'teto_por_pessoa', label: 'Teto por pessoa (R$)', sufixo: 'R$', step: '1', max: null,
    ajuda: 'Trava quanto uma única compra pode render. Zero = sem teto.',
  },
  {
    campo: 'validade_dias', label: 'Validade do crédito (dias)', sufixo: 'dias', step: '1', max: null,
    ajuda: 'Crédito sem prazo vira dívida eterna da loja. Zero = não expira.',
  },
  {
    campo: 'compra_minima', label: 'Compra mínima (R$)', sufixo: 'R$', step: '1', max: null,
    ajuda: 'Compra abaixo disso não gera crédito nenhum.',
  },
]

const PADRAO = {
  ativo: false,
  pct_indicacao: 5,
  pct_cashback: 5,
  teto_por_pessoa: 20,
  validade_dias: 90,
  compra_minima: 25,
}

export default function Fidelidade() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  // Aba na URL: voltar pra tela não perde o lugar, e dá pra mandar o link já
  // aberto na aba certa.
  const [params, setParams] = useSearchParams()
  const aba = params.get('aba') === 'clientes' ? 'clientes' : 'regras'
  const setAba = (id) => {
    const p = new URLSearchParams(params)
    if (id === 'regras') p.delete('aba'); else p.set('aba', id)
    setParams(p)
  }
  const [loading, setLoading] = useState(true)
  const [cfg, setCfg]         = useState(PADRAO)
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg]         = useState(null)

  const [clientes, setClientes]   = useState([])
  const [extrato, setExtrato]     = useState(null)   // { cliente, linhas }

  useEffect(() => {
    if (!empresaId) return
    supabase.from('fidelidade_config').select('*').eq('empresa_id', empresaId).maybeSingle()
      .then(({ data }) => {
        // Loja que nunca abriu esta tela não tem linha — vale como desligada.
        if (data) setCfg({ ...PADRAO, ...data })
        setLoading(false)
      })
  }, [empresaId])

  // Só busca a lista quando a aba abre: a view varre clientes e movimentos, e
  // quem entra aqui na maioria das vezes vem mexer nas regras.
  useEffect(() => {
    if (aba !== 'clientes' || !empresaId) return
    supabase.from('fidelidade_clientes').select('*').order('saldo', { ascending: false })
      .then(({ data }) => setClientes(data ?? []))
  }, [aba, empresaId])

  function set(campo, valor) {
    setCfg(c => ({ ...c, [campo]: valor }))
    setMsg(null)
  }

  async function salvar() {
    if (!empresaId) return
    setSalvando(true); setMsg(null)
    const { error } = await supabase.from('fidelidade_config').upsert({
      empresa_id:      empresaId,
      ativo:           cfg.ativo,
      pct_indicacao:   Number(cfg.pct_indicacao)   || 0,
      pct_cashback:    Number(cfg.pct_cashback)    || 0,
      teto_por_pessoa: Number(cfg.teto_por_pessoa) || 0,
      validade_dias:   Number(cfg.validade_dias)   || 0,
      compra_minima:   Number(cfg.compra_minima)   || 0,
      atualizado_em:   new Date().toISOString(),
    }, { onConflict: 'empresa_id' })
    setSalvando(false)
    setMsg(error ? { tipo: 'erro', texto: error.message } : { tipo: 'ok', texto: 'Regras salvas.' })
    if (!error) setTimeout(() => setMsg(null), 2500)
  }

  async function abrirExtrato(cliente) {
    setExtrato({ cliente, linhas: null })
    const { data } = await supabase.from('creditos_movimentos')
      .select('*').eq('cliente_id', cliente.cliente_id)
      .order('created_at', { ascending: false }).limit(100)
    setExtrato({ cliente, linhas: data ?? [] })
  }

  if (loading) return <div className="page"><p>Carregando...</p></div>

  // Quanto custa, no pior caso, cada indicado que voltar pra gastar tudo.
  const custoMax = Number(cfg.pct_indicacao || 0) + Number(cfg.pct_cashback || 0)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Indicação e Cashback</h1>
          <p className="page-subtitle">Seus clientes trazem clientes, e ganham crédito pra gastar aqui.</p>
        </div>
      </div>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '1px solid var(--border)' }}>
        {[['regras', 'Regras'], ['clientes', 'Clientes']].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setAba(id)}
            style={{
              padding: '9px 16px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontWeight: 700, fontSize: 14, marginBottom: -1,
              color: aba === id ? 'var(--primary)' : 'var(--text-muted)',
              borderBottom: `2px solid ${aba === id ? 'var(--primary)' : 'transparent'}`,
            }}>
            {label}
          </button>
        ))}
      </div>

      {aba === 'regras' && (
        <>
          {/* Chave mestra */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ maxWidth: 560 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Ligar indicação e cashback</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                  Cada cliente ganha um link pra chamar os amigos. Quando um amigo faz a
                  <b> primeira compra</b>, os dois ganham crédito pra gastar na loja — uma vez só.
                  Com isto desligado, nada disso existe: nem crédito, nem linha no caixa, nem despesa.
                </div>
              </div>
              <button
                type="button"
                onClick={() => set('ativo', !cfg.ativo)}
                aria-label="Ligar indicação e cashback"
                style={{
                  width: 52, height: 30, borderRadius: 999, border: 'none', cursor: 'pointer',
                  position: 'relative', flexShrink: 0,
                  background: cfg.ativo ? 'var(--primary)' : 'var(--border)', transition: 'background 150ms',
                }}
              >
                <span style={{
                  position: 'absolute', top: 3, left: cfg.ativo ? 25 : 3, width: 24, height: 24,
                  borderRadius: '50%', background: '#fff', transition: 'left 150ms',
                }} />
              </button>
            </div>
          </div>

          {/* Ajustes */}
          <div className="card">
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Quanto a loja paga</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
              O crédito só sai do bolso da loja quando o cliente <b>volta e gasta</b>.
              Crédito que ninguém usa não custa nada.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 16 }}>
              {AJUSTES.map(a => (
                <div className="form-field" key={a.campo}>
                  <label>{a.label}</label>
                  <input
                    type="number" min="0" step={a.step}
                    {...(a.max ? { max: a.max } : {})}
                    value={cfg[a.campo] ?? ''}
                    onChange={e => set(a.campo, e.target.value)}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.ajuda}</span>
                </div>
              ))}
            </div>

            {/* O número que o lojista precisa ver antes de salvar: somados, os
                dois percentuais são o que uma indicação custa no pior caso. */}
            <div style={{
              marginTop: 18, padding: '12px 14px', borderRadius: 8,
              background: custoMax > 15 ? 'rgba(220,38,38,.10)' : 'var(--bg-secondary, rgba(127,127,127,.08))',
              fontSize: 13, color: custoMax > 15 ? 'var(--danger)' : 'var(--text-muted)',
            }}>
              Cada pessoa indicada custa até <b>{custoMax.toLocaleString('pt-BR')}%</b> de
              uma compra — uma única vez, e só se os dois voltarem pra gastar.
              {custoMax > 15 && ' Isso é bastante: confira sua margem antes de salvar.'}
            </div>

            {msg && (
              <div style={{ marginTop: 12, fontSize: 13, color: msg.tipo === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
                {msg.texto}
              </div>
            )}

            <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={salvar} disabled={salvando}>
              {salvando ? 'Salvando...' : 'Salvar regras'}
            </button>
          </div>
        </>
      )}

      {aba === 'clientes' && (
        clientes.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🎟️</div>
            <p><strong>Ninguém participando ainda.</strong></p>
            <p>Assim que um cliente indicar alguém e essa pessoa comprar, os dois aparecem aqui.</p>
          </div>
        ) : (
          <div className="data-table">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th style={{ textAlign: 'right' }}>Indicou</th>
                  <th style={{ textAlign: 'right' }}>Ganhou</th>
                  <th style={{ textAlign: 'right' }}>Gastou</th>
                  <th style={{ textAlign: 'right' }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {clientes.map(c => (
                  <tr key={c.cliente_id} style={{ cursor: 'pointer' }} onClick={() => abrirExtrato(c)}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.nome}</div>
                      {c.telefone && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{c.telefone}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {c.indicados_pagos}
                      {c.indicados_pendentes > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> +{c.indicados_pendentes} a comprar</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmt(c.total_ganho)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(c.total_gasto)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: c.saldo > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                      {fmt(c.saldo)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Extrato de um cliente */}
      {extrato && (
        <div className="modal-overlay" onClick={() => setExtrato(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2>{extrato.cliente.nome}</h2>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
              Saldo atual: <b>{fmt(extrato.cliente.saldo)}</b>
            </div>

            {extrato.linhas === null ? (
              <p>Carregando...</p>
            ) : extrato.linhas.length === 0 ? (
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Sem movimento ainda.</p>
            ) : (
              <div style={{ display: 'grid', gap: 1, background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                {extrato.linhas.map(l => {
                  const entra = l.tipo === 'credito' || l.tipo === 'estorno'
                  return (
                    <div key={l.id} style={{ background: 'var(--bg)', padding: '10px 13px', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14 }}>{l.descricao || l.motivo}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          {new Date(l.created_at).toLocaleDateString('pt-BR')}
                          {l.expira_em && l.tipo === 'credito' && ` · vence ${new Date(l.expira_em + 'T12:00').toLocaleDateString('pt-BR')}`}
                        </div>
                      </div>
                      <div style={{ fontWeight: 700, whiteSpace: 'nowrap', color: entra ? 'var(--success)' : 'var(--danger)' }}>
                        {entra ? '+' : '−'} {fmt(l.valor)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <button type="button" className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => setExtrato(null)}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
