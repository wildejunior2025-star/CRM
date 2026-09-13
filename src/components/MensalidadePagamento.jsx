import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { dataCurtaBR } from '../lib/mensalidade'

// O miolo do pagamento: usado no pop-up que trava e na tela Minha mensalidade.
// PIX e cartão caem no Mercado Pago JURÍDICO da FWC (Edge Function mensalidade).

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

async function chamar(action, body = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mensalidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
    body: JSON.stringify({ action, ...body }),
  })
  return res.json().catch(() => ({ error: 'Sem resposta do servidor.' }))
}

export default function MensalidadePagamento({ situacao, onPago, empresaId, mostrarValorGerado = true }) {
  const [aba, setAba] = useState('pix')
  const [pix, setPix] = useState(situacao?.pagamento_pendente ?? null)
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState(null)
  const [copiado, setCopiado] = useState(false)
  const [pago, setPago] = useState(false)
  const [vendasSemana, setVendasSemana] = useState(null)
  const pollRef = useRef(null)

  const hoje = situacao?.hoje
  const abertas = situacao?.abertas ?? []
  const vencidas = abertas.filter(c => c.vencimento <= hoje)
  const proxima = abertas.find(c => c.vencimento > hoje)
  const total = vencidas.reduce((s, c) => s + Number(c.valor), 0)
  const desconto = Number(situacao?.desconto_antecipado ?? 0)
  const podeAntecipar = !vencidas.length && proxima

  // "Esta semana o sistema recebeu R$ X": o valor da mensalidade fica pequeno
  // perto do que passou por ele.
  useEffect(() => {
    if (!mostrarValorGerado || !empresaId) return
    const desde = new Date(Date.now() - 7 * 86400000).toISOString()
    supabase.from('pedidos_delivery').select('total').eq('empresa_id', empresaId)
      .neq('status', 'cancelado').gte('created_at', desde).limit(5000)
      .then(({ data }) => setVendasSemana((data ?? []).reduce((s, p) => s + Number(p.total || 0), 0)))
  }, [empresaId, mostrarValorGerado])

  // Com PIX na tela, confere sozinho a cada 5 s se já caiu.
  useEffect(() => {
    if (!pix?.id || pago) return
    pollRef.current = setInterval(async () => {
      const r = await chamar('status')
      if (r?.ok && r.em_aberto === 0) {
        clearInterval(pollRef.current)
        setPago(true)
        setTimeout(() => onPago?.(), 2500)
      }
    }, 5000)
    return () => clearInterval(pollRef.current)
  }, [pix?.id, pago, onPago])

  async function gerarPix(antecipar = false) {
    setGerando(true); setErro(null)
    const r = await chamar('pix', { antecipar })
    setGerando(false)
    if (r?.error) { setErro(r.error); return }
    setPix(r)
  }

  async function copiar() {
    try { await navigator.clipboard.writeText(pix.pix_copia_cola) } catch { /* sem permissão: a pessoa copia na mão */ }
    setCopiado(true); setTimeout(() => setCopiado(false), 2000)
  }

  if (pago) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 8px' }}>
        <div style={{ fontSize: 52 }}>✅</div>
        <div style={{ fontSize: 20, fontWeight: 900, marginTop: 8 }}>Pagamento confirmado!</div>
        <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 6 }}>Obrigado. O acesso já está liberado.</div>
      </div>
    )
  }

  return (
    <div>
      {vencidas.length > 0 ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
          {vencidas.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
              <span>{c.referencia} <span style={{ color: 'var(--text-muted)' }}>· venceu {dataCurtaBR(c.vencimento)}</span></span>
              <strong>{fmt(c.valor)}</strong>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 12px', fontSize: 16, fontWeight: 900, background: 'rgba(239,68,68,.08)' }}>
            <span>Total em aberto</span><span style={{ color: '#dc2626' }}>{fmt(total)}</span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 14, marginBottom: 14 }}>
          {proxima
            ? <>Próxima: <strong>{proxima.referencia}</strong> · vence {dataCurtaBR(proxima.vencimento)} · <strong>{fmt(proxima.valor)}</strong>
                {desconto > 0 && <div style={{ color: 'var(--success, #16a34a)', fontWeight: 700, marginTop: 4 }}>Pagando antes do vencimento: {fmt(Math.max(0, proxima.valor - desconto))}</div>}</>
            : 'Nenhuma mensalidade em aberto. 🎉'}
        </div>
      )}

      {mostrarValorGerado && vendasSemana > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14 }}>
          Nos últimos 7 dias passaram <strong style={{ color: 'var(--text)' }}>{fmt(vendasSemana)}</strong> em pedidos pelo sistema.
        </div>
      )}

      {(vencidas.length > 0 || podeAntecipar) && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {[['pix', 'PIX'], ['cartao', 'Cartão (automático)']].map(([id, lab]) => (
              <button key={id} type="button" onClick={() => { setAba(id); setErro(null) }} style={{
                flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13,
                background: aba === id ? 'var(--primary)' : 'var(--bg)', color: aba === id ? '#fff' : 'var(--text)',
                outline: `1.5px solid ${aba === id ? 'var(--primary)' : 'var(--border)'}`,
              }}>{lab}</button>
            ))}
          </div>

          {erro && <div style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(239,68,68,.1)', color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{erro}</div>}

          {aba === 'pix' && (!pix ? (
            <button type="button" disabled={gerando} onClick={() => gerarPix(!vencidas.length)} style={botaoPrincipal}>
              {gerando ? 'Gerando PIX…' : `Gerar PIX de ${fmt(vencidas.length ? total : Math.max(0, (proxima?.valor ?? 0) - desconto))}`}
            </button>
          ) : (
            <div style={{ textAlign: 'center' }}>
              {pix.pix_qr_base64 && <img src={`data:image/png;base64,${pix.pix_qr_base64}`} alt="QR Code do PIX" style={{ width: 200, height: 200, maxWidth: '100%' }} />}
              <div style={{ fontSize: 13, fontWeight: 800, margin: '6px 0' }}>{fmt(pix.valor)}</div>
              <button type="button" onClick={copiar} style={{ ...botaoPrincipal, background: copiado ? '#16a34a' : 'var(--primary)' }}>
                {copiado ? 'Copiado!' : 'Copiar código PIX'}
              </button>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                Assim que o pagamento cair, esta tela libera sozinha. ⏳
              </div>
            </div>
          ))}

          {aba === 'cartao' && <CartaoRecorrente situacao={situacao} onPago={() => { setPago(true); setTimeout(() => onPago?.(), 2500) }} />}
        </>
      )}
    </div>
  )
}

function CartaoRecorrente({ situacao, onPago }) {
  const mpRef = useRef(null)
  const [pronto, setPronto] = useState(false)
  const [semChave, setSemChave] = useState(false)
  const [f, setF] = useState({ numero: '', nome: '', validade: '', cvv: '', cpf: '', email: '' })
  const [enviando, setEnviando] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      const r = await chamar('cartao_chave')
      if (!vivo) return
      if (!r?.public_key) { setSemChave(true); return }
      const iniciar = () => { mpRef.current = new window.MercadoPago(r.public_key); setPronto(true) }
      if (window.MercadoPago) { iniciar(); return }
      const s = document.createElement('script')
      s.src = 'https://sdk.mercadopago.com/js/v2'
      s.onload = iniciar
      document.head.appendChild(s)
    })()
    return () => { vivo = false }
  }, [])

  if (situacao?.cartao) {
    return (
      <div style={{ fontSize: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(34,197,94,.1)', border: '1px solid rgba(34,197,94,.35)' }}>
        💳 Cobrança automática ativa no cartão {situacao.cartao.bandeira ?? ''} final <strong>{situacao.cartao.final ?? '····'}</strong>.
      </div>
    )
  }
  if (semChave) {
    return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>O cartão ainda não foi ligado pela FWC. Por enquanto, pague no PIX.</div>
  }

  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))
  // Máscaras: o lojista digita só os números e a formatação aparece sozinha.
  const soDigitos = (t, max) => String(t ?? '').replace(/[^0-9]/g, '').slice(0, max)
  const mascara = {
    numero: t => soDigitos(t, 19).replace(/(.{4})(?=.)/g, '$1 '),
    validade: t => { const d = soDigitos(t, 4); return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d },
    cvv: t => soDigitos(t, 4),
    cpf: t => {
      const d = soDigitos(t, 11)
      return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2')
    },
  }
  const setMasc = (k) => (e) => { const val = mascara[k](e.target.value); setF(v => ({ ...v, [k]: val })) }

  async function enviar(e) {
    e.preventDefault()
    if (!mpRef.current) return
    setEnviando(true); setMsg(null)
    try {
      const [mes, ano] = f.validade.split('/')
      const numero = f.numero.replace(/\D/g, '')
      const dados = {
        cardNumber: numero, cardholderName: f.nome, cardExpirationMonth: mes, cardExpirationYear: `20${ano}`,
        securityCode: f.cvv, identificationType: 'CPF', identificationNumber: f.cpf.replace(/\D/g, ''),
      }
      // Dois tokens: um pra cobrar o que já venceu agora, outro pra assinatura
      // (cada token do Mercado Pago só pode ser usado uma vez).
      const tAssin = await mpRef.current.createCardToken(dados)
      const tAgora = await mpRef.current.createCardToken(dados)
      const metodos = await mpRef.current.getPaymentMethods({ bin: numero.slice(0, 8) })
      const metodo = metodos?.results?.[0]
      const r = await chamar('assinar', {
        card_token: tAssin.id, card_token_agora: tAgora.id, payment_method_id: metodo?.id,
        email: f.email, cpf: f.cpf, final: numero.slice(-4), bandeira: metodo?.name ?? metodo?.id,
      })
      if (r?.error) { setMsg(r.error); setEnviando(false); return }
      onPago?.()
    } catch (err) {
      setMsg(err?.message ?? 'Não consegui ler o cartão. Confira os dados.')
    }
    setEnviando(false)
  }

  return (
    <form onSubmit={enviar} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
        Cadastre uma vez e a mensalidade é cobrada sozinha no vencimento — o que já venceu é cobrado agora. Os dados vão direto pro Mercado Pago.
      </div>
      {msg && <div style={{ padding: '8px 12px', borderRadius: 8, background: 'rgba(239,68,68,.1)', color: '#dc2626', fontSize: 13 }}>{msg}</div>}
      <input style={campo} placeholder="Número do cartão" inputMode="numeric" autoComplete="cc-number" value={f.numero} onChange={setMasc('numero')} required />
      <input style={campo} placeholder="Nome impresso no cartão" autoComplete="cc-name" value={f.nome} onChange={e => setF(v => ({ ...v, nome: e.target.value.toUpperCase() }))} required />
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={campo} placeholder="Validade (MM/AA)" inputMode="numeric" autoComplete="cc-exp" value={f.validade} maxLength={5} onChange={setMasc('validade')} required />
        <input style={campo} placeholder="CVV" inputMode="numeric" autoComplete="cc-csc" maxLength={4} value={f.cvv} onChange={setMasc('cvv')} required />
      </div>
      <input style={campo} placeholder="CPF do titular" inputMode="numeric" value={f.cpf} maxLength={14} onChange={setMasc('cpf')} required />
      <input style={campo} placeholder="E-mail pra receber o recibo" type="email" value={f.email} onChange={set('email')} required />
      <button type="submit" disabled={!pronto || enviando} style={botaoPrincipal}>
        {enviando ? 'Confirmando…' : 'Ativar cobrança automática'}
      </button>
    </form>
  )
}

const botaoPrincipal = {
  width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
  background: 'var(--primary)', color: '#fff', fontWeight: 800, fontSize: 14.5,
}
const campo = {
  width: '100%', padding: '10px 12px', borderRadius: 9, border: '1.5px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)', fontSize: 14, minWidth: 0,
}
