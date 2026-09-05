import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { adicionalComplementos } from '../lib/complementos'
import { precoPorQuantidade, faixaAplicada, menorFaixa } from '../lib/precoQuantidade'
import { aguardandoHora, rotuloAgendado } from '../lib/agendamento'
import { imprimirCupom, autoImprimirAtivo, imprimirHtml, montarComandaCozinhaHtml, montarContaPresencialHtml, imprimirComandaMesaApp } from '../utils/imprimirCupom'
import { rotuloComanda } from '../lib/comanda'
import { useChamados } from '../hooks/useChamados'
import { calcularTaxa } from '../lib/taxaServico'
import { fwcFetch, explicaErroFwc } from '../lib/appFwc'
import Caixa from './Caixa'

// "558498180774" -> "(84) 9818-0774"
function foneBonito(p) {
  const d = String(p || '').replace(/\D/g, '')
  const n = d.startsWith('55') ? d.slice(2) : d
  if (n.length < 10) return p || ''
  return `(${n.slice(0, 2)}) ${n.slice(2, -4)}-${n.slice(-4)}`
}

// Aceitar pedidos automaticamente (lido do localStorage pra não pegar estado
// velho dentro do handler de realtime).
function aceitarAutoAtivo() {
  try { return JSON.parse(localStorage.getItem('painelConfig') || '{}').aceitarAuto === true }
  catch { return false }
}
import { FORMAS_PAGAMENTO, formasAtivas } from '../lib/constants'
import { separarItem } from '../lib/itensPedido'
import { semAcento } from '../lib/texto'
import { exigeCodigoEntrega, novoCodigoEntrega } from '../lib/codigoEntrega'
import { abertaAgora, comoFicaNoDia, carregarExcecoes, hojeBR } from '../lib/feriados'
// Sistema de salão embutido no gestor (Mesas): salão, reservas e config de mesas.
import PresencialSalao from './PresencialSalao'
import PresencialReservas from './PresencialReservas'
import PresencialMesas from './PresencialMesas'
import PresencialHistorico from './PresencialHistorico'
import PresencialCozinha from './PresencialCozinha'
import './PainelPedidos.css'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''


// ── Constantes ─────────────────────────────────────────────
const TIMER_LIMITE_MS = 7 * 60 * 1000 // 7 minutos

// Limite para concluir automaticamente um pedido que saiu para entrega
// e nunca teve o código de confirmação digitado.
const AUTO_CONCLUIR_ENTREGA_MS = 6 * 60 * 60 * 1000 // 6 horas

// Status que encerram o ciclo — pedido sai do painel
const STATUS_FINALIZADOS = new Set(['entregue', 'cancelado'])

// Progressão de status por tipo de entrega
const PROXIMO_STATUS = {
  aguardando:   'confirmado',
  confirmado:   'em_preparo',
  em_preparo:   'saiu_entrega', // para retirada: overridden no botão
  saiu_entrega: 'entregue',
}

const LABEL_STATUS = {
  aguardando:   'Aguardando',
  confirmado:   'Preparando',
  em_preparo:   'Preparando',
  pronto:       'Pronto p/ entrega',
  saiu_entrega: 'Saiu p/ entrega',
  entregue:     'Entregue',
  cancelado:    'Cancelado',
}

const BADGE_STATUS_COR = {
  aguardando:   { bg: 'rgba(234,179,8,.18)',  color: '#ca8a04' },
  confirmado:   { bg: 'rgba(59,130,246,.15)', color: '#1d4ed8' },
  em_preparo:   { bg: 'rgba(59,130,246,.15)', color: '#1d4ed8' },
  pronto:       { bg: 'rgba(13,148,136,.15)', color: '#0d9488' },
  saiu_entrega: { bg: 'rgba(124,58,237,.15)', color: '#7c3aed' },
  entregue:     { bg: 'rgba(34,197,94,.15)',  color: '#16a34a' },
  cancelado:    { bg: 'rgba(239,68,68,.15)',  color: '#dc2626' },
}

// ── Utilidades ─────────────────────────────────────────────
// A hora combinada ainda não chegou? Enquanto isso o pedido agendado NÃO tem
// relógio de aceite: com a loja fechada não tem ninguém pra clicar, e o timer
// cancelava sozinho ("Tempo de aceite esgotado") o pedido que o cliente deixou
// marcado pra mais tarde.
function agendadoAindaVai(pedido) {
  if (!pedido?.agendado_para) return false
  const t = new Date(pedido.agendado_para).getTime()
  return !Number.isNaN(t) && t > Date.now()
}

// De quando começa a contar o tempo de aceite. No agendado é da HORA COMBINADA:
// contar da criação faria o pedido feito de manhã nascer expirado à tarde.
function inicioDoAceite(pedido) {
  return relogioDoPedido(pedido) || pedido?.aguardando_desde || pedido?.created_at
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
  return [
    pedido.endereco_rua,
    pedido.endereco_numero,
    pedido.endereco_complemento,
    pedido.endereco_bairro,
    pedido.endereco_cidade,
  ].filter(Boolean).join(', ')
}

function fmt(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// AudioContext único — criado na primeira interação do usuário e reutilizado
let _audioCtx = null

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    // Desbloqueia no primeiro gesto (clique, toque, teclado)
    const unlock = () => {
      if (_audioCtx.state === 'suspended') _audioCtx.resume()
    }
    document.addEventListener('click', unlock, { once: false })
    document.addEventListener('keydown', unlock, { once: false })
    document.addEventListener('touchstart', unlock, { once: false })
  }
  return _audioCtx
}

function tocarSom() {
  try {
    const ctx = getAudioCtx()
    if (ctx.state === 'suspended') ctx.resume()

    // 3 bipes curtos em sequência
    const bipes = [0, 0.18, 0.36]
    bipes.forEach(offset => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.setValueAtTime(880, ctx.currentTime + offset)
      gain.gain.setValueAtTime(0.28, ctx.currentTime + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.14)
      osc.start(ctx.currentTime + offset)
      osc.stop(ctx.currentTime + offset + 0.14)
    })
  } catch {
    // Web Audio não disponível — ignora silenciosamente
  }
}

function getUrgencia(ms) {
  if (ms > 3 * 60 * 1000) return 'ok'
  if (ms > 60 * 1000)     return 'atencao'
  return 'critico'
}

// ── Timer regressivo ────────────────────────────────────────
// Componente isolado: só re-renderiza a si mesmo a cada tick,
// evitando re-render do card inteiro.
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
  const urgencia = getUrgencia(restante)

  return (
    <div className="pp-timer">
      <div className="pp-timer-row">
        <span className={`pp-timer-tempo ${urgencia}`}>
          {formatarTempo(restante)}
        </span>
        <span className="pp-timer-label">para aceitar</span>
      </div>
      <div className="pp-timer-barra-bg">
        <div
          className={`pp-timer-barra ${urgencia}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Modal de recusa ─────────────────────────────────────────
function ModalRecusa({ pedido, onConfirmar, onFechar }) {
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)

  async function handleConfirmar() {
    const m = motivo.trim()
    if (!m) return
    setEnviando(true)
    await onConfirmar(pedido.id, m)
    setEnviando(false)
  }

  // Fecha ao pressionar Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onFechar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  return (
    <div className="pp-modal-overlay" onClick={onFechar}>
      <div className="pp-modal" onClick={e => e.stopPropagation()}>
        <div>
          <p className="pp-modal-titulo">
            Recusar pedido #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}
          </p>
          <p className="pp-modal-sub">
            Informe o motivo — o cliente sera notificado.
          </p>
        </div>
        {(pedido.pix_status === 'pago' || pedido.mp_payment_status === 'approved') && (
          <div className="pp-modal-pix-aviso">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Este pedido foi pago via PIX. O reembolso sera processado automaticamente pelo Mercado Pago.</span>
          </div>
        )}
        <div className="pp-modal-field">
          <label className="pp-modal-label">Motivo do cancelamento</label>
          <textarea
            className="pp-modal-textarea"
            rows={4}
            value={motivo}
            onChange={e => setMotivo(e.target.value)}
            placeholder="Ex: Item fora de estoque, area nao atendida, loja fechando..."
            autoFocus
          />
        </div>
        <div className="pp-modal-actions">
          <button
            type="button"
            className="pp-modal-btn-secondary"
            onClick={onFechar}
          >
            Voltar
          </button>
          <button
            type="button"
            className="pp-modal-btn-danger"
            disabled={!motivo.trim() || enviando}
            onClick={handleConfirmar}
          >
            {enviando ? 'Recusando...' : 'Recusar pedido'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal de aceite (tempo de preparo) ──────────────────────
const PRESETS_PREPARO = [10, 15, 20, 30, 45, 60]

function ModalAceitar({ pedido, onConfirmar, onFechar }) {
  const [min, setMin] = useState(30)
  const [salvando, setSalvando] = useState(false)
  // Horário previsto calculado fora do render (Date.now é impuro em render)
  const [previsao, setPrevisao] = useState('')

  useEffect(() => {
    if (min == null) { setPrevisao(''); return }
    setPrevisao(new Date(Date.now() + min * 60000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
  }, [min])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  async function confirmar() {
    setSalvando(true)
    await onConfirmar(pedido.id, min)
    setSalvando(false)
  }

  const isRetirada = (pedido.tipo_entrega || 'entrega') === 'retirada'

  return (
    <div className="pp-modal-overlay" onClick={onFechar}>
      <div className="pp-modal" onClick={e => e.stopPropagation()}>
        <div>
          <p className="pp-modal-titulo">
            Aceitar pedido #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}
          </p>
          <p className="pp-modal-sub">
            Em quanto tempo {isRetirada ? 'fica pronto para retirada' : 'fica pronto'}? O cliente acompanha na tela dele.
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '6px 0 14px' }}>
          {PRESETS_PREPARO.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setMin(p)}
              style={{
                padding: '8px 14px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                border: `1.5px solid ${min === p ? '#16a34a' : 'var(--border, #2a2a3a)'}`,
                background: min === p ? 'rgba(34,197,94,.14)' : 'transparent',
                color: min === p ? '#16a34a' : 'var(--text)',
              }}
            >
              {p} min
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMin(null)}
            style={{
              padding: '8px 14px', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
              border: `1.5px solid ${min === null ? '#7c3aed' : 'var(--border, #2a2a3a)'}`,
              background: min === null ? 'rgba(124,58,237,.14)' : 'transparent',
              color: min === null ? '#a78bfa' : 'var(--text)',
            }}
          >
            Sem estimativa
          </button>
        </div>

        {min !== null && previsao && (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px' }}>
            Fica pronto por volta de{' '}
            <strong style={{ color: 'var(--text)' }}>{previsao}</strong>
          </p>
        )}

        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={onFechar}>Voltar</button>
          <button
            type="button"
            className="pp-modal-btn-danger"
            style={{ background: '#16a34a', borderColor: '#16a34a' }}
            disabled={salvando}
            onClick={confirmar}
          >
            {salvando ? 'Aceitando...' : 'Aceitar pedido'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal de mensagem ───────────────────────────────────────
const MSGS_RAPIDAS = [
  'Seu pedido está sendo preparado! 🍽️',
  'Seu pedido saiu para entrega! 🛵',
  'Estamos com um pequeno atraso, mas já estamos a caminho! 😊',
  'Problema com seu pedido? Pode nos falar aqui! 😊',
]

function ModalMensagem({ pedido, onEnviar, onFechar }) {
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  async function handleEnviar() {
    const msg = texto.trim()
    if (!msg) return
    setEnviando(true)
    setErro(null)
    const ok = await onEnviar(pedido, msg)
    setEnviando(false)
    if (ok) onFechar()
    else setErro('Não foi possível enviar. Verifique se o WhatsApp está conectado.')
  }

  return (
    <div className="pp-modal-overlay" onClick={onFechar}>
      <div className="pp-modal" onClick={e => e.stopPropagation()}>
        <p className="pp-modal-titulo">
          Enviar mensagem para {pedido.cliente_nome || pedido.cliente_telefone}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {MSGS_RAPIDAS.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setTexto(m)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid var(--border)',
                background: texto === m ? 'var(--primary)' : 'transparent',
                color: texto === m ? '#fff' : 'var(--text)',
                cursor: 'pointer',
              }}
            >{m}</button>
          ))}
        </div>
        <div className="pp-modal-field">
          <label className="pp-modal-label">Ou escreva uma mensagem</label>
          <textarea
            className="pp-modal-textarea"
            rows={3}
            value={texto}
            onChange={e => setTexto(e.target.value)}
            placeholder="Digite sua mensagem..."
            autoFocus
          />
        </div>
        {erro && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }}>{erro}</p>}
        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={onFechar}>Cancelar</button>
          <button
            type="button"
            className="pp-modal-btn-danger"
            style={{ background: '#25d366', borderColor: '#25d366' }}
            disabled={!texto.trim() || enviando}
            onClick={handleEnviar}
          >
            {enviando ? 'Enviando...' : 'Enviar pelo WhatsApp'}
          </button>
        </div>
      </div>
    </div>
  )
}

const ORIGEM_CONFIG = {
  whatsapp: { label: 'WhatsApp', bg: '#25d366', color: '#fff', borda: '#25d366' },
  cardapio:  { label: 'Cardápio', bg: '#3b82f6', color: '#fff', borda: '#3b82f6' },
  app:       { label: 'App',      bg: '#f97316', color: '#fff', borda: '#f97316' },
  balcao:    { label: 'Balcão',   bg: '#0891b2', color: '#fff', borda: '#0891b2' },
  ifood:     { label: 'iFood',    bg: '#ea1d2c', color: '#fff', borda: '#ea1d2c' },
}

// Campo de quantidade digitável (permite digitar 100 em vez de clicar 100x).
// Mantém um texto local para deixar apagar/retypear sem sumir o item.
function QtdInput({ value, onChange }) {
  const [txt, setTxt] = useState(String(value))
  useEffect(() => { setTxt(String(value)) }, [value])
  return (
    <input
      type="text"
      inputMode="numeric"
      value={txt}
      onChange={e => {
        const v = e.target.value.replace(/\D/g, '')
        setTxt(v)
        if (v !== '') onChange(parseInt(v, 10))
      }}
      onFocus={e => e.target.select()}
      onBlur={() => { if (txt === '') setTxt(String(value)) }}
      style={{
        width: 52, height: 30, textAlign: 'center', fontWeight: 700, fontSize: 14,
        borderRadius: 7, border: '1px solid var(--border, #2a2a3a)',
        background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
      }}
    />
  )
}

// Rascunho do cadastro de cliente: sair da tela no meio não pode apagar o que
// já foi digitado. No celular isso acontece à toa — basta abrir o WhatsApp pra
// conferir o telefone do cliente que o app recarrega e a ficha volta em branco.
//
// O rascunho só some quando o cliente é salvo ou quando o vendedor clica em
// Cancelar. Fechar sem querer (clique fora, Esc) preserva.
const draftKeyCliente = (empresaId) => (empresaId ? `pp-cliente-draft-${empresaId}` : null)
function lerDraftCliente(empresaId) {
  const k = draftKeyCliente(empresaId)
  if (!k) return null
  try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null }
}
function apagarDraftCliente(empresaId) {
  const k = draftKeyCliente(empresaId)
  if (k) { try { localStorage.removeItem(k) } catch { /* ignore */ } }
}
function clienteTemAlgoDigitado(form) {
  return Object.values(form || {}).some(v => String(v ?? '').trim())
}
// Nome e telefone o vendedor já enxerga na tela da venda: reabrir a ficha por
// causa deles só atrapalharia. O que dói perder é o endereço — é ele que manda
// o cadastro voltar sozinho.
function draftClienteTemEndereco(form) {
  return ['cep', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'estado']
    .some(c => String(form?.[c] ?? '').trim())
}

// ── Cadastro rápido de cliente no balcão ──
function ModalNovoCliente({ empresa, initialNome = '', initialTel = '', onFechar, onSalvo }) {
  // Cadastro de balcão: nome, telefone e endereço, numa tela só.
  //
  // Antes eram duas etapas com a ficha comercial inteira — tipo de cliente,
  // CNPJ, dia de visita, condição de pagamento, limite de crédito, desconto
  // autorizado, pedido mínimo, observações. Isso serve pra carteira de
  // atacado, não pra quem está com o cliente na frente e a fila andando.
  //
  // Os campos tirados NÃO sumiram do banco: todos têm valor padrão na coluna
  // (tipo 'mercadinho', condição 'à vista', ativo true, zeros), então o
  // cadastro sai exatamente igual ao que saía antes — só não é mais perguntado.
  const [form, setForm] = useState(() => {
    const vazio = {
      nome: initialNome, telefone: initialTel,
      cep: '', endereco: '', numero: '', complemento: '', bairro: '', cidade: '', estado: '',
    }
    // O rascunho só volta se for do MESMO cliente. Se o vendedor digitou outro
    // nome na venda, reabrir a ficha de antes é pior que começar do zero.
    const d = lerDraftCliente(empresa?.id)
    const inicial = String(initialNome || '').trim().toLowerCase()
    const mesmo = d && (!inicial || String(d.nome ?? '').toLowerCase().startsWith(inicial))
    return mesmo ? { ...vazio, ...d } : vazio
  })
  const [saving, setSaving] = useState(false)
  const [erro, setErro]     = useState(null)
  const [buscandoCep, setBuscandoCep] = useState(false)

  // Ao digitar o CEP completo, puxa endereço/bairro/cidade/UF (ViaCEP).
  async function buscarCep(cepRaw) {
    const cep = (cepRaw || '').replace(/\D/g, '')
    if (cep.length !== 8) return
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`)
      const d = await res.json()
      if (!d.erro) {
        setForm(p => ({ ...p,
          endereco: d.logradouro || p.endereco,
          bairro: d.bairro || p.bairro,
          cidade: d.localidade || p.cidade,
          estado: d.uf || p.estado,
        }))
      }
    } catch { /* CEP offline — segue manual */ }
    setBuscandoCep(false)
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  // Guarda o que já foi digitado a cada tecla.
  useEffect(() => {
    if (!empresa?.id) return
    if (!clienteTemAlgoDigitado(form)) { apagarDraftCliente(empresa.id); return }
    try { localStorage.setItem(draftKeyCliente(empresa.id), JSON.stringify(form)) } catch { /* ignore */ }
  }, [empresa?.id, form])

  function ch(e) {
    const { name, value } = e.target
    setForm(p => ({ ...p, [name]: value }))
  }

  async function salvar(e) {
    e.preventDefault()
    if (!form.nome.trim()) { setErro('Informe o nome do cliente.'); return }
    setSaving(true); setErro(null)
    const { data, error } = await supabase
      .from('clientes')
      .insert({ ...form, empresa_id: empresa.id })
      .select('id, nome, telefone, endereco, numero, complemento, bairro, cidade')
      .single()
    setSaving(false)
    if (error) { setErro(error.message); return }
    apagarDraftCliente(empresa.id)
    onSalvo(data)
  }

  const inp = {
    width: '100%', padding: '9px 11px', borderRadius: 8,
    border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
    color: 'var(--text)', fontSize: 14,
  }
  const lbl = { fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', margin: '0 0 4px', display: 'block' }
  const col = { flex: 1, minWidth: 0 }

  return (
    <div className="pp-modal-overlay" onClick={onFechar} style={{ zIndex: 200 }}>
      <form className="pp-modal pp-cliente" onClick={e => e.stopPropagation()} onSubmit={salvar}>
        <div>
          <p className="pp-modal-titulo" style={{ marginBottom: 4 }}>Novo cliente</p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
            Só o nome é obrigatório — o endereço dá pra completar depois.
          </p>
          {clienteTemAlgoDigitado(form) && (
            <p style={{ fontSize: 12, color: '#16a34a', fontWeight: 700, margin: '6px 0 0' }}>
              💾 Rascunho guardado — pode sair e voltar que continua daqui.
            </p>
          )}
        </div>

        {/* Duas colunas no PC (quem cadastra está no caixa, de tela larga) e uma
            só no celular. Ver .pp-cliente em PainelPedidos.css. */}
        <div className="pp-cliente-grid">
          <div className="pp-cliente-col">
            <p className="pp-cliente-secao">Quem é</p>

            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>Nome *</label>
              <input name="nome" value={form.nome} onChange={ch} style={inp} autoFocus
                placeholder="Como chamar o cliente" />
            </div>

            <div>
              <label style={lbl}>Telefone</label>
              <input name="telefone" value={form.telefone} onChange={ch} style={inp}
                inputMode="tel" placeholder="(84) 90000-0000" />
            </div>
          </div>

          <div className="pp-cliente-col">
            <p className="pp-cliente-secao">Onde entregar</p>

            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <div style={{ ...col, flex: '0 0 46%' }}>
                <label style={lbl}>CEP {buscandoCep && <span style={{ color: 'var(--primary)' }}>· buscando...</span>}</label>
                <input name="cep" value={form.cep} onChange={e => { ch(e); buscarCep(e.target.value) }}
                  placeholder="00000-000" inputMode="numeric" style={inp} />
              </div>
              <div style={col}>
                <label style={lbl}>Número</label>
                <input name="numero" value={form.numero} onChange={ch} style={inp} />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Endereço</label>
              <input name="endereco" value={form.endereco} onChange={ch} style={inp} placeholder="Rua, avenida..." />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Complemento</label>
              <input name="complemento" value={form.complemento} onChange={ch} style={inp} placeholder="Apto, bloco, referência..." />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <div style={col}>
                <label style={lbl}>Bairro</label>
                <input name="bairro" value={form.bairro} onChange={ch} style={inp} />
              </div>
              <div style={col}>
                <label style={lbl}>Cidade</label>
                <input name="cidade" value={form.cidade} onChange={ch} style={inp} />
              </div>
            </div>

            <p className="pp-cliente-dica">💡 Digite o CEP que a gente puxa rua, bairro e cidade.</p>
          </div>
        </div>

        {erro && <p style={{ color: 'var(--danger, #ef4444)', fontSize: 14, margin: 0 }}>{erro}</p>}

        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary"
            onClick={() => { apagarDraftCliente(empresa?.id); onFechar() }}>Cancelar</button>
          <button type="submit" className="pp-modal-btn-danger" style={{ background: '#7c3aed', borderColor: '#7c3aed' }} disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar cliente'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Modal de venda no balcão (PDV do gestor) ────────────────
// O vendedor monta o pedido pelo catálogo; ele entra na lista do painel.
// Seletor de complementos ("monte sua quentinha") na venda de balcão.
function ModalComplementos({ produto, onFechar, onConfirmar, iniciais = [] }) {
  const grupos = produto.grupos ?? []
  // A escolha é { grupoId: { opcaoId: quantidade } }. No grupo comum a
  // quantidade é sempre 1 e o que vale é estar ou não na lista; no grupo de
  // atacado (modo_quantidade) é ela que diz quantos picolés de cada sabor.
  const [sel, setSel] = useState(() => {
    const chave = n => String(n ?? '').toLowerCase().trim()
    const init = {}
    for (const g of grupos) {
      const m = {}
      for (const o of (g.opcoes ?? [])) {
        // Ao EDITAR, volta com o que já estava escolhido (casando pelo nome).
        const antes = (iniciais ?? []).find(n => chave(n?.nome ?? n) === chave(o.nome))
        if (antes) m[o.id] = Number(antes?.qtd ?? 1) || 1
      }
      init[g.id] = m
    }
    return init
  })

  const escolhidas = g => Object.keys(sel[g.id] ?? {}).length
  const somaQtd = g => Object.values(sel[g.id] ?? {}).reduce((s, q) => s + (Number(q) || 0), 0)

  function toggle(grupo, opcao) {
    setSel(prev => {
      const atual = { ...(prev[grupo.id] ?? {}) }
      if (atual[opcao.id]) delete atual[opcao.id]
      else {
        if (grupo.max === 1) return { ...prev, [grupo.id]: { [opcao.id]: 1 } }   // rádio
        if (Object.keys(atual).length >= grupo.max) return prev                   // limite atingido
        atual[opcao.id] = 1
      }
      return { ...prev, [grupo.id]: atual }
    })
  }

  function setQtd(grupo, opcao, valor) {
    const n = Math.max(0, Math.floor(Number(valor) || 0))
    setSel(prev => {
      const atual = { ...(prev[grupo.id] ?? {}) }
      if (n <= 0) delete atual[opcao.id]
      else atual[opcao.id] = n
      return { ...prev, [grupo.id]: atual }
    })
  }

  const selecoes = grupos.flatMap(g =>
    Object.entries(sel[g.id] ?? {}).map(([oid, q]) => {
      const o = g.opcoes.find(x => String(x.id) === String(oid))
      return {
        grupoId: g.id, grupo: g.nome, opcaoId: oid, nome: o?.nome ?? '',
        preco: Number(o?.preco_adicional ?? 0), qtd: Number(q) || 1,
        // Marca pra comanda/cupom não multiplicar de novo pela quantidade do
        // item: aqui os sabores DIVIDEM o total (itensPedido.js).
        absoluto: !!g.modo_quantidade,
      }
    })
  )

  // Quantas unidades a linha leva. No atacado é a soma dos sabores (10 + 15 +
  // 20 = 45) — é essa quantidade que dá baixa certa no estoque.
  const grupoQtd = grupos.find(g => g.modo_quantidade)
  const qtdItem = grupoQtd ? somaQtd(grupoQtd) : 1
  const adicional = adicionalComplementos(grupos, selecoes)
  // Opção paga entra rateada, pra a linha ter UM preço unitário e o
  // subtotal (qtd × unitário) continuar batendo.
  // No atacado a quantidade da linha é a soma dos sabores (10 uva + 15 limão),
  // e é ela que decide a faixa: 25 picolés entram no "a partir de 10".
  const precoBase = precoDoProduto(produto, qtdItem)
  const faixa = faixaAplicada(produto.faixas_preco, qtdItem)
  const faixa1 = menorFaixa(produto.faixas_preco)
  const adicionalUnit = qtdItem > 0 ? adicional / qtdItem : adicional
  const precoUnit = precoBase + adicionalUnit
  const totalItem = precoUnit * (qtdItem || 1)
  const faltando = grupos.filter(g => g.modo_quantidade
    ? somaQtd(g) < (g.min ?? 0)
    : escolhidas(g) < (g.min ?? 0))
  const podeAdd = faltando.length === 0 && qtdItem > 0

  return (
    <div className="pp-modal-overlay" onClick={onFechar} style={{ zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(440px, 94vw)', maxHeight: '90vh', overflowY: 'auto',
        background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
        borderRadius: 14, padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>{produto.nome}</h3>
            {/* A descrição vem junto quando existe — quem atende lê o que vai no
                prato sem ter que abrir o cadastro do produto em outra aba. */}
            {produto.descricao && (
              <p style={{ margin: '3px 0 0', fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>{produto.descricao}</p>
            )}
          </div>
          <button type="button" onClick={onFechar} style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1, flexShrink: 0 }}>×</button>
        </div>

        {grupos.map(grupo => {
          const qtdSel = grupo.modo_quantidade ? somaQtd(grupo) : escolhidas(grupo)
          const obrig = (grupo.min ?? 0) > 0
          const incompleto = qtdSel < (grupo.min ?? 0)
          return (
            <div key={grupo.id} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{grupo.nome}</span>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                  background: incompleto ? 'rgba(239,68,68,.15)' : 'var(--border,#2a2a3a)',
                  color: incompleto ? '#f87171' : 'var(--text-muted)' }}>
                  {grupo.modo_quantidade
                    ? `${qtdSel} un${obrig ? ` · min ${grupo.min}` : ''}`
                    : `${obrig ? `Obrigatório${grupo.min > 1 ? ` · min ${grupo.min}` : ''}` : 'Opcional'}${grupo.max > 1 ? ` · até ${grupo.max}` : ''}`}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {grupo.opcoes.map(opcao => {
                  const qtdOpcao = Number(sel[grupo.id]?.[opcao.id] ?? 0)
                  const marcado = qtdOpcao > 0
                  const bloqueado = !grupo.modo_quantidade && !marcado && grupo.max > 1 && qtdSel >= grupo.max

                  // Atacado: − / número / +. O número é campo de digitar porque
                  // ninguém clica 500 vezes no + — desiste antes.
                  if (grupo.modo_quantidade) return (
                    <div key={opcao.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                        padding: '7px 11px', borderRadius: 9,
                        border: `1.5px solid ${marcado ? '#22c55e' : 'var(--border,#2a2a3a)'}`,
                        background: marcado ? 'rgba(34,197,94,.12)' : 'transparent', color: 'var(--text)' }}>
                      <span style={{ flex: 1, fontSize: 14, minWidth: 0 }}>
                        {opcao.nome}
                        {opcao.descricao && (
                          <span style={{ display: 'block', fontSize: 12, lineHeight: 1.35, color: 'var(--text-muted)', marginTop: 2 }}>{opcao.descricao}</span>
                        )}
                      </span>
                      {Number(opcao.preco_adicional) > 0 && (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>+{fmt(opcao.preco_adicional)}</span>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <button type="button" aria-label={`Menos ${opcao.nome}`} disabled={qtdOpcao <= 0}
                          onClick={() => setQtd(grupo, opcao, qtdOpcao - 1)}
                          style={{ width: 28, height: 28, borderRadius: 7, cursor: qtdOpcao <= 0 ? 'not-allowed' : 'pointer',
                            border: '1px solid var(--border,#2a2a3a)', background: 'transparent',
                            color: 'var(--text)', fontSize: 16, fontWeight: 800, opacity: qtdOpcao <= 0 ? .4 : 1 }}>−</button>
                        <input type="number" min="0" inputMode="numeric"
                          aria-label={`Quantidade de ${opcao.nome}`}
                          value={qtdOpcao === 0 ? '' : qtdOpcao} placeholder="0"
                          onChange={e => setQtd(grupo, opcao, e.target.value)}
                          onFocus={e => e.target.select()}
                          style={{ width: 58, textAlign: 'center', fontSize: 14, fontWeight: 700,
                            padding: '5px 2px', borderRadius: 7, border: '1px solid var(--border,#2a2a3a)',
                            background: 'var(--bg, transparent)', color: 'var(--text)' }} />
                        <button type="button" aria-label={`Mais ${opcao.nome}`}
                          onClick={() => setQtd(grupo, opcao, qtdOpcao + 1)}
                          style={{ width: 28, height: 28, borderRadius: 7, cursor: 'pointer',
                            border: '1px solid var(--border,#2a2a3a)', background: 'transparent',
                            color: 'var(--text)', fontSize: 16, fontWeight: 800 }}>+</button>
                      </div>
                    </div>
                  )

                  return (
                    <button key={opcao.id} type="button" onClick={() => toggle(grupo, opcao)} disabled={bloqueado}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                        padding: '9px 11px', borderRadius: 9, cursor: bloqueado ? 'not-allowed' : 'pointer',
                        border: `1.5px solid ${marcado ? '#22c55e' : 'var(--border,#2a2a3a)'}`,
                        background: marcado ? 'rgba(34,197,94,.12)' : 'transparent',
                        color: 'var(--text)', opacity: bloqueado ? 0.4 : 1 }}>
                      <span style={{ width: 18, height: 18, flexShrink: 0, borderRadius: grupo.max === 1 ? '50%' : 5,
                        border: `2px solid ${marcado ? '#22c55e' : '#64748b'}`, background: marcado ? '#22c55e' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#04120a', fontSize: 12, fontWeight: 900 }}>
                        {marcado ? '✓' : ''}
                      </span>
                      <span style={{ flex: 1, fontSize: 14, minWidth: 0, textAlign: 'left' }}>
                        {opcao.nome}
                        {opcao.descricao && (
                          <span style={{ display: 'block', fontSize: 12, lineHeight: 1.35, color: 'var(--text-muted)', marginTop: 2 }}>{opcao.descricao}</span>
                        )}
                      </span>
                      {Number(opcao.preco_adicional) > 0 && (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>+{fmt(opcao.preco_adicional)}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}

        {faixa ? (
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#22c55e', marginBottom: 8 }}>
            Atacado: {faixa.qtd_min}+ un sai a {fmt(faixa.preco)} cada
          </div>
        ) : faixa1 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            A partir de {faixa1.qtd_min} un sai a {fmt(faixa1.preco)} cada
          </div>
        ) : null}

        <button type="button" disabled={!podeAdd} onClick={() => onConfirmar(produto, selecoes, precoUnit, qtdItem, adicionalUnit)}
          className="btn btn-primary" style={{ width: '100%', opacity: podeAdd ? 1 : 0.5, marginTop: 4 }}>
          {podeAdd
            ? (grupoQtd ? `Adicionar ${qtdItem} un · ${fmt(totalItem)}` : `Adicionar · ${fmt(totalItem)}`)
            : (faltando[0] ? `Escolha: ${faltando[0].nome}` : 'Escolha os obrigatórios')}
        </button>
      </div>
    </div>
  )
}

// Preço do produto pela QUANTIDADE que o cliente leva (atacado/promoção).
//
// A Loja Online já cobrava a faixa ("a partir de 10 sai a R$ 0,65"), o balcão
// não: na CD Bom, 10 picolés de R$ 1,50 fechavam R$ 15,00 em vez de R$ 6,50.
// As duas telas leem as mesmas faixas de `produtos.faixas_preco`.
function precoDoProduto(produto, qtd) {
  const base = Number(produto?.preco_venda || 0)
  const preco = precoPorQuantidade(base, produto?.faixas_preco, qtd, produto?.preco_promocional)
  // O preço especial do cliente já entrou no lugar do preço cheio: a faixa só
  // vale se for MENOR, senão o combinado com ele subiria por causa do atacado.
  return Math.min(preco, base)
}

// Preço da linha do carrinho quando a quantidade muda no +/−: passar de 9 pra
// 10 tem que baixar o valor sozinho, senão o "a partir de 10" vira promessa
// que a loja não cumpre.
//
// Linha sem `precoBase` é de pedido em edição (o preço veio salvo do banco):
// aí vale o que foi cobrado na hora, ninguém remarca venda antiga.
function precoDaLinha(item, qtd) {
  if (item?.precoBase == null) return Number(item?.preco || 0)
  const p = {
    preco_venda: item.precoBase,
    faixas_preco: item.faixas_preco,
    preco_promocional: item.preco_promocional,
  }
  return precoDoProduto(p, qtd) + Number(item.adicionalUnit || 0)
}

// Os campos que a linha do carrinho guarda pra saber recalcular sozinha.
function dadosDePreco(produto, adicionalUnit = 0) {
  return {
    precoBase: Number(produto?.preco_venda || 0),
    faixas_preco: produto?.faixas_preco ?? [],
    preco_promocional: produto?.preco_promocional ?? null,
    adicionalUnit: Number(adicionalUnit) || 0,
  }
}

// Reconstrói o carrinho a partir dos itens de um pedido (ao editar).
function cartFromPedido(p) {
  const c = {}
  ;(p?.itens ?? []).forEach((it, idx) => {
    const comps = Array.isArray(it.complementos) ? it.complementos : []
    const key = comps.length ? `${it.produto_id}::${comps.map(x => x.nome).join(',')}::${idx}` : (it.produto_id || `i${idx}`)
    c[key] = {
      id: key, produto_id: it.produto_id,
      nome: it.nome, preco: Number(it.preco_unitario ?? it.preco ?? 0),
      qtd: Number(it.quantidade ?? it.qtd ?? 1), complementos: comps,
    }
  })
  return c
}

// Cache do catálogo (produtos + complementos) por empresa. Sem isto, cada
// abertura do modal de venda/edição refazia 2 consultas e, num painel movimentado
// (realtime + polling), a lista demorava a aparecer ("Carregando produtos..."
// travado). Carregamos uma vez e reaproveitamos; o painel ainda pré-aquece.
const catalogoCache = {} // { [empresaId]: { produtos, compMap } }

async function carregarCatalogo(empresaId) {
  const [prodRes, vincRes] = await Promise.all([
    // Paginado: sem isso a Nova venda de um deposito so achava os 1000 primeiros nomes.
    fetchAll(() => supabase.from('produtos').select('id, nome, preco_venda, preco_promocional, faixas_preco, categoria')
      .eq('empresa_id', empresaId).is('arquivado_em', null).order('nome', { ascending: true }).order('id')),
    supabase.from('produto_complemento_grupos')
      .select('produto_id, ordem, min_override, max_override, complemento_grupos(id, nome, min, max, regra_preco, modo_quantidade, complemento_opcoes(id, nome, preco_adicional, ordem, disponivel)), produtos!inner(empresa_id)')
      .eq('produtos.empresa_id', empresaId).order('ordem'),
  ])
  if (prodRes.error) throw prodRes.error
  const compMap = {}
  for (const v of (vincRes.data ?? [])) {
    const g = v.complemento_grupos
    if (!g) continue
    const opcoes = (g.complemento_opcoes ?? [])
      .filter(o => o.disponivel !== false)
      .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
    if (!opcoes.length) continue
    ;(compMap[v.produto_id] = compMap[v.produto_id] || []).push({
      id: g.id, nome: g.nome, min: v.min_override ?? g.min ?? 0, max: v.max_override ?? g.max ?? 1,
      regra_preco: g.regra_preco ?? 'somar', opcoes,
      // Atacado (mig 0200): o cliente diz QUANTO de cada sabor. Sem isso o
      // balcao mostrava radio e a Gaby nao conseguia vender 10 de leite
      // condensado + 15 de limao numa linha so.
      modo_quantidade: g.modo_quantidade === true,
    })
  }
  const catalogo = { produtos: prodRes.data || [], compMap }
  catalogoCache[empresaId] = catalogo
  return catalogo
}

// Distância entre dois pontos (km) — pra calcular taxa de entrega por km.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
// Endereço em texto → coordenadas (OpenStreetMap/Nominatim, mesmo do checkout).
async function geocodificarEndereco(endereco) {
  try {
    const q = encodeURIComponent(`${endereco}, Brasil`)
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { 'User-Agent': 'CRM-FWC/1.0' },
    })
    const data = await res.json()
    if (data?.[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  } catch { /* ignora */ }
  return null
}

// Endereço em campos → coordenada, do jeito mais preciso primeiro (mig 0238).
// Com o CEP dá pra usar a busca ESTRUTURADA do Nominatim, que é bem melhor que
// jogar o endereço inteiro num campo de texto — é a mesma da Loja Online.
async function geocodificarPreciso({ rua, numero, bairro, cidade, estado, cep } = {}) {
  const cepLimpo = String(cep || '').replace(/\D/g, '')
  const pega = async (url) => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'CRM-FWC/1.0' } })
      const d = await r.json()
      if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
    } catch { /* sem rede, sem ponto */ }
    return null
  }
  if (cepLimpo.length === 8) {
    const params = new URLSearchParams({
      street: [numero, rua].filter(Boolean).join(' '),
      city: cidade || '', state: estado || '', postalcode: cepLimpo,
      country: 'Brazil', format: 'json', limit: '1',
    })
    const c = await pega(`https://nominatim.openstreetmap.org/search?${params}`)
    if (c) return c
  }
  const q = [rua, numero, bairro, cidade, estado].filter(v => v && String(v).trim()).join(', ')
  if (!q) return null
  return pega(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Brasil')}&format=json&limit=1`)
}

// Mesma chave da Loja Online e do banco (chave_endereco, mig 0160): serve pra
// saber se o pino guardado no cadastro é DESTE endereço. Endereço diferente,
// pino diferente — senão o cliente que mudou de casa recebia no lugar antigo.
function chaveEnderecoJS({ rua, numero, cidade } = {}) {
  const junto = [rua, numero, cidade].map(v => String(v ?? '').trim()).filter(Boolean).join(' ')
  return junto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim() || null
}

// Coordenada → endereço escrito (o caminho inverso do buscador de mapa).
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      { headers: { 'User-Agent': 'CRM-FWC/1.0' } },
    )
    const d = await r.json()
    const a = d?.address ?? {}
    return {
      rua: a.road ?? a.pedestrian ?? a.footway ?? '',
      // O GPS devolve PONTO, não número de casa. Quando vem, é bônus.
      numero: a.house_number ?? '',
      bairro: a.suburb ?? a.neighbourhood ?? a.city_district ?? '',
      cidade: a.city ?? a.town ?? a.municipality ?? a.village ?? '',
      estado: a['ISO3166-2-lvl4']?.split('-')?.[1] ?? '',
      cep: String(a.postcode ?? '').replace(/\D/g, ''),
    }
  } catch {
    return null
  }
}

// LOCALIZAÇÃO DO WHATSAPP → CADASTRO (mig 0238).
//
// O cliente mandou o pininho. O mapa sabe dizer a rua, o bairro, a cidade e
// muitas vezes o CEP — só o NÚMERO da casa ele não sabe, porque GPS devolve
// ponto, não número. Então a tela preenche o que dá e pergunta só o que falta.
//
// O ponto vai pro cadastro marcado como do CLIENTE: é o único pino em que o
// cálculo de taxa confia e que o buscador de mapa não pode sobrescrever depois.
function ModalLocalizacaoCliente({ empresa, telefone, nome, lat, lng, onFechar, onSalvo }) {
  const [f, setF] = useState({ rua: '', numero: '', bairro: '', cidade: '', estado: '', cep: '' })
  const [lendo, setLendo] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      // O que a loja já sabe deste cliente. O GPS não devolve número de casa —
      // se ele já pediu antes, o número está aqui e ninguém precisa digitar de
      // novo (nem perguntar de novo ao cliente).
      const chave = String(telefone ?? '').replace(/[^0-9]/g, '').slice(-8)
      let jaTem = null
      if (empresa?.id && chave.length >= 8) {
        const { data } = await supabase.from('clientes')
          .select('endereco, numero, complemento, bairro, cidade, estado, cep')
          .eq('empresa_id', empresa.id).ilike('telefone', `%${chave}`)
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        jaTem = data ?? null
      }
      const a = await reverseGeocode(lat, lng)
      if (!vivo) return
      if (!a && !jaTem) {
        setErro('O mapa não soube dizer o endereço deste ponto. Escreva à mão — o ponto continua valendo.')
      }
      setF(p => ({
        ...p,
        // Rua/bairro/cidade: o mapa manda, porque quem escolheu o ponto foi o
        // cliente e é o ponto que diz onde ele está de verdade.
        rua:    a?.rua    || jaTem?.endereco || p.rua,
        bairro: a?.bairro || jaTem?.bairro   || p.bairro,
        cidade: a?.cidade || jaTem?.cidade   || p.cidade,
        estado: a?.estado || jaTem?.estado   || p.estado,
        cep:    a?.cep    || (jaTem?.cep ?? '').replace(/[^0-9]/g, '') || p.cep,
        // Número: o cadastro manda, porque o mapa raramente sabe.
        numero: jaTem?.numero || a?.numero || p.numero,
      }))
      setLendo(false)
    })()
    return () => { vivo = false }
  }, [lat, lng, telefone, empresa?.id])

  async function salvar() {
    setSalvando(true); setErro(null)
    try {
      const { data: cid, error } = await supabase.rpc('upsert_cliente_loja', {
        p_empresa_id: empresa.id,
        p_nome: (nome || '').trim() || 'Cliente',
        p_telefone: String(telefone || '').replace(/\D/g, ''),
        p_email: '', p_cep: f.cep, p_endereco: f.rua, p_numero: f.numero,
        p_complemento: '', p_bairro: f.bairro, p_cidade: f.cidade, p_estado: f.estado,
      })
      if (error || !cid) { setErro(error?.message || 'Não deu pra salvar o cliente.'); return }

      const { error: errPin } = await supabase.from('clientes').update({
        endereco_lat: lat,
        endereco_lng: lng,
        endereco_pin_manual: true,
        endereco_pin_origem: 'cliente',
        endereco_pin_ref: chaveEnderecoJS({ rua: f.rua, numero: f.numero, cidade: f.cidade }),
        endereco_pin_em: new Date().toISOString(),
      }).eq('id', cid)
      if (errPin) { setErro(errPin.message); return }

      onSalvo?.()
      onFechar()
    } finally {
      setSalvando(false)
    }
  }

  const campo = (k, ph, extra = {}) => (
    <input value={f[k]} onChange={e => setF(p => ({ ...p, [k]: e.target.value }))} placeholder={ph}
      style={{
        padding: '9px 11px', borderRadius: 8, border: '1px solid var(--border, #2a2a3a)',
        background: 'var(--bg, #0f0f1a)', color: 'var(--text)', fontSize: 13.5, width: '100%',
        ...extra,
      }} />
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onFechar}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 420, background: 'var(--card-bg, var(--bg, #14141f))',
        border: '1px solid var(--border, #2a2a3a)', borderRadius: 14, padding: 18,
        display: 'flex', flexDirection: 'column', gap: 9,
      }}>
        <strong style={{ fontSize: 15.5, color: 'var(--text)' }}>📍 Endereço pela localização</strong>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          O ponto é exato — veio do celular do cliente. O que o mapa souber do
          endereço já vem preenchido, e o <strong>número</strong> vem do cadastro
          quando ele já pediu antes. Se estiver em branco, o GPS não traz — pergunte
          pra ele.
        </p>
        {lendo ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '10px 0' }}>Lendo o endereço no mapa…</div>
        ) : (
          <>
            {campo('rua', 'Rua')}
            <div style={{ display: 'flex', gap: 8 }}>
              {campo('numero', 'Nº', { maxWidth: 110 })}
              {campo('bairro', 'Bairro')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {campo('cidade', 'Cidade')}
              {campo('cep', 'CEP', { maxWidth: 130 })}
            </div>
          </>
        )}
        {erro && <div style={{ fontSize: 12, color: 'var(--danger,#ef4444)', fontWeight: 600 }}>{erro}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={onFechar} style={{
            padding: '9px 14px', borderRadius: 8, border: '1px solid var(--border, #2a2a3a)',
            background: 'transparent', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
          }}>Cancelar</button>
          <button type="button" onClick={salvar} disabled={salvando || lendo} style={{
            flex: 1, padding: '9px 14px', borderRadius: 8, border: 'none',
            background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 13.5,
            cursor: salvando ? 'wait' : 'pointer',
          }}>{salvando ? 'Salvando…' : 'Salvar endereço e ponto'}</button>
        </div>
      </div>
    </div>
  )
}

// ── Busca de rua pelo nome ───────────────────────────────────────────────────
// O CEP quase ninguém sabe de cabeça; o nome da rua, todo mundo. O cliente
// fala "Rua Prefeita Eliane Barros" no áudio e quem atende escolhe da lista —
// que já traz bairro, cidade e CEP juntos. Endereço digitado de ouvido é o que
// faz o motoboy rodar à toa.
//
// Duas fontes, e as duas fazem falta:
//
// • ViaCEP conhece só rua que tem CEP PRÓPRIO, e só na cidade que a gente
//   perguntar. Bairro novo e cidade pequena costumam ter um CEP único pra tudo
//   — e aí a rua do cliente simplesmente não existe na lista.
// • OpenStreetMap conhece a rua mesmo sem CEP e no estado inteiro, que é o que
//   resolve o cliente da cidade vizinha (a loja em Natal entregando em São
//   Gonçalo é o caso comum, não a exceção).
//
// A busca do ViaCEP é literal: "Rua" na frente atrapalha, então a gente tira o
// tipo do logradouro e, se ainda assim não achar, tenta a maior palavra.
async function buscarRuasViaCep(uf, cidade, termo) {
  const estado = String(uf ?? '').trim()
  const cid = String(cidade ?? '').trim()
  const t = String(termo ?? '').trim()
  if (t.length < 3 || !estado || cid.length < 3) return []
  const buscar = async (q) => {
    if (!q || q.length < 3) return []
    const r = await fetch(`https://viacep.com.br/ws/${estado}/${encodeURIComponent(cid)}/${encodeURIComponent(q)}/json/`)
    const j = await r.json()
    return Array.isArray(j) ? j : []
  }
  const semTipo = t.replace(/^(r|rua|av|avn|avenida|trav|travessa|al|alameda|pc|praca|praça|rod|rodovia|estr|estrada|beco|conj|conjunto|vl|vila)\.?\s+/i, '').trim()
  let d = await buscar(semTipo || t)
  if (!d.length) {
    const maior = semTipo.split(/\s+/).filter(w => w.length >= 4).sort((x, y) => y.length - x.length)[0]
    if (maior) d = await buscar(maior)
  }
  return d.filter(x => x.logradouro)
}

/** Ruas do mapa (OpenStreetMap): pega o que não tem CEP próprio e a cidade vizinha. */
async function buscarRuasNoMapa(uf, termo) {
  const t = String(termo ?? '').trim()
  const estado = String(uf ?? '').trim()
  if (t.length < 4 || !estado) return []
  const q = encodeURIComponent(`${t}, ${estado}, Brasil`)
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=6&addressdetails=1&countrycodes=br`,
    { headers: { 'User-Agent': 'CRM-FWC/1.0' } })
  const j = await r.json()
  return (Array.isArray(j) ? j : [])
    .filter(x => x.address?.road)
    .map(x => ({
      logradouro: x.address.road,
      bairro: x.address.suburb ?? x.address.neighbourhood ?? x.address.city_district ?? '',
      localidade: x.address.city ?? x.address.town ?? x.address.municipality ?? '',
      // CEP do mapa NÃO vem: ele é chute. Na Rua Prefeita Eliane Barros o
      // OpenStreetMap devolvia 59106-120, que é a Avenida Bacharel Tomaz
      // Landim, em Igapó, OUTRA cidade. CEP errado no pedido é o entregador
      // indo pro bairro errado — melhor campo vazio que número inventado.
      cep: '',
      lat: x.lat, lon: x.lon,
      doMapa: true,
    }))
}

/**
 * As duas fontes numa lista só, sem repetir rua.
 *
 * A parte que faz a diferença é a terceira busca: o ViaCEP só procura DENTRO
 * de uma cidade, e a gente só sabe perguntar pela cidade da loja. Cliente da
 * cidade vizinha ficava sem CEP à toa — a Rua Prefeita Eliane Barros tem CEP
 * (59296-391), mas em São Gonçalo do Amarante, e a busca perguntava em Natal.
 *
 * Então: o mapa acha a rua e diz a cidade dela; com a cidade na mão, a gente
 * volta ao ViaCEP e pega o CEP de verdade. O CEP vem sozinho, que é o ponto —
 * o cliente não sabe o CEP dele, e quem atende não tem como conferir chute.
 */
async function buscarRuas(uf, cidade, termo) {
  const [viacep, mapa] = await Promise.all([
    buscarRuasViaCep(uf, cidade, termo).catch(() => []),
    buscarRuasNoMapa(uf, termo).catch(() => []),
  ])

  const jaPerguntada = normBairro(cidade)
  const outrasCidades = [...new Set(mapa.map(m => m.localidade).filter(Boolean))]
    .filter(c => normBairro(c) !== jaPerguntada)
    .slice(0, 2)
  const vizinhas = (await Promise.all(
    outrasCidades.map(c => buscarRuasViaCep(uf, c, termo).catch(() => [])),
  )).flat()

  // Ordem importa: quem tem CEP de verdade entra primeiro e ganha da versão
  // do mapa, que traz a mesma rua sem CEP.
  const vistas = new Set()
  return [...viacep, ...vizinhas, ...mapa].filter(x => {
    const k = `${normBairro(x.logradouro)}|${normBairro(x.bairro)}`
    if (vistas.has(k)) return false
    vistas.add(k); return true
  }).slice(0, 8)
}

/** A listinha que cai embaixo do campo de rua. */
function ListaDeRuas({ sugestoes, onEscolher, onFechar }) {
  return (
    <>
      <div onClick={onFechar} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
      <div style={{
        position: 'absolute', zIndex: 61, top: 'calc(100% + 4px)', left: 0, right: 0,
        maxHeight: 220, overflowY: 'auto', padding: 4, borderRadius: 10,
        border: '1px solid var(--border, #2a2a3a)', background: 'var(--surface, #16161f)',
        boxShadow: '0 12px 28px rgba(0,0,0,.35)',
      }}>
        {sugestoes.map(r => (
          <button key={`${r.cep}-${r.logradouro}`} type="button" onClick={() => onEscolher(r)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
              border: 'none', borderRadius: 7, background: 'none', color: 'var(--text)', cursor: 'pointer',
            }}>
            <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700 }}>{r.logradouro}</span>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)' }}>
              {[r.bairro, r.localidade].filter(Boolean).join(' · ')}
              {/* Rua que veio do mapa costuma não ter CEP próprio — quem atende
                  precisa saber por que o campo do CEP ficou vazio. */}
              {r.doMapa && <span style={{ color: '#7c3aed' }}> · do mapa</span>}
            </span>
          </button>
        ))}
      </div>
    </>
  )
}

// ── Taxa de entrega de um endereço ───────────────────────────────────────────
// A mesma conta da Loja Online e do robô, pra que o pedido montado na conversa
// cobre o mesmo frete que o cliente pagaria pelo link: BAIRRO cadastrado manda
// (é o que a loja combinou na mão); sem bairro, mede a distância até a loja.
const ABREV_BAIRRO = {
  sra: 'senhora', sr: 'senhor', sto: 'santo', sta: 'santa',
  n: 'nossa', na: 'nossa', jd: 'jardim', pq: 'parque',
  vl: 'vila', cj: 'conjunto', res: 'residencial', pres: 'presidente',
}
function normBairro(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map(p => ABREV_BAIRRO[p] ?? p).join(' ')
}
function acharBairroCfg(lista, bairroCliente) {
  const n = normBairro(bairroCliente)
  if (!n) return null
  return (Array.isArray(lista) ? lista : []).find(b => normBairro(b.bairro) === n) || null
}

/**
 * Devolve { taxa, texto, bloqueado } pro endereço. `texto` é o que aparece na
 * tela explicando de onde saiu o valor — sem isso o atendente não tem como
 * saber se a taxa é a do bairro, a da distância ou a fixa da loja.
 */
async function taxaDoEndereco(empresa, end) {
  const cfg = acharBairroCfg(empresa?.taxas_entrega_bairro, end.bairro)
  if (cfg && cfg.entrega === false) {
    return { taxa: 0, bloqueado: true, texto: `A loja não entrega no bairro ${cfg.bairro}.` }
  }
  if (cfg) {
    return { taxa: Number(cfg.taxa) || 0, texto: `bairro ${cfg.bairro} · taxa cadastrada` }
  }

  const faixas = Array.isArray(empresa?.taxas_entrega_km) ? empresa.taxas_entrega_km : []
  const linha = [end.rua, end.numero, end.bairro, end.cidade || empresa?.cidade, end.cep].filter(s => s && String(s).trim()).join(', ')
  if (empresa?.latitude && empresa?.longitude && faixas.length && linha) {
    const coords = await geocodificarEndereco(linha)
    if (coords) {
      const km = haversineKm(coords.lat, coords.lng, Number(empresa.latitude), Number(empresa.longitude))
      const ordenadas = [...faixas].sort((a, b) => Number(a.km) - Number(b.km))
      const faixa = ordenadas.find(f => km <= Number(f.km)) ?? ordenadas[ordenadas.length - 1]
      const fora = empresa.raio_entrega_km && km > Number(empresa.raio_entrega_km)
      // A faixa vai escrita junto: sem ela, uma distância de 6,6 km cobrando a
      // faixa "até 7 km" parece erro, e quem atende não tem como conferir.
      return {
        taxa: Number(faixa.taxa) || 0,
        texto: `${km.toFixed(1)} km da loja · faixa até ${faixa.km} km${fora ? ` · ⚠️ fora do raio de ${empresa.raio_entrega_km} km` : ''}`,
      }
    }
  }
  // Sem bairro cadastrado e sem como medir. Se a loja tem taxa fixa, é ela.
  // Se não tem, devolve NULO e avisa — botar R$ 0,00 aqui era entregar de graça
  // sem ninguém perceber, que é o pior jeito de errar.
  const fixa = Number(empresa?.taxa_entrega ?? 0) || 0
  if (fixa > 0) return { taxa: fixa, texto: 'taxa fixa da loja (não deu pra medir a distância)' }
  return {
    taxa: null,
    texto: 'Não achei esse endereço no mapa e a loja não tem taxa fixa — digite a taxa na mão.',
  }
}

// Rascunho da venda de balcão: se o vendedor sai da tela no meio do pedido,
// a gente guarda o que ele já digitou e reabre igualzinho quando ele volta.
const draftKeyFor = (empresaId) => (empresaId ? `pp-venda-draft-${empresaId}` : null)
function lerDraftVenda(empresaId) {
  const k = draftKeyFor(empresaId)
  if (!k) return null
  try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null }
}

function ModalVenda({ empresa, onFechar, onCriado, pedidoEdicao = null }) {
  const editando = !!pedidoEdicao
  // Rascunho só vale pra venda nova (não pra edição de pedido existente)
  const draft = editando ? null : lerDraftVenda(empresa?.id)
  const draftKey = editando ? null : draftKeyFor(empresa?.id)
  const [produtos, setProdutos] = useState([])
  const [loading, setLoading]   = useState(true)
  const [busca, setBusca]       = useState('')
  const [destaque, setDestaque] = useState(0)   // item marcado pelas setas do teclado
  const listaRef = useRef(null)
  const [cart, setCart]         = useState(() => draft?.cart ?? cartFromPedido(pedidoEdicao))
  const [compMap, setCompMap]   = useState({}) // { [produto_id]: grupos[] }
  const [produtoComp, setProdutoComp] = useState(null) // produto sendo montado (complementos)
  const [nome, setNome]         = useState(draft?.nome ?? (pedidoEdicao && pedidoEdicao.cliente_nome !== 'Balcão' ? (pedidoEdicao.cliente_nome ?? '') : ''))
  const [telefone, setTelefone] = useState(draft?.telefone ?? (pedidoEdicao && pedidoEdicao.cliente_telefone !== '—' ? (pedidoEdicao.cliente_telefone ?? '') : ''))
  // Abre em ENTREGA. O padrão era Retirada e isso custava venda: a venda saía
  // como balcão, sem endereço e sem taxa, e o pedido nunca aparecia no app do
  // motoqueiro — o pedido 1001 da CD Bom (31/08/2026) ficou parado assim, com o
  // endereço do cliente já preenchido por trás e escondido pela aba errada.
  // Esquecer de marcar Entrega some com o pedido; esquecer de marcar Retirada
  // só faz o sistema pedir o endereço, e aí dá pra corrigir na hora.
  const [tipo, setTipo]         = useState(draft?.tipo ?? pedidoEdicao?.tipo_entrega ?? 'entrega') // 'retirada' (balcão) | 'entrega'
  const [cep, setCep]           = useState(draft?.cep ?? pedidoEdicao?.endereco_cep ?? '')
  const [buscandoCepVenda, setBuscandoCepVenda] = useState(false)
  const [rua, setRua]           = useState(draft?.rua ?? (pedidoEdicao && pedidoEdicao.endereco_rua !== 'Retirada na loja' ? (pedidoEdicao.endereco_rua ?? '') : ''))
  const [numero, setNumero]     = useState(draft?.numero ?? pedidoEdicao?.endereco_numero ?? '')
  const [bairro, setBairro]     = useState(draft?.bairro ?? pedidoEdicao?.endereco_bairro ?? '')
  const [cidade, setCidade]     = useState(draft?.cidade ?? (pedidoEdicao?.endereco_cidade && pedidoEdicao.endereco_cidade !== 'Retirada' ? pedidoEdicao.endereco_cidade : ''))
  const [taxa, setTaxa]         = useState(draft?.taxa ?? (pedidoEdicao?.taxa_entrega ? String(pedidoEdicao.taxa_entrega) : ''))
  // Formas ligadas na loja. Se a que veio do rascunho/edição foi desligada
  // depois, cai na primeira ativa — senão o botão sumiria com ela selecionada.
  const formasLoja = formasAtivas(empresa)
  const pagInicial = draft?.pagamento ?? pedidoEdicao?.forma_pagamento ?? 'dinheiro'
  const [pagamento, setPagamento] = useState(
    formasLoja.includes(pagInicial) ? pagInicial : formasLoja[0]
  )
  const [troco, setTroco]       = useState(draft?.troco ?? (pedidoEdicao?.troco_para ? String(pedidoEdicao.troco_para) : ''))
  const [obs, setObs]           = useState(draft?.obs ?? (pedidoEdicao?.observacoes ?? ''))
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro]         = useState(null)
  // Busca de clientes já cadastrados na loja
  const [sugestoes, setSugestoes]       = useState([])
  const [clienteSelId, setClienteSelId] = useState(draft?.clienteSelId ?? pedidoEdicao?.cliente_id ?? null)
  const [precoEspMap, setPrecoEspMap] = useState({}) // produto_id → preço especial (parceria) do cliente selecionado
  const [msgCli, setMsgCli]             = useState(null)
  const buscaCliTimer = useRef(null)
  // Abre a ficha completa de cadastro de cliente
  // Ficha de cliente pela metade reabre junto com a venda: sem isso o rascunho
  // ficava guardado e ninguém via, o que dá no mesmo que ter perdido.
  const [cadastroAberto, setCadastroAberto] = useState(
    () => draftClienteTemEndereco(lerDraftCliente(empresa?.id) ?? {})
  )
  // Leitor de print: lê a captura de tela de um pedido de outro canal (iFood,
  // WhatsApp, planilha...) e preenche a venda automaticamente.
  const [lendoPrint, setLendoPrint] = useState(false)
  const [msgPrint, setMsgPrint] = useState(null)
  const [colarPronto, setColarPronto] = useState(false)
  const fileRef = useRef(null)
  const pasteRef = useRef(null)
  // Cálculo automático da taxa de entrega pela distância loja↔cliente
  const [calcTaxa, setCalcTaxa] = useState({ loading: false, msg: null })
  // ── Ponto da entrega (mig 0238) ────────────────────────────────────────────
  // A venda montada aqui não gravava coordenada nenhuma: o motoboy abria o TEXTO
  // do endereço no Google, que, sem confiar no número, larga o pino no meio da
  // rua. Rua certa, casa errada. Agora a venda leva o ponto — e, quando dá, o
  // ponto que o próprio cliente apontou.
  const [coordCliente, setCoordCliente] = useState(
    pedidoEdicao?.endereco_lat != null
      ? { lat: Number(pedidoEdicao.endereco_lat), lng: Number(pedidoEdicao.endereco_lng) }
      : null
  )
  // Pino que veio do cliente (cadastro ou link confirmado): o buscador de mapa
  // não sobrescreve o que a pessoa apontou com o dedo.
  const pinDoCliente = useRef(false)
  const [pinSalvo, setPinSalvo] = useState(null)   // { lat, lng, ref } do cadastro
  const [pinLink, setPinLink] = useState(null)     // { url, enviado } do link mandado
  const [pinMsg, setPinMsg]   = useState(null)
  const [pinBusy, setPinBusy] = useState(false)

  useEffect(() => {
    if (!empresa?.id) { setLoading(false); return }
    let ativo = true
    // Cache quente → a lista aparece na hora, sem esperar a rede.
    const cache = catalogoCache[empresa.id]
    if (cache) {
      setProdutos(cache.produtos)
      setCompMap(cache.compMap)
      setLoading(false)
    }
    // Carrega/atualiza em segundo plano (catálogo pode ter mudado).
    ;(async () => {
      try {
        const catalogo = await carregarCatalogo(empresa.id)
        if (!ativo) return
        setProdutos(catalogo.produtos)
        setCompMap(catalogo.compMap)
      } catch (e) {
        if (ativo && !cache) setErro(`Erro ao carregar produtos: ${String(e?.message ?? e)}`)
      } finally {
        if (ativo) setLoading(false)
      }
    })()
    return () => { ativo = false }
  }, [empresa])

  // Busca os clientes da loja enquanto digita (debounce).
  //
  // Acha pelo NOME ou pelo TELEFONE. Quem está no balcão quase
  // sempre tem o número antes do nome — o cliente dita o telefone, não como
  // ficou cadastrado — e digitar o número não achava nada.
  //
  // A busca do número usa `telefone_digitos` (mig 0212), que é o telefone só
  // com dígitos: os cadastros vieram de todo jeito ((84) 99818-0774, 84 8620-
  // 4148, 84987749958) e procurar na coluna crua acharia um e perderia os
  // outros dois.
  function buscarClientes(q) {
    clearTimeout(buscaCliTimer.current)
    const termo = (q || '').trim()
    if (termo.length < 2) { setSugestoes([]); return }
    const digitos = termo.replace(/\D/g, '')
    // Vírgula, parênteses e aspas separam os filtros na consulta do Supabase:
    // digitar "(84) 99818" quebraria a busca inteira. Somem do pedaço do nome
    // (o do telefone já é só número).
    const nomeBusca = termo.replace(/[(),."\\]/g, ' ').trim()
    // Menos de 3 dígitos não filtra nada de útil — traria meia loja.
    const filtros = []
    if (nomeBusca) filtros.push(`nome.ilike.%${nomeBusca}%`)
    if (digitos.length >= 3) filtros.push(`telefone_digitos.ilike.%${digitos}%`)
    if (!filtros.length) { setSugestoes([]); return }
    buscaCliTimer.current = setTimeout(async () => {
      const { data } = await supabase
        .from('clientes')
        .select('id, nome, telefone, endereco, numero, complemento, bairro, cidade, estado, cep')
        .eq('empresa_id', empresa.id)
        .or(filtros.join(','))
        .order('nome', { ascending: true })
        .limit(8)
      setSugestoes(data || [])
    }, 300)
  }

  function selecionarCliente(c) {
    setNome(c.nome || '')
    setTelefone(c.telefone || '')
    if (c.endereco || c.bairro || c.cidade) {
      setRua(c.endereco || ''); setNumero(c.numero || '')
      setBairro(c.bairro || ''); setCidade(c.cidade || '')
      if (c.cep) setCep(c.cep)
    }
    setClienteSelId(c.id)
    setSugestoes([])
    setMsgCli(null)
  }

  // Preço especial de parceria: quando um cliente é selecionado, carrega os preços
  // combinados dele. Sem cliente (ou sem acordo) → mapa vazio → tudo no preço normal.
  useEffect(() => {
    if (!clienteSelId) { setPrecoEspMap({}); return }
    let vivo = true
    supabase.from('precos_especiais_cliente').select('produto_id, preco').eq('cliente_id', clienteSelId)
      .then(({ data }) => {
        if (!vivo) return
        const m = {}
        for (const r of (data ?? [])) m[r.produto_id] = Number(r.preco)
        setPrecoEspMap(m)
      })
    return () => { vivo = false }
  }, [clienteSelId])

  // Vincula à venda o cliente recém-cadastrado pela ficha completa
  function aoCadastrarCliente(c) {
    selecionarCliente(c)
    setCadastroAberto(false)
    setMsgCli('Cliente cadastrado ✓')
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  // Colar (Ctrl+V) um print da área de transferência → lê direto.
  useEffect(() => {
    if (editando) return
    function onPaste(e) {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type?.startsWith('image/'))
      if (!item) return
      const file = item.getAsFile()
      if (file) { e.preventDefault(); lerPrint(file) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editando, produtos])

  // Salva o rascunho da venda enquanto o vendedor mexe (pra não perder se sair).
  useEffect(() => {
    if (editando || !draftKey) return
    const temConteudo = Object.keys(cart).length > 0 || nome.trim() || telefone.trim() || obs.trim()
    if (!temConteudo) { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } return }
    const d = { cart, nome, telefone, tipo, cep, rua, numero, bairro, cidade, taxa, pagamento, troco, obs, clienteSelId }
    try { localStorage.setItem(draftKey, JSON.stringify(d)) } catch { /* ignore */ }
  }, [editando, draftKey, cart, nome, telefone, tipo, cep, rua, numero, bairro, cidade, taxa, pagamento, troco, obs, clienteSelId])

  // Limpa o rascunho e fecha (usado ao concluir a venda ou cancelar de propósito)
  function limparDraft() { if (draftKey) { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } } }
  function cancelar() { limparDraft(); onFechar() }

  // CEP → preenche rua/bairro/cidade automaticamente (ViaCEP).
  async function buscarCepVenda(cepRaw) {
    const num = (cepRaw || '').replace(/\D/g, '')
    if (num.length !== 8) return
    setBuscandoCepVenda(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${num}/json/`)
      const d = await res.json()
      if (!d.erro) {
        if (d.logradouro) setRua(d.logradouro)
        if (d.bairro) setBairro(d.bairro)
        if (d.localidade) setCidade(d.localidade)
      }
    } catch { /* CEP offline — segue manual */ }
    setBuscandoCepVenda(false)
  }

  // Calcula a taxa de entrega pela distância entre a loja e o endereço do cliente
  // (usa a config de Raio de Entrega da loja: localização + faixas por km).
  async function calcularTaxaPorEndereco() {
    const endStr = [rua, numero, bairro, cidade, cep].filter(s => s && s.trim()).join(', ')
    if (!endStr.trim()) { setCalcTaxa({ loading: false, msg: { tipo: 'erro', txt: 'Preencha o endereço primeiro.' } }); return }
    setCalcTaxa({ loading: true, msg: null })
    try {
      const { data: emp } = await supabase.from('empresas')
        .select('latitude, longitude, taxa_entrega, taxas_entrega_km, raio_entrega_km')
        .eq('id', empresa.id).maybeSingle()
      if (!emp?.latitude || !emp?.longitude) {
        setCalcTaxa({ loading: false, msg: { tipo: 'erro', txt: 'A loja não tem localização configurada. Vá em Configurações → Raio de entrega, ou digite a taxa manual.' } })
        return
      }
      // Ponto que já está na tela (o do cliente, ou o que o buscador achou com
      // o número) vale mais que uma busca nova por texto — e é o mesmo ponto
      // que vai no pedido, então a taxa e o mapa do motoboy contam a mesma
      // história.
      const coords = coordCliente ?? await geocodificarPreciso({ rua, numero, bairro, cidade, cep })
      if (!coords) { setCalcTaxa({ loading: false, msg: { tipo: 'erro', txt: 'Não achei esse endereço no mapa. Digite a taxa manual.' } }); return }
      if (!coordCliente) setCoordCliente(coords)
      const dist = haversineKm(coords.lat, coords.lng, Number(emp.latitude), Number(emp.longitude))
      const faixas = Array.isArray(emp.taxas_entrega_km) ? emp.taxas_entrega_km : []
      let valor
      if (faixas.length > 0) {
        const ordenadas = [...faixas].sort((a, b) => a.km - b.km)
        const faixa = ordenadas.find(f => dist <= Number(f.km)) ?? ordenadas[ordenadas.length - 1]
        valor = Number(faixa.taxa) || 0
      } else {
        valor = Number(emp.taxa_entrega || 0)
      }
      setTaxa(String(valor))
      const foraRaio = emp.raio_entrega_km && dist > Number(emp.raio_entrega_km)
      setCalcTaxa({
        loading: false,
        msg: {
          tipo: foraRaio ? 'aviso' : 'ok',
          txt: `${dist.toFixed(1)} km → taxa ${fmt(valor)}` + (foraRaio ? ` · ⚠️ fora do raio de ${emp.raio_entrega_km} km` : ''),
        },
      })
    } catch {
      setCalcTaxa({ loading: false, msg: { tipo: 'erro', txt: 'Erro ao calcular. Digite a taxa manual.' } })
    }
  }

  // ── Pino do cadastro: reaproveita o que o cliente já apontou ───────────────
  // Só vale pro MESMO endereço. Mudou de casa, o pino velho não serve.
  useEffect(() => {
    if (!clienteSelId || tipo !== 'entrega') { setPinSalvo(null); return }
    let vivo = true
    supabase.from('clientes')
      .select('endereco_lat, endereco_lng, endereco_pin_manual, endereco_pin_ref')
      .eq('id', clienteSelId).maybeSingle()
      .then(({ data }) => {
        if (!vivo) return
        setPinSalvo(data?.endereco_pin_manual && data.endereco_lat != null
          ? { lat: Number(data.endereco_lat), lng: Number(data.endereco_lng), ref: data.endereco_pin_ref }
          : null)
      })
    return () => { vivo = false }
  }, [clienteSelId, tipo])

  useEffect(() => {
    if (!pinSalvo || tipo !== 'entrega') return
    if (chaveEnderecoJS({ rua, numero, cidade }) !== pinSalvo.ref) return
    pinDoCliente.current = true
    setCoordCliente({ lat: pinSalvo.lat, lng: pinSalvo.lng })
  }, [pinSalvo, rua, numero, cidade, tipo])

  // ── Buscador de mapa: SÓ depois do número ─────────────────────────────────
  // Sem o número o buscador devolve um ponto no meio da rua — e ninguém
  // desconfia, porque o endereço na tela está certinho. Era daí que saía o
  // motoboy rodando atrás da casa errada. Mesma regra da Loja Online.
  useEffect(() => {
    if (tipo !== 'entrega' || pinDoCliente.current) return
    if (!rua.trim() || !numero.trim()) { setCoordCliente(null); return }
    let vivo = true
    const t = setTimeout(async () => {
      const c = await geocodificarPreciso({ rua, numero, bairro, cidade, cep })
      if (vivo && c && !pinDoCliente.current) setCoordCliente(c)
    }, 900)
    return () => { vivo = false; clearTimeout(t) }
  }, [rua, numero, bairro, cidade, cep, tipo])

  // Endereço mudou de verdade? O pino do cliente era do endereço ANTIGO.
  useEffect(() => {
    if (!pinSalvo) { pinDoCliente.current = false; return }
    if (chaveEnderecoJS({ rua, numero, cidade }) !== pinSalvo.ref) pinDoCliente.current = false
  }, [rua, numero, cidade, pinSalvo])

  // ── Pedir pro cliente confirmar no mapa ───────────────────────────────────
  // Gera o link e manda no WhatsApp dele. O cliente abre, vê o pino já na casa
  // dele (o que o buscador achou) e só ajusta — e o acerto volta pro cadastro
  // na hora. É a única pessoa que sabe onde mora.
  async function pedirConfirmacaoNoMapa() {
    if (!rua.trim()) { setPinMsg({ tipo: 'erro', txt: 'Escreva o endereço antes.' }); return }
    setPinBusy(true); setPinMsg(null)
    try {
      const { data, error } = await supabase.rpc('criar_pin_link', {
        p_telefone: telefone.trim(), p_rua: rua.trim(), p_numero: numero.trim() || null,
        p_bairro: bairro.trim() || null, p_cidade: cidade.trim() || null,
        p_estado: null, p_cep: cep.trim() || null,
        p_lat: coordCliente?.lat ?? null, p_lng: coordCliente?.lng ?? null,
        p_pedido_id: pedidoEdicao?.id ?? null,
      })
      if (error || !data?.ok) {
        setPinMsg({ tipo: 'erro', txt: data?.erro || error?.message || 'Não deu pra gerar o link.' })
        return
      }
      const url = `https://lojaonline.fwcinter.com/local/${data.token}`
      try { await navigator.clipboard.writeText(url) } catch { /* sem clipboard: o link fica na tela */ }

      const tel = telefone.replace(/\D/g, '')
      if (tel.length >= 10) {
        const texto = `Oi! Pra entrega chegar certinho, confirma no mapa o ponto exato da sua casa:

${url}

É só arrastar o pininho e tocar em "É aqui". 🙂`
        const { data: env } = await supabase.functions.invoke('whatsapp-connect', {
          body: { action: 'send_message', phone: tel, text: texto },
        })
        setPinLink({ url, enviado: !!env?.ok })
        setPinMsg(env?.ok
          ? { tipo: 'ok', txt: '✓ Link enviado no WhatsApp do cliente (e copiado aqui).' }
          : { tipo: 'aviso', txt: 'Link copiado — no WhatsApp não foi: ' + (env?.erro || 'WhatsApp da loja desconectado.') })
      } else {
        setPinLink({ url, enviado: false })
        setPinMsg({ tipo: 'aviso', txt: 'Link copiado. Sem telefone na venda, mande você mesmo.' })
      }
    } finally {
      setPinBusy(false)
    }
  }

  function addItem(p) {
    setCart(prev => {
      const qtd = (prev[p.id]?.qtd ?? 0) + 1
      return { ...prev, [p.id]: {
        id: p.id, produto_id: p.id, nome: p.nome, qtd,
        ...dadosDePreco(p), preco: precoDoProduto(p, qtd),
      } }
    })
  }
  // Se o produto tem complementos, abre o seletor; senão adiciona direto.
  function pedirProduto(p) {
    const grupos = compMap[p.id]
    if (grupos?.length) setProdutoComp({ ...p, grupos })
    else addItem(p)
  }
  // Adiciona uma linha com os complementos escolhidos (mesma escolha soma qtd).
  //
  // A assinatura leva a QUANTIDADE de cada opção junto: sem isso "10 uva" e "15
  // uva" cairiam na mesma linha do carrinho e uma apagaria a outra.
  //
  // `qtdItem` vem preenchido no atacado (é a soma dos sabores: 10 + 15 + 20 =
  // 45 picolés) e manda na quantidade da linha — repetir o produto ali somaria
  // 45 em cima de 45. Fora do atacado ele vem 1 e o comportamento é o de
  // sempre: clicar de novo soma mais um.
  function adicionarComComplementos(produto, selecoes, precoUnit, qtdInicial, qtdItem, adicionalUnit = 0) {
    const sig = `${produto.id}::${selecoes.map(s => `${s.opcaoId}x${s.qtd ?? 1}`).sort().join(',')}`
    const atacado = selecoes.some(s => s.absoluto)
    setCart(prev => {
      // Ao editar, preserva a quantidade original; ao adicionar, soma 1.
      const qtd = qtdInicial != null ? qtdInicial
        : atacado ? Number(qtdItem || 1)
        : (prev[sig]?.qtd ?? 0) + 1
      const dados = dadosDePreco(produto, adicionalUnit)
      return { ...prev, [sig]: {
        id: sig, produto_id: produto.id, nome: produto.nome, qtd, ...dados,
        // Fora do atacado a linha pode nascer com qtd maior que a da montagem
        // (clicou de novo no mesmo combo): o preço é o da quantidade final.
        preco: precoDaLinha({ ...dados, preco: precoUnit }, qtd),
        complementos: selecoes.map(s => ({
          nome: s.nome, qtd: s.qtd ?? 1, grupo: s.grupo, preco: s.preco, absoluto: !!s.absoluto,
        })),
      } }
    })
    setProdutoComp(null)
  }
  function subItem(id) {
    setCart(prev => {
      const cur = prev[id]
      if (!cur) return prev
      const novo = { ...prev }
      if (cur.qtd <= 1) delete novo[id]
      else novo[id] = { ...cur, qtd: cur.qtd - 1, preco: precoDaLinha(cur, cur.qtd - 1) }
      return novo
    })
  }
  function maisItem(id) {
    setCart(prev => {
      const cur = prev[id]
      if (!cur) return prev
      return { ...prev, [id]: { ...cur, qtd: cur.qtd + 1, preco: precoDaLinha(cur, cur.qtd + 1) } }
    })
  }
  function removeItem(id) {
    setCart(prev => { const novo = { ...prev }; delete novo[id]; return novo })
  }
  function setItemQtd(p, n) {
    const qtd = Math.max(0, Math.floor(Number(n) || 0))
    setCart(prev => {
      const novo = { ...prev }
      if (qtd <= 0) delete novo[p.id]
      else novo[p.id] = { id: p.id, nome: p.nome, qtd, ...dadosDePreco(p), preco: precoDoProduto(p, qtd) }
      return novo
    })
  }

  const itens     = Object.values(cart)
  const subtotal  = itens.reduce((s, i) => s + i.preco * i.qtd, 0)
  const taxaNum   = tipo === 'entrega' ? (parseFloat(String(taxa).replace(',', '.')) || 0) : 0
  const total     = subtotal + taxaNum

  // ── Mandar o pedido pro cliente no WhatsApp ──────────────────
  // O atendimento acontece no WhatsApp e a venda é montada aqui: sem este
  // botão, a pessoa digitava o pedido inteiro DE NOVO na mão pra confirmar com
  // o cliente — e é digitando de novo que troca item e valor.
  //
  // Manda só o resumo pra ele conferir, sem link de pedido: quem fecha a venda
  // é a atendente, aqui. Link levaria o cliente a montar tudo outra vez e o
  // pedido entraria duas vezes.
  const telZap = String(telefone ?? '').replace(/\D/g, '')
  const podeMandarZap = itens.length > 0 && telZap.length >= 10
  const [zapStatus, setZapStatus] = useState(null)   // null | 'enviando' | 'ok' | 'manual'
  const [zapErro, setZapErro] = useState(null)

  // Busca de rua pelo nome (mesma do checkout do cliente). Aqui vale ainda mais:
  // quem digita é a atendente, com o cliente falando no ouvido — e endereço
  // digitado de ouvido é o que faz o motoboy rodar à toa.
  const [ruaSug, setRuaSug] = useState([])
  const [ruaSugAberta, setRuaSugAberta] = useState(false)
  useEffect(() => {
    if (tipo !== 'entrega') { setRuaSug([]); return }
    const termo = String(rua ?? '').trim()
    const uf = String(empresa?.estado ?? '').trim()
    const cid = String(cidade || empresa?.cidade || '').trim()
    if (termo.length < 3 || !uf || cid.length < 3) { setRuaSug([]); return }
    let vivo = true
    const t = setTimeout(async () => {
      try {
        const d = await buscarRuas(uf, cid, termo)
        if (vivo) setRuaSug(d)
      } catch { if (vivo) setRuaSug([]) }
    }, 500)
    return () => { vivo = false; clearTimeout(t) }
  }, [rua, cidade, empresa, tipo])

  async function mandarNoZap() {
    if (!podeMandarZap || zapStatus === 'enviando') return
    const primeiro = String(nome ?? '').trim().split(' ')[0]
    const NL = '\n'
    const linhas = itens.map(i => {
      const comps = (i.complementos ?? [])
        .map(c => `${Number(c.qtd ?? 1)} ${String(c.nome ?? '').trim()}`)
        .filter(Boolean).join(', ')
      return `• ${i.qtd}x ${i.nome} — ${fmt(i.preco * i.qtd)}` + (comps ? `${NL}   ${comps}` : '')
    }).join(NL)

    const endereco = tipo === 'entrega' && String(rua ?? '').trim()
      ? [`${rua}${numero ? `, ${numero}` : ''}`, bairro, cidade].filter(Boolean).join(' — ')
      : null

    const msg = [
      `${primeiro ? `Oi ${primeiro}!` : 'Oi!'} 👋 Seu pedido${empresa?.nome ? ` na *${empresa.nome}*` : ''}:`,
      '',
      linhas,
      '',
      taxaNum > 0 ? `Itens: ${fmt(subtotal)}` : null,
      taxaNum > 0 ? `Entrega: ${fmt(taxaNum)}` : null,
      `*Total: ${fmt(total)}*`,
      endereco ? `${NL}📍 Entrega em: ${endereco}` : (tipo === 'retirada' ? `${NL}🏬 Retirada na loja` : null),
      '',
      'Confere pra mim que eu já mando preparar? 😊',
    ].filter(l => l !== null).join(NL)

    const numero55 = telZap.startsWith('55') ? telZap : `55${telZap}`

    // Sai pelo WhatsApp DA LOJA (Cloud ou Evolution, o mesmo caminho do botão de
    // mensagem do pedido): a atendente não sai da tela e o cliente recebe do
    // número que ele conhece. Abrir o wa.me troca de app, pede "abrir aplicação"
    // e às vezes manda pelo WhatsApp pessoal de quem está no caixa.
    setZapStatus('enviando')
    setZapErro(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ action: 'send_message', phone: numero55, text: msg }),
      })
      const d = await res.json().catch(() => ({}))
      if (d?.ok) { setZapStatus('ok'); return }
      setZapErro(d?.erro || null)
    } catch { /* rede caiu — cai no plano B */ }

    // Loja sem WhatsApp conectado (ou envio recusado): abre o app com a
    // mensagem escrita, que é melhor do que deixar a atendente sem saída.
    setZapStatus('manual')
    window.open(`https://wa.me/${numero55}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener')
  }

  // Aplica o preço especial do cliente (se houver) antes de mostrar/adicionar — só afeta este cliente.
  const produtosComPreco = produtos.map(p => (precoEspMap[p.id] != null ? { ...p, preco_venda: precoEspMap[p.id] } : p))
  // Busca ignorando acento: quem digita rápido escreve "camarao", e o produto
  // está cadastrado como "Camarão".
  const buscaNorm = semAcento(busca)
  const filtrados = produtosComPreco.filter(p => !buscaNorm || semAcento(p.nome).includes(buscaNorm))

  // ── Teclado na busca ────────────────────────────────────────────────────
  // Digita, desce com a seta e confirma no Enter, sem tirar a mão do teclado
  // nem mirar o mouse num botão pequeno. Produto com complemento abre a
  // montagem no Enter, igual ao clique.
  useEffect(() => { setDestaque(0) }, [busca])

  function teclaBusca(e) {
    if (!filtrados.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setDestaque(d => {
        const proximo = e.key === 'ArrowDown' ? d + 1 : d - 1
        const i = Math.max(0, Math.min(filtrados.length - 1, proximo))
        // Rola só o necessário pra linha marcada ficar visível.
        const el = listaRef.current?.children?.[i]
        if (el?.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
        return i
      })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const p = filtrados[destaque]
      if (p) pedirProduto(p)
    }
  }

  async function concluir() {
    if (itens.length === 0) { setErro('Adicione pelo menos um item.'); return }
    if (tipo === 'entrega' && !rua.trim()) { setErro('Informe o endereço da entrega — ou marque Balcão / Retirada se o cliente leva daqui.'); return }
    setSalvando(true); setErro(null)

    // Vincula o cliente: usa o selecionado ou cadastra/atualiza pelo telefone.
    let clienteId = clienteSelId
    if (!clienteId && telefone.trim()) {
      try {
        const { data: cid } = await supabase.rpc('upsert_cliente_loja', {
          p_empresa_id: empresa.id, p_nome: nome.trim() || 'Cliente', p_telefone: telefone.trim(),
          p_email: '', p_cep: cep.trim(), p_endereco: rua.trim(), p_numero: numero.trim(),
          p_complemento: '', p_bairro: bairro.trim(), p_cidade: cidade.trim(), p_estado: '',
        })
        clienteId = cid ?? null
      } catch { /* não bloqueia a venda */ }
    }

    const payload = {
      empresa_id: empresa.id,
      cliente_id: clienteId,
      cliente_nome: nome.trim() || 'Balcão',
      // Telefone é opcional no balcão (cliente do self-service pode não dar).
      // A coluna exige valor, então usamos um traço quando vier vazio.
      cliente_telefone: telefone.trim() || '—',
      tipo_entrega: tipo,
      origem: 'balcao',
      status: 'confirmado', // já aceito — o vendedor está criando o pedido
      itens: itens.map(i => ({
        produto_id: i.produto_id ?? i.id, nome: i.nome, quantidade: i.qtd,
        preco_unitario: i.preco, subtotal: i.preco * i.qtd,
        complementos: i.complementos ?? [],
      })),
      subtotal,
      taxa_entrega: taxaNum,
      total,
      forma_pagamento: pagamento,
      troco_para: pagamento === 'dinheiro' && troco
        ? Math.round(parseFloat(troco.replace(',', '.')) * 100) / 100
        : null,
      observacoes: obs.trim() || null,
    }
    if (tipo === 'entrega') {
      payload.endereco_rua = rua.trim()
      payload.endereco_numero = numero.trim()
      payload.endereco_bairro = bairro.trim()
      payload.endereco_cidade = cidade.trim()
      payload.endereco_cep = cep.trim() || null
      // O ponto vai junto: é ele que o app do entregador abre (sem ele, o
      // Google chuta pelo texto e larga o motoboy no meio da rua).
      payload.endereco_lat = coordCliente?.lat ?? null
      payload.endereco_lng = coordCliente?.lng ?? null
    }
    let error
    if (editando) {
      // Edição: não mexe em origem/status; atualiza os dados do pedido.
      const upd = { ...payload }
      delete upd.empresa_id; delete upd.origem; delete upd.status
      if (tipo !== 'entrega') {
        upd.endereco_rua = 'Retirada na loja'; upd.endereco_numero = null
        upd.endereco_bairro = null; upd.endereco_cidade = 'Retirada'
      }
      ;({ error } = await supabase.from('pedidos_delivery').update(upd).eq('id', pedidoEdicao.id))
    } else {
      ;({ error } = await supabase.from('pedidos_delivery').insert(payload))
    }
    setSalvando(false)
    if (error) { setErro(error.message); return }
    limparDraft()
    onCriado()
    onFechar()
  }

  // Lê o print/PDF escolhido → chama a IA → preenche os campos da venda.
  async function lerPrint(file) {
    if (!file) return
    const ehImagem = file.type?.startsWith('image/')
    const ehPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
    if (!ehImagem && !ehPdf) { setMsgPrint({ tipo: 'erro', txt: 'Selecione uma imagem (print) ou um PDF.' }); return }
    setLendoPrint(true); setMsgPrint(null); setErro(null)
    try {
      // arquivo → base64 puro (sem o prefixo data:...)
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result).split(',')[1] || '')
        r.onerror = rej
        r.readAsDataURL(file)
      })
      const { data, error } = await supabase.functions.invoke('ler-print-pedido', {
        body: {
          imageBase64: base64,
          mimetype: file.type || (ehPdf ? 'application/pdf' : 'image/png'),
          produtos: produtos.map(p => ({
            id: p.id, nome: p.nome, preco: Number(p.preco_venda || 0),
            // Adicionais/complementos do produto (achatados) pra IA casar os extras do print.
            comps: (compMap[p.id] || []).flatMap(g => g.opcoes.map(o => ({ nome: o.nome, preco: Number(o.preco_adicional || 0) }))),
          })),
        },
      })
      if (error) throw new Error(error.message)
      if (!data?.ok) throw new Error(data?.error || 'Não consegui ler o print.')
      const d = data.dados || {}

      // Itens → carrinho (soma sobre o que já estiver). Com complementos, cada
      // combinação de adicionais vira uma linha própria (mesma lógica do "monte").
      let addidos = 0
      if (Array.isArray(d.itens) && d.itens.length) {
        setCart(prev => {
          const novo = { ...prev }
          for (const it of d.itens) {
            const p = produtos.find(x => x.id === it.produto_id)
            if (!p) continue
            const comps = Array.isArray(it.complementos) ? it.complementos : []
            const adicUnit = comps.reduce((s, c) => s + Number(c.preco || 0), 0)
            const sig = comps.length ? `${p.id}::${comps.map(c => c.nome).sort().join(',')}` : p.id
            const q = (novo[sig]?.qtd ?? 0) + Math.max(1, Number(it.quantidade) || 1)
            const dados = dadosDePreco(p, adicUnit)
            novo[sig] = {
              id: sig, produto_id: p.id, nome: p.nome, qtd: q, ...dados,
              preco: precoDaLinha(dados, q),
              complementos: comps.map(c => ({ nome: c.nome, qtd: 1 })),
            }
            addidos++
          }
          return novo
        })
      }

      // Cliente
      if (d.cliente_nome) { setNome(d.cliente_nome); setClienteSelId(null) }
      if (d.telefone) setTelefone(d.telefone)
      // Tipo + endereço
      if (d.tipo === 'entrega') {
        setTipo('entrega')
        const e = d.endereco || {}
        if (e.rua) setRua(e.rua)
        if (e.numero) setNumero(String(e.numero))
        if (e.bairro) setBairro(e.bairro)
        if (e.cidade) setCidade(e.cidade)
        if (e.cep) setCep(String(e.cep))
        if (d.taxa_entrega != null) setTaxa(String(d.taxa_entrega))
      } else if (d.tipo === 'retirada') {
        setTipo('retirada')
      }
      // Pagamento / troco
      if (d.pagamento) setPagamento(d.pagamento)
      if (d.troco_para != null) setTroco(String(d.troco_para))
      // Observações + itens que a IA não achou no catálogo
      const partes = []
      if (d.observacoes) partes.push(String(d.observacoes))
      if (Array.isArray(d.nao_encontrados) && d.nao_encontrados.length) {
        partes.push('⚠️ Não achei no catálogo: ' + d.nao_encontrados.join(', '))
      }
      if (partes.length) setObs(prev => [prev, ...partes].filter(Boolean).join(' · '))

      const faltou = Array.isArray(d.nao_encontrados) ? d.nao_encontrados.length : 0
      setMsgPrint({
        tipo: faltou ? 'aviso' : 'ok',
        txt: `Preenchido: ${addidos} ${addidos === 1 ? 'item' : 'itens'}` +
          (faltou ? ` · ${faltou} não achei no catálogo (veja Observações)` : '') +
          '. Confira antes de concluir.',
      })
    } catch (e) {
      setMsgPrint({ tipo: 'erro', txt: 'Erro ao ler o print: ' + String(e?.message ?? e) })
    } finally {
      setLendoPrint(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const inputSt = {
    width: '100%', padding: '9px 11px', borderRadius: 8,
    border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
    color: 'var(--text)', fontSize: 14,
  }
  const tipoBtn = (val, lbl) => ({
    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
    border: `1.5px solid ${tipo === val ? '#7c3aed' : 'var(--border, #2a2a3a)'}`,
    background: tipo === val ? 'rgba(124,58,237,.15)' : 'transparent',
    color: tipo === val ? '#a78bfa' : 'var(--text)',
  })
  const pagBtn = (val, lbl) => ({
    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
    border: `1.5px solid ${pagamento === val ? '#16a34a' : 'var(--border, #2a2a3a)'}`,
    background: pagamento === val ? 'rgba(34,197,94,.12)' : 'transparent',
    color: pagamento === val ? '#16a34a' : 'var(--text)',
  })

  return (
    <>
    <div className="pp-modal-overlay" onClick={onFechar}>
      <div className="pp-modal pp-venda" onClick={e => e.stopPropagation()}>
        <p className="pp-modal-titulo">{editando ? `Editar pedido #${pedidoEdicao.numero_pedido ?? ''}` : 'Nova venda (balcão)'}</p>

        {/* Duas colunas na tela grande, uma só no celular (ver PainelPedidos.css).
            À esquerda o que o vendedor fica repetindo — buscar produto e conferir
            o carrinho; à direita o que ele preenche uma vez por venda. Numa tela
            larga a coluna única deixava a lista de produtos com 5 linhas visíveis
            e metade da tela vazia. */}
        <div className="pp-venda-grid">
        <div className="pp-venda-col">

        {/* Leitor de print — pra loja que recebe pedido por outro canal (iFood,
            WhatsApp...): tira o print de lá e a IA preenche a venda.
            A caixa é uma "zona de colar": clica nela e aperta Ctrl+V. */}
        {!editando && (
          <div style={{ marginBottom: 12 }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf,.pdf"
              style={{ display: 'none' }}
              onChange={e => lerPrint(e.target.files?.[0])}
            />
            <div
              ref={pasteRef}
              tabIndex={0}
              /* O Ctrl+V é tratado pelo listener global (useEffect). NÃO colocar
                 onPaste aqui também — senão o print é lido 2x e a sacola duplica. */
              onFocus={() => setColarPronto(true)}
              onBlur={() => setColarPronto(false)}
              onClick={() => pasteRef.current?.focus()}
              style={{
                padding: '12px', borderRadius: 10, cursor: lendoPrint ? 'wait' : 'text', outline: 'none',
                border: `2px ${colarPronto ? 'solid' : 'dashed'} #7c3aed`,
                background: colarPronto ? 'rgba(124,58,237,.18)' : 'rgba(124,58,237,.08)',
                textAlign: 'center', transition: 'all .15s',
              }}
            >
              <div style={{ color: '#a78bfa', fontWeight: 700, fontSize: 13.5 }}>
                {lendoPrint
                  ? '⏳ Lendo o pedido...'
                  : colarPronto
                    ? '📋 Agora aperte Ctrl+V pra colar o print'
                    : '📷 Ler print ou PDF do pedido — clique aqui e aperte Ctrl+V'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                Recebeu por iFood/WhatsApp? Cole o print (Ctrl+V) ou anexe um PDF — a IA preenche tudo.
              </div>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); fileRef.current?.click() }}
                disabled={lendoPrint || loading}
                style={{
                  marginTop: 8, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid var(--border,#2a2a3a)', background: 'transparent',
                  color: 'var(--text-muted)', fontWeight: 600, fontSize: 12,
                }}
              >
                ou escolher imagem/PDF do computador
              </button>
            </div>
            {msgPrint && (
              <div style={{
                marginTop: 8, fontSize: 12.5, fontWeight: 600, padding: '7px 10px', borderRadius: 8,
                background: msgPrint.tipo === 'erro' ? 'rgba(239,68,68,.12)' : msgPrint.tipo === 'aviso' ? 'rgba(234,179,8,.12)' : 'rgba(34,197,94,.12)',
                color: msgPrint.tipo === 'erro' ? '#ef4444' : msgPrint.tipo === 'aviso' ? '#eab308' : '#16a34a',
              }}>
                {msgPrint.txt}
              </div>
            )}
          </div>
        )}

        {/* Produtos */}
        <input
          type="search" value={busca} onChange={e => setBusca(e.target.value)}
          onKeyDown={teclaBusca}
          placeholder="Buscar produto... (↑ ↓ e Enter)" style={{ ...inputSt, marginBottom: 8 }}
        />
        <div ref={listaRef} className="pp-venda-lista" style={{ overflowY: 'auto', flexShrink: 0, border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 6, marginBottom: 14 }}>
          {loading ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16, fontSize: 13 }}>Carregando produtos...</div>
          ) : filtrados.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16, fontSize: 13 }}>
              {produtos.length === 0 ? 'Nenhum produto cadastrado.' : `Nenhum produto com “${busca}”. (${produtos.length} produtos no catálogo)`}
            </div>
          ) : filtrados.map((p, idx) => {
            const qtd = cart[p.id]?.qtd ?? 0
            const faixa1 = menorFaixa(p.faixas_preco)
            const marcado = idx === destaque && !!buscaNorm
            return (
              <div key={p.id} className="pp-venda-linha"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 6px', borderRadius: 8,
                  background: marcado ? 'rgba(124,58,237,.18)' : 'transparent',
                  boxShadow: marcado ? 'inset 0 0 0 1.5px #7c3aed' : 'none' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="pp-venda-nome" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.nome}</div>
                  <div className="pp-venda-sub" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {fmt(p.preco_venda)}
                    {/* O degrau do atacado na própria lista: o caixa vê que
                        existe preço melhor antes de bater a quantidade. */}
                    {faixa1 ? <span style={{ color: '#22c55e', fontWeight: 700 }}> · {faixa1.qtd_min}+ {fmt(faixa1.preco)}</span> : null}
                    {compMap[p.id]?.length ? <span style={{ color: '#7c3aed', fontWeight: 700 }}> · monte</span> : null}
                  </div>
                </div>
                {qtd > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <button type="button" onClick={() => subItem(p.id)} style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid var(--border,#2a2a3a)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontWeight: 800, fontSize: 16 }}>−</button>
                    <QtdInput value={qtd} onChange={n => setItemQtd(p, n)} />
                    <button type="button" onClick={() => addItem(p)} style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontWeight: 800, fontSize: 16 }}>+</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => pedirProduto(p)} style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 8, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>{compMap[p.id]?.length ? 'Escolher' : 'Adicionar'}</button>
                )}
              </div>
            )
          })}
        </div>

        </div>{/* fim da coluna da esquerda */}
        <div className="pp-venda-col">

        {/* Itens da venda — é a lista que o caixa confere em voz alta com o
            cliente. Ficava espremida embaixo da busca, em letra de 13px; agora
            mora do lado do total, que é o outro número que os dois olham. */}
        <div className="pp-venda-itens">
          <div className="pp-venda-itens-cab">
            <span>Itens da venda</span>
            {itens.length > 0 && <span>{itens.reduce((n, i) => n + i.qtd, 0)} un</span>}
          </div>

          {itens.length === 0 ? (
            <div className="pp-venda-itens-vazio">
              Nenhum item ainda — busque o produto ao lado.
            </div>
          ) : (
            <div className="pp-venda-itens-lista">
              {itens.map(i => {
                const temComp = Array.isArray(i.complementos) && i.complementos.length > 0
                const btnQtd = { width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border,#2a2a3a)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontWeight: 800, fontSize: 16, lineHeight: 1, flexShrink: 0 }
                return (
                  <div key={i.id} className="pp-venda-item">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      <button type="button" onClick={() => subItem(i.id)} title="Diminuir" style={btnQtd}>−</button>
                      <span className="pp-venda-item-qtd">{i.qtd}</span>
                      <button type="button" onClick={() => maisItem(i.id)} title="Aumentar" style={btnQtd}>+</button>
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="pp-venda-item-nome">{i.nome}</div>
                      {/* Unitário ao lado do total: sem ele o caixa não confere
                          o preço de cabeça quando a quantidade é alta. */}
                      <div className="pp-venda-item-unit">
                        {fmt(i.preco)} cada
                        {temComp && i.complementos.map((c, j) => (
                          <span key={j}> · {Number(c.qtd ?? 1)}× {c.nome}</span>
                        ))}
                      </div>
                    </div>

                    <span className="pp-venda-item-total">{fmt(i.preco * i.qtd)}</span>

                    {temComp && (
                      <button type="button" title="Editar complementos"
                        onClick={() => {
                          const pr = produtosComPreco.find(x => x.id === i.produto_id)
                          const grupos = compMap[i.produto_id]
                          // Abre o modal JÁ preenchido com o que estava escolhido; só troca
                          // ao confirmar (se fechar no X, o item original continua).
                          if (pr && grupos?.length) setProdutoComp({ ...pr, grupos, _editId: i.id, _iniciais: i.complementos ?? [], _qtd: i.qtd })
                        }}
                        style={{ background: 'none', border: 'none', color: '#7c3aed', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>✏️</button>
                    )}
                    <button type="button" onClick={() => removeItem(i.id)} title="Remover"
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Cliente — busca os já cadastrados pelo nome */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                value={nome}
                onChange={e => { setNome(e.target.value); setClienteSelId(null); setMsgCli(null); buscarClientes(e.target.value) }}
                placeholder="Nome ou telefone do cliente (busca os cadastrados)"
                style={inputSt}
                autoComplete="off"
              />
              {sugestoes.length > 0 && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 5,
                  background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
                  borderRadius: 8, maxHeight: 200, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.3)',
                }}>
                  {sugestoes.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => selecionarCliente(c)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '8px 11px',
                        background: 'transparent', border: 'none', borderBottom: '1px solid var(--border,#2a2a3a)',
                        cursor: 'pointer', color: 'var(--text)',
                      }}
                    >
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.nome}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {c.telefone || 'sem telefone'}{c.bairro ? ` · ${c.bairro}` : ''}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input value={telefone} onChange={e => { setTelefone(e.target.value); setClienteSelId(null) }} placeholder="Telefone (opcional)" style={{ ...inputSt, maxWidth: 160 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <button
              type="button"
              onClick={() => setCadastroAberto(true)}
              style={{
                background: 'none', border: '1px dashed var(--border, #2a2a3a)', borderRadius: 8,
                padding: '5px 10px', cursor: 'pointer',
                color: 'var(--primary, #a78bfa)', fontWeight: 700, fontSize: 12.5,
              }}
            >
              + Cadastrar novo cliente
            </button>
            {clienteSelId && <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700 }}>● cliente vinculado</span>}
            {msgCli && <span style={{ fontSize: 12, color: msgCli.includes('✓') ? '#16a34a' : 'var(--danger,#ef4444)' }}>{msgCli}</span>}
          </div>
        </div>

        {/* Tipo */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button type="button" style={tipoBtn('retirada')} onClick={() => setTipo('retirada')}>Balcão / Retirada</button>
          <button type="button" style={tipoBtn('entrega')} onClick={() => setTipo('entrega')}>Entrega</button>
        </div>

        {tipo === 'entrega' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
            <div style={{ position: 'relative' }}>
              <input
                value={cep}
                onChange={e => { setCep(e.target.value); buscarCepVenda(e.target.value) }}
                placeholder="CEP (preenche o endereço)"
                inputMode="numeric"
                style={inputSt}
              />
              {buscandoCepVenda && (
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11.5, color: '#a78bfa', fontWeight: 600 }}>buscando...</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input value={rua} style={inputSt} autoComplete="off"
                  placeholder="Rua (digite o nome e escolha)"
                  onChange={e => { setRua(e.target.value); setRuaSugAberta(true) }}
                  onFocus={() => setRuaSugAberta(true)} />
                {ruaSugAberta && ruaSug.length > 0 && (
                  <ListaDeRuas
                    sugestoes={ruaSug}
                    onFechar={() => setRuaSugAberta(false)}
                    onEscolher={r => {
                      const c = String(r.cep ?? '').replace(/\D/g, '')
                      setRua(r.logradouro || rua)
                      if (r.bairro) setBairro(r.bairro)
                      if (r.localidade) setCidade(r.localidade)
                      // Rua do mapa não traz CEP: limpa o campo em vez de deixar o
                      // CEP da rua escolhida antes, que é de outro lugar.
                      setCep(c.length === 8 ? `${c.slice(0, 5)}-${c.slice(5)}` : '')
                      setRuaSug([]); setRuaSugAberta(false)
                    }}
                  />
                )}
              </div>
              <input value={numero} onChange={e => setNumero(e.target.value)} placeholder="Nº" style={{ ...inputSt, maxWidth: 90 }} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={bairro} onChange={e => setBairro(e.target.value)} placeholder="Bairro" style={inputSt} />
              <input value={cidade} onChange={e => setCidade(e.target.value)} placeholder="Cidade" style={inputSt} />
            </div>
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                <input value={taxa} onChange={e => { setTaxa(e.target.value); setCalcTaxa({ loading: false, msg: null }) }} placeholder="Taxa de entrega (R$)" inputMode="decimal" style={inputSt} />
                <button
                  type="button"
                  onClick={calcularTaxaPorEndereco}
                  disabled={calcTaxa.loading}
                  title="Calcular a taxa pela distância entre a loja e o endereço do cliente"
                  style={{
                    flexShrink: 0, padding: '0 12px', borderRadius: 8, cursor: calcTaxa.loading ? 'wait' : 'pointer',
                    border: '1.5px solid #7c3aed', background: 'rgba(124,58,237,.12)',
                    color: '#a78bfa', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap',
                  }}
                >
                  {calcTaxa.loading ? '⏳ Calculando...' : '📍 Calcular pela distância'}
                </button>
              </div>
              {calcTaxa.msg && (
                <div style={{
                  marginTop: 5, fontSize: 12, fontWeight: 600,
                  color: calcTaxa.msg.tipo === 'erro' ? 'var(--danger,#ef4444)' : calcTaxa.msg.tipo === 'aviso' ? '#eab308' : '#16a34a',
                }}>
                  {calcTaxa.msg.txt}
                </div>
              )}
            </div>

            {/* Ponto da entrega (mig 0238) — o que o entregador vai seguir */}
            {(() => {
              const pinConfirmado = !!pinSalvo && chaveEnderecoJS({ rua, numero, cidade }) === pinSalvo.ref
              const semNumero = !!rua.trim() && !numero.trim()
              const cor = pinConfirmado ? '#16a34a' : coordCliente ? '#eab308' : 'var(--text-muted,#9aa1ad)'
              const txt = pinConfirmado
                ? '📍 Ponto confirmado pelo cliente — o entregador vai direto na porta.'
                : semNumero
                  ? '📍 Falta o número: o ponto no mapa só é buscado depois dele (sem número o mapa chuta o meio da rua).'
                  : coordCliente
                    ? '📍 Ponto pelo mapa, aproximado. Peça a confirmação pro cliente marcar a casa dele.'
                    : '📍 Sem ponto no mapa — o entregador vai só pelo texto do endereço.'
              return (
                <div style={{
                  padding: '9px 11px', borderRadius: 8, background: 'var(--bg-alt,rgba(255,255,255,.03))',
                  border: '1px solid var(--border,#2a2f3a)',
                }}>
                  <div style={{ fontSize: 12, color: cor, fontWeight: 600, lineHeight: 1.5 }}>{txt}</div>
                  {!pinConfirmado && (
                    <button
                      type="button" onClick={pedirConfirmacaoNoMapa} disabled={pinBusy || !rua.trim()}
                      style={{
                        marginTop: 7, padding: '7px 11px', borderRadius: 7,
                        border: '1.5px solid #7c3aed', background: 'rgba(124,58,237,.12)',
                        color: '#a78bfa', fontWeight: 700, fontSize: 12.5,
                        cursor: pinBusy ? 'wait' : 'pointer',
                      }}
                    >
                      {pinBusy ? '⏳ Gerando...' : '📲 Pedir confirmação no mapa'}
                    </button>
                  )}
                  {pinMsg && (
                    <div style={{
                      marginTop: 6, fontSize: 11.5, fontWeight: 600,
                      color: pinMsg.tipo === 'erro' ? 'var(--danger,#ef4444)' : pinMsg.tipo === 'aviso' ? '#eab308' : '#16a34a',
                    }}>
                      {pinMsg.txt}
                    </div>
                  )}
                  {pinLink && (
                    <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted,#9aa1ad)', wordBreak: 'break-all' }}>
                      {pinLink.url}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )}

        {/* Pagamento — só as formas ligadas em Minha Loja → Pagamento */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {FORMAS_PAGAMENTO.filter(f => formasLoja.includes(f.value)).map(f => (
            <button key={f.value} type="button" style={pagBtn(f.value)} onClick={() => setPagamento(f.value)}>
              {f.label}
            </button>
          ))}
        </div>
        {pagamento === 'dinheiro' && (
          <input value={troco} onChange={e => setTroco(e.target.value)} placeholder="Troco para (R$) — opcional" inputMode="decimal" style={{ ...inputSt, marginBottom: 10 }} />
        )}

        <input value={obs} onChange={e => setObs(e.target.value)} placeholder="Observações (opcional)" style={{ ...inputSt, marginBottom: 14 }} />

        {/* Total em painel — é o número que o cliente pergunta e o caixa fala
            em voz alta. Em linha de 18px no meio do formulário ele se perdia
            entre os campos. Quando tem taxa, a conta aparece por cima, senão o
            valor "não bate" com a soma dos itens e vira discussão no balcão. */}
        <div className="pp-venda-total">
          {taxaNum > 0 && (
            <div className="pp-venda-total-conta">
              <span>Itens {fmt(subtotal)}</span>
              <span>+ entrega {fmt(taxaNum)}</span>
            </div>
          )}
          <div className="pp-venda-total-linha">
            <span className="pp-venda-total-rot">Total</span>
            <span className="pp-venda-total-val">{fmt(total)}</span>
          </div>
        </div>

        {erro && <p style={{ fontSize: 13, color: 'var(--danger, #ef4444)', margin: '0 0 10px' }}>{erro}</p>}
        {zapErro && (
          <p style={{ fontSize: 12.5, color: '#eab308', margin: '0 0 10px', lineHeight: 1.45 }}>
            Não deu pra enviar pelo WhatsApp da loja: {zapErro} — abri o app com a mensagem pronta.
          </p>
        )}

        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={editando ? onFechar : cancelar}>Cancelar</button>
          <button
            type="button"
            className="pp-modal-btn-secondary"
            style={podeMandarZap
              ? { borderColor: '#16a34a', color: '#16a34a' }
              : { opacity: .45, cursor: 'not-allowed' }}
            disabled={!podeMandarZap}
            title={podeMandarZap
              ? 'Abre o WhatsApp com o pedido escrito pra você só enviar'
              : 'Preencha o telefone do cliente e adicione ao menos um item'}
            onClick={mandarNoZap}
          >
            {zapStatus === 'enviando' ? 'Enviando...'
              : zapStatus === 'ok' ? '✅ Enviado'
              : zapStatus === 'manual' ? '💬 Mandar de novo'
              : '💬 Mandar pro cliente'}
          </button>
          <button
            type="button"
            className="pp-modal-btn-danger"
            style={{ background: '#7c3aed', borderColor: '#7c3aed' }}
            disabled={salvando || itens.length === 0}
            onClick={concluir}
          >
            {salvando ? 'Salvando...' : `${editando ? 'Salvar alterações' : 'Concluir venda'} · ${fmt(total)}`}
          </button>
        </div>

        </div>{/* fim da coluna da direita */}
        </div>{/* fim do grid */}
      </div>
    </div>

    {cadastroAberto && (
      <ModalNovoCliente
        empresa={empresa}
        initialNome={nome}
        initialTel={telefone}
        onFechar={() => setCadastroAberto(false)}
        onSalvo={aoCadastrarCliente}
      />
    )}

    {produtoComp && (
      <ModalComplementos
        produto={produtoComp}
        iniciais={produtoComp._iniciais ?? []}
        onFechar={() => setProdutoComp(null)}
        onConfirmar={(prod, selecoes, precoUnit, qtdItem, adicionalUnit) => {
          // Edição: tira a linha antiga e recria com a escolha nova, mantendo a
          // qtd — menos no atacado, onde a quantidade É a soma dos sabores e
          // acabou de ser recontada.
          const atacado = selecoes.some(s => s.absoluto)
          if (produtoComp._editId) {
            removeItem(produtoComp._editId)
            adicionarComComplementos(prod, selecoes, precoUnit, atacado ? qtdItem : produtoComp._qtd, qtdItem, adicionalUnit)
          } else {
            adicionarComComplementos(prod, selecoes, precoUnit, undefined, qtdItem, adicionalUnit)
          }
        }}
      />
    )}
    </>
  )
}

// ── Card de pedido ──────────────────────────────────────────
// Seletor pra o gestor atrelar um entregador a um pedido (ex.: pedido do iFood
// que foi despachado sem motoboy). Ao escolher, o pedido passa a aparecer no
// app daquele entregador.
function SeletorEntregador({ entregadores = [], onAtribuir, pedidoId }) {
  if (!entregadores.length) {
    return (
      <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '0 0 8px' }}>
        Nenhum entregador cadastrado ainda.
      </p>
    )
  }
  return (
    <select
      defaultValue=""
      onChange={e => { if (e.target.value) onAtribuir?.(pedidoId, e.target.value) }}
      style={{
        width: '100%', padding: '9px 12px', borderRadius: 8, marginBottom: 8,
        border: '1.5px solid var(--border)', background: 'var(--surface)',
        color: 'var(--text)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
      }}
    >
      <option value="">🛵 Atribuir / trocar entregador...</option>
      {entregadores.map(en => <option key={en.id} value={en.id}>{en.nome}</option>)}
    </select>
  )
}

// Card de configuração da impressora do CELULAR (Bluetooth / Web Bluetooth).
// Isolado do FWC — só conecta e testa a térmica Bluetooth pelo Chrome do Android.
// Mesma lista do filtro do app FWC. Duplicada de propósito: a de lá vive dentro
// do componente principal e é enviada pro app do PC; esta fica no navegador.
const ORIGENS_IMPRESSORA = [
  { k: 'mesa', lbl: 'Mesa (comandas)' },
  { k: 'whatsapp', lbl: 'WhatsApp' },
  { k: 'ifood', lbl: 'iFood' },
  { k: 'balcao', lbl: 'Balcão' },
  { k: 'cardapio', lbl: 'Cardápio (loja online)' },
  { k: 'app', lbl: 'App' },
]

function ImpressoraCelularPanel({ empresa }) {
  const [conectada, setConectada] = useState(false)
  const [nome, setNome] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const semBt = typeof navigator !== 'undefined' && !navigator.bluetooth

  // Religa a impressora sozinho quando a tela volta a ficar visível (ex.: o dono
  // saiu pro WhatsApp e voltou — o Android derruba o Bluetooth em background).
  // Assim ele não precisa clicar "Conectar" de novo toda vez.
  useEffect(() => {
    let vivo = true
    async function tentar() {
      if (document.visibilityState !== 'visible') return
      try {
        const mod = await import('../utils/imprimirBluetooth')
        if (mod.estaConectada()) { if (vivo) { setConectada(true); setNome(mod.nomeImpressora()) } return }
        const ok = await mod.reconectarSilencioso()
        if (!vivo) return
        setConectada(ok)
        if (ok) setNome(mod.nomeImpressora())
      } catch { /* ignora */ }
    }
    tentar()
    document.addEventListener('visibilitychange', tentar)
    window.addEventListener('focus', tentar)
    return () => { vivo = false; document.removeEventListener('visibilitychange', tentar); window.removeEventListener('focus', tentar) }
  }, [])

  async function rodar(fn, okTxt) {
    setBusy(true); setMsg(null)
    try {
      const mod = await import('../utils/imprimirBluetooth')
      await fn(mod)
      setConectada(true); setNome(mod.nomeImpressora())
      setMsg({ ok: true, txt: okTxt })
    } catch (e) { setMsg({ ok: false, txt: e?.message || 'Falhou' }) }
    finally { setBusy(false) }
  }
  // Papel desta impressora (mig 0184). Fica no navegador DESTE aparelho, igual
  // ao pareamento — é o que faz um celular ser o da cozinha e outro o da frente.
  const [setor, setSetorLocal] = useState('tudo')
  useEffect(() => {
    import('../utils/imprimirBluetooth').then(m => setSetorLocal(m.setorDaImpressora())).catch(() => {})
  }, [])
  async function escolherSetor(v) {
    setSetorLocal(v)
    try { const m = await import('../utils/imprimirBluetooth'); m.definirSetorDaImpressora(v) } catch { /* ok */ }
  }

  // O que esta impressora imprime, por origem. Mesma lista do app do PC — mas
  // guardada aqui no navegador, porque no celular não existe app pra guardar.
  const [origens, setOrigens] = useState({})
  useEffect(() => {
    import('../utils/imprimirBluetooth').then(m => setOrigens(m.origensDaImpressora())).catch(() => {})
  }, [])
  async function alternarOrigem(k) {
    const nova = origens[k] === false
    setOrigens(prev => ({ ...prev, [k]: nova }))
    try { const m = await import('../utils/imprimirBluetooth'); m.definirOrigemDaImpressora(k, nova) } catch { /* ok */ }
  }

  const conectar = () => rodar(m => m.conectarImpressoraCelular(), 'Conectada! Agora use o botão 📱🖨️ nos pedidos.')
  const testar = () => rodar(m => m.imprimirTesteCelular(empresa || {}), 'Enviei um cupom de teste!')

  const btn = (bg, outline) => ({ padding: '10px 14px', borderRadius: 8, border: outline ? '1px solid #2563eb' : 'none', cursor: busy ? 'wait' : 'pointer', background: bg, color: outline ? '#2563eb' : '#fff', fontWeight: 800, fontSize: 13, opacity: (busy || semBt) ? .6 : 1 })
  return (
    <div style={{ border: '2px solid #2563eb', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, background: 'rgba(37,99,235,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 800 }}>📱🖨️ Impressora do celular (Bluetooth)</span>
        {conectada && <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 800 }}>● conectada</span>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Pra imprimir só pelo <b>celular</b> numa térmica Bluetooth, sem PC. Abra este gestor no <b>Chrome do Android</b> (não pelo app), ligue a impressora e conecte aqui.
      </div>
      {semBt && <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 700 }}>⚠️ Este navegador não tem Bluetooth. Abra pelo Chrome no Android.</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy || semBt} onClick={conectar} style={btn('#2563eb', false)}>{busy ? '…' : (conectada ? 'Reconectar' : 'Conectar impressora')}</button>
        <button type="button" disabled={busy || semBt} onClick={testar} style={btn('transparent', true)}>Imprimir teste</button>
      </div>
      {nome && <div style={{ fontSize: 12, color: 'var(--text)' }}>Impressora: <b>{nome}</b></div>}
      {conectada && (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#a16207', background: 'rgba(234,179,8,.10)', border: '1px solid #eab308', borderRadius: 8, padding: '9px 11px' }}>
          📌 <b>Este aparelho é a impressora da loja.</b> O garçom lança do celular dele e o papel sai <b>aqui</b> —
          então deixe esta tela aberta e o aparelho <b>na tomada</b>. Enquanto a impressora estiver ligada a tela fica
          acesa sozinha; se você fechar o gestor ou o celular desligar, o pedido não sai.
        </div>
      )}
      {msg && <div style={{ fontSize: 12, color: msg.ok ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{msg.ok ? '✓ ' : '⚠️ '}{msg.txt}</div>}
      <div style={{ borderTop: '1px solid var(--border, #2a2a3a)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>O que ESTA impressora imprime</span>
        <select value={setor} onChange={e => escolherSetor(e.target.value)} style={{
          width: '100%', padding: '9px 10px', borderRadius: 8, fontSize: 13, fontWeight: 700,
          border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
        }}>
          <option value="tudo">📄 Tudo</option>
          <option value="cozinha">🍳 Só cozinha</option>
          <option value="frente">🧾 Só frente (salão)</option>
        </select>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {setor === 'cozinha'
            ? 'Só os itens de categoria marcada como Cozinha. Conta, pré-conta e fechamento NÃO saem aqui.'
            : setor === 'frente'
              ? 'Tudo que NÃO é da cozinha, mais conta, pré-conta e fechamento.'
              : 'Uma impressora só: sai tudo, como sempre. Marque o setor de cada categoria em Produtos → Categorias antes de dividir.'}
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border, #2a2a3a)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>De onde ela imprime</span>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 2 }}>
          Desligue o que NÃO deve sair neste aparelho. Ex.: celular da cozinha = só <b>Mesa</b>.
        </div>
        {ORIGENS_IMPRESSORA.map(({ k, lbl }) => (
          <ToggleRow key={k} label={lbl} ativo={origens[k] !== false} onToggle={() => alternarOrigem(k)} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Se a impressora não aparecer na lista do Chrome, ela é Bluetooth "Classic" — aí usamos o app RawBT.</div>
    </div>
  )
}

// Botão "Atualizar o app agora" — força pegar a versão nova na hora (limpa os
// caches do PWA e recarrega). Garantia manual caso a atualização automática
// demore no celular. Igual ao "Atualizar agora" da Impressora FWC.
function AtualizarAppCard() {
  const [busy, setBusy] = useState(false)
  async function atualizar() {
    setBusy(true)
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map(r => r.update().catch(() => {})))
      }
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys()
        await Promise.all(keys.map(k => caches.delete(k)))
      }
    } catch { /* ignora e recarrega mesmo assim */ }
    window.location.reload()
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <button type="button" onClick={atualizar} disabled={busy} title="Pegar a versão mais nova agora"
        style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', cursor: busy ? 'wait' : 'pointer', background: '#2563eb', color: '#fff', fontSize: 20, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: busy ? .6 : 1 }}>
        {busy ? '…' : '🔄'}
      </button>
      <div style={{ fontSize: 12.5 }}>
        <b>Atualizar o app agora</b>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Pega a versão mais nova na hora, sem precisar limpar cache na mão.</div>
      </div>
    </div>
  )
}

function CardPedido({ pedido, onConfirmar, onRecusar, onExpirado, onAvancar, onEnviarMensagem, onImprimir, onImprimirCelular, onAtribuir, onEditar, entregadores = [], nfceHabilitada = false, onEmitirNfce, nfceEmitindo }) {
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const pagamento = pedido.forma_pagamento || ''
  const endereco = enderecoCompleto(pedido)
  const hora = new Date(pedido.created_at).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const tipoEntrega = pedido.tipo_entrega || 'entrega'
  const isRetirada = tipoEntrega === 'retirada'
  // iFood: a confirmação de entrega é feita pelo CÓDIGO DO IFOOD (validado na API
  // do iFood), não pelo nosso código interno. ifood_requer_codigo vem do handshake.
  const isIfood = pedido.origem === 'ifood'
  const precisaCodigoIfood = isIfood && pedido.ifood_requer_codigo
  // Precisa digitar código? iFood (código do iFood) ou nosso pedido com código gerado.
  const precisaCodigo = precisaCodigoIfood || (!isIfood && !!pedido.codigo_entrega)

  // Estado local para input de código de confirmação (saiu_entrega)
  const [codigoDigitos, setCodigoDigitos] = useState(['', '', '', ''])
  const [erroLocal, setErroLocal] = useState(null)
  const digitRefs = useRef([])
  const [confirmandoEntrega, setConfirmandoEntrega] = useState(false)
  const [verificandoIfood, setVerificandoIfood] = useState(false)

  function handleDigitChange(i, v) {
    const digit = v.replace(/\D/g, '').slice(-1)
    const novos = [...codigoDigitos]
    novos[i] = digit
    setCodigoDigitos(novos)
    setErroLocal(null)
    if (digit && i < 3) digitRefs.current[i + 1]?.focus()
  }

  function handleKeyDown(i, e) {
    if (e.key === 'Backspace' && !codigoDigitos[i] && i > 0) {
      const novos = [...codigoDigitos]
      novos[i - 1] = ''
      setCodigoDigitos(novos)
      digitRefs.current[i - 1]?.focus()
    }
  }

  async function handleConfirmarComCodigo() {
    const codigo = codigoDigitos.join('')
    // iFood: valida o código NA API do iFood (não é o nosso código interno).
    if (precisaCodigoIfood) {
      setVerificandoIfood(true); setErroLocal(null)
      try {
        const { data, error } = await supabase.functions.invoke('ifood-integration', {
          body: { acao: 'verify_delivery_code', pedido_id: pedido.id, codigo },
        })
        if (error || !data?.valid) {
          setErroLocal('Código do iFood inválido. Confira com o cliente.')
          setCodigoDigitos(['', '', '', ''])
          digitRefs.current[0]?.focus()
          return
        }
        // iFood aceitou — o backend já concluiu; atualiza o quadro.
        onAvancar(pedido.id, 'entregue')
      } catch {
        setErroLocal('Erro ao validar no iFood. Tente de novo.')
      } finally {
        setVerificandoIfood(false)
      }
      return
    }
    // Fluxo normal (nosso código de 4 dígitos)
    if (pedido.codigo_entrega && codigo !== String(pedido.codigo_entrega).trim()) {
      setErroLocal('Código incorreto.')
      setCodigoDigitos(['', '', '', ''])
      digitRefs.current[0]?.focus()
      return
    }
    onAvancar(pedido.id, 'entregue')
  }

  // urgencia afeta a borda esquerda (só faz sentido para aguardando)
  // ATENÇÃO: getUrgencia retorna 'ok' | 'atencao' | 'critico' — o CSS usa as mesmas strings
  const urgenciaAtual = pedido.status === 'aguardando'
    ? getUrgencia(getTempoRestante(pedido.created_at, pedido.aguardando_desde))
    : 'ok'

  const badgeSt = BADGE_STATUS_COR[pedido.status] ?? BADGE_STATUS_COR.aguardando
  const origemCfg = ORIGEM_CONFIG[pedido.origem] ?? ORIGEM_CONFIG.cardapio

  return (
    <div className={`pp-card urgencia-${urgenciaAtual}`} style={{ borderTop: `3px solid ${origemCfg.borda}` }}>
      {/* Header */}
      <div className="pp-card-header">
        <div className="pp-card-header-left">
          {/* Nos pedidos do iFood, o número do iFood é o principal (grande);
              o nosso número interno fica pequeno ao lado. */}
          {pedido.origem === 'ifood' && pedido.ifood_display_id ? (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
              <span className="pp-numero" style={{ color: '#ea1d2c' }}>iFood #{pedido.ifood_display_id}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>#{pedido.numero_pedido ?? ''}</span>
            </span>
          ) : (
            <span className="pp-numero">#{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}</span>
          )}
          {/* Badge de origem */}
          <span style={{
            background: origemCfg.bg,
            color: origemCfg.color,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 7px',
            borderRadius: 20,
            letterSpacing: '0.03em',
            flexShrink: 0,
          }}>
            {origemCfg.label}
          </span>
          {/* Badge de status para pedidos não-aguardando */}
          {pedido.status !== 'aguardando' && (
            <span
              className="pp-status-badge"
              style={{ background: badgeSt.bg, color: badgeSt.color }}
            >
              {LABEL_STATUS[pedido.status] ?? pedido.status}
            </span>
          )}
        </div>
        <div className="pp-card-header-right">
          {/* Badge tipo entrega */}
          <span className={`pp-tipo-badge ${isRetirada ? 'retirada' : 'entrega'}`}>
            {isRetirada ? 'Retirada' : 'Entrega'}
          </span>
          <span className="pp-hora">{hora}</span>
          {/* Imprimir cupom */}
          <button
            type="button"
            title="Imprimir cupom"
            aria-label="Imprimir cupom"
            onClick={() => onImprimir(pedido)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 2,
              display: 'flex', alignItems: 'center', color: 'var(--text-muted)',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
          </button>
          {/* Impressora do CELULAR (Bluetooth) — caminho separado, isolado */}
          {onImprimirCelular && (
            <button
              type="button"
              title="Imprimir na impressora do celular (Bluetooth)"
              aria-label="Imprimir na impressora do celular (Bluetooth)"
              onClick={() => onImprimirCelular(pedido)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 2,
                display: 'flex', alignItems: 'center', color: '#2563eb',
              }}
            >
              📱🖨️
            </button>
          )}
          {/* Emitir NFC-e — só aparece se a loja habilitou a nota fiscal */}
          {nfceHabilitada && onEmitirNfce && (
            <button
              type="button"
              title="Emitir NFC-e deste pedido"
              aria-label="Emitir NFC-e"
              disabled={nfceEmitindo === pedido.id}
              onClick={() => onEmitirNfce(pedido)}
              style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                cursor: nfceEmitindo === pedido.id ? 'wait' : 'pointer', padding: '2px 6px',
                display: 'flex', alignItems: 'center', gap: 4,
                color: 'var(--primary)', fontSize: 11, fontWeight: 700,
                opacity: nfceEmitindo === pedido.id ? 0.6 : 1,
              }}
            >
              🧾 {nfceEmitindo === pedido.id ? '...' : 'NFC-e'}
            </button>
          )}
        </div>
      </div>

      {/* Timer — só para pedidos aguardando, e só depois da hora combinada */}
      {pedido.status === 'aguardando' && !agendadoAindaVai(pedido) && (
        <TimerRegressivo
          createdAt={inicioDoAceite(pedido)}
          aguardandoDesde={null}
          onExpirado={() => onExpirado(pedido.id)}
        />
      )}

      {/* Cliente */}
      <div className="pp-cliente">
        <span className="pp-cliente-nome">{pedido.cliente_nome || '—'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {pedido.cliente_telefone && (
            <a href={`tel:${pedido.cliente_telefone}`} className="pp-cliente-tel">
              {pedido.cliente_telefone}
            </a>
          )}
          {pedido.cliente_telefone && (
            <button
              type="button"
              title="Enviar mensagem pelo WhatsApp"
              onClick={() => onEnviarMensagem(pedido)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: 2, display: 'flex', alignItems: 'center',
                color: '#25d366',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.558 4.118 1.533 5.845L.057 23.899l6.199-1.476A11.954 11.954 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.814 9.814 0 0 1-5.002-1.368l-.359-.214-3.68.875.938-3.577-.234-.369A9.818 9.818 0 0 1 2.182 12C2.182 6.579 6.579 2.182 12 2.182S21.818 6.579 21.818 12 17.421 21.818 12 21.818z"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Endereco — só para entrega */}
      {!isRetirada && endereco && (
        <div className="pp-endereco">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          {endereco}
        </div>
      )}
      {isRetirada && (
        <div className="pp-endereco" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Cliente vai retirar na loja
        </div>
      )}

      {/* Itens */}
      {itens.length > 0 && (
        <ul className="pp-itens">
          {itens.map((item, i) => {
            const qtd = item.qtd ?? item.quantidade ?? 1
            const sub = item.subtotal != null
              ? Number(item.subtotal)
              : qtd * Number(item.preco ?? item.preco_unitario ?? 0)
            const { nome: nomeItem, complementos } = separarItem(item)
            return (
              <li key={i} style={{ display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span><strong style={{ marginRight: 5 }}>{qtd}</strong>{nomeItem}</span>
                  <span style={{ whiteSpace: 'nowrap' }}>{fmt(sub)}</span>
                </div>
                {complementos.length > 0 && (
                  <div style={{ paddingLeft: 18, marginTop: 3, marginBottom: 4 }}>
                    {complementos.map((c, j) => (
                      <div key={j} style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        {Number(c.qtdTotal ?? 1)} {c.nome ?? c}
                      </div>
                    ))}
                  </div>
                )}
                {item.observacao && (
                  <div style={{ paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    obs: {item.observacao}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* Totais */}
      <div className="pp-totais">
        {pedido.origem === 'ifood' && pedido.ifood_valores ? (() => {
          const v = pedido.ifood_valores
          const subComTaxa = Number(v.itens || 0) + Number(v.taxa || 0)
          const aLojaRecebe = Number(v.pago || 0) + Number(v.incentivo_ifood || 0)
          // Cobrar na entrega quando NÃO é pré-pago (débito/crédito/dinheiro "via loja")
          const cobrar = !(pagamento === 'online' || (pagamento === 'pix' && (pedido.pix_status === 'pago' || pedido.mp_payment_status === 'approved')))
          return (
            <>
              <div className="pp-totais-row"><span>Itens</span><span>{fmt(v.itens)}</span></div>
              {!isRetirada && <div className="pp-totais-row"><span>Taxa de entrega</span><span>{fmt(v.taxa)}</span></div>}
              <div className="pp-totais-row"><span>Subtotal</span><span>{fmt(subComTaxa)}</span></div>
              {Number(v.incentivo_loja) > 0 && (
                <div className="pp-totais-row"><span>Desconto da loja</span><span>− {fmt(v.incentivo_loja)}</span></div>
              )}
              <div className="pp-totais-total" style={{ color: '#16a34a' }}><span>💰 A loja recebe</span><span>{fmt(aLojaRecebe)}</span></div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>• Cliente {cobrar ? 'paga na entrega' : 'pagou (via iFood)'}</span><span>{fmt(v.pago)}</span></div>
                {Number(v.incentivo_ifood) > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#16a34a', fontWeight: 700 }}><span>• Incentivo iFood (iFood repassa)</span><span>+ {fmt(v.incentivo_ifood)}</span></div>
                )}
              </div>
              {cobrar ? (
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#b45309', marginTop: 6 }}>
                  💵 Cobrar {fmt(v.pago)} do cliente na entrega ({pagamento || 'via loja'})
                </div>
              ) : (
                <div style={{ fontSize: 12, fontWeight: 700, color: '#16a34a', marginTop: 6 }}>
                  ✓ Pago via iFood — não precisa cobrar na entrega
                </div>
              )}
            </>
          )
        })() : (
          <>
            {pedido.subtotal != null && (
              <div className="pp-totais-row">
                <span>Subtotal</span>
                <span>{fmt(pedido.subtotal)}</span>
              </div>
            )}
            {!isRetirada && pedido.taxa_entrega != null && (
              <div className="pp-totais-row">
                <span>Taxa de entrega</span>
                <span>{fmt(pedido.taxa_entrega)}</span>
              </div>
            )}
            {/* Taxa do cartão repassada (mig 0223). Sem a linha, o total não
                fecha com subtotal + entrega e parece erro de conta. */}
            {Number(pedido.acrescimo || 0) > 0 && (
              <div className="pp-totais-row">
                <span>💳 Taxa do cartão</span>
                <span>{fmt(pedido.acrescimo)}</span>
              </div>
            )}
            {/* Cashback (mig 0178): sem esta linha o card mostrava subtotal de
                R$ 68 e total de R$ 28, e a loja não tinha como saber por quê —
                parecia erro de conta ou pedido adulterado. */}
            {Number(pedido.cashback_usado || 0) > 0 && (
              <div className="pp-totais-row" style={{ color: '#16a34a' }}>
                <span>🎟️ Cashback do cliente</span>
                <span>− {fmt(pedido.cashback_usado)}</span>
              </div>
            )}
            <div className="pp-totais-total">
              <span>Total</span>
              <span>{fmt(pedido.total)}</span>
            </div>
          </>
        )}
      </div>

      {/* Avaliação do cliente (pós-entrega) */}
      {pedido.avaliacao_nota && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 2px', fontSize: 13, flexWrap: 'wrap' }}>
          <span style={{ color: '#f59e0b', letterSpacing: 1, fontSize: 15 }}>
            {'★'.repeat(pedido.avaliacao_nota)}{'☆'.repeat(5 - pedido.avaliacao_nota)}
          </span>
          {pedido.avaliacao_comentario && (
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>“{pedido.avaliacao_comentario}”</span>
          )}
        </div>
      )}

      {/* Tempo de preparo prometido ao cliente */}
      {(pedido.status === 'confirmado' || pedido.status === 'em_preparo') && pedido.pronto_previsto_at && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 2px',
          fontSize: 13, fontWeight: 600, color: '#16a34a',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
          </svg>
          Pronto por volta de {new Date(pedido.pronto_previsto_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          {pedido.tempo_preparo_min ? ` (~${pedido.tempo_preparo_min} min)` : ''}
        </div>
      )}

      {/* Entregador — quem aceitou a entrega (o entregador se atribui na tela dele) */}
      {!isRetirada && ['pronto', 'saiu_entrega'].includes(pedido.status) && pedido.entregador_id && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 2px', fontSize: 13 }}>
          <span style={{ color: 'var(--text-muted)' }}>🛵 Entregador:</span>
          <strong style={{ color: 'var(--text)' }}>
            {entregadores.find(en => en.id === pedido.entregador_id)?.nome || 'Entregador'}
          </strong>
        </div>
      )}

      {/* Pagamento */}
      <div className="pp-pagamento-row">
        {pagamento === 'pix' && (
          <span className="pp-badge pp-badge-pix">Pix</span>
        )}
        {/* PIX na entrega: o cliente transfere na porta, direto pra chave da loja.
            Não tem confirmação automática — por isso nunca vira "PIX pago" aqui. */}
        {pagamento === 'pix_entrega' && (
          <span className="pp-badge pp-badge-pix">Pix na entrega</span>
        )}
        {pagamento === 'pix' && (pedido.pix_status === 'pago' || pedido.mp_payment_status === 'approved') && (
          <span className="pp-badge-pix-pago">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            PIX pago
          </span>
        )}
        {pagamento === 'dinheiro' && (
          <span className="pp-badge pp-badge-dinheiro">Dinheiro</span>
        )}
        {pagamento === 'dinheiro' && pedido.troco_para > 0 && (
          <span className="pp-troco">Troco para {fmt(pedido.troco_para)}</span>
        )}
        {pagamento !== 'pix' && pagamento !== 'pix_entrega' && pagamento !== 'dinheiro' && pagamento && (
          <span className="pp-badge pp-badge-outro">{pagamento}</span>
        )}
        {/* Precisa cobrar na entrega? Pré-pago = "online" (iFood app) ou PIX confirmado.
            iFood "via loja" (débito/crédito/dinheiro) o cliente paga na entrega. */}
        {!(pagamento === 'online' || (pagamento === 'pix' && (pedido.pix_status === 'pago' || pedido.mp_payment_status === 'approved'))) && (
          <span className="pp-badge" style={{ background: 'rgba(245,158,11,.15)', color: '#b45309', fontWeight: 800, border: '1px solid #f59e0b' }}>
            💵 Cobrar do cliente · {fmt(pedido.total)}
          </span>
        )}
      </div>

      {/* Observacoes */}
      {pedido.observacoes && (
        <div className="pp-obs">
          <span className="pp-obs-label">Obs:</span>
          {pedido.observacoes}
        </div>
      )}

      {/* Acoes por status */}
      <div className="pp-acoes">
        {/* Passo 1: aceitar */}
        {pedido.status === 'aguardando' && (
          <>
            <button type="button" className="pp-btn pp-btn-confirmar" onClick={() => onConfirmar(pedido.id)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              Confirmar
            </button>
            <button type="button" className="pp-btn pp-btn-recusar" onClick={() => onRecusar(pedido)} title="Recusar pedido">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Recusar
            </button>
          </>
        )}

        {/* Balcão (PDV): venda feita pelo vendedor — finaliza direto, sem código de entrega */}
        {pedido.origem === 'balcao' && (pedido.status === 'confirmado' || pedido.status === 'em_preparo' || pedido.status === 'saiu_entrega') && (
          <>
            <button
              type="button"
              className="pp-btn pp-btn-avancar"
              style={{ width: '100%', background: '#16a34a', borderColor: '#16a34a' }}
              onClick={() => onAvancar(pedido.id, 'entregue')}
            >
              Finalizar venda
            </button>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, width: '100%' }}>
              <button type="button" onClick={() => onEditar?.(pedido)}
                style={{ flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer',
                  border: '1.5px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontWeight: 700, fontSize: 13 }}>
                ✏️ Editar
              </button>
              <button type="button" onClick={() => onRecusar(pedido)}
                style={{ flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer',
                  background: 'transparent', border: '1.5px solid rgba(239,68,68,.5)', color: '#ef4444', fontWeight: 700, fontSize: 13 }}>
                Cancelar
              </button>
            </div>
          </>
        )}

        {/* Passo 2: preparando → marcar pronto (libera para os entregadores) */}
        {pedido.origem !== 'balcao' && (pedido.status === 'confirmado' || pedido.status === 'em_preparo') && (
          <button type="button" className="pp-btn pp-btn-avancar"
            onClick={() => onAvancar(pedido.id, isRetirada ? 'saiu_entrega' : 'pronto')}>
            {isRetirada ? 'Pronto para retirada' : 'Marcar pronto p/ entrega'}
          </button>
        )}

        {/* Passo 2b: pronto — aguardando um entregador aceitar (com fallback manual) */}
        {pedido.origem !== 'balcao' && !isRetirada && pedido.status === 'pronto' && (
          <div style={{ width: '100%' }}>
            <p style={{ textAlign: 'center', fontSize: 13, fontWeight: 600, margin: '0 0 10px', color: pedido.entregador_id ? '#16a34a' : '#a16207' }}>
              {pedido.entregador_id ? '🛵 Entregador a caminho' : '✅ Pronto · aguardando um entregador aceitar'}
            </p>
            {!pedido.entregador_id && (
              <>
                <SeletorEntregador entregadores={entregadores} onAtribuir={onAtribuir} pedidoId={pedido.id} />
                <button type="button" className="pp-btn pp-btn-avancar"
                  onClick={() => onAvancar(pedido.id, 'saiu_entrega')} style={{ width: '100%' }}>
                  Despachar mesmo assim
                </button>
              </>
            )}
          </div>
        )}

        {/* Passo 3: saiu → primeiro mostra status, depois confirma com código */}
        {pedido.origem !== 'balcao' && pedido.status === 'saiu_entrega' && (
          <div style={{ width: '100%' }}>
            {!confirmandoEntrega ? (
              <>
                {/* Despachado sem motoboy (ex.: pedido do iFood) → o gestor pode
                    atrelar um entregador, e o pedido passa a aparecer no app dele */}
                {!isRetirada && !pedido.entregador_id && (
                  <SeletorEntregador entregadores={entregadores} onAtribuir={onAtribuir} pedidoId={pedido.id} />
                )}
                <p style={{ textAlign: 'center', color: '#a78bfa', fontSize: 13, fontWeight: 600, margin: '0 0 10px' }}>
                  🛵 {pedido.entregador_id ? 'Pedido com o entregador' : 'Saiu para entrega (sem motoboy atribuído)'}
                </p>
                <button
                  type="button"
                  className="pp-btn pp-btn-avancar"
                  onClick={() => {
                    // Sem código exigido (ex.: iFood sem handshake) → conclui direto.
                    if (!precisaCodigo) { onAvancar(pedido.id, 'entregue'); return }
                    setConfirmandoEntrega(true); setTimeout(() => digitRefs.current[0]?.focus(), 80)
                  }}
                  style={{ width: '100%', background: '#7c3aed', borderColor: '#7c3aed' }}
                >
                  Confirmar entrega
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '0 0 8px' }}>
                  {precisaCodigoIfood
                    ? 'Peça o código de confirmação do iFood ao cliente:'
                    : 'Peça o código de 4 dígitos ao cliente:'}
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '4px 0 10px' }}>
                  {[0, 1, 2, 3].map(i => (
                    <input
                      key={i}
                      ref={el => { digitRefs.current[i] = el }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={codigoDigitos[i]}
                      onChange={e => handleDigitChange(i, e.target.value)}
                      onKeyDown={e => handleKeyDown(i, e)}
                      style={{
                        width: 52, height: 58, textAlign: 'center',
                        fontSize: 24, fontWeight: 800, borderRadius: 10,
                        border: `2px solid ${erroLocal ? '#ef4444' : '#444'}`,
                        background: '#0f0f1a', color: '#fff', outline: 'none',
                      }}
                    />
                  ))}
                </div>
                {erroLocal && (
                  <p style={{ color: '#ef4444', fontSize: 12, textAlign: 'center', margin: '0 0 8px' }}>
                    {erroLocal}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="pp-btn pp-btn-recusar"
                    onClick={() => { setConfirmandoEntrega(false); setCodigoDigitos(['','','','']); setErroLocal(null) }}
                    style={{ flex: '0 0 auto' }}
                  >
                    Voltar
                  </button>
                  <button
                    type="button"
                    className="pp-btn pp-btn-avancar"
                    onClick={handleConfirmarComCodigo}
                    disabled={codigoDigitos.some(d => d === '') || verificandoIfood}
                    style={{ flex: 1 }}
                  >
                    {verificandoIfood ? 'Validando no iFood...' : 'Confirmar entrega'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Concluído: o gestor pode atribuir/trocar o entregador (ex.: a moto de
            um quebrou e outro levou), pra o histórico refletir quem entregou.
            Vale pra QUALQUER origem que tenha saído pra entrega — venda de balcão
            com entrega também vai de moto e conta no acerto do motoboy. Só some
            na retirada, onde não existe entregador. */}
        {!isRetirada && pedido.status === 'entregue' && (
          <div style={{ width: '100%' }}>
            <p style={{ textAlign: 'center', fontSize: 13, fontWeight: 600, margin: '0 0 8px', color: '#16a34a' }}>
              {(() => {
                const en = entregadores.find(e => e.id === pedido.entregador_id)
                return en ? `🛵 Entregue por: ${en.nome}` : '🛵 Entregue (sem motoboy atribuído)'
              })()}
            </p>
            <SeletorEntregador entregadores={entregadores} onAtribuir={onAtribuir} pedidoId={pedido.id} />
          </div>
        )}

        {/* Cancelar um pedido JÁ aceito (faltou produto, cliente desistiu, etc.).
            Não aparece no balcão (venda própria) nem em quem ainda está "A aceitar"
            (esse usa o botão Recusar acima). */}
        {pedido.origem !== 'balcao' && ['confirmado', 'em_preparo', 'pronto', 'saiu_entrega'].includes(pedido.status) && (
          <button
            type="button"
            onClick={() => onRecusar(pedido)}
            style={{
              width: '100%', marginTop: 8, padding: '8px', borderRadius: 8,
              background: 'transparent', border: '1.5px solid rgba(239,68,68,.5)',
              color: '#ef4444', fontWeight: 700, fontSize: 13, cursor: 'pointer',
            }}
          >
            Cancelar pedido
          </button>
        )}
      </div>
    </div>
  )
}

// ── Empty state ─────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="pp-empty">
      <div className="pp-empty-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
          <rect x="9" y="3" width="6" height="4" rx="1"/>
          <line x1="9" y1="12" x2="15" y2="12"/>
          <line x1="9" y1="16" x2="13" y2="16"/>
        </svg>
      </div>
      <h2 className="pp-empty-titulo">Nenhum pedido ativo</h2>
      <p className="pp-empty-sub">
        Novos pedidos aparecerao aqui instantaneamente. Deixe essa aba aberta.
      </p>
      <div className="pp-empty-dot" aria-hidden="true" />
    </div>
  )
}

// ── Skeleton de loading ─────────────────────────────────────
function SkeletonGrid() {
  return (
    <div className="pp-grid">
      {[1, 2, 3].map(i => (
        <div key={i} className="pp-card pp-card-skeleton">
          <div className="pp-skel-row" style={{ width: '45%', marginBottom: 14 }} />
          <div className="pp-skel-row" style={{ width: '100%', height: 56, marginBottom: 12 }} />
          <div className="pp-skel-row" style={{ width: '70%', marginBottom: 8 }} />
          <div className="pp-skel-row" style={{ width: '55%', marginBottom: 8 }} />
          <div className="pp-skel-row" style={{ width: '35%' }} />
        </div>
      ))}
    </div>
  )
}

// ── Config de som (lida do localStorage para respeitar config.somAtivo) ───
// O painel não tem um painel de config próprio aqui, mas respeitamos
// a chave "painelConfig" caso exista — senão, som ligado por padrão.
function somAtivoConfig() {
  try {
    const raw = localStorage.getItem('painelConfig')
    if (!raw) return true
    const cfg = JSON.parse(raw)
    return cfg.somAtivo !== false
  } catch {
    return true
  }
}

// ── Verifica se a loja deveria estar aberta pelo horário ────
// Prioriza a GRADE SEMANAL nova (horarios_funcionamento); só cai no horário único
// legado (horario_abertura/fechamento) se não houver grade.
// `excecoes` traz os feriados/folgas marcados (mig 0142) — é o que faz a loja
// fechar sozinha no feriado, e continuar abrindo no feriado que ela não folga.
function lojaAbertaPorHorario(emp, excecoes = {}) {
  if (Array.isArray(emp?.horarios_funcionamento) && emp.horarios_funcionamento.length === 7) {
    return abertaAgora({ grade: emp.horarios_funcionamento, excecoes, fechaFeriado: !!emp?.feriados_fecha })
  }
  // Fallback: horário único legado
  if (!emp?.horario_abertura || !emp?.horario_fechamento) return true
  const horaBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }))
  const minuto = horaBR.getHours() * 60 + horaBR.getMinutes()
  const [aH, aM] = emp.horario_abertura.slice(0, 5).split(':').map(Number)
  const [fH, fM] = emp.horario_fechamento.slice(0, 5).split(':').map(Number)
  return minuto >= aH * 60 + aM && minuto < fH * 60 + fM
}
function horarioHojeTexto(emp, excecoes = {}) {
  if (Array.isArray(emp?.horarios_funcionamento) && emp.horarios_funcionamento.length === 7) {
    const hoje = comoFicaNoDia(hojeBR(), {
      grade: emp.horarios_funcionamento, excecoes, fechaFeriado: !!emp?.feriados_fecha,
    })
    if (hoje.aberto && hoje.periodos.length) {
      return hoje.periodos.map(p => `${String(p.i).slice(0, 5)} às ${String(p.f).slice(0, 5)}`).join(' e ')
    }
    return hoje.motivo ? `fechado hoje (${hoje.motivo})` : 'fechado hoje'
  }
  const ab = emp?.horario_abertura?.slice(0, 5), fe = emp?.horario_fechamento?.slice(0, 5)
  return (ab && fe) ? `${ab} às ${fe}` : ''
}

// ── Toggle reutilizável (liga/desliga) ─────────────────────
// ── Impressora FWC: configuração DENTRO do gestor ────────────────────────────
// O app FWC roda no PC e expõe uma API local (localhost:9110). Aqui o gestor
// fala com ela pra logar, escolher loja/impressora e imprimir teste — tudo sem
// abrir o localhost. Se o app não estiver aberto, mostra o botão de baixar.
const FWC_EXE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co/storage/v1/object/public/downloads/ImpressoraFWC.exe'

function ImpressoraFWCPanel({ empresaId }) {
  const [online, setOnline] = useState(null) // null=checando | true | false
  const [st, setSt] = useState(null)
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState('')
  const [adotando, setAdotando] = useState(false)
  const [nomeManual, setNomeManual] = useState('')
  const [atzMsg, setAtzMsg] = useState('')      // mensagem do botão "Atualizar agora"
  const [atzBusy, setAtzBusy] = useState(false)
  const [motivo, setMotivo] = useState('')      // por que não chegou no app (em português)
  const adotouRef = useRef(false)
  // Permissão "rede local" do Chrome novo (150+). O gestor é https e o app é
  // http://localhost: sem essa permissão o navegador SEGURA a chamada até estourar
  // o tempo, e o card jurava que o app estava fechado. Foi o que travou duas lojas.
  const [permLocal, setPermLocal] = useState(null) // 'granted' | 'prompt' | 'denied' | null (Chrome antigo)
  useEffect(() => {
    let vivo = true
    navigator.permissions?.query?.({ name: 'local-network-access' })
      .then(p => { if (vivo) setPermLocal(p.state) })
      .catch(() => { /* Chrome antigo: não existe essa permissão, segue a vida */ })
    return () => { vivo = false }
  }, [])

  const chamar = useCallback(async (path, opts) => {
    const r = await fwcFetch('/api' + path, { timeout: 8000, ...opts })
    return await r.json().catch(() => ({}))
  }, [])

  const carregar = useCallback(async () => {
    try { const s = await chamar('/status'); setSt(s); setOnline(true); setMotivo('') }
    catch (e) { setOnline(false); setMotivo(explicaErroFwc(e)) }
  }, [chamar])

  useEffect(() => { carregar(); const id = setInterval(carregar, 5000); return () => clearInterval(id) }, [carregar])

  // Reconhece a conta do gestor sozinho: se o app está aberto mas SEM login,
  // entrega a sessão do gestor pro app (1x por abertura do painel). Sem digitar.
  useEffect(() => {
    if (online !== true || !st || st.logado || adotouRef.current) return
    adotouRef.current = true
    ;(async () => {
      setAdotando(true)
      try {
        const { data } = await supabase.auth.getSession()
        const s = data?.session
        if (s?.access_token && s?.refresh_token) {
          await chamar('/adotar-sessao', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token, empresa_id: empresaId || undefined }),
          })
          await carregar()
        }
      } catch (e) { /* cai no login manual */ }
      finally { setAdotando(false) }
    })()
  }, [online, st, empresaId, chamar, carregar])

  const acao = async (path, corpo) => {
    setBusy(true); setErro('')
    try {
      const j = await chamar(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo || {}) })
      if (j && j.ok === false) setErro(j.erro || 'Não deu certo.')
      await carregar()
      return j
    } catch (e) { setErro('Não consegui falar com o app. Ele está aberto?'); setOnline(false) }
    finally { setBusy(false) }
  }

  // "Atualizar agora": pede pro app checar/baixar a versão nova na hora. Se ele for
  // baixar, derruba a própria conexão (esperado) — tratamos como sucesso.
  const atualizarAgora = async () => {
    setAtzBusy(true); setAtzMsg('Procurando atualização…'); setErro('')
    try {
      const j = await chamar('/atualizar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (j?.baixando) setAtzMsg('⬇️ Baixando a versão nova… o app reinicia sozinho em alguns segundos.')
      else if (j?.atualizado) setAtzMsg('✅ Você já está na versão mais nova.')
      else if (j?.atualizando) setAtzMsg('⏳ Já está atualizando…')
      else setAtzMsg('Não consegui verificar agora. Tente de novo em instantes.')
    } catch (e) {
      // conexão caiu = o app começou a baixar e vai reiniciar
      setAtzMsg('⬇️ Atualizando… o app reinicia sozinho em alguns segundos.')
    } finally { setAtzBusy(false); setTimeout(carregar, 8000) }
  }

  // Solução de problema fica FECHADA por padrão. Na esmagadora maioria das vezes
  // é só baixar e abrir; o muro de texto (permissão de rede local, localhost,
  // antivírus) assusta quem só queria clicar num botão.
  const [ajuda, setAjuda] = useState(false)

  // O app é um programa de Windows que só responde em localhost — de um celular
  // ele NUNCA vai ser encontrado. Mostrar "App fechado" em vermelho, botão de
  // baixar .exe e três parágrafos de diagnóstico num celular é puro barulho:
  // ali a impressora certa é a Bluetooth, logo abaixo.
  const ehCelular = typeof navigator !== 'undefined' && (
    navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
  )

  const inp = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }
  const btnRoxo = { padding: '10px 14px', borderRadius: 8, border: 'none', cursor: busy ? 'wait' : 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 13, opacity: busy ? .6 : 1 }
  const btnVerde = { ...btnRoxo, background: '#16a34a' }

  // ── Celular: o app não é daqui ──
  if (ehCelular && online !== true) {
    return (
      <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '11px 13px', fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        🖨️ <b style={{ color: 'var(--text)' }}>Impressora FWC</b> é o app do <b>computador</b> da loja (impressora no cabo).
        No celular, use a <b>impressora Bluetooth</b> aqui embaixo.
      </div>
    )
  }

  // ── App não encontrado (fechado ou não instalado) ──
  if (online === false) {
    return (
      <div style={{ border: '2px solid #7c3aed', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 8, background: 'rgba(124,58,237,0.07)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>🖨️ Impressora FWC</span>
          <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 800 }}>● App fechado</span>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Baixe e <b>abra o arquivo uma vez</b> — ele se <b>instala sozinho</b> e passa a ligar junto com o Windows.
        </div>
        <a href={FWC_EXE_URL} download
          style={{ alignSelf: 'flex-start', background: '#7c3aed', color: '#fff', borderRadius: 8, padding: '10px 16px', fontWeight: 800, fontSize: 13, textDecoration: 'none', marginTop: 2 }}>
          ⬇️ Baixar Impressora FWC (Windows)
        </a>

        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 }}>
          <button type="button" onClick={carregar} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary, #a78bfa)', fontSize: 12, fontWeight: 700, padding: 0 }}>
            ↻ Já instalei — procurar de novo
          </button>
          <button type="button" onClick={() => setAjuda(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, fontWeight: 700, padding: 0 }}>
            {ajuda ? '▴ Fechar ajuda' : '▾ Instalei e continua "App fechado"'}
          </button>
        </div>

        {/* Tudo que só serve quando dá errado mora aqui dentro. Aberto o tempo
            todo, virava um muro de texto na frente do único botão que importa. */}
        {ajuda && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px dashed var(--border)', paddingTop: 10, marginTop: 2 }}>
            {/* Chrome 150+ pede permissão pra um site https falar com o localhost. Sem ela
                a chamada fica pendurada e o card jura que o app está fechado — mesmo com o
                app rodando. Como o navegador conta isso ANTES de tentar, vem primeiro. */}
            {(permLocal === 'prompt' || permLocal === 'denied') && (
              <div style={{ border: '1.5px solid #f59e0b', background: 'rgba(245,158,11,.12)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.5 }}>
                <b>⚠️ Provavelmente é isto.</b> Este Chrome {permLocal === 'denied' ? 'está BLOQUEANDO' : 'não liberou'} o
                acesso do site à <b>rede local</b> — sem isso ele nem chega no app.
                <div style={{ marginTop: 6 }}>
                  Cadeado ao lado do endereço → <b>Configurações do site</b> → <b>Rede local</b> → <b>Permitir</b>. Depois F5.
                </div>
              </div>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Se o Windows avisar ao abrir o arquivo, clique em "Mais informações → Executar assim mesmo".
            </div>
            {/* O erro cru ("Failed to fetch") não ajuda ninguém no balcão — aqui sai traduzido. */}
            {motivo && (
              <div style={{ fontSize: 11.5, color: '#f59e0b', fontWeight: 700, lineHeight: 1.45 }}>Motivo: {motivo}</div>
            )}
            {/* Teste direto: separa "o app não está rodando" de "o app roda mas algo bloqueia
                a conexão" (antivírus/firewall). Sem isso o suporte fica no escuro. */}
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Abra este endereço numa aba nova <b>deste PC</b>:{' '}
              <a href="http://localhost:9110/api/status" target="_blank" rel="noreferrer"
                style={{ color: 'var(--primary, #a78bfa)', fontWeight: 800, wordBreak: 'break-all' }}>
                localhost:9110/api/status
              </a>
              <br />
              <b>Abriu um monte de texto</b> = o app roda, quem bloqueia é o antivírus/firewall.
              {' '}<b>Deu erro</b> = o app não subiu: abra o ícone <b>Impressora FWC</b> na Área de Trabalho
              (ou na setinha ▲ perto do relógio).
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Checando ──
  if (online === null || !st) {
    return (
      <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 14, fontSize: 12.5, color: 'var(--text-muted)' }}>
        🖨️ Procurando o app Impressora FWC neste PC…
      </div>
    )
  }

  // ── App online ──
  return (
    <div style={{ border: '2px solid #7c3aed', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(124,58,237,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 800 }}>🖨️ Impressora FWC</span>
        <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 800 }}>● App conectado</span>
        {st.versao != null && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>v{st.versao}</span>
        )}
      </div>

      {erro && <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 700 }}>{erro}</div>}

      {/* Atualização: o app se atualiza sozinho (checa a cada 3h), mas o botão força na hora.
          O botão "Atualizar agora" só existe a partir da v6; versão mais antiga vê o download. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
        {Number(st.versao) >= 6 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" onClick={atualizarAgora} disabled={atzBusy}
                title="Buscar e instalar a versão mais nova agora"
                style={{ width: 44, height: 44, borderRadius: '50%', border: 'none', cursor: atzBusy ? 'wait' : 'pointer',
                  background: '#7c3aed', color: '#fff', fontSize: 20, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: atzBusy ? .6 : 1, flexShrink: 0 }}>
                {atzBusy ? '…' : '🔄'}
              </button>
              <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
                <b>Atualizar agora</b>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Sem esperar — busca e instala a versão nova na hora.</div>
              </div>
            </div>
            {atzMsg && <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>{atzMsg}</div>}
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <a href={FWC_EXE_URL} download style={{ color: '#7c3aed', fontWeight: 800, textDecoration: 'none' }}>
              ⬇️ Baixar versão nova do app
            </a>
            <span>(feche o app atual e abra o baixado — depois dessa vez ele se atualiza sozinho)</span>
          </div>
        )}
      </div>

      {/* Não logado → tenta reconhecer a conta do gestor; senão, login manual */}
      {!st.logado ? (
        adotando ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>🔑 Reconhecendo a conta do gestor…</div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Entre com a conta da loja (a mesma do gestor).</div>
            <input style={inp} type="email" placeholder="E-mail" value={email} onChange={e => setEmail(e.target.value)} />
            <input style={inp} type="password" placeholder="Senha" value={senha} onChange={e => setSenha(e.target.value)} />
            <button type="button" disabled={busy} style={btnRoxo} onClick={() => acao('/login', { email, senha })}>Entrar</button>
          </>
        )
      ) : (
        <>
          {/* Loja (só se tiver mais de uma e ainda não escolheu) */}
          {!st.empresaId && st.empresas?.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Sua conta tem mais de uma loja — escolha qual imprime:</div>
              <select style={inp} defaultValue="" onChange={e => e.target.value && acao('/empresa', { empresa_id: e.target.value })}>
                <option value="">Selecione a loja</option>
                {st.empresas.map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
            </div>
          )}

          {/* Status */}
          <div style={{ fontSize: 12.5, color: 'var(--text)' }}>
            <div>Loja: <b>{st.loja || '—'}</b></div>
            <div>Impressora: <b style={{ color: st.impressora ? '#16a34a' : '#dc2626' }}>{st.impressora || 'nenhuma escolhida'}</b></div>
          </div>

          {/* Escolher impressora */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Impressora (todas as instaladas neste PC)</div>
            <select style={inp} value={st.impressora || ''} onChange={e => acao('/printer', { printer: e.target.value })}>
              <option value="">Selecione a impressora</option>
              {(st.impressoras || []).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            {/* Escape: SÓ aparece quando o Windows não listou nenhuma impressora —
                aí o usuário digita o nome exato. Com impressora detectada, fica escondido. */}
            {(st.impressoras || []).length === 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', margin: '10px 0 6px' }}>
                  ⚠️ Nenhuma impressora foi detectada. Digite o nome EXATO (Windows → Impressoras):
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={{ ...inp, flex: 1 }} placeholder="Ex.: POS-80 / EPSON TM-T20"
                    value={nomeManual} onChange={e => setNomeManual(e.target.value)} />
                  <button type="button" disabled={busy || !nomeManual.trim()} style={{ ...btnRoxo, opacity: (busy || !nomeManual.trim()) ? .6 : 1 }}
                    onClick={() => acao('/printer', { printer: nomeManual.trim() })}>Salvar</button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Copie o nome exatinho como aparece no Windows (Configurações → Impressoras e scanners).</div>
              </>
            )}
          </div>

          {/* Papel deste PC (v20+). Só aparece em quem já atualizou: nas versões
              antigas o app ignora o comando e o botão mentiria. */}
          {Number(st.versao) >= 20 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <label style={{ fontSize: 12.5, fontWeight: 800 }}>O que ESTA impressora imprime</label>
              <select value={st.setor || 'tudo'} disabled={busy} style={inp}
                onChange={e => acao('/setor', { setor: e.target.value })}>
                <option value="tudo">📄 Tudo</option>
                <option value="cozinha">🍳 Só cozinha</option>
                <option value="frente">🧾 Só frente (salão)</option>
              </select>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                Vale pelas categorias marcadas em <b>Produtos → Categorias</b>. Com uma impressora só, deixe em Tudo.
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" disabled={busy || !st.impressora} style={{ ...btnVerde, opacity: (busy || !st.impressora) ? .6 : 1 }} onClick={() => acao('/teste')}>Imprimir cupom de teste</button>
            <button type="button" disabled={busy} style={{ ...btnRoxo, background: '#374151' }} onClick={() => acao('/logout')}>Sair (trocar conta)</button>
          </div>
        </>
      )}
    </div>
  )
}

function ToggleRow({ label, ativo, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={ativo}
        style={{
          width: 44, height: 24, borderRadius: 20, border: 'none', cursor: 'pointer',
          position: 'relative', flexShrink: 0,
          background: ativo ? 'var(--primary, #7c3aed)' : 'var(--border, #3a3a4a)',
          transition: 'background .15s',
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: ativo ? 23 : 3, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left .15s',
        }} />
      </button>
    </div>
  )
}

// Botões da barra lateral direita (extensível — é só adicionar itens aqui)
const RIGHTBAR_BOTOES = [
  {
    id: 'impressora', label: 'Impressora',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 9 6 2 18 2 18 9"/>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
        <rect x="6" y="14" width="12" height="8"/>
      </svg>
    ),
  },
  {
    id: 'salao', label: 'Mesas',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 11h18"/>
        <path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/>
        <path d="M6 11v9"/>
        <path d="M18 11v9"/>
      </svg>
    ),
  },
  {
    id: 'chat', label: 'Mensagens',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      </svg>
    ),
  },
  {
    id: 'catalogo', label: 'Catálogo',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    id: 'hoje', label: 'Hoje',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
        <polyline points="9 16 11 18 15 14"/>
      </svg>
    ),
  },
  {
    id: 'entregadores', label: 'Entregadores',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="5" cy="17" r="3"/>
        <circle cx="19" cy="17" r="3"/>
        <path d="M8 17h8M5 14l2-7h8l3 7"/>
        <path d="M13 7l1-4h3"/>
      </svg>
    ),
  },
]

// Timer compacto para os cards "a aceitar"
function MiniTimer({ createdAt, aguardandoDesde, onExpirado }) {
  const [restante, setRestante] = useState(() => getTempoRestante(createdAt, aguardandoDesde))
  const expRef = useRef(false)
  useEffect(() => {
    if (restante === 0) {
      if (!expRef.current) { expRef.current = true; onExpirado() }
      return
    }
    const id = setTimeout(() => setRestante(getTempoRestante(createdAt, aguardandoDesde)), 500)
    return () => clearTimeout(id)
  }, [restante, createdAt, aguardandoDesde, onExpirado])
  const urg = getUrgencia(restante)
  const cor = urg === 'critico' ? '#ef4444' : urg === 'atencao' ? '#f59e0b' : '#16a34a'
  return <span style={{ fontSize: 11, fontWeight: 800, color: cor, whiteSpace: 'nowrap' }}>⏱ {formatarTempo(restante)}</span>
}

// Card compacto do quadro — clica pra abrir o pedido completo
// Próximo passo rápido do pedido (botão direto no card, sem abrir o pedido).
function acaoRapidaPedido(pedido) {
  const isRet = (pedido.tipo_entrega || 'entrega') === 'retirada'
  switch (pedido.status) {
    case 'confirmado':
    case 'em_preparo':
      return { status: 'pronto', label: '✓ Pronto', cor: '#1d4ed8' }
    case 'pronto':
      return isRet
        ? { status: 'entregue', label: '✓ Confirmar retirada', cor: '#16a34a' }
        : { status: 'saiu_entrega', label: '🛵 Despachar', cor: '#7c3aed' }
    case 'saiu_entrega':
      // Retirada: confirma no próprio gestor. Entrega por motoboy: só o CÓDIGO
      // do cliente confirma (no app do entregador) — sem botão "Entregue" aqui.
      return isRet
        ? { status: 'entregue', label: '✓ Confirmar retirada', cor: '#16a34a' }
        : null
    default:
      return null
  }
}

// Passo pra TRÁS (desfazer quando avançou errado / quer trocar).
function acaoVoltarPedido(pedido) {
  // iFood segue o fluxo dele — não existe "cancelar despacho" no iFood; não mostra.
  const isIfood = pedido.origem === 'ifood'
  switch (pedido.status) {
    case 'pronto':       return { status: 'em_preparo', label: '↩ Voltar pra cozinha' }
    case 'saiu_entrega': return isIfood ? null : { status: 'pronto', label: '↩ Cancelar despacho' }
    default:             return null
  }
}

// Tempo decorrido (pra "há X min" na cozinha e "despachado há X min")
function minutosDesde(iso) {
  if (!iso) return null
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  return m < 0 ? 0 : m
}
function tempoDecorridoTxt(iso) {
  const m = minutosDesde(iso)
  if (m == null) return ''
  if (m < 1) return 'agora'
  if (m < 60) return `há ${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `há ${h}h${r}min` : `há ${h}h`
}
// Pedido em preparo/pronto atrasado? usa a previsão do preparo; senão 40 min de teto.
const ATRASO_PADRAO_MIN = 40
// Pedido agendado conta o tempo da HORA COMBINADA, não de quando foi feito:
// senão o almoço pedido às 8h já nasce "em atraso" ao entrar na cozinha.
const relogioDoPedido = (p) => {
  // Janela que já começou quando o pedido entrou (a loja que entrega "das 08h
  // às 18h" recebe pedido ao meio-dia) não pode contar desde as 08h: nasceria
  // atrasado. Vale o que for MAIS RECENTE entre a hora combinada e a criação.
  const a = p?.agendado_para
  if (a && new Date(a).getTime() > new Date(p?.created_at).getTime()) return a
  return p?.created_at
}

function pedidoAtrasado(pedido) {
  if (!['confirmado', 'em_preparo', 'pronto'].includes(pedido.status)) return false
  if (pedido.pronto_previsto_at) return Date.now() > new Date(pedido.pronto_previsto_at).getTime()
  const m = minutosDesde(relogioDoPedido(pedido))
  return m != null && m > ATRASO_PADRAO_MIN
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
const PERIODOS_ENT = [['hoje', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias'], ['tudo', 'Tudo']]

// Mini-modal: pede o código de retirada ao concluir um pedido de retirada.
// Igual ao motoboy na entrega — só conclui se o código bater com o do pedido
// (ex.: o código de retirada que veio do iFood).
function ModalCodigoRetirada({ pedido, onOk, onCancelar }) {
  const [digitos, setDigitos] = useState(['', '', '', ''])
  const [erro, setErro] = useState(null)
  const [validando, setValidando] = useState(false)
  const refs = useRef([])
  const ehIfood = pedido.origem === 'ifood'
  useEffect(() => { const t = setTimeout(() => refs.current[0]?.focus(), 60); return () => clearTimeout(t) }, [])
  function change(i, v) {
    const d = v.replace(/\D/g, '').slice(-1)
    const novos = [...digitos]; novos[i] = d; setDigitos(novos); setErro(null)
    if (d && i < 3) refs.current[i + 1]?.focus()
  }
  function keyDown(i, e) {
    if (e.key === 'Backspace' && !digitos[i] && i > 0) {
      const n = [...digitos]; n[i - 1] = ''; setDigitos(n); refs.current[i - 1]?.focus()
    }
  }
  async function confirmar() {
    const codigo = digitos.join('')
    // iFood: valida o código NA API do iFood (verifyDeliveryCode) — igual ao motoboy
    // na entrega. Se o iFood aceitar, ele conclui a retirada e a gente marca entregue.
    if (ehIfood) {
      setValidando(true); setErro(null)
      try {
        const { data, error } = await supabase.functions.invoke('ifood-integration', {
          body: { acao: 'verify_delivery_code', pedido_id: pedido.id, codigo },
        })
        if (error || !data?.valid) {
          setErro('Código do iFood inválido. Confira com o cliente.')
          setDigitos(['', '', '', '']); refs.current[0]?.focus(); return
        }
        onOk()
      } catch {
        setErro('Erro ao validar no iFood. Tente de novo.')
      } finally {
        setValidando(false)
      }
      return
    }
    // Nossa loja: compara com o código do pedido
    if (codigo !== String(pedido.codigo_entrega ?? '').trim()) {
      setErro('Código incorreto. Confira com o cliente.')
      setDigitos(['', '', '', '']); refs.current[0]?.focus(); return
    }
    onOk()
  }
  return (
    <div className="pp-modal-overlay" onClick={onCancelar} style={{ zIndex: 130 }}>
      <div onClick={e => e.stopPropagation()} className="pp-modal" style={{ width: 'min(360px, 94vw)', padding: 22, textAlign: 'center' }}>
        <h3 style={{ margin: '0 0 4px' }}>Confirmar retirada</h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px' }}>
          Pedido #{pedido.numero_pedido} · {ehIfood
            ? <>peça os <strong>4 últimos dígitos do telefone</strong> do cliente:</>
            : <>peça o <strong>código de retirada</strong> ao cliente:</>}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '0 0 12px' }}>
          {[0, 1, 2, 3].map(i => (
            <input key={i} ref={el => { refs.current[i] = el }} type="text" inputMode="numeric" maxLength={1}
              value={digitos[i]} onChange={e => change(i, e.target.value)} onKeyDown={e => keyDown(i, e)}
              style={{ width: 52, height: 58, textAlign: 'center', fontSize: 24, fontWeight: 800, borderRadius: 10,
                border: `2px solid ${erro ? '#ef4444' : '#444'}`, background: '#0f0f1a', color: '#fff', outline: 'none' }} />
          ))}
        </div>
        {erro && <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 10px' }}>{erro}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="pp-btn pp-btn-recusar" onClick={onCancelar} style={{ flex: '0 0 auto' }}>Cancelar</button>
          <button type="button" className="pp-btn pp-btn-avancar" onClick={confirmar}
            disabled={digitos.some(d => d === '') || validando} style={{ flex: 1 }}>
            {validando ? 'Validando no iFood...' : 'Confirmar retirada'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CardMini({ pedido, onClick, onExpirado, onAvancar, onVoltar, entregadores = [] }) {
  const oc = ORIGEM_CONFIG[pedido.origem] ?? ORIGEM_CONFIG.cardapio
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const qtdItens = itens.reduce((s, i) => s + Number(i.qtd ?? i.quantidade ?? 1), 0)
  const hora = new Date(pedido.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const isRetirada = (pedido.tipo_entrega || 'entrega') === 'retirada'
  const entregadorNome = pedido.entregador_id
    ? (entregadores.find(en => en.id === pedido.entregador_id)?.nome || 'Entregador')
    : null
  const aguardandoEntregador = pedido.status === 'pronto' && !pedido.entregador_id && !isRetirada
  const acao = onAvancar ? acaoRapidaPedido(pedido) : null
  const voltar = onVoltar ? acaoVoltarPedido(pedido) : null
  return (
    <div role="button" tabIndex={0} onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter') onClick?.() }}
      className="pp-mini" style={{ borderLeft: `3px solid ${oc.borda}`, cursor: 'pointer' }}>
      <div className="pp-mini-top">
        <span className="pp-mini-num">
          {pedido.origem === 'ifood' && pedido.ifood_display_id
            ? <>iFood #{pedido.ifood_display_id} <span style={{ fontWeight: 600, opacity: .6, fontSize: '.85em' }}>#{pedido.numero_pedido ?? ''}</span></>
            : `#${pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}`
          } · {fmt(pedido.total)}
        </span>
        {pedido.status === 'aguardando' && onExpirado && !agendadoAindaVai(pedido) && (
          <MiniTimer createdAt={inicioDoAceite(pedido)} aguardandoDesde={null} onExpirado={() => onExpirado(pedido.id)} />
        )}
      </div>
      <div className="pp-mini-sub">{hora} · {pedido.cliente_nome || '—'}</div>
      <div className="pp-mini-tags">
        {pedido.agendado_para && (
          <span className="pp-mini-badge" style={{ background: 'rgba(14,165,233,.18)', color: '#0284c7' }}>
            🗓️ {rotuloAgendado(pedido.agendado_para, { comData: true, ate: pedido.agendado_ate })}
          </span>
        )}
        <span className="pp-mini-badge" style={{ background: oc.bg, color: oc.color }}>{oc.label}</span>
        <span className="pp-mini-itens">{qtdItens} {qtdItens === 1 ? 'item' : 'itens'}</span>
        {isRetirada && <span className="pp-mini-itens">{pedido.origem === 'balcao' ? 'Balcão' : 'Retirada'}</span>}
        {entregadorNome && <span className="pp-mini-itens">🛵 {entregadorNome}</span>}
        {aguardandoEntregador && <span className="pp-mini-itens" style={{ color: '#a16207' }}>aguardando entregador</span>}
        {['confirmado', 'em_preparo', 'pronto'].includes(pedido.status) && (
          pedidoAtrasado(pedido)
            ? <span className="pp-mini-badge" style={{ background: '#dc2626', color: '#fff' }}>⚠️ Em atraso · {tempoDecorridoTxt(relogioDoPedido(pedido))}</span>
            : <span className="pp-mini-itens">⏱ {tempoDecorridoTxt(relogioDoPedido(pedido))}</span>
        )}
        {pedido.status === 'saiu_entrega' && !isRetirada && (
          <span className="pp-mini-itens" style={{ color: '#7c3aed', fontWeight: 700 }}>🛵 Despachado {tempoDecorridoTxt(pedido.saiu_entrega_at || pedido.updated_at)}</span>
        )}
      </div>
      {acao && (
        <button type="button"
          onClick={e => { e.stopPropagation(); onAvancar(pedido.id, acao.status) }}
          style={{ marginTop: 8, width: '100%', padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
            fontWeight: 800, fontSize: 15, border: `1.5px solid ${acao.cor}`, background: `${acao.cor}1e`, color: acao.cor }}>
          {acao.label}
        </button>
      )}
      {voltar && (
        <button type="button"
          onClick={e => { e.stopPropagation(); onVoltar(pedido.id, voltar.status) }}
          style={{ marginTop: 6, width: '100%', padding: '5px', borderRadius: 8, cursor: 'pointer',
            fontWeight: 600, fontSize: 13, border: '1px solid var(--border, #2a2a3a)', background: 'none', color: 'var(--text-muted)' }}>
          {voltar.label}
        </button>
      )}
    </div>
  )
}

// Card compacto de uma mesa (autoatendimento por QR) no quadro do gestor
// Uma linha de item da comanda de mesa. Mostra o preço à direita; o ADM
// (podeEditarPreco) clica no preço pra digitar outro valor — ex.: açaí no peso,
// que só tem valor depois de pesar. Vale só pra essa comanda.
function LinhaItemMesa({ comanda, it, onItemPronto, onEditarPreco, podeEditarPreco }) {
  const { nome, complementos } = separarItem(it)
  const pronto = it.status === 'pronto' || it.status === 'entregue'
  const q = Number(it.quantidade ?? 1)
  const pu = Number(it.preco_unitario ?? 0)
  const [editando, setEditando] = useState(false)
  const [valor, setValor] = useState('')
  function abrir() { setValor(pu ? String(pu).replace('.', ',') : ''); setEditando(true) }
  function salvar() {
    const n = Number(String(valor).replace(',', '.'))
    if (Number.isFinite(n) && n >= 0 && n !== pu) onEditarPreco(comanda, it, n)
    setEditando(false)
  }
  return (
    <div style={{ fontSize: 12.5, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: pronto ? '#16a34a' : 'var(--text)' }}>
          {pronto ? '✓ ' : ''}{q}× {nome}
        </div>
        {complementos.map((c, j) => (
          <div key={j} style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 14 }}>{Number(c?.qtd ?? 1)}× {c?.nome ?? c}</div>
        ))}
      </div>
      {editando ? (
        <input
          autoFocus type="text" inputMode="decimal" value={valor}
          onChange={e => setValor(e.target.value)}
          onBlur={salvar}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); salvar() } else if (e.key === 'Escape') setEditando(false) }}
          placeholder="0,00"
          style={{ flexShrink: 0, width: 62, padding: '2px 6px', fontSize: 12, borderRadius: 6,
            border: '1.5px solid #7c3aed', background: 'var(--surface)', color: 'var(--text)', textAlign: 'right' }}
        />
      ) : podeEditarPreco ? (
        <button type="button" onClick={abrir} title="Editar preço deste item"
          style={{ flexShrink: 0, padding: '2px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
            border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {fmt(pu * q)} ✎
        </button>
      ) : (
        <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmt(pu * q)}</span>
      )}
      {!pronto && onItemPronto && (
        <button type="button" title="Marcar este item pronto" onClick={() => onItemPronto(comanda, it)}
          style={{ flexShrink: 0, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 800,
            border: '1px solid #22c55e', background: 'rgba(34,197,94,.12)', color: '#16a34a' }}>
          ✓
        </button>
      )}
    </div>
  )
}

function CardMesa({ comanda, taxaPct = 0, onPronto, onItemPronto, onFecharConta, onConfirmarLiberar, onImprimir, onImprimirConta, onEditarPreco, podeEditarPreco, onAjustarTaxa }) {
  const itens = Array.isArray(comanda.comanda_itens) ? comanda.comanda_itens : []
  const subtotal = itens.reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
  const hora = new Date(comanda.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const pendentes = itens.filter(it => it.status !== 'pronto' && it.status !== 'entregue')
  const aguardando = comanda.status === 'aguardando_conferencia'
  const taxaAplicada = (comanda.fechamento_pendente || {}).aplicar_taxa !== false // garçom fecha com 10% por padrão
  // O card mostrava só a soma dos itens: o ADM conferia a mesa azul por um valor
  // MENOR do que o cliente pagou, na loja que cobra serviço. Aqui o topo já sai
  // com a taxa que vai ser cobrada de verdade (a do fechamento do garçom).
  const taxa = calcularTaxa(itens, taxaPct, aguardando ? taxaAplicada : true)
  const total = subtotal + taxa
  return (
    <div className="pp-mini" style={{ borderLeft: `3px solid ${aguardando ? '#3b82f6' : '#db2777'}`, cursor: 'default' }}>
      <div className="pp-mini-top" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="pp-mini-num" style={{ flex: 1, minWidth: 0 }}>
          🍽️ {rotuloComanda(comanda)} · {fmt(total)}
          {taxa > 0 && (
            <span style={{ fontWeight: 600, fontSize: 11.5, color: 'var(--text-muted)' }}>
              {' '}({fmt(subtotal)} + {fmt(taxa)} de serviço)
            </span>
          )}
        </span>
        {onImprimir && itens.length > 0 && (
          <button type="button" title="Imprimir comanda na cozinha" aria-label="Imprimir comanda"
            onClick={() => onImprimir(comanda)}
            style={{ flexShrink: 0, padding: '4px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 14, lineHeight: 1,
              border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>
            🖨️
          </button>
        )}
      </div>
      <div className="pp-mini-sub">{hora} · autoatendimento (QR)</div>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {itens.map(it => (
          <LinhaItemMesa key={it.id} comanda={comanda} it={it} onItemPronto={onItemPronto}
            onEditarPreco={onEditarPreco} podeEditarPreco={podeEditarPreco} />
        ))}
      </div>
      {onPronto && (pendentes.length > 0 ? (
        <button type="button" onClick={() => onPronto(comanda)}
          style={{ marginTop: 8, width: '100%', padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: 12.5,
            border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.14)', color: '#16a34a' }}>
          ✓ Marcar tudo pronto
        </button>
      ) : (
        <div style={{ marginTop: 8, textAlign: 'center', fontSize: 12.5, fontWeight: 800, color: '#16a34a' }}>✓ Tudo pronto</div>
      ))}
      {aguardando ? (
        <>
          <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 8, background: 'rgba(59,130,246,.16)', color: '#2563eb', fontWeight: 800, fontSize: 11.5, textAlign: 'center' }}>
            🔵 Conta fechada pelo garçom — aguardando o ADM liberar
          </div>
          {onAjustarTaxa && (
            <button type="button" onClick={() => onAjustarTaxa(comanda, !taxaAplicada)}
              style={{ marginTop: 6, width: '100%', padding: '7px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: 12,
                border: `1.5px solid ${taxaAplicada ? '#f59e0b' : '#16a34a'}`, background: 'transparent', color: taxaAplicada ? '#d97706' : '#16a34a' }}>
              {taxaAplicada ? '➖ Cliente não quer os 10% (tirar e reimprimir)' : '➕ Voltar os 10% (reimprimir)'}
            </button>
          )}
          {/* Reimprimir a conta na mão. A impressão automática da conta depende do
              gestor ENXERGAR o app FWC; quando ele não enxerga, ela não sai e ninguém
              percebe. Este botão não depende disso: tenta app → navegador. */}
          {onImprimirConta && (
            <button type="button" onClick={() => onImprimirConta(comanda)}
              style={{ marginTop: 6, width: '100%', padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: 12.5,
                border: '1.5px solid #7c3aed', background: 'transparent', color: '#a78bfa' }}>
              🧾 Imprimir conta
            </button>
          )}
          {onConfirmarLiberar && (
            <button type="button" onClick={() => onConfirmarLiberar(comanda)}
              style={{ marginTop: 6, width: '100%', padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: 12.5,
                border: 'none', background: '#2563eb', color: '#fff' }}>
              ✅ Confirmar pagamento e liberar mesa
            </button>
          )}
        </>
      ) : (
        onFecharConta && itens.length > 0 && (
          <button type="button" onClick={() => onFecharConta(comanda)}
            style={{ marginTop: 6, width: '100%', padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: 12.5,
              border: 'none', background: '#7c3aed', color: '#fff' }}>
            💳 Fechar conta
          </button>
        )
      )}
    </div>
  )
}

// Modal de fechar conta da mesa pelo gestor
function ModalFecharConta({ comanda, taxaPct, onFechar, onConfirmar }) {
  const [forma, setForma] = useState('dinheiro')
  const [aplicarTaxa, setAplicarTaxa] = useState(true) // taxa de serviço vem marcada; desmarca se o cliente não quiser
  const [salvando, setSalvando] = useState(false)
  const itens = Array.isArray(comanda.comanda_itens) ? comanda.comanda_itens : []
  const subtotal = itens.reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
  // Item de categoria isenta (couvert) fica fora da base da taxa (mig 0192).
  const taxa = calcularTaxa(itens, taxaPct, aplicarTaxa)
  const total = subtotal + taxa
  // Crédito e débito separados: cada um tem a taxa da maquineta dele (ver Caixa).
  const FORMAS = [['dinheiro', '💵 Dinheiro'], ['pix', '⚡ Pix'], ['credito', '💳 Crédito'], ['debito', '💳 Débito']]
  async function confirmar() {
    setSalvando(true)
    await onConfirmar({ comanda, forma, aplicarTaxa, total })
    setSalvando(false)
  }
  return (
    <div className="pp-modal-overlay" onClick={onFechar} style={{ zIndex: 130 }}>
      <div className="pp-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380, width: '92vw' }}>
        <p className="pp-modal-titulo">Fechar conta · {rotuloComanda(comanda)}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={aplicarTaxa} onChange={e => setAplicarTaxa(e.target.checked)} />
              Taxa de serviço ({taxaPct}%)
            </span>
            <span>{fmt(taxa)}</span>
          </label>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 16, marginTop: 4 }}>
            <span>Total</span><span style={{ color: '#7c3aed' }}>{fmt(total)}</span>
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>Forma de pagamento</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {FORMAS.map(([v, lbl]) => (
            <button key={v} type="button" onClick={() => setForma(v)} style={{
              flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12.5,
              border: `1.5px solid ${forma === v ? '#16a34a' : 'var(--border, #2a2a3a)'}`,
              background: forma === v ? 'rgba(34,197,94,.12)' : 'transparent',
              color: forma === v ? '#16a34a' : 'var(--text)',
            }}>{lbl}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onFechar} style={{ flex: '0 0 auto', padding: '0 16px', borderRadius: 10, border: '1px solid var(--border, #2a2a3a)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>Cancelar</button>
          <button type="button" onClick={confirmar} disabled={salvando} style={{ flex: 1, height: 44, borderRadius: 10, border: 'none', cursor: 'pointer', background: '#16a34a', color: '#fff', fontWeight: 800 }}>
            {salvando ? 'Fechando...' : `Fechar · ${fmt(total)}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// Coluna do quadro
function Coluna({ titulo, cor, count, vazio, children }) {
  return (
    <div className="pp-col">
      <div className="pp-col-head" style={{ borderTopColor: cor }}>
        <span>{titulo}</span>
        <span className="pp-col-count" style={{ background: cor }}>{count}</span>
      </div>
      <div className="pp-col-body">
        {count === 0 ? <div className="pp-col-vazio">{vazio}</div> : children}
      </div>
    </div>
  )
}

// ── Conversa aberta (loja respondendo cliente) ──────────────
// FOTO E ÁUDIO DA CONVERSA (mig 0242).
//
// O arquivo fica num bucket PRIVADO — é foto de cliente: comprovante, receita,
// endereço, a casa dele. Então a tela pede um link assinado na hora de mostrar,
// e esse link vence sozinho. Sem isso a foto de um cliente ficaria numa URL
// pública que qualquer um com o endereço abriria.
//
// A mídia vive 24 horas. Passou disso, o arquivo já foi apagado pela faxina e
// a mensagem fica só com a marca ("📷 Foto") — quem precisa rever abre o
// WhatsApp, que é onde a conversa mora de verdade.
// PLAYER DE ÁUDIO no formato do WhatsApp (mig 0242).
//
// O <audio controls> do navegador não cabe na bolha: ele encolhe até virar um
// "⋯" com três pontinhos e SOME COM O BOTÃO DE PLAY. Quem atende olhava pra uma
// mensagem de áudio sem nenhum jeito óbvio de ouvir.
//
// Aqui é o desenho que todo mundo já conhece: bolinha de play, a onda do áudio
// e o tempo embaixo. Tocar é um toque, e dá pra pular pro meio clicando na onda.
function PlayerDeAudio({ url }) {
  const ref = useRef(null)
  const [tocando, setTocando] = useState(false)
  const [agora, setAgora] = useState(0)
  const [total, setTotal] = useState(0)
  // Áudio de cliente é quase sempre mais longo do que precisava ser. Acelerar é
  // o que faz ouvir 20 recados no movimento em vez de deixar pra depois — e
  // "depois" é quando o pedido some.
  const VELOCIDADES = [1, 1.5, 2]
  const [velocidade, setVelocidade] = useState(1)

  function trocarVelocidade() {
    const proxima = VELOCIDADES[(VELOCIDADES.indexOf(velocidade) + 1) % VELOCIDADES.length]
    setVelocidade(proxima)
    if (ref.current) ref.current.playbackRate = proxima
  }

  // A "onda" é decorativa — desenhar a real exigiria decodificar o áudio
  // inteiro, e o que importa aqui é ver o progresso. As alturas saem do próprio
  // endereço do arquivo pra cada áudio ter o seu desenho, sempre o mesmo.
  const barras = useMemo(() => {
    let semente = 0
    for (let i = 0; i < (url || '').length; i++) semente = (semente * 31 + url.charCodeAt(i)) % 100000
    return Array.from({ length: 34 }, (_, i) => {
      semente = (semente * 1103515245 + 12345) % 2147483648
      return 24 + ((semente >> (i % 8)) % 70)   // 24% a 94% da altura
    })
  }, [url])

  function alternar() {
    const a = ref.current
    if (!a) return
    if (a.paused) { a.play().catch(() => {}); } else { a.pause() }
  }

  function pularPara(e) {
    const a = ref.current
    if (!a || !total) return
    const cx = e.currentTarget.getBoundingClientRect()
    const fracao = Math.min(1, Math.max(0, (e.clientX - cx.left) / cx.width))
    a.currentTime = fracao * total
    setAgora(a.currentTime)
  }

  // Áudio de WhatsApp (ogg/opus) costuma vir SEM a duração no cabeçalho: o
  // navegador responde Infinity e a barra nunca anda. O empurrão pro fim força
  // ele a calcular, e aí a gente volta pro começo.
  function aoCarregar() {
    const a = ref.current
    if (!a) return
    if (a.duration === Infinity || Number.isNaN(a.duration)) {
      a.currentTime = 1e101
      const voltar = () => { a.currentTime = 0; setTotal(a.duration || 0); a.removeEventListener('timeupdate', voltar) }
      a.addEventListener('timeupdate', voltar)
    } else {
      setTotal(a.duration || 0)
    }
  }

  const mmss = (seg) => {
    const s2 = Math.max(0, Math.floor(seg || 0))
    return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`
  }
  const progresso = total ? agora / total : 0

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, minWidth: 190 }}>
      <audio
        ref={ref} src={url} preload="metadata"
        onLoadedMetadata={aoCarregar}
        onDurationChange={aoCarregar}
        onTimeUpdate={e => setAgora(e.currentTarget.currentTime)}
        onPlay={e => { e.currentTarget.playbackRate = velocidade; setTocando(true) }}
        onPause={() => setTocando(false)}
        onEnded={() => { setTocando(false); setAgora(0) }}
        style={{ display: 'none' }}
      />
      <button
        type="button" onClick={alternar}
        aria-label={tocando ? 'Pausar áudio' : 'Ouvir áudio'}
        style={{
          flexShrink: 0, width: 34, height: 34, borderRadius: '50%', border: 'none',
          background: 'rgba(255,255,255,.16)', color: 'var(--text)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
        }}
      >
        {tocando ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5Z" />
          </svg>
        )}
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          onClick={pularPara}
          style={{ display: 'flex', alignItems: 'center', gap: 2, height: 26, cursor: total ? 'pointer' : 'default' }}
        >
          {barras.map((altura, i) => (
            <span key={i} style={{
              flex: 1, height: `${altura}%`, borderRadius: 2, minWidth: 2,
              background: (i / barras.length) <= progresso ? '#60a5fa' : 'rgba(255,255,255,.30)',
              transition: 'background .15s',
            }} />
          ))}
        </div>
        <div style={{ fontSize: 10.5, opacity: .7, marginTop: 1 }}>
          {mmss(tocando || agora ? agora : total)}
        </div>
      </div>

      <button
        type="button" onClick={trocarVelocidade}
        title="Velocidade de reprodução"
        aria-label={`Velocidade ${String(velocidade).replace('.', ',')} vezes`}
        style={{
          flexShrink: 0, minWidth: 34, height: 22, padding: '0 7px', borderRadius: 11,
          border: 'none', cursor: 'pointer',
          background: velocidade === 1 ? 'rgba(255,255,255,.14)' : 'rgba(96,165,250,.28)',
          color: velocidade === 1 ? 'var(--text)' : '#93c5fd',
          fontSize: 11, fontWeight: 800, lineHeight: 1,
        }}
      >
        {String(velocidade).replace('.', ',')}×
      </button>
    </div>
  )
}

function MidiaDaMensagem({ path, tipo }) {
  const [url, setUrl] = useState(null)
  const [erro, setErro] = useState(false)

  useEffect(() => {
    if (!path) return
    let vivo = true
    supabase.storage.from('chat-midias').createSignedUrl(path, 60 * 60)
      .then(({ data, error }) => {
        if (!vivo) return
        if (error || !data?.signedUrl) setErro(true)
        else setUrl(data.signedUrl)
      })
    return () => { vivo = false }
  }, [path])

  if (erro) {
    return <div style={{ fontSize: 11.5, opacity: .7, marginTop: 4 }}>(não consegui abrir o arquivo)</div>
  }
  if (!url) {
    return <div style={{ fontSize: 11.5, opacity: .7, marginTop: 4 }}>carregando…</div>
  }
  if (tipo === 'audio') return <PlayerDeAudio url={url} />
  if (tipo === 'imagem') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 6 }}>
        <img src={url} alt="Foto enviada pelo cliente" loading="lazy"
          style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8, display: 'block' }} />
      </a>
    )
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      style={{ display: 'inline-block', marginTop: 6, fontSize: 12, color: '#60a5fa', textDecoration: 'underline' }}>
      abrir arquivo
    </a>
  )
}

function ChatConversa({ thread, texto, onTexto, enviando, onEnviar, onVoltar, canalLabel, aviso, empresaId, empresa, onEscolherProduto, botPausado, onDevolverAoRobo, sacola, onQtdSacola, onQtdDiretaSacola, onAvulsoSacola, onEnviarSacola, enviandoSacola, onAbrirSacola, onFinalizarPedido, salvandoPedido, onPedirLocalizacao, onUsarLocalizacao, cadastroVersao }) {
  const g = useTelaGrande()
  const fimRef = useRef(null)
  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: 'end' })
  }, [thread.msgs.length])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
      {/* Cabeçalho da conversa */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10, borderBottom: '1px solid var(--border, #2a2a3a)', marginBottom: 8 }}>
        <button type="button" onClick={onVoltar} aria-label="Voltar"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: 20, lineHeight: 1, padding: 0 }}>
          ‹
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {thread.cliente_nome || thread.cliente_ref || 'Cliente'}
          </div>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 20,
            background: thread.canal === 'app' ? '#f97316' : '#3b82f6', color: '#fff',
          }}>{canalLabel}</span>
        </div>
      </div>

      {/* Mensagens */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
        {thread.msgs.map(m => {
          const daLoja = m.remetente === 'loja'
          const doRobo = daLoja && m.bot
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: daLoja ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: g ? '76%' : '82%', padding: g ? '12px 16px' : '7px 11px', borderRadius: 13,
                fontSize: g ? 17 : 13.5, lineHeight: g ? 1.5 : 1.35,
                // Duas cores, um significado só, igual à tela de Mensagens do
                // portal: ROXO é o robô, VERDE é você. Antes as duas falas
                // saíam roxas (a sua em roxo cheio, a do robô apagada) e quem
                // atende tinha que ler pra saber quem tinha falado.
                background: doRobo ? 'rgba(124,58,237,.28)' : daLoja ? 'rgba(34,197,94,.16)' : 'var(--bg, #0f0f1a)',
                color: 'var(--text)',
                border: doRobo ? '1px solid rgba(124,58,237,.55)' : daLoja ? '1px solid rgba(34,197,94,.45)' : '1px solid var(--border, #2a2a3a)',
                borderBottomRightRadius: daLoja ? 3 : 12,
                borderBottomLeftRadius: daLoja ? 12 : 3,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {doRobo && (
                  <div style={{ fontSize: 9.5, fontWeight: 800, opacity: .8, marginBottom: 2 }}>🤖 Robô</div>
                )}
                {/* Localização que o cliente mandou (mig 0238): o ponto exato
                    da casa dele. Vale mais que qualquer endereço digitado —
                    aqui ele vira endereço + pino com um clique. */}
                {m.lat != null && m.lng != null ? (
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>📍 Localização enviada</div>
                    <a
                      href={`https://www.google.com/maps?q=${m.lat},${m.lng}`}
                      target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 11.5, color: '#60a5fa', textDecoration: 'underline' }}
                    >
                      abrir no mapa
                    </a>
                    {onUsarLocalizacao && (
                      <button
                        type="button"
                        onClick={() => onUsarLocalizacao({ lat: Number(m.lat), lng: Number(m.lng) })}
                        style={{
                          display: 'block', marginTop: 6, padding: '6px 10px', borderRadius: 7,
                          border: '1.5px solid #7c3aed', background: 'rgba(124,58,237,.15)',
                          color: '#a78bfa', fontWeight: 700, fontSize: 11.5, cursor: 'pointer',
                        }}
                      >
                        Usar como endereço do cliente
                      </button>
                    )}
                  </div>
                ) : m.texto}
                {m.midia_path && (
                  <MidiaDaMensagem path={m.midia_path} tipo={m.midia_tipo} />
                )}
                <div style={{ fontSize: 9.5, opacity: .65, marginTop: 3, textAlign: 'right' }}>
                  {new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={fimRef} />
      </div>

      {/* Saiu no WhatsApp ou não? Quem está atendendo precisa saber ANTES de
          achar que avisou o cliente e tocar o pedido pra frente. */}
      {aviso && (
        <div style={{
          fontSize: 11.5, fontWeight: 600, padding: '6px 9px', borderRadius: 8, marginTop: 6,
          background: aviso.ok ? 'rgba(34,197,94,.12)' : 'rgba(234,179,8,.14)',
          color: aviso.ok ? '#16a34a' : '#b45309',
        }}>{aviso.txt}</div>
      )}

      {/* O robô está fora desta conversa porque alguém assumiu. O caminho de
          volta fica AQUI, onde a pessoa está — o card do chamado já sumiu
          quando ela respondeu. */}
      {botPausado && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '7px 10px',
          borderRadius: 8, background: 'rgba(124,58,237,.10)', border: '1px solid rgba(124,58,237,.35)',
        }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flex: 1, lineHeight: 1.4 }}>
            🤖 O robô está calado nesta conversa — quem responde é você.
          </span>
          <button type="button" onClick={onDevolverAoRobo}
            style={{
              flexShrink: 0, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11.5, fontWeight: 800,
              border: '1px solid rgba(124,58,237,.6)', background: 'rgba(124,58,237,.18)', color: '#a78bfa',
            }}>Devolver pro robô</button>
        </div>
      )}

      {/* No PC a sacola mora NO PAINEL AO LADO (ver PainelSacola): montar
          carrinho embaixo das mensagens empurra a conversa pra cima e o
          atendente perde de vista o que o cliente pediu. Aqui fica só o botão
          que abre. No celular não cabem dois painéis — lá continua embaixo. */}
      {empresaId && g && (
        <button type="button" onClick={onAbrirSacola}
          style={{
            marginTop: 8, width: '100%', padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
            fontSize: 15.5, fontWeight: 700,
            border: `1px ${sacola?.length ? 'solid' : 'dashed'} ${sacola?.length ? 'rgba(34,197,94,.6)' : 'var(--border, #2a2a3a)'}`,
            background: sacola?.length ? 'rgba(34,197,94,.10)' : 'transparent',
            color: sacola?.length ? '#22c55e' : 'var(--text-muted)',
          }}>
          {sacola?.length
            ? `🛒 Sacola do cliente (${sacola.length} ${sacola.length === 1 ? 'item' : 'itens'})`
            : '🔍 Buscar produto / montar sacola'}
        </button>
      )}

      {empresaId && !g && <BuscaProdutoNoChat empresaId={empresaId} onEscolher={onEscolherProduto} onAvulso={onAvulsoSacola} />}
      {!g && sacola?.length > 0 && (
        <>
          <SacolaNoChat
            itens={sacola}
            onQtd={onQtdSacola}
            onQtdDireta={onQtdDiretaSacola}
            onRemover={idx => onQtdSacola(idx, -999)}
            onEnviar={onEnviarSacola}
            enviando={enviandoSacola}
          />
          <FecharPedidoNoChat
            key={thread.cliente_ref}
            empresa={empresa}
            telefone={thread.cliente_ref}
            nomeThread={thread.cliente_nome}
            itens={sacola}
            onFinalizar={onFinalizarPedido}
            salvando={salvandoPedido}
            cadastroVersao={cadastroVersao}
          />
        </>
      )}

      {/* Pedir o pininho do WhatsApp. Endereço ditado por áudio erra número e
          o mapa erra o resto; o ponto que o cliente manda não erra nada. */}
      {onPedirLocalizacao && thread.canal === 'whatsapp' && (
        <button type="button" onClick={onPedirLocalizacao} disabled={enviando}
          style={{
            marginTop: 8, width: '100%', padding: g ? '10px 14px' : '8px 12px', borderRadius: 9,
            border: '1px dashed var(--border, #2a2a3a)', background: 'transparent',
            color: 'var(--text-muted)', fontSize: g ? 14 : 12.5, fontWeight: 600, cursor: 'pointer',
          }}>
          📍 Pedir a localização do cliente
        </button>
      )}

      {/* Caixa de resposta */}
      <div style={{ display: 'flex', gap: 6, paddingTop: 8, borderTop: '1px solid var(--border, #2a2a3a)' }}>
        <textarea
          value={texto}
          onChange={e => onTexto(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEnviar() } }}
          placeholder="Escreva uma resposta..."
          rows={g ? 2 : 1}
          style={{
            flex: 1, resize: 'none', maxHeight: g ? 140 : 90, padding: g ? '12px 14px' : '9px 11px', borderRadius: 10,
            border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
            color: 'var(--text)', fontSize: g ? 16.5 : 13.5, fontFamily: 'inherit',
          }}
        />
        <button type="button" onClick={onEnviar} disabled={!texto.trim() || enviando}
          style={{
            flexShrink: 0, width: g ? 54 : 42, borderRadius: 10, border: 'none', cursor: texto.trim() ? 'pointer' : 'default',
            background: texto.trim() ? '#7c3aed' : 'var(--border, #2a2a3a)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// PC ou celular? No celular a gaveta ocupa a tela inteira e o desenho
// apertado é o certo. No monitor sobra espaço dos dois lados, e aí 480px de
// largura com letra 13 vira uma conversa que ninguém consegue ler o dia todo.
function useTelaGrande() {
  const [grande, setGrande] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 1024,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const ver = e => setGrande(e.matches)
    mq.addEventListener('change', ver)
    return () => mq.removeEventListener('change', ver)
  }, [])
  return grande
}

// Busca de produto DENTRO da conversa. Quando o robô transfere ("não achei
// Galioto"), o atendente precisa do nome e do preço certos sem sair da tela — e
// o nome que ele mandar é o que o robô vai ler pra reconhecer o produto quando
// voltar. Escrito de cabeça, sai errado; daqui, sai do cadastro.
function BuscaProdutoNoChat({ empresaId, onEscolher, onAvulso, semBotao = false }) {
  const g = useTelaGrande()
  const [termo, setTermo] = useState('')
  const [itens, setItens] = useState([])
  const [buscando, setBuscando] = useState(false)
  const [aberto, setAberto] = useState(false)
  const [avulsoPreco, setAvulsoPreco] = useState('')

  // Vender o que não está cadastrado: o nome é o que ele acabou de digitar na
  // busca, e o preço ele informa. Vai pra sacola como qualquer outro item.
  function addAvulso() {
    const nome = termo.trim()
    const v = Number(String(avulsoPreco).replace(',', '.'))
    if (!nome || !(v > 0)) return
    onAvulso({ produto_id: null, nome, preco: v, qtd: 1 })
    setAvulsoPreco('')
    setTermo('')
    setItens([])
  }

  async function buscar(q) {
    const t = q.trim()
    if (t.length < 3) { setItens([]); return }
    setBuscando(true)
    // Mesma busca do robô (migs 0227/0232/0233): sem acento, casa categoria e
    // perdoa erro de digitação — "heinekem" acha "HEINEKEN".
    const { data } = await supabase.rpc('buscar_produto_nome', {
      p_empresa: empresaId, p_termo: t, p_limite: 12,
    })
    setItens(Array.isArray(data) ? data : [])
    setBuscando(false)
  }

  if (!aberto && !semBotao) {
    return (
      <button type="button" onClick={() => setAberto(true)}
        style={{
          marginTop: 8, width: '100%', padding: g ? '12px 14px' : '8px 10px', borderRadius: 10,
          cursor: 'pointer', fontSize: g ? 15.5 : 12.5, fontWeight: 700,
          border: '1px dashed var(--border, #2a2a3a)', background: 'transparent', color: 'var(--text-muted)',
        }}>🔍 Buscar produto no cardápio</button>
    )
  }

  return (
    <div style={{ marginTop: 6, border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 8 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          autoFocus
          value={termo}
          onChange={e => { setTermo(e.target.value); buscar(e.target.value) }}
          placeholder="Nome do produto (ex.: galioto, coca 2l)"
          style={{
            flex: 1, padding: g ? '13px 15px' : '7px 10px', borderRadius: 9, fontSize: g ? 16 : 13,
            border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
          }}
        />
        <button type="button" onClick={() => { setAberto(false); setTermo(''); setItens([]) }}
          style={{ padding: '0 10px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>×</button>
      </div>

      {termo.trim().length >= 3 && (
        <div style={{ marginTop: 6, maxHeight: g ? 340 : 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: g ? 6 : 4 }}>
          {buscando && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Procurando…</div>}
          {!buscando && itens.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Nada com esse nome no cardápio.<br />
              Se a loja tem o produto e ele não está cadastrado, cadastre no <strong>Catálogo</strong> — depois é só buscar aqui de novo.
            </div>
          )}
          {/* Não achou porque a loja não cadastrou? A venda não pode morrer
              por isso: nome (o que ele digitou) + preço, e o item entra na
              sacola igual aos outros. */}
          <div style={{ display: 'flex', gap: 5, marginTop: 2, marginBottom: 2 }}>
            <input value={avulsoPreco} onChange={e => setAvulsoPreco(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addAvulso() }}
              placeholder="R$"
              style={{ width: g ? 90 : 66, padding: g ? '10px 12px' : '6px 8px', borderRadius: 8, fontSize: g ? 14.5 : 12, border: '1px solid #f59e0b', background: 'var(--bg, #0f0f1a)', color: 'var(--text)' }} />
            <button type="button" onClick={addAvulso}
              style={{ flex: 1, padding: g ? '10px 12px' : '6px 8px', borderRadius: 8, cursor: 'pointer', fontSize: g ? 13.5 : 11.5, fontWeight: 700,
                       border: '1px solid #f59e0b', background: 'rgba(245,158,11,.12)', color: '#f59e0b' }}>
              + Vender &quot;{termo.trim()}&quot; mesmo sem cadastro
            </button>
          </div>

          {itens.map(p => (
            <button key={p.id} type="button" onClick={() => onEscolher(p)}
              style={{
                textAlign: 'left', cursor: 'pointer', padding: g ? '11px 13px' : '7px 9px', borderRadius: 9,
                border: '1px solid var(--border, #2a2a3a)', background: 'transparent',
              }}>
              <div style={{ fontSize: g ? 16.5 : 13, fontWeight: 700, color: 'var(--text)' }}>{p.nome}</div>
              <div style={{ fontSize: g ? 14 : 11.5, color: 'var(--text-muted)' }}>
                {Number(p.preco) > 0 ? `R$ ${Number(p.preco).toFixed(2).replace('.', ',')}` : 'sob consulta'}
                {/* O degrau do atacado já na lista, igual à tela de Vender: o
                    atendente vê que existe preço melhor antes de bater a
                    quantidade. */}
                {menorFaixa(p.faixas_preco)
                  ? <span style={{ color: '#22c55e', fontWeight: 700 }}> · {menorFaixa(p.faixas_preco).qtd_min}+ R$ {Number(menorFaixa(p.faixas_preco).preco).toFixed(2).replace('.', ',')}</span>
                  : null}
                {p.categoria ? ` · ${p.categoria}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Preço da linha da sacola pra essa quantidade — a mesma conta da tela de
 * Vender e da Loja Online.
 *
 * Sem isto, 10 picolés de R$ 1,50 fechavam R$ 15,00 na conversa mesmo com a
 * faixa "a partir de 10 sai a R$ 0,65" cadastrada: o atendente mandava pro
 * cliente um preço que a loja não cobra em lugar nenhum.
 *
 * Item fora do cardápio não tem faixa nenhuma: vale o preço que o atendente
 * digitou, e ninguém mexe nele.
 */
function precoSacola(item, qtd) {
  if (item?.precoBase == null) return Number(item?.preco || 0)
  const base = Number(item.precoBase) || 0
  const p = precoPorQuantidade(base, item.faixas_preco, qtd, item.preco_promocional)
  // A faixa só vale se for MENOR: preço combinado à parte não sobe por causa
  // do atacado.
  return Math.min(p, base)
}

// Sacola montada pelo ATENDENTE, dentro da conversa.
//
// Nasce do caso que o robô não resolve: o cliente pediu algo que não está no
// cardápio. A tela de balcão não serve aqui — ela cobre a conversa, e não tem
// como jogar o que está nela pra dentro do chat. Então a sacola mora aqui: o
// atendente acha o produto (ou digita um que não está cadastrado), monta, e um
// botão só manda a lista pro cliente E entrega o carrinho pro robô terminar
// endereço e pagamento. A parte chata fica com a gente; a fácil, com o robô.
function SacolaNoChat({ itens, onQtd, onQtdDireta, onRemover, onEnviar, enviando }) {
  const g = useTelaGrande()
  const total = itens.reduce((s, i) => s + Number(i.preco) * Number(i.qtd), 0)

  return (
    <div style={{
      marginTop: 8, border: '1px solid rgba(34,197,94,.4)', borderRadius: 10,
      background: 'rgba(34,197,94,.06)', padding: g ? 14 : 8,
    }}>
      <div style={{ fontSize: g ? 13.5 : 11, fontWeight: 800, color: '#22c55e', marginBottom: g ? 10 : 6 }}>
        🛒 SACOLA DO CLIENTE ({itens.length} {itens.length === 1 ? 'item' : 'itens'})
      </div>

      {itens.map((i, idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: g ? 10 : 6, marginBottom: g ? 8 : 4 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: g ? 16 : 12.5, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {i.nome}{!i.produto_id && <span style={{ fontSize: 10, color: '#f59e0b' }}> · fora do cardápio</span>}
            </div>
            <div style={{ fontSize: g ? 14 : 11, color: 'var(--text-muted)' }}>
              R$ {Number(i.preco).toFixed(2).replace('.', ',')} · subtotal R$ {(Number(i.preco) * Number(i.qtd)).toFixed(2).replace('.', ',')}
              {/* Por que este preço e não o da vitrine: o atendente confere
                  isso em voz alta com o cliente. */}
              {faixaAplicada(i.faixas_preco, i.qtd)
                ? <span style={{ color: '#22c55e', fontWeight: 700 }}> · atacado {faixaAplicada(i.faixas_preco, i.qtd).qtd_min}+</span>
                : menorFaixa(i.faixas_preco)
                  ? <span style={{ color: '#22c55e', fontWeight: 700 }}> · {menorFaixa(i.faixas_preco).qtd_min}+ sai a R$ {Number(menorFaixa(i.faixas_preco).preco).toFixed(2).replace('.', ',')}</span>
                  : null}
            </div>
          </div>
          <button type="button" onClick={() => onQtd(idx, -1)} style={btnQtd(g)}>−</button>
          {/* Digitar a quantidade, igual à tela de Vender: no atacado ninguém
              clica 30 vezes no "+" pra vender 30 picolés. */}
          <QtdInput value={i.qtd} onChange={n => onQtdDireta(idx, n)} />
          <button type="button" onClick={() => onQtd(idx, 1)} style={btnQtd(g)}>+</button>
          <button type="button" onClick={() => onRemover(idx)} style={{ ...btnQtd(g), color: '#ef4444' }}>×</button>
        </div>
      ))}

      {itens.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: g ? 12 : 8, fontSize: g ? 17.5 : 13, fontWeight: 800, color: 'var(--text)' }}>
            <span>Total dos itens</span>
            <span>R$ {total.toFixed(2).replace('.', ',')}</span>
          </div>
          <button type="button" onClick={onEnviar} disabled={enviando}
            style={{
              width: '100%', marginTop: g ? 12 : 8, padding: g ? '14px 12px' : '9px 10px', borderRadius: 9, border: 'none',
              background: '#22c55e', color: '#fff', fontSize: g ? 16 : 12.5, fontWeight: 800,
              cursor: enviando ? 'default' : 'pointer', opacity: enviando ? .6 : 1,
            }}>
            {enviando ? 'Enviando...' : '📤 Mandar a sacola pro cliente'}
          </button>
          <div style={{ fontSize: g ? 13 : 10.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
            O cliente recebe a lista com os preços. Você continua na conversa —
            pra o robô assumir daqui, use o <strong>Devolver pro robô</strong>.
          </div>
        </>
      )}
    </div>
  )
}
const btnQtd = (g) => ({
  width: g ? 34 : 24, height: g ? 34 : 24, borderRadius: 7, cursor: 'pointer', flexShrink: 0,
  border: '1px solid var(--border, #2a2a3a)', background: 'transparent',
  color: 'var(--text)', fontSize: g ? 17 : 14, fontWeight: 800, lineHeight: 1,
})

// ── Fechar o pedido pela conversa ────────────────────────────────────────────
//
// A sacola já monta os itens. O que faltava era o resto do pedido: endereço,
// forma de pagamento e o botão que joga no sistema. Sem isso o atendente
// conversava aqui e digitava tudo DE NOVO na tela de Vender — dois trabalhos
// pro mesmo pedido, e é na segunda digitação que troca item e valor.
//
// O endereço vem preenchido quando o cliente já pediu antes: é o caso comum, e
// aí o atendente só confere e aperta o botão.
const FORMAS_PGTO = [
  ['dinheiro',    '💵 Dinheiro'],
  ['pix_entrega', '📱 PIX'],
  ['credito',     '💳 Crédito'],
  ['debito',      '💳 Débito'],
  ['cartao',      '💳 Cartão'],
]

function FecharPedidoNoChat({ empresa, telefone, nomeThread, itens, onFinalizar, salvando, cadastroVersao = 0 }) {
  const g = useTelaGrande()
  const [tipo, setTipo] = useState('entrega')
  const [nome, setNome] = useState(nomeThread || '')
  const [cep, setCep] = useState('')
  const [rua, setRua] = useState('')
  const [numero, setNumero] = useState('')
  const [bairro, setBairro] = useState('')
  const [cidade, setCidade] = useState('')
  const [taxa, setTaxa] = useState('')
  const [pagamento, setPagamento] = useState('dinheiro')
  const [troco, setTroco] = useState('')
  const [obs, setObs] = useState('')
  const [msgTaxa, setMsgTaxa] = useState(null)
  const [calculando, setCalculando] = useState(false)
  const [achouCliente, setAchouCliente] = useState(false)
  const [cadastro, setCadastro] = useState(null)   // { id, telefone } do cliente que já existe
  // Pino que o cliente apontou (mandou a localização, ou arrastou no link).
  // Vai junto no pedido: é ele que o app do entregador abre.
  const [pinCadastro, setPinCadastro] = useState(null)  // { lat, lng, ref }
  const [ruaSug, setRuaSug] = useState([])
  const [ruaSugAberta, setRuaSugAberta] = useState(false)

  // Digitou o nome da rua, aparece a lista — mesma busca da tela de Vender e do
  // checkout do cliente. Quem atende está com o cliente falando no ouvido: o
  // CEP ele não sabe, o nome da rua sim.
  useEffect(() => {
    if (tipo !== 'entrega') { setRuaSug([]); return }
    let vivo = true
    const t = setTimeout(async () => {
      try {
        const d = await buscarRuas(empresa?.estado, cidade || empresa?.cidade, rua)
        if (vivo) setRuaSug(d)
      } catch { if (vivo) setRuaSug([]) }
    }, 500)
    return () => { vivo = false; clearTimeout(t) }
  }, [rua, cidade, empresa, tipo])

  // O cadastro do cliente, pelos 8 últimos dígitos (o WhatsApp entrega o mesmo
  // número com e sem o 9). Quem já pediu antes não digita endereço de novo.
  useEffect(() => {
    let vivo = true
    const chave = String(telefone ?? '').replace(/\D/g, '').slice(-8)
    if (!empresa?.id || chave.length < 8) return
    ;(async () => {
      const { data } = await supabase.from('clientes')
        .select('id, telefone, nome, endereco, numero, bairro, cidade, cep, endereco_lat, endereco_lng, endereco_pin_manual, endereco_pin_ref')
        .eq('empresa_id', empresa.id).ilike('telefone', `%${chave}`)
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (!vivo || !data) return
      // Guarda QUEM é: o cadastro costuma ter o telefone sem o 55 e o WhatsApp
      // manda com. Salvar pelo número do WhatsApp criava um cliente novo em vez
      // de atualizar o que já existe — dois cadastros pra mesma pessoa.
      setCadastro({ id: data.id, telefone: data.telefone })
      setAchouCliente(true)
      if (data.nome) setNome(n => n || data.nome)
      if (data.endereco) setRua(data.endereco)
      if (data.numero) setNumero(data.numero)
      if (data.bairro) setBairro(data.bairro)
      if (data.cidade) setCidade(data.cidade)
      if (data.cep) setCep(data.cep)
      setPinCadastro(data.endereco_pin_manual && data.endereco_lat != null
        ? { lat: Number(data.endereco_lat), lng: Number(data.endereco_lng), ref: data.endereco_pin_ref }
        : null)
    })()
    return () => { vivo = false }
    // `cadastroVersao` sobe quando a localização do chat vira endereço: aí este
    // formulário relê o cadastro e se preenche sozinho, em vez de deixar quem
    // atende digitando de novo um endereço que já está salvo.
  }, [empresa?.id, telefone, cadastroVersao])

  // CEP preenche rua/bairro/cidade (ViaCEP), igual à tela de Vender.
  async function buscarCep(v) {
    const num = String(v || '').replace(/\D/g, '')
    if (num.length !== 8) return
    try {
      const res = await fetch(`https://viacep.com.br/ws/${num}/json/`)
      const d = await res.json()
      if (d.erro) return
      if (d.logradouro) setRua(d.logradouro)
      if (d.bairro) setBairro(d.bairro)
      if (d.localidade) setCidade(d.localidade)
    } catch { /* CEP fora do ar: segue na mão */ }
  }

  async function calcularTaxa() {
    if (!rua.trim() && !bairro.trim()) { setMsgTaxa({ ok: false, txt: 'Preencha o bairro (ou a rua) primeiro.' }); return }
    setCalculando(true)
    const r = await taxaDoEndereco(empresa, { rua, numero, bairro, cidade, cep })
    setCalculando(false)
    if (r.taxa == null) { setMsgTaxa({ ok: false, txt: r.texto }); return }   // não mexe na taxa que já estava lá
    setTaxa(String(r.taxa.toFixed(2)))
    setMsgTaxa({ ok: !r.bloqueado, txt: r.bloqueado ? r.texto : `Taxa R$ ${r.taxa.toFixed(2).replace('.', ',')} — ${r.texto}` })
  }

  // Só as formas que a loja aceita. PIX aqui é sempre o PIX direto pra loja
  // (o cliente manda o comprovante): gerar cobrança de gateway é outro caminho,
  // e prometer isso aqui daria um pedido esperando um pagamento que não existe.
  const aceitas = Array.isArray(empresa?.formas_pagamento) ? empresa.formas_pagamento : []
  const formas = FORMAS_PGTO.filter(([id]) => (
    aceitas.length === 0
      ? id === 'dinheiro' || id === 'pix_entrega'
      : id === 'pix_entrega' ? (aceitas.includes('pix_entrega') || aceitas.includes('pix')) : aceitas.includes(id)
  ))
  const formasFinais = formas.length ? formas : FORMAS_PGTO.slice(0, 2)

  const subtotal = itens.reduce((s, i) => s + Number(i.preco) * Number(i.qtd), 0)
  const taxaNum = tipo === 'entrega' ? (parseFloat(String(taxa).replace(',', '.')) || 0) : 0
  const total = subtotal + taxaNum
  const faltaEndereco = tipo === 'entrega' && !rua.trim()

  const inp = {
    width: '100%', padding: g ? '10px 12px' : '7px 9px', borderRadius: 8,
    border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
    color: 'var(--text)', fontSize: g ? 14.5 : 13, fontFamily: 'inherit',
  }
  const btnEscolha = (ativo) => ({
    flex: 1, minWidth: 84, padding: g ? '9px 10px' : '7px 8px', borderRadius: 9, cursor: 'pointer',
    fontSize: g ? 13.5 : 12, fontWeight: 700, whiteSpace: 'nowrap',
    border: `1px solid ${ativo ? '#22c55e' : 'var(--border, #2a2a3a)'}`,
    background: ativo ? 'rgba(34,197,94,.16)' : 'transparent',
    color: ativo ? '#22c55e' : 'var(--text-muted)',
  })
  const rotulo = { fontSize: 11, fontWeight: 800, letterSpacing: .4, color: 'var(--text-muted)', textTransform: 'uppercase', margin: '0 0 5px' }

  return (
    <div style={{
      marginTop: 8, border: '1px solid var(--border, #2a2a3a)', borderRadius: 10,
      padding: g ? 14 : 10, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ fontSize: g ? 13.5 : 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: .5, textTransform: 'uppercase' }}>
        Fechar o pedido
      </div>

      <div>
        <p style={rotulo}>Entrega ou retirada</p>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={() => setTipo('entrega')} style={btnEscolha(tipo === 'entrega')}>🛵 Entrega</button>
          <button type="button" onClick={() => setTipo('retirada')} style={btnEscolha(tipo === 'retirada')}>🏪 Retirada</button>
        </div>
      </div>

      <div>
        <p style={rotulo}>Nome do cliente</p>
        <input value={nome} onChange={e => setNome(e.target.value)} placeholder="Como chamar" style={inp} />
        {achouCliente && (
          <div style={{ fontSize: 11.5, color: '#22c55e', marginTop: 4 }}>
            ✓ Cliente já cadastrado — dados vieram do último pedido.
          </div>
        )}
      </div>

      {tipo === 'entrega' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <p style={{ ...rotulo, margin: 0 }}>Endereço da entrega</p>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={cep} onChange={e => { setCep(e.target.value); buscarCep(e.target.value) }}
              placeholder="CEP (preenche sozinho)" inputMode="numeric" style={{ ...inp, flex: 1 }} />
            <input value={numero} onChange={e => setNumero(e.target.value)}
              placeholder="Nº" style={{ ...inp, width: 80, flexShrink: 0 }} />
          </div>
          {/* Digitar o nome da rua e escolher da lista: vem com bairro, cidade
              e CEP juntos, e sem risco de escrever errado o que veio de ouvido. */}
          <div style={{ position: 'relative' }}>
            <input value={rua} autoComplete="off"
              onChange={e => { setRua(e.target.value); setRuaSugAberta(true) }}
              onFocus={() => setRuaSugAberta(true)}
              placeholder="Rua (digite o nome e escolha)" style={inp} />
            {ruaSugAberta && ruaSug.length > 0 && (
              <ListaDeRuas
                sugestoes={ruaSug}
                onFechar={() => setRuaSugAberta(false)}
                onEscolher={r => {
                  const c = String(r.cep ?? '').replace(/\D/g, '')
                  setRua(r.logradouro || rua)
                  if (r.bairro) setBairro(r.bairro)
                  if (r.localidade) setCidade(r.localidade)
                  setCep(c.length === 8 ? `${c.slice(0, 5)}-${c.slice(5)}` : '')
                  setRuaSug([]); setRuaSugAberta(false)
                  // Endereço novo, taxa velha não vale mais.
                  setMsgTaxa(null)
                }}
              />
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={bairro} onChange={e => setBairro(e.target.value)} placeholder="Bairro" style={{ ...inp, flex: 1 }} />
            <input value={cidade} onChange={e => setCidade(e.target.value)} placeholder="Cidade" style={{ ...inp, flex: 1 }} />
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={taxa} onChange={e => setTaxa(e.target.value)} placeholder="Taxa R$"
              inputMode="decimal" style={{ ...inp, width: 110, flexShrink: 0 }} />
            {/* O botão de calcular só aparece com o NÚMERO da casa preenchido:
                sem ele o mapa devolve o meio da rua, e numa rua comprida isso é
                a diferença entre uma faixa de taxa e outra. */}
            {numero.trim() ? (
              <button type="button" onClick={calcularTaxa} disabled={calculando}
                style={{ ...btnEscolha(false), flex: 1, cursor: calculando ? 'wait' : 'pointer' }}>
                {calculando ? 'Calculando…' : '📍 Calcular pelo endereço'}
              </button>
            ) : (
              <span style={{ flex: 1, fontSize: 11.5, lineHeight: 1.4, color: 'var(--text-muted)' }}>
                Ponha o <strong>número da casa</strong> pra calcular a taxa — sem ele o mapa
                erra a distância.
              </span>
            )}
          </div>
          {msgTaxa && (
            <div style={{ fontSize: 11.5, lineHeight: 1.4, color: msgTaxa.ok ? '#22c55e' : '#f59e0b' }}>{msgTaxa.txt}</div>
          )}
        </div>
      )}

      <div>
        <p style={rotulo}>Forma de pagamento</p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {formasFinais.map(([id, lab]) => (
            <button key={id} type="button" onClick={() => setPagamento(id)} style={btnEscolha(pagamento === id)}>{lab}</button>
          ))}
        </div>
        {pagamento === 'dinheiro' && (
          <input value={troco} onChange={e => setTroco(e.target.value)} inputMode="decimal"
            placeholder={`Troco para R$ (total ${total.toFixed(2).replace('.', ',')})`}
            style={{ ...inp, marginTop: 6 }} />
        )}
      </div>

      <div>
        <p style={rotulo}>Observação (opcional)</p>
        <input value={obs} onChange={e => setObs(e.target.value)}
          placeholder="Ex.: portão azul, sem cebola" style={inp} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: g ? 17 : 14, fontWeight: 800, color: 'var(--text)' }}>
        <span>Total do pedido</span>
        <span>R$ {total.toFixed(2).replace('.', ',')}</span>
      </div>
      {tipo === 'entrega' && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: -8 }}>
          itens R$ {subtotal.toFixed(2).replace('.', ',')} + taxa R$ {taxaNum.toFixed(2).replace('.', ',')}
        </div>
      )}

      <button type="button" disabled={salvando || faltaEndereco || !itens.length}
        onClick={() => onFinalizar({
          tipo, nome, cep, rua, numero, bairro, cidade, taxa: taxaNum,
          pagamento, troco, obs, subtotal, total, cadastro,
          // Só manda o pino se ele for DESTE endereço: o cliente que mudou de
          // casa tem pino velho guardado, e ele levaria o motoboy pro lugar
          // errado com o endereço certo escrito no papel.
          pino: pinCadastro && chaveEnderecoJS({ rua, numero, cidade }) === pinCadastro.ref
            ? { lat: pinCadastro.lat, lng: pinCadastro.lng }
            : null,
        })}
        style={{
          width: '100%', padding: g ? '14px 12px' : '10px', borderRadius: 9, border: 'none',
          background: (salvando || faltaEndereco || !itens.length) ? 'var(--border, #2a2a3a)' : '#7c3aed',
          color: '#fff', fontSize: g ? 16 : 13, fontWeight: 800,
          cursor: (salvando || faltaEndereco || !itens.length) ? 'default' : 'pointer',
        }}>
        {salvando ? 'Lançando...' : faltaEndereco ? 'Falta o endereço da entrega' : '✅ Finalizar e jogar no sistema'}
      </button>
      <div style={{ fontSize: g ? 12.5 : 10.5, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: -6 }}>
        O pedido entra já confirmado, igual ao da tela de Vender — imprime, vai pro
        entregador e conta no caixa. O cliente recebe o número do pedido no WhatsApp.
      </div>
    </div>
  )
}

// Tempo previsto (min) pra ficar pronto — usa o tempo do Raio de Entrega por KM,
// sem perguntar ao lojista. Ordem: distância→faixa; senão faixa pela taxa; senão
// maior tempo das faixas; senão tempo_entrega_max. (haversineKm já existe acima.)
function tempoPrevistoMin(pedido, empresa) {
  const faixas = Array.isArray(empresa?.taxas_entrega_km) ? empresa.taxas_entrega_km : []
  if (pedido.tipo_entrega !== 'retirada' && faixas.length) {
    const ord = [...faixas].sort((a, b) => Number(a.km) - Number(b.km))
    if (empresa?.latitude && empresa?.longitude && pedido.endereco_lat && pedido.endereco_lng) {
      const km = haversineKm(Number(empresa.latitude), Number(empresa.longitude), Number(pedido.endereco_lat), Number(pedido.endereco_lng))
      const f = ord.find(x => km <= Number(x.km)) || ord[ord.length - 1]
      if (Number(f?.tempo) > 0) return Number(f.tempo)
    }
    const porTaxa = ord.find(x => Number(x.taxa) === Number(pedido.taxa_entrega))
    if (Number(porTaxa?.tempo) > 0) return Number(porTaxa.tempo)
    const maxT = Math.max(...ord.map(x => Number(x.tempo) || 0))
    if (maxT > 0) return maxT
  }
  return Number(empresa?.tempo_entrega_max) || 40
}

// ── Componente principal ────────────────────────────────────
export default function PainelPedidos() {
  const { empresa, logout, profile } = useAuth()
  // Só o dono (admin/super_admin) pode editar o preço de item da mesa.
  const podeFinanceiro = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'
  const { theme, toggleTheme } = useTheme()
  const [pedidos, setPedidos] = useState([])
  const [entregadores, setEntregadores] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [lojaAberta, setLojaAberta] = useState(false)
  const [excecoesLoja, setExcecoesLoja] = useState({}) // feriados/folgas (mig 0142)
  const [togglingLoja, setTogglingLoja] = useState(false)
  const [avisoHorario, setAvisoHorario] = useState(null)
  const [pedidoRecusando, setPedidoRecusando] = useState(null)
  const [pedidoAceitando, setPedidoAceitando] = useState(null) // pedido no modal de aceite (tempo de preparo)
  const [pedidoMensagem, setPedidoMensagem] = useState(null)
  const [vendaAberta, setVendaAberta] = useState(false)
  const [vendaEditando, setVendaEditando] = useState(null) // pedido de balcão sendo editado

  // Se o vendedor tinha uma venda de balcão pela metade e saiu da tela, reabre
  // o modal ao voltar (o rascunho fica salvo no localStorage — ver ModalVenda).
  useEffect(() => {
    const d = lerDraftVenda(empresa?.id)
    if (d && d.cart && Object.keys(d.cart).length > 0) setVendaAberta(true)
  }, [empresa?.id])
  const [comandas, setComandas] = useState([]) // mesas (autoatendimento QR) abertas
  const [comandaFechando, setComandaFechando] = useState(null) // comanda no modal de fechar conta
  const mesaPrintRef = useRef({}) // buffer p/ imprimir itens da mesa juntos
  const contaMesaImpressaRef = useRef(null) // ids de comanda cuja CONTA já saiu (garçom fechou)
  const [pedidoDetalhe, setPedidoDetalhe] = useState(null) // pedido aberto em detalhe (card completo)
  const [modalCodRetirada, setModalCodRetirada] = useState(null) // retirada aguardando o código do cliente
  const [autoImprimir, setAutoImprimir] = useState(autoImprimirAtivo)
  const [aceitarAuto, setAceitarAuto] = useState(aceitarAutoAtivo)
  // NFC-e: a loja habilitou a emissão E registrou o certificado no emissor?
  const [nfceHabilitada, setNfceHabilitada] = useState(false)
  const [nfceEmitindo, setNfceEmitindo] = useState(null) // id do pedido em emissão
  useEffect(() => {
    if (!empresa?.id) return
    supabase.from('empresa_fiscal').select('ativo, focus_registrada').eq('empresa_id', empresa.id).maybeSingle()
      .then(({ data }) => setNfceHabilitada(!!(data?.ativo && data?.focus_registrada)))
  }, [empresa?.id])

  async function handleEmitirNfce(pedido) {
    if (!pedido?.id) return
    setNfceEmitindo(pedido.id)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const base = import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'
      const r = await fetch(`${base}/functions/v1/emitir-nfce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ acao: 'emitir', pedido_id: pedido.id }),
      })
      const resp = await r.json()
      if (resp?.ok || resp?.ja_emitida) {
        const danfe = resp?.nota?.danfe_url
        if (danfe) window.open(danfe, '_blank')
        alert(resp?.ja_emitida ? 'NFC-e já emitida para este pedido.' : 'NFC-e autorizada! Abrindo o cupom (DANFE).')
      } else if (resp?.status === 'processando') {
        alert('NFC-e enviada, aguardando autorização da SEFAZ. Consulte em instantes.')
      } else {
        alert(`Não foi possível emitir a NFC-e:\n${resp?.mensagem || resp?.error || 'erro desconhecido'}`)
      }
    } catch (e) {
      alert(`Erro ao emitir NFC-e: ${e}`)
    } finally {
      setNfceEmitindo(null)
    }
  }
  // App Impressora FWC conectado + com impressora? Se sim, ele imprime os
  // pedidos (delivery/balcão) sozinho — o navegador NÃO imprime junto (evita 2x).
  const [fwcAppImprime, setFwcAppImprime] = useState(false)
  const [fwcPausado, setFwcPausado] = useState(false)
  const [fwcVersao, setFwcVersao] = useState(0)        // versão do app (>=11 tem filtro por origem)
  const [fwcFiltros, setFwcFiltros] = useState(null)   // o que ESTE PC imprime (null = tudo)
  const fwcImprimeRef = useRef(false)
  useEffect(() => {
    let vivo = true
    const ping = async () => {
      let on = false, pausado = false, versao = 0, filtros = null
      try {
        const r = await fwcFetch('/api/status', { timeout: 3000, cache: 'no-store' })
        const j = await r.json().catch(() => null)
        on = !!(j && j.logado && j.impressora)
        pausado = !!(j && j.pausado)
        versao = Number(j?.versao || 0)
        filtros = j?.filtros ?? null
      } catch (e) { on = false }
      if (vivo) { setFwcAppImprime(on); fwcImprimeRef.current = on; setFwcPausado(pausado); setFwcVersao(versao); setFwcFiltros(filtros) }
    }
    ping(); const id = setInterval(ping, 15000)
    return () => { vivo = false; clearInterval(id) }
  }, [])
  // Liga/desliga o que ESTA impressora imprime (por origem). Salva no app FWC deste PC.
  const FWC_ORIGENS = [
    { k: 'mesa', lbl: 'Mesa (comandas)' },
    { k: 'whatsapp', lbl: 'WhatsApp' },
    { k: 'ifood', lbl: 'iFood' },
    { k: 'balcao', lbl: 'Balcão' },
    { k: 'cardapio', lbl: 'Cardápio (loja online)' },
    { k: 'app', lbl: 'App' },
  ]
  async function toggleFwcFiltro(key) {
    const base = {}
    for (const { k } of FWC_ORIGENS) base[k] = (fwcFiltros?.[k] !== false)
    base[key] = !base[key]
    setFwcFiltros(base) // otimista
    try {
      await fwcFetch('/api/filtros', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filtros: base }),
      })
    } catch { setFwcFiltros(fwcFiltros) /* reverte */ }
  }
  // Atalho do topo: liga/pausa a impressão automática do app FWC.
  async function toggleFwcPausa() {
    const novo = !fwcPausado
    setFwcPausado(novo) // otimista
    try {
      await fwcFetch('/api/pausar', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pausado: novo }),
      })
    } catch { setFwcPausado(!novo) /* reverte se falhou */ }
  }

  // Este aparelho TEM uma térmica pareada e conectada? Então ele é a estação de
  // impressão da loja — o garçom lança do celular dele, e quem cospe o papel é
  // este aqui. Parear impressora é ato explícito: ninguém pareia pra não
  // imprimir. Por isso a térmica conectada vale por si, sem depender do
  // interruptor "Auto-imprimir" (que nasceu pro caminho do navegador, onde a
  // impressão abre janela e atrapalha).
  const ehEstacaoDeImpressao = () => window.__fwcBtConectada === true
  const deveAutoImprimir = () => autoImprimirAtivo() || ehEstacaoDeImpressao()

  // ── Pedido agendado (mig 0222) ───────────────────────────────
  // Ele entra no painel na hora que o cliente faz — mas guardado: não toca e
  // não imprime, senão a cozinha recebe às 8h da manhã o almoço das 11h.
  // Faltando `agendamento_libera_min` pra hora combinada, vira pedido normal e
  // aí sim toca, imprime e (se estiver ligado) é aceito sozinho.
  const liberaAgendaMin = Number(empresa?.agendamento_libera_min ?? 45)
  const [ticAgenda, setTicAgenda] = useState(0)
  const agendadosPendentesRef = useRef(new Set())
  const ehAgendadoPendente = (p) => !!p?.agendado_para
    && !STATUS_FINALIZADOS.has(p.status)
    && aguardandoHora(p.agendado_para, liberaAgendaMin)

  // Relógio só enquanto existe agendado na tela.
  useEffect(() => {
    if (!pedidos.some(p => p.agendado_para)) return
    const id = setInterval(() => setTicAgenda(t => t + 1), 30000)
    return () => clearInterval(id)
  }, [pedidos])

  useEffect(() => {
    const pendentes = agendadosPendentesRef.current
    for (const p of pedidos) {
      if (!p.agendado_para) continue
      if (ehAgendadoPendente(p)) { pendentes.add(p.id); continue }
      // Só solta o que ESTAVA guardado nesta tela. Sem esse `has`, abrir o
      // painel no meio da tarde imprimiria de novo todo agendado do dia.
      if (!pendentes.has(p.id)) continue
      pendentes.delete(p.id)
      // O agendado já entra ACEITO (mig 0224), então aqui ele costuma estar em
      // 'confirmado' — e é assim mesmo que precisa imprimir. Só quem ainda está
      // 'aguardando' passa pelo aceite (manual ou automático).
      if (!['aguardando', 'confirmado'].includes(p.status)) continue
      if (deveAutoImprimir() && !fwcImprimeRef.current) autoImprimirPedido(p)
      iniciarLoopSom()
      if (p.status === 'aguardando' && aceitarAutoAtivo()) handleConfirmar(p.id, tempoPrevistoMin(p, empresa))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedidos, ticAgenda])

  function patchConfigLocal(patch) {
    try {
      const cfg = JSON.parse(localStorage.getItem('painelConfig') || '{}')
      Object.assign(cfg, patch)
      localStorage.setItem('painelConfig', JSON.stringify(cfg))
    } catch {
      localStorage.setItem('painelConfig', JSON.stringify(patch))
    }
  }
  function toggleAutoImprimir() {
    const novo = !autoImprimir
    setAutoImprimir(novo)
    patchConfigLocal({ autoImprimir: novo })
  }
  function toggleAceitarAuto() {
    const novo = !aceitarAuto
    setAceitarAuto(novo)
    patchConfigLocal({ aceitarAuto: novo })
  }

  async function handleImprimir(pedido) {
    // Sem o app FWC, a única saída é o navegador — mas aí o lojista
    // precisa SABER, senão ele aperta reimprimir, aparece a janela do Chrome
    // perguntando a impressora e ele conclui que o sistema está quebrado.
    const via = await imprimirCupom(pedido, empresa)
    if (via === 'navegador') {
      alert([
        'Não achei o app Impressora FWC neste computador.',
        '',
        'Abri a impressão pelo navegador. Se a térmica é a da loja, confira se o app',
        'Impressora FWC está aberto E LOGADO — sem login ele também não imprime sozinho.',
      ].join('\n'))
    }
  }

  // Impressão pela térmica Bluetooth do CELULAR (Web Bluetooth) — caminho
  // separado e isolado do sistema FWC. Carregado sob demanda (só quem usa).
  async function handleImprimirCelular(pedido) {
    try {
      const mod = await import('../utils/imprimirBluetooth')
      await mod.imprimirPedidoCelular(pedido, empresa)
    } catch (e) {
      alert('Impressora celular (Bluetooth): ' + (e?.message || e))
    }
  }

  // Auto-imprime um pedido novo. Se a térmica Bluetooth do CELULAR está conectada
  // (ou reconecta sozinha), imprime por ela e para aqui — assim o papel sai sozinho
  // sem precisar do botão 📱🖨️, e sem abrir o diálogo do navegador. Se não houver
  // Bluetooth (ex.: no PC), cai no caminho normal (app FWC → navegador).
  // Silencioso: no automático não mostra alerta se falhar (não atrapalha o painel).
  async function autoImprimirPedido(pedido) {
    try {
      const mod = await import('../utils/imprimirBluetooth')
      if (mod.estaConectada() || await mod.reconectarSilencioso()) {
        // Origem desligada NESTA impressora: não imprime aqui — e também não
        // cai no caminho de baixo, senão o "desligado" não desligaria nada.
        if (!mod.imprimeOrigem(pedido.origem)) return
        await mod.imprimirPedidoCelular(pedido, empresa)
        return
      }
    } catch { /* sem Bluetooth ou falhou — usa o caminho normal abaixo */ }
    imprimirCupom(pedido, empresa, { auto: true })
  }

  // Reimpressão MANUAL (botão 🖨️ dos pedidos finalizados). Igual ao auto, mas
  // mostra alerta se a Bluetooth falhar — é uma ação do usuário, ele quer saber.
  // No PC (sem Bluetooth) cai no caminho normal (app FWC → navegador).
  async function reimprimirPedido(pedido) {
    try {
      const mod = await import('../utils/imprimirBluetooth')
      if (mod.estaConectada() || await mod.reconectarSilencioso()) {
        await mod.imprimirPedidoCelular(pedido, empresa)
        return
      }
    } catch (e) {
      alert('Impressora celular (Bluetooth): ' + (e?.message || e))
      return
    }
    // Mesmo aviso do handleImprimir: cair no navegador em silêncio faz o
    // lojista achar que o botão ignorou a térmica da loja.
    const via = await imprimirCupom(pedido, empresa)
    if (via === 'navegador') {
      alert([
        'Não achei o app Impressora FWC neste computador.',
        '',
        'Abri a impressão pelo navegador. Se a térmica é a da loja, confira se o app',
        'Impressora FWC está aberto E LOGADO — sem login ele também não imprime sozinho.',
      ].join('\n'))
    }
  }

  // ── Religa a térmica Bluetooth assim que o gestor abre ────────────────────
  // Recarregar a página apaga a conexão BLE (ela vive na memória da aba). O
  // navegador ainda LEMBRA que este site pode falar com aquela impressora, então
  // dá pra religar sem pedir nada — mas alguém precisa mandar religar.
  //
  // Antes só o painel da Impressora fazia isso, e só se o dono abrisse aquela
  // aba. Quem dava F5 e ficava no Salão só descobria na hora de imprimir. Agora
  // a religada começa junto com o gestor, e o vigia do módulo assume daí.
  useEffect(() => {
    let sobrou = false
    try { sobrou = !!localStorage.getItem('bt_printer_id') } catch { /* ok */ }
    if (!sobrou) return
    import('../utils/imprimirBluetooth')
      .then(m => m.reconectarSilencioso())
      .catch(() => { /* sem Bluetooth neste aparelho */ })
  }, [])

  // ── Painel lateral direito (Impressora / Pedidos) ─────────
  // Lembra a seção aberta (ex.: Mesas) ao sair e voltar do gestor.
  const [painelDireito, setPainelDireito] = useState(() => {
    // 'pedidos' foi removido do rail — ignora valor antigo lembrado no navegador.
    try { const v = localStorage.getItem('gestor-painel-direito'); return v === 'pedidos' ? null : (v || null) } catch { return null }
  }) // null | 'impressora' | 'salao' | 'hoje' | 'chat' | 'catalogo' | 'entregadores'
  const [subAbaSalao, setSubAbaSalao] = useState(() => {
    try { return localStorage.getItem('gestor-subaba-salao') || 'salao' } catch { return 'salao' }
  }) // dentro de Mesas: 'salao' | 'reservas' | 'mesas'
  useEffect(() => {
    try { painelDireito ? localStorage.setItem('gestor-painel-direito', painelDireito) : localStorage.removeItem('gestor-painel-direito') } catch { /* ignore */ }
  }, [painelDireito])
  useEffect(() => {
    try { localStorage.setItem('gestor-subaba-salao', subAbaSalao) } catch { /* ignore */ }
  }, [subAbaSalao])
  const [larguraCupom, setLarguraCupom] = useState(() => {
    try { return JSON.parse(localStorage.getItem('painelConfig') || '{}').larguraCupom === '58mm' ? '58mm' : '80mm' }
    catch { return '80mm' }
  })
  const [somAtivo, setSomAtivo] = useState(somAtivoConfig)
  const [cupomCfg, setCupomCfg] = useState(() => {
    try { return JSON.parse(localStorage.getItem('painelConfig') || '{}').cupom || {} }
    catch { return {} }
  })
  const [historico, setHistorico] = useState([])
  const [loadingHist, setLoadingHist] = useState(false)
  // Concluídos do dia
  const [concluidosHoje, setConcluidosHoje] = useState([])
  const [mesasFechadasHoje, setMesasFechadasHoje] = useState([]) // G3: mesas com conta fechada hoje
  const [canceladosHoje, setCanceladosHoje] = useState([])
  const [loadingHoje, setLoadingHoje] = useState(false)
  // Entregadores — estatísticas e histórico por motoboy
  const [entregasConcluidas, setEntregasConcluidas] = useState([])
  const [entregadorSel, setEntregadorSel] = useState(null)
  const [periodoEnt, setPeriodoEnt] = useState('hoje') // filtro de data do histórico do entregador (começa em Hoje)
  // Filtro do quadro — null = todas as colunas; ou 'aceitar'|'cozinha'|'entrega'|'concluidos'
  // Persistem no localStorage: ao sair e voltar da tela, mantêm o filtro escolhido.
  const [filtroColuna, setFiltroColuna] = useState(() => {
    try { const v = localStorage.getItem('pp-filtro-coluna'); return v ? v : null } catch { return null }
  })
  const [filtroOrigem, setFiltroOrigem] = useState(() => {
    // 'mesa' saiu do total de pedidos (fica só na seção Mesas) — ignora filtro antigo salvo.
    try { const v = localStorage.getItem('pp-filtro-origem'); return (v && v !== 'mesa') ? v : null } catch { return null }
  }) // WhatsApp/App/iFood/Balcão/Cardápio; null = todas
  useEffect(() => {
    try { filtroColuna ? localStorage.setItem('pp-filtro-coluna', filtroColuna) : localStorage.removeItem('pp-filtro-coluna') } catch {}
  }, [filtroColuna])
  useEffect(() => {
    try { filtroOrigem ? localStorage.setItem('pp-filtro-origem', filtroOrigem) : localStorage.removeItem('pp-filtro-origem') } catch {}
  }, [filtroOrigem])
  // Busca de pedido pelo código/nº, código iFood, nome ou telefone do cliente
  const [buscaPedido, setBuscaPedido] = useState('')
  // Caixa de entrada (chat com clientes) — a loja responde aqui
  const [chatMsgs, setChatMsgs]       = useState([])
  const [chatAberto, setChatAberto]   = useState(null)   // "canal|cliente_ref"
  const [chatAviso, setChatAviso]     = useState(null)   // saiu no WhatsApp? (ver enviarChat)
  const [chatTexto, setChatTexto]     = useState('')
  const [enviandoChat, setEnviandoChat] = useState(false)
  // Robô pausado no número da conversa aberta? É o que decide mostrar o
  // "Devolver pro robô" dentro da conversa — depois de responder, o chamado
  // fecha e o card com os botões some, mas a conversa continua na tela.
  const telaGrande = useTelaGrande()
  const [botPausado, setBotPausado] = useState(false)
  // Sacola que o ATENDENTE monta dentro da conversa (ver SacolaNoChat).
  const [sacolaChat, setSacolaChat] = useState([])
  // Painel da sacola colado na conversa (só no PC).
  const [sacolaLateral, setSacolaLateral] = useState(false)
  const [enviandoSacola, setEnviandoSacola] = useState(false)
  const [salvandoPedidoChat, setSalvandoPedidoChat] = useState(false)
  // Cliente que pediu atendente no WhatsApp: o robô não inventa resposta, chama
  // gente. Toca AQUI, no gestor — é a tela que fica aberta no balcão.
  const { chamados, atender: atenderChamado, silenciados: chamadosSilenciados, silenciar: silenciarChamado } = useChamados(empresa?.id)
  // Catálogo (pausar/ativar itens da loja online)
  const [catalogo, setCatalogo] = useState([])
  const [complementosPorProduto, setComplementosPorProduto] = useState({}) // produtoId -> [grupos] (pausáveis)
  const [catExpandido, setCatExpandido] = useState(() => new Set())        // produtos com complementos abertos
  const [catCatsAbertas, setCatCatsAbertas] = useState(() => new Set())    // categorias abertas (nascem fechadas)
  const [loadingCatalogo, setLoadingCatalogo] = useState(false)
  const [buscaCatalogo, setBuscaCatalogo] = useState('')
  const [ordemCategorias, setOrdemCategorias] = useState({})
  const [pausandoId, setPausandoId] = useState(null)
  function patchPainelConfig(patch) {
    try {
      const cfg = JSON.parse(localStorage.getItem('painelConfig') || '{}')
      Object.assign(cfg, patch)
      localStorage.setItem('painelConfig', JSON.stringify(cfg))
    } catch {
      localStorage.setItem('painelConfig', JSON.stringify(patch))
    }
  }

  function escolherLargura(v) { setLarguraCupom(v); patchPainelConfig({ larguraCupom: v }) }
  function toggleSom() { const novo = !somAtivo; setSomAtivo(novo); patchPainelConfig({ somAtivo: novo }) }
  function setCupom(patch) {
    setCupomCfg(prev => {
      const novo = { ...prev, ...patch }
      patchPainelConfig({ cupom: novo })
      return novo
    })
  }

  function imprimirTeste() {
    imprimirCupom({
      numero_pedido: 'TESTE',
      created_at: new Date().toISOString(),
      tipo_entrega: 'entrega',
      cliente_nome: 'Cliente Teste',
      cliente_telefone: '(00) 00000-0000',
      endereco_rua: 'Rua Exemplo', endereco_numero: '123',
      endereco_bairro: 'Centro', endereco_cidade: 'Cidade',
      itens: [{ nome: 'Produto A', qtd: 2, preco: 5 }, { nome: 'Produto B', qtd: 1, preco: 3.5 }],
      subtotal: 13.5, taxa_entrega: 5, total: 18.5,
      forma_pagamento: 'dinheiro', troco_para: 50,
      observacoes: 'Cupom de teste de impressão', codigo_entrega: '0000',
    }, empresa)
  }

  // Gera e baixa um atalho .bat que abre o gestor no Chrome com impressão
  // silenciosa (--kiosk-printing). O cliente dá 2 cliques e imprime sozinho,
  // sem instalar nada e sem a janela de impressão travar.
  function baixarAtalhoImpressao() {
    const url = 'https://gestor.fwcinter.com/painel'
    const linhas = [
      '@echo off',
      'title Gestor FWC - impressao automatica',
      'rem Deixe a impressora termica como PADRAO no Windows. De 2 cliques neste atalho.',
      'set "PROF=%USERPROFILE%\\gestor-fwc"',
      'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" (',
      `  start "" "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing --user-data-dir="%PROF%" "${url}"`,
      ') else if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" (',
      `  start "" "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing --user-data-dir="%PROF%" "${url}"`,
      ') else (',
      `  start "" chrome --kiosk-printing --user-data-dir="%PROF%" "${url}"`,
      ')',
    ]
    const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'application/octet-stream' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = 'Gestor FWC - impressao automatica.bat'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(href)
  }

  const carregarHistorico = useCallback(async () => {
    if (!empresa) return
    setLoadingHist(true)
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('empresa_id', empresa.id)
      .in('status', ['entregue', 'cancelado'])
      .order('created_at', { ascending: false })
      .limit(40)
    setHistorico(data || [])
    setLoadingHist(false)
  }, [empresa])

  useEffect(() => {
    if (painelDireito === 'pedidos') carregarHistorico()
  }, [painelDireito, carregarHistorico])

  // ── Entregadores: entregas já concluídas (para contagem + histórico) ──
  const carregarEntregasConcluidas = useCallback(async () => {
    if (!empresa) return
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('id, numero_pedido, cliente_nome, total, taxa_entrega, forma_pagamento, pix_status, created_at, entregador_id, origem, endereco_bairro, endereco_cidade, entregador_pago, entregador_pago_em')
      .eq('empresa_id', empresa.id)
      .eq('status', 'entregue')
      .not('entregador_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500)
    setEntregasConcluidas(data ?? [])
  }, [empresa])

  // Marca corridas como PAGAS ao entregador (acerto da taxa). Otimista + persiste.
  async function pagarCorridas(ids) {
    if (!ids?.length) return
    const agora = new Date().toISOString()
    setEntregasConcluidas(prev => prev.map(p => (ids.includes(p.id) ? { ...p, entregador_pago: true, entregador_pago_em: agora } : p)))
    await supabase.from('pedidos_delivery').update({ entregador_pago: true, entregador_pago_em: agora }).in('id', ids)
  }

  useEffect(() => {
    if (painelDireito === 'entregadores') { setEntregadorSel(null); carregarEntregasConcluidas() }
  }, [painelDireito, carregarEntregasConcluidas])

  // ── Concluídos do dia (vendas finalizadas hoje) ─────────────
  const carregarConcluidosHoje = useCallback(async () => {
    if (!empresa) return
    setLoadingHoje(true)
    const inicio = new Date()
    inicio.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('empresa_id', empresa.id)
      .in('status', ['entregue', 'cancelado'])
      .gte('created_at', inicio.toISOString())
      .order('created_at', { ascending: false })
    const todos = data || []
    setConcluidosHoje(todos.filter(p => p.status === 'entregue'))
    setCanceladosHoje(todos.filter(p => p.status === 'cancelado'))

    // G3 — mesas (comandas) com conta fechada hoje também entram nos concluídos
    const { data: mesas } = await supabase
      .from('comandas')
      .select('id, numero_mesa, tipo, nome_cliente, total, forma_pagamento, fechada_at')
      .eq('empresa_id', empresa.id)
      .eq('status', 'fechada')
      .gte('fechada_at', inicio.toISOString())
      .order('fechada_at', { ascending: false })
    setMesasFechadasHoje(mesas ?? [])
    setLoadingHoje(false)
  }, [empresa])

  useEffect(() => {
    if (painelDireito === 'hoje') carregarConcluidosHoje()
  }, [painelDireito, carregarConcluidosHoje])

  // Carrega a coluna "Concluídos" do quadro assim que o painel abre
  useEffect(() => { carregarConcluidosHoje() }, [carregarConcluidosHoje])

  // ── Chat: carrega mensagens e escuta em tempo real ──────────
  useEffect(() => {
    if (!empresa) return
    let ativo = true
    ;(async () => {
      // Só as conversas de HOJE — as de dias anteriores não aparecem no gestor.
      const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0)

      // App e Loja Online: tudo. Ali o cliente não tem outro caminho pra falar
      // com a loja — se não aparecer aqui, não aparece em lugar nenhum.
      const { data: internas } = await supabase
        .from('mensagens_chat')
        .select('*')
        .eq('empresa_id', empresa.id)
        .neq('canal', 'whatsapp')
        .gte('created_at', inicioHoje.toISOString())
        .order('created_at', { ascending: true })
        .limit(500)

      // WhatsApp: só a conversa em que a LOJA falou.
      //
      // O WhatsApp da loja é atendido no celular dela (coexistência), e o CRM
      // só espelha o que ENTRA — a resposta que ela dá no aparelho não volta
      // pra cá. Espelhando tudo, a caixa virava mão única: na CDBom deu 476 não
      // lidas num dia, de gente que já tinha sido atendida. Pior: enchia o teto
      // da consulta e empurrava pra fora as mensagens do App e da Loja Online,
      // que são as que ninguém mais responde.
      //
      // Quando a loja escreve pelo gestor (o "Enviar mensagem" do pedido), a
      // conversa passa a aparecer — e as respostas do cliente vêm junto.
      const { data: daLoja } = await supabase
        .from('mensagens_chat')
        .select('cliente_ref')
        .eq('empresa_id', empresa.id)
        .eq('canal', 'whatsapp')
        .eq('remetente', 'loja')
        .gte('created_at', inicioHoje.toISOString())
        .limit(300)
      const refsAbertas = [...new Set((daLoja ?? []).map(r => r.cliente_ref).filter(Boolean))]
      let doZap = []
      if (refsAbertas.length) {
        const { data } = await supabase
          .from('mensagens_chat')
          .select('*')
          .eq('empresa_id', empresa.id)
          .eq('canal', 'whatsapp')
          .in('cliente_ref', refsAbertas)
          .gte('created_at', inicioHoje.toISOString())
          .order('created_at', { ascending: true })
          .limit(500)
        doZap = data ?? []
      }
      const todas = [...(internas ?? []), ...doZap]
        .sort((x, y) => new Date(x.created_at) - new Date(y.created_at))
      if (ativo) setChatMsgs(todas)
    })()
    const canal = supabase
      .channel(`chat_${empresa.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'mensagens_chat', filter: `empresa_id=eq.${empresa.id}` },
        payload => {
          if (payload.eventType === 'INSERT') {
            setChatMsgs(prev => prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new])
          } else if (payload.eventType === 'UPDATE') {
            setChatMsgs(prev => prev.map(m => m.id === payload.new.id ? payload.new : m))
          }
        })
      .subscribe()
    return () => { ativo = false; canal.unsubscribe() }
  }, [empresa])

  // Abre no gestor a conversa do número que pediu atendente. O casamento é
  // pelos 8 últimos dígitos porque o WhatsApp entrega o mesmo número com e sem
  // o 9 do celular — comparar inteiro não acha a conversa que existe.
  function abrirConversaDoChamado(phone) {
    const chave = String(phone || '').replace(/\D/g, '').slice(-8)
    const t = chatThreads.find(x => String(x.cliente_ref || '').replace(/\D/g, '').endsWith(chave))
    if (t) { abrirThread(t); return }
    // Sem conversa espelhada ainda: abre uma nova pra este número.
    setChatAberto(`whatsapp|${String(phone || '').replace(/\D/g, '')}`)
  }

  // Produto escolhido na busca: vira texto pronto na caixa de resposta, com
  // nome e preço EXATOS do cadastro. O atendente revisa e manda — e é esse nome
  // que o robô lê depois pra reconhecer o produto certo (ele passou a olhar
  // também o que a pessoa da loja escreveu).
  function escolherProdutoNoChat(p) {
    setSacolaLateral(true)
    setSacolaChat(prev => {
      const i = prev.findIndex(x => x.produto_id === p.id)
      if (i >= 0) {
        const copia = [...prev]
        const qtd = copia[i].qtd + 1
        copia[i] = { ...copia[i], qtd, preco: precoSacola(copia[i], qtd) }
        return copia
      }
      // Guarda o preço cheio e as faixas junto: é o que deixa a linha
      // recalcular sozinha quando a quantidade muda.
      const item = {
        produto_id: p.id, nome: p.nome, qtd: 1,
        precoBase: Number(p.preco) || 0,
        faixas_preco: p.faixas_preco ?? [],
        preco_promocional: p.preco_promocional ?? null,
      }
      return [...prev, { ...item, preco: precoSacola(item, 1) }]
    })
  }

  // Uma função só pros dois jeitos de mudar a quantidade: os botões +/− e o
  // campo onde se digita. Quem some é a linha que chegou a zero.
  function ajustarQtdSacola(idx, calcular) {
    setSacolaChat(prev => prev
      .map((it, i) => {
        if (i !== idx) return it
        const qtd = Math.max(0, Math.floor(Number(calcular(Number(it.qtd) || 0)) || 0))
        return { ...it, qtd, preco: precoSacola(it, qtd) }
      })
      .filter(it => it.qtd > 0))
  }
  const mudarQtdSacola   = (idx, delta) => ajustarQtdSacola(idx, q => q + delta)
  const definirQtdSacola = (idx, n)     => ajustarQtdSacola(idx, () => n)

  /**
   * Fecha o pedido pela própria conversa — sem passar pela tela de Vender.
   *
   * É o outro fim da sacola: em vez de devolver pro robô pedir endereço e
   * pagamento, quem está atendendo já tem essas duas coisas na conversa e
   * lança o pedido. Ele entra igual ao da tela de Vender (origem balcão, já
   * confirmado), então imprime, aparece pro entregador e conta no caixa do
   * mesmo jeito — o que muda é que ninguém digitou o pedido duas vezes.
   */
  async function finalizarPedidoDoChat(d) {
    if (!sacolaChat.length || !chatAberto || !empresa?.id) return
    const sep = chatAberto.indexOf('|')
    const canal = chatAberto.slice(0, sep)
    const cliente_ref = chatAberto.slice(sep + 1)
    const tel = String(cliente_ref).replace(/\D/g, '')
    setSalvandoPedidoChat(true)
    setChatAviso(null)

    const thread = chatMsgs.find(m => `${m.canal}|${m.cliente_ref}` === chatAberto)
    const nomeCliente = (d.nome || thread?.cliente_nome || '').trim() || 'Cliente do WhatsApp'

    // Cadastra/atualiza o cliente com o endereço — é o que faz o PRÓXIMO pedido
    // dele vir preenchido, aqui e na Loja Online.
    //
    // Quando o cliente JÁ existe, manda o telefone do jeito que está no
    // cadastro: o upsert casa por número exato, e o WhatsApp entrega com o 55
    // que o cadastro não tem. Mandar o do WhatsApp criava um segundo cadastro
    // pra mesma pessoa — e o endereço ia parar no cliente errado.
    let clienteId = d.cadastro?.id ?? null
    const telParaCadastro = d.cadastro?.telefone || tel
    if (tel.length >= 10) {
      try {
        const { data: cid } = await supabase.rpc('upsert_cliente_loja', {
          p_empresa_id: empresa.id, p_nome: nomeCliente, p_telefone: telParaCadastro,
          p_email: '', p_cep: d.cep?.trim() ?? '', p_endereco: d.rua?.trim() ?? '',
          p_numero: d.numero?.trim() ?? '', p_complemento: '',
          p_bairro: d.bairro?.trim() ?? '', p_cidade: d.cidade?.trim() ?? '', p_estado: '',
        })
        if (cid) clienteId = cid
      } catch { /* cadastro falhou: o pedido não pode morrer por isso */ }
    }

    const payload = {
      empresa_id: empresa.id,
      cliente_id: clienteId,
      cliente_nome: nomeCliente,
      cliente_telefone: tel || '—',
      tipo_entrega: d.tipo,
      origem: 'balcao',
      status: 'confirmado',      // quem atendeu já aceitou — não tem o que confirmar
      itens: sacolaChat.map(i => ({
        produto_id: i.produto_id ?? null, nome: i.nome, quantidade: i.qtd,
        preco_unitario: Number(i.preco), subtotal: Number(i.preco) * Number(i.qtd),
        complementos: [],
      })),
      subtotal: d.subtotal,
      taxa_entrega: d.tipo === 'entrega' ? d.taxa : 0,
      total: d.total,
      forma_pagamento: d.pagamento,
      troco_para: d.pagamento === 'dinheiro' && d.troco
        ? Math.round(parseFloat(String(d.troco).replace(',', '.')) * 100) / 100
        : null,
      // De onde este pedido veio fica escrito: daqui a uma semana ninguém lembra
      // que este foi montado na conversa, e o balcão vira uma caixa-preta.
      observacoes: [d.obs?.trim(), 'Montado na conversa do WhatsApp'].filter(Boolean).join(' · '),
    }
    if (d.tipo === 'entrega') {
      payload.endereco_rua = d.rua?.trim() || null
      payload.endereco_numero = d.numero?.trim() || null
      payload.endereco_bairro = d.bairro?.trim() || null
      payload.endereco_cidade = d.cidade?.trim() || null
      payload.endereco_cep = d.cep?.trim() || null
      // O ponto que o cliente apontou. Sem ele o app do entregador abre o TEXTO
      // do endereço no Google, que larga o pino no meio da rua.
      payload.endereco_lat = d.pino?.lat ?? null
      payload.endereco_lng = d.pino?.lng ?? null
    }

    const { data: novo, error } = await supabase.from('pedidos_delivery')
      .insert(payload).select('id, numero_pedido').maybeSingle()
    if (error) {
      setSalvandoPedidoChat(false)
      setChatAviso({ ok: false, txt: `⚠️ Não consegui lançar o pedido: ${error.message}` })
      return
    }

    // O carrinho do robô sai de cena: se ficasse lá, o robô fecharia um segundo
    // pedido com os mesmos itens na próxima mensagem do cliente.
    await supabase.from('whatsapp_carrinho').delete()
      .eq('empresa_id', empresa.id).like('phone', `%${tel.slice(-8)}`)

    // O cliente precisa ver o número do pedido — é por ele que ele cobra depois.
    const linhas = sacolaChat
      .map(i => `• ${i.nome} x${i.qtd} — R$ ${(Number(i.preco) * Number(i.qtd)).toFixed(2).replace('.', ',')}`)
      .join('\n')
    const labelPgto = ({ dinheiro: 'dinheiro', pix_entrega: 'PIX', credito: 'cartão de crédito', debito: 'cartão de débito', cartao: 'cartão' })[d.pagamento] ?? d.pagamento
    const texto =
      `🧾 *Pedido #${novo?.numero_pedido ?? ''} anotado!*\n\n${linhas}\n` +
      (d.tipo === 'entrega' ? `🛵 Taxa de entrega: R$ ${Number(d.taxa).toFixed(2).replace('.', ',')}\n` : '🏪 Retirada na loja\n') +
      `💰 *Total: R$ ${Number(d.total).toFixed(2).replace('.', ',')}*\n💳 Pagamento em *${labelPgto}*\n\nJá tá na cozinha. 😉`

    await supabase.from('mensagens_chat').insert({
      empresa_id: empresa.id, canal, cliente_ref,
      cliente_nome: thread?.cliente_nome ?? null, remetente: 'loja', texto,
    })
    let okZap = false
    if (tel.length >= 10) {
      const { data } = await supabase.functions.invoke('whatsapp-connect', {
        body: { action: 'send_message', phone: tel, text: texto, espelhar_no_chat: false, assumir_conversa: false },
      })
      okZap = !!data?.ok
    }

    setSacolaChat([])
    setSalvandoPedidoChat(false)
    setChatAviso({
      ok: true,
      txt: `✓ Pedido #${novo?.numero_pedido ?? ''} lançado no sistema.` +
        (okZap ? ' O cliente já recebeu o número no WhatsApp.' : ' ⚠️ Mas o aviso não saiu no WhatsApp do cliente.'),
    })
    carregarPedidos()
  }

  /**
   * Manda a sacola pro cliente e devolve a conversa pro robô.
   *
   * Três coisas de uma vez, e a ordem importa: o cliente vê a lista com preços,
   * o carrinho do robô passa a ter esses itens (senão ele fecharia um pedido
   * vazio) e a pausa sai, pra ele continuar em endereço e pagamento.
   */
  async function enviarSacolaDoChat() {
    if (!sacolaChat.length || !chatAberto || !empresa?.id) return
    const sep = chatAberto.indexOf('|')
    const canal = chatAberto.slice(0, sep)
    const cliente_ref = chatAberto.slice(sep + 1)
    const tel = String(cliente_ref).replace(/\D/g, '')
    setEnviandoSacola(true)
    setChatAviso(null)

    const total = sacolaChat.reduce((s, i) => s + Number(i.preco) * Number(i.qtd), 0)
    const linhas = sacolaChat
      .map(i => `• ${i.nome} x${i.qtd} — R$ ${(Number(i.preco) * Number(i.qtd)).toFixed(2).replace('.', ',')}`)
      .join('\n')
    const texto = `Montei sua sacola aqui 🛒\n\n${linhas}\n\n*Total dos itens: R$ ${total.toFixed(2).replace('.', ',')}*\n\nÉ só me confirmar o endereço e a forma de pagamento que eu fecho pra você. 😉`

    // 1) O carrinho do robô. Sem isso ele fecharia o pedido sem os itens.
    const { error: errCarrinho } = await supabase.from('whatsapp_carrinho')
      .upsert({
        empresa_id: empresa.id, phone: tel,
        items: sacolaChat.map(i => ({ produto_id: i.produto_id, nome: i.nome, qtd: i.qtd, preco: Number(i.preco) })),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'empresa_id,phone' })

    // 2) A mensagem pro cliente (chat do gestor + WhatsApp).
    const thread = chatMsgs.find(m => `${m.canal}|${m.cliente_ref}` === chatAberto)
    await supabase.from('mensagens_chat').insert({
      empresa_id: empresa.id, canal, cliente_ref,
      cliente_nome: thread?.cliente_nome ?? null, remetente: 'loja', texto,
    })
    let okZap = false
    if (tel.length >= 10) {
      // Mandar a sacola NÃO devolve a conversa (era o que este botão fazia, e
      // eram duas coisas num clique só). Quem está atendendo pode querer mandar
      // a lista e continuar falando — combinar a troca de um item, avisar que
      // acabou um sabor. Devolver pro robô virou decisão à parte, no botão que
      // já existe pra isso, na barra roxa.
      //
      // assumir_conversa também fica FALSE: a conversa já é de quem está aqui,
      // e pausar de novo só reiniciaria o relógio das 12h sem motivo.
      const { data } = await supabase.functions.invoke('whatsapp-connect', {
        body: { action: 'send_message', phone: tel, text: texto, espelhar_no_chat: false, assumir_conversa: false },
      })
      okZap = !!data?.ok
    }

    setSacolaChat([])
    setEnviandoSacola(false)
    setChatAviso(errCarrinho
      ? { ok: false, txt: '⚠️ A lista foi enviada, mas não consegui gravar o carrinho: ' + errCarrinho.message }
      : { ok: true, txt: okZap
          ? '✓ Sacola enviada. Você continua na conversa — devolva pro robô quando quiser.'
          : '⚠️ Sacola gravada aqui, mas não saiu no WhatsApp do cliente.' })
  }

  // Devolve a conversa pro robô sem sair dela: tira a pausa automática e ele
  // volta a responder aquele número, já tendo lido o que a pessoa escreveu.
  async function devolverConversaAoRobo() {
    const sep = chatAberto?.indexOf('|') ?? -1
    const tel = sep >= 0 ? String(chatAberto.slice(sep + 1)).replace(/\D/g, '') : ''
    if (!tel || !empresa?.id) return
    await supabase.from('whatsapp_bot_pausado')
      .delete().eq('empresa_id', empresa.id)
      .like('phone', `%${tel.slice(-8)}`)
      .not('expira_em', 'is', null)
    setBotPausado(false)
    setChatAviso({ ok: true, txt: '🤖 Robô de volta nesta conversa — ele continua de onde você parou.' })
  }

  // Marca como lidas as mensagens do cliente ao abrir a conversa, e envia resposta
  async function abrirThread(t) {
    setChatAberto(t.key)
    setSacolaChat([])   // sacola é daquela conversa, não segue pra próxima
    setSacolaLateral(false)
    const tel = String(t.cliente_ref || '').replace(/\D/g, '')
    setBotPausado(false)
    if (tel.length >= 8 && empresa?.id) {
      // Casa pelos 8 últimos dígitos: o mesmo número aparece com e sem o 9.
      const { data } = await supabase.from('whatsapp_bot_pausado')
        .select('phone, expira_em').eq('empresa_id', empresa.id)
        .like('phone', `%${tel.slice(-8)}`).limit(5)
      const agora = Date.now()
      setBotPausado((data ?? []).some(l => !l.expira_em || new Date(l.expira_em).getTime() > agora))
    }
    const naoLidas = t.msgs.filter(m => m.remetente === 'cliente' && !m.lida).map(m => m.id)
    if (naoLidas.length) {
      setChatMsgs(prev => prev.map(m => naoLidas.includes(m.id) ? { ...m, lida: true } : m))
      await supabase.from('mensagens_chat').update({ lida: true }).in('id', naoLidas)
    }
  }
  async function enviarChat() { return enviarChatTexto(chatTexto) }

  // Pede o pininho do WhatsApp (mig 0238). É o caminho mais curto de todos: o
  // cliente toca no clipe → Localização, e o ponto exato chega sozinho — sem
  // link, sem digitar endereço, sem o buscador de mapa chutar nada.
  async function pedirLocalizacaoNoChat() {
    await enviarChatTexto(
      'Pra entrega chegar certinho, me manda sua localização? 📍\n\n' +
      'É rapidinho: toque no *clipe* (📎) aqui embaixo → *Localização* → ' +
      '*Enviar sua localização atual*. Assim o entregador vai direto na sua porta. 🙂'
    )
  }

  // Localização que o cliente mandou → vira o endereço + o ponto dele.
  const [locUsar, setLocUsar] = useState(null) // { lat, lng, telefone, nome }
  // Sobe de 1 quando o cadastro do cliente muda por aqui (a localização virou
  // endereço). O "Fechar o pedido" lê o cadastro uma vez, na abertura — sem
  // este aviso ele continuava mostrando "Falta o endereço da entrega" com o
  // endereço já salvo do lado, e não dava pra fechar o pedido.
  const [cadastroVersao, setCadastroVersao] = useState(0)

  // Manda um texto pela conversa aberta. O "Enviar" usa o que está digitado;
  // outros botões (pedir localização, por exemplo) mandam texto pronto — e
  // todos passam pelo mesmo caminho: grava aqui, manda no WhatsApp, pausa o
  // robô. Duplicar isso é como a loja acaba respondendo em dois lugares.
  async function enviarChatTexto(bruto) {
    const txt = String(bruto ?? '').trim()
    if (!txt || !chatAberto) return
    const sep = chatAberto.indexOf('|')
    const canal = chatAberto.slice(0, sep)
    const cliente_ref = chatAberto.slice(sep + 1)
    const thread = chatMsgs.find(m => `${m.canal}|${m.cliente_ref}` === chatAberto)
    setEnviandoChat(true)
    setChatAviso(null)
    const { error } = await supabase.from('mensagens_chat').insert({
      empresa_id: empresa.id, canal, cliente_ref,
      cliente_nome: thread?.cliente_nome ?? null, remetente: 'loja', texto: txt,
    })
    if (error) { setEnviandoChat(false); return }
    if (txt === chatTexto.trim()) setChatTexto('')

    // A mesma resposta vai também pro WhatsApp dele. O chat do link só aparece
    // pra quem está com a página aberta: quem pediu e fechou o navegador nunca
    // ficava sabendo, e do lado da loja parecia respondido.
    //
    // O `cliente_ref` do chat É o telefone. Sem telefone (conversa antiga, ou
    // canal app sem cadastro) não dá pra mandar — aí fica só no link mesmo, e a
    // tela diz isso em vez de deixar a loja achando que o cliente foi avisado.
    const tel = String(cliente_ref || '').replace(/\D/g, '')
    if (tel.length >= 10) {
      const { data, error: errZap } = await supabase.functions.invoke('whatsapp-connect', {
        // Gente digitou: o robô cala nesse número por umas horas (mig 0228).
        body: { action: 'send_message', phone: tel, text: txt, espelhar_no_chat: false, assumir_conversa: true },
      })
      setChatAviso(data?.ok
        ? { ok: true, txt: '✓ Enviado aqui e no WhatsApp do cliente.' }
        : { ok: false, txt: '⚠️ Ficou só aqui no link — no WhatsApp não foi: ' + (data?.erro || errZap?.message || 'WhatsApp da loja desconectado.') })
      // Respondeu = assumiu, e isso NÃO depende de o WhatsApp ter aceitado a
      // mensagem. O alarme tocando enquanto a pessoa digita a resposta é o
      // jeito mais rápido de ela desligar o som — e aí ela perde os chamados de
      // verdade. Se o envio falhou, o aviso acima já diz; o sino não tem nada a
      // ver com isso.
      const chamado = chamados.find(c => String(c.phone).replace(/\D/g, '').endsWith(tel.slice(-8)))
      if (chamado) await atenderChamado(chamado.id)
      // E o robô sai de cena enquanto a pessoa atende. Quem faz isso de dentro
      // do whatsapp-connect é o envio bem-sucedido; aqui a gente garante o
      // mesmo mesmo quando o WhatsApp da loja está fora do ar.
      if (empresa?.id) {
        await supabase.from('whatsapp_bot_pausado').upsert({
          empresa_id: empresa.id, phone: tel,
          pausado_em: new Date().toISOString(),
          expira_em: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
          motivo: 'loja assumiu a conversa',
        }, { onConflict: 'empresa_id,phone' })
      }
      setBotPausado(true)
    } else {
      setChatAviso({ ok: false, txt: 'ℹ️ Esta conversa não tem telefone — a resposta fica só no link da loja.' })
    }
    setEnviandoChat(false)
  }

  // ── Catálogo: carrega os produtos da loja ───────────────────
  const carregarCatalogo = useCallback(async () => {
    if (!empresa) return
    setLoadingCatalogo(true)
    const { data } = await supabase
      .from('produtos')
      .select('id, nome, preco_venda, categoria, disponivel_delivery')
      .eq('empresa_id', empresa.id)
      .is('arquivado_em', null)
      .order('nome', { ascending: true })
    setCatalogo(data || [])
    // A ordem das categorias é a MESMA do cardápio (tabela categorias). Ordenar
    // por nome aqui deixaria a lista do painel numa ordem e a da loja em outra —
    // e quem pausa item procura pela ordem que conhece.
    const { data: cats } = await supabase
      .from('categorias').select('nome, ordem').eq('empresa_id', empresa.id)
    setOrdemCategorias(Object.fromEntries((cats ?? []).map(c => [c.nome, Number(c.ordem ?? 0)])))
    // Complementos aninhados por produto (estilo iFood): cada produto abre seus
    // grupos ("subcategorias") e opções, cada um pausável individualmente.
    const { data: vinc } = await supabase
      .from('produto_complemento_grupos')
      .select('produto_id, ordem, min_override, max_override, complemento_grupos(id, nome, min, max, disponivel, regra_preco, complemento_opcoes(id, nome, preco_adicional, disponivel, ordem)), produtos!inner(empresa_id)')
      .eq('produtos.empresa_id', empresa.id)
      .order('ordem')
    const porProduto = {}
    for (const v of (vinc ?? [])) {
      const g = v.complemento_grupos
      if (!g) continue
      const opcoes = (g.complemento_opcoes ?? [])
        .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
      ;(porProduto[v.produto_id] ??= []).push({
        id: g.id, nome: g.nome, min: v.min_override ?? g.min ?? 0, max: v.max_override ?? g.max ?? 1, ordem: v.ordem ?? 0,
        regra_preco: g.regra_preco ?? 'somar', disponivel: g.disponivel !== false, opcoes,
      })
    }
    for (const pid in porProduto) porProduto[pid].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
    setComplementosPorProduto(porProduto)
    setLoadingCatalogo(false)
  }, [empresa])

  function toggleExpandirCat(produtoId) {
    setCatExpandido(prev => {
      const n = new Set(prev)
      n.has(produtoId) ? n.delete(produtoId) : n.add(produtoId)
      return n
    })
  }

  // Categorias nascem fechadas: numa loja com 200 produtos o lojista rolava a
  // lista inteira pra achar o item. Abre só a que ele clicar.
  function toggleCategoriaCat(categoria) {
    setCatCatsAbertas(prev => {
      const n = new Set(prev)
      n.has(categoria) ? n.delete(categoria) : n.add(categoria)
      return n
    })
  }

  useEffect(() => {
    if (painelDireito === 'catalogo') carregarCatalogo()
  }, [painelDireito, carregarCatalogo])

  // Pausa/reativa uma opção de complemento (ex.: "Frango Assado" acabou).
  async function togglePausarOpcao(produtoId, grupoId, op) {
    const novo = op.disponivel === false // se está pausada, reativa
    setPausandoId(op.id)
    const patch = (val) => setComplementosPorProduto(prev => ({
      ...prev,
      [produtoId]: (prev[produtoId] ?? []).map(g => g.id !== grupoId ? g : {
        ...g, opcoes: g.opcoes.map(o => o.id === op.id ? { ...o, disponivel: val } : o),
      }),
    }))
    patch(novo)
    const { error } = await supabase.from('complemento_opcoes').update({ disponivel: novo }).eq('id', op.id)
    setPausandoId(null)
    if (error) patch(op.disponivel)
  }

  // Pausa/reativa a subcategoria inteira (ex.: acabou o feijão → some o grupo todo).
  async function togglePausarGrupo(produtoId, grupo) {
    const novo = grupo.disponivel === false // se está pausado, reativa
    setPausandoId(grupo.id)
    const patch = (val) => setComplementosPorProduto(prev => ({
      ...prev,
      [produtoId]: (prev[produtoId] ?? []).map(g => g.id === grupo.id ? { ...g, disponivel: val } : g),
    }))
    patch(novo)
    const { error } = await supabase.from('complemento_grupos').update({ disponivel: novo }).eq('id', grupo.id)
    setPausandoId(null)
    if (error) patch(grupo.disponivel)
  }

  // Pausa/reativa um item — pausado some da loja online na hora.
  async function togglePausarProduto(prod) {
    const novo = !prod.disponivel_delivery
    setPausandoId(prod.id)
    setCatalogo(prev => prev.map(p => p.id === prod.id ? { ...p, disponivel_delivery: novo } : p))
    const { error } = await supabase
      .from('produtos')
      .update({ disponivel_delivery: novo })
      .eq('id', prod.id)
    setPausandoId(null)
    if (error) {
      // reverte em caso de falha
      setCatalogo(prev => prev.map(p => p.id === prod.id ? { ...p, disponivel_delivery: prod.disponivel_delivery } : p))
    }
  }

  // ── Ref para o intervalo do loop de som ───────────────────
  const somLoopRef = useRef(null)

  function iniciarLoopSom() {
    if (!somAtivoConfig()) return
    if (somLoopRef.current) return // já rodando
    tocarSom()
    somLoopRef.current = setInterval(tocarSom, 3000)
  }

  function pararLoopSom() {
    if (somLoopRef.current) {
      clearInterval(somLoopRef.current)
      somLoopRef.current = null
    }
  }

  // ── Atualiza <title> com contagem ──────────────────────────
  const total = pedidos.length
  useEffect(() => {
    document.title = total > 0 ? `(${total}) Gestor` : 'Gestor'
    return () => { document.title = 'CRM' }
  }, [total])

  // ── Para o loop de som quando não há mais pedidos aguardando ─
  useEffect(() => {
    const temAguardando = pedidos.some(p => p.status === 'aguardando')
    if (!temAguardando) {
      pararLoopSom()
    }
  }, [pedidos]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sincroniza estado de loja com empresa ─────────────────
  useEffect(() => {
    if (empresa) setLojaAberta(empresa.delivery_ativo ?? false)
  }, [empresa])

  // Feriados/folgas da loja: entram na conta do "auto-fecha pelo horário" logo abaixo.
  useEffect(() => {
    if (!empresa?.id) return
    let vivo = true
    carregarExcecoes(supabase, empresa.id).then(e => { if (vivo) setExcecoesLoja(e) })
    return () => { vivo = false }
  }, [empresa?.id])

  // ── Auto-fecha pelo horário de funcionamento ───────────────
  useEffect(() => {
    if (!empresa) return
    function verificarHorario() {
      if (!lojaAbertaPorHorario(empresa, excecoesLoja)) {
        setLojaAberta(prev => {
          if (prev) {
            supabase.from('empresas').update({ delivery_ativo: false }).eq('id', empresa.id).then(() => {})
          }
          return false
        })
      }
    }
    verificarHorario()
    const id = setInterval(verificarHorario, 60_000)
    return () => clearInterval(id)
    // excecoesLoja entra na lista: elas chegam depois da empresa e mudam a resposta
    // (num feriado marcado, o auto-fecha só age quando a lista já carregou).
  }, [empresa, excecoesLoja]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Heartbeat: sinaliza que o painel está online ───────────
  // Atualiza last_heartbeat_at a cada 60s enquanto a aba estiver aberta.
  // O portal mostra "Aberta" só se o heartbeat chegou há menos de 2 min.
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

  // ── Busca inicial: todos os pedidos ativos (não finalizados) ──
  // Esta função roda MUITO: na abertura, a cada 30s no polling, toda vez que o
  // dono volta pra aba e sempre que o realtime reconecta. Só a PRIMEIRA carga
  // de cada loja mostra o esqueleto; as outras trocam os dados por baixo, com
  // o quadro no lugar. Antes ela acendia o esqueleto sempre, então o painel
  // piscava inteiro de 30 em 30 segundos e a cada volta pra tela — parecia
  // que o sistema tinha recarregado sozinho.
  const carregadoDe = useRef(null)
  const carregarPedidos = useCallback(async () => {
    if (!empresa) return
    if (carregadoDe.current !== empresa.id) setCarregando(true)
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('empresa_id', empresa.id)
      .not('status', 'in', '("entregue","cancelado","aguardando_pagamento")')
      .order('created_at', { ascending: true }) // mais antigos primeiro — urgência visual natural
    setPedidos(data || [])
    carregadoDe.current = empresa.id
    setCarregando(false)
  }, [empresa])

  // Carrega os entregadores da loja (para atribuir aos pedidos)
  useEffect(() => {
    if (!empresa) return
    supabase
      .from('profiles')
      .select('id, nome, entregador_desconto_ativo, entregador_desconto_valor')
      .eq('empresa_id', empresa.id)
      .eq('perfil', 'entregador')
      .eq('ativo', true)
      .order('nome')
      .then(({ data }) => setEntregadores(data || []))
  }, [empresa])

  // Pré-aquece o catálogo (produtos + complementos) pro modal de venda/edição
  // abrir instantâneo, sem o "Carregando produtos..." aparecer.
  useEffect(() => {
    if (empresa?.id) carregarCatalogo(empresa.id).catch(() => {})
  }, [empresa])

  // Mesas abertas (autoatendimento por QR) — o gestor vê os pedidos das mesas
  // no quadro, junto com delivery/iFood, com o nome da mesa.
  useEffect(() => {
    if (!empresa?.id) return
    let ativo = true
    async function carregarComandas() {
      const { data } = await supabase
        .from('comandas')
        .select('id, numero_mesa, tipo, nome_cliente, created_at, status, fechamento_pendente, preconta_pedida_em, fechada_por, comanda_itens(id, nome, quantidade, preco_unitario, status, observacao, setor, isento_taxa)')
        .eq('empresa_id', empresa.id)
        .in('status', ['aberta', 'aguardando_conferencia'])
        .order('numero_mesa')
      const lista = data ?? []
      // Conta da mesa: o garçom fecha no celular (sem impressora) e a mesa vira
      // "aguardando_conferencia". É AQUI, no gestor da loja (com a térmica/app FWC),
      // que a conta sai impressa. Dedupe por id; na 1ª carga não imprime as antigas.
      // Imprime se HÁ como imprimir: app FWC ativo OU auto do navegador ligado —
      // a conta não tem impressão pelo app (ele não escuta status da comanda), então
      // quem dispara é sempre o gestor (imprimirHtml roteia pro app ou navegador).
      // Pré-conta pedida pelo garçom (mig 0186): o celular dele não tem
      // impressora, então ele carimba a comanda e QUEM TIRA O PAPEL É AQUI.
      // Só carimbo posterior à abertura desta tela — senão, a cada F5 sairia de
      // novo a pré-conta de todas as mesas do dia.
      for (const c of lista) {
        if (!c.preconta_pedida_em) continue
        const quando = new Date(c.preconta_pedida_em).getTime()
        if (!Number.isFinite(quando) || quando < abertoEmRef.current) continue
        if (precontaFeitaRef.current.get(c.id) === quando) continue
        precontaFeitaRef.current.set(c.id, quando)
        imprimirPreContaMesa(c)
      }

      const aguardando = lista.filter(c => c.status === 'aguardando_conferencia')
      const primeira = contaMesaImpressaRef.current === null
      if (primeira) contaMesaImpressaRef.current = new Set()
      // `conta_impressa` = quem fechou já imprimiu a conta na própria tela do Salão.
      // Sem isso, com o painel aberto noutra aba, sairiam duas vias da mesma conta.
      const novas = aguardando.filter(c => !contaMesaImpressaRef.current.has(c.id) && !c.fechamento_pendente?.conta_impressa)
      novas.forEach(c => contaMesaImpressaRef.current.add(c.id))
      if (!primeira && (fwcImprimeRef.current || deveAutoImprimir())) novas.forEach(imprimirContaMesa)
      if (ativo) setComandas(lista)
    }
    carregarComandas()
    const ch = supabase
      .channel(`painel_comandas_${empresa.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comandas', filter: `empresa_id=eq.${empresa.id}` }, carregarComandas)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_itens', filter: `empresa_id=eq.${empresa.id}` }, (payload) => {
        carregarComandas()
        if (payload.eventType === 'INSERT') agendarImpressaoMesa(payload.new)
      })
      .subscribe()
    const id = setInterval(carregarComandas, 30_000)
    return () => { ativo = false; ch.unsubscribe(); clearInterval(id) }
  }, [empresa])

  // Marcar itens da mesa como prontos direto pelo gestor (pra quem não usa a
  // Cozinha/KDS — já imprime tudo). O cliente é avisado igual (acompanha no cel).
  async function handleMesaPronto(comanda) {
    const ids = (comanda.comanda_itens ?? [])
      .filter(it => it.status !== 'pronto' && it.status !== 'entregue').map(it => it.id)
    if (!ids.length) return
    setComandas(cs => cs.map(c => c.id === comanda.id
      ? { ...c, comanda_itens: (c.comanda_itens ?? []).map(it => ids.includes(it.id) ? { ...it, status: 'pronto' } : it) }
      : c))
    await supabase.from('comanda_itens').update({ status: 'pronto' }).in('id', ids)
  }
  async function handleMesaItemPronto(comanda, item) {
    setComandas(cs => cs.map(c => c.id === comanda.id
      ? { ...c, comanda_itens: (c.comanda_itens ?? []).map(it => it.id === item.id ? { ...it, status: 'pronto' } : it) }
      : c))
    await supabase.from('comanda_itens').update({ status: 'pronto' }).eq('id', item.id)
  }
  // ADM ajusta o preço de UM item da comanda (ex.: açaí no peso, que só tem valor
  // depois de pesar). Grava direto no comanda_itens — total do card e da conta
  // recalculam sozinhos. Só admin/super_admin (podeFinanceiro).
  async function handleEditarPrecoMesaItem(comanda, item, novoPreco) {
    const preco = Math.max(0, Math.round(Number(novoPreco) * 100) / 100)
    if (!Number.isFinite(preco)) return
    setComandas(cs => cs.map(c => c.id === comanda.id
      ? { ...c, comanda_itens: (c.comanda_itens ?? []).map(it => it.id === item.id ? { ...it, preco_unitario: preco } : it) }
      : c))
    const { error } = await supabase.from('comanda_itens').update({ preco_unitario: preco }).eq('id', item.id)
    if (error) alert('Erro ao salvar o preço: ' + error.message)
  }

  // Auto-imprime o pedido da mesa (comanda). Junta os itens que chegam quase
  // juntos (mesmo envio do cliente) num cupom só, com pequeno atraso.
  function agendarImpressaoMesa(item) {
    // Se o app FWC está ativo, ELE imprime a mesa sozinho (escuta comanda_itens).
    // O navegador só imprime mesa quando o app não está no comando (evita 2 vias).
    // A tela do Salão já imprimiu estes itens na térmica deste aparelho, na hora
    // do envio. Sem esta marca sairiam duas vias da mesma comanda.
    const jaSaiu = window.__fwcMesaImpressa
    if (jaSaiu?.has(item.id)) { jaSaiu.delete(item.id); return }
    if (!deveAutoImprimir() || fwcImprimeRef.current || (item.status && item.status !== 'pendente')) return
    const cid = item.comanda_id
    const buf = mesaPrintRef.current
    if (!buf[cid]) buf[cid] = { itens: [], timer: null }
    buf[cid].itens.push(item)
    clearTimeout(buf[cid].timer)
    buf[cid].timer = setTimeout(() => flushImpressaoMesa(cid), 1500)
  }
  // Dados extras pro cabeçalho da comanda da cozinha (salão, atendente, pessoas, rodapé).
  async function infoComandaCozinha(cid) {
    const info = { numero: '?', rotulo: '', area: '', atendente: '', pessoas: 0, rodape: empresa?.rodape_cozinha || '' }
    try {
      const { data: c } = await supabase.from('comandas').select('numero_mesa, tipo, nome_cliente, num_pessoas, garcom_id, mesa_id').eq('id', cid).maybeSingle()
      if (c) {
        if (c.numero_mesa != null) info.numero = c.numero_mesa
        info.rotulo = rotuloComanda(c)
        info.pessoas = c.num_pessoas || 0
        if (c.garcom_id) { const { data: g } = await supabase.from('profiles').select('nome').eq('id', c.garcom_id).maybeSingle(); if (g?.nome) info.atendente = String(g.nome).split(' ')[0] }
        if (c.mesa_id) { const { data: m } = await supabase.from('mesas').select('nome').eq('id', c.mesa_id).maybeSingle(); if (m?.nome) info.area = m.nome }
      }
      if (!info.rodape && empresa?.id) { const { data: e } = await supabase.from('empresas').select('rodape_cozinha').eq('id', empresa.id).maybeSingle(); if (e?.rodape_cozinha) info.rodape = e.rodape_cozinha }
    } catch (e) { /* segue com o que tiver */ }
    return info
  }

  // Se a térmica Bluetooth do celular estiver ligada, é ELA quem imprime.
  // Só o delivery passava por aqui: a loja que imprime pelo celular não recebia
  // comanda de mesa nenhuma, porque o caminho de mesa ia direto pro app FWC /
  // navegador — que no celular não existe. Devolve true se a Bluetooth deu conta.
  async function viaBluetooth(tipo, dados) {
    try {
      const mod = await import('../utils/imprimirBluetooth')
      if (!mod.imprimeOrigem('mesa')) return mod.estaConectada()   // desligado aqui: assunto encerrado
      return await mod.imprimirMesaSeConectada(tipo, dados)
    } catch { return false }   // sem Bluetooth neste aparelho
  }

  async function flushImpressaoMesa(cid) {
    const entry = mesaPrintRef.current[cid]
    delete mesaPrintRef.current[cid]
    if (!entry?.itens?.length) return
    const info = await infoComandaCozinha(cid)
    const dados = {
      numeroMesa: info.numero, rotulo: info.rotulo,
      nomeLoja: empresa?.nome,
      area: info.area, atendente: info.atendente, pessoas: info.pessoas, rodape: info.rodape,
      itens: entry.itens.map(i => ({ nome: i.nome, quantidade: i.quantidade, observacao: i.observacao, setor: i.setor })),
    }
    if (await viaBluetooth('comanda', dados)) return
    // "Não imprime" vale em qualquer impressora, não só na Bluetooth: a loja
    // disse que ali não precisa de papel.
    const paraPapel = dados.itens.filter(i => i.setor !== 'nenhum')
    if (!paraPapel.length) return
    imprimirHtml(montarComandaCozinhaHtml({ ...dados, itens: paraPapel }))
  }

  // A CONTA da mesa também respeita o filtro "Mesa" deste PC: se a Mesa está
  // DESLIGADA aqui, este PC não imprime nem a comanda da cozinha nem a conta.
  // (fwcFiltros null = sem filtro = imprime tudo, como antes.)
  // Pré-conta pedida do celular do garçom: guarda o que já saiu (por comanda e
  // por carimbo) pra não repetir a cada recarga da lista, que roda de 30 em 30s.
  const precontaFeitaRef = useRef(new Map())
  const abertoEmRef = useRef(Date.now())

  async function imprimirPreContaMesa(c) {
    const itens = Array.isArray(c.comanda_itens) ? c.comanda_itens : []
    if (!itens.length) return
    const subtotal = itens.reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
    const pct = Number(empresa?.taxa_servico_pct ?? 0)
    const taxa = calcularTaxa(itens, pct, true)
    const dados = {
      numeroMesa: c.numero_mesa, rotulo: rotuloComanda(c),
      itens, subtotal, taxa, total: subtotal + taxa,
      // Pré-conta não fala em pagamento: a mesa ainda vai escolher.
      formaPagamento: '', pagamentos: [], empresa, preConta: true,
    }
    if (await viaBluetooth('conta', dados)) return
    imprimirHtml(montarContaPresencialHtml(dados), empresa?.nome, { origem: 'mesa' })
  }

  // Recebe os DADOS da conta (não o HTML pronto): a Bluetooth monta em ESC/POS,
  // o app FWC / navegador monta em HTML. Cada um no seu formato.
  async function imprimirContaSeMesa(dados, titulo) {
    if (fwcFiltros?.mesa === false) return
    if (await viaBluetooth('conta', dados)) return
    imprimirHtml(montarContaPresencialHtml(dados), titulo, { origem: 'mesa' }) // o app também filtra por origem
  }

  // Imprime a CONTA da mesa na loja (chamado quando o garçom fecha e a mesa entra em
  // "aguardando_conferencia"). Total/forma vêm do fechamento_pendente que o garçom lançou.
  function imprimirContaMesa(c) {
    const itens = Array.isArray(c.comanda_itens) ? c.comanda_itens : []
    const subtotal = itens.reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
    const pend = c.fechamento_pendente || {}
    const pagamentos = Array.isArray(pend.pagamentos) ? pend.pagamentos : []
    const total = pagamentos.length ? pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0) : subtotal
    const taxa = Math.max(0, Math.round((total - subtotal) * 100) / 100)
    const forma = pagamentos.length > 1 ? 'Dividido' : (pagamentos[0]?.forma ?? '')
    imprimirContaSeMesa({
      numeroMesa: c.numero_mesa, rotulo: rotuloComanda(c), itens, subtotal, taxa, total, formaPagamento: forma, pagamentos, empresa,
    }, empresa?.nome)
  }

  // Impressão MANUAL da CONTA (botão no card, mesa aguardando conferência).
  // Aqui NÃO passa pelo filtro nem pela detecção do app: quem clicou quer o papel
  // agora. Vai por onde der — app FWC ou navegador. É a rede de segurança pra
  // quando a conta automática não sai e a loja fica sem saber.
  async function handleImprimirContaMesa(c) {
    const itens = Array.isArray(c.comanda_itens) ? c.comanda_itens : []
    const subtotal = itens.reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
    const pend = c.fechamento_pendente || {}
    const pagamentos = Array.isArray(pend.pagamentos) ? pend.pagamentos : []
    const total = pagamentos.length ? pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0) : subtotal
    const taxa = Math.max(0, Math.round((total - subtotal) * 100) / 100)
    const forma = pagamentos.length > 1 ? 'Dividido' : (pagamentos[0]?.forma ?? '')
    const dados = {
      numeroMesa: c.numero_mesa, rotulo: rotuloComanda(c), itens, subtotal, taxa, total,
      formaPagamento: forma, pagamentos, empresa,
    }
    if (await viaBluetooth('conta', dados)) return
    imprimirHtml(montarContaPresencialHtml(dados), empresa?.nome, { origem: 'mesa' })
  }

  // Impressão MANUAL da comanda da mesa (botão no card). Imprime todos os itens
  // pelo navegador, independente do app FWC — pro caso do automático não ter saído.
  async function handleImprimirMesa(comanda) {
    const itens = Array.isArray(comanda.comanda_itens) ? comanda.comanda_itens : []
    if (!itens.length) return
    const info = await infoComandaCozinha(comanda.id)
    const dados = {
      numeroMesa: comanda.numero_mesa ?? info.numero ?? '?',
      rotulo: rotuloComanda(comanda),
      comandaId: comanda.id,
      nomeLoja: empresa?.nome,
      area: info.area, atendente: info.atendente, pessoas: info.pessoas, rodape: info.rodape,
      itens: itens.map(i => ({ nome: i.nome, quantidade: i.quantidade, preco_unitario: i.preco_unitario, observacao: i.observacao })),
    }
    if (await viaBluetooth('comanda', dados)) return
    imprimirComandaMesaApp(dados)
  }

  // Fecha a conta da mesa pelo gestor (cria a venda, baixa estoque, libera a mesa).
  // A venda da mesa nasce com o caixa de quem fecha (`vendas.caixa_id` =
  // current_caixa_id()). Sem caixa aberto ela entra com caixa NULO: o
  // faturamento conta e o dinheiro não aparece em caixa nenhum, então a gaveta
  // não fecha à noite. Desde 02/09/2026 o ADM lança na mesa sem caixa — o que
  // torna fácil chegar até aqui sem ter aberto o dia.
  async function caixaAbertoAgora() {
    const { data: s } = await supabase.auth.getUser()
    if (!s?.user?.id) return true   // sem sessão, deixa o servidor decidir
    const { data } = await supabase.from('caixas').select('id')
      .eq('empresa_id', empresa?.id).eq('aberto_por', s.user.id).eq('status', 'aberto').limit(1)
    return !!(data && data.length)
  }

  async function handleFecharConta({ comanda, forma, aplicarTaxa, total }) {
    if (!(await caixaAbertoAgora())) {
      alert('⚠️ Abra o caixa (menu 💵 Caixa) pra receber esta conta.\n\nSem caixa aberto a venda entra sem caixa e a gaveta não fecha no fim da noite.')
      return
    }
    // Quem fechou, pro ranking do salão (mig 0187). Antes do RPC: ele mexe em
    // status/total e não encosta nestes campos.
    if (!comanda.fechada_por) {
      const { data: s } = await supabase.auth.getUser()
      if (s?.user?.id) {
        await supabase.from('comandas')
          .update({ fechada_por: s.user.id, fechada_por_em: new Date().toISOString() })
          .eq('id', comanda.id)
      }
    }
    const { error } = await supabase.rpc('fechar_conta_presencial', {
      p_comanda_id: comanda.id,
      // Sem valor: quem reconta a mesa e fecha o número é o servidor (mig 0144).
      p_pagamentos: [{ forma, valor: null }],
      p_aplicar_taxa: aplicarTaxa,
    })
    if (error) { alert('Erro ao fechar a conta: ' + error.message); return }
    // Imprime a conta automaticamente ao fechar.
    try {
      const itens = Array.isArray(comanda.comanda_itens) ? comanda.comanda_itens : []
      const subtotal = itens.reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
      imprimirContaSeMesa({
        numeroMesa: comanda.numero_mesa, rotulo: rotuloComanda(comanda),
        itens, subtotal, taxa: Math.max(0, total - subtotal), total,
        formaPagamento: forma, empresa,
      })
    } catch { /* best-effort */ }
    setComandaFechando(null)
    setComandas(cs => cs.filter(c => c.id !== comanda.id))
    // G3 — mostra na coluna "Concluídos hoje" na hora (o reload confirma depois)
    setMesasFechadasHoje(prev => [
      { id: comanda.id, numero_mesa: comanda.numero_mesa, tipo: comanda.tipo, nome_cliente: comanda.nome_cliente, total, forma_pagamento: forma, fechada_at: new Date().toISOString() },
      ...prev.filter(m => m.id !== comanda.id),
    ])
  }

  // ADM tira (ou volta) os 10% de uma mesa que o garçom já fechou, ANTES de liberar
  // (cliente decidiu não pagar a taxa). Recalcula os pagamentos pro novo total,
  // salva no fechamento_pendente e reimprime a conta já com/sem os 10%.
  async function handleAjustarTaxaMesa(comanda, aplicar) {
    const itens = Array.isArray(comanda.comanda_itens) ? comanda.comanda_itens : []
    const subtotal = itens.reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
    // ?? 0 e não ?? 10: chutar 10% quando a config da loja não veio já inventou taxa
    // de serviço numa loja que cobra 0% e travou a mesa na hora de liberar (mig 0144).
    const pct = Number(empresa?.taxa_servico_pct ?? 0)
    const taxa = calcularTaxa(itens, pct, aplicar)
    const novoTotal = Math.round((subtotal + taxa) * 100) / 100
    const pend = comanda.fechamento_pendente || {}
    const pagsAntigos = Array.isArray(pend.pagamentos) ? pend.pagamentos : []
    const totalAntigo = pagsAntigos.reduce((s, p) => s + Number(p.valor || 0), 0) || novoTotal
    // Reescala os pagamentos pro novo total (mantém a forma; no dividido, proporcional).
    let novos
    if (pagsAntigos.length <= 1) {
      novos = [{ forma: pagsAntigos[0]?.forma ?? 'dinheiro', valor: novoTotal }]
    } else {
      let acc = 0
      novos = pagsAntigos.map((p, i) => {
        if (i === pagsAntigos.length - 1) return { forma: p.forma, valor: Math.round((novoTotal - acc) * 100) / 100 }
        const v = Math.round(Number(p.valor || 0) * novoTotal / totalAntigo * 100) / 100
        acc += v
        return { forma: p.forma, valor: v }
      })
    }
    const novoPend = { ...pend, pagamentos: novos, aplicar_taxa: aplicar }
    const { error } = await supabase.from('comandas').update({ fechamento_pendente: novoPend }).eq('id', comanda.id)
    if (error) { alert('Erro ao ajustar a taxa: ' + error.message); return }
    setComandas(cs => cs.map(c => c.id === comanda.id ? { ...c, fechamento_pendente: novoPend } : c))
    // reimprime a conta com o novo valor
    const forma = novos.length > 1 ? 'Dividido' : (novos[0]?.forma ?? '')
    imprimirContaSeMesa({
      numeroMesa: comanda.numero_mesa, rotulo: rotuloComanda(comanda), itens, subtotal, taxa, total: novoTotal, formaPagamento: forma, pagamentos: novos, empresa,
    }, empresa?.nome)
  }

  // ADM confere e libera uma mesa que o garçom já fechou (aguardando_conferencia),
  // usando o pagamento que o garçom lançou. Sem pagamento salvo, abre o modal.
  async function handleConfirmarLiberarMesa(comanda) {
    const pend = comanda.fechamento_pendente || {}
    if (!Array.isArray(pend.pagamentos) || !pend.pagamentos.length) {
      setComandaFechando(comanda); return
    }
    // Liberar a mesa azul é o que cria a venda do que o garçom já recebeu.
    if (!(await caixaAbertoAgora())) {
      alert('⚠️ Abra o caixa (menu 💵 Caixa) pra liberar esta mesa.\n\nÉ agora que a venda é criada — sem caixa aberto ela entra sem caixa e a gaveta não fecha no fim da noite.')
      return
    }
    const total = (comanda.comanda_itens ?? []).reduce((s, it) => s + Number(it.preco_unitario ?? 0) * Number(it.quantidade ?? 1), 0)
    // Pagamento único: manda SEM valor pro servidor recontar a mesa na hora. Era aqui
    // que a mesa travava com "a soma dos pagamentos não confere com o total" quando o
    // valor guardado pelo garçom tinha ficado velho (mig 0144).
    const pags = pend.pagamentos.length === 1 ? [{ ...pend.pagamentos[0], valor: null }] : pend.pagamentos
    const { error } = await supabase.rpc('fechar_conta_presencial', {
      p_comanda_id: comanda.id,
      p_pagamentos: pags,
      p_aplicar_taxa: pend.aplicar_taxa ?? true,
      p_cliente_id: pend.cliente_id ?? null,
    })
    if (error) { alert('Erro ao liberar a mesa: ' + error.message); return }
    setComandas(cs => cs.filter(c => c.id !== comanda.id))
    setMesasFechadasHoje(prev => [
      { id: comanda.id, numero_mesa: comanda.numero_mesa, tipo: comanda.tipo, nome_cliente: comanda.nome_cliente, total, forma_pagamento: (pend.pagamentos[0]?.forma ?? 'dinheiro'), fechada_at: new Date().toISOString() },
      ...prev.filter(m => m.id !== comanda.id),
    ])
  }

  // ── Realtime subscription + polling de segurança + visibilidade ──
  useEffect(() => {
    if (!empresa) return
    carregarPedidos()

    // Bug 2 — reconexão: ao reconectar (status SUBSCRIBED) recarrega os pedidos
    const channel = supabase
      .channel(`painel_pedidos_${empresa.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pedidos_delivery',
          filter: `empresa_id=eq.${empresa.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const novo = payload.new
            // Só adiciona ao painel se não for finalizado E não for aguardando pagamento PIX
            if (!STATUS_FINALIZADOS.has(novo.status) && novo.status !== 'aguardando_pagamento') {
              setPedidos(prev => [...prev, novo])
              // Agendado pra depois entra calado: vai pra aba Agendados e só
              // toca/imprime perto da hora (ver o efeito de liberação).
              const guardado = ehAgendadoPendente(novo)
              if (guardado) agendadosPendentesRef.current.add(novo.id)
              // Imprime pedido novo (aguardando) OU venda de balcão (já confirmada).
              // Se o app Impressora FWC está imprimindo, o navegador não imprime (evita 2 vias).
              if (!guardado && deveAutoImprimir() && !fwcImprimeRef.current && (novo.status === 'aguardando' || novo.origem === 'balcao')) {
                autoImprimirPedido(novo)
              }
              if (!guardado && novo.status === 'aguardando') {
                iniciarLoopSom()
                if (aceitarAutoAtivo()) handleConfirmar(novo.id, tempoPrevistoMin(novo, empresa))
              }
            }
          } else if (payload.eventType === 'UPDATE') {
            const { new: novo } = payload
            if (STATUS_FINALIZADOS.has(novo.status)) {
              // Pedido finalizado — remove do painel
              setPedidos(prev => prev.filter(p => p.id !== novo.id))
            } else if (novo.status !== 'aguardando_pagamento') {
              setPedidos(prev => {
                const jaEstaNopainel = prev.some(p => p.id === novo.id)
                if (!jaEstaNopainel) {
                  // Pedido chegou ao painel agora (ex: PIX confirmado)
                  const guardado = ehAgendadoPendente(novo)
                  if (guardado) agendadosPendentesRef.current.add(novo.id)
                  if (!guardado && novo.status === 'aguardando') {
                    iniciarLoopSom()
                    if (deveAutoImprimir() && !fwcImprimeRef.current) autoImprimirPedido(novo)
                    if (aceitarAutoAtivo()) handleConfirmar(novo.id, tempoPrevistoMin(novo, empresa))
                  }
                  return [...prev, novo]
                }
                // Atualiza card existente
                return prev.map(p => p.id === novo.id ? { ...p, ...novo } : p)
              })
            }
          } else if (payload.eventType === 'DELETE') {
            setPedidos(prev => prev.filter(p => p.id !== payload.old.id))
          }
        }
      )
      .subscribe((status) => {
        // Bug 2 — reconexão: recarrega pedidos ao (re)conectar o canal
        if (status === 'SUBSCRIBED') {
          carregarPedidos()
        }
      })

    // Bug 2 — polling de segurança: garante atualização a cada 30s
    // mesmo que o Realtime esteja caído
    const pollingId = setInterval(carregarPedidos, 30_000)

    // Bug 2 — visibilidade: recarrega ao voltar para a aba
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        carregarPedidos()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      channel.unsubscribe()
      clearInterval(pollingId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      // Bug 1 — cleanup: para o loop de som ao desmontar o componente
      pararLoopSom()
    }
  }, [empresa, carregarPedidos]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-conclusão de pedidos parados em "saiu para entrega" ──
  // Verifica a cada minuto se algum pedido saiu para entrega há mais
  // de 6h sem ter o código confirmado e o conclui automaticamente.
  // Fallback de referência: saiu_entrega_at → updated_at → created_at
  // (pedidos antigos não têm saiu_entrega_at preenchido).
  useEffect(() => {
    function verificarParados() {
      const agora = Date.now()
      pedidos.forEach(p => {
        if (p.status !== 'saiu_entrega') return
        const ref = p.saiu_entrega_at ?? p.updated_at ?? p.created_at
        if (!ref) return
        if (agora - new Date(ref).getTime() >= AUTO_CONCLUIR_ENTREGA_MS) {
          // Conclui automaticamente — remove do painel e marca entregue no banco.
          setPedidos(prev => prev.filter(x => x.id !== p.id))
          supabase
            .from('pedidos_delivery')
            .update({ status: 'entregue' })
            .eq('id', p.id)
            .eq('status', 'saiu_entrega') // guarda: só conclui se ainda estiver saindo
            .then(() => {})
        }
      })
    }
    verificarParados()
    const id = setInterval(verificarParados, 60_000)
    return () => clearInterval(id)
  }, [pedidos])

  // ── Handlers ──────────────────────────────────────────────
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
    } catch {
      // silencioso — notificação é best-effort
    }
  }

  // A devolução de status pro iFood é feita por trigger no banco
  // (notify_ifood_status, migração 0070) — cobre gestor, entregador e
  // auto-conclusão sem o front precisar chamar a edge function.

  // Gestor atrela um entregador ao pedido (ex.: iFood despachado sem motoboy).
  // Só seta o entregador_id — o pedido passa a aparecer no app daquele motoboy.
  async function handleAtribuirEntregador(id, entregadorId) {
    const patch = p => p.id === id ? { ...p, entregador_id: entregadorId } : p
    setPedidos(prev => prev.map(patch))
    setConcluidosHoje(prev => prev.map(patch)) // pedidos concluídos também podem ser reatribuídos
    await supabase.from('pedidos_delivery').update({ entregador_id: entregadorId }).eq('id', id)
  }

  async function handleAvancar(id, novoStatus, extra = {}) {
    // Trava da RETIRADA: não conclui ('entregue') sem o cliente informar o código
    // de retirada. Igual ao motoboy na entrega. Abre o mini-modal do código.
    if (novoStatus === 'entregue' && !extra.__codigoOk) {
      const pAtual = pedidos.find(x => x.id === id)
      const ehRet = pAtual && (pAtual.tipo_entrega || 'entrega') === 'retirada'
      if (ehRet && pAtual.codigo_entrega) { setModalCodRetirada(pAtual); return }
    }

    const { __codigoOk, ...extraLimpo } = extra
    const update = { status: novoStatus, ...extraLimpo }

    // Gera código de confirmação de 4 dígitos ao despachar (SÓ entrega). Retirada
    // mantém o código que já veio (ex.: o código de retirada do iFood) — não regera.
    //
    // Só gera se a loja usa código. Esta tela gerava sempre, ignorando o ajuste:
    // desligado, o código continuava nascendo aqui e a confirmação — que só olha
    // se o pedido TEM código — seguia exigindo. Era por isso que desligar não
    // fazia efeito nenhum.
    if (novoStatus === 'saiu_entrega') {
      const pAtual = pedidos.find(x => x.id === id)
      const ehRet = pAtual && (pAtual.tipo_entrega || 'entrega') === 'retirada'
      const cod = ehRet ? null : novoCodigoEntrega(await exigeCodigoEntrega())
      if (cod) update.codigo_entrega = cod
      // Marca quando saiu para entrega — usado pelo auto-conclusão de 6h.
      update.saiu_entrega_at = new Date().toISOString()
    }

    // Atualização otimista — resposta imediata sem esperar Realtime
    if (STATUS_FINALIZADOS.has(novoStatus)) {
      setPedidos(prev => prev.filter(p => p.id !== id))
    } else {
      setPedidos(prev => prev.map(p => p.id === id ? { ...p, ...update } : p))
    }

    await supabase
      .from('pedidos_delivery')
      .update(update)
      .eq('id', id)

    // Pedido concluído → recarrega a coluna "Concluídos hoje"
    if (novoStatus === 'entregue') carregarConcluidosHoje()

    notificarCliente(id, novoStatus)
  }

  // Voltar um passo (avançou errado / quer trocar) — correção interna, NÃO avisa
  // o cliente. Ao cancelar o despacho, limpa o código e a hora de saída.
  async function handleVoltar(id, novoStatus) {
    const update = { status: novoStatus }
    if (novoStatus === 'pronto') { update.codigo_entrega = null; update.saiu_entrega_at = null }
    setPedidos(prev => prev.map(p => p.id === id ? { ...p, ...update } : p))
    await supabase.from('pedidos_delivery').update(update).eq('id', id)
  }

  async function handleConfirmar(id, minutos = null) {
    const extra = {}
    if (minutos) {
      extra.tempo_preparo_min = minutos
      extra.pronto_previsto_at = new Date(Date.now() + minutos * 60000).toISOString()
    }
    await handleAvancar(id, 'confirmado', extra)
  }

  async function handleConfirmarRecusa(id, motivo) {
    setPedidos(prev => prev.filter(p => p.id !== id))
    setPedidoRecusando(null)

    // Se o pedido foi pago via PIX, aciona reembolso automático via Edge Function
    const pedido = pedidos.find(p => p.id === id)
    if (pedido?.mp_payment_id) {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch(`${SUPABASE_URL}/functions/v1/refund-pix`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ order_id: id, motivo }),
      })
    } else {
      await supabase
        .from('pedidos_delivery')
        .update({ status: 'cancelado', motivo_cancelamento: motivo })
        .eq('id', id)
    }

    carregarConcluidosHoje()
    notificarCliente(id, 'cancelado')
  }

  async function handleExpirado(id) {
    const pedido = pedidos.find(p => p.id === id)
    setPedidos(prev => prev.filter(p => p.id !== id))

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

    carregarConcluidosHoje()
    notificarCliente(id, 'cancelado')
  }

  async function handleEnviarMensagem(pedido, texto) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          action: 'send_message',
          phone: pedido.cliente_telefone,
          text: texto,
        }),
      })
      const data = await res.json()
      return data.ok === true
    } catch {
      return false
    }
  }

  async function handleToggleLoja() {
    if (!empresa || togglingLoja) return
    const tentandoAbrir = !lojaAberta
    // Bloqueia abertura manual fora do horário
    if (tentandoAbrir && !lojaAbertaPorHorario(empresa, excecoesLoja)) {
      setAvisoHorario(`Horário de funcionamento: ${horarioHojeTexto(empresa, excecoesLoja)}. Ajuste em Minha Loja para abrir fora do horário.`)
      setTimeout(() => setAvisoHorario(null), 5000)
      return
    }
    setTogglingLoja(true)
    const { error } = await supabase
      .from('empresas')
      .update({ delivery_ativo: tentandoAbrir })
      .eq('id', empresa.id)
    if (!error) setLojaAberta(tentandoAbrir)
    setTogglingLoja(false)
  }

  // ── Loading inicial (sem empresa ainda) ───────────────────
  if (!empresa) {
    return (
      <div className="pp-loading">
        <div className="pp-spinner" aria-hidden="true" />
        <span className="pp-loading-text">Carregando painel...</span>
      </div>
    )
  }

  const buscaCat = buscaCatalogo.trim().toLowerCase()
  const bateProduto = (p) => !!p.nome?.toLowerCase().includes(buscaCat)
  // Grupos/opções que interessam pra busca atual. Se o próprio produto bate (ou
  // não há busca), mostra o cardápio inteiro dele; senão só o que casou — assim
  // procurar "camarão" não devolve as 38 opções do grupo junto.
  const gruposDaBusca = (produtoId, produtoBate) => {
    const grupos = complementosPorProduto[produtoId] ?? []
    if (!buscaCat || produtoBate) return grupos
    const out = []
    for (const g of grupos) {
      if (g.nome?.toLowerCase().includes(buscaCat)) { out.push(g); continue }
      const opcoes = (g.opcoes ?? []).filter(o => o.nome?.toLowerCase().includes(buscaCat))
      if (opcoes.length) out.push({ ...g, opcoes, totalOpcoes: (g.opcoes ?? []).length })
    }
    return out
  }

  // Catálogo agrupado por categoria — a lista corrida misturava açaí com
  // acompanhamento e cobertura, e achar o item pra pausar virava caça ao tesouro
  // numa loja com 200 produtos.
  const catalogoPorCategoria = (lista) => {
    const grupos = new Map()
    for (const p of lista) {
      const cat = (p.categoria || '').trim() || 'Sem categoria'
      if (!grupos.has(cat)) grupos.set(cat, [])
      grupos.get(cat).push(p)
    }
    const posicao = (cat) => (
      cat === 'Sem categoria' ? Number.MAX_SAFE_INTEGER
        : (ordemCategorias[cat] ?? Number.MAX_SAFE_INTEGER - 1)
    )
    return [...grupos.entries()]
      .map(([categoria, itens]) => ({ categoria, itens }))
      .sort((a, b) => (posicao(a.categoria) - posicao(b.categoria)) || a.categoria.localeCompare(b.categoria, 'pt-BR'))
  }

  const catalogoFiltrado = catalogo.filter(p => {
    if (!buscaCat) return true
    if (bateProduto(p)) return true
    // casa também se algum complemento do produto bate na busca
    return gruposDaBusca(p.id, false).length > 0
  })

  // Agrupa as mensagens em conversas (canal + cliente)
  const chatThreads = Object.values(chatMsgs.reduce((acc, m) => {
    const k = `${m.canal}|${m.cliente_ref}`
    if (!acc[k]) acc[k] = { key: k, canal: m.canal, cliente_ref: m.cliente_ref, cliente_nome: m.cliente_nome, msgs: [], unread: 0 }
    acc[k].msgs.push(m)
    if (m.cliente_nome) acc[k].cliente_nome = m.cliente_nome
    if (m.remetente === 'cliente' && !m.lida) acc[k].unread++
    return acc
  }, {}))
    // Conversa de WhatsApp só entra na caixa se a LOJA tiver falado nela (ver a
    // carga acima). Vale também pro que chega em tempo real: sem isto, cada
    // "bom dia" de cliente reabria a enxurrada na tela.
    .filter(t => t.canal !== 'whatsapp' || t.msgs.some(m => m.remetente === 'loja'))
    .sort((a, b) =>
      new Date(b.msgs[b.msgs.length - 1].created_at) - new Date(a.msgs[a.msgs.length - 1].created_at)
    )
  const chatNaoLidas = chatThreads.reduce((s, t) => s + t.unread, 0)
  const threadAberta = chatThreads.find(t => t.key === chatAberto)
  const CANAL_LABEL = { app: 'App', lojaonline: 'Loja online', whatsapp: 'WhatsApp' }

  // Busca de pedido: casa nº do pedido, código iFood, id, nome ou telefone.
  const buscaQ = buscaPedido.trim().toLowerCase()
  function pedidoCasaBusca(p) {
    if (!buscaQ) return true
    const alvos = [
      p.numero_pedido, p.ifood_display_id, p.id, p.cliente_nome, p.cliente_telefone,
      p.id ? String(p.id).slice(-4) : '',
    ]
    return alvos.some(v => v != null && String(v).toLowerCase().includes(buscaQ))
  }
  // Resultados da busca (todos os pedidos do dia, de qualquer coluna)
  const resultadosBusca = buscaQ
    ? [...pedidos, ...concluidosHoje, ...canceladosHoje].filter(pedidoCasaBusca)
    : []

  // Filtro por origem (WhatsApp / App / iFood / Balcão / Cardápio / Mesa). null = todas.
  const isMesaFiltro = filtroOrigem === 'mesa'
  const passaOrigem = (p) => !filtroOrigem || (p?.origem || 'cardapio') === filtroOrigem
  const contaOrigem = (o) => [...pedidos, ...concluidosHoje, ...canceladosHoje].filter(p => (p?.origem || 'cardapio') === o).length
  // Filtro "Mesa": mostra só as comandas/mesas e esconde o delivery.
  // Filtro de origem de delivery: esconde as mesas. Sem filtro: mostra tudo.
  // Novo no topo: as colunas mostram o pedido mais recente em cima (ordem de chegada, de cima pra baixo).
  const pedidosTodosView    = [...(isMesaFiltro ? [] : (filtroOrigem ? pedidos.filter(passaOrigem) : pedidos))]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  // Agendado que ainda não chegou a hora fica FORA da fila: não conta em "A
  // aceitar", não entra na cozinha e não some no meio dos pedidos de agora.
  // Ordem aqui é a da hora combinada — o próximo a sair fica em cima.
  const agendadosView = pedidosTodosView
    .filter(ehAgendadoPendente)
    .sort((a, b) => new Date(a.agendado_para) - new Date(b.agendado_para))
  const pedidosView = pedidosTodosView.filter(p => !ehAgendadoPendente(p))
  const concluidosHojeView  = isMesaFiltro ? [] : (filtroOrigem ? concluidosHoje.filter(passaOrigem)  : concluidosHoje)
  const canceladosHojeView  = isMesaFiltro ? [] : (filtroOrigem ? canceladosHoje.filter(passaOrigem)  : canceladosHoje)
  // Mesas saíram do "total de pedidos" — ficam SÓ na seção Mesas (evita duplicidade).
  // Zerando estas views, o tab "Mesas" e os cards de mesa somem sozinhos da tela principal.
  // (Reversível: antes era (!filtroOrigem || isMesaFiltro) ? mesasFechadasHoje/comandas : [].)
  const mesasFechadasHojeView = []
  const comandasView          = []
  // Quanto a cozinha tem na fila agora (item de mesa que ninguém marcou pronto).
  const itensNaCozinha = comandas.reduce((n, c) => n + (c.comanda_itens ?? [])
    .filter(i => i.status !== 'pronto' && i.status !== 'entregue' && i.setor !== 'nenhum').length, 0)

  return (
    <div className="pp-root">
      {/* Header fixo */}
      <header className="pp-header">
        <div className="pp-header-left">
          {/* Logo mark */}
          <div className="pp-logo-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
          <span className="pp-loja-nome">{empresa.nome || 'Gestor'}</span>
          {total > 0 && (
            <span className="pp-count-badge" aria-label={`${total} pedidos ativos`}>
              {total}
            </span>
          )}
        </div>

        <div className="pp-header-right">
          {/* Nova venda (balcão / PDV) */}
          <button
            type="button"
            className="pp-toggle-loja aberta"
            onClick={() => setVendaAberta(true)}
            title="Registrar uma venda no balcão"
            style={{ background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>Vender</span>
          </button>

          {/* Alternar tema claro / escuro */}
          <button
            type="button"
            className="pp-theme-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Mudar para modo claro' : 'Mudar para modo escuro'}
            aria-label={theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro'}
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4"/>
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a6.364 6.364 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
              </svg>
            )}
          </button>

          {/* Sair */}
          <button type="button" className="pp-back-link" title="Sair" onClick={logout}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            <span>Sair</span>
          </button>

          {/* Impressão automática: se o app FWC está imprimindo, mostra isso (fim da
              confusão do "OFF" que ainda imprime). Senão, o toggle do navegador. */}
          {fwcAppImprime ? (
            <button
              type="button"
              onClick={toggleFwcPausa}
              className={`pp-toggle-loja ${fwcPausado ? 'fechada' : 'aberta'}`}
              title={fwcPausado ? 'Impressão automática PAUSADA — clique para LIGAR' : 'Impressão automática LIGADA (app FWC) — clique para PAUSAR'}
              aria-label="Ligar/pausar impressão automática"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 6 2 18 2 18 9"/>
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                <rect x="6" y="14" width="12" height="8"/>
              </svg>
              <span>{fwcPausado ? 'Impressão OFF' : 'Impressão ON'}</span>
            </button>
          ) : (
            <button
              type="button"
              className={`pp-toggle-loja ${autoImprimir ? 'aberta' : 'fechada'}`}
              onClick={toggleAutoImprimir}
              title={autoImprimir ? 'Imprimir cupom automaticamente ao chegar pedido' : 'Impressão automática desligada'}
              aria-label="Alternar impressão automática"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 6 2 18 2 18 9"/>
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                <rect x="6" y="14" width="12" height="8"/>
              </svg>
              <span>{autoImprimir ? 'Auto-imprimir ON' : 'Auto-imprimir OFF'}</span>
            </button>
          )}

          {/* Toggle aceitar pedido automático */}
          <button
            type="button"
            className={`pp-toggle-loja ${aceitarAuto ? 'aberta' : 'fechada'}`}
            onClick={toggleAceitarAuto}
            title={aceitarAuto ? 'Todo pedido novo é aceito sozinho' : 'Aceite automático desligado'}
            aria-label="Alternar aceite automático de pedidos"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>{aceitarAuto ? 'Aceitar auto ON' : 'Aceitar auto OFF'}</span>
          </button>

          {/* Toggle loja */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className={`pp-toggle-loja ${lojaAberta ? 'aberta' : 'fechada'}`}
              onClick={handleToggleLoja}
              disabled={togglingLoja}
              aria-label={lojaAberta ? 'Loja aberta — clique para fechar' : 'Loja fechada — clique para abrir'}
            >
              <span className="pp-toggle-dot" aria-hidden="true" />
              <span>{togglingLoja ? 'Aguarde...' : lojaAberta ? 'Loja aberta' : 'Loja fechada'}</span>
            </button>
            {avisoHorario && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: '#1e293b', border: '1px solid #f59e0b',
                color: '#fbbf24', borderRadius: 8, padding: '8px 12px',
                fontSize: 12, whiteSpace: 'nowrap', zIndex: 999,
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              }}>
                ⏰ {avisoHorario}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Aviso forte quando a loja está fechada — pedidos não entram */}
      {!lojaAberta && (
        <div className="pp-loja-fechada-banner" role="alert">
          <span className="pp-lf-dot" aria-hidden="true" />
          LOJA FECHADA — novos pedidos NÃO estão entrando. Clique em “Loja fechada” no topo para abrir.
        </div>
      )}

      {/* Corpo — quadro com 4 colunas (cards compactos; clica pra ver completo) */}
      <main className="pp-body" style={{ paddingRight: 56 }}>
        {carregando ? (
          <SkeletonGrid />
        ) : (
          <>
            {/* Barra de busca de pedido (nº, código iFood, nome ou telefone) */}
            <div style={{ position: 'relative', maxWidth: 320, marginBottom: 10 }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted, #9aa0b5)' }} aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </span>
              <input
                type="search"
                value={buscaPedido}
                onChange={e => setBuscaPedido(e.target.value)}
                placeholder="Buscar pedido (nº, iFood, cliente...)"
                style={{
                  width: '100%', padding: '9px 12px 9px 34px', borderRadius: 20, fontSize: 15,
                  border: '1.5px solid var(--border, #2a2a3a)', background: 'var(--surface, #16161f)',
                  color: 'var(--text)', outline: 'none',
                }}
              />
            </div>

            {/* Filtro de colunas — some quando está buscando */}
            {!buscaQ && (
            <div className="pp-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {[
                { id: null,         label: 'Todos',     cor: '#7c3aed', count: pedidosView.length + agendadosView.length + concluidosHojeView.length + mesasFechadasHojeView.length + canceladosHojeView.length },
                // "Agendados" só existe quando há pedido marcado pra depois.
                ...(agendadosView.length > 0
                  ? [{ id: 'agendados', label: 'Agendados', cor: '#0284c7', count: agendadosView.length }]
                  : []),
                // "Mesas" só aparece quando há mesa aberta (autoatendimento por QR)
                ...(comandasView.length > 0
                  ? [{ id: 'mesas', label: 'Mesas', cor: '#db2777', count: comandasView.length }]
                  : []),
                // "A aceitar" só aparece quando há pedido aguardando (esconde quando vazia)
                ...(pedidosView.some(p => p.status === 'aguardando')
                  ? [{ id: 'aceitar', label: 'A aceitar', cor: '#ca8a04', count: pedidosView.filter(p => p.status === 'aguardando').length }]
                  : []),
                { id: 'cozinha',    label: 'Na cozinha', cor: '#1d4ed8', count: pedidosView.filter(p => p.tipo_entrega !== 'retirada' && ['confirmado', 'em_preparo', 'pronto'].includes(p.status)).length },
                { id: 'entrega',    label: 'Em rota', cor: '#7c3aed', count: pedidosView.filter(p => p.tipo_entrega !== 'retirada' && p.status === 'saiu_entrega').length },
                { id: 'retirada',   label: 'Retirada',  cor: '#0891b2', count: pedidosView.filter(p => p.tipo_entrega === 'retirada' && ['confirmado', 'em_preparo', 'pronto', 'saiu_entrega'].includes(p.status)).length },
                { id: 'concluidos', label: 'Concluídos', cor: '#16a34a', count: concluidosHojeView.length + mesasFechadasHojeView.length },
                { id: 'cancelados', label: 'Cancelados', cor: '#dc2626', count: canceladosHojeView.length },
              ].map(f => {
                const ativo = filtroColuna === f.id
                return (
                  <button key={f.label} type="button" onClick={() => setFiltroColuna(f.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                      borderRadius: 20, cursor: 'pointer', fontSize: 14, fontWeight: 700,
                      border: `1.5px solid ${ativo ? f.cor : 'var(--border, #2a2a3a)'}`,
                      background: ativo ? f.cor : 'transparent',
                      color: ativo ? '#fff' : 'var(--text-muted, #9aa0b5)',
                    }}>
                    {f.label}
                    <span style={{
                      minWidth: 20, height: 20, borderRadius: 10, padding: '0 6px',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12.5, fontWeight: 800,
                      background: ativo ? 'rgba(255,255,255,.25)' : 'var(--border, #2a2a3a)',
                      color: ativo ? '#fff' : 'var(--text-muted, #9aa0b5)',
                    }}>{f.count}</span>
                  </button>
                )
              })}
            </div>
            )}

            {/* Filtro por origem — só aparece quando há mais de uma origem hoje */}
            {!buscaQ && (
            <div className="pp-chips" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {[
                { id: null, label: 'Todas origens', cor: '#7c3aed', count: pedidos.length + concluidosHoje.length + canceladosHoje.length },
                // "Mesa (comandas)" saiu daqui — mesas ficam só na seção Mesas.
                { id: 'whatsapp', label: 'WhatsApp', cor: ORIGEM_CONFIG.whatsapp.bg, count: contaOrigem('whatsapp') },
                { id: 'ifood', label: 'iFood', cor: ORIGEM_CONFIG.ifood.bg, count: contaOrigem('ifood') },
                { id: 'balcao', label: 'Balcão', cor: ORIGEM_CONFIG.balcao.bg, count: contaOrigem('balcao') },
                { id: 'cardapio', label: 'Cardápio (loja online)', cor: ORIGEM_CONFIG.cardapio.bg, count: contaOrigem('cardapio') },
                { id: 'app', label: 'App', cor: ORIGEM_CONFIG.app.bg, count: contaOrigem('app') },
              ].map(f => {
                const ativo = filtroOrigem === f.id
                return (
                  <button key={f.label} type="button" onClick={() => setFiltroOrigem(f.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px',
                      borderRadius: 20, cursor: 'pointer', fontSize: 14, fontWeight: 700,
                      border: `1.5px solid ${ativo ? f.cor : 'var(--border, #2a2a3a)'}`,
                      background: ativo ? f.cor : 'transparent',
                      color: ativo ? '#fff' : 'var(--text-muted, #9aa0b5)',
                    }}>
                    {f.label}
                    <span style={{
                      minWidth: 20, height: 20, borderRadius: 10, padding: '0 6px',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12.5, fontWeight: 800,
                      background: ativo ? 'rgba(255,255,255,.25)' : 'var(--border, #2a2a3a)',
                      color: ativo ? '#fff' : 'var(--text-muted, #9aa0b5)',
                    }}>{f.count}</span>
                  </button>
                )
              })}
            </div>
            )}

            {/* Resultados da busca (substitui as colunas enquanto tem texto) */}
            {buscaQ && (
              <div className="pp-board" style={{ gridTemplateColumns: 'minmax(0, 460px)' }}>
                <Coluna titulo={`Busca: "${buscaPedido.trim()}"`} cor="#7c3aed" count={resultadosBusca.length} vazio="Nenhum pedido encontrado com esse termo">
                  {resultadosBusca.map(p => (
                    <CardMini key={p.id} pedido={p} entregadores={entregadores} onAvancar={handleAvancar} onVoltar={handleVoltar} onClick={() => setPedidoDetalhe(p)} />
                  ))}
                </Coluna>
              </div>
            )}

            {!buscaQ && (
            <div className="pp-board" style={filtroColuna ? { gridTemplateColumns: 'minmax(0, 460px)' } : undefined}>
              {(!filtroColuna || filtroColuna === 'mesas') && comandasView.length > 0 && (
                <Coluna titulo="Mesas" cor="#db2777" count={comandasView.length} vazio="Nenhuma mesa aberta">
                  {comandasView.map(c => (
                    <CardMesa key={c.id} comanda={c} taxaPct={Number(empresa?.taxa_servico_pct ?? 0)} onPronto={handleMesaPronto} onItemPronto={handleMesaItemPronto} onFecharConta={setComandaFechando} onConfirmarLiberar={handleConfirmarLiberarMesa} onImprimir={handleImprimirMesa} onImprimirConta={handleImprimirContaMesa} onEditarPreco={handleEditarPrecoMesaItem} podeEditarPreco={podeFinanceiro} onAjustarTaxa={podeFinanceiro ? handleAjustarTaxaMesa : null} />
                  ))}
                </Coluna>
              )}

              {/* Agendados: o que o cliente marcou pra mais tarde. Fica aqui,
                  quieto, até faltar pouco pra hora — só então entra na fila. */}
              {(!filtroColuna || filtroColuna === 'agendados') && agendadosView.length > 0 && (
                <Coluna titulo="Agendados" cor="#0284c7"
                  count={agendadosView.length}
                  vazio="Nada agendado">
                  {agendadosView.map(p => (
                    <CardMini key={p.id} pedido={p} entregadores={entregadores} onClick={() => setPedidoDetalhe(p)} />
                  ))}
                </Coluna>
              )}

              {(!filtroColuna || filtroColuna === 'aceitar') && pedidosView.some(p => p.status === 'aguardando') && (
                <Coluna titulo="A aceitar" cor="#ca8a04"
                  count={pedidosView.filter(p => p.status === 'aguardando').length}
                  vazio="Nenhum pedido novo">
                  {/* Card completo já aqui — o lojista vê tudo e aceita/recusa sem abrir */}
                  {pedidosView.filter(p => p.status === 'aguardando').map(p => (
                    <CardPedido
                      key={p.id}
                      pedido={p}
                      entregadores={entregadores}
                      onConfirmar={(id) => { const ped = pedidos.find(x => x.id === id) || p; handleConfirmar(id, tempoPrevistoMin(ped, empresa)) }}
                      onRecusar={(ped) => setPedidoRecusando(ped)}
                      onExpirado={handleExpirado}
                      onAvancar={handleAvancar}
                      onAtribuir={handleAtribuirEntregador}
                      onEnviarMensagem={(ped) => setPedidoMensagem(ped)}
                      onImprimir={handleImprimir} onImprimirCelular={handleImprimirCelular}
                      nfceHabilitada={nfceHabilitada}
                      onEmitirNfce={handleEmitirNfce}
                      nfceEmitindo={nfceEmitindo}
                    />
                  ))}
                </Coluna>
              )}

              {/* Na cozinha: pedidos de ENTREGA em preparo OU prontos aguardando despacho (ficam aqui até despachar) */}
              {((!filtroColuna && pedidosView.some(p => p.tipo_entrega !== 'retirada' && ['confirmado', 'em_preparo', 'pronto'].includes(p.status))) || filtroColuna === 'cozinha') && (
                <Coluna titulo="Na cozinha" cor="#1d4ed8"
                  count={pedidosView.filter(p => p.tipo_entrega !== 'retirada' && ['confirmado', 'em_preparo', 'pronto'].includes(p.status)).length}
                  vazio="Nada em preparo">
                  {pedidosView.filter(p => p.tipo_entrega !== 'retirada' && ['confirmado', 'em_preparo', 'pronto'].includes(p.status)).map(p => (
                    <CardMini key={p.id} pedido={p} entregadores={entregadores} onAvancar={handleAvancar} onVoltar={handleVoltar} onClick={() => setPedidoDetalhe(p)} />
                  ))}
                </Coluna>
              )}

              {/* Em rota: pedidos de ENTREGA já despachados (só o código do cliente conclui) */}
              {((!filtroColuna && pedidosView.some(p => p.tipo_entrega !== 'retirada' && p.status === 'saiu_entrega')) || filtroColuna === 'entrega') && (
                <Coluna titulo="Em rota" cor="#7c3aed"
                  count={pedidosView.filter(p => p.tipo_entrega !== 'retirada' && p.status === 'saiu_entrega').length}
                  vazio="Ninguém na rua">
                  {pedidosView.filter(p => p.tipo_entrega !== 'retirada' && p.status === 'saiu_entrega').map(p => (
                    <CardMini key={p.id} pedido={p} entregadores={entregadores} onAvancar={handleAvancar} onVoltar={handleVoltar} onClick={() => setPedidoDetalhe(p)} />
                  ))}
                </Coluna>
              )}

              {/* Retirada: lista separada (não sai pra entrega) — confirma no próprio gestor */}
              {((!filtroColuna && pedidosView.some(p => p.tipo_entrega === 'retirada' && ['confirmado', 'em_preparo', 'pronto', 'saiu_entrega'].includes(p.status))) || filtroColuna === 'retirada') && (
                <Coluna titulo="Retirada" cor="#0891b2"
                  count={pedidosView.filter(p => p.tipo_entrega === 'retirada' && ['confirmado', 'em_preparo', 'pronto', 'saiu_entrega'].includes(p.status)).length}
                  vazio="Nenhuma retirada">
                  {pedidosView.filter(p => p.tipo_entrega === 'retirada' && ['confirmado', 'em_preparo', 'pronto', 'saiu_entrega'].includes(p.status)).map(p => (
                    <CardMini key={p.id} pedido={p} onAvancar={handleAvancar} onVoltar={handleVoltar} onClick={() => setPedidoDetalhe(p)} />
                  ))}
                </Coluna>
              )}

              {((!filtroColuna && (concluidosHojeView.length > 0 || mesasFechadasHojeView.length > 0)) || filtroColuna === 'concluidos') && (
                <Coluna titulo="Concluídos hoje" cor="#16a34a"
                  count={concluidosHojeView.length + mesasFechadasHojeView.length}
                  vazio="Nenhum concluído hoje">
                  {mesasFechadasHojeView.map(m => (
                    <div key={m.id} className="pp-mini" style={{ borderLeft: '3px solid #db2777', cursor: 'default' }}>
                      <div className="pp-mini-top">
                        <span className="pp-mini-num">🍽️ {rotuloComanda(m)} · {fmt(m.total)}</span>
                      </div>
                      <div className="pp-mini-sub">
                        {m.fechada_at ? new Date(m.fechada_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''} · conta fechada
                      </div>
                      <div className="pp-mini-tags">
                        <span className="pp-mini-badge" style={{ background: '#dcfce7', color: '#166534' }}>Mesa paga</span>
                        {m.forma_pagamento && <span className="pp-mini-itens">{m.forma_pagamento}</span>}
                      </div>
                    </div>
                  ))}
                  {concluidosHojeView.map(p => (
                    <CardMini key={p.id} pedido={p} entregadores={entregadores} onClick={() => setPedidoDetalhe(p)} />
                  ))}
                </Coluna>
              )}

              {((!filtroColuna && canceladosHojeView.length > 0) || filtroColuna === 'cancelados') && (
                <Coluna titulo="Cancelados hoje" cor="#dc2626"
                  count={canceladosHojeView.length}
                  vazio="Nenhum cancelado hoje">
                  {canceladosHojeView.map(p => (
                    <CardMini key={p.id} pedido={p} entregadores={entregadores} onClick={() => setPedidoDetalhe(p)} />
                  ))}
                </Coluna>
              )}
            </div>
            )}
          </>
        )}
      </main>

      {/* Modal de recusa */}
      {pedidoRecusando && (
        <ModalRecusa
          pedido={pedidoRecusando}
          onConfirmar={handleConfirmarRecusa}
          onFechar={() => setPedidoRecusando(null)}
        />
      )}

      {/* Modal de aceite — tempo de preparo */}
      {pedidoAceitando && (
        <ModalAceitar
          pedido={pedidoAceitando}
          onConfirmar={(id, minutos) => { handleConfirmar(id, minutos); setPedidoAceitando(null) }}
          onFechar={() => setPedidoAceitando(null)}
        />
      )}

      {/* Modal de mensagem WhatsApp */}
      {pedidoMensagem && (
        <ModalMensagem
          pedido={pedidoMensagem}
          onEnviar={handleEnviarMensagem}
          onFechar={() => setPedidoMensagem(null)}
        />
      )}

      {/* Localização que o cliente mandou no chat → endereço + ponto dele */}
      {locUsar && (
        <ModalLocalizacaoCliente
          empresa={empresa}
          telefone={locUsar.telefone}
          nome={locUsar.nome}
          lat={locUsar.lat}
          lng={locUsar.lng}
          onFechar={() => setLocUsar(null)}
          onSalvo={() => {
            setCadastroVersao(v => v + 1)
            setChatAviso({ ok: true, txt: '✓ Endereço e ponto salvos — já preenchi no pedido.' })
          }}
        />
      )}

      {/* Modal de venda no balcão (PDV) */}
      {vendaAberta && (
        <ModalVenda
          empresa={empresa}
          onFechar={() => setVendaAberta(false)}
          onCriado={carregarPedidos}
        />
      )}

      {/* Edição de um pedido de balcão */}
      {vendaEditando && (
        <ModalVenda
          empresa={empresa}
          pedidoEdicao={vendaEditando}
          onFechar={() => setVendaEditando(null)}
          onCriado={carregarPedidos}
        />
      )}

      {comandaFechando && (
        <ModalFecharConta
          comanda={comandaFechando}
          taxaPct={Number(empresa?.taxa_servico_pct ?? 0)}
          onFechar={() => setComandaFechando(null)}
          onConfirmar={handleFecharConta}
        />
      )}

      {/* Detalhe do pedido — card completo ao clicar num card compacto */}
      {pedidoDetalhe && (
        <div className="pp-modal-overlay" onClick={() => setPedidoDetalhe(null)} style={{ zIndex: 120 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(440px, 94vw)', maxHeight: '92vh', overflowY: 'auto' }}>
            <CardPedido
              pedido={pedidos.find(p => p.id === pedidoDetalhe.id) || concluidosHoje.find(p => p.id === pedidoDetalhe.id) || canceladosHoje.find(p => p.id === pedidoDetalhe.id) || pedidoDetalhe}
              onConfirmar={(id) => {
                const p = pedidos.find(x => x.id === id) || pedidoDetalhe
                setPedidoDetalhe(null)
                handleConfirmar(id, tempoPrevistoMin(p, empresa))
              }}
              onRecusar={(p) => { setPedidoRecusando(p); setPedidoDetalhe(null) }}
              onExpirado={(id) => { handleExpirado(id); setPedidoDetalhe(null) }}
              onAvancar={(id, st) => { handleAvancar(id, st); setPedidoDetalhe(null) }}
              onAtribuir={handleAtribuirEntregador}
              onEditar={(p) => { setVendaEditando(p); setPedidoDetalhe(null) }}
              onEnviarMensagem={(p) => { setPedidoMensagem(p); setPedidoDetalhe(null) }}
              onImprimir={handleImprimir} onImprimirCelular={handleImprimirCelular}
              entregadores={entregadores}
              nfceHabilitada={nfceHabilitada}
              onEmitirNfce={handleEmitirNfce}
              nfceEmitindo={nfceEmitindo}
            />
          </div>
        </div>
      )}

      {modalCodRetirada && (
        <ModalCodigoRetirada
          pedido={modalCodRetirada}
          onCancelar={() => setModalCodRetirada(null)}
          onOk={() => { const p = modalCodRetirada; setModalCodRetirada(null); handleAvancar(p.id, 'entregue', { __codigoOk: true }) }}
        />
      )}

      {/* ── Gaveta lateral direita ── */}
      {painelDireito && (
        <aside className="pp-drawer" style={{
          // right:56 reserva o menu de ícones; a largura precisa descontar isso
          // (senão no celular 94vw + 56px estoura a tela e corta o lado esquerdo).
          //
          // No PC ela pega METADE da tela: atender pelo gestor é ler conversa e
          // montar sacola ao mesmo tempo, e 480px espremia as duas coisas num
          // monitor que tem espaço sobrando. A outra metade continua mostrando
          // os pedidos, que é o que a loja não pode perder de vista.
          position: 'fixed', top: 60, right: 56, bottom: 0, zIndex: 39,
          width: telaGrande ? 'min(50vw, calc(100vw - 80px))' : 'min(480px, calc(100vw - 64px))',
          background: 'var(--surface, #16161f)', borderLeft: '1px solid var(--border, #2a2a3a)',
          boxShadow: '-8px 0 24px rgba(0,0,0,.25)', overflowY: 'auto', overflowX: 'hidden',
          padding: telaGrande ? 22 : 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
              {painelDireito === 'impressora' ? 'Impressora'
                : painelDireito === 'pedidos' ? 'Pedidos finalizados'
                : painelDireito === 'hoje' ? 'Concluídos hoje'
                : painelDireito === 'chat' ? 'Mensagens'
                : painelDireito === 'entregadores' ? 'Entregadores'
                : 'Catálogo'}
            </h3>
            <button type="button" onClick={() => setPainelDireito(null)} aria-label="Fechar"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1 }}>
              ×
            </button>
          </div>

          {/* Painel: Mensagens (chat App + Loja online) */}
          {painelDireito === 'chat' && chamados.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {(() => {
                // O sino só grita enquanto tem gente esperando de verdade.
                // Depois que a loja clicou em "Responder aqui" em todos, o
                // título deixa de ser alarme e vira lembrete.
                const esperando = chamados.filter(c => !chamadosSilenciados.has(c.id)).length
                return (
                  <div style={{
                    fontSize: 11, fontWeight: 800, letterSpacing: '.04em',
                    color: esperando ? '#f87171' : '#eab308',
                  }}>
                    {esperando
                      ? '🔔 ESPERANDO ATENDENTE NO WHATSAPP'
                      : '💬 EM ATENDIMENTO — RESPONDA E FECHE O CHAMADO'}
                  </div>
                )
              })()}
              {chamados.map(c => {
                const indoResponder = chamadosSilenciados.has(c.id)
                return (
                <div key={c.id} style={{
                  // Vermelho é "ninguém foi ainda". Depois do clique vira âmbar:
                  // o chamado continua aberto (falta responder e fechar), mas
                  // parou de ser urgente — e parou de tocar.
                  border: `1px solid ${indoResponder ? 'rgba(234,179,8,.55)' : 'rgba(220,38,38,.5)'}`,
                  borderRadius: 10,
                  padding: telaGrande ? '14px 16px' : '10px 12px',
                  background: indoResponder ? 'rgba(234,179,8,.10)' : 'rgba(220,38,38,.10)',
                }}>
                  <div style={{ fontSize: telaGrande ? 17 : 13.5, fontWeight: 700, color: 'var(--text)' }}>
                    {c.nome || foneBonito(c.phone)}
                  </div>
                  {c.nome && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{foneBonito(c.phone)}</div>
                  )}
                  {c.motivo && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>"{c.motivo}"</div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {/* Responde AQUI, não no app da loja. A resposta digitada
                        aqui fica gravada na conversa — é ela que o robô lê pra
                        continuar de onde a pessoa parou. Respondendo pelo
                        celular, ele volta sem saber o que foi dito. */}
                    <button type="button"
                      onClick={() => { silenciarChamado(c.id); abrirConversaDoChamado(c.phone) }}
                      style={{
                        flex: 1, padding: telaGrande ? '12px 14px' : '8px 10px', borderRadius: 8,
                        cursor: 'pointer', border: 'none',
                        background: indoResponder ? 'rgba(34,197,94,.25)' : '#22c55e',
                        color: indoResponder ? '#4ade80' : '#fff',
                        fontSize: telaGrande ? 15.5 : 12, fontWeight: 800,
                      }}>{indoResponder ? '💬 Respondendo…' : '💬 Responder aqui'}</button>
                  </div>
                  {/* Duas saídas, e a diferença é quem continua falando com o
                      cliente. Devolver é o caso comum: o robô travou numa
                      pergunta, a pessoa respondeu, e o pedido segue sozinho. */}
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button type="button" onClick={() => atenderChamado(c.id, { devolverAoRobo: true })}
                      title="O robô volta a responder este cliente e continua de onde parou"
                      style={{
                        flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 800,
                        border: '1px solid rgba(124,58,237,.6)', background: 'rgba(124,58,237,.15)', color: '#a78bfa',
                      }}>🤖 Devolver pro robô</button>
                    <button type="button" onClick={() => { atenderChamado(c.id); setBotPausado(true) }}
                      title="Você segue a conversa; o robô fica quieto por 12h neste número. Pra devolver depois, abra a conversa: o botão fica lá dentro"
                      style={{
                        flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 800,
                        border: '1px solid var(--border, #2a2a3a)', background: 'transparent', color: 'var(--text-muted)',
                      }}>Assumi a conversa</button>
                  </div>
                </div>
                )
              })}
            </div>
          )}

          {painelDireito === 'chat' && (
            threadAberta ? (
              <ChatConversa
                thread={threadAberta}
                texto={chatTexto}
                onTexto={setChatTexto}
                enviando={enviandoChat}
                onEnviar={enviarChat}
                onVoltar={() => { setChatAberto(null); setChatAviso(null) }}
                canalLabel={CANAL_LABEL[threadAberta.canal] ?? threadAberta.canal}
                aviso={chatAviso}
                empresaId={empresa?.id}
                onEscolherProduto={escolherProdutoNoChat}
                botPausado={botPausado}
                onDevolverAoRobo={devolverConversaAoRobo}
                sacola={sacolaChat}
                onQtdSacola={mudarQtdSacola}
                onQtdDiretaSacola={definirQtdSacola}
                empresa={empresa}
                onFinalizarPedido={finalizarPedidoDoChat}
                salvandoPedido={salvandoPedidoChat}
                onAvulsoSacola={item => setSacolaChat(prev => [...prev, item])}
                onEnviarSacola={enviarSacolaDoChat}
                enviandoSacola={enviandoSacola}
                onAbrirSacola={() => setSacolaLateral(true)}
                onPedirLocalizacao={pedirLocalizacaoNoChat}
                onUsarLocalizacao={({ lat, lng }) => setLocUsar({
                  lat, lng,
                  telefone: threadAberta.cliente_ref,
                  nome: threadAberta.cliente_nome,
                })}
                cadastroVersao={cadastroVersao}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {chatThreads.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 12px', fontSize: 13 }}>
                    Nenhuma conversa ainda.<br />
                    Mensagens do app e da loja online aparecem aqui.
                  </div>
                ) : chatThreads.map(t => {
                  const ultima = t.msgs[t.msgs.length - 1]
                  const hora = new Date(ultima.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                  const canalLbl = CANAL_LABEL[t.canal] ?? t.canal
                  return (
                    <button key={t.key} type="button" onClick={() => abrirThread(t)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                        border: '1px solid var(--border, #2a2a3a)', borderRadius: 10,
                        padding: telaGrande ? '13px 15px' : '10px 12px',
                        background: t.unread ? 'rgba(124,58,237,.08)' : 'transparent',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: telaGrande ? 16.5 : 13.5, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.cliente_nome || t.cliente_ref || 'Cliente'}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{hora}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 20, flexShrink: 0,
                          background: t.canal === 'app' ? '#f97316' : '#3b82f6', color: '#fff',
                        }}>{canalLbl}</span>
                        <span style={{ fontSize: telaGrande ? 15 : 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {ultima.remetente === 'loja' ? (ultima.bot ? '🤖 ' : 'Você: ') : ''}{ultima.texto}
                        </span>
                        {t.unread > 0 && (
                          <span style={{ flexShrink: 0, minWidth: 18, height: 18, borderRadius: 9, background: '#7c3aed', color: '#fff', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>
                            {t.unread}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          )}

          {/* Painel: Impressora */}
          {painelDireito === 'impressora' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Atualizar o app (pegar versão nova na hora) */}
              <AtualizarAppCard />

              {/* Impressora FWC — configuração ao vivo dentro do gestor */}
              <ImpressoraFWCPanel empresaId={empresa?.id} />

              {/* Impressora do celular (Bluetooth) — caminho separado, sem PC */}
              <ImpressoraCelularPanel empresa={empresa} />

              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Largura do cupom</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['80mm', '58mm'].map(w => (
                    <button key={w} type="button" onClick={() => escolherLargura(w)} style={{
                      flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                      border: `1.5px solid ${larguraCupom === w ? 'var(--primary, #7c3aed)' : 'var(--border, #2a2a3a)'}`,
                      background: larguraCupom === w ? 'rgba(124,58,237,.15)' : 'transparent',
                      color: larguraCupom === w ? 'var(--primary, #a78bfa)' : 'var(--text)',
                    }}>{w}</button>
                  ))}
                </div>
              </div>

              {/* Cupom — o que aparece */}
              <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Cupom — o que aparece</span>

                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Tamanho da fonte</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[['normal', 'Normal'], ['grande', 'Grande']].map(([v, lbl]) => {
                      const ativo = (cupomCfg.fonte === 'grande' ? 'grande' : 'normal') === v
                      return (
                        <button key={v} type="button" onClick={() => setCupom({ fonte: v })} style={{
                          flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                          border: `1.5px solid ${ativo ? 'var(--primary, #7c3aed)' : 'var(--border, #2a2a3a)'}`,
                          background: ativo ? 'rgba(124,58,237,.15)' : 'transparent',
                          color: ativo ? 'var(--primary, #a78bfa)' : 'var(--text)',
                        }}>{lbl}</button>
                      )
                    })}
                  </div>
                </div>

                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.4 }}>
                  Todas as informações do pedido (telefone, endereço, taxa, observações, código e itens) saem sempre no cupom.
                </p>
              </div>

              {/* O que ESTE computador imprime — por origem (controla o app FWC deste PC) */}
              {fwcAppImprime && fwcVersao >= 11 ? (
                <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>O que ESTE computador imprime</span>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 4px', lineHeight: 1.4 }}>
                    Ligue só o que deve sair NESTA impressora. Ex.: PC da cozinha = só <b>Mesa</b>; PC do delivery = tudo <b>menos Mesa</b>.
                  </p>
                  {FWC_ORIGENS.map(({ k, lbl }) => (
                    <ToggleRow key={k} label={lbl} ativo={fwcFiltros?.[k] !== false} onToggle={() => toggleFwcFiltro(k)} />
                  ))}
                </div>
              ) : fwcAppImprime ? (
                <p style={{ fontSize: 11, color: '#a16207', lineHeight: 1.4, margin: 0, background: 'rgba(161,98,7,.08)', border: '1px solid #a16207', borderRadius: 8, padding: '8px 10px' }}>
                  ⚠️ Clique em <b>"Atualizar agora"</b> aqui em cima pra atualizar o app e liberar a escolha do que cada computador imprime.
                </p>
              ) : null}

              {fwcAppImprime && (
                <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 700, background: 'rgba(34,197,94,.08)', border: '1px solid #16a34a', borderRadius: 8, padding: '8px 10px' }}>
                  ✓ Pedidos de delivery/balcão imprimem sozinhos pelo <b>app FWC</b>. O toggle abaixo vale só pra impressão pelo <b>navegador</b> (ex.: mesa/comanda).
                </div>
              )}
              <ToggleRow label={fwcAppImprime ? 'Auto-imprimir pelo navegador (mesa)' : 'Imprimir automático'} ativo={autoImprimir} onToggle={toggleAutoImprimir} />
              <ToggleRow label="Aceitar pedido automático" ativo={aceitarAuto} onToggle={toggleAceitarAuto} />
              {aceitarAuto && (
                <p style={{ fontSize: 11, color: '#a16207', lineHeight: 1.4, margin: '-4px 0 0' }}>
                  ⚠️ Todo pedido novo é aceito sozinho, sem revisar. Bom pra quem confia no fluxo (ex.: iFood/app).
                </p>
              )}
              <ToggleRow label="Som de novo pedido" ativo={somAtivo} onToggle={toggleSom} />

              <button type="button" onClick={imprimirTeste} style={{
                padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: 'var(--primary, #7c3aed)', color: '#fff', fontWeight: 700, fontSize: 14,
              }}>
                Imprimir cupom de teste
              </button>
            </div>
          )}

          {/* Painel: Pedidos finalizados (histórico + reimpressão) */}
          {painelDireito === 'pedidos' && (
            loadingHist ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Carregando...</div>
            ) : historico.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Nenhum pedido finalizado ainda.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {historico.map(p => {
                  const st = BADGE_STATUS_COR[p.status] ?? BADGE_STATUS_COR.entregue
                  return (
                    <div key={p.id} style={{
                      border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '10px 12px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                          #{p.numero_pedido ?? p.id.slice(-4).toUpperCase()} · {fmt(p.total)}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: st.bg, color: st.color }}>
                          {LABEL_STATUS[p.status] ?? p.status}
                        </span>
                      </div>
                      <button type="button" onClick={() => reimprimirPedido(p)} title="Reimprimir cupom"
                        style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', borderRadius: 8, cursor: 'pointer', padding: 6, color: 'var(--text-muted)', flexShrink: 0 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="6 9 6 2 18 2 18 9"/>
                          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                          <rect x="6" y="14" width="12" height="8"/>
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          )}

          {/* Painel: Catálogo (pausar/ativar itens da loja online) */}
          {painelDireito === 'catalogo' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Pause um item quando ele acabar — ele <strong>some da loja online na hora</strong>. Reative quando voltar ao estoque.
              </p>
              <input
                type="search"
                value={buscaCatalogo}
                onChange={e => setBuscaCatalogo(e.target.value)}
                placeholder="Buscar produto..."
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
                  color: 'var(--text)', fontSize: 13,
                }}
              />
              {loadingCatalogo ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Carregando...</div>
              ) : catalogoFiltrado.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>
                  {buscaCatalogo ? 'Nada encontrado.' : 'Nenhum item cadastrado.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {catalogoPorCategoria(catalogoFiltrado).map(({ categoria, itens }) => (
                  <div key={categoria} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Cabeçalho da categoria: gruda no topo enquanto rola, senão
                        numa lista longa some e o lojista perde onde está.
                        Clicar abre/fecha — durante uma busca fica tudo aberto,
                        senão o resultado ficaria escondido atrás da categoria. */}
                    <button
                      type="button"
                      onClick={() => toggleCategoriaCat(categoria)}
                      aria-expanded={!!buscaCat || catCatsAbertas.has(categoria)}
                      style={{
                        position: 'sticky', top: 0, zIndex: 2,
                        background: 'var(--surface, #16161f)',
                        border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer',
                        padding: '8px 2px', margin: '0 -2px',
                        display: 'flex', alignItems: 'center', gap: 8,
                        fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em',
                        textTransform: 'uppercase', color: 'var(--primary, #7c3aed)',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                        style={{ flexShrink: 0, transform: (!!buscaCat || catCatsAbertas.has(categoria)) ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} aria-hidden="true">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                      {categoria}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 0, textTransform: 'none' }}>
                        {itens.length}
                      </span>
                      <span style={{ flex: 1, height: 1, background: 'var(--border, #2a2a3a)' }} />
                    </button>
                  {(!!buscaCat || catCatsAbertas.has(categoria)) && itens.map(prod => {
                    const pausado = prod.disponivel_delivery === false
                    const prodBate = bateProduto(prod)
                    const grupos = gruposDaBusca(prod.id, prodBate)
                    const temComp = grupos.length > 0
                    // Quando o produto entrou na lista por causa de um complemento,
                    // já abre o accordion — senão o lojista busca e não vê o que achou.
                    const achouNoComp = !!buscaCat && !prodBate && temComp
                    const aberto = catExpandido.has(prod.id) || achouNoComp
                    return (
                      <div key={prod.id} style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, overflow: 'hidden' }}>
                        {/* Linha do produto */}
                        <div style={{
                          padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                          opacity: pausado ? 0.6 : 1,
                        }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', lineHeight: 1.25 }}>
                              {prod.nome}
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              {fmt(prod.preco_venda)}{prod.categoria ? ` · ${prod.categoria}` : ''}
                              {pausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            {temComp && (
                              <button
                                type="button"
                                onClick={() => toggleExpandirCat(prod.id)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                                  fontWeight: 700, fontSize: 12, border: '1.5px solid',
                                  borderColor: aberto ? '#2563eb' : 'var(--border, #2a2a3a)',
                                  background: aberto ? 'rgba(37,99,235,.12)' : 'transparent',
                                  color: aberto ? '#2563eb' : 'var(--text-muted)',
                                }}
                                title="Ver e pausar os complementos"
                              >
                                Complementos
                                <span style={{ fontSize: 10, fontWeight: 800, background: 'rgba(148,163,184,.25)', borderRadius: 20, padding: '0 6px' }}>{grupos.length}</span>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                                  style={{ transform: aberto ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} aria-hidden="true">
                                  <polyline points="6 9 12 15 18 9" />
                                </svg>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => togglePausarProduto(prod)}
                              disabled={pausandoId === prod.id}
                              style={{
                                padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                                fontWeight: 700, fontSize: 12, border: '1.5px solid',
                                borderColor: pausado ? '#16a34a' : '#dc2626',
                                background: pausado ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                                color: pausado ? '#16a34a' : '#dc2626',
                              }}
                            >
                              {pausandoId === prod.id ? '...' : pausado ? 'Ativar' : 'Pausar'}
                            </button>
                          </div>
                        </div>

                        {/* Complementos aninhados (grupos + opções) */}
                        {temComp && aberto && (
                          <div style={{ borderTop: '1px solid var(--border, #2a2a3a)', background: 'rgba(148,163,184,.05)', padding: '6px 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {grupos.map(g => {
                              const gPausado = g.disponivel === false
                              const qtd = g.max > 1 ? `escolha até ${g.max}` : (g.min > 0 ? 'obrigatório' : 'opcional')
                              return (
                                <div key={g.id} style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 8, overflow: 'hidden', opacity: gPausado ? 0.6 : 1 }}>
                                  {/* Cabeçalho do grupo (subcategoria) */}
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 10px', background: 'var(--bg, #0f0f1a)' }}>
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text)' }}>
                                        {g.nome}
                                        {gPausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                                      </div>
                                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                                        {qtd} · {g.opcoes.length}
                                        {g.totalOpcoes ? ` de ${g.totalOpcoes}` : ''} {g.opcoes.length === 1 ? 'opção' : 'opções'}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => togglePausarGrupo(prod.id, g)}
                                      disabled={pausandoId === g.id}
                                      style={{
                                        flexShrink: 0, padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
                                        fontWeight: 700, fontSize: 11.5, border: '1.5px solid',
                                        borderColor: gPausado ? '#16a34a' : '#dc2626',
                                        background: gPausado ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                                        color: gPausado ? '#16a34a' : '#dc2626',
                                      }}
                                    >
                                      {pausandoId === g.id ? '...' : gPausado ? 'Ativar grupo' : 'Pausar grupo'}
                                    </button>
                                  </div>
                                  {/* Opções do grupo */}
                                  {g.opcoes.map(op => {
                                    const oPausado = op.disponivel === false
                                    return (
                                      <div key={op.id} style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                                        padding: '6px 10px', borderTop: '1px solid var(--border, #2a2a3a)', opacity: oPausado ? 0.55 : 1,
                                      }}>
                                        <div style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          {op.nome}
                                          {Number(op.preco_adicional) > 0 && <span style={{ color: 'var(--text-muted)' }}> · +{fmt(op.preco_adicional)}</span>}
                                          {oPausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => togglePausarOpcao(prod.id, g.id, op)}
                                          disabled={pausandoId === op.id}
                                          style={{
                                            flexShrink: 0, padding: '4px 10px', borderRadius: 7, cursor: 'pointer',
                                            fontWeight: 700, fontSize: 11, border: '1.5px solid',
                                            borderColor: oPausado ? '#16a34a' : '#dc2626',
                                            background: oPausado ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                                            color: oPausado ? '#16a34a' : '#dc2626',
                                          }}
                                        >
                                          {pausandoId === op.id ? '...' : oPausado ? 'Ativar' : 'Pausar'}
                                        </button>
                                      </div>
                                    )
                                  })}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Painel: Concluídos do dia */}
          {painelDireito === 'hoje' && (
            loadingHoje ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Carregando...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Resumo do dia */}
                <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '12px 14px', background: 'rgba(34,197,94,.08)' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>
                    {concluidosHoje.length} pedido{concluidosHoje.length !== 1 ? 's' : ''} concluído{concluidosHoje.length !== 1 ? 's' : ''} hoje
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#16a34a', marginTop: 2 }}>
                    {fmt(concluidosHoje.reduce((s, p) => s + Number(p.total || 0), 0))}
                  </div>
                </div>

                {concluidosHoje.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>
                    Nenhum pedido concluído hoje ainda.
                  </div>
                ) : (
                  concluidosHoje.map(p => {
                    const oc = ORIGEM_CONFIG[p.origem] ?? ORIGEM_CONFIG.cardapio
                    return (
                      <div key={p.id} style={{
                        border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '10px 12px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                            #{p.numero_pedido ?? p.id.slice(-4).toUpperCase()} · {fmt(p.total)}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {new Date(p.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: oc.bg, color: oc.color }}>
                            {oc.label}
                          </span>
                        </div>
                        <button type="button" onClick={() => reimprimirPedido(p)} title="Reimprimir cupom"
                          style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', borderRadius: 8, cursor: 'pointer', padding: 6, color: 'var(--text-muted)', flexShrink: 0 }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="6 9 6 2 18 2 18 9"/>
                            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                            <rect x="6" y="14" width="12" height="8"/>
                          </svg>
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
            )
          )}

          {/* Painel: Entregadores (contagem + histórico por motoboy) */}
          {painelDireito === 'entregadores' && (() => {
            const emRota = (id) => pedidos.filter(p => p.entregador_id === id && p.status === 'saiu_entrega')
            const concluidas = (id) => entregasConcluidas.filter(p => p.entregador_id === id)

            if (entregadores.length === 0) {
              return (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24, fontSize: 13 }}>
                  Nenhum entregador cadastrado. Cadastre em Funcionários (perfil Entregador).
                </div>
              )
            }

            // Detalhe de um entregador (histórico)
            if (entregadorSel) {
              const ent = entregadores.find(e => e.id === entregadorSel)
              const rota = emRota(entregadorSel)
              const concl = concluidas(entregadorSel).filter(p => dentroDoPeriodo(p.created_at, 'hoje'))
              const pendentes = concl.filter(p => !p.entregador_pago)
              const pagos = concl.filter(p => p.entregador_pago)
              // Ganho LÍQUIDO do motoqueiro: taxa cheia, menos o desconto SÓ nas do iFood.
              const descValor = (ent?.entregador_desconto_ativo && Number(ent?.entregador_desconto_valor) > 0) ? Number(ent.entregador_desconto_valor) : 0
              const ganho = p => Math.max(0, Number(p.taxa_entrega || 0) - (p.origem === 'ifood' ? descValor : 0))
              const somaTaxa = arr => arr.reduce((s, p) => s + ganho(p), 0)
              // Pagamento do CLIENTE: o motoqueiro cobrou na entrega (dinheiro/cartão)
              // ou já estava pago (PIX confirmado / iFood)?
              const pagCliente = p => {
                const f = p.forma_pagamento
                const ehIfood = p.origem === 'ifood'
                if (f === 'dinheiro') return { pago: false, label: 'Dinheiro' + (ehIfood ? ' (via iFood)' : '') }
                if (['cartao', 'cartão', 'credito', 'debito'].includes(f)) {
                  const n = f === 'debito' ? 'Débito' : f === 'credito' ? 'Crédito' : 'Cartão'
                  return { pago: false, label: n + (ehIfood ? ' (via iFood)' : ' (maquininha)') }
                }
                if (f === 'vale') return { pago: false, label: 'Vale' + (ehIfood ? ' (via iFood)' : '') }
                if (f === 'pix') return (p.pix_status === 'pago' || p.mp_payment_status === 'approved') ? { pago: true, label: 'PIX pago' } : { pago: false, label: 'PIX não confirmado' }
                // PIX na entrega cai direto na conta da loja — o motoqueiro não
                // fica com nada na mão, então não entra no repasse.
                if (f === 'pix_entrega') return { pago: true, label: 'PIX na entrega (direto pra loja)' }
                // iFood com forma não mapeada ("outro") = cobrar na entrega, não "pago".
                if (ehIfood && f !== 'online') return { pago: false, label: (f || 'via iFood') + ' (via iFood)' }
                return { pago: true, label: ehIfood ? 'Pago no iFood' : (f || 'Pago') }
              }
              const dataDe = p => new Date(p.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
              const agrupaPorData = arr => {
                const g = {}
                for (const p of arr) (g[dataDe(p)] ??= []).push(p)
                return Object.entries(g)
              }
              const OrderRow = (p, { pago = false, rota: ehRota = false } = {}) => {
                const pgc = pagCliente(p)
                // Taxa a pagar ao motoqueiro: laranja enquanto pendente, verde quando pago.
                const corTaxa = ehRota ? '#7c3aed' : (pago ? '#16a34a' : '#f59e0b')
                return (
                <div key={p.id} style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '9px 11px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>#{p.numero_pedido ?? p.id.slice(-4).toUpperCase()}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 13, color: corTaxa }}
                        title={p.origem === 'ifood' && descValor > 0 ? `Taxa ${fmt(p.taxa_entrega)} − iFood ${fmt(descValor)}` : 'Taxa de entrega'}>{fmt(ganho(p))}</strong>
                      {!ehRota && (pago
                        ? <span style={{ fontSize: 11, fontWeight: 800, color: '#16a34a', background: 'rgba(34,197,94,.14)', padding: '2px 8px', borderRadius: 20 }}>✓ Pago</span>
                        : <button type="button" onClick={() => pagarCorridas([p.id])}
                            style={{ fontSize: 11, fontWeight: 800, color: '#16a34a', background: 'rgba(34,197,94,.12)', border: '1px solid #22c55e', borderRadius: 20, padding: '2px 10px', cursor: 'pointer' }}>
                            Pagar
                          </button>)}
                    </div>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                    {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
                    {p.origem === 'ifood' && descValor > 0 && <span style={{ color: '#f59e0b' }}> · iFood −{fmt(descValor)}</span>}
                  </div>
                  {/* Valor do pedido: laranja = cobrar na entrega; verde = já pago */}
                  <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, display: 'flex', justifyContent: 'space-between', gap: 8, color: pgc.pago ? '#16a34a' : '#f59e0b' }}>
                    <span>{pgc.pago ? '✓ Pago' : '💵 Cobrar na entrega'} · {pgc.label}</span>
                    <span>{fmt(p.total)}</span>
                  </div>
                </div>
                )
              }
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <button type="button" onClick={() => setEntregadorSel(null)}
                    style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--primary, #a78bfa)', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 0 }}>
                    ← Todos os entregadores
                  </button>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{ent?.nome || 'Entregador'} <span style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed' }}>· hoje</span></div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    Histórico completo (7/30 dias, tudo) em <b>Vendas → Entregadores</b>.
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[['A receber', fmt(somaTaxa(pendentes)), '#f59e0b'], ['Pago', fmt(somaTaxa(pagos)), '#16a34a'], ['Em rota', rota.length, '#7c3aed']].map(([lab, val, cor]) => (
                      <div key={lab} style={{ flex: 1, textAlign: 'center', border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '8px 4px' }}>
                        <div style={{ fontSize: 16, fontWeight: 800, color: cor }}>{val}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{lab}</div>
                      </div>
                    ))}
                  </div>

                  {/* Desconto que a loja fica por corrida — SÓ nas entregas do iFood */}
                  {ent?.entregador_desconto_ativo && Number(ent?.entregador_desconto_valor) > 0 && (() => {
                    const nIfood = concl.filter(p => p.origem === 'ifood').length
                    const valor = Number(ent.entregador_desconto_valor)
                    return (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(245,158,11,.12)', border: '1.5px solid #f59e0b', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                        <span>💰 Desconto da loja (só iFood): {nIfood} × {fmt(valor)}</span>
                        <strong style={{ color: '#f59e0b', fontSize: 14 }}>{fmt(nIfood * valor)}</strong>
                      </div>
                    )
                  })()}

                  {rota.length > 0 && (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginTop: 4 }}>Em rota agora</div>
                      {rota.map(p => OrderRow(p, { rota: true }))}
                    </>
                  )}

                  {/* A PAGAR (pendentes por data) */}
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#f59e0b', marginTop: 6 }}>
                    A pagar · {fmt(somaTaxa(pendentes))}
                  </div>
                  {pendentes.length === 0
                    ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Tudo acertado. 🎉</div>
                    : agrupaPorData(pendentes).map(([data, ps]) => (
                      <div key={data} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>{data} · {ps.length} corrida{ps.length > 1 ? 's' : ''} · {fmt(somaTaxa(ps))}</span>
                          <button type="button" onClick={() => pagarCorridas(ps.map(p => p.id))}
                            style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: '#16a34a', border: 'none', borderRadius: 20, padding: '3px 12px', cursor: 'pointer' }}>
                            Pagar todas
                          </button>
                        </div>
                        {ps.map(p => OrderRow(p, { pago: false }))}
                      </div>
                    ))}

                  {/* PAGAS (por data) */}
                  <div style={{ fontSize: 13, fontWeight: 800, color: '#16a34a', marginTop: 10 }}>
                    Pagas · {fmt(somaTaxa(pagos))}
                  </div>
                  {pagos.length === 0
                    ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nenhuma corrida paga ainda.</div>
                    : agrupaPorData(pagos).map(([data, ps]) => (
                      <div key={data} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', marginTop: 2 }}>{data} · {ps.length} corrida{ps.length > 1 ? 's' : ''} · {fmt(somaTaxa(ps))}</div>
                        {ps.map(p => OrderRow(p, { pago: true }))}
                      </div>
                    ))}
                </div>
              )
            }

            // Lista de todos os entregadores com os números
            const totRota = entregadores.reduce((s, e) => s + emRota(e.id).length, 0)
            const totConcl = entregadores.reduce((s, e) => s + concluidas(e.id).filter(p => dentroDoPeriodo(p.created_at, 'hoje')).length, 0)
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Total de TODOS os entregadores (hoje) */}
                <div style={{ border: '2px solid #7c3aed', borderRadius: 12, padding: '12px 14px', background: 'rgba(124,58,237,.08)' }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>📊 Todos os entregadores — hoje</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'rgba(124,58,237,.15)', color: '#7c3aed', fontWeight: 700 }}>Rota {totRota}</span>
                    <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'rgba(34,197,94,.14)', color: '#16a34a', fontWeight: 700 }}>Concl. {totConcl}</span>
                    <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'var(--border, #2a2a3a)', color: 'var(--text)', fontWeight: 800 }}>Total {totRota + totConcl}</span>
                  </div>
                </div>
                {entregadores.map(e => {
                  const r = emRota(e.id).length
                  // No gestor o resumo é só do DIA (histórico completo fica em Vendas → Entregadores)
                  const c = concluidas(e.id).filter(p => dentroDoPeriodo(p.created_at, 'hoje')).length
                  return (
                    <button key={e.id} type="button" onClick={() => setEntregadorSel(e.id)}
                      style={{ textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border, #2a2a3a)', borderRadius: 12, padding: '12px 14px', background: 'transparent' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>🛵 {e.nome || 'Entregador'}</div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'rgba(124,58,237,.15)', color: '#7c3aed', fontWeight: 700 }}>Rota {r}</span>
                        <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'rgba(34,197,94,.14)', color: '#16a34a', fontWeight: 700 }}>Concl. {c}</span>
                        <span style={{ flex: 1, textAlign: 'center', fontSize: 12, padding: '4px 0', borderRadius: 8, background: 'var(--border, #2a2a3a)', color: 'var(--text)', fontWeight: 700 }}>Total {r + c}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          })()}
        </aside>
      )}

      {/* ── Sacola do atendente, COLADA na gaveta de mensagens ──
           Fica à esquerda dela: a conversa continua inteira na tela e ele
           monta o pedido olhando o que o cliente escreveu. ── */}
      {telaGrande && painelDireito === 'chat' && threadAberta && sacolaLateral && (
        <aside style={{
          position: 'fixed', top: 60, bottom: 0, zIndex: 39,
          right: 'calc(min(50vw, calc(100vw - 80px)) + 56px)',
          width: 'min(440px, 34vw)',
          background: 'var(--surface, #16161f)', borderLeft: '1px solid var(--border, #2a2a3a)',
          boxShadow: '-8px 0 24px rgba(0,0,0,.25)', overflowY: 'auto', padding: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
              🛒 Sacola do cliente
            </h3>
            <button type="button" onClick={() => setSacolaLateral(false)} aria-label="Fechar"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1 }}>
              ×
            </button>
          </div>

          <BuscaProdutoNoChat
            empresaId={empresa?.id}
            onEscolher={escolherProdutoNoChat}
            onAvulso={item => setSacolaChat(prev => [...prev, item])}
            semBotao
          />

          {sacolaChat.length === 0 ? (
            <div style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 14, lineHeight: 1.5 }}>
              Procure o produto acima e clique pra jogar aqui.<br />
              Não achou? Ponha o preço e mande mesmo sem cadastro.
            </div>
          ) : (
            <>
              <SacolaNoChat
                itens={sacolaChat}
                onQtd={mudarQtdSacola}
                onQtdDireta={definirQtdSacola}
                onRemover={idx => mudarQtdSacola(idx, -999)}
                onEnviar={enviarSacolaDoChat}
                enviando={enviandoSacola}
              />
              {/* Endereço, pagamento e o botão que joga no sistema. `key` no
                  telefone: trocou de conversa, formulário novo — senão o
                  endereço de um cliente ia parar no pedido do outro. */}
              <FecharPedidoNoChat
                key={threadAberta?.cliente_ref}
                empresa={empresa}
                telefone={threadAberta?.cliente_ref}
                nomeThread={threadAberta?.cliente_nome}
                itens={sacolaChat}
                onFinalizar={finalizarPedidoDoChat}
                salvando={salvandoPedidoChat}
                cadastroVersao={cadastroVersao}
              />
            </>
          )}
        </aside>
      )}

      {/* ── Barra de ações do gestor. No computador fica na lateral direita;
           no celular o CSS vira barra INFERIOR, que é onde o polegar alcança
           (ver .pp-rail em PainelPedidos.css). ── */}
      <nav className="pp-rail" style={{
        position: 'fixed', top: 60, right: 0, bottom: 0, width: 56, zIndex: 40,
        background: 'var(--surface, #16161f)', borderLeft: '1px solid var(--border, #2a2a3a)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 0',
      }}>
        {RIGHTBAR_BOTOES.map(b => {
          const ativo = painelDireito === b.id
          return (
            <button key={b.id} type="button" title={b.label}
              onClick={() => setPainelDireito(prev => prev === b.id ? null : b.id)}
              style={{
                position: 'relative',
                width: 44, height: 48, borderRadius: 10, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
                border: `1px solid ${ativo ? 'var(--primary, #7c3aed)' : 'transparent'}`,
                background: ativo ? 'rgba(124,58,237,.15)' : 'transparent',
                color: ativo ? 'var(--primary, #a78bfa)' : 'var(--text-muted, #9aa0b5)',
              }}>
              {b.icon}
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.02em' }}>{b.label}</span>
              {/* Chamado de atendente é ALARME, não recado: ganha sino e pisca.
                  Mensagem comum é só o número. */}
              {b.id === 'chat' && (chatNaoLidas + chamados.length) > 0 && (
                <span className={chamados.length ? 'pp-sino-alerta' : undefined} style={{
                  position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, borderRadius: 8,
                  background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, padding: '0 4px',
                }}>
                  {chamados.length > 0 && <span style={{ fontSize: 9 }}>🔔</span>}
                  {chatNaoLidas + chamados.length}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* ── MESAS / SALÃO em painel. Cobre da esquerda até ANTES da barra de menu
           da direita (56px), pra ela continuar acessível. "← Pedidos" volta pro grid. ── */}
      {painelDireito === 'salao' && (
        <div className="pp-salao" style={{
          position: 'fixed', top: 0, left: 0, right: 56, bottom: 0, zIndex: 60,
          background: 'var(--bg, #0f1420)', display: 'flex', flexDirection: 'column',
        }}>
          {/* Sub-abas + voltar: tudo do salão no mesmo canto. No celular vira
              uma faixa só, que rola na horizontal (ver .pp-salao-tabs no CSS). */}
          <div className="pp-salao-tabs" style={{
            display: 'flex', gap: 6, padding: '10px 14px', flexWrap: 'wrap', alignItems: 'center',
            borderBottom: '1px solid var(--border, #2a2a3a)', background: 'var(--surface, #16161f)',
          }}>
            <button type="button" onClick={() => setPainelDireito(null)}
              style={{
                padding: '7px 14px', borderRadius: 9, fontWeight: 800, fontSize: 13, cursor: 'pointer',
                border: '1.5px solid var(--primary, #7c3aed)', background: 'var(--primary, #7c3aed)', color: '#fff',
              }}>
              <span className="pp-rot-longo">← Pedidos</span>
              <span className="pp-rot-curto">←</span>
            </button>
            <span className="pp-rot-longo" style={{ fontWeight: 800, fontSize: 15, margin: '0 8px' }}>🍽️ Salão</span>
            {[
              // `curto` é o que aparece no celular: com o nome inteiro os botões
              // não cabiam na tela e "Histórico" ficava escondido fora da borda.
              { id: 'salao', label: 'Salão / Mesas', curto: '🍽️ Mesas' },
              // A Cozinha estava só no portal (/presencial/cozinha). Quem fica no
              // celular preso na impressora tinha que SAIR do gestor pra marcar
              // pronto e voltar pra imprimir — e nesse vai-e-volta saía comanda
              // sem imprimir. Agora é a mesma tela, aqui dentro.
              // O número é o que falta preparar. Sem ele, quem está no Salão não
              // vê a cozinha encher — e a ideia toda é não precisar ficar
              // trocando de tela pra saber.
              { id: 'cozinha', label: '👨‍🍳 Cozinha', curto: '👨‍🍳 Cozinha', count: itensNaCozinha },
              { id: 'caixa', label: '💵 Caixa', curto: '💵 Caixa' },
              { id: 'historico', label: 'Histórico', curto: 'Histórico' },
              { id: 'reservas', label: 'Reservas', curto: 'Reservas' },
              { id: 'mesas', label: 'Configurar mesas', curto: '⚙️ Config.' },
            ].map(t => (
              <button key={t.id} type="button" onClick={() => setSubAbaSalao(t.id)}
                style={{
                  padding: '7px 14px', borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                  border: `1.5px solid ${subAbaSalao === t.id ? 'var(--primary, #7c3aed)' : 'var(--border, #2a2a3a)'}`,
                  background: subAbaSalao === t.id ? 'rgba(124,58,237,.15)' : 'transparent',
                  color: subAbaSalao === t.id ? 'var(--primary, #a78bfa)' : 'var(--text)',
                }}>
                <span className="pp-rot-longo">{t.label}</span>
                <span className="pp-rot-curto">{t.curto}</span>
                {t.count > 0 && (
                  <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 900, padding: '1px 7px',
                    borderRadius: 999, background: '#f59e0b', color: '#1a1200' }}>{t.count}</span>
                )}
              </button>
            ))}
          </div>
          {/* Conteúdo da sub-aba */}
          <div className="pp-salao-body" style={{ flex: 1, overflow: 'auto' }}>
            {subAbaSalao === 'salao' && <PresencialSalao />}
            {subAbaSalao === 'cozinha' && <PresencialCozinha embutido />}
            {subAbaSalao === 'caixa' && <Caixa />}
            {subAbaSalao === 'historico' && <PresencialHistorico />}
            {subAbaSalao === 'reservas' && <PresencialReservas />}
            {subAbaSalao === 'mesas' && <PresencialMesas />}
          </div>
        </div>
      )}

    </div>
  )
}
