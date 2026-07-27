import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { adicionalComplementos, blocosDeOpcoes } from '../lib/complementos'
import { criarBuscadorDescricao, comDescricaoNasOpcoes } from '../lib/descricaoSabor'

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

export default function MesaCardapio() {
  const { token } = useParams()
  const [info, setInfo]       = useState(null)
  const [produtos, setProdutos] = useState([])
  const [catOrdem, setCatOrdem] = useState({}) // { nomeCategoria: ordem } — ordem do cardápio
  const [loading, setLoading] = useState(true)
  const [erro, setErro]       = useState(null)
  const [busca, setBusca]     = useState('')
  const [cat, setCat]         = useState('Todos')
  const [carrinho, setCarrinho] = useState({}) // { key: { produto_id, nome, preco, qtd, complementos } }
  const [compMap, setCompMap]   = useState({}) // { produto_id: grupos[] } — "monte sua quentinha"
  const [montando, setMontando] = useState(null) // produto sendo montado (complementos)
  const [drawer, setDrawer]   = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [sucesso, setSucesso] = useState(false)
  const [comanda, setComanda] = useState(null)   // o que já foi pedido (status ao vivo)
  const [acompanhar, setAcompanhar] = useState(false)
  const [notif, setNotif]     = useState(null)
  const prevPronto = useRef(new Set())

  function avisar() {
    try { navigator.vibrate?.([200, 100, 200]) } catch { /* sem vibração */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain()
        o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 880
        g.gain.setValueAtTime(0.001, ctx.currentTime)
        g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02)
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
        o.start(); o.stop(ctx.currentTime + 0.4)
      }
    } catch { /* áudio bloqueado */ }
  }

  async function fetchComanda() {
    const { data } = await supabase.rpc('mesa_comanda', { p_token: token })
    setComanda(data || null)
    const prontoIds = new Set((data?.itens ?? []).filter(i => i.status === 'pronto').map(i => i.id))
    let novo = false
    prontoIds.forEach(id => { if (!prevPronto.current.has(id)) novo = true })
    prevPronto.current = prontoIds
    if (novo) { setNotif('🔔 Seu pedido ficou pronto!'); avisar() }
  }

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('mesa_info', { p_token: token })
      if (error || !data) { setErro('Mesa não encontrada.'); setLoading(false); return }
      if (!data.ativa) { setErro('Esta mesa está indisponível.'); setLoading(false); return }
      if (!data.presencial_ativo) { setErro('O pedido pela mesa não está disponível agora.'); setLoading(false); return }
      setInfo(data)
      const { data: ps } = await supabase
        .from('estoque_catalogo')
        .select('produto_id, nome, preco_venda, categoria, foto_url')
        .eq('empresa_id', data.empresa_id)
        .order('categoria').order('nome').limit(500)
      // Ordem personalizada das categorias (mesma da loja online)
      const { data: cats } = await supabase
        .from('categorias')
        .select('nome, ordem')
        .eq('empresa_id', data.empresa_id)
      const ordemMap = {}
      for (const c of (cats ?? [])) ordemMap[c.nome] = c.ordem ?? 999
      setCatOrdem(ordemMap)
      // Complementos por produto ("monte sua quentinha")
      const ids = (ps ?? []).map(p => p.produto_id)
      const cm = {}
      if (ids.length) {
        // Sabor de pizza também é produto: usa a descrição dele pra mostrar o que vai na pizza.
        const { data: descData } = await supabase.from('produtos')
          .select('nome, categoria, descricao')
          .eq('empresa_id', data.empresa_id)
          .eq('ativo', true)
        const descricaoDaOpcao = criarBuscadorDescricao(descData)
        const { data: vinc } = await supabase
          .from('produto_complemento_grupos')
          .select('produto_id, ordem, min_override, max_override, complemento_grupos(id, nome, min, max, disponivel, regra_preco, complemento_opcoes(id, nome, descricao, preco_adicional, ordem, disponivel))')
          .in('produto_id', ids)
          .order('ordem')
        const soSemOpcao = nome => /^\s*sem\s|n[ãa]o\s*quero/i.test(String(nome || ''))
        for (const v of (vinc ?? [])) {
          const g = v.complemento_grupos
          if (!g || g.disponivel === false) continue // grupo pausado some do cardápio da mesa
          const opcoes = comDescricaoNasOpcoes(
            (g.complemento_opcoes ?? [])
              .filter(o => o.disponivel !== false)
              .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)),
            descricaoDaOpcao,
          )
          // Some se não tiver opção nenhuma OU só tiver "Sem/Não Quero" (nada real).
          if (!opcoes.some(o => !soSemOpcao(o.nome))) continue
          ;(cm[v.produto_id] ??= []).push({
            id: g.id, nome: g.nome, min: v.min_override ?? g.min ?? 0, max: v.max_override ?? g.max ?? 1,
            regra_preco: g.regra_preco ?? 'somar', opcoes,
          })
        }
      }
      setCompMap(cm)
      setProdutos(ps ?? [])
      setLoading(false)
    })()
  }, [token])

  // Acompanha a comanda ao vivo (e avisa quando a cozinha dá o pronto)
  useEffect(() => {
    if (!info) return
    fetchComanda()
    const t = setInterval(fetchComanda, 8000)
    return () => clearInterval(t)
  }, [info])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notif) return
    const t = setTimeout(() => setNotif(null), 8000)
    return () => clearTimeout(t)
  }, [notif])

  const ordemCat = (nome) => catOrdem[nome] ?? 999
  const categorias = useMemo(() => {
    const nomes = [...new Set(produtos.map(p => p.categoria).filter(Boolean))]
      .sort((a, b) => {
        const oa = ordemCat(a), ob = ordemCat(b)
        return oa !== ob ? oa - ob : a.localeCompare(b)
      })
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
      return oa !== ob ? oa - ob : (a.nome ?? '').localeCompare(b.nome ?? '')
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
    const payload = itens.map(i => {
      const comps = i.complementos ?? []
      const nome = comps.length ? `${i.nome} (${comps.map(c => c.nome).join(', ')})` : i.nome
      return { produto_id: i.produto_id ?? i.id, nome, preco: i.preco, qtd: i.qtd }
    })
    const { data, error } = await supabase.rpc('mesa_pedir', { p_token: token, p_itens: payload })
    setEnviando(false)
    if (error || !data?.ok) { alert('Não deu pra enviar: ' + (error?.message ?? 'erro')); return }
    setCarrinho({}); setDrawer(false); setSucesso(true)
    fetchComanda()
  }

  const C = {
    page: { minHeight: '100dvh', background: '#0f0a1e', color: '#fff', paddingBottom: 90, fontFamily: 'system-ui, sans-serif' },
    header: { padding: '18px 16px', background: 'linear-gradient(135deg,#5b21b6,#7c3aed)', position: 'sticky', top: 0, zIndex: 5 },
    card: { background: '#1b1430', border: '1px solid #2c2350', borderRadius: 12, padding: 12, display: 'flex', alignItems: 'center', gap: 12 },
  }

  if (loading) return <div style={{ ...C.page, display: 'grid', placeItems: 'center' }}>Carregando…</div>
  if (erro) return (
    <div style={{ ...C.page, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div>
        <div style={{ fontSize: 40 }}>🍽️</div>
        <p style={{ marginTop: 10 }}>{erro}</p>
      </div>
    </div>
  )

  return (
    <div style={C.page}>
      <header style={C.header}>
        <div style={{ fontSize: 13, opacity: .85 }}>{info.empresa_nome}</div>
        <div style={{ fontSize: 22, fontWeight: 800 }}>Mesa {info.numero}{info.nome ? ` · ${info.nome}` : ''}</div>
        <div style={{ fontSize: 12, opacity: .85, marginTop: 2 }}>Faça seu pedido — vai direto pra cozinha 👨‍🍳</div>
      </header>

      {/* Aviso de pronto */}
      {notif && (
        <div onClick={() => { setNotif(null); setAcompanhar(true) }}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 30, background: '#22c55e', color: '#fff', padding: '14px 16px', textAlign: 'center', fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,.4)' }}>
          {notif} <span style={{ fontWeight: 600, opacity: .9 }}>· toque para ver</span>
        </div>
      )}

      {/* Acessar "Meu pedido" */}
      {comanda && (comanda.itens?.length > 0) && (
        <button onClick={() => setAcompanhar(true)}
          style={{ width: 'calc(100% - 28px)', margin: '12px 14px 0', padding: '12px 14px', borderRadius: 12, border: '1px solid #2c2350', background: '#1b1430', color: '#fff', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700 }}>
          <span>📋 Meu pedido ({comanda.itens.length})</span>
          <span style={{ color: '#a78bfa' }}>{fmt(comanda.subtotal)} ›</span>
        </button>
      )}

      <div style={{ padding: 14 }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar item…"
          style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: '1px solid #2c2350', background: '#1b1430', color: '#fff', marginBottom: 12 }} />

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
                <div style={{ flex: 1 }}>
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

      {/* Barra do carrinho */}
      {totalItens > 0 && (
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
                <div style={{ flex: 1 }}>
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
            <p style={{ fontSize: 12, opacity: .7, marginBottom: 12 }}>💳 O pagamento é feito no fim, com a equipe.</p>
            <button onClick={enviar} disabled={enviando}
              style={{ width: '100%', height: 52, borderRadius: 14, border: 'none', cursor: 'pointer', background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: 16 }}>
              {enviando ? 'Enviando…' : 'Enviar pedido para a cozinha'}
            </button>
          </div>
        </div>
      )}

      {/* Modal "monte" (complementos) */}
      {montando && compMap[montando.produto_id] && (
        <ModalCompMesa
          produto={montando}
          grupos={compMap[montando.produto_id]}
          semObrigatorios={!!info?.sem_obrigatorios}
          onClose={() => setMontando(null)}
          onConfirm={addComplemento}
        />
      )}

      {/* Acompanhar pedido */}
      {acompanhar && (() => {
        const lista = comanda?.itens ?? []
        const sub = Number(comanda?.subtotal ?? 0)
        const taxaPct = Number(comanda?.taxa_pct ?? 0)
        const taxa = Math.round(sub * taxaPct / 100 * 100) / 100
        const totalEst = sub + taxa
        const sLabel = s => s === 'pronto' ? '🔔 Pronto!' : s === 'entregue' ? '🍽️ Entregue' : '⏳ Preparando'
        const sCor = s => s === 'pronto' ? '#22c55e' : s === 'entregue' ? '#a78bfa' : '#f59e0b'
        return (
          <div onClick={() => setAcompanhar(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 15, display: 'flex', alignItems: 'flex-end' }}>
            <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#15102a', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, maxHeight: '85dvh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 17 }}>Meu pedido</strong>
                <button onClick={() => setAcompanhar(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, cursor: 'pointer' }}>×</button>
              </div>
              {lista.length === 0 ? (
                <p style={{ opacity: .7 }}>Você ainda não pediu nada.</p>
              ) : (
                <>
                  {lista.map(it => (
                    <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid #2c2350' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14 }}>{it.quantidade}× {it.nome}</div>
                        {it.observacao && <div style={{ fontSize: 12, opacity: .7 }}>📝 {it.observacao}</div>}
                        <div style={{ fontSize: 12.5, fontWeight: 800, color: sCor(it.status), marginTop: 2 }}>{sLabel(it.status)}</div>
                      </div>
                      <span style={{ fontWeight: 700 }}>{fmt(it.preco * it.quantidade)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 14 }}><span>Subtotal</span><span>{fmt(sub)}</span></div>
                  {taxaPct > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, opacity: .8 }}><span>Taxa de serviço ({taxaPct}%)</span><span>{fmt(taxa)}</span></div>}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 18, fontWeight: 800 }}>
                    <span>{taxaPct > 0 ? 'Total estimado' : 'Total'}</span><span style={{ color: '#a78bfa' }}>{fmt(totalEst)}</span>
                  </div>
                  <p style={{ fontSize: 12, opacity: .7, marginTop: 10 }}>💳 O pagamento é feito no fim, com a equipe.</p>
                </>
              )}
              <button onClick={() => setAcompanhar(false)} style={{ marginTop: 14, width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800 }}>
                Pedir mais
              </button>
            </div>
          </div>
        )
      })()}

      {/* Sucesso */}
      {sucesso && (
        <div onClick={() => setSucesso(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 20, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#15102a', borderRadius: 18, padding: 28, maxWidth: 340 }}>
            <div style={{ fontSize: 48 }}>🎉</div>
            <h2 style={{ margin: '10px 0 6px' }}>Pedido enviado!</h2>
            <p style={{ opacity: .8, fontSize: 14 }}>Já foi pra cozinha. Pode pedir mais quando quiser — é só adicionar e enviar de novo.</p>
            <button onClick={() => setSucesso(false)}
              style={{ marginTop: 18, width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800 }}>
              Continuar pedindo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const btnQ = {
  width: 34, height: 34, borderRadius: 9, cursor: 'pointer', flexShrink: 0,
  border: '1px solid #7c3aed', background: 'transparent', color: '#fff', fontSize: 18, fontWeight: 700,
}

// Modal "monte sua quentinha" — escolhe complementos por grupo (min/max)
function ModalCompMesa({ produto, grupos, semObrigatorios, onClose, onConfirm }) {
  const [sel, setSel] = useState({}) // { grupoId: [opcaoId] }
  const base = Number(produto.preco_venda)

  function toggle(g, o) {
    setSel(prev => {
      const atual = prev[g.id] ?? []
      const tem = atual.includes(o.id)
      let novo
      if (g.max === 1) novo = tem ? [] : [o.id]
      else if (tem) novo = atual.filter(x => x !== o.id)
      else if (atual.length >= g.max) novo = atual // trava no máximo
      else novo = [...atual, o.id]
      return { ...prev, [g.id]: novo }
    })
  }

  const selecionados = grupos.flatMap(g => (sel[g.id] ?? []).map(oid => {
    const o = g.opcoes.find(x => x.id === oid)
    return { grupoId: g.id, nome: o.nome, preco_adicional: Number(o.preco_adicional || 0) }
  }))
  const precoUnit = base + adicionalComplementos(
    grupos,
    selecionados.map(c => ({ grupoId: c.grupoId, preco: c.preco_adicional })),
  )
  // A loja pode liberar os obrigatórios no presencial (botão no Salão, mig 0121):
  // aqui na mesa o atendimento é na hora, então o mínimo deixa de travar.
  const faltando = semObrigatorios
    ? []
    : grupos.filter(g => (g.min ?? 0) > 0 && (sel[g.id]?.length ?? 0) < g.min)
  const pode = faltando.length === 0

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 25, display: 'flex', alignItems: 'flex-end' }}>
      {/* Só a lista rola: com 9 grupos, o botão de adicionar ficava lá no fim e
          o cliente tinha que descer tudo pra confirmar. */}
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#15102a', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '85dvh', display: 'flex', flexDirection: 'column', color: '#fff' }}>
        <div style={{ padding: '18px 18px 12px', borderBottom: '1px solid #2c2350', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
            <strong style={{ fontSize: 17 }}>{produto.nome}</strong>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, cursor: 'pointer' }}>×</button>
          </div>
          <p style={{ fontSize: 12.5, opacity: .7, margin: 0 }}>Monte do seu jeito 👇</p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 4px' }}>
        {grupos.map(g => {
          const conta = sel[g.id]?.length ?? 0
          const falta = !semObrigatorios && (g.min ?? 0) > 0 && conta < g.min
          return (
            <div key={g.id} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ fontSize: 14 }}>{g.nome}</strong>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: falta ? '#7f1d1d' : '#2c2350', color: falta ? '#fecaca' : '#a78bfa' }}>
                  {g.max === 1 ? 'escolha 1' : `até ${g.max}`}{g.min > 0 && !semObrigatorios ? ' · obrigatório' : ''}
                </span>
              </div>
              {blocosDeOpcoes(g.opcoes).map(bloco => (
              <div key={bloco.titulo ?? 'unico'} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: bloco.titulo ? 10 : 0 }}>
                {bloco.titulo && (
                  <p style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .4, color: '#a89ec9', margin: '4px 0 0' }}>
                    {bloco.titulo}
                  </p>
                )}
                {bloco.opcoes.map(o => {
                  const marcado = (sel[g.id] ?? []).includes(o.id)
                  return (
                    <button key={o.id} onClick={() => toggle(g, o)} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                      border: '1px solid ' + (marcado ? '#7c3aed' : '#2c2350'),
                      background: marcado ? 'rgba(124,58,237,.18)' : 'transparent', color: '#fff', fontSize: 14,
                    }}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block' }}>{marcado ? '✓ ' : ''}{o.nomeCurto ?? o.nome}</span>
                        {o.descricao && (
                          <span style={{ display: 'block', fontSize: 12, lineHeight: 1.35, color: '#a89ec9', marginTop: 2 }}>{o.descricao}</span>
                        )}
                      </span>
                      {Number(o.preco_adicional) > 0 && <span style={{ color: '#a78bfa', fontSize: 13, flexShrink: 0 }}>+{fmt(o.preco_adicional)}</span>}
                    </button>
                  )
                })}
              </div>
              ))}
            </div>
          )
        })}
        </div>

        <div style={{
          flexShrink: 0, padding: '12px 18px calc(12px + env(safe-area-inset-bottom, 0px))',
          borderTop: '1px solid #2c2350', background: '#15102a',
        }}>
          <button onClick={() => pode && onConfirm(produto, selecionados, precoUnit)} disabled={!pode}
            style={{ width: '100%', height: 52, borderRadius: 14, border: 'none', cursor: pode ? 'pointer' : 'not-allowed',
              background: pode ? '#22c55e' : '#374151', color: '#fff', fontWeight: 800, fontSize: 15 }}>
            {pode ? `Adicionar · ${fmt(precoUnit)}` : `Escolha: ${faltando.map(g => g.nome).join(', ')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
