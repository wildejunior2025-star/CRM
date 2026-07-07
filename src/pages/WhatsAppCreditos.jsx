import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const BRAND_LABEL = { visa: 'Visa', master: 'Mastercard', elo: 'Elo', amex: 'Amex', hipercard: 'Hipercard' }

async function callCreditos(action, body = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-creditos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, ...body }),
  })
  return res.json()
}

export default function WhatsAppCreditos() {
  const [dados, setDados]           = useState(null)
  const [loading, setLoading]       = useState(true)
  const [aba, setAba]               = useState('comprar') // 'comprar' | 'cartao' | 'auto' | 'historico'
  const [pacoteSel, setPacoteSel]   = useState(null)
  const [metodo, setMetodo]         = useState('pix')     // 'pix' | 'cartao'
  const [pixData, setPixData]       = useState(null)
  const [copiado, setCopiado]       = useState(false)
  const [processando, setProcessando] = useState(false)
  const [segRestante, setSegRestante] = useState(0)   // cronômetro do PIX (segundos)
  const [expirado, setExpirado]     = useState(false)
  const pollRef = useRef(null)
  const [msg, setMsg]               = useState(null)
  const [cvvInput, setCvvInput]     = useState('')

  // Card form
  const [cardNumber, setCardNumber] = useState('')
  const [cardName, setCardName]     = useState('')
  const [cardExpiry, setCardExpiry] = useState('')
  const [cardCvv, setCardCvv]       = useState('')
  const [cardCpf, setCardCpf]       = useState('')
  const mpRef = useRef(null)

  // Auto-recharge
  const [autoAtivo, setAutoAtivo]     = useState(false)
  const [autoMinimo, setAutoMinimo]   = useState(50)
  const [autoValor, setAutoValor]     = useState(50)
  const [savingAuto, setSavingAuto]   = useState(false)

  // Alerta de crédito baixo (avisa o dono, sem cobrar)
  const { empresa } = useAuth()
  const [alertaMinimo, setAlertaMinimo] = useState(20)
  const [savingAlerta, setSavingAlerta] = useState(false)

  async function load() {
    setLoading(true)
    const data = await callCreditos('get_balance')
    setDados(data)
    if (data.auto_recarga) {
      setAutoAtivo(data.auto_recarga.ativo)
      setAutoMinimo(data.auto_recarga.minimo)
      setAutoValor(data.auto_recarga.valor)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Carrega o mínimo do alerta de crédito baixo
  useEffect(() => {
    if (!empresa?.id) return
    supabase.from('empresas').select('credito_alerta_minimo').eq('id', empresa.id).single()
      .then(({ data }) => { if (data && data.credito_alerta_minimo != null) setAlertaMinimo(data.credito_alerta_minimo) })
  }, [empresa?.id])

  async function handleSalvarAlerta() {
    if (!empresa?.id) return
    setSavingAlerta(true)
    const val = Math.max(0, Number(alertaMinimo) || 0)
    const { error } = await supabase.from('empresas').update({ credito_alerta_minimo: val, credito_alerta_enviado: false }).eq('id', empresa.id)
    setSavingAlerta(false)
    setMsg(error ? { tipo: 'erro', texto: error.message } : { tipo: 'ok', texto: val > 0 ? `Alerta ligado: avisa abaixo de ${val} créditos.` : 'Alerta desligado.' })
  }

  // Quando PIX está aberto, consulta saldo a cada 5s até ser pago
  useEffect(() => {
    if (!pixData) { clearInterval(pollRef.current); return }
    pollRef.current = setInterval(async () => {
      const data = await callCreditos('get_balance')
      if ((data.creditos ?? 0) > (dados?.creditos ?? 0)) {
        setDados(data)
        setPixData(null)
        setMsg({ tipo: 'ok', texto: `✅ Pagamento confirmado! +${pacoteSel?.creditos ?? 0} créditos adicionados.` })
        clearInterval(pollRef.current)
      }
    }, 5000)
    return () => clearInterval(pollRef.current)
  }, [pixData])

  // Cronômetro do PIX — conta regressiva até expira_em; ao zerar, marca expirado e para de esperar
  useEffect(() => {
    if (!pixData?.expira_em) { setSegRestante(0); return }
    setExpirado(false)
    const alvo = new Date(pixData.expira_em).getTime()
    const tick = () => {
      const s = Math.max(0, Math.round((alvo - Date.now()) / 1000))
      setSegRestante(s)
      if (s <= 0) { setExpirado(true); clearInterval(pollRef.current) }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [pixData])

  // Carrega SDK do Mercado Pago
  useEffect(() => {
    const existing = document.getElementById('mp-sdk')
    if (existing) { initMP(); return }
    const script = document.createElement('script')
    script.id  = 'mp-sdk'
    script.src = 'https://sdk.mercadopago.com/js/v2'
    script.onload = initMP
    document.head.appendChild(script)
  }, [])

  function initMP() {
    const pubKey = import.meta.env.VITE_MP_PUBLIC_KEY
    if (pubKey && window.MercadoPago) {
      mpRef.current = new window.MercadoPago(pubKey)
    }
  }

  // Formata número do cartão
  function handleCardNumber(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 16)
    setCardNumber(v.replace(/(.{4})/g, '$1 ').trim())
  }
  function handleExpiry(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 4)
    setCardExpiry(v.length > 2 ? `${v.slice(0,2)}/${v.slice(2)}` : v)
  }

  async function handleComprar() {
    if (!pacoteSel) { setMsg({ tipo: 'erro', texto: 'Selecione um pacote.' }); return }
    setProcessando(true); setMsg(null); setPixData(null)

    if (metodo === 'pix') {
      const data = await callCreditos('buy_pix', { creditos: pacoteSel.creditos })
      if (data.error) { setMsg({ tipo: 'erro', texto: data.error }); setProcessando(false); return }
      setPixData(data)
    } else {
      if (!mpRef.current) { setMsg({ tipo: 'erro', texto: 'SDK do MP não carregado. Recarregue a página.' }); setProcessando(false); return }
      if (!dados?.cartao) { setMsg({ tipo: 'erro', texto: 'Salve um cartão primeiro na aba "Meu Cartão".' }); setProcessando(false); return }
      if (!cvvInput || cvvInput.length < 3) { setMsg({ tipo: 'erro', texto: 'Digite o CVV do cartão.' }); setProcessando(false); return }
      try {
        const tokenData = await mpRef.current.createCardToken({
          cardId:       dados.cartao.card_id,
          securityCode: cvvInput,
        })
        const data = await callCreditos('charge_card', { creditos: pacoteSel.creditos, token: tokenData.id })
        if (data.error) { setMsg({ tipo: 'erro', texto: data.error }); setProcessando(false); return }
        if (data.ok) {
          setMsg({ tipo: 'ok', texto: `+${pacoteSel.creditos} créditos adicionados com sucesso!` })
          setCvvInput('')
          load()
        } else {
          const detalhe = data.mp_message || data.mp_error || data.detail || data.status
          setMsg({ tipo: 'erro', texto: `Cobrança recusada: ${detalhe}` })
        }
      } catch (err) {
        setMsg({ tipo: 'erro', texto: err?.message ?? 'Erro ao tokenizar CVV.' })
      }
    }
    setProcessando(false)
  }

  async function handleSalvarCartao(e) {
    e.preventDefault()
    if (!mpRef.current) { setMsg({ tipo: 'erro', texto: 'SDK MP não carregado. Recarregue a página.' }); return }
    setProcessando(true); setMsg(null)
    try {
      const [mes, ano] = cardExpiry.split('/')
      const tokenData = await mpRef.current.createCardToken({
        cardNumber:            cardNumber.replace(/\s/g, ''),
        cardholderName:        cardName,
        cardExpirationMonth:   mes,
        cardExpirationYear:    `20${ano}`,
        securityCode:          cardCvv,
        identificationType:    'CPF',
        identificationNumber:  cardCpf.replace(/\D/g, ''),
      })
      const data = await callCreditos('save_card', { card_token: tokenData.id, cpf: cardCpf })
      if (data.error) { setMsg({ tipo: 'erro', texto: data.error }); setProcessando(false); return }
      setMsg({ tipo: 'ok', texto: `Cartão ${BRAND_LABEL[data.brand] ?? data.brand} ****${data.last4} salvo!` })
      setCardNumber(''); setCardName(''); setCardExpiry(''); setCardCvv(''); setCardCpf('')
      load()
    } catch (err) {
      setMsg({ tipo: 'erro', texto: err?.message ?? 'Erro ao tokenizar cartão.' })
    }
    setProcessando(false)
  }

  async function handleRemoverCartao() {
    if (!confirm('Remover cartão salvo?')) return
    setProcessando(true)
    await callCreditos('remove_card')
    load()
    setProcessando(false)
  }

  async function handleSalvarAuto() {
    setSavingAuto(true)
    await callCreditos('set_auto_recharge', { ativo: autoAtivo, minimo: autoMinimo, valor: autoValor })
    setSavingAuto(false)
    setMsg({ tipo: 'ok', texto: 'Configuração de recarga automática salva!' })
    load()
  }

  async function copiarPix() {
    await navigator.clipboard.writeText(pixData.qr_code)
    setCopiado(true)
    setTimeout(() => setCopiado(false), 2000)
  }

  const inputStyle = {
    width: '100%', padding: '9px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text)', fontSize: 14,
  }

  if (loading) return <div className="empty-state">Carregando...</div>

  const creditos = dados?.creditos ?? 0
  const cartao   = dados?.cartao
  const pacotes  = dados?.pacotes ?? []

  return (
    <div>
      <div className="page-header">
        <h1>Créditos WhatsApp Bot</h1>
      </div>

      {/* Saldo */}
      <div style={{
        background: creditos > 20
          ? 'linear-gradient(135deg,#16a34a,#15803d)'
          : creditos > 0
          ? 'linear-gradient(135deg,#d97706,#b45309)'
          : 'linear-gradient(135deg,#dc2626,#b91c1c)',
        borderRadius: 16, padding: '24px 28px', marginBottom: 24, color: '#fff',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85, marginBottom: 6, letterSpacing: '0.05em' }}>SALDO ATUAL</div>
          <div style={{ fontSize: 48, fontWeight: 900, lineHeight: 1 }}>{creditos}</div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 6 }}>
            créditos · {creditos > 0 ? `≈ ${creditos} respostas do bot` : 'bot pausado — recarregue'}
          </div>
        </div>
        <div style={{ fontSize: 40, opacity: 0.3 }}>💬</div>
      </div>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { id: 'comprar',   label: 'Comprar créditos' },
          { id: 'cartao',    label: 'Meu cartão' },
          { id: 'auto',      label: 'Recarga automática' },
          { id: 'historico', label: 'Histórico' },
        ].map(a => (
          <button key={a.id} onClick={() => { setAba(a.id); setMsg(null) }} style={{
            padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 13,
            background: aba === a.id ? 'var(--primary)' : 'var(--surface)',
            color:      aba === a.id ? '#fff' : 'var(--text)',
            outline:    `1.5px solid ${aba === a.id ? 'var(--primary)' : 'var(--border)'}`,
          }}>
            {a.label}
          </button>
        ))}
      </div>

      {msg && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13,
          background: msg.tipo === 'ok' ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)',
          color: msg.tipo === 'ok' ? '#16a34a' : '#dc2626',
          border: `1px solid ${msg.tipo === 'ok' ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
        }}>
          {msg.texto}
        </div>
      )}

      {/* ── ABA COMPRAR ── */}
      {aba === 'comprar' && (
        <div className="card">
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Escolha o pacote</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            {pacotes.map(p => (
              <div key={p.creditos} onClick={() => setPacoteSel(p)} style={{
                padding: '14px 16px', borderRadius: 12, cursor: 'pointer',
                border: `2px solid ${pacoteSel?.creditos === p.creditos ? 'var(--primary)' : 'var(--border)'}`,
                background: pacoteSel?.creditos === p.creditos ? 'rgba(124,58,237,.06)' : 'var(--bg)',
                transition: 'all .15s',
              }}>
                <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--primary)' }}>{p.creditos}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>créditos</div>
                <div style={{ fontSize: 16, fontWeight: 800 }}>{fmt(p.valor)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {fmt(p.valor / p.creditos)}/crédito
                </div>
              </div>
            ))}
          </div>

          {/* Método */}
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Forma de pagamento</div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            {['pix', 'cartao'].map(m => (
              <button key={m} onClick={() => setMetodo(m)} style={{
                flex: 1, padding: '10px 0', borderRadius: 8, cursor: 'pointer',
                border: `2px solid ${metodo === m ? 'var(--primary)' : 'var(--border)'}`,
                background: metodo === m ? 'rgba(124,58,237,.06)' : 'var(--bg)',
                fontWeight: 700, fontSize: 13, color: metodo === m ? 'var(--primary)' : 'var(--text)',
              }}>
                {m === 'pix' ? '⚡ PIX' : '💳 Cartão salvo'}
              </button>
            ))}
          </div>

          {metodo === 'cartao' && !cartao && (
            <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13,
              background: 'rgba(245,158,11,.1)', color: '#92400e', border: '1px solid rgba(245,158,11,.3)' }}>
              Você não tem cartão salvo. Vá em <strong>Meu Cartão</strong> e cadastre primeiro.
            </div>
          )}
          {metodo === 'cartao' && cartao && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 10, fontSize: 13,
                background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)' }}>
                Será cobrado no {BRAND_LABEL[cartao.brand] ?? cartao.brand} ****{cartao.last4}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>CVV do cartão</label>
                <input
                  type="text" inputMode="numeric" maxLength={4}
                  placeholder="123"
                  value={cvvInput}
                  onChange={e => setCvvInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  style={{ width: 80, padding: '8px 12px', borderRadius: 8,
                    border: '1.5px solid var(--border)', background: 'var(--bg)',
                    color: 'var(--text)', fontSize: 14, textAlign: 'center' }}
                />
              </div>
            </div>
          )}

          <button onClick={handleComprar} disabled={processando || !pacoteSel || (metodo === 'cartao' && !cartao)} style={{
            width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'var(--primary)', color: '#fff', fontWeight: 800, fontSize: 15,
            opacity: (!pacoteSel || processando) ? 0.6 : 1,
          }}>
            {processando ? 'Processando...' : pacoteSel ? `Pagar ${fmt(pacoteSel.valor)} via ${metodo === 'pix' ? 'PIX' : 'Cartão'}` : 'Selecione um pacote'}
          </button>

          {/* QR Code PIX */}
          {pixData && !expirado && (
            <div style={{ marginTop: 20, textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--primary)' }}>
                Escaneie o QR Code para pagar
              </div>
              <img src={`data:image/png;base64,${pixData.qr_code_base64}`} alt="QR PIX"
                style={{ width: 180, height: 180, borderRadius: 12, border: '3px solid var(--border)' }} />
              <div style={{
                marginTop: 12, fontSize: 13, fontWeight: 800,
                color: segRestante <= 60 ? 'var(--danger)' : 'var(--primary)',
              }}>
                ⏳ Pague em {String(Math.floor(segRestante / 60)).padStart(2, '0')}:{String(segRestante % 60).padStart(2, '0')}
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                ou copie o código Pix Copia e Cola
              </div>
              <button onClick={copiarPix} style={{
                padding: '9px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: copiado ? 'var(--success)' : 'var(--primary)',
                color: '#fff', fontWeight: 700, fontSize: 13,
              }}>
                {copiado ? '✓ Copiado!' : 'Copiar código PIX'}
              </button>
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
                Os créditos são adicionados automaticamente após a confirmação do pagamento.
              </div>
            </div>
          )}

          {pixData && expirado && (
            <div style={{ marginTop: 20, textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--danger)', marginBottom: 12 }}>
                ⌛ PIX expirado
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                O tempo para pagar acabou. Gere um novo PIX para continuar.
              </div>
              <button onClick={handleComprar} disabled={processando} style={{
                padding: '10px 28px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: 'var(--primary)', color: '#fff', fontWeight: 700, fontSize: 13,
              }}>
                {processando ? 'Gerando...' : 'Gerar novo PIX'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── ABA CARTÃO ── */}
      {aba === 'cartao' && (
        <div className="card">
          {cartao ? (
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Cartão salvo</div>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 16px', borderRadius: 10,
                background: 'linear-gradient(135deg,#1e1b4b,#312e81)',
                color: '#fff', marginBottom: 16,
              }}>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>{BRAND_LABEL[cartao.brand] ?? cartao.brand?.toUpperCase()}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '0.1em' }}>**** **** **** {cartao.last4}</div>
                </div>
                <div style={{ fontSize: 32, opacity: 0.4 }}>💳</div>
              </div>
              <button onClick={handleRemoverCartao} disabled={processando} style={{
                width: '100%', padding: '10px 0', borderRadius: 8, border: '1.5px solid var(--danger)',
                background: 'transparent', color: 'var(--danger)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}>
                {processando ? 'Removendo...' : 'Remover cartão'}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSalvarCartao}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Adicionar cartão de crédito</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                Os dados são enviados diretamente ao Mercado Pago — nunca armazenamos seu cartão.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' }}>Número do cartão</label>
                  <input style={inputStyle} placeholder="0000 0000 0000 0000" value={cardNumber} onChange={handleCardNumber} maxLength={19} required />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' }}>Nome no cartão</label>
                  <input style={inputStyle} placeholder="NOME COMPLETO" value={cardName} onChange={e => setCardName(e.target.value.toUpperCase())} required />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' }}>Validade</label>
                    <input style={inputStyle} placeholder="MM/AA" value={cardExpiry} onChange={handleExpiry} maxLength={5} required />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' }}>CVV</label>
                    <input style={inputStyle} placeholder="123" value={cardCvv} onChange={e => setCardCvv(e.target.value.replace(/\D/g,'').slice(0,4))} maxLength={4} required />
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, display: 'block' }}>CPF do titular</label>
                  <input style={inputStyle} placeholder="000.000.000-00" value={cardCpf} onChange={e => setCardCpf(e.target.value)} required />
                </div>
              </div>

              <button type="submit" disabled={processando} style={{
                width: '100%', marginTop: 16, padding: '12px 0', borderRadius: 10, border: 'none',
                background: 'var(--primary)', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer',
                opacity: processando ? 0.6 : 1,
              }}>
                {processando ? 'Salvando...' : 'Salvar cartão'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* ── ABA AUTO-RECARGA ── */}
      {aba === 'auto' && (
        <div className="card">
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Recarga automática</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
            Quando seus créditos caírem abaixo do mínimo, o cartão salvo é cobrado automaticamente.
          </div>

          {!cartao && (
            <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13,
              background: 'rgba(245,158,11,.1)', color: '#92400e', border: '1px solid rgba(245,158,11,.3)' }}>
              Você precisa de um cartão salvo para usar a recarga automática. Vá em <strong>Meu Cartão</strong>.
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <input type="checkbox" id="auto-ativo" checked={autoAtivo} onChange={e => setAutoAtivo(e.target.checked)}
              disabled={!cartao} style={{ width: 18, height: 18, cursor: 'pointer' }} />
            <label htmlFor="auto-ativo" style={{ fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Ativar recarga automática
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20, opacity: (!autoAtivo || !cartao) ? 0.5 : 1 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' }}>
                Recarregar quando chegar em
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" min={10} max={500} value={autoMinimo} onChange={e => setAutoMinimo(Number(e.target.value))}
                  disabled={!autoAtivo || !cartao} style={{ ...inputStyle, width: 100 }} />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>créditos</span>
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' }}>
                Valor a recarregar
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>R$</span>
                <input type="number" min={10} step={5} value={autoValor} onChange={e => setAutoValor(Number(e.target.value))}
                  disabled={!autoAtivo || !cartao} style={{ ...inputStyle, width: 110 }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {autoValor >= 10 && autoValor < 45 ? '100 créditos' : autoValor >= 45 && autoValor < 160 ? '500 créditos' : autoValor >= 160 ? '2.000+ créditos' : ''}
              </div>
            </div>
          </div>

          <div style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12,
            background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            Exemplo: saldo cai para {autoMinimo} → cartão é cobrado R$ {autoValor} automaticamente → créditos são adicionados na hora.
          </div>

          <button onClick={handleSalvarAuto} disabled={savingAuto || !cartao} style={{
            width: '100%', padding: '11px 0', borderRadius: 9, border: 'none',
            background: 'var(--primary)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer',
            opacity: (!cartao || savingAuto) ? 0.6 : 1,
          }}>
            {savingAuto ? 'Salvando...' : 'Salvar configuração'}
          </button>
        </div>
      )}

      {/* ── ALERTA DE CRÉDITO BAIXO (na aba auto) ── */}
      {aba === 'auto' && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>🔔 Alerta de crédito baixo</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
            Manda uma mensagem no WhatsApp do dono quando o saldo ficar baixo (avisa <b>uma vez</b>; volta a avisar depois que recarregar). Não cobra nada — é só um aviso.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Avisar quando ficar abaixo de</label>
            <input type="number" min={0} max={2000} value={alertaMinimo} onChange={e => setAlertaMinimo(Number(e.target.value))} style={{ ...inputStyle, width: 90 }} />
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>créditos (0 = desligado)</span>
          </div>
          <button onClick={handleSalvarAlerta} disabled={savingAlerta} style={{
            width: '100%', padding: '11px 0', borderRadius: 9, border: 'none',
            background: 'var(--primary)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: savingAlerta ? 0.6 : 1,
          }}>
            {savingAlerta ? 'Salvando...' : 'Salvar alerta'}
          </button>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            ⚠️ Precisa ter o número do dono configurado (em <b>WhatsApp → Config</b>, o telefone do admin).
          </div>
        </div>
      )}

      {/* ── ABA HISTÓRICO ── */}
      {aba === 'historico' && (
        <div className="card">
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Histórico de créditos</div>
          {(dados?.historico ?? []).length === 0 ? (
            <div className="empty-state">Nenhum registro ainda.</div>
          ) : (
            dados.historico.map((h, i) => {
              const positivo = h.creditos > 0
              return (
                <div key={h.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 0', borderBottom: i < dados.historico.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{h.descricao}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(h.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: positivo ? 'var(--success)' : 'var(--text-muted)' }}>
                      {positivo ? '+' : ''}{h.creditos} créditos
                    </div>
                    {h.valor_reais && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmt(h.valor_reais)}</div>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
