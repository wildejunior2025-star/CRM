import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { imprimirHtml, montarContaPresencialHtml } from '../utils/imprimirCupom'
import '../components/Page.css'

const FORMAS = [
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'pix',      label: 'PIX' },
  { id: 'cartao',   label: 'Cartão' },
]

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

export default function PresencialSalao() {
  const { profile, user } = useAuth()
  const empresaId = profile?.empresa_id
  // Só o ADM confere o pagamento e libera a mesa. Garçom fecha, mas não libera.
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'

  const [taxaPct, setTaxaPct] = useState(10)
  const [empresaNome, setEmpresaNome] = useState('')
  const [mesas, setMesas]     = useState([])
  const [comandas, setComandas] = useState([])
  const [produtos, setProdutos] = useState([])
  const [garcons, setGarcons] = useState({})   // { profile_id: nome }
  const [loading, setLoading] = useState(true)

  const [mesaSel, setMesaSel] = useState(null)   // mesa aberta no drawer
  const [busca, setBusca]     = useState('')
  const [fechando, setFechando] = useState(false) // modal de fechamento
  const [forma, setForma]     = useState('dinheiro')
  const [aplicarTaxa, setAplicarTaxa] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [obsEdit, setObsEdit] = useState({})  // observação em edição por item
  const [modoPag, setModoPag] = useState('unico')   // 'unico' | 'dividir'
  const [pagamentos, setPagamentos] = useState([])  // [{ forma, valor(string) }] no modo dividir
  // Rascunho: itens que o garçom monta mas que só vão pra cozinha (e pra impressora)
  // quando ele clica "Enviar" — assim o pedido inteiro sai numa impressão só.
  const [rascunho, setRascunho] = useState([]) // [{ produto_id, nome, preco_venda, quantidade }]
  const [enviando, setEnviando] = useState(false)

  async function loadAll() {
    if (!empresaId) return
    const [emp, ms, cs, ps, gs] = await Promise.all([
      supabase.from('empresas').select('taxa_servico_pct, nome').eq('id', empresaId).single(),
      supabase.from('mesas').select('*').eq('empresa_id', empresaId).eq('ativa', true).order('numero'),
      supabase.from('comandas').select('*, comanda_itens(*)').eq('empresa_id', empresaId).in('status', ['aberta', 'aguardando_conferencia']),
      supabase.from('estoque_catalogo').select('produto_id, nome, preco_venda, categoria').eq('empresa_id', empresaId).order('nome').limit(500),
      supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
    ])
    if (emp.data) { setTaxaPct(Number(emp.data.taxa_servico_pct ?? 10)); setEmpresaNome(emp.data.nome || '') }
    setMesas(ms.data ?? [])
    setComandas(cs.data ?? [])
    setProdutos(ps.data ?? [])
    setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: atualiza quando outro garçom mexe nas comandas
  useEffect(() => {
    if (!empresaId) return
    const ch = supabase.channel(`salao_${empresaId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comandas', filter: `empresa_id=eq.${empresaId}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_itens', filter: `empresa_id=eq.${empresaId}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mesas', filter: `empresa_id=eq.${empresaId}` }, loadAll)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  const comandaPorMesa = useMemo(() => {
    const map = {}
    for (const c of comandas) map[c.mesa_id] = c
    return map
  }, [comandas])

  function subtotalDe(comanda) {
    return (comanda?.comanda_itens ?? []).reduce((s, i) => s + Number(i.preco_unitario) * i.quantidade, 0)
  }

  function prontosDe(comanda) {
    return (comanda?.comanda_itens ?? []).filter(i => i.status === 'pronto').length
  }

  // Bip quando a cozinha marca um item como pronto (avisa o garçom)
  const prevProntos = useRef(0)
  function bip() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = 880
      gain.gain.setValueAtTime(0.001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
      osc.start(); osc.stop(ctx.currentTime + 0.36)
    } catch { /* áudio bloqueado pelo navegador — ignora */ }
  }
  useEffect(() => {
    const total = comandas.reduce((s, c) => s + prontosDe(c), 0)
    if (total > prevProntos.current) bip()
    prevProntos.current = total
  }, [comandas])

  const comandaSel = mesaSel ? comandaPorMesa[mesaSel.id] : null
  // Rascunho é por comanda e fica salvo no navegador (sobrevive a fechar sem querer).
  const rascunhoKey = comandaSel ? 'rasc_mesa_' + comandaSel.id : null
  useEffect(() => {
    if (!rascunhoKey) { setRascunho([]); return }
    try { setRascunho(JSON.parse(localStorage.getItem(rascunhoKey) || '[]')) } catch { setRascunho([]) }
  }, [rascunhoKey])
  useEffect(() => {
    if (!rascunhoKey) return
    try { localStorage.setItem(rascunhoKey, JSON.stringify(rascunho)) } catch { /* ignora */ }
  }, [rascunho, rascunhoKey])
  const subtotalRascunho = rascunho.reduce((s, r) => s + Number(r.preco_venda) * r.quantidade, 0)

  const subtotalSel = subtotalDe(comandaSel)
  const taxaSel = aplicarTaxa ? Math.round(subtotalSel * (taxaPct / 100) * 100) / 100 : 0
  const totalSel = subtotalSel + taxaSel

  // Divisão da conta
  const somaPag = pagamentos.reduce((s, p) => s + (Number(p.valor) || 0), 0)
  const restante = Math.round((totalSel - somaPag) * 100) / 100
  const podeReceber = modoPag === 'unico' || Math.abs(restante) < 0.05

  // ── Ações ────────────────────────────────────────────────────────────────
  async function abrirMesa(mesa) {
    const existente = comandaPorMesa[mesa.id]
    if (!existente) {
      await supabase.from('comandas').insert({
        empresa_id: empresaId, mesa_id: mesa.id, numero_mesa: mesa.numero, garcom_id: user?.id ?? null,
      })
      await supabase.from('mesas').update({ status: 'ocupada' }).eq('id', mesa.id)
      await loadAll()
    }
    setMesaSel(mesa)
    setBusca(''); setFechando(false); setForma('dinheiro'); setAplicarTaxa(true)
  }

  // Adicionar item agora vai pro RASCUNHO (não vai pra cozinha ainda). Só quando o
  // garçom clica "Enviar para a cozinha" é que os itens são gravados e impressos.
  function addItem(produto) {
    if (!comandaSel) return
    if (comandaSel.status === 'aguardando_conferencia') { window.alert('Conta já fechada, aguardando o ADM liberar a mesa.'); return }
    setRascunho(prev => {
      const i = prev.findIndex(r => r.produto_id === produto.produto_id)
      if (i >= 0) {
        const c = prev.slice(); c[i] = { ...c[i], quantidade: c[i].quantidade + 1 }; return c
      }
      return [...prev, { produto_id: produto.produto_id, nome: produto.nome, preco_venda: Number(produto.preco_venda), quantidade: 1 }]
    })
  }
  function mudarQtdRascunho(produtoId, delta) {
    setRascunho(prev => prev.flatMap(r => {
      if (r.produto_id !== produtoId) return [r]
      const q = r.quantidade + delta
      return q <= 0 ? [] : [{ ...r, quantidade: q }]
    }))
  }
  // Envia o pedido montado pra cozinha: insere TODOS os itens de uma vez → sai numa
  // impressão só (o gestor e o app FWC juntam os inserts que chegam juntos).
  async function enviarCozinha() {
    if (!comandaSel || !rascunho.length || enviando) return
    setEnviando(true)
    const rows = rascunho.map(r => ({
      empresa_id: empresaId, comanda_id: comandaSel.id,
      produto_id: r.produto_id, nome: r.nome,
      preco_unitario: Number(r.preco_venda), quantidade: r.quantidade,
    }))
    const { error } = await supabase.from('comanda_itens').insert(rows)
    setEnviando(false)
    if (error) { window.alert('Erro ao enviar pra cozinha: ' + error.message); return }
    setRascunho([])
    if (rascunhoKey) { try { localStorage.removeItem(rascunhoKey) } catch { /* ignora */ } }
    await loadAll()
  }

  async function mudarQtd(item, delta) {
    const nova = item.quantidade + delta
    if (nova <= 0) await supabase.from('comanda_itens').delete().eq('id', item.id)
    else await supabase.from('comanda_itens').update({ quantidade: nova }).eq('id', item.id)
    await loadAll()
  }

  async function entregarItem(item) {
    // registra QUEM entregou (quem clicou) — atribuição por entrega
    await supabase.from('comanda_itens')
      .update({ status: 'entregue', entregue_por: user?.id ?? null, entregue_at: new Date().toISOString() })
      .eq('id', item.id)
    await loadAll()
  }

  async function salvarObs(item) {
    const texto = obsEdit[item.id]
    if (texto === undefined) return                 // não estava editando
    const novo = texto.trim() || null
    if (novo === (item.observacao ?? null)) {        // não mudou
      setObsEdit(prev => { const n = { ...prev }; delete n[item.id]; return n })
      return
    }
    await supabase.from('comanda_itens').update({ observacao: novo }).eq('id', item.id)
    setObsEdit(prev => { const n = { ...prev }; delete n[item.id]; return n })
    await loadAll()
  }

  async function cancelarMesa() {
    if (!comandaSel) return
    if (!window.confirm('Cancelar esta mesa? Os itens lançados serão descartados.')) return
    await supabase.from('comandas').update({ status: 'cancelada' }).eq('id', comandaSel.id)
    await supabase.from('mesas').update({ status: 'livre' }).eq('id', mesaSel.id)
    setMesaSel(null)
    await loadAll()
  }

  function abrirFechamento() {
    setModoPag('unico')
    setForma('dinheiro')
    setPagamentos([])
    setFechando(true)
  }

  // Rachar igual entre n pessoas (ajusta a última linha p/ fechar o total)
  function dividirIgual(n) {
    const cada = Math.floor((totalSel / n) * 100) / 100
    const arr = Array.from({ length: n }, () => ({ forma: 'dinheiro', valor: cada.toFixed(2) }))
    const resto = Math.round((totalSel - cada * n) * 100) / 100
    if (arr.length) arr[arr.length - 1].valor = (cada + resto).toFixed(2)
    setPagamentos(arr)
  }
  function addPagamento() {
    const falta = Math.max(0, Math.round((totalSel - somaPag) * 100) / 100)
    setPagamentos(prev => [...prev, { forma: 'dinheiro', valor: falta > 0 ? falta.toFixed(2) : '' }])
  }
  function updatePagamento(i, campo, val) {
    setPagamentos(prev => prev.map((p, idx) => idx === i ? { ...p, [campo]: val } : p))
  }
  function removePagamento(i) {
    setPagamentos(prev => prev.filter((_, idx) => idx !== i))
  }

  function imprimirConta() {
    imprimirHtml(montarContaPresencialHtml({
      numeroMesa: mesaSel?.numero,
      itens: comandaSel?.comanda_itens ?? [],
      subtotal: subtotalSel, taxa: taxaSel, total: totalSel,
      formaPagamento: modoPag === 'unico' ? forma : 'Dividido',
      empresa: { nome: empresaNome },
    }), empresaNome)
  }

  async function confirmarFechamento() {
    if (!comandaSel) return
    let lista
    if (modoPag === 'unico') {
      lista = [{ forma, valor: Math.round(totalSel * 100) / 100 }]
    } else {
      lista = pagamentos
        .map(p => ({ forma: p.forma, valor: Math.round((Number(p.valor) || 0) * 100) / 100 }))
        .filter(p => p.valor > 0)
      const soma = lista.reduce((s, p) => s + p.valor, 0)
      if (lista.length === 0) { window.alert('Adicione ao menos um pagamento.'); return }
      if (Math.abs(soma - totalSel) > 0.05) {
        window.alert(`A soma (R$ ${soma.toFixed(2)}) não bate com o total (R$ ${totalSel.toFixed(2)}).`)
        return
      }
    }
    setSalvando(true)
    if (ehAdmin) {
      // ADM: fecha de vez (gera a venda e libera a mesa).
      const { error } = await supabase.rpc('fechar_conta_presencial', {
        p_comanda_id: comandaSel.id,
        p_pagamentos: lista,
        p_aplicar_taxa: aplicarTaxa,
      })
      setSalvando(false)
      if (error) { window.alert('Erro ao fechar a conta: ' + error.message); return }
    } else {
      // Garçom: NÃO libera a mesa. Marca "aguardando conferência" e guarda o
      // pagamento pra o ADM conferir e liberar depois.
      const { error } = await supabase.from('comandas').update({
        status: 'aguardando_conferencia',
        fechamento_pendente: { pagamentos: lista, aplicar_taxa: aplicarTaxa },
      }).eq('id', comandaSel.id)
      setSalvando(false)
      if (error) { window.alert('Erro ao enviar pro caixa: ' + error.message); return }
    }
    // Garçom pode estar no celular (sem impressora) — NÃO imprime aqui. Quem imprime a
    // conta é o GESTOR da loja, que detecta a mesa em "aguardando_conferencia" e manda
    // pra térmica/app FWC. Só o ADM (operador da loja, com impressora) imprime na hora.
    if (ehAdmin) { try { imprimirConta() } catch { /* best-effort */ } }
    setFechando(false)
    setMesaSel(null)
    await loadAll()
  }

  // ADM confere o pagamento e libera a mesa de vez (a partir do que o garçom fechou).
  async function confirmarLiberarAdm() {
    if (!comandaSel) return
    const pend = comandaSel.fechamento_pendente || {}
    const lista = Array.isArray(pend.pagamentos) && pend.pagamentos.length
      ? pend.pagamentos
      : [{ forma: 'dinheiro', valor: Math.round(totalSel * 100) / 100 }]
    const aplicar = pend.aplicar_taxa ?? true
    setSalvando(true)
    const { error } = await supabase.rpc('fechar_conta_presencial', {
      p_comanda_id: comandaSel.id,
      p_pagamentos: lista,
      p_aplicar_taxa: aplicar,
    })
    setSalvando(false)
    if (error) { window.alert('Erro ao liberar a mesa: ' + error.message); return }
    setMesaSel(null)
    await loadAll()
  }

  const produtosFiltrados = busca.trim()
    ? produtos.filter(p => p.nome?.toLowerCase().includes(busca.trim().toLowerCase())).slice(0, 30)
    : produtos.slice(0, 30)

  if (loading) return <div className="page"><p>Carregando salão...</p></div>

  const corStatus = (mesa) => {
    const c = comandaPorMesa[mesa.id]
    if (!c) return { bg: 'rgba(34,197,94,.12)', border: '#22c55e', label: 'Livre' }
    if (c.status === 'aguardando_conferencia') return { bg: 'rgba(59,130,246,.16)', border: '#3b82f6', label: 'Aguard. ADM' }
    return { bg: 'rgba(239,68,68,.12)', border: '#ef4444', label: 'Ocupada' }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Salão</h1>
          <p className="page-subtitle">Toque numa mesa para abrir/gerenciar a comanda.</p>
        </div>
      </div>

      {mesas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          Você ainda não cadastrou mesas. <Link to="/presencial/mesas" style={{ color: 'var(--primary)' }}>Cadastrar mesas →</Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 7 }}>
          {mesas.map(mesa => {
            const c = comandaPorMesa[mesa.id]
            const cor = corStatus(mesa)
            const sub = subtotalDe(c)
            const prontos = c ? prontosDe(c) : 0
            return (
              <div key={mesa.id} role="button" tabIndex={0} onClick={() => abrirMesa(mesa)}
                onKeyDown={ev => { if (ev.key === 'Enter') abrirMesa(mesa) }}
                style={{
                  borderRadius: 9, padding: '7px 8px', cursor: 'pointer', textAlign: 'left', position: 'relative',
                  border: `1.5px solid ${prontos > 0 ? '#22c55e' : cor.border}`,
                  background: prontos > 0 ? 'rgba(34,197,94,.14)' : cor.bg,
                  color: 'var(--text)',
                  boxShadow: prontos > 0 ? '0 0 0 2px rgba(34,197,94,.25)' : 'none',
                }}>
                {prontos > 0 && (
                  <span style={{
                    position: 'absolute', top: 4, right: 4, fontSize: 9, fontWeight: 800,
                    background: '#22c55e', color: '#fff', borderRadius: 999, padding: '1px 5px',
                  }}>🔔{prontos}</span>
                )}
                <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.1 }}>Mesa {mesa.numero}</div>
                <div style={{ fontSize: 9.5, marginTop: 2, color: cor.border, fontWeight: 700 }}>{cor.label}</div>
                {c && <div style={{ fontSize: 11.5, marginTop: 1, fontWeight: 800 }}>{fmt(sub)}</div>}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Drawer da comanda ── */}
      {mesaSel && comandaSel && (
        <div onClick={() => setMesaSel(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 900, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 'min(460px, 100%)', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)' }}>
            {/* header */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>Mesa {mesaSel.numero}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mesaSel.nome || `${mesaSel.capacidade} lugares`}</div>
                {comandaSel?.garcom_id && garcons[comandaSel.garcom_id] ? (
                  <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600, marginTop: 2 }}>
                    👤 Atendido por {garcons[comandaSel.garcom_id]}
                  </div>
                ) : comandaSel && !comandaSel.garcom_id ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginTop: 2 }}>
                    📱 Pedido pelo QR (autoatendimento)
                  </div>
                ) : null}
              </div>
              <button type="button" onClick={() => setMesaSel(null)} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
            </div>

            {/* corpo */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
              {/* itens lançados */}
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Comanda</div>
              {(comandaSel.comanda_itens ?? []).length === 0 ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum item ainda. Adicione abaixo.</p>
              ) : (
                (comandaSel.comanda_itens ?? [])
                  .slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                  .map(item => (
                    <div key={item.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 600 }}>{item.nome}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span>
                              {fmt(item.preco_unitario)} · {
                                item.status === 'pronto' ? '🔔 pronto'
                                : item.status === 'entregue'
                                  ? `🍽️ entregue${item.entregue_por && garcons[item.entregue_por] ? ' por ' + garcons[item.entregue_por].split(' ')[0] : ''}`
                                : '⏳ preparando'
                              }
                            </span>
                            {item.status === 'pronto' && (
                              <button type="button" onClick={() => entregarItem(item)}
                                style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                                  border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.15)', color: '#16a34a' }}>
                                Marcar entregue
                              </button>
                            )}
                          </div>
                        </div>
                        <button type="button" onClick={() => mudarQtd(item, -1)} style={qtdBtn}>−</button>
                        <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 700 }}>{item.quantidade}</span>
                        <button type="button" onClick={() => mudarQtd(item, +1)} style={qtdBtn}>+</button>
                        <span style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
                          {fmt(item.preco_unitario * item.quantidade)}
                        </span>
                      </div>
                      <input
                        value={obsEdit[item.id] !== undefined ? obsEdit[item.id] : (item.observacao ?? '')}
                        onChange={e => setObsEdit(prev => ({ ...prev, [item.id]: e.target.value }))}
                        onBlur={() => salvarObs(item)}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                        placeholder="📝 Observação (ex: sem cebola, sem gelo, ponto da carne...)"
                        style={{
                          width: '100%', marginTop: 6, padding: '6px 10px', fontSize: 12.5,
                          borderRadius: 8, border: '1px solid var(--border)',
                          background: 'var(--input-bg, var(--bg))', color: 'var(--text)',
                        }}
                      />
                    </div>
                  ))
              )}

              {/* A enviar (rascunho) — ainda não foi pra cozinha */}
              {rascunho.length > 0 && (
                <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: '1.5px dashed var(--primary)', background: 'rgba(124,58,237,.06)' }}>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8, color: 'var(--primary)' }}>
                    🧾 A enviar — ainda não foi pra cozinha
                  </div>
                  {rascunho.map(r => (
                    <div key={r.produto_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.nome}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmt(r.preco_venda)}</div>
                      </div>
                      <button type="button" onClick={() => mudarQtdRascunho(r.produto_id, -1)} style={qtdBtn}>−</button>
                      <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 700 }}>{r.quantidade}</span>
                      <button type="button" onClick={() => mudarQtdRascunho(r.produto_id, +1)} style={qtdBtn}>+</button>
                      <span style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>{fmt(r.preco_venda * r.quantidade)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* adicionar item */}
              <div style={{ fontSize: 13, fontWeight: 700, margin: '18px 0 8px' }}>Adicionar item</div>
              <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar produto..."
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', marginBottom: 8 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {produtosFiltrados.map(p => (
                  <button key={p.produto_id} type="button" onClick={() => addItem(p)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', textAlign: 'left' }}>
                    <span style={{ fontSize: 13.5 }}>{p.nome}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--primary)' }}>+ {fmt(p.preco_venda)}</span>
                  </button>
                ))}
                {produtosFiltrados.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum produto encontrado.</p>}
              </div>
            </div>

            {/* rodapé */}
            <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
              {comandaSel.status !== 'aguardando_conferencia' && rascunho.length > 0 && (
                <button type="button" onClick={enviarCozinha} disabled={enviando}
                  style={{ width: '100%', marginBottom: 12, padding: '12px 0', borderRadius: 10, border: 'none', cursor: enviando ? 'wait' : 'pointer',
                    background: '#16a34a', color: '#fff', fontWeight: 800, fontSize: 15, opacity: enviando ? 0.6 : 1 }}>
                  {enviando ? 'Enviando...' : `🍳 Enviar para a cozinha · ${rascunho.reduce((s, r) => s + r.quantidade, 0)} item(ns) · ${fmt(subtotalRascunho)}`}
                </button>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 4 }}>
                <span>Subtotal</span><strong>{fmt(subtotalSel)}</strong>
              </div>
              {comandaSel.status === 'aguardando_conferencia' ? (
                <div>
                  <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(59,130,246,.16)', color: '#2563eb', fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
                    🔵 Conta fechada pelo garçom — aguardando o ADM conferir o pagamento e liberar a mesa.
                  </div>
                  {ehAdmin ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={abrirFechamento}
                        style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                        Revisar
                      </button>
                      <button type="button" onClick={confirmarLiberarAdm} disabled={salvando}
                        className="btn btn-primary" style={{ flex: 1, marginTop: 0 }}>
                        {salvando ? 'Liberando...' : '✅ Confirmar e liberar mesa'}
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
                      Aguardando o administrador liberar a mesa.
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={cancelarMesa}
                    style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                    Cancelar
                  </button>
                  <button type="button" onClick={abrirFechamento} disabled={subtotalSel <= 0}
                    className="btn btn-primary" style={{ flex: 1, marginTop: 0, opacity: subtotalSel <= 0 ? 0.5 : 1 }}>
                    {ehAdmin ? 'Fechar conta' : 'Fechar conta'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de fechamento ── */}
      {fechando && comandaSel && (
        <div onClick={() => setFechando(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 380, background: 'var(--bg)', borderRadius: 16, border: '1px solid var(--border)', padding: 20 }}>
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 14 }}>Fechar conta — Mesa {mesaSel.numero}</div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
              <span>Subtotal</span><span>{fmt(subtotalSel)}</span>
            </div>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14, padding: '4px 0', cursor: 'pointer' }}>
              <span>
                <input type="checkbox" checked={aplicarTaxa} onChange={e => setAplicarTaxa(e.target.checked)} style={{ marginRight: 8 }} />
                Taxa de serviço ({taxaPct}%)
              </span>
              <span>{fmt(taxaSel)}</span>
            </label>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 800, padding: '10px 0', borderTop: '1px dashed var(--border)', marginTop: 6 }}>
              <span>Total</span><span style={{ color: 'var(--primary)' }}>{fmt(totalSel)}</span>
            </div>

            {/* Modo: pagamento único × dividir */}
            <div style={{ display: 'flex', gap: 8, margin: '14px 0 10px' }}>
              {[['unico', 'Pagamento único'], ['dividir', 'Dividir conta']].map(([id, label]) => (
                <button key={id} type="button"
                  onClick={() => { setModoPag(id); if (id === 'dividir' && pagamentos.length === 0) dividirIgual(comandaSel.num_pessoas > 1 ? comandaSel.num_pessoas : 2) }}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                    border: `1.5px solid ${modoPag === id ? 'var(--primary)' : 'var(--border)'}`,
                    background: modoPag === id ? 'rgba(134,59,255,.1)' : 'transparent', color: 'var(--text)' }}>
                  {label}
                </button>
              ))}
            </div>

            {modoPag === 'unico' ? (
              <div style={{ display: 'flex', gap: 8 }}>
                {FORMAS.map(f => (
                  <button key={f.id} type="button" onClick={() => setForma(f.id)}
                    style={{ flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                      border: `1.5px solid ${forma === f.id ? 'var(--primary)' : 'var(--border)'}`,
                      background: forma === f.id ? 'rgba(134,59,255,.1)' : 'transparent', color: 'var(--text)' }}>
                    {f.label}
                  </button>
                ))}
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Pagamentos</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    rachar:
                    {[2, 3, 4].map(n => (
                      <button key={n} type="button" onClick={() => dividirIgual(n)}
                        style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>
                        {n}x
                      </button>
                    ))}
                  </span>
                </div>

                {pagamentos.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                    <select value={p.forma} onChange={e => updatePagamento(i, 'forma', e.target.value)}
                      style={{ padding: '8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }}>
                      {FORMAS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                    <input type="number" step="0.01" min="0" inputMode="decimal" value={p.valor}
                      onChange={e => updatePagamento(i, 'valor', e.target.value)} placeholder="0,00"
                      style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }} />
                    <button type="button" onClick={() => removePagamento(i)}
                      style={{ width: 30, height: 34, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)', fontSize: 16 }}>×</button>
                  </div>
                ))}

                <button type="button" onClick={addPagamento}
                  style={{ width: '100%', padding: '8px 0', borderRadius: 8, marginTop: 2, cursor: 'pointer', border: '1.5px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 13 }}>
                  + Adicionar pagamento
                </button>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 14, fontWeight: 800,
                  color: Math.abs(restante) < 0.05 ? 'var(--success)' : 'var(--danger)' }}>
                  <span>{Math.abs(restante) < 0.05 ? '✓ Fecha certinho' : restante > 0 ? 'Falta receber' : 'Passou'}</span>
                  <span>{fmt(Math.abs(restante))}</span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
              <button type="button" onClick={() => setFechando(false)}
                style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                Voltar
              </button>
              <button type="button" onClick={imprimirConta} title="Imprimir conta"
                style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                🖨️ Conta
              </button>
              <button type="button" onClick={confirmarFechamento} disabled={salvando || !podeReceber}
                className="btn btn-primary" style={{ flex: 1, marginTop: 0, opacity: (salvando || !podeReceber) ? 0.5 : 1 }}>
                {salvando ? 'Fechando...' : (ehAdmin ? `Receber ${fmt(totalSel)}` : `Fechar e enviar pro caixa · ${fmt(totalSel)}`)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const qtdBtn = {
  width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
  fontSize: 16, lineHeight: 1, flexShrink: 0,
}
