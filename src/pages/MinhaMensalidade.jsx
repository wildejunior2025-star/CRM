import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { dataCurtaBR } from '../lib/mensalidade'
import MensalidadePagamento from '../components/MensalidadePagamento'
import '../components/Page.css'

// Tela do administrador: o que está em aberto, pagar, cartão automático e o
// histórico com recibo de cada semana paga (mig 0263).

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const FORMA = { pix: 'PIX', cartao: 'Cartão', manual: 'Pago à FWC' }

export default function MinhaMensalidade() {
  const { empresa } = useAuth()
  const [situacao, setSituacao] = useState(null)
  const [historico, setHistorico] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [cancelando, setCancelando] = useState(false)

  const carregar = useCallback(async () => {
    const [{ data: sit }, { data: hist }] = await Promise.all([
      supabase.rpc('mensalidade_situacao'),
      supabase.from('mensalidade_cobrancas').select('id, vencimento, referencia, valor, status, pago_em, valor_pago, forma')
        .order('vencimento', { ascending: false }).limit(60),
    ])
    setSituacao(sit ?? null)
    setHistorico(hist ?? [])
    setCarregando(false)
  }, [])

  useEffect(() => { carregar() }, [carregar])

  async function cancelarCartao() {
    if (!window.confirm('Parar a cobrança automática no cartão? As próximas mensalidades vão precisar ser pagas no PIX.')) return
    setCancelando(true)
    const { data: { session } } = await supabase.auth.getSession()
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mensalidade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ action: 'cancelar_cartao' }),
    })
    setCancelando(false)
    carregar()
  }

  if (carregando) return <div className="empty-state">Carregando...</div>

  if (!situacao?.ativa) {
    return (
      <div>
        <div className="page-header"><h1>Minha mensalidade</h1></div>
        <div className="card" style={{ fontSize: 14 }}>A cobrança desta loja ainda não foi configurada pela FWC.</div>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header"><h1>Minha mensalidade</h1></div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Seu plano</div>
          <div style={{ fontSize: 26, fontWeight: 900, margin: '4px 0' }}>
            {fmt(situacao.valor)} <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' }}>/ {situacao.periodicidade === 'semanal' ? 'semana' : 'mês'}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Depois do vencimento, a loja tem {situacao.carencia_dias} dia(s) de funcionamento pra pagar antes do bloqueio.
          </div>
          {situacao.cartao && (
            <div style={{ marginTop: 12, fontSize: 13.5 }}>
              💳 Cobrança automática no cartão final <strong>{situacao.cartao.final ?? '····'}</strong>
              {situacao.cartao.status && situacao.cartao.status !== 'authorized' && <span style={{ color: '#dc2626' }}> ({situacao.cartao.status})</span>}
              <div>
                <button type="button" disabled={cancelando} onClick={cancelarCartao}
                  style={{ marginTop: 6, background: 'none', border: 'none', color: 'var(--danger, #dc2626)', fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                  {cancelando ? 'Parando…' : 'Parar cobrança no cartão'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>Pagar</div>
          <MensalidadePagamento situacao={situacao} empresaId={empresa?.id} onPago={carregar} />
        </div>
      </div>

      <div className="card">
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>Histórico</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                <th style={th}>Referência</th><th style={th}>Vencimento</th><th style={th}>Valor</th><th style={th}>Situação</th>
              </tr>
            </thead>
            <tbody>
              {historico.map(c => (
                <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}>{c.referencia}</td>
                  <td style={td}>{dataCurtaBR(c.vencimento)}</td>
                  <td style={td}>{fmt(c.valor_pago ?? c.valor)}</td>
                  <td style={td}>
                    {c.status === 'paga'
                      ? <span style={{ color: 'var(--success, #16a34a)', fontWeight: 700 }}>✓ Paga {c.pago_em ? `em ${new Date(c.pago_em).toLocaleDateString('pt-BR')}` : ''} · {FORMA[c.forma] ?? c.forma}</span>
                      : c.status === 'cancelada'
                        ? <span style={{ color: 'var(--text-muted)' }}>Cancelada</span>
                        : c.vencimento <= situacao.hoje
                          ? <span style={{ color: '#dc2626', fontWeight: 700 }}>Em aberto</span>
                          : <span style={{ color: 'var(--text-muted)' }}>A vencer</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const th = { padding: '6px 8px', fontWeight: 700 }
const td = { padding: '8px 8px' }
