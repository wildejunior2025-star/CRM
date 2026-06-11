import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { FORMAS_RECEBIMENTO } from '../lib/constants'
import '../components/Page.css'
import './Portal.css'

const FORMA_BADGE = {
  dinheiro: 'badge-success',
  pix: 'badge-primary',
  transferencia: 'badge-warning',
  cartao: 'badge-neutral',
}

export default function PortalFiado() {
  const { profile } = useAuth()
  const [saldo, setSaldo] = useState(0)
  const [pagamentos, setPagamentos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function loadAll() {
    setLoading(true)
    setError(null)

    if (!profile?.cliente_id) {
      setLoading(false)
      return
    }

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

    const firstError = saldoRes.error || pagamentosRes.error
    if (firstError) setError(firstError.message)

    setSaldo(Number(saldoRes.data?.saldo_fiado ?? 0))
    setPagamentos(pagamentosRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.cliente_id])

  return (
    <div>
      <div className="page-header">
        <h1>Meu fiado</h1>
      </div>

      {!loading && !profile?.cliente_id && (
        <p className="error-text">
          Seu cadastro ainda não foi vinculado a um cliente. Entre em contato com o depósito.
        </p>
      )}

      {error && <p className="error-text">{error}</p>}

      {profile?.cliente_id && (
        <div className="card dashboard-card" style={{ marginBottom: 24, maxWidth: 320 }}>
          <div className="label">Saldo em aberto</div>
          <div className={`portal-saldo ${saldo > 0.009 ? 'portal-saldo-aberto' : 'portal-saldo-zero'}`}>
            R$ {saldo.toFixed(2)}
          </div>
        </div>
      )}

      <h2 className="portal-table-title">Histórico de pagamentos</h2>
      <div className="data-table">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : pagamentos.length === 0 ? (
          <div className="empty-state">Nenhum pagamento registrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Forma</th>
                <th className="portal-amount-col">Valor</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              {pagamentos.map((p) => (
                <tr key={p.id}>
                  <td>{new Date(p.created_at).toLocaleString('pt-BR')}</td>
                  <td>
                    <span className={`badge ${FORMA_BADGE[p.forma_pagamento] ?? 'badge-neutral'}`}>
                      {FORMAS_RECEBIMENTO.find((f) => f.value === p.forma_pagamento)?.label ||
                        p.forma_pagamento}
                    </span>
                  </td>
                  <td className="portal-amount-col">R$ {Number(p.valor).toFixed(2)}</td>
                  <td>{p.observacao ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
