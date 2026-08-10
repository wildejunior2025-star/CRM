import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import ClientePicker from '../components/ClientePicker'
import { rotuloComanda } from '../lib/comanda'
import '../components/Page.css'

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
const FORMA_LABEL = { dinheiro: 'Dinheiro', pix: 'PIX', credito: 'Crédito', debito: 'Débito', cartao: 'Cartão', fiado: 'Fiado', dividido: 'Dividido', transferencia: 'Transferência' }
// Formas que dá pra escolher ao corrigir uma conta (o "dividido" não entra aqui).
const FORMAS_EDIT = [['dinheiro', 'Dinheiro'], ['pix', 'PIX'], ['credito', 'Crédito'], ['debito', 'Débito'], ['cartao', 'Cartão'], ['fiado', 'Fiado']]

function horaBR(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function PresencialHistorico() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [comandas, setComandas] = useState([])
  const [garcons, setGarcons]   = useState({})  // { profile_id: nome }
  const [entregas, setEntregas] = useState([])  // itens entregues hoje
  const [comissaoPct, setComissaoPct] = useState(0)
  const [loading, setLoading]   = useState(true)
  const [aberta, setAberta]     = useState(null) // id da comanda expandida
  const [pickerComanda, setPickerComanda] = useState(null) // comanda em que se está ligando o cliente
  const [editandoForma, setEditandoForma] = useState(null) // id da comanda com o seletor de forma aberto
  const [salvandoForma, setSalvandoForma] = useState(false)

  // Corrige a forma de pagamento de uma conta já fechada (lançou errado e fechou).
  async function trocarForma(comanda, forma) {
    if (forma === comanda.forma_pagamento) { setEditandoForma(null); return }
    setSalvandoForma(true)
    const { error } = await supabase.rpc('alterar_forma_pagamento_comanda', {
      p_comanda_id: comanda.id, p_forma: forma,
    })
    setSalvandoForma(false)
    setEditandoForma(null)
    if (error) { window.alert('Não deu pra trocar a forma: ' + error.message); return }
    setComandas(prev => prev.map(c => c.id === comanda.id ? { ...c, forma_pagamento: forma } : c))
  }

  // Liga (ou tira) um cliente a uma conta já fechada. Propaga pra venda no banco.
  async function ligarCliente(comanda, cliente) {
    const { error } = await supabase.rpc('vincular_cliente_comanda', {
      p_comanda_id: comanda.id, p_cliente_id: cliente?.id ?? null,
    })
    setPickerComanda(null)
    if (error) { window.alert('Erro ao ligar o cliente: ' + error.message); return }
    setComandas(prev => prev.map(c => c.id === comanda.id
      ? { ...c, cliente: cliente ? { id: cliente.id, nome: cliente.nome, telefone: cliente.telefone } : null }
      : c))
  }

  useEffect(() => {
    if (!empresaId) return
    const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0)
    Promise.all([
      supabase.from('comandas')
        .select('*, comanda_itens(*), cliente:clientes(id, nome, telefone)')
        .eq('empresa_id', empresaId)
        .eq('status', 'fechada')
        .order('fechada_at', { ascending: false })
        .limit(100),
      supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
      supabase.from('comanda_itens')
        .select('entregue_por, preco_unitario, quantidade')
        .eq('empresa_id', empresaId)
        .eq('status', 'entregue')
        .not('entregue_por', 'is', null)
        .gte('entregue_at', inicioHoje.toISOString()),
      supabase.from('empresas').select('comissao_garcom_pct').eq('id', empresaId).single(),
    ]).then(([cs, gs, es, emp]) => {
      setComandas(cs.data ?? [])
      setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
      setEntregas(es.data ?? [])
      setComissaoPct(Number(emp.data?.comissao_garcom_pct ?? 0))
      setLoading(false)
    })
  }, [empresaId])

  async function salvarComissao(v) {
    const n = Math.max(0, Math.min(100, Number(v) || 0))
    setComissaoPct(n)
    await supabase.from('empresas').update({ comissao_garcom_pct: n }).eq('id', empresaId)
  }

  // Ranking de entregas de hoje por garçom
  const rankingEntregas = useMemo(() => {
    const map = {}
    for (const it of entregas) {
      const k = it.entregue_por
      if (!map[k]) map[k] = { id: k, qtd: 0, valor: 0 }
      map[k].qtd += it.quantidade
      map[k].valor += Number(it.preco_unitario) * it.quantidade
    }
    return Object.values(map).sort((a, b) => b.qtd - a.qtd)
  }, [entregas])

  // Resumo de hoje
  const resumoHoje = useMemo(() => {
    const hoje = new Date().toDateString()
    const doDia = comandas.filter(c => c.fechada_at && new Date(c.fechada_at).toDateString() === hoje)
    return {
      qtd: doDia.length,
      total: doDia.reduce((s, c) => s + Number(c.total || 0), 0),
    }
  }, [comandas])

  if (loading) return <div className="page"><p>Carregando...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/pedidos-delivery" style={{ color: 'var(--primary)' }}>← Vendas</Link>
          </p>
          <h1>Vendas salão</h1>
          <p className="page-subtitle">Contas fechadas do salão.</p>
        </div>
      </div>

      {/* Resumo de hoje */}
      <div className="card" style={{ marginBottom: 18, display: 'flex', gap: 28, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Contas fechadas hoje</div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{resumoHoje.qtd}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Recebido hoje</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success)' }}>{fmt(resumoHoje.total)}</div>
        </div>
      </div>

      {/* Ranking de entregas por garçom (hoje) + comissão */}
      {rankingEntregas.length > 0 && (() => {
        const pctNum = Number(comissaoPct) || 0
        const totalEntregue = rankingEntregas.reduce((s, r) => s + r.valor, 0)
        const totalComissao = totalEntregue * pctNum / 100
        return (
          <div className="card" style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>🏆 Entregas por garçom (hoje)</div>
              <label style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                Comissão do garçom
                <input type="number" min="0" max="100" step="0.5" value={comissaoPct}
                  onChange={e => setComissaoPct(e.target.value)} onBlur={e => salvarComissao(e.target.value)}
                  style={{ width: 64, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                %
              </label>
            </div>
            {rankingEntregas.map((r, i) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < rankingEntregas.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>
                  {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`}
                </span>
                <span style={{ flex: 1, fontWeight: 600 }}>{garcons[r.id] ?? 'Garçom'}</span>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{r.qtd} {r.qtd === 1 ? 'item' : 'itens'} · {fmt(r.valor)}</span>
                {pctNum > 0 && (
                  <strong style={{ minWidth: 84, textAlign: 'right', color: 'var(--success)' }}>{fmt(r.valor * pctNum / 100)}</strong>
                )}
              </div>
            ))}
            {pctNum > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, marginTop: 4, borderTop: '1px dashed var(--border)', fontWeight: 800 }}>
                <span>Total de comissão ({pctNum}% sobre {fmt(totalEntregue)})</span>
                <span style={{ color: 'var(--success)' }}>{fmt(totalComissao)}</span>
              </div>
            )}
          </div>
        )
      })()}

      {comandas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          Nenhuma conta fechada ainda. Feche uma conta no Salão que ela aparece aqui. 🧾
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {comandas.map(c => {
            const expandida = aberta === c.id
            return (
              <div key={c.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <button type="button" onClick={() => setAberta(expandida ? null : c.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {c.numero_mesa ? rotuloComanda(c) : 'Balcão'}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {horaBR(c.fechada_at)} · {FORMA_LABEL[c.forma_pagamento] ?? c.forma_pagamento ?? '—'}
                      {' · '}{(c.comanda_itens ?? []).length} {(c.comanda_itens ?? []).length === 1 ? 'item' : 'itens'}
                    </div>
                    {c.garcom_id && garcons[c.garcom_id] && (
                      <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600 }}>
                        👤 {garcons[c.garcom_id]}
                      </div>
                    )}
                    {c.cliente && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
                        🧑 Cliente: {c.cliente.nome}{c.cliente.telefone ? ` · ${c.cliente.telefone}` : ''}
                      </div>
                    )}
                  </div>
                  <strong style={{ fontSize: 16 }}>{fmt(c.total)}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandida ? '▲' : '▼'}</span>
                </button>

                {expandida && (
                  <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border)' }}>
                    {(c.comanda_itens ?? []).map(it => (
                      <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                        <div>
                          <div style={{ fontSize: 13.5 }}>{it.quantidade}× {it.nome}</div>
                          {it.observacao && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>📝 {it.observacao}</div>}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(it.preco_unitario * it.quantidade)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, paddingTop: 8, color: 'var(--text-muted)' }}>
                      <span>Subtotal</span><span>{fmt(c.subtotal)}</span>
                    </div>
                    {Number(c.taxa_servico) > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)' }}>
                        <span>Taxa de serviço</span><span>{fmt(c.taxa_servico)}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, paddingTop: 6 }}>
                      <span>Total</span><span>{fmt(c.total)}</span>
                    </div>

                    {/* Forma de pagamento — mostra e deixa corrigir se lançou errado */}
                    <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-hover)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13.5 }}>
                          💳 Pagamento: <strong>{FORMA_LABEL[c.forma_pagamento] ?? c.forma_pagamento ?? '—'}</strong>
                        </span>
                        {editandoForma !== c.id && (
                          <button type="button" onClick={() => setEditandoForma(c.id)}
                            style={{ padding: '5px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)',
                              background: 'transparent', color: 'var(--primary)', fontSize: 12.5, fontWeight: 700 }}>
                            Trocar
                          </button>
                        )}
                      </div>
                      {editandoForma === c.id && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Escolha a forma correta:</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {FORMAS_EDIT.map(([id, lbl]) => (
                              <button key={id} type="button" disabled={salvandoForma} onClick={() => trocarForma(c, id)}
                                style={{ padding: '7px 12px', borderRadius: 8, cursor: salvandoForma ? 'wait' : 'pointer', fontWeight: 700, fontSize: 13,
                                  border: `1.5px solid ${c.forma_pagamento === id ? 'var(--primary)' : 'var(--border)'}`,
                                  background: c.forma_pagamento === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                                {lbl}
                              </button>
                            ))}
                            <button type="button" onClick={() => setEditandoForma(null)}
                              style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)' }}>
                              Cancelar
                            </button>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                            Fiado precisa de um cliente ligado à conta (é dívida, não entra no caixa).
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Ligar/trocar o cliente deste pedido já fechado */}
                    <button type="button" onClick={() => setPickerComanda(c)}
                      style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
                        border: `1.5px ${c.cliente ? 'solid var(--border)' : 'dashed var(--primary)'}`,
                        background: c.cliente ? 'transparent' : 'rgba(124,58,237,.06)',
                        color: c.cliente ? 'var(--text)' : 'var(--primary)', fontSize: 13.5, fontWeight: 700 }}>
                      {c.cliente ? `🧑 ${c.cliente.nome} · trocar cliente` : '➕ Ligar cliente a este pedido'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {pickerComanda && (
        <ClientePicker
          empresaId={empresaId}
          titulo={pickerComanda.numero_mesa ? `Cliente da ${rotuloComanda(pickerComanda, { comNome: false })}` : 'Cliente do pedido'}
          permitirTirar={!!pickerComanda.cliente}
          onPick={(cli) => ligarCliente(pickerComanda, cli)}
          onFechar={() => setPickerComanda(null)}
        />
      )}
    </div>
  )
}
