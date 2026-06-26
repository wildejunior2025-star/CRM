import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'
import './BotTeste.css'

const TEST_PHONE = '5500000000001'

// ── Ícones SVG inline ──────────────────────────────────────────────────────────

function BotIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <path d="M12 11V7" />
      <circle cx="12" cy="5" r="2" />
      <path d="M8 15h.01M16 15h.01" />
    </svg>
  )
}

function SendIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function TrashIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  )
}

function AlertTriangleIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

// ── Mapeamento de badge por agente ──────────────────────────────────────────────

const AGENT_CONFIG = {
  AgenteCardapio:  { label: 'Cardápio',   cls: 'cardapio'  },
  AgenteCadastro:  { label: 'Cadastro',   cls: 'cadastro'  },
  AgentePagamento: { label: 'Pagamento',  cls: 'pagamento' },
  AgenteAvaliacao: { label: 'Avaliação',  cls: 'avaliacao' },
  Claude:          { label: 'Claude',     cls: 'claude'    },
}

function AgentBadge({ agente }) {
  if (!agente) return null
  const cfg = AGENT_CONFIG[agente] || { label: agente, cls: 'claude' }
  return (
    <span className={`bot-teste-agent-badge bot-teste-agent-badge--${cfg.cls}`}>
      {cfg.label}
    </span>
  )
}

// ── Formatar hora HH:MM ────────────────────────────────────────────────────────

function formatTime(date) {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// ── Componente principal ───────────────────────────────────────────────────────

export default function BotTeste() {
  const [instancias, setInstancias]     = useState([])
  const [instanciaId, setInstanciaId]   = useState('')
  const [loadingInst, setLoadingInst]   = useState(true)
  const [messages, setMessages]         = useState([])
  const [input, setInput]               = useState('')
  const [sending, setSending]           = useState(false)
  const [clearing, setClearing]         = useState(false)

  const messagesEndRef = useRef(null)
  const inputRef       = useRef(null)

  // Scroll para o final ao adicionar mensagem
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Buscar instâncias ativas
  useEffect(() => {
    async function fetchInstancias() {
      setLoadingInst(true)
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('id, instance_name, empresa_id, empresas(nome)')
        .eq('ativo', true)

      if (!error && data) {
        setInstancias(data)
        if (data.length === 1) setInstanciaId(data[0].id)
      }
      setLoadingInst(false)
    }
    fetchInstancias()
  }, [])

  const instanciaSelecionada = instancias.find((i) => i.id === instanciaId)

  // Limpar conversa de teste
  async function handleLimpar() {
    if (!instanciaSelecionada) return
    if (!window.confirm('Limpar o histórico de conversa de teste desta instância?')) return

    setClearing(true)
    await supabase
      .from('whatsapp_conversas')
      .delete()
      .eq('phone', TEST_PHONE)
      .eq('empresa_id', instanciaSelecionada.empresa_id)

    setMessages([])
    setClearing(false)
    inputRef.current?.focus()
  }

  // Enviar mensagem ao bot
  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || sending || !instanciaSelecionada) return

    const userMsg = {
      id: Date.now(),
      role: 'user',
      text,
      time: new Date(),
    }

    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setSending(true)

    const payload = {
      _test: true,
      event: 'messages.upsert',
      instance: instanciaSelecionada.instance_name,
      data: {
        key: {
          remoteJid: `${TEST_PHONE}@s.whatsapp.net`,
          fromMe: false,
        },
        messageType: 'conversation',
        message: {
          conversation: text,
        },
      },
    }

    try {
      const { data: fnData, error: fnError } = await supabase.functions.invoke('whatsapp-webhook', {
        body: payload,
        headers: { 'x-bot-test': '1' },
      })

      let botText = null
      let agente  = null

      if (fnError) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'error',
            text: `Erro da edge function: ${fnError.message}`,
            time: new Date(),
          },
        ])
        setSending(false)
        return
      }

      if (fnData) {
        botText = fnData.resposta ?? fnData.reply ?? fnData.message ?? null
        agente  = fnData.agente_ativo ?? fnData.agente ?? null
        if (!botText && typeof fnData === 'string') botText = fnData
        if (!botText && fnData.erro === 'claude') {
          botText = `❌ Erro Anthropic (HTTP ${fnData.status}): ${fnData.detalhe ?? 'sem detalhe'}`
        }
        if (!botText && fnData.ok === false && fnData.erro) {
          botText = `❌ Erro: ${fnData.erro}${fnData.detalhe ? ' — ' + fnData.detalhe : ''}`
        }
      }

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'bot',
          text: botText ?? '(sem resposta no body — verifique o log da edge function)',
          agente,
          time: new Date(),
        },
      ])
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'error',
          text: `Falha de rede: ${err.message}`,
          time: new Date(),
        },
      ])
    } finally {
      setSending(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [input, sending, instanciaSelecionada])

  // Enter para enviar (Shift+Enter = nova linha)
  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Auto-resize do textarea
  function handleInput(e) {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
  }

  const canSend = input.trim().length > 0 && !sending && !!instanciaSelecionada

  return (
    <div className="bot-teste-page">
      {/* ── Header ── */}
      <div className="bot-teste-header">
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 20, fontWeight: 700 }}>
            <BotIcon size={22} />
            Teste do Bot WhatsApp
          </h1>
          <div className="bot-teste-toolbar">
            <select
              className="bot-teste-select"
              value={instanciaId}
              onChange={(e) => {
                setInstanciaId(e.target.value)
                setMessages([])
              }}
              disabled={loadingInst}
              aria-label="Selecionar instância"
            >
              <option value="">
                {loadingInst ? 'Carregando instâncias…' : 'Selecionar instância / loja'}
              </option>
              {instancias.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.instance_name}
                  {inst.empresas?.nome ? ` — ${inst.empresas.nome}` : ''}
                </option>
              ))}
            </select>

            <button
              className="btn btn-secondary btn-sm"
              onClick={handleLimpar}
              disabled={!instanciaSelecionada || clearing}
              title="Apaga o histórico de conversa do número de teste no banco"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
            >
              <TrashIcon size={13} />
              {clearing ? 'Limpando…' : 'Limpar conversa'}
            </button>
          </div>
        </div>

        {!instanciaSelecionada && !loadingInst && instancias.length === 0 && (
          <div className="bot-teste-notice">
            <AlertTriangleIcon size={15} />
            Nenhuma instância WhatsApp ativa encontrada. Configure uma em Configurações &gt; WhatsApp.
          </div>
        )}

        {!instanciaSelecionada && !loadingInst && instancias.length > 0 && (
          <div className="bot-teste-notice">
            <AlertTriangleIcon size={15} />
            Selecione uma instância para começar a testar o bot.
          </div>
        )}
      </div>

      {/* ── Chat card ── */}
      <div className="bot-teste-chat-card">
        {/* Header do "contato" simulado */}
        <div className="bot-teste-chat-header">
          <div className="bot-teste-chat-avatar">
            <BotIcon size={18} />
          </div>
          <div className="bot-teste-chat-info">
            <div className="bot-teste-chat-name">
              Bot {instanciaSelecionada ? `— ${instanciaSelecionada.instance_name}` : ''}
            </div>
            <div className="bot-teste-chat-status">
              <span className="bot-teste-status-dot" />
              {instanciaSelecionada
                ? `Número de teste: ${TEST_PHONE}`
                : 'Selecione uma instância para iniciar'}
            </div>
          </div>
          {instanciaSelecionada && (
            <span className="badge badge-success" style={{ fontSize: 11 }}>
              Conectado
            </span>
          )}
        </div>

        {/* Área de mensagens */}
        <div className="bot-teste-messages">
          {messages.length === 0 ? (
            <div className="bot-teste-empty">
              <div className="bot-teste-empty-icon">
                <BotIcon size={22} />
              </div>
              <p>
                {instanciaSelecionada
                  ? 'Digite uma mensagem abaixo para testar o bot.\nAs respostas aparecerão aqui em tempo real.'
                  : 'Selecione uma instância no topo para começar.'}
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`bot-teste-msg bot-teste-msg--${msg.role}`}
              >
                {msg.role === 'bot' && msg.agente && (
                  <AgentBadge agente={msg.agente} />
                )}
                <div className="bot-teste-bubble">{msg.text}</div>
                <span className="bot-teste-msg-time">{formatTime(msg.time)}</span>
              </div>
            ))
          )}

          {/* Indicador "digitando..." */}
          {sending && (
            <div className="bot-teste-typing">
              <span className="bot-teste-typing-label">Bot digitando</span>
              <div className="bot-teste-typing-dots">
                <span /><span /><span />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="bot-teste-input-area">
          <textarea
            ref={inputRef}
            className="bot-teste-input"
            placeholder={
              instanciaSelecionada
                ? 'Digite uma mensagem… (Enter para enviar, Shift+Enter para nova linha)'
                : 'Selecione uma instância primeiro'
            }
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={!instanciaSelecionada || sending}
            rows={1}
            aria-label="Mensagem de teste"
          />
          <button
            className="bot-teste-send-btn"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="Enviar mensagem"
            title="Enviar (Enter)"
          >
            {sending ? (
              <div className="bot-teste-send-spinner" />
            ) : (
              <SendIcon size={15} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
