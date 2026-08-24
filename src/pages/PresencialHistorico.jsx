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
  const { profile, user } = useAuth()
  const empresaId = profile?.empresa_id
  // A MESMA tela serve o dono e o garçom. Pro garçom ela vira "Minhas mesas":
  // só as contas que ele atendeu, sem os controles de dono (corrigir forma de
  // pagamento, ligar cliente, mexer na comissão) e sem o ranking dos colegas —
  // quanto o outro vendeu não é assunto dele.
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'
  const meuId = user?.id

  const [comandas, setComandas] = useState([])
  const [garcons, setGarcons]   = useState({})  // { profile_id: nome }
  const [entregas, setEntregas] = useState([])  // itens entregues hoje
  const [lancados, setLancados] = useState([])  // itens lançados hoje (mig 0187)
  const [fechadas, setFechadas] = useState([])  // contas fechadas hoje, por quem fechou
  const [pontosCfg, setPontosCfg] = useState({ lancar: 1, entregar: 1, fechar: 2 })
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
    // Garçom só puxa o que é dele — filtrado no BANCO, não na tela: menos dado
    // viajando no celular dele e nada de conta dos outros passando por ali.
    let qComandas = supabase.from('comandas')
      .select('*, comanda_itens(*), cliente:clientes(id, nome, telefone)')
      .eq('empresa_id', empresaId)
      .eq('status', 'fechada')
    if (!ehAdmin && meuId) qComandas = qComandas.eq('garcom_id', meuId)

    Promise.all([
      qComandas.order('fechada_at', { ascending: false }).limit(100),
      supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
      supabase.from('comanda_itens')
        .select('entregue_por, preco_unitario, quantidade')
        .eq('empresa_id', empresaId)
        .eq('status', 'entregue')
        .not('entregue_por', 'is', null)
        .gte('entregue_at', inicioHoje.toISOString()),
      supabase.from('empresas').select('comissao_garcom_pct, pontos_garcom').eq('id', empresaId).single(),
      // Quem LANÇOU cada item hoje (mig 0187)
      supabase.from('comanda_itens')
        .select('lancado_por, preco_unitario, quantidade')
        .eq('empresa_id', empresaId)
        .not('lancado_por', 'is', null)
        .gte('created_at', inicioHoje.toISOString()),
      // Quem FECHOU cada conta hoje (mig 0187)
      supabase.from('comandas')
        .select('fechada_por')
        .eq('empresa_id', empresaId)
        .not('fechada_por', 'is', null)
        .gte('fechada_por_em', inicioHoje.toISOString()),
    ]).then(([cs, gs, es, emp, ls, fs]) => {
      setComandas(cs.data ?? [])
      setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
      setEntregas(es.data ?? [])
      setLancados(ls.data ?? [])
      setFechadas(fs.data ?? [])
      setComissaoPct(Number(emp.data?.comissao_garcom_pct ?? 0))
      const pc = emp.data?.pontos_garcom
      if (pc) setPontosCfg({ lancar: Number(pc.lancar ?? 1), entregar: Number(pc.entregar ?? 1), fechar: Number(pc.fechar ?? 2) })
      setLoading(false)
    })
  }, [empresaId, ehAdmin, meuId])

  async function salvarPontos(campo, valor) {
    const n = Math.max(0, Math.min(99, Number(valor) || 0))
    const novo = { ...pontosCfg, [campo]: n }
    setPontosCfg(novo)
    await supabase.from('empresas').update({ pontos_garcom: novo }).eq('id', empresaId)
  }

  async function salvarComissao(v) {
    const n = Math.max(0, Math.min(100, Number(v) || 0))
    setComissaoPct(n)
    await supabase.from('empresas').update({ comissao_garcom_pct: n }).eq('id', empresaId)
  }

  // Ranking do dia por PONTOS (mig 0187).
  //
  // Antes contava só entrega. O ranking por "dono da mesa" (quem abriu) foi
  // descartado de propósito: ele obriga o garçom a carregar aquela mesa até o
  // fim pra levar o crédito, e cria o "não mexe na minha mesa" que trava o
  // salão. Contando gesto por gesto, qualquer um atende qualquer mesa.
  const ranking = useMemo(() => {
    const map = {}
    const linha = (k) => (map[k] ??= { id: k, lancou: 0, entregou: 0, fechou: 0, valor: 0 })
    for (const it of lancados) linha(it.lancado_por).lancou += it.quantidade
    for (const it of entregas) {
      const l = linha(it.entregue_por)
      l.entregou += it.quantidade
      l.valor += Number(it.preco_unitario) * it.quantidade   // base da comissão em R$
    }
    for (const c of fechadas) linha(c.fechada_por).fechou += 1
    const lista = Object.values(map).map(r => ({
      ...r,
      pontos: r.lancou * pontosCfg.lancar + r.entregou * pontosCfg.entregar + r.fechou * pontosCfg.fechar,
    })).sort((a, b) => b.pontos - a.pontos)
    return ehAdmin ? lista : lista.filter(r => r.id === meuId)
  }, [lancados, entregas, fechadas, pontosCfg, ehAdmin, meuId])

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
            <Link to={ehAdmin ? '/pedidos-delivery' : '/presencial/salao'} style={{ color: 'var(--primary)' }}>
              {ehAdmin ? '← Vendas' : '← Salão'}
            </Link>
          </p>
          <h1>{ehAdmin ? 'Vendas salão' : 'Minhas mesas'}</h1>
          <p className="page-subtitle">
            {ehAdmin ? 'Contas fechadas do salão.' : 'As mesas que você atendeu e já foram fechadas.'}
          </p>
        </div>
      </div>

      {/* Resumo de hoje */}
      <div className="card" style={{ marginBottom: 18, display: 'flex', gap: 28, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ehAdmin ? 'Contas fechadas hoje' : 'Suas mesas fechadas hoje'}</div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{resumoHoje.qtd}</div>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ehAdmin ? 'Recebido hoje' : 'Total das suas mesas hoje'}</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success)' }}>{fmt(resumoHoje.total)}</div>
        </div>
      </div>

      {/* Ranking do dia por pontos (mig 0187) */}
      {ranking.length > 0 && (() => {
        const pctNum = Number(comissaoPct) || 0
        const totalEntregue = ranking.reduce((s, r) => s + r.valor, 0)
        const cel = { padding: '7px 6px', fontSize: 12.5, textAlign: 'center', whiteSpace: 'nowrap' }
        return (
          <div className="card" style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>{ehAdmin ? '🏆 Pontos por garçom (hoje)' : '🏆 Seus pontos hoje'}</div>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 10px', lineHeight: 1.45 }}>
              Conta gesto por gesto, não mesa por mesa — assim qualquer um atende qualquer mesa
              sem perder o crédito do que fez.
            </p>

            {/* Pesos: só o dono mexe; o garçom vê quanto vale cada coisa. */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12,
              padding: '9px 11px', borderRadius: 9, background: 'var(--surface-hover)', border: '1px solid var(--border)' }}>
              {[['lancar', 'Lançar item'], ['entregar', 'Entregar item'], ['fechar', 'Fechar conta']].map(([k, lbl]) => (
                <label key={k} style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {lbl}
                  {ehAdmin ? (
                    <input type="number" min="0" max="99" step="1" value={pontosCfg[k]}
                      onChange={e => setPontosCfg(p => ({ ...p, [k]: e.target.value }))}
                      onBlur={e => salvarPontos(k, e.target.value)}
                      style={{ width: 52, padding: '4px 6px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                  ) : (
                    <strong style={{ color: 'var(--text)' }}>{pontosCfg[k]}</strong>
                  )}
                  <span>pt</span>
                </label>
              ))}
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 380 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em' }}>
                    <th style={{ ...cel, textAlign: 'left' }}>Garçom</th>
                    <th style={cel}>Lançou</th>
                    <th style={cel}>Entregou</th>
                    <th style={cel}>Fechou</th>
                    <th style={{ ...cel, textAlign: 'right' }}>Pontos</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map((r, i) => (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ ...cel, textAlign: 'left', fontWeight: 600 }}>
                        {ehAdmin && <span style={{ marginRight: 6 }}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`}</span>}
                        {garcons[r.id] ?? 'Garçom'}
                      </td>
                      <td style={cel}>{r.lancou}</td>
                      <td style={cel}>{r.entregou}</td>
                      <td style={cel}>{r.fechou}</td>
                      <td style={{ ...cel, textAlign: 'right', fontWeight: 800, fontSize: 14 }}>{r.pontos}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* A comissão em R$ continua pelo VALOR ENTREGUE: pontos medem esforço,
                dinheiro segue o que a pessoa carregou até a mesa. */}
            {pctNum > 0 && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Comissão de {pctNum}% sobre o que cada um entregou
                </div>
                {ranking.filter(r => r.valor > 0).map(r => (
                  <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                    <span>{garcons[r.id] ?? 'Garçom'} · {fmt(r.valor)}</span>
                    <strong style={{ color: 'var(--success)' }}>{fmt(r.valor * pctNum / 100)}</strong>
                  </div>
                ))}
                {ehAdmin && (
                  <label style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                    Comissão do garçom
                    <input type="number" min="0" max="100" step="0.5" value={comissaoPct}
                      onChange={e => setComissaoPct(e.target.value)} onBlur={e => salvarComissao(e.target.value)}
                      style={{ width: 64, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                    %
                  </label>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, marginTop: 6, borderTop: '1px dashed var(--border)', fontWeight: 800 }}>
                  <span>Total ({fmt(totalEntregue)} entregue)</span>
                  <span style={{ color: 'var(--success)' }}>{fmt(totalEntregue * pctNum / 100)}</span>
                </div>
              </div>
            )}
            {pctNum === 0 && ehAdmin && (
              <label style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
                Comissão em % sobre o que o garçom entrega (0 = não usa)
                <input type="number" min="0" max="100" step="0.5" value={comissaoPct}
                  onChange={e => setComissaoPct(e.target.value)} onBlur={e => salvarComissao(e.target.value)}
                  style={{ width: 64, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                %
              </label>
            )}
          </div>
        )
      })()}

      {comandas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          {ehAdmin ? 'Nenhuma conta fechada ainda. Feche uma conta no Salão que ela aparece aqui. 🧾' : 'Você ainda não teve mesa fechada. Assim que fechar, ela aparece aqui. 🧾'}
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
                    {(c.garcom_id || c.fechada_por) && (
                      <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600 }}>
                        {c.garcom_id && garcons[c.garcom_id] && <>👤 abriu: {garcons[c.garcom_id]}</>}
                        {c.garcom_id && garcons[c.garcom_id] && c.fechada_por && garcons[c.fechada_por] && ' · '}
                        {c.fechada_por && garcons[c.fechada_por] && <>🧾 fechou: {garcons[c.fechada_por]}</>}
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
                          {/* A trilha de quem fez o quê. Estava só no banco: quando o
                              cliente contestava um item na hora de pagar, a resposta
                              existia mas ninguém conseguia olhar. Agora está na linha
                              do próprio item — que é onde a pergunta nasce. */}
                          {(it.lancado_por || it.entregue_por) && (
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                              {it.lancado_por && <>✍️ lançou: {garcons[it.lancado_por] ?? '—'}</>}
                              {it.lancado_por && it.entregue_por && ' · '}
                              {it.entregue_por && <>🍽️ entregou: {garcons[it.entregue_por] ?? '—'}</>}
                            </div>
                          )}
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
                        {ehAdmin && editandoForma !== c.id && (
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

                    {/* Ligar/trocar o cliente deste pedido já fechado — mexe em fiado
                        e no cadastro, então é coisa de dono. */}
                    {ehAdmin && (
                    <button type="button" onClick={() => setPickerComanda(c)}
                      style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
                        border: `1.5px ${c.cliente ? 'solid var(--border)' : 'dashed var(--primary)'}`,
                        background: c.cliente ? 'transparent' : 'rgba(124,58,237,.06)',
                        color: c.cliente ? 'var(--text)' : 'var(--primary)', fontSize: 13.5, fontWeight: 700 }}>
                      {c.cliente ? `🧑 ${c.cliente.nome} · trocar cliente` : '➕ Ligar cliente a este pedido'}
                    </button>
                    )}
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
