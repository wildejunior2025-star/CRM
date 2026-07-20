import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const fmtBRL = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const semAcento = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
// Link de cobrança no WhatsApp: só dígitos, com 55 na frente se vier sem.
const zap = (tel) => {
  const d = String(tel ?? '').replace(/\D/g, '')
  if (d.length < 10) return null
  return `https://wa.me/${d.startsWith('55') ? d : '55' + d}`
}

// Quem está devendo e quanto. O saldo vem da view clientes_saldo_fiado:
//   Σ vendas (forma_pagamento <> 'a_vista')  −  Σ pagamentos
// A view alertas_fiado é essa mesma conta já com o nome do cliente e só quem
// deve (saldo > 0), ordenada do maior pro menor. As duas são security_invoker,
// então a RLS separa por empresa — o admin só enxerga os clientes da loja dele.
export default function ClientesFiado({ empresaId }) {
  const [linhas, setLinhas] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const [busca, setBusca] = useState('')

  useEffect(() => {
    let vivo = true
    async function load() {
      setLoading(true); setErro(null)
      // alertas_fiado não traz telefone/limite; busca os dados do cliente à parte
      // e junta por id (a view não tem FK, então não dá pra embutir no select).
      const [fi, cl] = await Promise.all([
        supabase.from('alertas_fiado').select('cliente_id, cliente_nome, saldo_fiado'),
        supabase.from('clientes').select('id, telefone, limite_credito').eq('empresa_id', empresaId),
      ])
      if (!vivo) return
      if (fi.error) { setErro(fi.error.message); setLoading(false); return }
      const extra = Object.fromEntries((cl.data ?? []).map(c => [c.id, c]))
      setLinhas((fi.data ?? []).map(f => ({
        ...f,
        saldo_fiado: Number(f.saldo_fiado || 0),
        telefone: extra[f.cliente_id]?.telefone ?? null,
        limite: Number(extra[f.cliente_id]?.limite_credito || 0),
      })))
      setLoading(false)
    }
    if (empresaId) load()
    return () => { vivo = false }
  }, [empresaId])

  const filtradas = useMemo(() => {
    const q = semAcento(busca)
    return q ? linhas.filter(l => semAcento(l.cliente_nome).includes(q)) : linhas
  }, [linhas, busca])

  const total = filtradas.reduce((s, l) => s + l.saldo_fiado, 0)
  const acimaDoLimite = filtradas.filter(l => l.limite > 0 && l.saldo_fiado > l.limite).length

  if (loading) return <div className="empty-state">Carregando...</div>
  if (erro) return <p className="error-text">Erro ao carregar: {erro}</p>

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
          <div className="label">Total a receber</div>
          <div className="value">{fmtBRL(total)}</div>
        </div>
        <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
          <div className="label">Clientes devendo</div>
          <div className="value">{filtradas.length}</div>
        </div>
        {acimaDoLimite > 0 && (
          <div className="card dashboard-card" style={{ flex: '1 1 180px' }}>
            <div className="label">Acima do limite</div>
            <div className="value" style={{ color: '#d97706' }}>{acimaDoLimite}</div>
          </div>
        )}
      </div>

      {linhas.length > 3 && (
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar cliente..."
          style={{ width: '100%', maxWidth: 320, padding: '9px 12px', marginBottom: 12, borderRadius: 8, boxSizing: 'border-box',
            border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14 }} />
      )}

      <div className="data-table">
        {filtradas.length === 0 ? (
          <div className="empty-state">
            {busca ? 'Nenhum cliente com esse nome.' : 'Ninguém devendo no fiado. 🎉'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th style={{ textAlign: 'right' }}>Deve</th>
              </tr>
            </thead>
            <tbody>
              {filtradas.map(l => {
                const estourou = l.limite > 0 && l.saldo_fiado > l.limite
                const link = zap(l.telefone)
                return (
                  <tr key={l.cliente_id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{l.cliente_nome}</div>
                      {l.telefone && (
                        link
                          ? <a href={link} target="_blank" rel="noreferrer"
                              style={{ fontSize: 12.5, color: 'var(--primary)', textDecoration: 'none' }}>
                              💬 {l.telefone}
                            </a>
                          : <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{l.telefone}</span>
                      )}
                      {estourou && (
                        <div style={{ fontSize: 12, color: '#d97706', fontWeight: 700 }}>
                          ⚠️ passou do limite de {fmtBRL(l.limite)}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 800, whiteSpace: 'nowrap' }}>
                      {fmtBRL(l.saldo_fiado)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
