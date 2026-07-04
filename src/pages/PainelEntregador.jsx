import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// Filtro de período por data (created_at). 'tudo' | 'hoje' | '7d' | '30d'.
function dentroDoPeriodo(iso, periodo) {
  if (periodo === 'tudo' || !iso) return true
  const d = new Date(iso).getTime()
  if (periodo === 'hoje') { const s = new Date(); s.setHours(0, 0, 0, 0); return d >= s.getTime() }
  if (periodo === '7d') return d >= Date.now() - 7 * 86400000
  if (periodo === '30d') return d >= Date.now() - 30 * 86400000
  return true
}
const PERIODOS_HIST = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['tudo', 'Tudo']]

function enderecoTexto(p) {
  return [p.endereco_rua, p.endereco_numero, p.endereco_bairro, p.endereco_cidade]
    .filter(Boolean).join(', ')
}

// Ponto pra rota: prefere COORDENADAS (GPS) — nunca falha em geocodificar, ao
// contrário do texto (um endereço que o Google não acha quebra a rota inteira).
function enderecoPonto(p) {
  if (p.endereco_lat != null && p.endereco_lng != null) return `${p.endereco_lat},${p.endereco_lng}`
  return enderecoTexto(p)
}

function mapsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(enderecoPonto(p))}`
}

// Rota única com várias paradas (E1). PRECISA de ponto de partida, senão o Maps
// preenche os endereços mas não traça o caminho. Por isso a 1ª entrega vira a
// ORIGEM, a última o destino, e as do meio vão em waypoints (separados por "|"
// cru — o navegador codifica; %7C já codificado o app não entende). Máx. 10.
function rotaMultiplaUrl(pedidos) {
  const pontos = pedidos.map(enderecoPonto).filter(Boolean).slice(0, 10)
  if (pontos.length < 2) return null
  const origem = encodeURIComponent(pontos[0])
  const destino = encodeURIComponent(pontos[pontos.length - 1])
  const meio = pontos.slice(1, -1).map(e => encodeURIComponent(e))
  let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${origem}&destination=${destino}`
  if (meio.length) url += `&waypoints=${meio.join('|')}`
  return url
}

// Só dígitos para o link do WhatsApp (wa.me abre a conversa, não gasta crédito).
function soDigitos(tel) {
  return String(tel || '').replace(/\D/g, '')
}

// Diz pro motoqueiro se ele PRECISA cobrar (dinheiro) ou se já está pago.
// iFood e cartão/online caem sempre como pago; PIX só quando confirmado.
function pagamentoInfo(p) {
  const forma = p.forma_pagamento
  if (forma === 'dinheiro') {
    return { pago: false, titulo: 'COBRAR NA ENTREGA', detalhe: 'Dinheiro', cor: '#f59e0b' }
  }
  if (forma === 'pix') {
    if (p.pix_status === 'pago') return { pago: true, titulo: 'JÁ PAGO', detalhe: 'PIX confirmado', cor: '#16a34a' }
    return { pago: false, titulo: 'COBRAR NA ENTREGA', detalhe: 'PIX (não confirmado)', cor: '#f59e0b' }
  }
  if (p.origem === 'ifood') {
    return { pago: true, titulo: 'JÁ PAGO', detalhe: 'Pago no iFood', cor: '#16a34a' }
  }
  return { pago: true, titulo: 'JÁ PAGO', detalhe: forma || 'Pago online', cor: '#16a34a' }
}

// ── Card de entrega ─────────────────────────────────────────
function CardEntrega({ pedido, mine, onAceitar, onSair, onConfirmar, onConfirmarIfood, onDesistir }) {
  const [codigo, setCodigo] = useState('')
  const [erro, setErro] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const endereco = enderecoTexto(pedido)
  const tel = soDigitos(pedido.cliente_telefone)
  const emRota = pedido.status === 'saiu_entrega'
  const cor = !mine ? '#0d9488' : emRota ? '#7c3aed' : '#2563eb'
  const pg = pagamentoInfo(pedido)
  // iFood não expõe o telefone real do cliente: liga num 0800 e digita um ID.
  // Por isso, nos pedidos do iFood some o WhatsApp e o "Ligar" vai no 0800.
  const isIfood = pedido.origem === 'ifood'
  const ifoodId = pedido.ifood_phone_localizer
  // Pedido do iFood que exige o código de confirmação de entrega (F1)
  const precisaCodigoIfood = isIfood && pedido.ifood_requer_codigo
  // Link de ligação: no iFood embute o ID no formato que o próprio iFood usa —
  // 0800 + ";" (espera) + ID. Ex: tel:08007054050;51303807. O motoqueiro liga e,
  // quando a gravação pedir, aperta pra enviar o código (não digita os 8 números).
  const telHref = (isIfood && ifoodId)
    ? `tel:${tel};${soDigitos(ifoodId)}`
    : `tel:${tel}`

  function desistir() {
    if (!window.confirm('Largar esta entrega? Ela volta para os outros motoqueiros pegarem.')) return
    run(() => onDesistir(pedido))
  }

  async function run(fn) {
    setOcupado(true)
    await fn()
    setOcupado(false)
  }

  async function confirmar() {
    // iFood que exige código: valida o código do CLIENTE no iFood (verifyDeliveryCode)
    if (precisaCodigoIfood) {
      if (codigo.trim().length < 2) { setErro('Digite o código do cliente.'); return }
      setErro(null); setOcupado(true)
      const ok = await onConfirmarIfood(pedido, codigo.trim())
      setOcupado(false)
      if (!ok) setErro('Código do iFood não confere. Confira com o cliente.')
      return
    }
    if (pedido.codigo_entrega && codigo.trim() !== String(pedido.codigo_entrega).trim()) {
      setErro('Código incorreto.')
      return
    }
    run(() => onConfirmar(pedido))
  }

  return (
    <div style={{
      background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
      borderRadius: 14, padding: 16, borderTop: `4px solid ${cor}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
          {pedido.origem === 'ifood' && pedido.ifood_display_id ? (
            <>
              <span style={{ fontWeight: 800, fontSize: 18, color: '#ea1d2c' }}>iFood #{pedido.ifood_display_id}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>#{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}</span>
            </>
          ) : (
            <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--text)' }}>
              #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}
            </span>
          )}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: `${cor}22`, color: cor }}>
          {!mine ? 'Disponível' : emRota ? 'Em rota' : 'Aceita'}
        </span>
      </div>

      <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>{pedido.cliente_nome || 'Cliente'}</div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, margin: '4px 0 10px' }}>
        <div style={{ fontSize: 14, color: 'var(--text-muted)', flex: 1 }}>📍 {endereco}</div>
        <a href={mapsUrl(pedido)} target="_blank" rel="noopener noreferrer"
          title="Ver o ponto no mapa"
          style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: '#7c3aed', textDecoration: 'none',
            background: 'rgba(124,58,237,.12)', border: '1px solid #7c3aed', borderRadius: 8, padding: '5px 10px', whiteSpace: 'nowrap' }}>
          🗺️ Rota
        </a>
      </div>


      {/* Pagamento: deixa MUITO claro se já pagou ou se o motoqueiro precisa cobrar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: `${pg.cor}18`, border: `1.5px solid ${pg.cor}`,
        borderRadius: 10, padding: '10px 12px', marginBottom: 10,
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 900, color: pg.cor, letterSpacing: .3 }}>
            {pg.pago ? '✓ ' : '💵 '}{pg.titulo}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>
            {pg.detalhe}
            {pedido.forma_pagamento === 'dinheiro' && pedido.troco_para > 0 && (
              <span> · troco p/ {fmt(pedido.troco_para)}</span>
            )}
          </div>
        </div>
        <strong style={{ fontSize: 18, color: 'var(--text)' }}>{fmt(pedido.total)}</strong>
      </div>

      {/* Taxa da corrida (o que a entrega vale para o motoqueiro) */}
      {pedido.taxa_entrega != null && Number(pedido.taxa_entrega) > 0 && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 13.5, color: 'var(--text-muted)', margin: '0 2px 12px',
        }}>
          <span>🛵 Taxa desta corrida</span>
          <strong style={{ color: 'var(--text)', fontSize: 15 }}>{fmt(pedido.taxa_entrega)}</strong>
        </div>
      )}

      {/* Contato / rota — só faz sentido depois de aceitar */}
      {mine && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: isIfood && ifoodId ? 6 : 12 }}>
            {tel && <a href={telHref} style={btnLink('#0891b2')}>📞 {isIfood ? 'Ligar (iFood)' : 'Ligar'}</a>}
            {/* WhatsApp só pros pedidos que NÃO são do iFood (iFood não tem zap do cliente) */}
            {tel && !isIfood && <a href={`https://wa.me/${tel}`} target="_blank" rel="noopener noreferrer" style={btnLink('#25d366')}>💬 Zap</a>}
          </div>
          {isIfood && ifoodId && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              background: 'rgba(234,29,44,.10)', border: '1.5px solid #ea1d2c',
              borderRadius: 10, padding: '8px 12px', marginBottom: 12, fontSize: 13, color: 'var(--text-muted)',
            }}>
              <span>Ao ligar, informe o ID do pedido:</span>
              <strong style={{ fontSize: 17, color: 'var(--text)', letterSpacing: 1 }}>{ifoodId}</strong>
            </div>
          )}
        </>
      )}

      {/* Ação principal */}
      {!mine ? (
        onAceitar ? (
          <button type="button" onClick={() => run(() => onAceitar(pedido))} disabled={ocupado}
            style={btnPrimario('#0d9488')}>
            {ocupado ? 'Aceitando...' : '✋ Aceitar entrega'}
          </button>
        ) : (
          <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)', padding: '4px 0' }}>
            Aguarde sua vez para aceitar
          </div>
        )
      ) : !emRota ? (
        <button type="button" onClick={() => run(() => onSair(pedido))} disabled={ocupado}
          style={btnPrimario('#7c3aed')}>
          {ocupado ? 'Salvando...' : '🛵 Sair para entrega'}
        </button>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={codigo}
              onChange={e => { setCodigo(e.target.value.replace(/\D/g, '').slice(0, precisaCodigoIfood ? 8 : 4)); setErro(null) }}
              inputMode="numeric"
              placeholder={precisaCodigoIfood ? 'Cód. do cliente' : 'Código'}
              style={{
                flex: 1, minWidth: 0, width: '100%', padding: '10px 8px', borderRadius: 10, textAlign: 'center',
                fontSize: 18, fontWeight: 700, letterSpacing: 3,
                border: '1.5px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
              }}
            />
            <button type="button" onClick={confirmar} disabled={ocupado}
              style={{ ...btnPrimario('#16a34a'), width: 'auto', flexShrink: 0, padding: '0 16px', whiteSpace: 'nowrap' }}>
              {ocupado ? '...' : 'Entreguei'}
            </button>
          </div>
          {erro && <div style={{ fontSize: 12.5, color: 'var(--danger, #ef4444)', marginTop: 6 }}>{erro}</div>}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
            {precisaCodigoIfood
              ? '📱 Peça ao cliente o código de confirmação do iFood (aparece no app dele).'
              : 'Peça ao cliente os 4 dígitos que aparecem na tela do pedido dele.'}
          </div>
        </div>
      )}

      {/* Desistir: devolve a entrega pro pool (só nas minhas) */}
      {mine && onDesistir && (
        <button type="button" onClick={desistir} disabled={ocupado}
          style={{
            width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 10,
            background: 'transparent', border: '1.5px solid var(--border, #2a2a3a)',
            color: 'var(--text-muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}>
          Largar entrega
        </button>
      )}
    </div>
  )
}

function btnLink(cor) {
  return {
    flex: 1, textAlign: 'center', textDecoration: 'none', padding: '9px 0', borderRadius: 10,
    border: `1.5px solid ${cor}`, color: cor, fontWeight: 700, fontSize: 13.5,
  }
}
function btnPrimario(cor) {
  return {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: cor, color: '#fff', fontWeight: 800, fontSize: 15,
  }
}
function filaBox(cor) {
  return {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
    background: `${cor}18`, border: `1.5px solid ${cor}`, borderRadius: 12, padding: '12px 14px',
  }
}
function btnFila(cor) {
  return {
    flexShrink: 0, padding: '10px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: cor, color: '#fff', fontWeight: 800, fontSize: 14, whiteSpace: 'nowrap',
  }
}

// ── Tela do entregador ──────────────────────────────────────
export default function PainelEntregador() {
  const { user, profile, empresa, logout } = useAuth()
  const [pedidos, setPedidos] = useState([])
  const [loading, setLoading] = useState(true)
  const [aba, setAba] = useState('disponiveis') // 'disponiveis' | 'minhas' | 'historico'
  const [historico, setHistorico] = useState([])
  const [histLoading, setHistLoading] = useState(false)
  const [periodoHist, setPeriodoHist] = useState('tudo') // filtro de data do histórico
  // Fila (E4): null = ainda não carregou. { fila_ativa, online, pausado, na_vez, posicao, total_fila }
  const [fila, setFila] = useState(null)
  const [filaBusy, setFilaBusy] = useState(false)

  // A RLS já limita: cada entregador recebe os pedidos dele + os 'pronto' livres
  // da própria loja. Por isso basta filtrar por status e deixar o banco filtrar o resto.
  const carregar = useCallback(async () => {
    if (!user) return
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .in('status', ['pronto', 'saiu_entrega'])
      .order('created_at')
    setPedidos(data ?? [])
    setLoading(false)
  }, [user])

  useEffect(() => {
    carregar()
    if (!user) return
    // Sem filtro de coluna: o Realtime respeita a RLS, então só chegam eventos
    // dos pedidos que este entregador pode ver (os dele + o pool da loja).
    const canal = supabase
      .channel(`entregas_${user.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'pedidos_delivery' },
        () => carregar())
      .subscribe()
    return () => { canal.unsubscribe() }
  }, [user, carregar])

  // Estado da fila (E4). Faz polling curto porque a fila muda no profile de
  // OUTROS entregadores (que o Realtime deste usuário não recebe).
  const carregarFila = useCallback(async () => {
    if (!user) return
    const { data } = await supabase.rpc('entregador_estado')
    if (data) setFila(data)
  }, [user])

  useEffect(() => {
    carregarFila()
    const t = setInterval(carregarFila, 5000)
    return () => clearInterval(t)
  }, [carregarFila])

  async function acaoFila(rpc, args) {
    setFilaBusy(true)
    await supabase.rpc(rpc, args)
    await Promise.all([carregarFila(), carregar()])
    setFilaBusy(false)
  }
  const ficarOnline    = () => acaoFila('entregador_set_online', { p_online: true })
  const ficarOffline   = () => acaoFila('entregador_set_online', { p_online: false })
  const finalizarVez   = () => acaoFila('entregador_finalizar_vez')
  const voltarFila      = () => acaoFila('entregador_voltar_fila')

  async function notificarCliente(pedidoId, novoStatus) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      fetch(`${SUPABASE_URL}/functions/v1/whatsapp-pedido-notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ pedido_id: pedidoId, novo_status: novoStatus }),
      })
    } catch { /* best-effort */ }
  }

  async function aceitar(pedido) {
    // Com fila ativa, o servidor decide se posso aceitar (tenho que estar na vez).
    if (fila?.fila_ativa) {
      const { data: ok } = await supabase.rpc('entregador_aceitar_pedido', { p_pedido: pedido.id })
      await Promise.all([carregar(), carregarFila()])
      if (ok === false) { alert('Não deu pra aceitar — ou não é a sua vez, ou outro motoqueiro pegou primeiro.'); return }
      setAba('minhas') // mostra na aba "Aceitas"
      return
    }
    // Pool livre (comportamento padrão): otimista, o reload corrige se outro pegou.
    setPedidos(prev => prev.map(p => p.id === pedido.id ? { ...p, entregador_id: user.id } : p))
    const { data } = await supabase.from('pedidos_delivery')
      .update({ entregador_id: user.id }).eq('id', pedido.id).is('entregador_id', null).select('id')
    await carregar()
    if (data && data.length) setAba('minhas')
    else alert('Não deu pra aceitar — outro motoqueiro pode ter pego primeiro. Atualize a lista.')
  }

  async function sairParaEntrega(pedido) {
    const update = { status: 'saiu_entrega', saiu_entrega_at: new Date().toISOString() }
    if (!pedido.codigo_entrega) update.codigo_entrega = String(Math.floor(1000 + Math.random() * 9000))
    setPedidos(prev => prev.map(p => p.id === pedido.id ? { ...p, ...update } : p))
    await supabase.from('pedidos_delivery').update(update).eq('id', pedido.id)
    notificarCliente(pedido.id, 'saiu_entrega')
  }

  async function confirmarEntrega(pedido) {
    setPedidos(prev => prev.filter(p => p.id !== pedido.id))
    await supabase.from('pedidos_delivery').update({ status: 'entregue' }).eq('id', pedido.id)
    notificarCliente(pedido.id, 'entregue')
  }

  // Força pegar a versão mais nova do app (limpa cache + atualiza o service
  // worker) — pro motoqueiro não ficar preso numa versão antiga no navegador.
  const [atualizando, setAtualizando] = useState(false)
  async function atualizarApp() {
    setAtualizando(true)
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.update()))
      }
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
    } catch { /* segue pro reload de qualquer jeito */ }
    window.location.reload()
  }

  // iFood com código de entrega (F1): valida o código do cliente no iFood.
  // Retorna true se o iFood aceitou (pedido concluído) — o card mostra o erro se não.
  async function confirmarEntregaIfood(pedido, codigo) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ifood-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ acao: 'verify_delivery_code', pedido_id: pedido.id, codigo }),
      })
      const json = await res.json()
      if (json?.valid) {
        setPedidos(prev => prev.filter(p => p.id !== pedido.id))
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // Desistir: devolve o pedido pro pool. Se já tinha saído pra entrega, volta
  // pra 'pronto' pra outro motoqueiro pegar (a RLS 0079 permite esse caso).
  async function desistirEntrega(pedido) {
    const update = { entregador_id: null }
    if (pedido.status === 'saiu_entrega') update.status = 'pronto'
    setPedidos(prev => prev.map(p => p.id === pedido.id ? { ...p, ...update } : p))
    await supabase.from('pedidos_delivery').update(update).eq('id', pedido.id).eq('entregador_id', user.id)
    carregar()
  }

  // Histórico: entregas já concluídas por este entregador (carrega ao abrir a aba)
  useEffect(() => {
    if (aba !== 'historico' || !user) return
    setHistLoading(true)
    supabase
      .from('pedidos_delivery')
      .select('id, numero_pedido, cliente_nome, total, taxa_entrega, forma_pagamento, origem, endereco_bairro, endereco_cidade, created_at, entregador_pago, entregador_pago_em')
      .eq('entregador_id', user.id)
      .eq('status', 'entregue')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => { setHistorico(data ?? []); setHistLoading(false) })
  }, [aba, user])

  const minhas = pedidos.filter(p => p.entregador_id === user?.id)
  // Disponíveis pro motoboy: só ENTREGA (retirada o cliente busca) e sem dono.
  // iFood: como o pedido costuma ir direto pra "saiu_entrega" (despachado no
  // iFood), também liberamos esses pro entregador da loja pegar e levar.
  const disponiveis = pedidos.filter(p =>
    p.tipo_entrega !== 'retirada' && !p.entregador_id &&
    (p.status === 'pronto' || (p.origem === 'ifood' && p.status === 'saiu_entrega'))
  )

  // Fila (E4): com a fila ativa, só quem está online, sem pausa e na vez aceita.
  const filaAtiva = !!fila?.fila_ativa
  const emAtividade = !filaAtiva || (fila?.online && !fila?.pausado) // pode ver o pool?
  const podeAceitar = !filaAtiva || !!fila?.na_vez

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #0f0f1a)' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px', background: 'var(--surface, #16161f)',
        borderBottom: '1px solid var(--border, #2a2a3a)',
      }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--text)' }}>Minhas entregas</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {empresa?.nome || ''} · {profile?.nome || user?.email}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={atualizarApp} disabled={atualizando}
            style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>
            {atualizando ? '...' : '🔄 Atualizar'}
          </button>
          <button type="button" onClick={logout}
            style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>
            Sair
          </button>
        </div>
      </header>

      {/* Barra da fila (E4) — só quando a loja usa fila por ordem de chegada */}
      {filaAtiva && (
        <div style={{ maxWidth: 560, margin: '0 auto', padding: '14px 16px 0' }}>
          {!fila.online ? (
            <div style={filaBox('#6b7280')}>
              <div>
                <div style={{ fontWeight: 800, color: 'var(--text)' }}>⚪ Você está offline</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Fique online ao chegar na loja para entrar na fila.</div>
              </div>
              <button type="button" onClick={ficarOnline} disabled={filaBusy} style={btnFila('#16a34a')}>
                🟢 Ficar online
              </button>
            </div>
          ) : fila.pausado ? (
            <div style={filaBox('#f59e0b')}>
              <div>
                <div style={{ fontWeight: 800, color: 'var(--text)' }}>⏸️ Vez finalizada — em pausa</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Quando voltar, entre de novo no fim da fila.</div>
              </div>
              <button type="button" onClick={voltarFila} disabled={filaBusy} style={btnFila('#7c3aed')}>
                ↩️ Voltar pra fila
              </button>
            </div>
          ) : (
            <div style={filaBox(fila.na_vez ? '#16a34a' : '#2563eb')}>
              <div>
                <div style={{ fontWeight: 800, color: 'var(--text)' }}>
                  {fila.na_vez ? '🟢 É a SUA VEZ' : `🟢 Online · você é o Nº ${fila.posicao}`}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                  {fila.na_vez
                    ? `Você pode aceitar as entregas. (${fila.total_fila} na fila)`
                    : `Aguarde sua vez — ${fila.total_fila} na fila.`}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button type="button" onClick={finalizarVez} disabled={filaBusy} style={btnFila('#f59e0b')}>
                  Finalizar minha vez
                </button>
                <button type="button" onClick={ficarOffline} disabled={filaBusy}
                  style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', color: 'var(--text-muted)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12.5 }}>
                  Ficar offline
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Abas */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '14px 16px 0', display: 'flex', gap: 8 }}>
        {[
          { id: 'disponiveis', label: `Disponíveis${disponiveis.length ? ` (${disponiveis.length})` : ''}` },
          { id: 'minhas', label: `Aceitas${minhas.length ? ` (${minhas.length})` : ''}` },
          { id: 'historico', label: 'Histórico' },
        ].map(t => (
          <button key={t.id} type="button" onClick={() => setAba(t.id)}
            style={{
              flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
              border: `1.5px solid ${aba === t.id ? '#7c3aed' : 'var(--border, #2a2a3a)'}`,
              background: aba === t.id ? 'rgba(124,58,237,.15)' : 'transparent',
              color: aba === t.id ? '#a78bfa' : 'var(--text)',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <main style={{ maxWidth: 560, margin: '0 auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {aba !== 'historico' ? (
          loading ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Carregando...</p>
          ) : aba === 'minhas' ? (
            /* ── Entregas que EU aceitei (seguir rota / dar saída / confirmar) ── */
            minhas.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>🛵</div>
                Você não aceitou nenhuma entrega ainda. Veja as prontas na aba <strong>Disponíveis</strong>.
              </div>
            ) : (
              <>
                {minhas.filter(p => enderecoTexto(p)).length >= 2 && (
                  <a href={rotaMultiplaUrl(minhas.filter(p => enderecoTexto(p)))} target="_blank" rel="noopener noreferrer"
                    style={{ ...btnPrimario('#7c3aed'), display: 'block', textAlign: 'center', textDecoration: 'none' }}>
                    🗺️ Rota de todas ({minhas.filter(p => enderecoTexto(p)).length} paradas)
                  </a>
                )}
                {minhas.map(p => (
                  <CardEntrega key={p.id} pedido={p} mine
                    onSair={sairParaEntrega} onConfirmar={confirmarEntrega}
                    onConfirmarIfood={confirmarEntregaIfood} onDesistir={desistirEntrega} />
                ))}
              </>
            )
          ) : (
            /* ── Disponíveis pra aceitar ── */
            !emAtividade ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                Fique <strong>online</strong> para ver as entregas disponíveis.
              </div>
            ) : disponiveis.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>📭</div>
                Nenhum pedido pronto esperando. Aguarde a cozinha liberar.
              </div>
            ) : disponiveis.map(p => (
              <CardEntrega key={p.id} pedido={p} mine={false} onAceitar={podeAceitar ? aceitar : undefined} />
            ))
          )
        ) : (
          /* ── Histórico de entregas concluídas ── */
          histLoading ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Carregando...</p>
          ) : historico.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>📭</div>
              Você ainda não concluiu nenhuma entrega.
            </div>
          ) : (
            <>
              {(() => {
                const base = historico.filter(p => dentroDoPeriodo(p.created_at, periodoHist))
                const pend = base.filter(p => !p.entregador_pago)
                const pagos = base.filter(p => p.entregador_pago)
                // Ganho LÍQUIDO: taxa cheia, menos o desconto SÓ nas do iFood.
                const descValor = (profile?.entregador_desconto_ativo && Number(profile?.entregador_desconto_valor) > 0) ? Number(profile.entregador_desconto_valor) : 0
                const ganho = p => Math.max(0, Number(p.taxa_entrega || 0) - (p.origem === 'ifood' ? descValor : 0))
                const soma = arr => arr.reduce((s, p) => s + ganho(p), 0)
                const dataDe = p => new Date(p.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
                const grupos = arr => {
                  const g = {}
                  for (const p of arr) (g[dataDe(p)] ??= []).push(p)
                  return Object.entries(g)
                }
                const Card = (p) => (
                  <div key={p.id} style={{ background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)', borderRadius: 12, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 800, color: 'var(--text)' }}>#{p.numero_pedido ?? p.id.slice(-4).toUpperCase()}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong style={{ color: '#16a34a' }}
                          title={p.origem === 'ifood' && descValor > 0 ? `Taxa ${fmt(p.taxa_entrega)} − iFood ${fmt(descValor)}` : 'Taxa de entrega'}>{fmt(ganho(p))}</strong>
                        {p.entregador_pago
                          ? <span style={{ fontSize: 11, fontWeight: 800, color: '#16a34a', background: 'rgba(34,197,94,.14)', padding: '2px 8px', borderRadius: 20 }}>✓ Pago</span>
                          : <span style={{ fontSize: 11, fontWeight: 800, color: '#f59e0b', background: 'rgba(245,158,11,.14)', padding: '2px 8px', borderRadius: 20 }}>A receber</span>}
                      </div>
                    </div>
                    <div style={{ fontSize: 13.5, color: 'var(--text)', marginTop: 4 }}>{p.cliente_nome || 'Cliente'}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>{[p.endereco_bairro, p.endereco_cidade].filter(Boolean).join(', ')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                      {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{p.forma_pagamento ? ` · ${p.forma_pagamento}` : ''}
                      {p.origem === 'ifood' && descValor > 0 && <span style={{ color: '#f59e0b' }}> · iFood −{fmt(descValor)}</span>}
                    </div>
                  </div>
                )
                return (
                  <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {PERIODOS_HIST.map(([val, lab]) => (
                        <button key={val} type="button" onClick={() => setPeriodoHist(val)}
                          style={{ fontSize: 12, fontWeight: 700, padding: '5px 14px', borderRadius: 20, cursor: 'pointer',
                            border: `1px solid ${periodoHist === val ? 'var(--primary, #a78bfa)' : 'var(--border, #2a2a3a)'}`,
                            background: periodoHist === val ? 'var(--primary, #a78bfa)' : 'transparent',
                            color: periodoHist === val ? '#fff' : 'var(--text-muted)' }}>
                          {lab}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{ flex: 1, textAlign: 'center', background: 'var(--surface,#16161f)', border: '1px solid var(--border,#2a2a3a)', borderRadius: 12, padding: '10px 4px' }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: '#f59e0b' }}>{fmt(soma(pend))}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>A receber ({pend.length})</div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center', background: 'var(--surface,#16161f)', border: '1px solid var(--border,#2a2a3a)', borderRadius: 12, padding: '10px 4px' }}>
                        <div style={{ fontSize: 17, fontWeight: 800, color: '#16a34a' }}>{fmt(soma(pagos))}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Recebido ({pagos.length})</div>
                      </div>
                    </div>

                    {descValor > 0 && base.some(p => p.origem === 'ifood') && (() => {
                      const nIfood = base.filter(p => p.origem === 'ifood').length
                      return (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(245,158,11,.10)', border: '1px solid #f59e0b', borderRadius: 12, padding: '9px 14px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                          <span>iFood: {fmt(descValor)}/corrida já descontado · {nIfood} corrida{nIfood > 1 ? 's' : ''}</span>
                          <strong style={{ color: '#f59e0b' }}>−{fmt(nIfood * descValor)}</strong>
                        </div>
                      )
                    })()}

                    <div style={{ fontSize: 14, fontWeight: 800, color: '#f59e0b', marginTop: 4 }}>A receber</div>
                    {pend.length === 0
                      ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nada pendente. 🎉</div>
                      : grupos(pend).map(([data, ps]) => (
                        <div key={data} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginTop: 4 }}>{data} · {fmt(soma(ps))}</div>
                          {ps.map(Card)}
                        </div>
                      ))}

                    <div style={{ fontSize: 14, fontWeight: 800, color: '#16a34a', marginTop: 12 }}>Recebidas</div>
                    {pagos.length === 0
                      ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhuma paga ainda.</div>
                      : grupos(pagos).map(([data, ps]) => (
                        <div key={data} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginTop: 4 }}>{data} · {fmt(soma(ps))}</div>
                          {ps.map(Card)}
                        </div>
                      ))}
                  </>
                )
              })()}
            </>
          )
        )}
      </main>
    </div>
  )
}
