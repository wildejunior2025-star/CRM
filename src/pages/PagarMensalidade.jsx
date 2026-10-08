import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

// Página pública do link de pagamento da mensalidade (enviado pelo WhatsApp da
// FWC). Sem login: o token da URL identifica a loja. Mostra o que está em aberto
// e o PIX (a função reaproveita o pendente que ainda vale ou gera um novo).

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const dataBR = ymd => ymd ? ymd.split('-').reverse().join('/') : ''

async function chamar(action, token) {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  try {
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mensalidade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ action, token }),
    })
    return await res.json()
  } catch {
    return { error: 'Sem resposta do servidor. Confira a internet e tente de novo.' }
  }
}

export default function PagarMensalidade() {
  const { token } = useParams()
  const [info, setInfo] = useState(null)
  const [pix, setPix] = useState(null)
  const [erro, setErro] = useState(null)
  const [gerando, setGerando] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const [pago, setPago] = useState(false)
  const pollRef = useRef(null)

  useEffect(() => {
    chamar('link_info', token).then(r => { if (r?.error) setErro(r.error); else setInfo(r) })
  }, [token])

  // Com o PIX na tela, confere a cada 5 s se já caiu.
  useEffect(() => {
    if (!pix?.id || pago) return
    pollRef.current = setInterval(async () => {
      const r = await chamar('link_status', token)
      if (r?.ok && r.em_aberto === 0) { clearInterval(pollRef.current); setPago(true) }
    }, 5000)
    return () => clearInterval(pollRef.current)
  }, [pix?.id, pago, token])

  async function gerar() {
    setGerando(true); setErro(null)
    const r = await chamar('link_pix', token)
    setGerando(false)
    if (r?.error) { setErro(r.error); return }
    setPix(r)
  }

  async function copiar() {
    try { await navigator.clipboard.writeText(pix.pix_copia_cola) } catch { /* copia na mão */ }
    setCopiado(true); setTimeout(() => setCopiado(false), 2000)
  }

  const lista = info ? (info.vencidas?.length ? info.vencidas : info.proxima ? [info.proxima] : []) : []
  const desconto = info && !info.vencidas?.length ? Number(info.desconto_antecipado || 0) : 0
  const total = Math.max(0, lista.reduce((s, c) => s + Number(c.valor), 0) - desconto)

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #f4f4f8)', display: 'flex', justifyContent: 'center', padding: '24px 16px' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', fontWeight: 900, fontSize: 15, color: 'var(--primary, #7c3aed)', marginBottom: 14 }}>FWC Inter</div>
        <div className="card" style={{ padding: 20, borderRadius: 16 }}>
          {!info && !erro && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Carregando…</div>}
          {erro && !pix && !info && <div style={{ textAlign: 'center', padding: 16, color: '#dc2626', fontWeight: 700 }}>{erro}</div>}

          {pago && (
            <div style={{ textAlign: 'center', padding: '20px 4px' }}>
              <div style={{ fontSize: 56 }}>✅</div>
              <div style={{ fontSize: 20, fontWeight: 900, marginTop: 8 }}>Pagamento confirmado!</div>
              <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 6 }}>Obrigado, o acesso está em dia.</div>
            </div>
          )}

          {info && !pago && (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Mensalidade do sistema</div>
              <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 12 }}>{info.loja}</div>

              {!lista.length ? (
                <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 15 }}>Nenhuma mensalidade em aberto. 🎉</div>
              ) : (
                <>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
                    {lista.map(c => (
                      <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
                        <span>{c.referencia} <span style={{ color: 'var(--text-muted)' }}>· {c.vencimento <= info.hoje ? 'venceu' : 'vence'} {dataBR(c.vencimento)}</span></span>
                        <strong>{fmt(c.valor)}</strong>
                      </div>
                    ))}
                    {desconto > 0 && (
                      <div style={{ padding: '8px 12px', fontSize: 13, color: '#16a34a', fontWeight: 700 }}>Desconto por pagar antes: − {fmt(desconto)}</div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 12px', fontSize: 16, fontWeight: 900, background: 'rgba(124,58,237,.08)' }}>
                      <span>Total</span><span>{fmt(total)}</span>
                    </div>
                  </div>

                  {erro && <div style={{ padding: '9px 12px', borderRadius: 8, background: 'rgba(239,68,68,.1)', color: '#dc2626', fontSize: 13, marginBottom: 10 }}>{erro}</div>}

                  {!pix ? (
                    <button type="button" disabled={gerando} onClick={gerar} style={botao}>
                      {gerando ? 'Gerando PIX…' : `Pagar ${fmt(total)} no PIX`}
                    </button>
                  ) : (
                    <div style={{ textAlign: 'center' }}>
                      {pix.pix_qr_base64 && <img src={`data:image/png;base64,${pix.pix_qr_base64}`} alt="QR Code do PIX" style={{ width: 210, height: 210, maxWidth: '100%' }} />}
                      <div style={{ fontSize: 14, fontWeight: 800, margin: '6px 0 10px' }}>{fmt(pix.valor)}</div>
                      <button type="button" onClick={copiar} style={{ ...botao, background: copiado ? '#16a34a' : 'var(--primary, #7c3aed)' }}>
                        {copiado ? 'Copiado!' : 'Copiar código PIX'}
                      </button>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                        Abra o app do seu banco, escolha PIX → Copia e Cola (ou leia o QR). Esta tela confirma sozinha quando o pagamento cair. ⏳
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const botao = {
  width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
  background: 'var(--primary, #7c3aed)', color: '#fff', fontWeight: 800, fontSize: 15,
}
