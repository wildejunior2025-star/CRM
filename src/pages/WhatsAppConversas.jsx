import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

// Formata "558498180774" → "+55 (84) 9818-0774" (best-effort)
function formatarTelefone(p) {
  const d = String(p || '').replace(/\D/g, '')
  const semPais = d.startsWith('55') ? d.slice(2) : d
  if (semPais.length >= 10) {
    const ddd = semPais.slice(0, 2)
    const resto = semPais.slice(2)
    const meio = resto.length >= 9 ? resto.slice(0, 5) : resto.slice(0, 4)
    const fim = resto.length >= 9 ? resto.slice(5) : resto.slice(4)
    return `(${ddd}) ${meio}-${fim}`
  }
  return p
}

function tempoRelativo(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function WhatsAppConversas() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null

  const [conversas, setConversas] = useState([]) // [{phone, ultima, quando, total, nome, pausado}]
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')
  const [soPausados, setSoPausados] = useState(false)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    if (!empresaId) return
    setLoading(true)
    const [convRes, cliRes, pausaRes] = await Promise.all([
      supabase.from('whatsapp_conversas').select('phone, role, content, created_at')
        .eq('empresa_id', empresaId).order('created_at', { ascending: false }).limit(4000),
      supabase.from('clientes').select('nome, telefone').eq('empresa_id', empresaId),
      supabase.from('whatsapp_bot_pausado').select('phone').eq('empresa_id', empresaId),
    ])
    // nome por telefone (casa pelos últimos 8 dígitos)
    const nomePorTel = {}
    for (const c of (cliRes.data ?? [])) {
      const k = String(c.telefone || '').replace(/\D/g, '').slice(-8)
      if (k && c.nome) nomePorTel[k] = c.nome
    }
    const pausadosSet = new Set((pausaRes.data ?? []).map(p => p.phone))
    // agrupa por número (a lista já vem do mais novo pro mais antigo)
    const map = new Map()
    for (const m of (convRes.data ?? [])) {
      if (!map.has(m.phone)) {
        map.set(m.phone, {
          phone: m.phone,
          ultima: m.content ?? '',
          quando: m.created_at,
          total: 0,
          nome: nomePorTel[String(m.phone).slice(-8)] ?? null,
          pausado: pausadosSet.has(m.phone),
        })
      }
      map.get(m.phone).total++
    }
    setConversas([...map.values()])
    setLoading(false)
  }, [empresaId])

  useEffect(() => { load() }, [load])

  async function togglePausa(item) {
    const pausar = !item.pausado
    setBusy(item.phone)
    setConversas(prev => prev.map(c => c.phone === item.phone ? { ...c, pausado: pausar } : c))
    if (pausar) {
      await supabase.from('whatsapp_bot_pausado').insert({ empresa_id: empresaId, phone: item.phone })
    } else {
      await supabase.from('whatsapp_bot_pausado').delete().eq('empresa_id', empresaId).eq('phone', item.phone)
    }
    setBusy(null)
  }

  const filtradas = useMemo(() => {
    const t = busca.trim().toLowerCase()
    const td = t.replace(/\D/g, '')
    return conversas.filter(c => {
      if (soPausados && !c.pausado) return false
      if (!t) return true
      const nomeMatch = c.nome && c.nome.toLowerCase().includes(t)
      const telMatch = td && String(c.phone).replace(/\D/g, '').includes(td)
      return nomeMatch || telMatch
    })
  }, [conversas, busca, soPausados])

  const totalPausados = conversas.filter(c => c.pausado).length

  return (
    <div>
      <div className="page-header">
        <h1>Conversas do bot</h1>
        <div style={{ display: 'flex', gap: 6 }}>
          <span className="badge badge-neutral">{conversas.length} números</span>
          {totalPausados > 0 && <span className="badge badge-danger">{totalPausados} pausado{totalPausados === 1 ? '' : 's'}</span>}
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: -6, maxWidth: 680 }}>
        Todos os números que já conversaram com o robô. <b>Pausar</b> faz o robô <b>parar de responder</b> aquele número
        (você assume a conversa manualmente pelo WhatsApp). <b>Reativar</b> devolve o atendimento pro robô.
      </p>

      <div className="toolbar">
        <input
          placeholder="Buscar por número ou nome..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
        />
        <button
          className={`btn btn-sm ${soPausados ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setSoPausados(v => !v)}
        >
          {soPausados ? '● Só pausados' : 'Só pausados'}
        </button>
      </div>

      {loading ? (
        <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '70%' }} /></div>
      ) : filtradas.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 22 }}>💬</div>
          <strong>{conversas.length === 0 ? 'Nenhuma conversa ainda' : 'Nada encontrado'}</strong>
          <p>{conversas.length === 0 ? 'Quando alguém falar com o robô, aparece aqui.' : 'Tente outro número ou nome.'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtradas.map(item => (
            <div key={item.phone} className="card" style={{
              padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              borderLeft: `4px solid ${item.pausado ? 'var(--danger)' : 'var(--success)'}`,
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700 }}>{formatarTelefone(item.phone)}</span>
                  {item.nome && <span className="badge badge-primary">{item.nome}</span>}
                  {item.pausado
                    ? <span className="badge badge-danger">Pausado</span>
                    : <span className="badge badge-success">Ativo</span>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 }}>
                  {item.ultima || '—'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {tempoRelativo(item.quando)} · {item.total} mensagens
                </div>
              </div>
              <button
                className={`btn btn-sm ${item.pausado ? 'btn-secondary' : 'btn-danger'}`}
                disabled={busy === item.phone}
                onClick={() => togglePausa(item)}
              >
                {busy === item.phone ? '...' : item.pausado ? '▶ Reativar' : '⏸ Pausar'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
