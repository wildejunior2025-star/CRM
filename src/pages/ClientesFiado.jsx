import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const fmtBRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
// Aceita "12,50" e "12.50" (mesma regra do Financeiro): vírgula manda, ponto vira milhar.
const parseValor = s => {
  let x = String(s ?? '').trim().replace(/[^\d.,]/g, '')
  if (!x) return 0
  if (x.includes(',')) x = x.replace(/\./g, '').replace(',', '.')
  return Number(x) || 0
}
const dataHora = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const semAcento = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
// Link de cobrança no WhatsApp: só dígitos, com 55 na frente se vier sem.
const zap = (tel) => {
  const d = String(tel ?? '').replace(/\D/g, '')
  if (d.length < 10) return null
  return `https://wa.me/${d.startsWith('55') ? d : '55' + d}`
}

// Quem está devendo e quanto. O saldo vem da view clientes_saldo_fiado:
//   Σ vendas (forma_pagamento <> 'a_vista')  −  Σ pagamentos
// A view alertas_fiado é essa mesma conta já com o nome do cliente e só quem
// deve (saldo > 0), ordenada do maior pro menor. As duas são security_invoker,
// então a RLS separa por empresa — o admin só enxerga os clientes da loja dele.
// Formas aceitas em `pagamentos`. O caixa soma cada uma num card diferente
// (recebimentos_dinheiro, _pix, _cartao, _transferencia), por isso a forma é
// escolhida e não chutada — chutar "dinheiro" bagunçaria a conferência do caixa.
const FORMAS = [
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'pix', label: 'PIX' },
  { id: 'cartao', label: 'Cartão' },
  { id: 'transferencia', label: 'Transferência' },
]

// Marca o recebimento de fiado e separa do pagamento de mesa no histórico.
const OBS_FIADO = 'Recebimento de fiado'

export default function ClientesFiado({ empresaId }) {
  // Esta tela abre no Financeiro (ADM) e também no Salão (garçom). Só o ADM apaga
  // dívida — a função no banco recusa de qualquer jeito, isto é só pra não mostrar
  // um botão que o garçom não pode usar.
  const { profile } = useAuth()
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'
  const [linhas, setLinhas] = useState([])
  const [historico, setHistorico] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const [busca, setBusca] = useState('')
  // Linha aberta pra receber: { cliente_id, valor(string), forma }
  const [recebendo, setRecebendo] = useState(null)
  const [salvando, setSalvando] = useState(false)
  // Histórico de compras aberto ao clicar no nome: { [cliente_id]: [vendas] | 'carregando' }
  const [compras, setCompras] = useState({})
  // Telefone em edição: { cliente_id, valor }. Cliente cadastrado às pressas no
  // balcão costuma ficar sem telefone — e sem telefone não dá pra cobrar no zap.
  const [editTel, setEditTel] = useState(null)
  const [salvandoTel, setSalvandoTel] = useState(false)

  // Grava o telefone de quem foi cadastrado sem ele.
  async function salvarTelefone(clienteId) {
    const tel = String(editTel?.valor ?? '').trim()
    if (tel.replace(/\D/g, '').length < 10) {
      window.alert('Digite o telefone com DDD (10 ou 11 números).')
      return
    }
    setSalvandoTel(true)
    const { error } = await supabase.from('clientes').update({ telefone: tel }).eq('id', clienteId)
    setSalvandoTel(false)
    if (error) { window.alert('Erro ao salvar o telefone: ' + error.message); return }
    setEditTel(null)
    await load()
  }

  // Apaga um fiado lançado errado (conta salva sem querer, valor trocado...).
  // Quem decide se pode é o banco (mig 0146): só ADM, só fiado, e só se ninguém
  // já tiver lançado recebimento em cima dessa dívida.
  async function apagarFiado(venda, clienteId) {
    const motivo = window.prompt(
      `Apagar este fiado de ${fmtBRL(venda.total)}?\n\nEle vai sumir da dívida do cliente.\nEscreva o porquê (fica registrado):`,
      'lançamento errado',
    )
    if (motivo === null) return
    const { error } = await supabase.rpc('cancelar_venda_fiado', { p_venda_id: venda.id, p_motivo: motivo })
    if (error) { window.alert('Não deu pra apagar: ' + error.message); return }
    setCompras(p => { const n = { ...p }; delete n[clienteId]; return n })
    await load()
  }

  // Puxa o que o cliente comprou (vendas + itens) sob demanda ao clicar no nome.
  // Só busca uma vez por cliente; clicar de novo fecha.
  async function verCompras(clienteId) {
    if (compras[clienteId]) { setCompras(p => { const n = { ...p }; delete n[clienteId]; return n }); return }
    setCompras(p => ({ ...p, [clienteId]: 'carregando' }))
    const { data, error } = await supabase.from('vendas')
      .select('id, total, forma_pagamento, created_at, venda_itens(quantidade, preco_unitario, produtos(nome))')
      .eq('empresa_id', empresaId)
      .eq('cliente_id', clienteId)
      .neq('status', 'cancelado')
      .order('created_at', { ascending: false })
      .limit(30)
    setCompras(p => ({ ...p, [clienteId]: error ? [] : (data ?? []) }))
  }

  async function load() {
    setLoading(true); setErro(null)
    // alertas_fiado não traz telefone/limite; busca os dados do cliente à parte
    // e junta por id (a view não tem FK, então não dá pra embutir no select).
    const [fi, cl, pg] = await Promise.all([
      supabase.from('alertas_fiado').select('cliente_id, cliente_nome, saldo_fiado'),
      supabase.from('clientes').select('id, telefone, limite_credito').eq('empresa_id', empresaId),
      // Só os recebimentos de fiado. `pagamentos` também guarda a mesa fechada em
      // dinheiro/PIX/cartão (vem da fechar_conta_presencial, com observação
      // "Presencial · Mesa N"), e misturar as duas coisas aqui daria a impressão
      // de que todo mundo pagou fiado. O marcador é a observação que gravamos
      // no `receber()` — se mudar lá, mude aqui.
      supabase.from('pagamentos')
        .select('id, valor, forma_pagamento, created_at, observacao, clientes(nome)')
        .eq('empresa_id', empresaId)
        .eq('observacao', OBS_FIADO)
        .order('created_at', { ascending: false })
        .limit(50),
    ])
    if (fi.error) { setErro(fi.error.message); setLoading(false); return }
    const extra = Object.fromEntries((cl.data ?? []).map(c => [c.id, c]))
    setLinhas((fi.data ?? []).map(f => ({
      ...f,
      saldo_fiado: Number(f.saldo_fiado || 0),
      telefone: extra[f.cliente_id]?.telefone ?? null,
      limite: Number(extra[f.cliente_id]?.limite_credito || 0),
    })))
    setHistorico(pg.data ?? [])
    setLoading(false)
  }

  useEffect(() => { if (empresaId) load() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Registra o recebimento. É a linha em `pagamentos` que abate o saldo: a view
  // clientes_saldo_fiado faz "vendas − pagamentos", então quem quita some da lista
  // sozinho. Pagou só uma parte? Continua na lista, com o resto.
  async function receber(linha) {
    const valor = Math.round(parseValor(recebendo?.valor) * 100) / 100
    if (!(valor > 0)) { window.alert('Digite um valor maior que zero.'); return }
    if (valor > linha.saldo_fiado + 0.005) {
      window.alert(`O valor é maior do que a dívida (${fmtBRL(linha.saldo_fiado)}).`)
      return
    }
    setSalvando(true)
    // caixa_id não vai aqui de propósito: a coluna tem DEFAULT current_caixa_id(),
    // então o recebimento cai sozinho no caixa aberto de quem está registrando.
    const { error } = await supabase.from('pagamentos').insert({
      empresa_id: empresaId,
      cliente_id: linha.cliente_id,
      forma_pagamento: recebendo.forma,
      valor,
      observacao: OBS_FIADO,
    })
    setSalvando(false)
    if (error) { window.alert('Erro ao registrar o pagamento: ' + error.message); return }
    setRecebendo(null)
    await load()
  }

  const filtradas = useMemo(() => {
    const q = semAcento(busca)
    return q ? linhas.filter(l => semAcento(l.cliente_nome).includes(q)) : linhas
  }, [linhas, busca])

  const total = filtradas.reduce((s, l) => s + l.saldo_fiado, 0)
  const acimaDoLimite = filtradas.filter(l => l.limite > 0 && l.saldo_fiado > l.limite).length

  if (loading) return <div className="empty-state">Carregando...</div>
  if (erro) return <p className="error-text">Erro ao carregar: {erro}</p>

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
          <div className="label">Total a receber</div>
          <div className="value">{fmtBRL(total)}</div>
        </div>
        <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
          <div className="label">Clientes devendo</div>
          <div className="value">{filtradas.length}</div>
        </div>
        {acimaDoLimite > 0 && (
          <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
            <div className="label">Acima do limite</div>
            <div className="value" style={{ color: '#d97706' }}>{acimaDoLimite}</div>
          </div>
        )}
      </div>

      {linhas.length > 3 && (
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar cliente..."
          style={{ width: '100%', maxWidth: 320, padding: '9px 12px', marginBottom: 12, borderRadius: 8, boxSizing: 'border-box',
            border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14 }} />
      )}

      <div className="data-table">
        {filtradas.length === 0 ? (
          <div className="empty-state">
            {busca ? 'Nenhum cliente com esse nome.' : 'Ninguém devendo no fiado. 🎉'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th style={{ textAlign: 'right' }}>Deve</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtradas.map(l => {
                const estourou = l.limite > 0 && l.saldo_fiado > l.limite
                const link = zap(l.telefone)
                const aberto = recebendo?.cliente_id === l.cliente_id
                return (
                  <Fragment key={l.cliente_id}>
                    <tr>
                      <td>
                        {/* Nome clicável: abre/fecha o histórico de compras */}
                        <button type="button" onClick={() => verCompras(l.cliente_id)}
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                            fontWeight: 600, fontSize: 14.5, color: 'var(--primary)' }}>
                          {compras[l.cliente_id] ? '▾ ' : '▸ '}{l.cliente_nome}
                        </button>
                        {l.telefone ? (
                          link
                            ? <a href={link} target="_blank" rel="noreferrer"
                                style={{ fontSize: 12.5, color: 'var(--primary)', textDecoration: 'none' }}>
                                💬 {l.telefone}
                              </a>
                            : <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{l.telefone}</span>
                        ) : editTel?.cliente_id === l.cliente_id ? (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
                            <input value={editTel.valor} type="tel" inputMode="tel" autoFocus
                              placeholder="Telefone com DDD"
                              onChange={e => setEditTel(t => ({ ...t, valor: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') salvarTelefone(l.cliente_id) }}
                              style={{ width: 150, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)',
                                background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }} />
                            <button type="button" onClick={() => salvarTelefone(l.cliente_id)} disabled={salvandoTel}
                              style={{ padding: '5px 10px', borderRadius: 7, border: 'none', cursor: 'pointer',
                                background: 'var(--primary)', color: '#fff', fontSize: 12, fontWeight: 800 }}>
                              {salvandoTel ? '...' : 'Salvar'}
                            </button>
                            <button type="button" onClick={() => setEditTel(null)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16 }}>×</button>
                          </div>
                        ) : (
                          // Cadastrou no aperto e não pegou o telefone? Põe agora.
                          <button type="button" onClick={() => setEditTel({ cliente_id: l.cliente_id, valor: '' })}
                            style={{ display: 'block', background: 'none', border: 'none', padding: 0, marginTop: 2,
                              cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12.5, textDecoration: 'underline' }}>
                            ➕ pôr o telefone
                          </button>
                        )}
                        {estourou && (
                          <div style={{ fontSize: 12, color: '#d97706', fontWeight: 700 }}>
                            ⚠️ passou do limite de {fmtBRL(l.limite)}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800, whiteSpace: 'nowrap' }}>
                        {fmtBRL(l.saldo_fiado)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button"
                          onClick={() => setRecebendo(aberto ? null : {
                            cliente_id: l.cliente_id,
                            valor: l.saldo_fiado.toFixed(2).replace('.', ','),
                            forma: 'dinheiro',
                          })}
                          style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
                            border: `1px solid ${aberto ? 'var(--border)' : 'var(--success, #16a34a)'}`,
                            background: 'transparent', color: aberto ? 'var(--text-muted)' : 'var(--success, #16a34a)',
                            fontSize: 12.5, fontWeight: 700 }}>
                          {aberto ? 'Cancelar' : '✓ Pago'}
                        </button>
                      </td>
                    </tr>

                    {aberto && (
                      <tr>
                        <td colSpan={3} style={{ background: 'rgba(22,163,74,.06)' }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '4px 0' }}>
                            <span style={{ fontSize: 12.5, fontWeight: 700 }}>Recebeu quanto?</span>
                            <input value={recebendo.valor} inputMode="decimal" autoFocus
                              onChange={e => setRecebendo(r => ({ ...r, valor: e.target.value }))}
                              style={{ width: 110, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--border)',
                                background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14, fontWeight: 700 }} />

                            <select value={recebendo.forma}
                              onChange={e => setRecebendo(r => ({ ...r, forma: e.target.value }))}
                              style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid var(--border)',
                                background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13.5 }}>
                              {FORMAS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                            </select>

                            <button type="button" onClick={() => receber(l)} disabled={salvando}
                              style={{ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: salvando ? 'wait' : 'pointer',
                                background: 'var(--success, #16a34a)', color: '#fff', fontSize: 13, fontWeight: 800, opacity: salvando ? .6 : 1 }}>
                              {salvando ? 'Salvando...' : 'Confirmar'}
                            </button>

                            {parseValor(recebendo.valor) > 0 && parseValor(recebendo.valor) < l.saldo_fiado && (
                              <span style={{ fontSize: 12.5, color: '#d97706', fontWeight: 700 }}>
                                fica devendo {fmtBRL(l.saldo_fiado - parseValor(recebendo.valor))}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}

                    {/* Histórico de compras do cliente (abre ao clicar no nome) */}
                    {compras[l.cliente_id] && (
                      <tr>
                        <td colSpan={3} style={{ background: 'var(--card, rgba(124,58,237,.04))' }}>
                          {compras[l.cliente_id] === 'carregando' ? (
                            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>Carregando compras...</div>
                          ) : compras[l.cliente_id].length === 0 ? (
                            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>Nenhuma compra registrada.</div>
                          ) : (
                            <div style={{ padding: '2px 0' }}>
                              {compras[l.cliente_id].map(v => (
                                <div key={v.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                                    <span style={{ color: 'var(--text-muted)' }}>
                                      {dataHora(v.created_at)}
                                      {v.forma_pagamento === 'fiado' && <span style={{ color: '#d97706', fontWeight: 700 }}> · fiado</span>}
                                    </span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                                      <span style={{ fontWeight: 700 }}>{fmtBRL(v.total)}</span>
                                      {/* Fiado lançado errado: o ADM apaga aqui (mig 0146). */}
                                      {ehAdmin && v.forma_pagamento === 'fiado' && (
                                        <button type="button" onClick={() => apagarFiado(v, l.cliente_id)}
                                          title="Apagar este fiado (lançamento errado)"
                                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                            fontSize: 14, lineHeight: 1, color: 'var(--danger)' }}>
                                          🗑️
                                        </button>
                                      )}
                                    </span>
                                  </div>
                                  {(v.venda_itens ?? []).length > 0 && (
                                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                                      {v.venda_itens.map((it, i) => (
                                        <span key={i}>{i > 0 ? ' · ' : ''}{it.quantidade}× {it.produtos?.nome ?? 'item'}</span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
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

      {/* Histórico: pra onde some quem pagou. Sem isso, quitar a dívida faria o
          cliente sumir da tela sem deixar rastro nenhum. */}
      <div style={{ fontSize: 15, fontWeight: 800, margin: '26px 0 10px' }}>
        ✅ Pagamentos recebidos
      </div>
      <div className="data-table">
        {historico.length === 0 ? (
          <div className="empty-state">Nenhum pagamento registrado ainda.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Quando</th>
                <th>Forma</th>
                <th style={{ textAlign: 'right' }}>Valor</th>
              </tr>
            </thead>
            <tbody>
              {historico.map(p => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.clientes?.nome ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 13 }}>{dataHora(p.created_at)}</td>
                  <td style={{ fontSize: 13 }}>
                    {FORMAS.find(f => f.id === p.forma_pagamento)?.label ?? p.forma_pagamento}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--success, #16a34a)' }}>
                    {fmtBRL(p.valor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
