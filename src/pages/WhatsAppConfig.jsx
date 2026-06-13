import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './WhatsAppConfig.css'

/* ── Ícone WhatsApp SVG (sem emoji) ── */
function WhatsAppIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/>
    </svg>
  )
}

function EyeIcon({ open }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
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

const FORM_DEFAULTS = {
  api_url:       '',
  api_key:       '',
  instance_name: '',
  ativo:         false,
  notif_pedido:  true,
  notif_fiado:   true,
  msg_pedido:    DEFAULT_MSG_PEDIDO,
  msg_fiado:     DEFAULT_MSG_FIADO,
}

export default function WhatsAppConfig() {
  const { profile } = useAuth()

  const [form, setForm]           = useState(FORM_DEFAULTS)
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [testing, setTesting]     = useState(false)
  const [saveMsg, setSaveMsg]     = useState(null)   // { type: 'success'|'error', text: string }
  const [testResult, setTestResult] = useState(null) // { type: 'success'|'error', text: string }
  const [showKey, setShowKey]     = useState(false)

  /* ── Carregar config ── */
  useEffect(() => {
    if (!profile?.empresa_id) return
    async function load() {
      setLoading(true)
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('empresa_id', profile.empresa_id)
        .single()

      if (!error && data) {
        setForm({
          api_url:       data.api_url       ?? '',
          api_key:       data.api_key       ?? '',
          instance_name: data.instance_name ?? '',
          ativo:         data.ativo         ?? false,
          notif_pedido:  data.notif_pedido  ?? true,
          notif_fiado:   data.notif_fiado   ?? true,
          msg_pedido:    data.msg_pedido     ?? DEFAULT_MSG_PEDIDO,
          msg_fiado:     data.msg_fiado      ?? DEFAULT_MSG_FIADO,
        })
      }
      // PGRST116 = row not found → usa defaults sem erro
      setLoading(false)
    }
    load()
  }, [profile?.empresa_id])

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
    setSaveMsg(null)
    setTestResult(null)
  }

  /* ── Salvar ── */
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
      setSaveMsg({ type: 'success', text: 'Configurações salvas com sucesso.' })
      setTimeout(() => setSaveMsg(null), 4000)
    }
  }

  /* ── Testar conexão ── */
  async function handleTestar() {
    if (!profile?.empresa_id) return
    setTesting(true)
    setTestResult(null)

    try {
      // Importa dinamicamente para não aumentar bundle se não houver arquivo ainda
      const { sendWhatsApp } = await import('../lib/whatsapp')
      await sendWhatsApp({
        phone: '5500000000000',
        message: 'Teste de conexão CRM Depósito',
        empresaId: profile.empresa_id,
      })
      setTestResult({ type: 'success', text: 'Conexão bem-sucedida! API respondeu corretamente.' })
    } catch (err) {
      setTestResult({ type: 'error', text: err?.message ?? 'Falha na conexão. Verifique URL, API Key e nome da instância.' })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="wa-config-page">
        <div className="wa-header">
          <h1>WhatsApp</h1>
        </div>
        <div className="wa-section">
          <div className="empty-state" style={{ padding: '32px 0' }}>Carregando configurações...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="wa-config-page">
      <div className="wa-header">
        <h1>WhatsApp</h1>
        <span className={`wa-status-pill ${form.ativo ? 'ativo' : 'inativo'}`}>
          {form.ativo ? 'WhatsApp Ativo' : 'WhatsApp Inativo'}
        </span>
      </div>

      <form onSubmit={handleSave}>
        {/* ── Seção Conexão ── */}
        <div className="wa-section">
          <h2 className="wa-section-title">
            <WhatsAppIcon size={15} />
            Conexão Evolution API
          </h2>

          <div className="wa-fields">
            {/* Toggle ativo */}
            <div className="wa-toggle-row">
              <span className="wa-toggle-label">Ativar integração WhatsApp</span>
              <label className="wa-toggle" aria-label="Ativar WhatsApp">
                <input
                  type="checkbox"
                  checked={form.ativo}
                  onChange={(e) => setField('ativo', e.target.checked)}
                />
                <span className="wa-toggle-track" />
              </label>
            </div>

            <div className="wa-input-group">
              <label htmlFor="wa-api-url">URL da API</label>
              <input
                id="wa-api-url"
                type="url"
                placeholder="https://evolution.suaempresa.com"
                value={form.api_url}
                onChange={(e) => setField('api_url', e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="wa-input-group">
              <label htmlFor="wa-api-key">API Key</label>
              <div className="wa-password-wrap">
                <input
                  id="wa-api-key"
                  type={showKey ? 'text' : 'password'}
                  placeholder="sua-api-key-aqui"
                  value={form.api_key}
                  onChange={(e) => setField('api_key', e.target.value)}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="wa-eye-btn"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? 'Ocultar chave' : 'Mostrar chave'}
                >
                  <EyeIcon open={showKey} />
                </button>
              </div>
            </div>

            <div className="wa-input-group">
              <label htmlFor="wa-instance">Nome da Instância</label>
              <input
                id="wa-instance"
                type="text"
                placeholder="minha-empresa"
                value={form.instance_name}
                onChange={(e) => setField('instance_name', e.target.value)}
              />
              <span className="wa-hint">Deve corresponder ao nome configurado na Evolution API.</span>
            </div>

            {/* Botão testar */}
            <div className="wa-test-row">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleTestar}
                disabled={testing || !form.api_url || !form.api_key || !form.instance_name}
              >
                {testing ? 'Testando...' : 'Testar conexão'}
              </button>

              {testResult && (
                <div className={`wa-test-result ${testResult.type}`}>
                  {testResult.type === 'success' ? <CheckIcon /> : <AlertIcon />}
                  {testResult.text}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Seção Notificações ── */}
        <div className="wa-section">
          <h2 className="wa-section-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            Notificações
          </h2>

          <div className="wa-fields">
            <label className="wa-checkbox-row">
              <input
                type="checkbox"
                checked={form.notif_pedido}
                onChange={(e) => setField('notif_pedido', e.target.checked)}
              />
              <div className="wa-checkbox-text">
                <span>Avisar cliente quando fizer pedido no portal</span>
                <small>Envia mensagem de confirmação automaticamente ao finalizar o pedido.</small>
              </div>
            </label>

            <label className="wa-checkbox-row">
              <input
                type="checkbox"
                checked={form.notif_fiado}
                onChange={(e) => setField('notif_fiado', e.target.checked)}
              />
              <div className="wa-checkbox-text">
                <span>Permitir cobranças de fiado via WhatsApp</span>
                <small>Habilita o botão de cobrança na página Financeiro.</small>
              </div>
            </label>
          </div>
        </div>

        {/* ── Seção Modelos de mensagem ── */}
        <div className="wa-section">
          <h2 className="wa-section-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            Modelos de mensagem
          </h2>

          <div className="wa-fields">
            <div className="wa-input-group">
              <label htmlFor="wa-msg-pedido">Mensagem de confirmação de pedido</label>
              <textarea
                id="wa-msg-pedido"
                rows={3}
                value={form.msg_pedido}
                onChange={(e) => setField('msg_pedido', e.target.value)}
                placeholder={DEFAULT_MSG_PEDIDO}
              />
              <div className="wa-vars-hint">
                <span className="wa-hint">Variáveis disponíveis:</span>
                <span className="wa-var-tag">{'{nome}'}</span>
              </div>
            </div>

            <div className="wa-input-group">
              <label htmlFor="wa-msg-fiado">Mensagem de cobrança de fiado</label>
              <textarea
                id="wa-msg-fiado"
                rows={3}
                value={form.msg_fiado}
                onChange={(e) => setField('msg_fiado', e.target.value)}
                placeholder={DEFAULT_MSG_FIADO}
              />
              <div className="wa-vars-hint">
                <span className="wa-hint">Variáveis disponíveis:</span>
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
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar configurações'}
          </button>
        </div>
      </form>
    </div>
  )
}
