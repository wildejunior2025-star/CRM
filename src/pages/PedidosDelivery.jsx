import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'
import './PedidosDelivery.css'
import { imprimirCupom } from '../utils/imprimirCupom'

const TIMER_LIMITE_MS = 7 * 60 * 1000 // 7 minutos
const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

// Data de hoje no formato YYYY-MM-DD (fuso local) — usada pra abrir a lista
// já filtrada no dia, batendo com o gestor.
function hojeISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ORIGEM_CONFIG = {
  whatsapp: { label: 'WhatsApp', bg: '#25d366', color: '#fff', borda: '#25d366' },
  cardapio:  { label: 'Cardápio', bg: '#3b82f6', color: '#fff', borda: '#3b82f6' },
  app:       { label: 'App',      bg: '#f97316', color: '#fff', borda: '#f97316' },
  ifood:     { label: 'iFood',    bg: '#ea1d2c', color: '#fff', borda: '#ea1d2c' },
  balcao:    { label: 'Balcão',   bg: '#0891b2', color: '#fff', borda: '#0891b2' },
}

const STATUS_CONFIG = {
  aguardando:    { label: 'Aguardando',       cor: '#f59e0b', bg: '#fef3c7', corDark: '#f59e0b', bgDark: 'rgba(245,158,11,0.15)' },
  confirmado:    { label: 'Confirmado',       cor: '#3b82f6', bg: '#eff6ff', corDark: '#60a5fa', bgDark: 'rgba(59,130,246,0.15)' },
  em_preparo:    { label: 'Em preparo',       cor: '#f97316', bg: '#fff7ed', corDark: '#fb923c', bgDark: 'rgba(249,115,22,0.15)' },
  saiu_entrega:  { label: 'Saiu p/ entrega', cor: '#7c3aed', bg: '#f5f3ff', corDark: '#a78bfa', bgDark: 'rgba(124,58,237,0.15)' },
  entregue:      { label: 'Entregue',         cor: '#10b981', bg: '#ecfdf5', corDark: '#34d399', bgDark: 'rgba(16,185,129,0.15)' },
  cancelado:     { label: 'Cancelado',        cor: '#ef4444', bg: '#fef2f2', corDark: '#f87171', bgDark: 'rgba(239,68,68,0.15)' },
}

const ABAS = [
  { id: 'aguardando', label: 'Aguardando', statuses: ['aguardando'] },
  { id: 'ativos',     label: 'Ativos',     statuses: ['confirmado', 'em_preparo', 'saiu_entrega'] },
  { id: 'concluidos', label: 'Concluídos', statuses: ['entregue'] },
  { id: 'cancelados', label: 'Cancelados', statuses: ['cancelado'] },
]

const CONFIG_KEY = 'venda_delivery_config'
const VIEW_MODE_KEY = 'delivery_view_mode'
const CONFIG_PADRAO = {
  autoAceitar: false,
  imprimirAuto: false,
  impressoraUrl: '',
  somAtivo: true,
}

function lerConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    return raw ? { ...CONFIG_PADRAO, ...JSON.parse(raw) } : { ...CONFIG_PADRAO }
  } catch {
    return { ...CONFIG_PADRAO }
  }
}

function salvarConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
}

function lerViewMode() {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) || 'tabela'
  } catch {
    return 'tabela'
  }
}

function tocarSom() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1)
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2)
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.5)
  } catch {
    // Web Audio não disponível — ignora silenciosamente
  }
}

function getTempoRestante(createdAt, aguardandoDesde) {
  const ref = aguardandoDesde ?? createdAt
  const elapsed = Date.now() - new Date(ref).getTime()
  return Math.max(0, TIMER_LIMITE_MS - elapsed)
}

function formatarTempo(ms) {
  const seg = Math.floor(ms / 1000)
  const m = Math.floor(seg / 60)
  const s = seg % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function enderecoCompleto(pedido) {
  const partes = [
    pedido.endereco_rua,
    pedido.endereco_numero,
    pedido.endereco_complemento,
    pedido.endereco_bairro,
    pedido.endereco_cidade,
  ].filter(Boolean)
  return partes.join(', ')
}

function imprimirPedido(pedido) {
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const dataHora = new Date(pedido.created_at).toLocaleString('pt-BR')
  const num = pedido.numero_pedido ? String(pedido.numero_pedido) : pedido.id.slice(-4).toUpperCase()
  const endereco = enderecoCompleto(pedido)

  const linhasItens = itens.map(it =>
    `<div style="display:flex;justify-content:space-between;margin:2px 0">
       <span>${it.quantidade}x ${it.nome}</span>
       <span>${fmt(it.subtotal)}</span>
     </div>`
  ).join('')

  const troco = pedido.forma_pagamento === 'dinheiro' && pedido.troco_para > 0
    ? `<div style="display:flex;justify-content:space-between"><span>Troco para</span><span>${fmt(pedido.troco_para)}</span></div>`
    : ''

  const obs = pedido.observacoes
    ? `<div class="sep"></div><div style="font-size:11px">Obs: ${pedido.observacoes}</div>`
    : ''

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @media print {
    body { width: 80mm; font-family: monospace; font-size: 12px; margin: 0; padding: 8px; }
    h2 { margin: 4px 0; font-size: 16px; }
    .sep { border-top: 1px dashed #000; margin: 6px 0; }
    .total { font-weight: bold; font-size: 14px; }
  }
  body { width: 80mm; font-family: monospace; font-size: 12px; margin: 0; padding: 8px; }
  h2 { margin: 4px 0; font-size: 16px; }
  .sep { border-top: 1px dashed #000; margin: 6px 0; }
  .total { font-weight: bold; font-size: 14px; }
</style>
</head>
<body>
<h2 style="text-align:center">FWC INTER</h2>
<div style="text-align:center;font-size:11px">Pedido #${num}</div>
<div style="text-align:center;font-size:11px">${dataHora}</div>
<div class="sep"></div>
<div>CLIENTE: ${pedido.cliente_nome || '—'}</div>
${pedido.cliente_telefone ? `<div>TEL: ${pedido.cliente_telefone}</div>` : ''}
${endereco ? `<div>END.: ${endereco}</div>` : ''}
<div class="sep"></div>
${linhasItens}
<div class="sep"></div>
${pedido.subtotal != null ? `<div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${fmt(pedido.subtotal)}</span></div>` : ''}
${pedido.taxa_entrega != null ? `<div style="display:flex;justify-content:space-between"><span>Taxa entrega</span><span>${fmt(pedido.taxa_entrega)}</span></div>` : ''}
<div style="display:flex;justify-content:space-between" class="total"><span>TOTAL</span><span>${fmt(pedido.total)}</span></div>
<div class="sep"></div>
<div>Pagamento: ${pedido.forma_pagamento?.toUpperCase() || '—'}</div>
${troco}
${obs}
</body>
</html>`

  // Imprime SILENCIOSO pelo app Impressora FWC (sem a janela do Chrome).
  // Só cai no navegador se o app FWC não estiver rodando. (html acima fica de reserva.)
  void html
  imprimirCupom(pedido)
}

// ─────────────────────────────────────────────
// Timer regressivo: renderiza apenas o tempo
// e dispara o callback ao chegar a zero.
// Componente separado para evitar re-render do card inteiro a cada tick.
// ─────────────────────────────────────────────
function TimerRegressivo({ createdAt, aguardandoDesde, onExpirado }) {
  const [restante, setRestante] = useState(() => getTempoRestante(createdAt, aguardandoDesde))
  const expiradoRef = useRef(false)

  useEffect(() => {
    if (restante === 0) {
      if (!expiradoRef.current) {
        expiradoRef.current = true
        onExpirado()
      }
      return
    }
    const id = setTimeout(() => setRestante(getTempoRestante(createdAt, aguardandoDesde)), 500)
    return () => clearTimeout(id)
  }, [restante, createdAt, aguardandoDesde, onExpirado])

  const pct = Math.round((restante / TIMER_LIMITE_MS) * 100)
  const critico = restante < 2 * 60 * 1000

  return (
    <div className="pd-timer">
      <div className="pd-timer-topo">
        <span className={`pd-timer-tempo ${critico ? 'critico' : ''}`}>
          {formatarTempo(restante)}
        </span>
        <span className="pd-timer-label">para aceitar</span>
      </div>
      <div className="pd-timer-barra-bg">
        <div
          className={`pd-timer-barra ${critico ? 'critico' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function tempoRelativo(dateStr) {
  const diff = Math.floor((Date.now() - new Date(dateStr)) / 1000)
  if (diff < 60)  return `há ${diff}s`
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `há ${Math.floor(diff / 3600)}h`
  return `há ${Math.floor(diff / 86400)}d`
}

function fmt(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || {}
  return (
    <span className="pd-badge" style={{ '--badge-cor': cfg.cor, '--badge-bg': cfg.bg }}>
      {cfg.label || status}
    </span>
  )
}

function OrigemBadge({ origem }) {
  const cfg = ORIGEM_CONFIG[origem] ?? ORIGEM_CONFIG.cardapio
  return (
    <span style={{
      background: cfg.bg, color: cfg.color,
      fontSize: 10, fontWeight: 700,
      padding: '2px 7px', borderRadius: 20,
      letterSpacing: '0.03em', flexShrink: 0,
    }}>
      {cfg.label}
    </span>
  )
}

function CardPedido({ pedido, onAtualizarStatus, onCancelar, onImprimirPedido, onExpirado }) {
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const pagamento = pedido.forma_pagamento || ''
  const origemCfg = ORIGEM_CONFIG[pedido.origem] ?? ORIGEM_CONFIG.cardapio

  return (
    <div className="pd-card" style={{ borderTop: `3px solid ${origemCfg.borda}` }}>
      <div className="pd-card-header">
        <div className="pd-card-header-left">
          <span className="pd-numero">#{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}</span>
          <OrigemBadge origem={pedido.origem} />
          <StatusBadge status={pedido.status} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="pd-tempo">{tempoRelativo(pedido.created_at)}</span>
          <button
            className="pd-btn-imprimir"
            title="Imprimir pedido"
            onClick={() => onImprimirPedido(pedido)}
            style={{ padding: '3px 7px', fontSize: 13 }}
          >
            Impr.
          </button>
        </div>
      </div>

      {pedido.status === 'aguardando' && (
        <TimerRegressivo
          createdAt={pedido.created_at}
          aguardandoDesde={pedido.aguardando_desde}
          onExpirado={() => onExpirado(pedido.id)}
        />
      )}

      <div className="pd-cliente">
        <span className="pd-cliente-nome">{pedido.cliente_nome || '—'}</span>
        {pedido.cliente_telefone && (
          <span className="pd-cliente-tel">{pedido.cliente_telefone}</span>
        )}
      </div>

      {enderecoCompleto(pedido) && (
        <div className="pd-endereco">{enderecoCompleto(pedido)}</div>
      )}

      {itens.length > 0 && (
        <ul className="pd-itens">
          {itens.map((item, i) => (
            <li key={i}>
              <span className="pd-item-qtd">{item.quantidade}x</span>
              <span className="pd-item-nome">{item.nome}</span>
              {item.subtotal != null && (
                <span className="pd-item-sub">{fmt(item.subtotal)}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="pd-totais">
        {pedido.subtotal != null && (
          <div className="pd-totais-row">
            <span>Subtotal</span>
            <span>{fmt(pedido.subtotal)}</span>
          </div>
        )}
        {pedido.taxa_entrega != null && (
          <div className="pd-totais-row">
            <span>Taxa de entrega</span>
            <span>{fmt(pedido.taxa_entrega)}</span>
          </div>
        )}
        <div className="pd-totais-row pd-totais-total">
          <span>Total</span>
          <span>{fmt(pedido.total)}</span>
        </div>
      </div>

      <div className="pd-pagamento-row">
        {pagamento === 'pix' && (
          <span className="pd-badge pd-badge-pix">Pix</span>
        )}
        {pagamento === 'dinheiro' && (
          <span className="pd-badge pd-badge-dinheiro">Dinheiro</span>
        )}
        {pagamento === 'dinheiro' && pedido.troco_para != null && pedido.troco_para > 0 && (
          <span className="pd-troco">Troco para {fmt(pedido.troco_para)}</span>
        )}
        {pagamento !== 'pix' && pagamento !== 'dinheiro' && pagamento && (
          <span className="pd-badge pd-badge-outro">{pagamento}</span>
        )}
      </div>

      {pedido.observacoes && (
        <div className="pd-obs">
          <span className="pd-obs-label">Obs:</span> {pedido.observacoes}
        </div>
      )}

      <AcoesPedido pedido={pedido} onAtualizarStatus={onAtualizarStatus} onCancelar={onCancelar} />
    </div>
  )
}

function AcoesPedido({ pedido, onAtualizarStatus, onCancelar }) {
  const { status } = pedido

  if (status === 'entregue' || status === 'cancelado') return null

  return (
    <div className="pd-acoes">
      {status === 'aguardando' && (
        <>
          <button
            className="btn pd-btn-confirmar"
            onClick={() => onAtualizarStatus(pedido.id, 'confirmado')}
          >
            Confirmar
          </button>
          <button
            className="btn pd-btn-cancelar"
            onClick={() => onCancelar(pedido)}
          >
            Cancelar
          </button>
        </>
      )}
      {status === 'confirmado' && (
        <button
          className="btn pd-btn-preparo"
          onClick={() => onAtualizarStatus(pedido.id, 'em_preparo')}
        >
          Em preparo
        </button>
      )}
      {status === 'em_preparo' && (
        <button
          className="btn pd-btn-entrega"
          onClick={() => onAtualizarStatus(pedido.id, 'saiu_entrega')}
        >
          Saiu para entrega
        </button>
      )}
      {status === 'saiu_entrega' && (
        <button
          className="btn pd-btn-entregue"
          onClick={() => onAtualizarStatus(pedido.id, 'entregue')}
        >
          Entregue
        </button>
      )}
    </div>
  )
}

function ModalCancelamento({ pedido, onConfirmar, onFechar }) {
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)

  async function handleConfirmar() {
    if (!motivo.trim()) return
    setEnviando(true)
    await onConfirmar(pedido.id, motivo.trim())
    setEnviando(false)
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Cancelar pedido #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}</h2>
        <div className="form-field">
          <label>Motivo do cancelamento</label>
          <textarea
            rows={4}
            value={motivo}
            onChange={e => setMotivo(e.target.value)}
            placeholder="Ex: Cliente solicitou cancelamento, item fora de estoque..."
            style={{ resize: 'vertical' }}
            autoFocus
          />
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onFechar}>Voltar</button>
          <button
            className="btn btn-danger"
            disabled={!motivo.trim() || enviando}
            onClick={handleConfirmar}
          >
            {enviando ? 'Cancelando...' : 'Cancelar pedido'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModalConfiguracoes({ config, onSalvar, onFechar }) {
  const [cfg, setCfg] = useState({ ...config })

  function toggle(campo) {
    setCfg(prev => ({ ...prev, [campo]: !prev[campo] }))
  }

  function handleSalvar() {
    salvarConfig(cfg)
    onSalvar(cfg)
    onFechar()
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal pd-modal-cfg" onClick={e => e.stopPropagation()}>
        <h2>Configuracoes da loja</h2>

        {/* Pedidos */}
        <div className="pd-cfg-secao">
          <div className="pd-cfg-titulo">Pedidos</div>
          <div className="pd-cfg-item">
            <div>
              <div className="pd-cfg-item-nome">Aceitar pedidos automaticamente</div>
              <div className="pd-cfg-item-desc">Ao chegar um novo pedido, confirma sem precisar clicar manualmente</div>
            </div>
            <button
              type="button"
              className={`pd-toggle ${cfg.autoAceitar ? 'ativo' : ''}`}
              onClick={() => toggle('autoAceitar')}
              aria-label="Toggle auto aceitar"
            >
              <span className="pd-toggle-thumb" />
            </button>
          </div>
        </div>

        {/* Som */}
        <div className="pd-cfg-secao">
          <div className="pd-cfg-titulo">Notificacao sonora</div>
          <div className="pd-cfg-item">
            <div>
              <div className="pd-cfg-item-nome">Tocar som ao receber pedido</div>
              <div className="pd-cfg-item-desc">Toca um aviso sonoro quando um novo pedido chegar</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={tocarSom}
              >
                Testar
              </button>
              <button
                type="button"
                className={`pd-toggle ${cfg.somAtivo ? 'ativo' : ''}`}
                onClick={() => toggle('somAtivo')}
                aria-label="Toggle som"
              >
                <span className="pd-toggle-thumb" />
              </button>
            </div>
          </div>
        </div>

        {/* Impressora */}
        <div className="pd-cfg-secao">
          <div className="pd-cfg-titulo">Impressora termica</div>
          <div className="pd-cfg-item">
            <div>
              <div className="pd-cfg-item-nome">Imprimir automaticamente ao aceitar pedido</div>
              <div className="pd-cfg-item-desc">Envia o cupom automaticamente quando o pedido for confirmado</div>
            </div>
            <button
              type="button"
              className={`pd-toggle ${cfg.imprimirAuto ? 'ativo' : ''}`}
              onClick={() => toggle('imprimirAuto')}
              aria-label="Toggle impressao auto"
            >
              <span className="pd-toggle-thumb" />
            </button>
          </div>
          <div className="form-field" style={{ marginTop: 10 }}>
            <label style={{ fontSize: 13 }}>URL da impressora</label>
            <input
              type="url"
              placeholder="http://localhost:9100"
              value={cfg.impressoraUrl}
              onChange={e => setCfg(prev => ({ ...prev, impressoraUrl: e.target.value }))}
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
              Configure o PrintNode ou QZ Tray para impressao automatica
            </span>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: 12, marginTop: 6 }}
            onClick={() => window.print()}
          >
            Testar impressao (janela atual)
          </button>
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onFechar}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSalvar}>Salvar</button>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ aba }) {
  const mensagens = {
    aguardando: { titulo: 'Nenhum pedido aguardando', sub: 'Novos pedidos aparecerao aqui em tempo real.' },
    ativos:     { titulo: 'Nenhum pedido ativo',      sub: 'Pedidos confirmados e em preparo aparecem aqui.' },
    concluidos: { titulo: 'Nenhum pedido concluido',  sub: 'Entregas realizadas ficarao registradas aqui.' },
    cancelados: { titulo: 'Nenhum pedido cancelado',  sub: 'Pedidos cancelados aparecem aqui para consulta.' },
  }
  const msg = mensagens[aba] || { titulo: 'Nenhum pedido', sub: '' }

  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
          <rect x="9" y="3" width="6" height="4" rx="1"/>
          <line x1="9" y1="12" x2="15" y2="12"/>
          <line x1="9" y1="16" x2="13" y2="16"/>
        </svg>
      </div>
      <strong>{msg.titulo}</strong>
      <p>{msg.sub}</p>
    </div>
  )
}

function DrawerDetalhe({ pedido, onFechar, onAtualizarStatus, onCancelar }) {
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const pagamento = pedido.forma_pagamento || ''
  const dataHora = new Date(pedido.created_at).toLocaleString('pt-BR')
  const endereco = enderecoCompleto(pedido)

  return (
    <div className="pd-drawer" role="dialog" aria-modal="true">
      {/* Cabeçalho */}
      <div className="pd-drawer-header">
        <div className="pd-drawer-titulo">
          <span className="pd-drawer-numero">#{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}</span>
          {pedido.origem === 'ifood' && pedido.ifood_display_id && (
            <span title="Código do pedido no iFood" style={{
              fontSize: 13, fontWeight: 800, color: '#ea1d2c',
              background: 'rgba(234,29,44,.12)', border: '1px solid #ea1d2c',
              borderRadius: 8, padding: '2px 8px', whiteSpace: 'nowrap',
            }}>
              iFood #{pedido.ifood_display_id}
            </span>
          )}
          <StatusBadge status={pedido.status} />
        </div>
        <button className="pd-drawer-fechar" onClick={onFechar} aria-label="Fechar">✕</button>
      </div>

      <hr className="pd-drawer-divider" />

      {/* Data e horário */}
      <div>
        <div className="pd-drawer-secao-label">Data e horário</div>
        <div className="pd-drawer-data">{dataHora}</div>
      </div>

      {/* Cliente */}
      <div>
        <div className="pd-drawer-secao-label">Cliente</div>
        <div className="pd-drawer-cliente-nome">{pedido.cliente_nome || '—'}</div>
        {pedido.cliente_telefone && (
          <div className="pd-drawer-cliente-tel">{pedido.cliente_telefone}</div>
        )}
      </div>

      {/* Endereço */}
      {endereco && (
        <div>
          <div className="pd-drawer-secao-label">Endereço de entrega</div>
          <div className="pd-drawer-endereco">{endereco}</div>
        </div>
      )}

      <hr className="pd-drawer-divider" />

      {/* Itens */}
      {itens.length > 0 && (
        <div>
          <div className="pd-drawer-secao-label">Itens do pedido</div>
          <ul className="pd-itens" style={{ marginTop: 6 }}>
            {itens.map((item, i) => (
              <li key={i}>
                <span className="pd-item-qtd">{item.quantidade}x</span>
                <span className="pd-item-nome">{item.nome}</span>
                {item.subtotal != null && (
                  <span className="pd-item-sub">{fmt(item.subtotal)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Totais */}
      <div className="pd-totais">
        {pedido.subtotal != null && (
          <div className="pd-totais-row">
            <span>Subtotal</span>
            <span>{fmt(pedido.subtotal)}</span>
          </div>
        )}
        {pedido.taxa_entrega != null && (
          <div className="pd-totais-row">
            <span>Taxa de entrega</span>
            <span>{fmt(pedido.taxa_entrega)}</span>
          </div>
        )}
        <div className="pd-totais-row pd-totais-total">
          <span>Total</span>
          <span>{fmt(pedido.total)}</span>
        </div>
      </div>

      <hr className="pd-drawer-divider" />

      {/* Pagamento */}
      <div>
        <div className="pd-drawer-secao-label">Forma de pagamento</div>
        <div className="pd-pagamento-row">
          {pagamento === 'pix' && <span className="pd-badge pd-badge-pix">Pix</span>}
          {pagamento === 'dinheiro' && <span className="pd-badge pd-badge-dinheiro">Dinheiro</span>}
          {pagamento === 'dinheiro' && pedido.troco_para != null && pedido.troco_para > 0 && (
            <span className="pd-troco">Troco para {fmt(pedido.troco_para)}</span>
          )}
          {pagamento !== 'pix' && pagamento !== 'dinheiro' && pagamento && (
            <span className="pd-badge pd-badge-outro">{pagamento}</span>
          )}
          {!pagamento && <span className="pd-troco">—</span>}
        </div>
      </div>

      {/* Observações */}
      {pedido.observacoes && (
        <div className="pd-obs">
          <span className="pd-obs-label">Obs:</span> {pedido.observacoes}
        </div>
      )}

      {/* Ações de status */}
      <AcoesPedido pedido={pedido} onAtualizarStatus={onAtualizarStatus} onCancelar={onCancelar} />
    </div>
  )
}

// ─── Ícone grade (cards) ───
function IconeGrade() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  )
}

// ─── Ícone lista (tabela) ───
function IconeLista() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  )
}

// ─── Tabela de pedidos ───
function TabelaPedidos({ pedidos, taxaPlataforma, onRowClick }) {
  const totalBruto = pedidos.reduce((acc, p) => acc + Number(p.total || 0), 0)
  const totalLiquido = pedidos.reduce((acc, p) => acc + Number(p.total || 0) * (1 - (taxaPlataforma ?? 5) / 100), 0)

  if (pedidos.length === 0) return null

  return (
    <div>
      <div className="data-table">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th>Nº Pedido</th>
              <th>Origem</th>
              <th>Data</th>
              <th>Horário</th>
              <th>Cliente</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th style={{ textAlign: 'right' }}>Líquido</th>
            </tr>
          </thead>
          <tbody>
            {pedidos.map(pedido => {
              const dt = new Date(pedido.created_at)
              const data = dt.toLocaleDateString('pt-BR')
              const hora = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
              const liquido = Number(pedido.total || 0) * (1 - (taxaPlataforma ?? 5) / 100)
              return (
                <tr key={pedido.id} style={{ cursor: 'pointer' }} onClick={() => onRowClick?.(pedido)}>
                  <td>
                    <span className="pd-tabela-num">
                      #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}
                    </span>
                  </td>
                  <td><OrigemBadge origem={pedido.origem} /></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>{data}</td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{hora}</td>
                  <td style={{ fontWeight: 500 }}>{pedido.cliente_nome || 'Anônimo'}</td>
                  <td>
                    <StatusBadge status={pedido.status} />
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                    {fmt(pedido.total)}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--success)' }}>
                    {fmt(liquido)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="pd-tabela-rodape">
        <span className="pd-tabela-rodape-count">{pedidos.length} pedido{pedidos.length !== 1 ? 's' : ''}</span>
        <span className="pd-tabela-rodape-sep" />
        <span>Total bruto: <strong>{fmt(totalBruto)}</strong></span>
        <span className="pd-tabela-rodape-sep" />
        <span>Total líquido: <strong style={{ color: 'var(--success)' }}>{fmt(totalLiquido)}</strong></span>
      </div>
    </div>
  )
}

export default function PedidosDelivery() {
  const { empresa } = useAuth()
  const [pedidos, setPedidos] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [abaAtiva, setAbaAtiva] = useState('aguardando')
  const [lojaAberta, setLojaAberta] = useState(false)
  const [togglingLoja, setTogglingLoja] = useState(false)
  const [pedidoCancelando, setPedidoCancelando] = useState(null)
  const [modalCfg, setModalCfg] = useState(false)
  const [config, setConfig] = useState(lerConfig)
  const [viewMode, setViewMode] = useState(lerViewMode)
  const [dataInicio, setDataInicio] = useState(hojeISO())
  const [dataFim, setDataFim] = useState(hojeISO())
  const [taxaPlataforma, setTaxaPlataforma] = useState(5)
  const [pedidoDetalhe, setPedidoDetalhe] = useState(null)
  const [filtroOrigem, setFiltroOrigem] = useState('todos')
  const [busca, setBusca] = useState('')

  // Mantém o drawer sincronizado quando o pedido é atualizado via Realtime
  useEffect(() => {
    if (!pedidoDetalhe) return
    const atualizado = pedidos.find(p => p.id === pedidoDetalhe.id)
    if (atualizado && atualizado !== pedidoDetalhe) setPedidoDetalhe(atualizado)
  }, [pedidos, pedidoDetalhe])

  // Ref para acessar config atualizada dentro do closure do Realtime sem re-subscribing
  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  // Persiste modo de visualização
  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  // ── Heartbeat: sinaliza que o painel está online ───────────
  useEffect(() => {
    if (!empresa) return
    async function heartbeat() {
      await supabase
        .from('empresas')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('id', empresa.id)
    }
    heartbeat()
    const timer = setInterval(heartbeat, 60_000)
    return () => clearInterval(timer)
  }, [empresa])

  useEffect(() => {
    if (!empresa) return
    setLojaAberta(empresa.delivery_ativo ?? false)
  }, [empresa])

  // ── Busca taxa da plataforma ──────────────────────────────
  useEffect(() => {
    if (!empresa) return
    async function buscarTaxa() {
      const { data: emp } = await supabase
        .from('empresas')
        .select('taxa_plataforma')
        .eq('id', empresa.id)
        .single()
      setTaxaPlataforma(emp?.taxa_plataforma ?? 5)
    }
    buscarTaxa()
  }, [empresa])

  const carregarPedidos = useCallback(async () => {
    if (!empresa) return
    setCarregando(true)
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('empresa_id', empresa.id)
      .order('created_at', { ascending: false })
      .limit(100)
    setPedidos(data || [])
    setCarregando(false)
  }, [empresa])

  useEffect(() => {
    if (!empresa) return
    carregarPedidos()

    const channel = supabase
      .channel('pedidos_delivery_' + empresa.id)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'pedidos_delivery',
        filter: `empresa_id=eq.${empresa.id}`,
      }, async (payload) => {
        if (payload.eventType === 'INSERT') {
          const novoPedido = payload.new
          setPedidos(prev => [novoPedido, ...prev])

          if (novoPedido.status === 'aguardando') {
            const cfg = configRef.current
            if (cfg.somAtivo) tocarSom()

            if (cfg.autoAceitar) {
              await supabase
                .from('pedidos_delivery')
                .update({ status: 'confirmado' })
                .eq('id', novoPedido.id)
              if (cfg.imprimirAuto) imprimirPedido(novoPedido)
            }
          }
        } else if (payload.eventType === 'UPDATE') {
          setPedidos(prev => prev.map(p => p.id === payload.new.id ? payload.new : p))
        } else if (payload.eventType === 'DELETE') {
          setPedidos(prev => prev.filter(p => p.id !== payload.old.id))
        }
      })
      .subscribe()

    return () => { channel.unsubscribe() }
  }, [empresa, carregarPedidos])

  async function handleAtualizarStatus(id, novoStatus) {
    const update = { status: novoStatus }

    // Gera código de confirmação de 4 dígitos ao despachar para entrega/retirada.
    // O cliente mostra esse código ao entregador (ou na retirada) para confirmar o pedido.
    if (novoStatus === 'saiu_entrega') {
      update.codigo_entrega = String(Math.floor(1000 + Math.random() * 9000))
    }

    await supabase
      .from('pedidos_delivery')
      .update(update)
      .eq('id', id)

    // Imprime automaticamente ao confirmar (se configurado)
    if (novoStatus === 'confirmado' && config.imprimirAuto) {
      const pedido = pedidos.find(p => p.id === id)
      if (pedido) imprimirPedido(pedido)
    }
  }

  async function handleConfirmarCancelamento(id, motivo) {
    await supabase
      .from('pedidos_delivery')
      .update({ status: 'cancelado', motivo_cancelamento: motivo })
      .eq('id', id)
    setPedidoCancelando(null)
  }

  async function handleExpirado(id) {
    const pedido = pedidos.find(p => p.id === id)

    if (pedido?.mp_payment_id) {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch(`${SUPABASE_URL}/functions/v1/refund-pix`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ order_id: id, motivo: 'Tempo de aceite esgotado' }),
      })
    } else {
      await supabase
        .from('pedidos_delivery')
        .update({ status: 'cancelado', motivo_cancelamento: 'Tempo de aceite esgotado' })
        .eq('id', id)
        .eq('status', 'aguardando')
    }
  }

  async function handleToggleLoja() {
    if (!empresa || togglingLoja) return
    setTogglingLoja(true)
    const novoValor = !lojaAberta
    const { error } = await supabase
      .from('empresas')
      .update({ delivery_ativo: novoValor })
      .eq('id', empresa.id)
    if (!error) setLojaAberta(novoValor)
    setTogglingLoja(false)
  }

  if (!empresa) return null

  const abaConfig = ABAS.find(a => a.id === abaAtiva)

  // ── Busca por código/cliente: quando ativa, varre TODAS as abas, origens e datas ──
  const buscaLimpa = busca.trim().toLowerCase()
  const casaBusca = p => {
    if (!buscaLimpa) return true
    const campos = [p.numero_pedido, p.ifood_display_id, p.codigo_entrega, p.cliente_nome, p.cliente_telefone, String(p.id || '').slice(-4)]
    return campos.filter(Boolean).join(' ').toLowerCase().includes(buscaLimpa)
  }
  // ── Filtro por aba/origem/data (a busca, quando ativa, ignora todos eles) ──
  const pedidosPorAba = buscaLimpa ? pedidos : pedidos.filter(p => abaConfig?.statuses.includes(p.status))
  const pedidosFiltrados = pedidosPorAba.filter(p => {
    if (buscaLimpa) return casaBusca(p)
    if (filtroOrigem !== 'todos') {
      const origem = p.origem ?? 'cardapio'
      if (origem !== filtroOrigem) return false
    }
    if (!dataInicio && !dataFim) return true
    const dt = new Date(p.created_at)
    const dtStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    if (dataInicio && dtStr < dataInicio) return false
    if (dataFim && dtStr > dataFim) return false
    return true
  })

  const totalAguardando = pedidos.filter(p => p.status === 'aguardando' && (filtroOrigem === 'todos' || (p.origem ?? 'cardapio') === filtroOrigem)).length
  const temFiltroData = dataInicio || dataFim

  return (
    <div>
      <div className="page-header">
        <div className="pd-titulo-wrap">
          <h1>Pedidos Delivery</h1>
          {totalAguardando > 0 && (
            <span className="pd-badge-pulsante">{totalAguardando}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="pd-view-toggle">
            <button
              className={`pd-view-btn ${viewMode === 'cards' ? 'ativo' : ''}`}
              title="Visualização em cards"
              aria-label="Modo cards"
              onClick={() => setViewMode('cards')}
            >
              <IconeGrade />
            </button>
            <button
              className={`pd-view-btn ${viewMode === 'tabela' ? 'ativo' : ''}`}
              title="Visualização em tabela"
              aria-label="Modo tabela"
              onClick={() => setViewMode('tabela')}
            >
              <IconeLista />
            </button>
          </div>
          <button
            className="btn btn-secondary pd-btn-cfg"
            onClick={() => setModalCfg(true)}
            title="Configuracoes"
          >
            Conf.
          </button>
          <button
            className={`pd-toggle-loja ${lojaAberta ? 'aberta' : 'fechada'}`}
            onClick={handleToggleLoja}
            disabled={togglingLoja}
          >
            <span className="pd-toggle-dot" />
            {lojaAberta ? 'Loja aberta' : 'Loja fechada'}
          </button>
        </div>
      </div>

      {/* ── Filtro de data ── */}
      <div className="pd-filtros">
        <span className="pd-filtros-label">Período:</span>
        <input
          type="date"
          value={dataInicio}
          onChange={e => setDataInicio(e.target.value)}
          title="Data início"
        />
        <span className="pd-filtros-sep">até</span>
        <input
          type="date"
          value={dataFim}
          onChange={e => setDataFim(e.target.value)}
          title="Data fim"
        />
        {temFiltroData && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { setDataInicio(''); setDataFim('') }}
          >
            Limpar
          </button>
        )}
      </div>

      {/* ── Busca por código/cliente (varre todas as abas, origens e datas) ── */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', maxWidth: 480, marginBottom: 12 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', left: 12, pointerEvents: 'none' }} aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          value={busca}
          onChange={e => setBusca(e.target.value)}
          placeholder="Buscar por cód. iFood, nº do pedido ou cliente — em todas as abas"
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
      {buscaLimpa && (
        <div style={{ fontSize: 12.5, color: 'var(--primary)', fontWeight: 700, marginBottom: 10 }}>
          🔎 Buscando em todas as abas e origens — {pedidosFiltrados.length} resultado{pedidosFiltrados.length === 1 ? '' : 's'}
        </div>
      )}

      {/* ── Filtro de origem ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {[
          { id: 'todos', label: 'Todos' },
          { id: 'ifood',     label: 'iFood',     ...ORIGEM_CONFIG.ifood },
          { id: 'whatsapp', label: 'WhatsApp', ...ORIGEM_CONFIG.whatsapp },
          { id: 'cardapio',  label: 'Cardápio',  ...ORIGEM_CONFIG.cardapio },
          { id: 'app',       label: 'App',        ...ORIGEM_CONFIG.app },
          { id: 'balcao',    label: 'Balcão',    ...ORIGEM_CONFIG.balcao },
        ].map(opt => {
          const ativo = filtroOrigem === opt.id
          const countOrigem = pedidos.filter(p => {
            const o = p.origem ?? 'cardapio'
            return opt.id === 'todos' ? true : o === opt.id
          }).length
          return (
            <button
              key={opt.id}
              onClick={() => setFiltroOrigem(opt.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 20, fontSize: 13, fontWeight: 600,
                cursor: 'pointer',
                border: ativo
                  ? `2px solid ${opt.bg ?? 'var(--primary)'}`
                  : '2px solid var(--border)',
                background: ativo ? (opt.bg ?? 'var(--primary)') : 'transparent',
                color: ativo ? (opt.color ?? '#fff') : 'var(--text)',
                transition: 'all 120ms',
              }}
            >
              {opt.label}
              {countOrigem > 0 && (
                <span style={{
                  background: ativo ? 'rgba(255,255,255,0.25)' : 'var(--border)',
                  color: ativo ? '#fff' : 'var(--text-muted)',
                  borderRadius: 10, padding: '0 6px', fontSize: 11, fontWeight: 700,
                }}>
                  {countOrigem}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="pd-abas">
        {ABAS.map(aba => {
          const count = pedidos.filter(p => {
            if (!aba.statuses.includes(p.status)) return false
            if (filtroOrigem !== 'todos') {
              const o = p.origem ?? 'cardapio'
              if (o !== filtroOrigem) return false
            }
            return true
          }).length
          return (
            <button
              key={aba.id}
              className={`pd-aba ${abaAtiva === aba.id ? 'ativa' : ''}`}
              onClick={() => setAbaAtiva(aba.id)}
            >
              {aba.label}
              {count > 0 && <span className="pd-aba-count">{count}</span>}
            </button>
          )
        })}
      </div>

      {carregando ? (
        <div className="pd-grid">
          {[1, 2, 3].map(i => (
            <div key={i} className="pd-card pd-card-skeleton">
              <div className="skeleton-row" style={{ width: '40%', marginBottom: 12 }} />
              <div className="skeleton-row" style={{ width: '70%', marginBottom: 8 }} />
              <div className="skeleton-row" style={{ width: '55%', marginBottom: 8 }} />
              <div className="skeleton-row" style={{ width: '30%' }} />
            </div>
          ))}
        </div>
      ) : pedidosFiltrados.length === 0 ? (
        <EmptyState aba={abaAtiva} />
      ) : viewMode === 'tabela' ? (
        <TabelaPedidos pedidos={pedidosFiltrados} taxaPlataforma={taxaPlataforma} onRowClick={setPedidoDetalhe} />
      ) : (
        <div className="pd-grid">
          {pedidosFiltrados.map(pedido => (
            <CardPedido
              key={pedido.id}
              pedido={pedido}
              onAtualizarStatus={handleAtualizarStatus}
              onCancelar={p => setPedidoCancelando(p)}
              onImprimirPedido={imprimirPedido}
              onExpirado={handleExpirado}
            />
          ))}
        </div>
      )}

      {pedidoCancelando && (
        <ModalCancelamento
          pedido={pedidoCancelando}
          onConfirmar={handleConfirmarCancelamento}
          onFechar={() => setPedidoCancelando(null)}
        />
      )}

      {modalCfg && (
        <ModalConfiguracoes
          config={config}
          onSalvar={setConfig}
          onFechar={() => setModalCfg(false)}
        />
      )}

      {/* Drawer de detalhe — visível apenas no modo tabela */}
      {pedidoDetalhe && (
        <>
          <div className="pd-drawer-overlay" onClick={() => setPedidoDetalhe(null)} />
          <DrawerDetalhe
            pedido={pedidoDetalhe}
            onFechar={() => setPedidoDetalhe(null)}
            onAtualizarStatus={handleAtualizarStatus}
            onCancelar={p => { setPedidoDetalhe(null); setPedidoCancelando(p) }}
          />
        </>
      )}
    </div>
  )
}
