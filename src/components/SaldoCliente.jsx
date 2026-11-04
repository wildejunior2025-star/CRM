import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'

// Conta pré-paga do cliente (mig 0436). O cliente paga adiantado, o saldo sobe e
// cada pedido pago com "Saldo" abate dele. Sobra passa pra próxima semana.
// O depósito entra no caixa de hoje como recebimento da forma escolhida.
const FORMAS = [
  { id: 'pix', label: 'PIX' },
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'debito', label: 'Débito' },
  { id: 'credito', label: 'Crédito' },
  { id: 'transferencia', label: 'Transferência' },
]
const fmt = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const paraNum = (v) => Math.round(parseFloat(String(v ?? '').replace(',', '.')) * 100) / 100

const ROTULO = { deposito: 'Depósito', uso: 'Pedido', estorno: 'Estorno', ajuste: 'Ajuste' }

export default function SaldoCliente({ cliente, onClose }) {
  const [saldo, setSaldo] = useState(null)
  const [extrato, setExtrato] = useState([])
  const [valor, setValor] = useState('')
  const [forma, setForma] = useState('pix')
  const [obs, setObs] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  const carregar = useCallback(async () => {
    const [s, m] = await Promise.all([
      supabase.rpc('cliente_saldo', { p_cliente_id: cliente.id }),
      supabase.from('cliente_saldo_movimentos')
        .select('id, tipo, valor, forma, observacao, created_at')
        .eq('cliente_id', cliente.id).order('created_at', { ascending: false }).limit(60),
    ])
    setSaldo(Number(s.data ?? 0))
    setExtrato(m.data ?? [])
  }, [cliente.id])

  useEffect(() => { carregar() }, [carregar])

  const v = paraNum(valor)
  const ok = Number.isFinite(v) && v > 0

  async function receber() {
    if (!ok || salvando) return
    setSalvando(true); setErro(null)
    const { data, error } = await supabase.rpc('saldo_depositar', {
      p_cliente_id: cliente.id, p_valor: v, p_forma: forma, p_obs: obs.trim() || null,
    })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setSaldo(Number(data ?? 0)); setValor(''); setObs('')
    carregar()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h2>💰 Saldo de {cliente.nome}</h2>
        <div style={{ fontSize: 30, fontWeight: 900, margin: '2px 0 4px', color: (saldo ?? 0) > 0 ? '#16a34a' : 'var(--text)' }}>
          {saldo == null ? '…' : fmt(saldo)}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 14px' }}>
          Dinheiro que o cliente já pagou adiantado. Nos pedidos, escolha a forma <b>Saldo</b> pra abater.
          O que sobrar fica pra próxima semana.
        </p>

        <div style={{ padding: 12, borderRadius: 10, border: '1.5px solid var(--border)', marginBottom: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Receber adiantado</div>
          <input value={valor} onChange={e => setValor(e.target.value)} placeholder="Valor (R$)" inputMode="decimal"
            style={{ width: '100%', padding: '9px 11px', borderRadius: 8, border: '1.5px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text)', fontSize: 16, fontWeight: 700, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {FORMAS.map(f => (
              <button key={f.id} type="button" onClick={() => setForma(f.id)}
                style={{ padding: '6px 12px', borderRadius: 20, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  border: `1.5px solid ${forma === f.id ? 'var(--primary)' : 'var(--border)'}`,
                  background: forma === f.id ? 'var(--primary-bg)' : 'var(--surface)',
                  color: forma === f.id ? 'var(--primary)' : 'var(--text)' }}>
                {f.label}
              </button>
            ))}
          </div>
          <input value={obs} onChange={e => setObs(e.target.value)} placeholder="Observação (ex.: semana 04 a 08/11)"
            style={{ width: '100%', padding: '8px 11px', borderRadius: 8, border: '1.5px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text)', fontSize: 13, marginBottom: 8 }} />
          {erro && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: '0 0 8px' }}>{erro}</p>}
          <button type="button" className="btn btn-primary" disabled={!ok || salvando} onClick={receber} style={{ width: '100%' }}>
            {salvando ? 'Salvando...' : ok ? `Receber ${fmt(v)} (${FORMAS.find(f => f.id === forma)?.label})` : 'Receber'}
          </button>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Entra no caixa de hoje como recebimento em {FORMAS.find(f => f.id === forma)?.label}.
          </p>
        </div>

        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>Extrato</div>
        <div style={{ maxHeight: 220, overflowY: 'auto', fontSize: 13 }}>
          {extrato.length === 0 && <div style={{ color: 'var(--text-muted)' }}>Nenhum movimento ainda.</div>}
          {extrato.map(m => (
            <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
              <span>
                <b>{ROTULO[m.tipo] ?? m.tipo}</b>
                {m.observacao ? <span style={{ color: 'var(--text-muted)' }}> · {m.observacao}</span> : null}
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {new Date(m.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  {m.forma ? ` · ${FORMAS.find(f => f.id === m.forma)?.label ?? m.forma}` : ''}
                </div>
              </span>
              <b style={{ color: Number(m.valor) > 0 ? '#16a34a' : '#b45309', whiteSpace: 'nowrap' }}>
                {Number(m.valor) > 0 ? '+' : '−'} {fmt(Math.abs(Number(m.valor)))}
              </b>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}
