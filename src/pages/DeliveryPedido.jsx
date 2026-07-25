import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { iniciarTags, registrarCompra } from '../lib/tracking'
import './DeliveryPedido.css'

const STATUS_STEPS = [
  { key: 'aguardando',   label: 'Aguardando confirmação', icon: IconClock },
  { key: 'confirmado',   label: 'Confirmado',             icon: IconCheck },
  { key: 'em_preparo',   label: 'Em preparo',             icon: IconChef },
  { key: 'saiu',         label: 'Saiu para entrega',      icon: IconMoto },
  { key: 'entregue',     label: 'Entregue',               icon: IconParty },
]

function iconProps() {
  return { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
}

function IconClock() {
  return <svg {...iconProps()}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
}

function IconCheck() {
  return <svg {...iconProps()}><polyline points="20 6 9 17 4 12" /></svg>
}

function IconChef() {
  return <svg {...iconProps()}><path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6v-7.13z" /><line x1="6" y1="17" x2="18" y2="17" /></svg>
}

function IconMoto() {
  return <svg {...iconProps()}><circle cx="5" cy="17" r="3" /><circle cx="19" cy="17" r="3" /><path d="M8 17h8M5 14l2-7h8l3 7" /><path d="M13 7l1-4h3" /></svg>
}

function IconParty() {
  return <svg {...iconProps()}><path d="M5.8 11.3 2 22l10.7-3.79" /><path d="M4 3h.01M22 8h.01M15 2h.01M22 20h.01M22 2l-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10" /><path d="M22 13l-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17" /><path d="M11 2l.33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.5 9 6.2v.01" /><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2z" /></svg>
}

function IconX() {
  return <svg {...iconProps()}><path d="M18 6 6 18M6 6l12 12" /></svg>
}

function IconStore() {
  return <svg {...iconProps()}><path d="M3 9l1-5h16l1 5" /><path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z" /><path d="M9 21V9m6 0v12" /></svg>
}

function IconRefresh() {
  return <svg {...iconProps()} width={14} height={14}><path d="M21 2v6h-6" /><path d="M21 13a9 9 0 1 1-3-7.7L21 8" /></svg>
}

function fmt(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function shortId(uuid) {
  return (uuid ?? '').slice(-8).toUpperCase()
}

function paymLabel(forma) {
  if (forma === 'pix') return 'Pix'
  if (forma === 'dinheiro') return 'Dinheiro'
  return forma ?? '—'
}

// O banco tem status que não são exatamente as chaves da timeline
// (ex: 'saiu_entrega' → passo 'saiu'; 'pronto' ainda está no preparo).
const STATUS_TO_STEP = {
  aguardando_pagamento: 'aguardando',
  aguardando: 'aguardando',
  confirmado: 'confirmado',
  em_preparo: 'em_preparo',
  pronto: 'em_preparo',
  saiu_entrega: 'saiu',
  entregue: 'entregue',
}

function statusIndex(status) {
  if (status === 'cancelado') return -1
  const chave = STATUS_TO_STEP[status] || status
  return STATUS_STEPS.findIndex(s => s.key === chave)
}

// ── Chat do cliente (loja online, sem login) com a loja ─────
// Cliente identificado pelo telefone. Acesso via RPCs SECURITY DEFINER (0047).
// Sem realtime para anon — usa polling.
function ChatLojaOnline({ empresaId, telefone, nome }) {
  const [msgs, setMsgs] = useState([])
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [carregando, setCarregando] = useState(true)
  const fimRef = useRef(null)

  const carregar = useCallback(async () => {
    if (!empresaId || !telefone) return
    const { data } = await supabase.rpc('listar_msgs_loja', {
      p_empresa_id: empresaId, p_telefone: telefone,
    })
    setMsgs(data || [])
    setCarregando(false)
    // marca como lidas as mensagens que a loja enviou
    if ((data || []).some(m => m.remetente === 'loja' && !m.lida_cliente)) {
      await supabase.rpc('marcar_lidas_loja', { p_empresa_id: empresaId, p_telefone: telefone })
    }
  }, [empresaId, telefone])

  useEffect(() => {
    carregar()
    const poll = setInterval(carregar, 8000)
    return () => clearInterval(poll)
  }, [carregar])

  useEffect(() => { fimRef.current?.scrollIntoView({ block: 'end' }) }, [msgs.length])

  async function enviar() {
    const t = texto.trim()
    if (!t || enviando) return
    setEnviando(true)
    const { data, error } = await supabase.rpc('enviar_msg_loja', {
      p_empresa_id: empresaId, p_telefone: telefone, p_nome: nome || '', p_texto: t,
    })
    setEnviando(false)
    if (!error) {
      setTexto('')
      if (data) setMsgs(prev => prev.some(x => x.id === data.id) ? prev : [...prev, data])
    }
  }

  if (!telefone) return null

  return (
    <section className="dpd-card">
      <h2 className="dpd-card-title">Falar com a loja</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto', marginBottom: 10 }}>
        {carregando ? (
          <p style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: 10 }}>Carregando...</p>
        ) : msgs.length === 0 ? (
          <p style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: 10 }}>
            Alguma dúvida sobre o pedido? Mande uma mensagem para a loja.
          </p>
        ) : msgs.map(m => {
          const daLoja = m.remetente === 'loja'
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: daLoja ? 'flex-start' : 'flex-end' }}>
              <div style={{
                maxWidth: '82%', padding: '7px 11px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.35,
                background: daLoja ? '#f1f5f9' : '#7c3aed',
                color: daLoja ? '#0f172a' : '#fff',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {m.texto}
                <div style={{ fontSize: 9.5, opacity: .65, marginTop: 3, textAlign: 'right' }}>
                  {new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={fimRef} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <textarea
          value={texto}
          onChange={e => setTexto(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } }}
          placeholder="Escreva uma mensagem..."
          rows={1}
          style={{
            flex: 1, resize: 'none', maxHeight: 90, padding: '9px 11px', borderRadius: 10,
            border: '1px solid #e2e8f0', background: '#fff', color: '#0f172a',
            fontSize: 13.5, fontFamily: 'inherit',
          }}
        />
        <button type="button" onClick={enviar} disabled={!texto.trim() || enviando}
          style={{
            flexShrink: 0, width: 42, borderRadius: 10, border: 'none', cursor: texto.trim() ? 'pointer' : 'default',
            background: texto.trim() ? '#7c3aed' : '#cbd5e1', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </section>
  )
}

export default function DeliveryPedido() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [pedido, setPedido] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [pixCopied, setPixCopied] = useState(false)
  const [loja, setLoja] = useState(null) // loja onde o pedido foi feito (cabeçalho + voltar)
  // Avaliação (pós-entrega)
  const [nota, setNota] = useState(0)
  const [hoverNota, setHoverNota] = useState(0)
  const [comentario, setComentario] = useState('')
  const [enviandoAval, setEnviandoAval] = useState(false)
  const [erroAval, setErroAval] = useState(null)
  const intervalRef = useRef(null)

  const fetchPedido = async () => {
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    const next = data ?? null
    if (next && (next.status === 'entregue' || next.status === 'cancelado')) {
      clearInterval(intervalRef.current)
    }
    setPedido(next)
    setLoading(false)
    setLastUpdate(new Date())
  }

  useEffect(() => {
    fetchPedido()
    // Polling de fallback a cada 30s (para casos onde Realtime não estiver disponível)
    intervalRef.current = setInterval(fetchPedido, 30_000)

    // Realtime: atualiza instantaneamente quando o status muda no painel da loja
    const channel = supabase
      .channel(`pedido_track_${id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'pedidos_delivery',
          filter: `id=eq.${id}`,
        },
        (payload) => {
          const updated = payload.new
          setPedido(prev => prev ? { ...prev, ...updated } : updated)
          setLastUpdate(new Date())
          if (updated.status === 'entregue' || updated.status === 'cancelado') {
            clearInterval(intervalRef.current)
          }
        }
      )
      .subscribe()

    return () => {
      clearInterval(intervalRef.current)
      channel.unsubscribe()
    }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Busca a loja do pedido (nome/logo) para o cabeçalho e o "voltar à loja"
  useEffect(() => {
    if (!pedido?.empresa_id) return
    supabase
      .from('empresas')
      .select('id, nome, logo_url, slug, google_ads_id, google_ads_label, meta_pixel_id')
      .eq('id', pedido.empresa_id)
      .maybeSingle()
      .then(({ data }) => {
        setLoja(data ?? null)
        // Quem abre o link do pedido direto (voltando do PIX, ou pelo histórico)
        // não passou pela vitrine — carrega as tags aqui também.
        iniciarTags(data)
      })
  }, [pedido?.empresa_id])

  // Conversão de compra pro Google Ads / Meta.
  //
  // Dispara aqui e não no checkout porque pedido no PIX só vale depois que o
  // Mercado Pago confirma — senão a loja otimizaria o anúncio por pedido que
  // nunca foi pago. Pedido cancelado não conta. `registrarCompra` trava por id
  // do pedido, então recarregar a página não conta a venda duas vezes.
  useEffect(() => {
    if (!pedido || !loja) return
    if (pedido.status === 'cancelado') return
    const pixPago = pedido.pix_status === 'pago' || pedido.mp_payment_status === 'approved'
    if (pedido.forma_pagamento === 'pix' && !pixPago) return
    registrarCompra({
      pedidoId: pedido.id,
      valor: Number(pedido.total ?? 0),
      itens: Array.isArray(pedido.itens) ? pedido.itens : [],
      loja,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedido?.id, pedido?.status, pedido?.pix_status, pedido?.mp_payment_status, loja])

  async function handleCopiarPix() {
    if (!pedido?.pix_copia_cola) return
    try {
      await navigator.clipboard.writeText(pedido.pix_copia_cola)
      setPixCopied(true)
      setTimeout(() => setPixCopied(false), 3000)
    } catch {
      // Fallback para ambientes sem clipboard API
    }
  }

  async function enviarAvaliacao() {
    if (nota < 1) { setErroAval('Escolha de 1 a 5 estrelas.'); return }
    setEnviandoAval(true)
    setErroAval(null)
    const { error } = await supabase.rpc('avaliar_pedido', {
      p_pedido_id: id, p_nota: nota, p_comentario: comentario,
    })
    setEnviandoAval(false)
    if (error) { setErroAval('Não foi possível enviar. Tente de novo.'); return }
    setPedido(prev => prev ? {
      ...prev,
      avaliacao_nota: nota,
      avaliacao_comentario: comentario.trim() || null,
      avaliacao_at: new Date().toISOString(),
    } : prev)
  }

  if (loading) {
    return (
      <div className="dpd-loading">
        <div className="dpd-spinner" />
        <p>Carregando pedido...</p>
      </div>
    )
  }

  if (!pedido) {
    return (
      <div className="dpd-loading">
        <p style={{ color: '#94a3b8' }}>Pedido não encontrado.</p>
      </div>
    )
  }

  const isCancelado = pedido.status === 'cancelado'
  const activeIdx = statusIndex(pedido.status)
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []

  return (
    <div className="dpd-root">
      <header className="dpd-header">
        <div className="dpd-header-inner">
          <button
            className="dpd-logo-btn"
            onClick={() => navigate(`/loja/${pedido.empresa_id}`)}
            title="Voltar à loja para pedir de novo"
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            {loja?.logo_url
              ? <img src={loja.logo_url} alt={loja.nome} style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'cover' }} />
              : <span style={{
                  width: 30, height: 30, borderRadius: 8, background: 'rgba(124,58,237,.25)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15,
                }}>{(loja?.nome ?? 'L').trim().charAt(0).toUpperCase()}</span>}
            <span className="dpd-logo" style={{ fontSize: 16 }}>{loja?.nome ?? 'Loja'}</span>
          </button>
          <div className="dpd-header-right">
            <span className="dpd-pedido-id">Pedido #{shortId(pedido.id)}</span>
            <button className="dpd-refresh-btn" onClick={fetchPedido} aria-label="Atualizar">
              <IconRefresh />
            </button>
          </div>
        </div>
      </header>

      <main className="dpd-main">
        {/* Timeline de status */}
        {!isCancelado ? (
          <section className="dpd-card dpd-card--timeline">
            <h2 className="dpd-card-title">Status do pedido</h2>
            <ol className="dpd-timeline" aria-label="Progresso do pedido">
              {STATUS_STEPS.map((step, i) => {
                const done = i < activeIdx
                const current = i === activeIdx
                const Icon = step.icon
                return (
                  <li key={step.key} className={`dpd-step${done ? ' dpd-step--done' : ''}${current ? ' dpd-step--current' : ''}`}>
                    <div className="dpd-step-icon-wrap">
                      <span className="dpd-step-icon">
                        <Icon />
                      </span>
                      {i < STATUS_STEPS.length - 1 && (
                        <span className={`dpd-step-line${done ? ' dpd-step-line--done' : ''}`} />
                      )}
                    </div>
                    <span className="dpd-step-label">{step.label}</span>
                  </li>
                )
              })}
            </ol>
            {['confirmado', 'em_preparo'].includes(pedido.status) && pedido.pronto_previsto_at && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '10px 12px',
                borderRadius: 12, background: '#ecfdf5', color: '#047857',
                fontSize: 14, fontWeight: 600,
              }}>
                <span style={{ display: 'flex', flexShrink: 0 }}><IconChef /></span>
                <span>
                  {(pedido.tipo_entrega || 'entrega') === 'retirada' ? 'Pronto para retirada' : 'Fica pronto'} por volta de{' '}
                  <strong>{new Date(pedido.pronto_previsto_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</strong>
                </span>
              </div>
            )}
            {lastUpdate && (
              <p className="dpd-update-time">
                Atualizado às {lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
          </section>
        ) : (
          <section className="dpd-card dpd-card--cancelado">
            <div className="dpd-cancelado-icon">
              <IconX />
            </div>
            <h2 className="dpd-cancelado-title">Pedido cancelado</h2>
            {pedido.motivo_cancelamento && (
              <p className="dpd-cancelado-motivo">{pedido.motivo_cancelamento}</p>
            )}
          </section>
        )}

        {/* Código de entrega — cliente informa ao entregador na chegada */}
        {!isCancelado && pedido.status === 'saiu_entrega' && pedido.codigo_entrega && (
          <section className="dpd-card" style={{ textAlign: 'center', border: '2px solid #7c3aed', background: 'rgba(124,58,237,.08)' }}>
            <h2 className="dpd-card-title" style={{ marginBottom: 6 }}>🛵 Seu pedido saiu para entrega</h2>
            <p style={{ fontSize: 13.5, color: '#94a3b8', margin: '0 0 10px' }}>
              Informe este código ao entregador para confirmar o recebimento:
            </p>
            <div style={{
              fontSize: 40, fontWeight: 800, letterSpacing: 10, color: '#7c3aed',
              fontVariantNumeric: 'tabular-nums', paddingLeft: 10,
            }}>
              {pedido.codigo_entrega}
            </div>
          </section>
        )}

        {/* Pedido entregue — confirmação + avaliação */}
        {pedido.status === 'entregue' && (
          <section className="dpd-card" style={{ border: '2px solid #16a34a', background: 'rgba(34,197,94,.07)' }}>
            <h2 className="dpd-card-title" style={{ textAlign: 'center', marginBottom: 4 }}>🎉 Pedido entregue!</h2>

            {pedido.avaliacao_nota ? (
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 14, color: '#16a34a', fontWeight: 700, margin: '6px 0' }}>Obrigado pela sua avaliação!</p>
                <div style={{ fontSize: 30, letterSpacing: 4 }}>
                  {[1, 2, 3, 4, 5].map(i => (
                    <span key={i} style={{ color: i <= pedido.avaliacao_nota ? '#f59e0b' : '#cbd5e1' }}>★</span>
                  ))}
                </div>
                {pedido.avaliacao_comentario && (
                  <p style={{ fontSize: 13.5, color: '#475569', fontStyle: 'italic', marginTop: 8 }}>
                    “{pedido.avaliacao_comentario}”
                  </p>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 13.5, color: '#64748b', margin: '4px 0 8px' }}>Que tal avaliar seu pedido?</p>
                <div style={{ fontSize: 38, lineHeight: 1 }}>
                  {[1, 2, 3, 4, 5].map(i => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => { setNota(i); setErroAval(null) }}
                      onMouseEnter={() => setHoverNota(i)}
                      onMouseLeave={() => setHoverNota(0)}
                      aria-label={`${i} estrela${i > 1 ? 's' : ''}`}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
                        fontSize: 38, lineHeight: 1,
                        color: i <= (hoverNota || nota) ? '#f59e0b' : '#cbd5e1',
                      }}
                    >★</button>
                  ))}
                </div>
                <textarea
                  value={comentario}
                  onChange={e => setComentario(e.target.value)}
                  placeholder="Deixe um comentário (opcional)"
                  rows={3}
                  style={{
                    width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10,
                    border: '1px solid #e2e8f0', background: '#fff', color: '#0f172a',
                    fontSize: 13.5, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
                  }}
                />
                {erroAval && <p style={{ fontSize: 12.5, color: '#dc2626', margin: '6px 0 0' }}>{erroAval}</p>}
                <button
                  type="button"
                  onClick={enviarAvaliacao}
                  disabled={enviandoAval}
                  style={{
                    width: '100%', marginTop: 10, padding: '12px 0', borderRadius: 10, border: 'none',
                    background: '#16a34a', color: '#fff', fontWeight: 800, fontSize: 15,
                    cursor: enviandoAval ? 'default' : 'pointer',
                  }}
                >
                  {enviandoAval ? 'Enviando...' : 'Enviar avaliação'}
                </button>
              </div>
            )}
          </section>
        )}

        {/* Pix pendente */}
        {pedido.forma_pagamento === 'pix' && pedido.pix_status === 'pendente' && !isCancelado && (
          <section className="dpd-card dpd-card--pix">
            {pedido.pix_qrcode ? (
              <>
                <h2 className="dpd-card-title">Pague com Pix</h2>
                <div className="dpd-pix-qr-wrap">
                  <img
                    src={`data:image/png;base64,${pedido.pix_qrcode}`}
                    alt="QR Code Pix"
                    className="dpd-pix-qr-img"
                  />
                </div>
                {pedido.pix_copia_cola && (
                  <div className="dpd-pix-copia-wrap">
                    <p className="dpd-pix-copia-label">Pix copia e cola</p>
                    <div className="dpd-pix-copia-row">
                      <span className="dpd-pix-copia-code">{pedido.pix_copia_cola}</span>
                      <button
                        className={`dpd-pix-copy-btn${pixCopied ? ' dpd-pix-copy-btn--done' : ''}`}
                        onClick={handleCopiarPix}
                        aria-label="Copiar código Pix"
                      >
                        {pixCopied ? 'Copiado!' : 'Copiar'}
                      </button>
                    </div>
                  </div>
                )}
                <p className="dpd-pix-aviso">Após o pagamento, o pedido será confirmado automaticamente.</p>
              </>
            ) : (
              <div className="dpd-pix-qr-placeholder">
                <IconStore />
                <p className="dpd-pix-msg">QR Code Pix em breve</p>
                <p className="dpd-pix-sub">O código de pagamento Pix será gerado em instantes.</p>
              </div>
            )}
          </section>
        )}

        {/* Resumo do pedido */}
        <section className="dpd-card">
          <h2 className="dpd-card-title">Resumo</h2>

          {itens.length > 0 && (
            <div className="dpd-itens">
              {itens.map((item, i) => (
                <div key={item.produto_id ?? i} className="dpd-item">
                  <span className="dpd-item-qty">{item.quantidade}x</span>
                  <span className="dpd-item-nome">{item.nome}</span>
                  <span className="dpd-item-sub">R$ {fmt(item.subtotal)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="dpd-totais">
            <div className="dpd-total-linha">
              <span>Subtotal</span>
              <span>R$ {fmt(pedido.subtotal)}</span>
            </div>
            <div className="dpd-total-linha">
              <span>Taxa de entrega</span>
              <span>{Number(pedido.taxa_entrega) === 0 ? 'Grátis' : `R$ ${fmt(pedido.taxa_entrega)}`}</span>
            </div>
            <div className="dpd-total-linha dpd-total-linha--total">
              <span>Total</span>
              <strong>R$ {fmt(pedido.total)}</strong>
            </div>
          </div>

          <div className="dpd-pagamento">
            <span className="dpd-pagamento-label">Pagamento</span>
            <span className="dpd-pagamento-val">{paymLabel(pedido.forma_pagamento)}</span>
            {pedido.troco_para && (
              <span className="dpd-troco">Troco para R$ {fmt(pedido.troco_para)}</span>
            )}
          </div>
        </section>

        {/* Endereço */}
        <section className="dpd-card">
          <h2 className="dpd-card-title">Endereço de entrega</h2>
          <address className="dpd-address">
            {pedido.endereco_rua}{pedido.endereco_numero ? `, ${pedido.endereco_numero}` : ''}
            {pedido.endereco_complemento && ` — ${pedido.endereco_complemento}`}
            {pedido.endereco_bairro && <><br />{pedido.endereco_bairro}</>}
            <br />{pedido.endereco_cidade}
          </address>
        </section>

        {pedido.observacoes && (
          <section className="dpd-card">
            <h2 className="dpd-card-title">Observações</h2>
            <p className="dpd-obs">{pedido.observacoes}</p>
          </section>
        )}

        {/* Conversa com a loja */}
        {pedido.empresa_id && pedido.cliente_telefone && (
          <ChatLojaOnline
            empresaId={pedido.empresa_id}
            telefone={pedido.cliente_telefone}
            nome={pedido.cliente_nome}
          />
        )}

        <p className="dpd-footer-note">
          Guarde este link para acompanhar seu pedido. Esta página atualiza automaticamente.
        </p>
      </main>
    </div>
  )
}
