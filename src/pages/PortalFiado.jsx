import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { FORMAS_RECEBIMENTO } from '../lib/constants'
import './PortalLoja.css'
import './Portal.css'

const FORMA_BADGE = {
  dinheiro: { bg: 'var(--success-bg)', color: 'var(--success)' },
  pix: { bg: 'var(--primary-bg)', color: 'var(--primary)' },
  transferencia: { bg: 'var(--warning-bg)', color: 'var(--warning)' },
  cartao: { bg: 'var(--bg)', color: 'var(--text-muted)' },
}

export default function PortalFiado() {
  const { profile } = useAuth()
  const [saldo, setSaldo] = useState(0)
  const [pagamentos, setPagamentos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      if (!profile?.cliente_id) { setLoading(false); return }

      const [saldoRes, pagamentosRes] = await Promise.all([
        supabase
          .from('clientes_saldo_fiado')
          .select('saldo_fiado')
          .eq('cliente_id', profile.cliente_id)
          .maybeSingle(),
        supabase
          .from('pagamentos')
          .select('*')
          .eq('cliente_id', profile.cliente_id)
          .order('created_at', { ascending: false }),
      ])

      const err = saldoRes.error || pagamentosRes.error
      if (err) setError(err.message)
      setSaldo(Number(saldoRes.data?.saldo_fiado ?? 0))
      setPagamentos(pagamentosRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [profile?.cliente_id])

  if (loading) {
    return (
      <div className="loja-loading">
        <div className="loja-spinner" />
        <p>Carregando...</p>
      </div>
    )
  }

  if (!profile?.cliente_id) {
    return (
      <div className="portal-section">
        <div className="portal-empty">
          <div className="portal-empty-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </div>
          <p>Cadastro não vinculado</p>
          <span>Fale com o depósito para liberar sua conta.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="portal-section">
      {error && <div className="loja-aviso loja-aviso-erro">{error}</div>}

      {/* Card de saldo */}
      <div className={`portal-saldo-card ${saldo > 0.009 ? 'portal-saldo-card-aberto' : 'portal-saldo-card-zero'}`}>
        <span className="portal-saldo-label">Saldo em aberto</span>
        <span className="portal-saldo-valor">
          R$ {saldo.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
        </span>
        <span className="portal-saldo-sub">
          {saldo > 0.009 ? 'Há valores a pagar' : 'Tudo em dia!'}
        </span>
      </div>

      <h2 className="portal-section-title" style={{ marginTop: 24 }}>Histórico de pagamentos</h2>

      {pagamentos.length === 0 ? (
        <div className="portal-empty">
          <div className="portal-empty-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <p>Nenhum pagamento registrado.</p>
        </div>
      ) : (
        <div className="portal-pagamentos-lista">
          {pagamentos.map(p => {
            const cores = FORMA_BADGE[p.forma_pagamento] ?? FORMA_BADGE.cartao
            const forma = FORMAS_RECEBIMENTO.find(f => f.value === p.forma_pagamento)?.label ?? p.forma_pagamento
            const data = new Date(p.created_at)

            return (
              <div key={p.id} className="portal-pagamento-item">
                <div className="portal-pagamento-left">
                  <span className="portal-pagamento-data">
                    {data.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' })}
                  </span>
                  <span
                    className="portal-pagamento-forma"
                    style={{ background: cores.bg, color: cores.color }}
                  >
                    {forma}
                  </span>
                  {p.observacao && (
                    <span className="portal-pagamento-obs">{p.observacao}</span>
                  )}
                </div>
                <span className="portal-pagamento-valor">
                  R$ {Number(p.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
