import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { listarPedidosSalvos, salvarPedidosSalvos, EXPIRA_CONCLUIDO_MS } from '../lib/meusPedidos'

const STATUS_INFO = {
  aguardando_pagamento: { label: 'Aguardando pagamento', cor: '#a16207', bg: '#fef9c3' },
  aguardando:           { label: 'Aguardando confirmação', cor: '#a16207', bg: '#fef9c3' },
  confirmado:           { label: 'Confirmado', cor: '#1d4ed8', bg: '#dbeafe' },
  em_preparo:           { label: 'Em preparo', cor: '#1d4ed8', bg: '#dbeafe' },
  pronto:               { label: 'Pronto', cor: '#0d9488', bg: '#ccfbf1' },
  saiu_entrega:         { label: 'Saiu para entrega', cor: '#7c3aed', bg: '#ede9fe' },
  entregue:             { label: 'Entregue', cor: '#16a34a', bg: '#dcfce7' },
  cancelado:            { label: 'Cancelado', cor: '#dc2626', bg: '#fee2e2' },
}
const CONCLUIDOS = ['entregue', 'cancelado']

function fmt(n) {
  return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function MeusPedidos() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const lojaFiltro = params.get('loja')
  const [pedidos, setPedidos] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      let salvos = listarPedidosSalvos()
      if (lojaFiltro) salvos = salvos.filter(s => s.empresaId === lojaFiltro)
      if (salvos.length === 0) { setPedidos([]); setLoading(false); return }

      const { data } = await supabase
        .from('pedidos_delivery')
        .select('id, numero_pedido, status, total, created_at, cliente_nome')
        .in('id', salvos.map(s => s.id))

      const porId = Object.fromEntries((data ?? []).map(p => [p.id, p]))
      const agora = Date.now()
      const todos = listarPedidosSalvos() // lista completa para reescrever sem perder de outras lojas
      let mudou = false
      const visiveis = []

      for (const s of salvos) {
        const pedido = porId[s.id]
        const ref = todos.find(t => t.id === s.id)
        if (!pedido) {
          // pedido sumiu do banco — remove do aparelho
          if (ref) { todos.splice(todos.indexOf(ref), 1); mudou = true }
          continue
        }
        if (CONCLUIDOS.includes(pedido.status)) {
          // marca quando vimos concluído pela 1ª vez e expira 48h depois
          if (ref && !ref.concluidoEm) { ref.concluidoEm = agora; mudou = true }
          const concluidoEm = ref?.concluidoEm ?? agora
          if (agora - concluidoEm > EXPIRA_CONCLUIDO_MS) {
            if (ref) { todos.splice(todos.indexOf(ref), 1); mudou = true }
            continue
          }
        }
        visiveis.push(pedido)
      }

      if (mudou) salvarPedidosSalvos(todos)
      visiveis.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      setPedidos(visiveis)
      setLoading(false)
    }
    load()
  }, [lojaFiltro])

  return (
    <div style={{ minHeight: '100vh', background: '#0f0f1a' }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 16px', background: '#16161f', borderBottom: '1px solid rgba(255,255,255,.08)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <button type="button" onClick={() => navigate(-1)} aria-label="Voltar"
          style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: 0 }}>‹</button>
        <h1 style={{ margin: 0, fontSize: 17, color: '#fff' }}>Meus pedidos</h1>
      </header>

      <main style={{ maxWidth: 560, margin: '0 auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: '#94a3b8', padding: 30 }}>Carregando...</p>
        ) : pedidos.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: 50 }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🧾</div>
            <p>Você ainda não fez nenhum pedido por aqui.</p>
          </div>
        ) : (
          pedidos.map(p => {
            const st = STATUS_INFO[p.status] ?? STATUS_INFO.aguardando
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => navigate(`/pedido/${p.id}`)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  background: '#16161f', border: '1px solid rgba(255,255,255,.08)', borderRadius: 12, padding: 14,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 800, fontSize: 15, color: '#fff' }}>
                    #{p.numero_pedido ?? p.id.slice(-4).toUpperCase()}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: st.bg, color: st.cor }}>
                    {st.label}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, color: '#94a3b8', fontSize: 13 }}>
                  <span>{new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <strong style={{ color: '#fff' }}>R$ {fmt(p.total)}</strong>
                </div>
              </button>
            )
          })
        )}
      </main>
    </div>
  )
}
