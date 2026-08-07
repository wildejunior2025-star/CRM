import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import ModalComplementos, { btnQtd as btnQ } from '../components/ModalComplementos'
import { carregarCardapio, itensParaPedido } from '../lib/cardapioPublico'
import { comoFicaNoDia } from '../lib/feriados'

// LINK DO CLIENTE (mig 0147) — a página que o freguês abre pelo link só dele.
// Sem login: quem identifica é o token na URL. Três abas:
//   Cardápio     → monta o pedido; ao enviar vira uma comanda no nome dele
//   Meu pedido   → o que está na cozinha agora, ao vivo
//   Minha conta  → o que ele deve e o que já pagou (o fiado, sem precisar perguntar)
//
// Mesmo cardápio e mesmo modal de montagem do QR da mesa (lib/cardapioPublico e
// components/ModalComplementos) — se mudar o cardápio, muda nos dois.

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
const dataBR = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

export default function ClienteLink() {
  const { token } = useParams()
  const [info, setInfo] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [catOrdem, setCatOrdem] = useState({})
  const [compMap, setCompMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const [aba, setAba] = useState('cardapio')      // cardapio | pedido | conta
  const [busca, setBusca] = useState('')
  const [cat, setCat] = useState('Todos')
  const [carrinho, setCarrinho] = useState({})
  const [montando, setMontando] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [sucesso, setSucesso] = useState(false)
  const [conta, setConta] = useState(null)        // cliente_conta(): comanda + fiado
  const [notif, setNotif] = useState(null)
  const prevPronto = useRef(new Set())

  function avisar() {
    try { navigator.vibrate?.([200, 100, 200]) } catch { /* sem vibração */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 880
      g.gain.setValueAtTime(0.001, ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
      o.start(); o.stop(ctx.currentTime + 0.4)
    } catch { /* áudio bloqueado */ }
  }

  async function fetchConta() {
    const { data } = await supabase.rpc('cliente_conta', { p_token: token })
    setConta(data || null)
    const prontos = new Set((data?.comanda?.itens ?? []).filter(i => i.status === 'pronto').map(i => i.id))
    let novo = false
    prontos.forEach(id => { if (!prevPronto.current.has(id)) novo = true })
    prevPronto.current = prontos
    if (novo) { setNotif('🔔 Seu pedido ficou pronto!'); avisar() }
  }

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('cliente_info', { p_token: token })
      if (error || !data) { setErro('Link não encontrado. Peça um novo pra loja.'); setLoading(false); return }
      if (!data.link_ativo) { setErro('A loja não está usando pedido por link agora.'); setLoading(false); return }
      setInfo(data)
      const { produtos: ps, catOrdem: om, compMap: cm } = await carregarCardapio(supabase, data.empresa_id)
      setProdutos(ps); setCatOrdem(om); setCompMap(cm)
      setLoading(false)
    })()
  }, [token])

  // Acompanha a comanda ao vivo (e avisa quando a cozinha dá o pronto)
  useEffect(() => {
    if (!info) return
    fetchConta()
    const t = setInterval(fetchConta, 8000)
    return () => clearInterval(t)
  }, [info])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notif) return
    const t = setTimeout(() => setNotif(null), 8000)
    return () => clearTimeout(t)
  }, [notif])

  // Loja aberta? Quem manda é o banco (a RPC recusa fora do horário); aqui é só
  // pra avisar antes, e pra tratar o feriado, que é calculado no app.
  const situacao = useMemo(() => {
    if (!info) return { aberto: false }
    const hoje = new Date()
    const ymd = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`
    const noApp = comoFicaNoDia(ymd, { grade: info.grade, excecoes: {}, fechaFeriado: info.fecha_feriado })
    return { aberto: !!info.aberta_agora && noApp.aberto !== false, motivo: noApp.motivo }
  }, [info])

  const ordemCat = (nome) => catOrdem[nome] ?? 999
  const categorias = useMemo(() => {
    const nomes = [...new Set(produtos.map(p => p.categoria).filter(Boolean))]
      .sort((a, b) => (ordemCat(a) - ordemCat(b)) || a.localeCompare(b))
    return ['Todos', ...nomes]
  }, [produtos, catOrdem]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtrados = produtos
    .filter(p => {
      const okCat = cat === 'Todos' || p.categoria === cat
      const t = busca.trim().toLowerCase()
      return okCat && (!t || p.nome?.toLowerCase().includes(t))
    })
    .sort((a, b) => {
      const oa = ordemCat(a.categoria), ob = ordemCat(b.categoria)
      if (oa !== ob) return oa - ob
      const porCategoria = (a.categoria ?? '').localeCompare(b.categoria ?? '')
      return porCategoria !== 0 ? porCategoria : (a.nome ?? '').localeCompare(b.nome ?? '')
    })

  const itens = Object.entries(carrinho).map(([id, v]) => ({ id, ...v }))
  const totalItens = itens.reduce((s, i) => s + i.qtd, 0)
  const totalValor = itens.reduce((s, i) => s + i.qtd * i.preco, 0)

  function add(p) {
    if (compMap[p.produto_id]?.length) { setMontando(p); return }
    setCarrinho(c => ({ ...c, [p.produto_id]: {
      produto_id: p.produto_id, nome: p.nome, preco: Number(p.preco_venda),
      qtd: (c[p.produto_id]?.qtd ?? 0) + 1, complementos: [],
    } }))
  }
  function addComplemento(produto, complementos, precoUnit) {
    const key = `${produto.produto_id}::${complementos.map(c => c.nome).join(',')}`
    setCarrinho(c => ({ ...c, [key]: {
      produto_id: produto.produto_id, nome: produto.nome, preco: precoUnit,
      qtd: (c[key]?.qtd ?? 0) + 1, complementos,
    } }))
    setMontando(null)
  }
  function mudar(id, d) {
    setCarrinho(c => {
      const q = (c[id]?.qtd ?? 0) + d
      if (q <= 0) { const n = { ...c }; delete n[id]; return n }
      return { ...c, [id]: { ...c[id], qtd: q } }
    })
  }

  async function enviar() {
    setEnviando(true)
    const { data, error } = await supabase.rpc('cliente_pedir', { p_token: token, p_itens: itensParaPedido(itens) })
    setEnviando(false)
    if (error || !data?.ok) { window.alert('Não deu pra enviar: ' + (error?.message ?? 'erro')); return }
    setCarrinho({}); setDrawer(false); setSucesso(true)
    fetchConta()
  }

  const C = {
    page: { minHeight: '100dvh', background: '#0f0a1e', color: '#fff', paddingBottom: 90, fontFamily: 'system-ui, sans-serif' },
    header: { padding: '18px 16px', background: 'linear-gradient(135deg,#5b21b6,#7c3aed)', position: 'sticky', top: 0, zIndex: 5 },
    card: { background: '#1b1430', border: '1px solid #2c2350', borderRadius: 12, padding: 12, display: 'flex', alignItems: 'center', gap: 12 },
    bloco: { background: '#1b1430', border: '1px solid #2c2350', borderRadius: 12, padding: 14, marginBottom: 12 },
  }

  if (loading) return <div style={{ ...C.page, display: 'grid', placeItems: 'center' }}>Carregando…</div>
  if (erro) return (
    <div style={{ ...C.page, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div><div style={{ fontSize: 40 }}>🔗</div><p style={{ marginTop: 10 }}>{erro}</p></div>
    </div>
  )

  const comanda = conta?.comanda
  const devendo = Number(conta?.saldo_fiado ?? 0)
  const sLabel = s => s === 'pronto' ? '🔔 Pronto!' : s === 'entregue' ? '🍽️ Entregue' : '⏳ Preparando'
  const sCor = s => s === 'pronto' ? '#22c55e' : s === 'entregue' ? '#a78bfa' : '#f59e0b'

  return (
    <div style={C.page}>
      <header style={C.header}>
        <div style={{ fontSize: 13, opacity: .85 }}>{info.empresa_nome}</div>
        <div style={{ fontSize: 22, fontWeight: 800, textTransform: 'capitalize' }}>Olá, {info.cliente_nome} 👋</div>
        <div style={{ fontSize: 12, opacity: .85, marginTop: 2 }}>
          {situacao.aberto ? 'Faça seu pedido — vai direto pra cozinha 👨‍🍳' : 'A loja está fechada agora'}
        </div>
      </header>

      {notif && (
        <div onClick={() => { setNotif(null); setAba('pedido') }}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 30, background: '#22c55e', color: '#fff', padding: '14px 16px', textAlign: 'center', fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,.4)' }}>
          {notif} <span style={{ fontWeight: 600, opacity: .9 }}>· toque para ver</span>
        </div>
      )}

      {/* Abas */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px 0' }}>
        {[
          ['cardapio', '🍽️ Cardápio'],
          ['pedido', `📋 Meu pedido${comanda?.itens?.length ? ` (${comanda.itens.length})` : ''}`],
          ['conta', devendo > 0 ? `🧾 Devo ${fmt(devendo)}` : '🧾 Minha conta'],
        ].map(([id, lb]) => (
          <button key={id} onClick={() => setAba(id)}
            style={{ flex: 1, padding: '9px 6px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 800,
              border: '1px solid ' + (aba === id ? '#7c3aed' : '#2c2350'),
              background: aba === id ? '#7c3aed' : 'transparent', color: '#fff' }}>
            {lb}
          </button>
        ))}
      </div>

      {/* ── CARDÁPIO ── */}
      {aba === 'cardapio' && (
        <div style={{ padding: 14 }}>
          {!situacao.aberto && (
            <div style={{ ...C.bloco, borderColor: '#f59e0b', background: 'rgba(245,158,11,.12)' }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>🌙 A loja está fechada agora</div>
              <div style={{ fontSize: 13, opacity: .85 }}>
                {situacao.motivo ? `${situacao.motivo}. ` : ''}
                Dá pra olhar o cardápio, mas o pedido só pode ser enviado no horário de funcionamento.
                {Array.isArray(info.grade) && (
                  <div style={{ marginTop: 8, fontSize: 12.5 }}>
                    {info.grade.map((d, i) => d?.aberto && (d.periodos ?? []).length > 0 && (
                      <div key={i} style={{ opacity: .9 }}>
                        {DIAS[i]}: {d.periodos.map(p => `${p.i} às ${p.f}`).join(', ')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar item…"
            style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: '1px solid #2c2350', background: '#1b1430', color: '#fff', marginBottom: 12, boxSizing: 'border-box' }} />

          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 8 }}>
            {categorias.map(c => (
              <button key={c} onClick={() => setCat(c)}
                style={{ whiteSpace: 'nowrap', padding: '7px 14px', borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  border: '1px solid ' + (cat === c ? '#7c3aed' : '#2c2350'),
                  background: cat === c ? '#7c3aed' : 'transparent', color: '#fff' }}>
                {c}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtrados.map(p => {
              const qtd = carrinho[p.produto_id]?.qtd ?? 0
              return (
                <div key={p.produto_id} style={C.card}>
                  {p.foto_url
                    ? <img src={p.foto_url} alt="" style={{ width: 54, height: 54, borderRadius: 10, objectFit: 'cover' }} />
                    : <div style={{ width: 54, height: 54, borderRadius: 10, background: '#2c2350', display: 'grid', placeItems: 'center', fontSize: 22 }}>🍴</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{p.nome}</div>
                    <div style={{ color: '#a78bfa', fontWeight: 800, fontSize: 14 }}>
                      {fmt(p.preco_venda)}
                      {compMap[p.produto_id]?.length ? <span style={{ color: '#f0abfc', fontWeight: 700 }}> · monte</span> : null}
                    </div>
                  </div>
                  {compMap[p.produto_id]?.length ? (
                    <button onClick={() => setMontando(p)} style={{ ...btnQ, width: 'auto', padding: '0 16px', background: '#7c3aed', borderColor: '#7c3aed' }}>Escolher</button>
                  ) : qtd > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => mudar(p.produto_id, -1)} style={btnQ}>−</button>
                      <span style={{ fontWeight: 800, minWidth: 18, textAlign: 'center' }}>{qtd}</span>
                      <button onClick={() => mudar(p.produto_id, +1)} style={btnQ}>+</button>
                    </div>
                  ) : (
                    <button onClick={() => add(p)} style={{ ...btnQ, width: 'auto', padding: '0 16px', background: '#7c3aed', borderColor: '#7c3aed' }}>Adicionar</button>
                  )}
                </div>
              )
            })}
            {filtrados.length === 0 && <p style={{ opacity: .7, textAlign: 'center', marginTop: 20 }}>Nenhum item encontrado.</p>}
          </div>
        </div>
      )}

      {/* ── MEU PEDIDO (o que está na cozinha agora) ── */}
      {aba === 'pedido' && (
        <div style={{ padding: 14 }}>
          {!comanda || (comanda.itens ?? []).length === 0 ? (
            <div style={{ ...C.bloco, textAlign: 'center', opacity: .8 }}>
              <div style={{ fontSize: 34 }}>🍽️</div>
              <p style={{ marginTop: 8 }}>Você não tem nenhum pedido em andamento.</p>
              <button onClick={() => setAba('cardapio')}
                style={{ marginTop: 8, padding: '10px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800 }}>
                Ver o cardápio
              </button>
            </div>
          ) : (
            <div style={C.bloco}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>Comanda {String(comanda.numero ?? '').padStart(2, '0')}</div>
              <div style={{ fontSize: 12, opacity: .7, marginBottom: 10 }}>
                {comanda.status === 'aguardando_conferencia' ? 'Conta fechada — aguardando a loja liberar' : 'Em andamento'}
              </div>
              {(comanda.itens ?? []).map(it => (
                <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid #2c2350' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>{it.quantidade}× {it.nome}</div>
                    {it.observacao && <div style={{ fontSize: 12, opacity: .7 }}>📝 {it.observacao}</div>}
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: sCor(it.status), marginTop: 2 }}>{sLabel(it.status)}</div>
                  </div>
                  <span style={{ fontWeight: 700 }}>{fmt(it.preco * it.quantidade)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 18, fontWeight: 800 }}>
                <span>Total</span><span style={{ color: '#a78bfa' }}>{fmt(comanda.subtotal)}</span>
              </div>
              <p style={{ fontSize: 12, opacity: .7, marginTop: 10 }}>💳 O pagamento é feito com a equipe da loja.</p>
            </div>
          )}
        </div>
      )}

      {/* ── MINHA CONTA (fiado) ── */}
      {aba === 'conta' && (
        <div style={{ padding: 14 }}>
          <div style={{ ...C.bloco, textAlign: 'center', borderColor: devendo > 0 ? '#d97706' : '#22c55e',
            background: devendo > 0 ? 'rgba(217,119,6,.12)' : 'rgba(34,197,94,.10)' }}>
            <div style={{ fontSize: 13, opacity: .85 }}>{devendo > 0 ? 'Você está devendo' : 'Sua conta está'}</div>
            <div style={{ fontSize: 30, fontWeight: 800, marginTop: 2, color: devendo > 0 ? '#fbbf24' : '#22c55e' }}>
              {devendo > 0 ? fmt(devendo) : 'em dia ✓'}
            </div>
            {devendo > 0 && <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>Pague na loja quando puder 🙂</div>}
          </div>

          <div style={C.bloco}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>🧾 O que ficou fiado</div>
            {(conta?.fiados ?? []).length === 0 ? (
              <p style={{ fontSize: 13, opacity: .7, margin: 0 }}>Nada anotado.</p>
            ) : (conta.fiados).map((f, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #2c2350', fontSize: 13.5 }}>
                <span style={{ opacity: .8 }}>{dataBR(f.data)}</span>
                <span style={{ fontWeight: 700 }}>{fmt(f.valor)}</span>
              </div>
            ))}
          </div>

          <div style={C.bloco}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>✅ O que você já pagou</div>
            {(conta?.pagamentos ?? []).length === 0 ? (
              <p style={{ fontSize: 13, opacity: .7, margin: 0 }}>Nenhum pagamento registrado ainda.</p>
            ) : (conta.pagamentos).map((p, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #2c2350', fontSize: 13.5 }}>
                <span style={{ opacity: .8 }}>{dataBR(p.data)} · {p.forma}</span>
                <span style={{ fontWeight: 700, color: '#22c55e' }}>{fmt(p.valor)}</span>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 11.5, opacity: .6, textAlign: 'center' }}>
            Alguma coisa errada? Fale com a loja — quem lança é a equipe.
          </p>
        </div>
      )}

      {/* Barra do carrinho */}
      {aba === 'cardapio' && totalItens > 0 && (
        <button onClick={() => setDrawer(true)}
          style={{ position: 'fixed', left: 12, right: 12, bottom: 12, height: 56, borderRadius: 14, border: 'none', cursor: 'pointer',
            background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', zIndex: 6 }}>
          <span>{totalItens} {totalItens === 1 ? 'item' : 'itens'}</span>
          <span>Ver pedido · {fmt(totalValor)}</span>
        </button>
      )}

      {/* Drawer do pedido */}
      {drawer && (
        <div onClick={() => setDrawer(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 10, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#15102a', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, maxHeight: '80dvh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontSize: 17 }}>Seu pedido</strong>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, cursor: 'pointer' }}>×</button>
            </div>
            {itens.map(i => (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #2c2350' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>{i.nome}</div>
                  {(i.complementos ?? []).map((c, j) => (
                    <div key={j} style={{ fontSize: 11.5, color: '#8b7bb8' }}>{Number(c.qtd ?? 1)}× {c.nome}</div>
                  ))}
                  <div style={{ fontSize: 12, color: '#a78bfa' }}>{fmt(i.preco)}</div>
                </div>
                <button onClick={() => mudar(i.id, -1)} style={btnQ}>−</button>
                <span style={{ fontWeight: 800, minWidth: 18, textAlign: 'center' }}>{i.qtd}</span>
                <button onClick={() => mudar(i.id, +1)} style={btnQ}>+</button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', margin: '14px 0', fontSize: 16, fontWeight: 800 }}>
              <span>Total</span><span style={{ color: '#a78bfa' }}>{fmt(totalValor)}</span>
            </div>
            <p style={{ fontSize: 12, opacity: .7, marginBottom: 12 }}>💳 O pagamento é feito com a equipe da loja.</p>
            <button onClick={enviar} disabled={enviando || !situacao.aberto}
              style={{ width: '100%', height: 52, borderRadius: 14, border: 'none',
                cursor: (enviando || !situacao.aberto) ? 'not-allowed' : 'pointer',
                background: situacao.aberto ? '#22c55e' : '#374151', color: '#fff', fontWeight: 800, fontSize: 16 }}>
              {!situacao.aberto ? '🌙 A loja está fechada' : enviando ? 'Enviando…' : 'Enviar pedido'}
            </button>
          </div>
        </div>
      )}

      {montando && compMap[montando.produto_id] && (
        <ModalComplementos
          produto={montando}
          grupos={compMap[montando.produto_id]}
          semObrigatorios={!!info?.sem_obrigatorios}
          onClose={() => setMontando(null)}
          onConfirm={addComplemento}
        />
      )}

      {sucesso && (
        <div onClick={() => setSucesso(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 20, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#15102a', borderRadius: 18, padding: 28, maxWidth: 340, color: '#fff' }}>
            <div style={{ fontSize: 48 }}>🎉</div>
            <h2 style={{ margin: '10px 0 6px' }}>Pedido enviado!</h2>
            <p style={{ opacity: .8, fontSize: 14 }}>Já foi pra cozinha, no seu nome. Acompanhe em "Meu pedido".</p>
            <button onClick={() => { setSucesso(false); setAba('pedido') }}
              style={{ marginTop: 18, width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800 }}>
              Acompanhar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
