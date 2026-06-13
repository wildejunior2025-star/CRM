import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './WhatsAppConfig.css'

function WhatsAppIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}

const DEFAULT_MSG_PEDIDO = 'Olá {nome}! Seu pedido foi recebido com sucesso. Em breve entraremos em contato para confirmar a entrega.'
const DEFAULT_MSG_FIADO  = 'Olá {nome}! Você tem um saldo em aberto de R$ {valor}. Entre em contato para regularizar.'

const NOTIF_DEFAULTS = {
  notif_pedido:  true,
  notif_fiado:   false,
  notif_estoque: false,
  admin_phone:   '',
  msg_pedido:    DEFAULT_MSG_PEDIDO,
  msg_fiado:     DEFAULT_MSG_FIADO,
}

export default function WhatsAppConfig() {
  const { profile } = useAuth()

  // ── Estado de conexão ──
  const [connStatus, setConnStatus] = useState('loading') // 'loading'|'connected'|'disconnected'|'connecting'
  const [connPhone,  setConnPhone]  = useState(null)
  const [qrCode,     setQrCode]     = useState(null)
  const [connError,  setConnError]  = useState(null)
  const [disconnecting, setDisconnecting] = useState(false)

  // ── Configurações de notificação ──
  const [form,    setForm]    = useState(NOTIF_DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)

  const pollRef = useRef(null)

  useEffect(() => {
    if (!profile?.empresa_id) return
    loadConfig()
    checkStatus()
    return () => stopPolling()
  }, [profile?.empresa_id])

  async function loadConfig() {
    setLoading(true)
    const { data } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('empresa_id', profile.empresa_id)
      .single()
    if (data) {
      setForm({
        notif_pedido:  data.notif_pedido  ?? true,
        notif_fiado:   data.notif_fiado   ?? false,
        notif_estoque: data.notif_estoque ?? false,
        admin_phone:   data.admin_phone   ?? '',
        msg_pedido:    data.msg_pedido    ?? DEFAULT_MSG_PEDIDO,
        msg_fiado:     data.msg_fiado     ?? DEFAULT_MSG_FIADO,
      })
    }
    setLoading(false)
  }

  async function checkStatus() {
    setConnStatus('loading')
    const { data, error } = await supabase.functions.invoke('whatsapp-connect', {
      body: { action: 'status' },
    })
    if (error || !data || data.state === 'not_found' || data.state === 'error' || data.state === 'close') {
      setConnStatus('disconnected')
      return
    }
    if (data.state === 'open') {
      setConnStatus('connected')
      setConnPhone(data.phone)
    } else {
      setConnStatus('disconnected')
    }
  }

  function startPolling() {
    stopPolling()
    pollRef.current = setInterval(async () => {
      const { data } = await supabase.functions.invoke('whatsapp-connect', {
        body: { action: 'status' },
      })
      if (data?.state === 'open') {
        stopPolling()
        setConnStatus('connected')
        setConnPhone(data.phone)
        setQrCode(null)
        loadConfig()
      }
    }, 4000)
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  async function handleConnect() {
    setConnStatus('connecting')
    setConnError(null)
    setQrCode(null)

    const { data, error } = await supabase.functions.invoke('whatsapp-connect', {
      body: { action: 'connect' },
    })

    if (error || data?.error) {
      setConnError(error?.message ?? data?.error ?? 'Erro desconhecido')
      setConnStatus('disconnected')
      return
    }

    if (data?.connected) {
      setConnStatus('connected')
      setConnPhone(data.phone)
      loadConfig()
      return
    }

    if (data?.qrcode) {
      setQrCode(data.qrcode)
      startPolling()
    }
  }

  async function handleDisconnect() {
    if (!confirm('Desconectar este WhatsApp? O número será desvinculado.')) return
    setDisconnecting(true)
    await supabase.functions.invoke('whatsapp-connect', {
      body: { action: 'disconnect' },
    })
    setDisconnecting(false)
    setConnStatus('disconnected')
    setConnPhone(null)
    setQrCode(null)
    stopPolling()
    loadConfig()
  }

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setSaveMsg(null)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!profile?.empresa_id) return
    setSaving(true)
    setSaveMsg(null)

    const { error } = await supabase.from('whatsapp_config').upsert(
      { empresa_id: profile.empresa_id, ...form },
      { onConflict: 'empresa_id' }
    )

    setSaving(false)
    if (error) {
      setSaveMsg({ type: 'error', text: error.message })
    } else {
      setSaveMsg({ type: 'success', text: 'Configurações salvas.' })
      setTimeout(() => setSaveMsg(null), 3500)
    }
  }

  const isConnected   = connStatus === 'connected'
  const isConnecting  = connStatus === 'connecting'
  const isLoading     = connStatus === 'loading'

  return (
    <div className="wa-config-page">
      <div className="wa-header">
        <h1>WhatsApp</h1>
        <span className={`wa-status-pill ${isConnected ? 'ativo' : 'inativo'}`}>
          {isConnected ? 'Conectado' : 'Desconectado'}
        </span>
      </div>

      {/* ── Seção Conexão ── */}
      <div className="wa-section">
        <h2 className="wa-section-title">
          <WhatsAppIcon size={15} />
          Conexão WhatsApp
        </h2>

        {isLoading && (
          <p className="wa-hint" style={{ textAlign: 'center', padding: '16px 0' }}>
            Verificando conexão...
          </p>
        )}

        {/* Conectado */}
        {isConnected && (
          <div className="wa-conn-connected">
            <div className="wa-conn-badge">
              <CheckIcon />
              WhatsApp conectado
            </div>
            {connPhone && (
              <p className="wa-conn-phone">
                Número: <strong>+{connPhone}</strong>
              </p>
            )}
            <p className="wa-hint">
              As mensagens enviadas pelo CRM saem deste número para os seus clientes.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 8 }}
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? 'Desconectando...' : 'Desvincular WhatsApp'}
            </button>
          </div>
        )}

        {/* Desconectado — sem QR ainda */}
        {!isLoading && !isConnected && !qrCode && (
          <div className="wa-conn-disconnected">
            <p className="wa-hint" style={{ marginBottom: 16 }}>
              Conecte o WhatsApp da sua empresa para enviar mensagens automáticas para seus clientes.
              Cada loja usa o seu próprio número.
            </p>
            {connError && (
              <div className="wa-test-result error" style={{ marginBottom: 12 }}>
                <AlertIcon />
                {connError}
              </div>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleConnect}
              disabled={isConnecting}
            >
              {isConnecting ? 'Gerando QR Code...' : 'Conectar meu WhatsApp'}
            </button>
          </div>
        )}

        {/* QR Code */}
        {qrCode && !isConnected && (
          <div className="wa-qr-widget">
            <p className="wa-qr-steps">
              <strong>Como conectar:</strong><br />
              1. Abra o WhatsApp no celular<br />
              2. Toque em <strong>Dispositivos conectados</strong><br />
              3. Toque em <strong>Conectar um dispositivo</strong><br />
              4. Aponte a câmera para o QR Code abaixo
            </p>
            <img
              src={qrCode}
              alt="QR Code WhatsApp"
              className="wa-qr-img"
            />
            <p className="wa-hint wa-qr-polling">
              Aguardando leitura do QR Code...
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { stopPolling(); setQrCode(null); setConnStatus('disconnected') }}
            >
              Cancelar
            </button>
          </div>
        )}
      </div>

      {/* ── Seção Notificações ── */}
      <form onSubmit={handleSave}>
        <div className="wa-section">
          <h2 className="wa-section-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            Notificações automáticas
          </h2>

          {loading ? (
            <p className="wa-hint">Carregando...</p>
          ) : (
            <div className="wa-fields">
              <label className="wa-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.notif_pedido}
                  onChange={(e) => setField('notif_pedido', e.target.checked)}
                />
                <div className="wa-checkbox-text">
                  <span>Avisar cliente ao fazer pedido no portal</span>
                  <small>Envia confirmação automática quando o pedido é finalizado.</small>
                </div>
              </label>

              <label className="wa-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.notif_fiado}
                  onChange={(e) => setField('notif_fiado', e.target.checked)}
                />
                <div className="wa-checkbox-text">
                  <span>Habilitar cobranças de fiado via WhatsApp</span>
                  <small>Ativa o botão de cobrança na página Financeiro.</small>
                </div>
              </label>

              <label className="wa-checkbox-row">
                <input
                  type="checkbox"
                  checked={form.notif_estoque}
                  onChange={(e) => setField('notif_estoque', e.target.checked)}
                />
                <div className="wa-checkbox-text">
                  <span>Alerta de estoque baixo no WhatsApp</span>
                  <small>Envia mensagem no seu número quando produto precisar de reposição.</small>
                </div>
              </label>

              {form.notif_estoque && (
                <div className="wa-input-group">
                  <label htmlFor="wa-admin-phone">Seu número para receber alertas</label>
                  <input
                    id="wa-admin-phone"
                    type="tel"
                    placeholder="84999999999"
                    value={form.admin_phone}
                    onChange={(e) => setField('admin_phone', e.target.value)}
                  />
                  <span className="wa-hint">DDD + número, sem espaços. Ex: 84998180774</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Modelos de mensagem ── */}
        <div className="wa-section">
          <h2 className="wa-section-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Modelos de mensagem
          </h2>

          <div className="wa-fields">
            <div className="wa-input-group">
              <label htmlFor="wa-msg-pedido">Confirmação de pedido</label>
              <textarea
                id="wa-msg-pedido"
                rows={3}
                value={form.msg_pedido}
                onChange={(e) => setField('msg_pedido', e.target.value)}
                placeholder={DEFAULT_MSG_PEDIDO}
              />
              <div className="wa-vars-hint">
                <span className="wa-hint">Variáveis:</span>
                <span className="wa-var-tag">{'{nome}'}</span>
              </div>
            </div>

            <div className="wa-input-group">
              <label htmlFor="wa-msg-fiado">Cobrança de fiado</label>
              <textarea
                id="wa-msg-fiado"
                rows={3}
                value={form.msg_fiado}
                onChange={(e) => setField('msg_fiado', e.target.value)}
                placeholder={DEFAULT_MSG_FIADO}
              />
              <div className="wa-vars-hint">
                <span className="wa-hint">Variáveis:</span>
                <span className="wa-var-tag">{'{nome}'}</span>
                <span className="wa-var-tag">{'{valor}'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Ações ── */}
        <div className="wa-form-actions">
          {saveMsg && (
            <div className={`wa-test-result ${saveMsg.type}`}>
              {saveMsg.type === 'success' ? <CheckIcon /> : <AlertIcon />}
              {saveMsg.text}
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={saving || loading}>
            {saving ? 'Salvando...' : 'Salvar configurações'}
          </button>
        </div>
      </form>
    </div>
  )
}
