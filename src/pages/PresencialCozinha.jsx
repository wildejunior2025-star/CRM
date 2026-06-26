import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { imprimirHtml, montarComandaCozinhaHtml } from '../utils/imprimirCupom'
import '../components/Page.css'

function tempoDesde(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'agora'
  if (min === 1) return '1 min'
  return `${min} min`
}

export default function PresencialCozinha() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  const [itens, setItens]     = useState([])
  const [loading, setLoading] = useState(true)
  const [, setTick]           = useState(0)

  async function load() {
    if (!empresaId) return
    const { data } = await supabase
      .from('comanda_itens')
      .select('*, comandas!inner(numero_mesa, status)')
      .eq('empresa_id', empresaId)
      .eq('status', 'pendente')
      .eq('comandas.status', 'aberta')
      .order('created_at')
    setItens(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Atualiza o "tempo de espera" a cada 30s
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  // Realtime
  useEffect(() => {
    if (!empresaId) return
    const ch = supabase.channel(`kds_${empresaId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_itens', filter: `empresa_id=eq.${empresaId}` }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  async function marcarPronto(item) {
    await supabase.from('comanda_itens').update({ status: 'pronto' }).eq('id', item.id)
    load()
  }

  const porMesa = useMemo(() => {
    const map = {}
    for (const it of itens) {
      const k = it.comandas?.numero_mesa ?? '—'
      ;(map[k] = map[k] || []).push(it)
    }
    return Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]))
  }, [itens])

  if (loading) return <div className="page"><p>Carregando cozinha...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Cozinha (KDS)</h1>
          <p className="page-subtitle">Itens aguardando preparo, ao vivo.</p>
        </div>
      </div>

      {porMesa.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
          🍳 Nenhum item na fila. Tudo em dia!
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
          {porMesa.map(([mesa, lista]) => (
            <div key={mesa} style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ background: 'var(--primary)', color: '#fff', padding: '10px 14px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Mesa {mesa}</span>
                <button type="button" title="Imprimir comanda"
                  onClick={() => imprimirHtml(montarComandaCozinhaHtml({ numeroMesa: mesa, itens: lista }))}
                  style={{ background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff', borderRadius: 8, cursor: 'pointer', fontSize: 16, padding: '2px 8px' }}>
                  🖨️
                </button>
              </div>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {lista.map(item => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {item.quantidade}× {item.nome}
                      </div>
                      {item.observacao && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{item.observacao}</div>}
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>há {tempoDesde(item.created_at)}</div>
                    </div>
                    <button type="button" onClick={() => marcarPronto(item)}
                      style={{ padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12.5,
                        border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.12)', color: '#16a34a' }}>
                      ✓ Pronto
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
