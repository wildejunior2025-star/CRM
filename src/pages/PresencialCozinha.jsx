import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { imprimirHtml, montarComandaCozinhaHtml } from '../utils/imprimirCupom'
import { separarItem } from '../lib/itensPedido'
import '../components/Page.css'

function tempoDesde(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora'
  if (min === 1) return '1 min'
  return `${min} min`
}
function horaBR(iso) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Botão/estado de "Aceitar → Preparando → Pronto" (G1). Reusado por pedido e item.
function AcaoPreparo({ registro, meuId, onAceitar, onSoltar, onPronto, size = 'md' }) {
  const prep = registro.preparando_por
  const mine = prep && prep === meuId
  const pad = size === 'sm' ? '8px 12px' : '10px 12px'
  const fs = size === 'sm' ? 12.5 : 13
  if (!prep) {
    return (
      <button type="button" onClick={() => onAceitar(registro)}
        style={{ padding: pad, borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: fs,
          border: '1.5px solid #2563eb', background: 'rgba(37,99,235,.12)', color: '#2563eb', width: '100%' }}>
        ✋ Aceitar
      </button>
    )
  }
  if (mine) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#16a34a' }}>👨‍🍳 Você está preparando</div>
        <button type="button" onClick={() => onPronto(registro)}
          style={{ padding: pad, borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: fs,
            border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.12)', color: '#16a34a' }}>
          ✓ Pronto
        </button>
        <button type="button" onClick={() => onSoltar(registro)}
          style={{ padding: '4px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 11.5,
            border: 'none', background: 'none', color: 'var(--text-muted)' }}>
          Soltar
        </button>
      </div>
    )
  }
  return (
    <div style={{ padding: pad, borderRadius: 8, textAlign: 'center', fontWeight: 700, fontSize: fs,
      background: 'rgba(245,158,11,.12)', border: '1.5px solid #f59e0b', color: '#b45309' }}>
      🔒 {registro.preparando_nome || 'Outro'} está preparando
    </div>
  )
}

// Linha da checklist da cozinha: quadradinho grande pra ir marcando o que já colocou na quentinha.
function ChkLinha({ chave, texto, principal, marcados, onToggle }) {
  const marcado = marcados.has(chave)
  return (
    <div onClick={() => onToggle(chave)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none',
        padding: principal ? '3px 0' : '3px 0 3px 14px' }}>
      <span style={{
        width: 26, height: 26, borderRadius: 6, flexShrink: 0,
        border: `2px solid ${marcado ? '#16a34a' : 'var(--border, #999)'}`,
        background: marcado ? '#16a34a' : 'transparent', color: '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 900,
      }}>{marcado ? '✓' : ''}</span>
      <span style={{
        fontWeight: principal ? 700 : 500, fontSize: principal ? 14.5 : 13.5,
        color: marcado ? 'var(--text-muted)' : 'var(--text)',
        textDecoration: marcado ? 'line-through' : 'none',
      }}>{texto}</span>
    </div>
  )
}

// Card de um pedido de delivery/iFood na cozinha (KDS).
function CardEntregaKDS({ pedido, meuId, onAceitar, onSoltar, onPronto, historico }) {
  const ehIfood = pedido.origem === 'ifood'
  const headerCor = historico ? '#16a34a' : (ehIfood ? '#ea1d2c' : '#7c3aed')
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const isRetirada = (pedido.tipo_entrega || 'entrega') === 'retirada'
  const numero = pedido.numero_pedido ?? String(pedido.id).slice(-4).toUpperCase()
  // Checklist de preparo: só aparece pra quem ACEITOU o pedido (está preparando).
  const preparandoComigo = !!pedido.preparando_por && pedido.preparando_por === meuId
  const checklist = preparandoComigo && !historico
  const [marcados, setMarcados] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('kds_chk_' + pedido.id) || '[]')) } catch { return new Set() }
  })
  const toggleMarca = (k) => setMarcados(prev => {
    const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k)
    try { localStorage.setItem('kds_chk_' + pedido.id, JSON.stringify([...n])) } catch {}
    return n
  })
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ background: headerCor, color: '#fff', padding: '10px 14px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          {ehIfood ? (
            <>
              <span>iFood #{pedido.ifood_display_id ?? numero}</span>
              <span style={{ fontSize: 11, fontWeight: 600, opacity: .8 }}>#{numero}</span>
            </>
          ) : (
            <span>#{numero}</span>
          )}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,.2)', borderRadius: 20, padding: '2px 8px' }}>
          {isRetirada ? '🥡 Retirada' : '🛵 Entrega'}
        </span>
      </div>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pedido.cliente_nome && (
          <div style={{ fontWeight: 800, fontSize: 14.5, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 6 }}>
            👤 {pedido.cliente_nome}
          </div>
        )}
        {checklist && (
          <div style={{ fontSize: 11.5, fontWeight: 700, color: '#16a34a' }}>👇 Marque o que já colocou</div>
        )}
        {itens.map((item, i) => {
          const { nome, complementos: comps } = separarItem(item)
          const qtd = item.quantidade ?? item.qtd ?? 1
          return (
            <div key={i}>
              {checklist
                ? <ChkLinha chave={`i${i}`} principal texto={`${qtd}× ${nome}`} marcados={marcados} onToggle={toggleMarca} />
                : <div style={{ fontWeight: 700, fontSize: 14 }}>{qtd}× {nome}</div>}
              {comps.map((c, j) => {
                const txt = `${Number(c?.qtd ?? 1)}× ${c?.nome ?? c}`
                return checklist
                  ? <ChkLinha key={j} chave={`c${i}_${j}`} texto={txt} marcados={marcados} onToggle={toggleMarca} />
                  : <div key={j} style={{ fontSize: 12.5, color: 'var(--text-muted)', paddingLeft: 14 }}>{txt}</div>
              })}
              {item.observacao && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', paddingLeft: 14, fontStyle: 'italic' }}>obs: {item.observacao}</div>
              )}
            </div>
          )
        })}
        {historico ? (
          <div style={{ fontSize: 12.5, fontWeight: 800, color: '#16a34a' }}>✓ Pronto às {horaBR(pedido.updated_at || pedido.created_at)}</div>
        ) : (
          <>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>há {tempoDesde(pedido.created_at)}</div>
            <AcaoPreparo registro={pedido} meuId={meuId} onAceitar={onAceitar} onSoltar={onSoltar}
              onPronto={(reg) => { try { localStorage.removeItem('kds_chk_' + pedido.id) } catch {}; onPronto(reg) }} />
          </>
        )}
      </div>
    </div>
  )
}

export default function PresencialCozinha() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  const meuId = profile?.id
  const meuNome = profile?.nome || 'Cozinha'
  const [itens, setItens]       = useState([]) // itens de mesa (pendente + pronto de hoje)
  const [entregas, setEntregas] = useState([]) // pedidos delivery/iFood (em preparo + pronto de hoje)
  const [aba, setAba]           = useState('afazer') // 'afazer' | 'preparando' | 'historico'
  const [busca, setBusca]       = useState('') // filtra por nº/código/cliente/mesa
  const [loading, setLoading]   = useState(true)
  const [, setTick]             = useState(0)
  const loadGenRef              = useRef(0) // descarta reload atrasado que reverteria um "aceitar" recém-feito

  async function load() {
    if (!empresaId) return
    const gen = ++loadGenRef.current
    const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0)
    const hojeISO = inicioHoje.toISOString()
    const [mesasRes, entregasRes] = await Promise.all([
      supabase
        .from('comanda_itens')
        .select('*, comandas!inner(numero_mesa, status)')
        .eq('empresa_id', empresaId)
        .eq('comandas.status', 'aberta')
        .in('status', ['pendente', 'pronto'])
        .gte('created_at', hojeISO)
        .order('created_at'),
      supabase
        .from('pedidos_delivery')
        .select('*')
        .eq('empresa_id', empresaId)
        .in('status', ['confirmado', 'em_preparo', 'pronto'])
        .gte('created_at', hojeISO)
        .order('created_at'),
    ])
    // Descarta este reload se um mais novo já começou — evita que uma leitura
    // atrasada reverta um "aceitar" recém-feito (o pedido sumia do "Preparando").
    if (gen !== loadGenRef.current) return
    setItens(mesasRes.data ?? [])
    setEntregas(entregasRes.data ?? [])
    setLoading(false)
  }

  async function marcarPedidoPronto(pedido) {
    // Otimista: move pra Histórico. O trigger avisa o iFood (readyToPickup) e o
    // pedido segue pro motoboy / retirada.
    setEntregas(prev => prev.map(p => p.id === pedido.id ? { ...p, status: 'pronto', updated_at: new Date().toISOString() } : p))
    await supabase.from('pedidos_delivery').update({ status: 'pronto' }).eq('id', pedido.id)
  }

  // G1 — aceitar trava o pedido na pessoa (só quem aceitou marca Pronto).
  // NÃO muda o status (mantém confirmado) — só vincula quem pegou. Assim NÃO
  // dispara o WhatsApp do cliente. É controle 100% interno da loja.
  async function aceitarPedido(pedido) {
    const patch = { preparando_por: meuId, preparando_nome: meuNome, preparando_em: new Date().toISOString() }
    setEntregas(prev => prev.map(p => p.id === pedido.id ? { ...p, ...patch } : p))
    const { data } = await supabase.from('pedidos_delivery').update(patch).eq('id', pedido.id).is('preparando_por', null).select('id')
    if (!data || !data.length) alert('Esse pedido já foi pego por outra pessoa (ou não deu pra aceitar). Atualizando a lista…')
    load()
  }
  async function soltarPedido(pedido) {
    if (!window.confirm('Devolver este pedido para "A fazer"? Ele sai do seu "Preparando" e volta pra fila de aceitar.')) return
    const patch = { preparando_por: null, preparando_nome: null, preparando_em: null }
    setEntregas(prev => prev.map(p => p.id === pedido.id ? { ...p, ...patch } : p))
    await supabase.from('pedidos_delivery').update(patch).eq('id', pedido.id).eq('preparando_por', meuId)
    load()
  }

  async function marcarPronto(item) {
    setItens(prev => prev.map(i => i.id === item.id ? { ...i, status: 'pronto', updated_at: new Date().toISOString() } : i))
    await supabase.from('comanda_itens').update({ status: 'pronto' }).eq('id', item.id)
  }
  async function aceitarItem(item) {
    const patch = { preparando_por: meuId, preparando_nome: meuNome, preparando_em: new Date().toISOString() }
    setItens(prev => prev.map(i => i.id === item.id ? { ...i, ...patch } : i))
    const { data } = await supabase.from('comanda_itens').update(patch).eq('id', item.id).is('preparando_por', null).select('id')
    if (!data || !data.length) alert('Esse item já foi pego por outra pessoa. Atualizando a lista…')
    load()
  }
  async function soltarItem(item) {
    if (!window.confirm('Devolver este item para "A fazer"?')) return
    const patch = { preparando_por: null, preparando_nome: null, preparando_em: null }
    setItens(prev => prev.map(i => i.id === item.id ? { ...i, ...patch } : i))
    await supabase.from('comanda_itens').update(patch).eq('id', item.id).eq('preparando_por', meuId)
    load()
  }

  useEffect(() => { load() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Atualiza o "tempo de espera" a cada 30s
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  // Realtime
  useEffect(() => {
    if (!empresaId) return
    const ch = supabase.channel(`kds_${empresaId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_itens', filter: `empresa_id=eq.${empresaId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos_delivery', filter: `empresa_id=eq.${empresaId}` }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filtros por aba (igual ao app do motoqueiro) ─────────────
  const emPreparoStatus = s => s === 'confirmado' || s === 'em_preparo'
  const ent = {
    afazer:     entregas.filter(p => emPreparoStatus(p.status) && !p.preparando_por),
    preparando: entregas.filter(p => emPreparoStatus(p.status) && p.preparando_por === meuId),
    historico:  entregas.filter(p => p.status === 'pronto'),
  }
  const mesa = {
    afazer:     itens.filter(i => i.status === 'pendente' && !i.preparando_por),
    preparando: itens.filter(i => i.status === 'pendente' && i.preparando_por === meuId),
    historico:  itens.filter(i => i.status === 'pronto'),
  }
  const cont = {
    afazer:     ent.afazer.length + mesa.afazer.length,
    preparando: ent.preparando.length + mesa.preparando.length,
    historico:  ent.historico.length + mesa.historico.length,
  }

  const agruparPorMesa = lista => {
    const map = {}
    for (const it of lista) {
      const k = it.comandas?.numero_mesa ?? '—'
      ;(map[k] = map[k] || []).push(it)
    }
    return Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]))
  }
  // Busca (loja com muito pedido): filtra por nº do pedido, código de entrega,
  // nº do iFood, cliente, endereço ou mesa.
  const buscaLimpa = busca.trim().toLowerCase()
  const casaBusca = campos => !buscaLimpa || campos.filter(Boolean).join(' ').toLowerCase().includes(buscaLimpa)
  const entAba  = ent[aba].filter(p => casaBusca([p.numero_pedido, p.ifood_display_id, p.codigo_entrega, p.cliente_nome, p.endereco_rua, p.endereco_bairro, p.endereco_cidade, String(p.id || '').slice(-4)]))
  const mesaAba = useMemo(
    () => agruparPorMesa(mesa[aba].filter(i => casaBusca([i.comandas?.numero_mesa, 'mesa ' + (i.comandas?.numero_mesa ?? ''), i.nome]))),
    [itens, aba, meuId, buscaLimpa] // eslint-disable-line react-hooks/exhaustive-deps
  )

  if (loading) return <div className="page"><p>Carregando cozinha...</p></div>

  const ABAS = [
    ['afazer',     'A fazer'],
    ['preparando', 'Preparando'],
    ['historico',  'Histórico'],
  ]

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Cozinha (KDS)</h1>
          <p className="page-subtitle">Aceite o pedido, prepare e marque pronto — ao vivo.</p>
        </div>
      </div>

      {/* Abas (igual ao app do motoqueiro) */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {ABAS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setAba(id)}
            style={{
              padding: '9px 16px', borderRadius: 10, cursor: 'pointer', fontWeight: 800, fontSize: 13.5,
              border: `1.5px solid ${aba === id ? '#7c3aed' : 'var(--border)'}`,
              background: aba === id ? 'rgba(124,58,237,.14)' : 'transparent',
              color: aba === id ? '#7c3aed' : 'var(--text)',
            }}>
            {label} {cont[id] > 0 && <span style={{ opacity: .8 }}>({cont[id]})</span>}
          </button>
        ))}
      </div>

      {/* Busca por nº/código/cliente/mesa — ajuda quando tem muito pedido */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', maxWidth: 420, marginBottom: 16 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', left: 12, pointerEvents: 'none' }} aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          value={busca}
          onChange={e => setBusca(e.target.value)}
          placeholder="Buscar por nº, código, cliente ou mesa"
          style={{
            width: '100%', padding: '10px 12px 10px 38px', borderRadius: 10, fontSize: 14,
            border: '1.5px solid var(--border)', background: 'var(--surface, var(--bg))', color: 'var(--text)', boxSizing: 'border-box',
          }}
        />
        {busca && (
          <button type="button" onClick={() => setBusca('')} aria-label="Limpar busca"
            style={{ position: 'absolute', right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18, lineHeight: 1, padding: 6 }}>
            ×
          </button>
        )}
      </div>

      {entAba.length === 0 && mesaAba.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
          {buscaLimpa ? `🔍 Nenhum pedido encontrado pra “${busca}”.`
            : aba === 'afazer' ? '🍳 Nenhum pedido esperando. Tudo em dia!'
            : aba === 'preparando' ? '👨‍🍳 Você não está preparando nada agora.'
            : '📋 Nenhum pedido pronto hoje ainda.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {/* Pedidos de delivery / iFood */}
          {entAba.map(pedido => (
            <CardEntregaKDS key={pedido.id} pedido={pedido} meuId={meuId} historico={aba === 'historico'}
              onAceitar={aceitarPedido} onSoltar={soltarPedido} onPronto={marcarPedidoPronto} />
          ))}

          {/* Itens de mesa, agrupados por mesa */}
          {mesaAba.map(([numeroMesa, lista]) => (
            <div key={numeroMesa} style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ background: aba === 'historico' ? '#16a34a' : 'var(--primary)', color: '#fff', padding: '10px 14px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Mesa {numeroMesa}</span>
                <button type="button" title="Imprimir comanda"
                  onClick={() => imprimirHtml(montarComandaCozinhaHtml({ numeroMesa, itens: lista }))}
                  style={{ background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff', borderRadius: 8, cursor: 'pointer', fontSize: 16, padding: '2px 8px' }}>
                  🖨️
                </button>
              </div>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {lista.map(item => {
                  const { nome, complementos: comps } = separarItem(item)
                  return (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{item.quantidade}× {nome}</div>
                        {comps.map((c, j) => (
                          <div key={j} style={{ fontSize: 12.5, color: 'var(--text-muted)', paddingLeft: 14 }}>
                            {Number(c?.qtd ?? 1)}× {c?.nome ?? c}
                          </div>
                        ))}
                        {item.observacao && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{item.observacao}</div>}
                        {aba === 'historico'
                          ? <div style={{ fontSize: 12, fontWeight: 800, color: '#16a34a' }}>✓ Pronto às {horaBR(item.updated_at || item.created_at)}</div>
                          : <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>há {tempoDesde(item.created_at)}</div>}
                      </div>
                      {aba !== 'historico' && (
                        <div style={{ minWidth: 130 }}>
                          <AcaoPreparo registro={item} meuId={meuId} size="sm"
                            onAceitar={aceitarItem} onSoltar={soltarItem} onPronto={marcarPronto} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
