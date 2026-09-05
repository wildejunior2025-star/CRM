import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { conectarWhatsAppCloud } from '../lib/waEmbeddedSignup'
import { useAuth } from '../hooks/useAuth'
import { TEXTO_PRIMEIRA_FALA_PADRAO, montarPrimeiraFala } from '../lib/primeiraFala'
import '../components/Page.css'
import './WhatsAppConfig.css'

const CLOUD_HABILITADO = !!import.meta.env.VITE_WA_CONFIG_ID

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
  notif_fiado_compra: false,
  notif_estoque: false,
  admin_phone:   '',
  msg_pedido:    DEFAULT_MSG_PEDIDO,
  msg_fiado:     DEFAULT_MSG_FIADO,
}

export default function WhatsAppConfig() {
  const { profile } = useAuth()

  // ── Estado de conexão (Evolution / QR) ──
  const [connStatus, setConnStatus] = useState('loading') // 'loading'|'connected'|'disconnected'|'connecting'
  const [connPhone,  setConnPhone]  = useState(null)
  const [qrCode,     setQrCode]     = useState(null)
  const [connError,  setConnError]  = useState(null)
  const [disconnecting, setDisconnecting] = useState(false)

  // ── Estado da conexão Cloud API (Meta oficial) ──
  const [cloudPhone,  setCloudPhone]  = useState(null)  // número de exibição salvo
  const [cloudName,   setCloudName]   = useState(null)
  const [cloudBusy,   setCloudBusy]   = useState(false)
  const [cloudError,  setCloudError]  = useState(null)

  // ── Configurações de notificação ──
  const [form,    setForm]    = useState(NOTIF_DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)

  // ── Créditos WhatsApp ──
  const [creditos, setCreditos] = useState(null)

  // ── Vendedor IA ──
  const [iaAtivo,         setIaAtivo]         = useState(false)
  // Resposta automática com o link do cardápio (mig 0226). Vive fora do robô de
  // IA de propósito: não gasta crédito e não precisa aprender nada.
  const [linkAtivo,       setLinkAtivo]       = useState(false)
  const [salvandoLink,    setSalvandoLink]    = useState(false)
  const [linkMsg,         setLinkMsg]         = useState(null)
  // Texto da primeira fala. Vazio = o padrão da casa; cada loja fala do seu jeito.
  const [linkTexto,       setLinkTexto]       = useState('')
  const [salvandoTexto,   setSalvandoTexto]   = useState(false)
  const [textoMsg,        setTextoMsg]        = useState(null)
  const [iaNome,          setIaNome]          = useState('Assistente')
  const [iaInstrucoes,    setIaInstrucoes]    = useState('')
  const [savingIa,        setSavingIa]        = useState(false)
  const [iaSaveMsg,       setIaSaveMsg]       = useState(null)
  const [gerandoRoteiro,  setGerandoRoteiro]  = useState(false)
  const [empresaData,     setEmpresaData]     = useState(null)

  const pollRef    = useRef(null)
  const qrRefRef   = useRef(null)

  useEffect(() => {
    if (!profile?.empresa_id) return
    loadConfig()
    checkStatus()
    return () => stopPolling()
  }, [profile?.empresa_id])

  async function loadConfig() {
    setLoading(true)

    const [{ data }, { data: empresa }, { data: produtos }] = await Promise.all([
      supabase.from('whatsapp_config').select('*').eq('empresa_id', profile.empresa_id).single(),
      supabase.from('empresas').select('*').eq('id', profile.empresa_id).single(),
      supabase.from('produtos').select('nome, preco_venda, embalagem').eq('empresa_id', profile.empresa_id).eq('ativo', true).limit(20),
    ])
    if (empresa) setEmpresaData(empresa)

    if (data) {
      setForm({
        notif_pedido:  data.notif_pedido  ?? true,
        notif_fiado:   data.notif_fiado   ?? false,
        notif_fiado_compra: data.notif_fiado_compra ?? false,
        notif_estoque: data.notif_estoque ?? false,
        admin_phone:   data.admin_phone   ?? '',
        msg_pedido:    data.msg_pedido    ?? DEFAULT_MSG_PEDIDO,
        msg_fiado:     data.msg_fiado     ?? DEFAULT_MSG_FIADO,
      })
      setIaAtivo(data.ia_ativo ?? false)
      setLinkAtivo(data.resposta_link_ativo ?? false)
      setLinkTexto(data.resposta_link_texto ?? '')
      setIaNome(data.ia_nome ?? 'Assistente')
      setIaInstrucoes(data.ia_instrucoes ?? '')
      // Carrega phone salvo no banco como fallback
      if (data.connected_phone && !connPhone) {
        setConnPhone(data.connected_phone)
      }
      // Conexão Cloud API já feita?
      if (data.cloud_phone_number_id) {
        setCloudPhone(data.cloud_display_number ?? null)
        setCloudName(data.cloud_verified_name ?? null)
      } else {
        setCloudPhone(null)
        setCloudName(null)
      }
    }

    if (empresa) setCreditos(empresa.whatsapp_creditos ?? 0)

    setLoading(false)
  }

  async function checkStatus(retry = true) {
    setConnStatus('loading')
    const { data, error } = await supabase.functions.invoke('whatsapp-connect', {
      body: { action: 'status' },
    })

    // Só conta como conectado quando VEM O NÚMERO. "open" sem número é conexão
    // fantasma (pareamento interrompido — ex.: atualizou a tela no meio do QR):
    // aparece verde mas não recebe mensagem. Sem número → não é conectado.
    if (data?.state === 'open' && data.phone) {
      setConnStatus('connected')
      setConnPhone(data.phone)
      return
    }

    // Estados transitórios OU fantasma (open sem número): tenta mais uma vez após 3s
    if (retry && (error || !data || data.state === 'close' || data.state === 'error' || (data.state === 'open' && !data.phone))) {
      await new Promise(r => setTimeout(r, 3000))
      return checkStatus(false)
    }

    if (data?.state === 'not_found') {
      setConnStatus('disconnected')
    } else {
      setConnStatus('disconnected')
    }
  }

  function startPolling() {
    stopPolling()
    // Verifica status a cada 4s para detectar quando conectar
    pollRef.current = setInterval(async () => {
      const { data } = await supabase.functions.invoke('whatsapp-connect', {
        body: { action: 'status' },
      })
      // Só encerra o pareamento como sucesso quando o número confirmar. "open"
      // sem número ainda não firmou (segue tentando até o número vir ou o QR renovar).
      if (data?.state === 'open' && data.phone) {
        stopPolling()
        setConnStatus('connected')
        setConnPhone(data.phone)
        setQrCode(null)
        loadConfig()
      }
    }, 4000)

    // Renova o QR a cada 25s (QR codes do WhatsApp expiram em ~30s)
    qrRefRef.current = setInterval(async () => {
      const { data } = await supabase.functions.invoke('whatsapp-connect', {
        body: { action: 'connect' },
      })
      if (data?.connected) {
        stopPolling()
        setConnStatus('connected')
        setConnPhone(data.phone)
        setQrCode(null)
        loadConfig()
      } else if (data?.qrcode) {
        setQrCode(data.qrcode)
      }
    }, 25000)
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (qrRefRef.current) {
      clearInterval(qrRefRef.current)
      qrRefRef.current = null
    }
  }

  async function refreshQr() {
    const { data } = await supabase.functions.invoke('whatsapp-connect', {
      body: { action: 'connect' },
    })
    if (data?.connected) {
      stopPolling()
      setConnStatus('connected')
      setConnPhone(data.phone)
      setQrCode(null)
      loadConfig()
    } else if (data?.qrcode) {
      setQrCode(data.qrcode)
    }
  }

  async function handleConnect() {
    const confirmado = window.confirm(
      'Atenção: Se este WhatsApp já estiver conectado em outro computador, conectar novamente pode encerrar a sessão anterior.\n\nDeseja continuar?'
    )
    if (!confirmado) return

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

  // Fecha a conexão a partir do que a Meta devolveu. Fica separado porque roda
  // em dois momentos: no fluxo normal e quando o código chega atrasado, depois
  // de a tela já ter avisado que desistiu de esperar.
  async function finalizarConexaoCloud({ code, phone_number_id, waba_id }) {
    setCloudBusy(true)
    setCloudError(null)
    try {
      const { data, error } = await supabase.functions.invoke('whatsapp-cloud-signup', {
        body: { code, phone_number_id, waba_id },
      })
      if (error || data?.error) {
        // Em erro HTTP o supabase-js devolve só "non-2xx status code" e joga o
        // corpo pra dentro do `context` — que é onde está a explicação de
        // verdade. Sem isto a loja (e o suporte) ficam sem saber o que houve.
        let msg = data?.error ?? error?.message ?? 'Erro ao conectar.'
        try {
          const corpo = await error?.context?.json?.()
          if (corpo?.error) msg = corpo.error
        } catch { /* corpo não era JSON — fica a mensagem genérica */ }
        throw new Error(msg)
      }
      setCloudPhone(data.display_number ?? null)
      setCloudName(data.verified_name ?? null)
      loadConfig()
    } catch (e) {
      setCloudError(e.message ?? String(e))
    } finally {
      setCloudBusy(false)
    }
  }

  async function handleConnectCloud() {
    setCloudBusy(true)
    setCloudError(null)
    try {
      // Popup da Meta — lojista conecta o próprio número. `onCodigo` recolhe o
      // código que chegar tarde demais pra promessa, pra loja não perder o que
      // já fez só porque demorou.
      const dados = await conectarWhatsAppCloud({ onCodigo: finalizarConexaoCloud })
      await finalizarConexaoCloud(dados)
    } catch (e) {
      setCloudError(e.message ?? String(e))
      setCloudBusy(false)
    }
  }

  async function handleDisconnectCloud() {
    if (!confirm('Desconectar o WhatsApp (Cloud API) desta loja? O robô para de responder até reconectar.')) return
    setCloudBusy(true)
    setCloudError(null)
    // O mesmo cuidado do lado de lá (whatsapp-connect/disconnect): as duas
    // conexões dividem o `ativo`, então tirar a Meta não pode derrubar um QR
    // que esteja funcionando. Só apaga o interruptor quando não sobra conexão.
    const { data: cfgAtual } = await supabase
      .from('whatsapp_config').select('instance_name')
      .eq('empresa_id', profile.empresa_id).maybeSingle()
    const seguePeloQr = !!String(cfgAtual?.instance_name ?? '').trim()

    const { error } = await supabase
      .from('whatsapp_config')
      .update({ cloud_phone_number_id: null, cloud_display_number: null, ativo: seguePeloQr })
      .eq('empresa_id', profile.empresa_id)
    setCloudBusy(false)
    if (error) { setCloudError(error.message); return }
    setCloudPhone(null)
    setCloudName(null)
    loadConfig()
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

  async function gerarRoteiro() {
    setGerandoRoteiro(true)

    // Só gera regras de comportamento — produtos, preços, taxa de entrega,
    // horário e formas de pagamento já são injetados automaticamente pelo sistema.
    const roteiro = [
      `- Atenda sempre com simpatia e rapidez. Use emojis com moderação. 😊`,
      `- Se o cliente pedir desconto, informe que não é possível sem autorização do responsável.`,
      `- Para reclamações ou problemas com pedido: peça desculpas, acolha o cliente e diga que o responsável entrará em contato.`,
      `- Se o cliente perguntar algo que você não sabe responder, diga: "Vou verificar com o responsável e retorno em breve! 😊"`,
      `- Nunca invente informações que não estejam nos dados da loja.`,
      ``,
      `💡 Dicas do que você pode adicionar manualmente:`,
      `- Promoções ativas (ex: "Compre 10 leve 12 até sexta-feira!")`,
      `- Produtos em falta (ex: "Sabor Manga esgotado essa semana")`,
      `- Regras específicas da loja (ex: "Não fazemos entregas fora da cidade X")`,
      `- Tom de voz (ex: "Chame o cliente sempre pelo nome")`,
    ].join('\n')

    setIaInstrucoes(roteiro)
    setIaSaveMsg({ type: 'success', text: 'Roteiro gerado! Revise e clique em Salvar roteiro.' })
    setTimeout(() => setIaSaveMsg(null), 4000)
    setGerandoRoteiro(false)
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

  async function handleToggleIa(novoValor) {
    setIaAtivo(novoValor)
    setSavingIa(true)
    setIaSaveMsg(null)
    const { error } = await supabase
      .from('whatsapp_config')
      .upsert({ empresa_id: profile.empresa_id, ia_ativo: novoValor }, { onConflict: 'empresa_id' })
    setSavingIa(false)
    if (error) {
      setIaSaveMsg({ type: 'error', text: error.message })
      setIaAtivo(!novoValor)
    } else {
      setIaSaveMsg({ type: 'success', text: novoValor ? 'Vendedor IA ativado.' : 'Vendedor IA desativado.' })
      setTimeout(() => setIaSaveMsg(null), 2500)
    }
  }

  async function handleToggleLink(novoValor) {
    setLinkAtivo(novoValor)
    setSalvandoLink(true)
    setLinkMsg(null)
    const { error } = await supabase
      .from('whatsapp_config')
      .upsert({ empresa_id: profile.empresa_id, resposta_link_ativo: novoValor }, { onConflict: 'empresa_id' })
    setSalvandoLink(false)
    if (error) {
      setLinkMsg({ type: 'error', text: error.message })
      setLinkAtivo(!novoValor)
      return
    }
    setLinkMsg({ type: 'success', text: novoValor ? 'Resposta automática ligada.' : 'Resposta automática desligada.' })
    setTimeout(() => setLinkMsg(null), 2500)
  }

  async function handleSalvarTexto(novo) {
    setSalvandoTexto(true)
    setTextoMsg(null)
    const { error } = await supabase
      .from('whatsapp_config')
      // Texto vazio volta pro padrão da casa — é o mesmo que "não personalizei".
      .upsert({ empresa_id: profile.empresa_id, resposta_link_texto: novo.trim() || null }, { onConflict: 'empresa_id' })
    setSalvandoTexto(false)
    setTextoMsg(error
      ? { type: 'error', text: error.message }
      : { type: 'success', text: 'Mensagem salva. É ela que o cliente vai receber.' })
    if (!error) setTimeout(() => setTextoMsg(null), 3000)
  }

  async function handleSaveInstrucoes(e) {
    e.preventDefault()
    setSavingIa(true)
    setIaSaveMsg(null)
    const { error } = await supabase
      .from('whatsapp_config')
      .upsert({ empresa_id: profile.empresa_id, ia_nome: iaNome, ia_instrucoes: iaInstrucoes }, { onConflict: 'empresa_id' })
    setSavingIa(false)
    if (error) {
      setIaSaveMsg({ type: 'error', text: error.message })
    } else {
      setIaSaveMsg({ type: 'success', text: 'Roteiro salvo com sucesso.' })
      setTimeout(() => setIaSaveMsg(null), 2500)
    }
  }

  // `isConnected` é do QR e continua sendo: é ele que decide se mostra o
  // botão de conectar, o QR ou o número pareado.
  const isConnected   = connStatus === 'connected'
  const isConnecting  = connStatus === 'connecting'
  const isLoading     = connStatus === 'loading'
  // O selo lá em cima é outra coisa: ele responde "esta loja tem WhatsApp
  // ligado?". Olhava só o QR, então loja conectada pela Meta — que é o caminho
  // oficial — via "Desconectado" no topo e "WhatsApp conectado pela Meta" logo
  // abaixo, na mesma tela. Foi o que fez o lojista achar que o número caiu.
  const temWhatsApp   = isConnected || !!cloudPhone

  return (
    <div className="wa-config-page">
      <div className="wa-header">
        <h1>WhatsApp</h1>
        <span className={`wa-status-pill ${temWhatsApp ? 'ativo' : 'inativo'}`}>
          {temWhatsApp ? 'Conectado' : 'Desconectado'}
        </span>
      </div>

      {/* ── Seção Créditos WhatsApp ── */}
      <Link to="/whatsapp-creditos" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
        <div className="wa-section" style={{ cursor: 'pointer', transition: 'opacity 120ms' }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          <h2 className="wa-section-title" style={{ justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="16"/>
                <line x1="8" y1="12" x2="16" y2="12"/>
              </svg>
              Créditos WhatsApp
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 18l6-6-6-6"/>
            </svg>
          </h2>

          {creditos === null ? (
            <p className="wa-hint">Carregando saldo...</p>
          ) : (
            <div>
              <p style={{ fontSize: 15, marginBottom: 8 }}>
                Saldo: <strong>{creditos} mensagem{creditos !== 1 ? 's' : ''} disponíve{creditos !== 1 ? 'is' : 'l'}</strong>
              </p>
              {creditos === 0 && (
                <div className="wa-test-result error" style={{ marginTop: 4 }}>
                  <AlertIcon />
                  Sem créditos. Mensagens bloqueadas. Clique para recarregar.
                </div>
              )}
              {creditos > 0 && creditos < 10 && (
                <div className="wa-test-result" style={{ marginTop: 4, color: '#b45309', background: '#fffbeb', border: '1px solid #fcd34d' }}>
                  <AlertIcon />
                  Saldo baixo! Clique para recarregar.
                </div>
              )}
            </div>
          )}
        </div>
      </Link>

      {/* ── Seção Conexão Cloud API (Meta oficial) ── */}
      {CLOUD_HABILITADO && (
        <div className="wa-section">
          <h2 className="wa-section-title">
            <WhatsAppIcon size={15} />
            Conectar WhatsApp (oficial Meta)
          </h2>

          {cloudPhone ? (
            <div className="wa-conn-connected">
              <div className="wa-conn-badge">
                <CheckIcon />
                WhatsApp conectado pela Meta
              </div>
              <p className="wa-conn-phone">
                Número: <strong>{cloudPhone}</strong>
                {cloudName ? <> — {cloudName}</> : null}
              </p>
              <p className="wa-hint">
                O robô responde os clientes por este número — e você continua usando o
                WhatsApp Business no celular normalmente, com as mesmas conversas.
              </p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 8 }}
                onClick={handleDisconnectCloud}
                disabled={cloudBusy}
              >
                {cloudBusy ? 'Aguarde...' : 'Desconectar'}
              </button>
            </div>
          ) : (
            <div className="wa-conn-disconnected">
              <p className="wa-hint" style={{ marginBottom: 8 }}>
                Conecte o <strong>WhatsApp da sua loja</strong> — o mesmo número que você já usa.
                Você continua atendendo pelo celular, com as mesmas conversas e contatos, e o robô
                responde junto quando você não puder.
              </p>
              <p className="wa-hint" style={{ marginBottom: 16 }}>
                Antes de começar, deixe à mão: a <strong>senha do seu Facebook</strong> e o
                <strong> celular do número</strong> (a Meta manda um código por SMS). Leva uns 3 minutos.
                O app tem que ser o <strong>WhatsApp Business</strong>, não o WhatsApp comum.
              </p>
              {cloudError && (
                <div className="wa-test-result error" style={{ marginBottom: 12 }}>
                  <AlertIcon />
                  {cloudError}
                </div>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConnectCloud}
                disabled={cloudBusy}
              >
                {cloudBusy ? 'Conectando...' : 'Conectar meu WhatsApp'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Seção Conexão (Evolution / QR — modo alternativo) ── */}
      <div className="wa-section">
        <h2 className="wa-section-title">
          <WhatsAppIcon size={15} />
          {CLOUD_HABILITADO ? 'Conexão por QR (alternativa)' : 'Conexão WhatsApp'}
        </h2>

        {isLoading && (
          <p className="wa-hint" style={{ textAlign: 'center', padding: '16px 0' }}>
            Verificando conexão com o servidor... aguarde.
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
              Aguardando leitura do QR Code... (renova automaticamente)
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={refreshQr}
              >
                Atualizar QR
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { stopPolling(); setQrCode(null); setConnStatus('disconnected') }}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Resposta automática com o link (sem IA, sem crédito) ── */}
      <div className="wa-section">
        <h2 className="wa-section-title">🔗 Resposta automática com o cardápio</h2>

        <div className="wa-fields">
          <label className="wa-checkbox-row">
            <input
              type="checkbox"
              checked={linkAtivo}
              disabled={salvandoLink}
              onChange={(e) => handleToggleLink(e.target.checked)}
            />
            <div className="wa-checkbox-text">
              <span>Responder com o link do cardápio</span>
              <small>
                Cliente mandou mensagem e não tem ninguém no atendimento? O sistema responde
                na hora, em duas linhas: <em>"Oi! 👋 Peça aqui, é rapidinho:"</em> e o link do seu
                cardápio — <strong>já com o telefone dele</strong>, então o pedido abre com nome e
                endereço preenchidos. <strong>Não gasta crédito</strong>: é texto pronto, sem
                inteligência artificial. Responde no máximo uma vez a cada 6 horas por cliente,
                pra não virar spam.
              </small>
            </div>
          </label>

          {linkMsg && (
            <div className={`wa-test-result ${linkMsg.type}`} style={{ marginTop: 8 }}>
              {linkMsg.type === 'success' ? <CheckIcon /> : <AlertIcon />}
              {linkMsg.text}
            </div>
          )}

          {/* A primeira fala é a cara da loja. Cada uma fala do seu jeito — o
              padrão da casa fica de exemplo, e quem quiser escreve o dele. */}
          {linkAtivo && (
            <div className="wa-primeira-fala">
              <label htmlFor="wa-msg-boas-vindas" className="wa-primeira-fala-label">
                Mensagem de boas-vindas
              </label>
              <p className="wa-hint" style={{ margin: '2px 0 8px' }}>
                É o que o cliente recebe quando manda a primeira mensagem. Deixe em branco
                pra usar a nossa. Você pode usar:{' '}
                <code>{'{nome}'}</code> — o primeiro nome dele, quando já tem cadastro na loja
                (sem cadastro a mensagem sai sem o nome, sem ficar estranha) — e{' '}
                <code>{'{link}'}</code> — o link do seu cardápio já com o telefone dele. Se você
                não escrever <code>{'{link}'}</code>, ele entra no fim sozinho.
              </p>
              <textarea
                id="wa-msg-boas-vindas"
                className="wa-textarea"
                rows={6}
                value={linkTexto}
                onChange={e => setLinkTexto(e.target.value)}
                placeholder={TEXTO_PRIMEIRA_FALA_PADRAO}
              />

              <div className="wa-primeira-fala-acoes">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={salvandoTexto}
                  onClick={() => handleSalvarTexto(linkTexto)}
                >
                  {salvandoTexto ? 'Salvando...' : 'Salvar mensagem'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={salvandoTexto || !linkTexto.trim()}
                  onClick={() => { setLinkTexto(''); handleSalvarTexto('') }}
                >
                  Usar a mensagem padrão
                </button>
              </div>

              {textoMsg && (
                <div className={`wa-test-result ${textoMsg.type}`} style={{ marginTop: 8 }}>
                  {textoMsg.type === 'success' ? <CheckIcon /> : <AlertIcon />}
                  {textoMsg.text}
                </div>
              )}

              {/* Prévia dos dois casos, porque é onde o {nome} engana: a loja
                  escreve pensando em quem ela conhece e esquece de quem chega
                  pela primeira vez. */}
              <div className="wa-previa-grid">
                {[
                  { titulo: 'Cliente já cadastrado', nome: 'Ana' },
                  { titulo: 'Cliente novo (sem cadastro)', nome: '' },
                ].map(caso => (
                  <div key={caso.titulo} className="wa-previa">
                    <div className="wa-previa-titulo">{caso.titulo}</div>
                    <div className="wa-previa-balao">
                      {montarPrimeiraFala(
                        linkTexto,
                        caso.nome,
                        `https://lojaonline.fwcinter.com/${empresaData?.slug ?? 'sua-loja'}?t=84998180774`,
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Seção Vendedor IA ── */}
      <div className="wa-section">
        <h2 className="wa-section-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/>
            <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
            <line x1="9" y1="9" x2="9.01" y2="9"/>
            <line x1="15" y1="9" x2="15.01" y2="9"/>
          </svg>
          Vendedor IA
        </h2>

        <div className="wa-fields">
          <label className="wa-checkbox-row">
            <input
              type="checkbox"
              checked={iaAtivo}
              disabled={savingIa}
              onChange={(e) => handleToggleIa(e.target.checked)}
            />
            <div className="wa-checkbox-text">
              <span>Ativar vendedor IA no WhatsApp</span>
              <small>
                Quando ativo, o CRM responde automaticamente mensagens recebidas no WhatsApp,
                monta pedidos e atende clientes usando inteligência artificial.
                Consome 1 crédito por resposta enviada.
              </small>
            </div>
          </label>

          {iaSaveMsg && (
            <div className={`wa-test-result ${iaSaveMsg.type}`} style={{ marginTop: 8 }}>
              {iaSaveMsg.type === 'success' ? <CheckIcon /> : <AlertIcon />}
              {iaSaveMsg.text}
            </div>
          )}

          <div className="wa-input-group" style={{ marginTop: 16 }}>
            <label htmlFor="wa-ia-nome">Nome do vendedor IA</label>
            <input
              id="wa-ia-nome"
              type="text"
              maxLength={40}
              placeholder="Ex: Ana, João, Assistente FWC..."
              value={iaNome}
              onChange={(e) => setIaNome(e.target.value)}
            />
            <span className="wa-hint">
              Este é o nome com que a IA vai se apresentar para os clientes no WhatsApp.
            </span>
          </div>

        </div>
      </div>

      {/* ── Seção Roteiro do Vendedor IA ── */}
      <form onSubmit={handleSaveInstrucoes}>
        <div className="wa-section">
          <h2 className="wa-section-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
            </svg>
            Roteiro do Vendedor IA
          </h2>

          <p className="wa-hint" style={{ marginBottom: 14 }}>
            Escreva aqui as instruções personalizadas para o seu vendedor IA. Ele vai seguir este roteiro antes de responder qualquer cliente.
            Pode incluir: tom de voz, promoções ativas, condições de pagamento, política de entrega, como lidar com objeções, etc.
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={gerarRoteiro}
              disabled={gerandoRoteiro}
              style={{ fontSize: 13, padding: '6px 14px' }}
            >
              {gerandoRoteiro ? 'Gerando...' : '✨ Gerar roteiro automático'}
            </button>
          </div>

          <div className="wa-input-group">
            <textarea
              rows={10}
              value={iaInstrucoes}
              onChange={(e) => setIaInstrucoes(e.target.value)}
              placeholder={`Exemplos do que você pode escrever aqui:

- Nosso prazo de entrega é de 1 dia útil para pedidos feitos até as 14h.
- Aceitamos PIX, dinheiro e cartão na entrega.
- Temos promoção essa semana: compre 2 caixas de cerveja e ganhe 10% de desconto.
- Se o cliente perguntar sobre fiado, diga que o limite máximo é R$ 200.
- Sempre ofereça o produto mais vendido da semana: [nome do produto].
- Seja sempre animado e use emojis com moderação. 😊
- Se o cliente reclamar de algo, peça desculpas e ofereça uma solução.`}
            />
          </div>

          <div className="wa-form-actions" style={{ paddingTop: 12 }}>
            {iaSaveMsg && (
              <div className={`wa-test-result ${iaSaveMsg.type}`}>
                {iaSaveMsg.type === 'success' ? <CheckIcon /> : <AlertIcon />}
                {iaSaveMsg.text}
              </div>
            )}
            <button type="submit" className="btn btn-primary" disabled={savingIa}>
              {savingIa ? 'Salvando...' : 'Salvar roteiro'}
            </button>
          </div>
        </div>
      </form>

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
                  checked={form.notif_fiado_compra}
                  onChange={(e) => setField('notif_fiado_compra', e.target.checked)}
                />
                <div className="wa-checkbox-text">
                  <span>Mandar a comanda quando fechar no fiado</span>
                  <small>
                    Assim que a conta é fechada no fiado, o cliente recebe no WhatsApp o que foi
                    anotado, com item, valor e hora. Serve pra ele conferir no dia — depois de duas
                    semanas ninguém lembra se comprou ou se foi anotado errado. Só no fiado:
                    dinheiro, PIX e cartão não mandam nada.
                  </small>
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

              <div className="wa-input-group" style={{ marginTop: 12 }}>
                <label htmlFor="wa-admin-phone">Número do responsável (alertas e reclamações)</label>
                <input
                  id="wa-admin-phone"
                  type="tel"
                  placeholder="84999999999"
                  value={form.admin_phone}
                  onChange={(e) => setField('admin_phone', e.target.value)}
                />
                <span className="wa-hint">DDD + número, sem espaços. Ex: 84998180774. Usado para alertas de estoque e quando o bot escalar um problema para humano.</span>
              </div>
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
