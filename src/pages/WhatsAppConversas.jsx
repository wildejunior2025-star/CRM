import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

function hora(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversa aberta: histórico + caixa de resposta.
//
// A resposta sai pelo MESMO número da loja, pelo mesmo caminho do aviso
// automático de pedido. Do lado do cliente é uma conversa só: ele não sabe (nem
// precisa saber) se quem escreveu foi o robô ou a pessoa do balcão.
// ─────────────────────────────────────────────────────────────────────────────
function Conversa({ empresaId, item, iaAtiva, onFechar, onPausou, onEnviou }) {
  const [msgs, setMsgs] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const [pausado, setPausado] = useState(!!item.pausado)
  const fimRef = useRef(null)

  const carregar = useCallback(async () => {
    const { data } = await supabase
      .from('whatsapp_conversas')
      .select('id, role, content, created_at, origem')
      .eq('empresa_id', empresaId)
      .eq('phone', item.phone)
      .order('created_at', { ascending: true })
      .limit(300)
    setMsgs(data ?? [])
    setCarregando(false)
  }, [empresaId, item.phone])

  useEffect(() => { carregar() }, [carregar])

  // Mensagem nova do cliente entra na tela sem precisar recarregar — quem está
  // atendendo não fica com a conversa parada na frente enquanto o cliente digita.
  useEffect(() => {
    if (!empresaId) return
    const canal = supabase
      .channel(`conversa-${item.phone}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'whatsapp_conversas', filter: `empresa_id=eq.${empresaId}` },
        payload => { if (payload.new?.phone === item.phone) setMsgs(prev => [...prev, payload.new]) })
      .subscribe()
    return () => { canal.unsubscribe() }
  }, [empresaId, item.phone])

  useEffect(() => { fimRef.current?.scrollIntoView({ block: 'end' }) }, [msgs.length])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  async function pausarRobo() {
    await supabase.from('whatsapp_bot_pausado').insert({ empresa_id: empresaId, phone: item.phone })
    setPausado(true)
    onPausou?.(item.phone)
  }

  async function enviar() {
    const msg = texto.trim()
    if (!msg || enviando) return
    setEnviando(true); setErro(null)
    const { data, error } = await supabase.functions.invoke('whatsapp-connect', {
      body: { action: 'send_message', phone: item.phone, text: msg },
    })
    setEnviando(false)
    if (error || !data?.ok) {
      setErro(data?.erro || error?.message || 'Não consegui enviar. Confira se o WhatsApp da loja está conectado.')
      return
    }
    setTexto('')
    // A própria função grava a mensagem na conversa; o realtime traz de volta.
    // Recarrega mesmo assim: se o tempo real estiver atrasado, quem enviou tem
    // que ver a mensagem na tela na hora, senão manda de novo achando que falhou.
    carregar()
    onEnviou?.(item.phone, msg)
    // Assumiu a conversa: o robô sai de cena naquele número, senão os dois
    // respondem juntos e o cliente recebe duas versões da mesma coisa.
    if (iaAtiva && !pausado) pausarRobo()
  }

  const bolha = (m) => {
    const doCliente = m.role === 'user'
    const daLoja = m.origem === 'loja'
    return (
      <div key={m.id} style={{ display: 'flex', justifyContent: doCliente ? 'flex-start' : 'flex-end', marginBottom: 8 }}>
        <div style={{
          maxWidth: '78%', padding: '8px 11px', borderRadius: 12,
          background: doCliente ? 'var(--surface)' : daLoja ? 'rgba(34,197,94,.14)' : 'rgba(124,58,237,.14)',
          border: `1px solid ${doCliente ? 'var(--border)' : daLoja ? 'rgba(34,197,94,.4)' : 'rgba(124,58,237,.4)'}`,
          color: 'var(--text)',
        }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: .3, marginBottom: 3, color: 'var(--text-muted)' }}>
            {doCliente ? 'CLIENTE' : daLoja ? 'VOCÊ' : 'ROBÔ'} · {hora(m.created_at)}
          </div>
          <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 620, width: '94vw' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>
            {item.nome || formatarTelefone(item.phone)}
            {item.nome && <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}> · {formatarTelefone(item.phone)}</span>}
          </h2>
          <button className="btn btn-secondary btn-sm" onClick={onFechar}>Fechar</button>
        </div>

        {iaAtiva && (
          <p style={{ fontSize: 12.5, margin: '8px 0 0', color: pausado ? 'var(--text-muted)' : '#b45309' }}>
            {pausado
              ? '⏸ Robô pausado nesta conversa — quem responde é você. Pra devolver pro robô, use o botão Reativar na lista.'
              : '⚠️ O robô está atendendo este número. Assim que você responder, ele é pausado aqui pra vocês dois não falarem junto.'}
          </p>
        )}

        <div style={{
          marginTop: 12, padding: 12, borderRadius: 10, background: 'var(--bg)',
          border: '1px solid var(--border)', height: '46vh', overflowY: 'auto',
        }}>
          {carregando
            ? <div className="skeleton-row" />
            : msgs.length === 0
              ? <p style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>Nenhuma mensagem guardada deste número.</p>
              : msgs.map(bolha)}
          <div ref={fimRef} />
        </div>

        {erro && <p className="error-text" style={{ marginTop: 10 }}>{erro}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
          <textarea
            value={texto}
            onChange={e => setTexto(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } }}
            placeholder="Escreva a resposta... (Enter envia, Shift+Enter pula linha)"
            rows={2}
            style={{
              flex: 1, resize: 'vertical', padding: '9px 11px', borderRadius: 9,
              border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))',
              color: 'var(--text)', fontSize: 14, fontFamily: 'inherit',
            }}
          />
          <button className="btn btn-primary" onClick={enviar} disabled={enviando || !texto.trim()}>
            {enviando ? 'Enviando...' : 'Enviar'}
          </button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>
          Sai pelo WhatsApp da loja, no mesmo número que o cliente já conhece.
        </p>
      </div>
    </div>
  )
}

export default function WhatsAppConversas() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null

  const [conversas, setConversas] = useState([]) // [{phone, ultima, quando, total, nome, pausado}]
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')
  const [soPausados, setSoPausados] = useState(false)
  const [busy, setBusy] = useState(null)
  const [aberta, setAberta] = useState(null)   // conversa aberta na tela
  const [iaAtiva, setIaAtiva] = useState(false)

  const load = useCallback(async () => {
    if (!empresaId) return
    setLoading(true)
    const [convRes, cliRes, pausaRes, cfgRes] = await Promise.all([
      supabase.from('whatsapp_conversas').select('phone, role, content, created_at')
        .eq('empresa_id', empresaId).order('created_at', { ascending: false }).limit(4000),
      supabase.from('clientes').select('nome, telefone').eq('empresa_id', empresaId),
      supabase.from('whatsapp_bot_pausado').select('phone').eq('empresa_id', empresaId),
      supabase.from('whatsapp_config').select('ia_ativo').eq('empresa_id', empresaId).maybeSingle(),
    ])
    setIaAtiva(cfgRes.data?.ia_ativo === true)
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

  // Mensagem nova de qualquer número reordena a lista sozinha — sem isso o
  // atendente ficaria com a tela velha na frente sem saber que chegou coisa.
  useEffect(() => {
    if (!empresaId) return
    const canal = supabase
      .channel(`conversas-lista-${empresaId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'whatsapp_conversas', filter: `empresa_id=eq.${empresaId}` },
        () => load())
      .subscribe()
    return () => { canal.unsubscribe() }
  }, [empresaId, load])

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
        <h1>Conversas do WhatsApp</h1>
        <div style={{ display: 'flex', gap: 6 }}>
          <span className="badge badge-neutral">{conversas.length} números</span>
          {totalPausados > 0 && <span className="badge badge-danger">{totalPausados} pausado{totalPausados === 1 ? '' : 's'}</span>}
        </div>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: -6, maxWidth: 720 }}>
        Todo mundo que já falou com o WhatsApp da loja. Clique num número pra <b>ler a conversa e responder</b> —
        a resposta chega no WhatsApp do cliente, no mesmo número de sempre.
        {' '}<b>Pausar</b> faz o robô parar de responder aquele número; <b>Reativar</b> devolve pra ele.
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
          <p>{conversas.length === 0 ? 'Quando alguém falar com o WhatsApp da loja, aparece aqui.' : 'Tente outro número ou nome.'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtradas.map(item => (
            <div key={item.phone} className="card" style={{
              padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              borderLeft: `4px solid ${item.pausado ? 'var(--danger)' : 'var(--success)'}`,
            }}>
              <button
                type="button"
                onClick={() => setAberta(item)}
                style={{ minWidth: 0, flex: 1, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700 }}>{formatarTelefone(item.phone)}</span>
                  {item.nome && <span className="badge badge-primary">{item.nome}</span>}
                  {item.pausado
                    ? <span className="badge badge-danger">Robô pausado</span>
                    : <span className="badge badge-success">Robô ativo</span>}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 520 }}>
                  {item.ultima || '—'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {tempoRelativo(item.quando)} · {item.total} mensagens
                </div>
              </button>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn btn-primary btn-sm" onClick={() => setAberta(item)}>💬 Responder</button>
                <button
                  className={`btn btn-sm ${item.pausado ? 'btn-secondary' : 'btn-danger'}`}
                  disabled={busy === item.phone}
                  onClick={() => togglePausa(item)}
                >
                  {busy === item.phone ? '...' : item.pausado ? '▶ Reativar' : '⏸ Pausar'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {aberta && (
        <Conversa
          empresaId={empresaId}
          item={aberta}
          iaAtiva={iaAtiva}
          onFechar={() => { setAberta(null); load() }}
          onPausou={phone => setConversas(prev => prev.map(c => c.phone === phone ? { ...c, pausado: true } : c))}
          onEnviou={(phone, msg) => setConversas(prev => prev.map(c => c.phone === phone ? { ...c, ultima: msg, quando: new Date().toISOString() } : c))}
        />
      )}
    </div>
  )
}
