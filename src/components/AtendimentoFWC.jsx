import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// ── Atendimento FWC ─────────────────────────────────────────────────────────
//
// A conversa do número oficial da plataforma ("FWC Inter"), direto do Super
// ADM (mig 0257). Esse número é Cloud API pura — não tem celular com WhatsApp
// —, então é AQUI que se lê e responde o lojista: quem respondeu a cobrança da
// mensalidade, mandou comprovante, pediu ajuda.
//
// Regra da Meta que manda no desenho da tela: dá pra escrever livremente até
// 24h depois da ÚLTIMA mensagem da pessoa. Fora disso (ou pra puxar conversa
// com quem nunca escreveu) só sai MODELO aprovado. A tela mostra qual dos dois
// vale agora, em vez de deixar a pessoa digitar e levar erro.

const JANELA_MS = 24 * 60 * 60 * 1000

const chaveTel = (t) => String(t ?? '').replace(/\D/g, '').slice(-8)

// "558487417625" → "(84) 8741-7625" — mesmo formato do gestor.
function telefoneBonito(phone) {
  const d = String(phone ?? '').replace(/\D/g, '')
  const local = d.startsWith('55') ? d.slice(2) : d
  if (local.length !== 10 && local.length !== 11) return String(phone ?? '')
  const meio = local.length === 11 ? local.slice(2, 7) : local.slice(2, 6)
  const fim = local.length === 11 ? local.slice(7) : local.slice(6)
  return `(${local.slice(0, 2)}) ${meio}-${fim}`
}

function quando(iso) {
  const d = new Date(iso)
  const hoje = new Date()
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === hoje.toDateString()) return hora
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hora}`
}

// Troca {{1}}, {{2}}… pelos valores digitados — é a prévia do que o lojista vai ler.
function montarTexto(corpo, params) {
  return String(corpo ?? '').replace(/\{\{(\d+)\}\}/g, (_, i) => {
    const v = params[Number(i) - 1]
    return v ? v : `[campo ${i}]`
  })
}

async function chamar(body) {
  const { data, error } = await supabase.functions.invoke('admin-chat', { body })
  if (error) {
    let erro = error.message
    try {
      const j = await error.context?.json?.()
      if (j?.erro) erro = j.erro
    } catch { /* resposta sem corpo */ }
    return { ok: false, erro }
  }
  return data ?? { ok: false, erro: 'Sem resposta do servidor.' }
}

// Bip curto quando chega mensagem nova. Navegador bloqueia som antes do
// primeiro clique na página — aí fica calado, sem erro.
function tocarAviso() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = 880
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    o.connect(g).connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.36)
    o.onended = () => ctx.close()
  } catch { /* sem som, tudo bem */ }
}

function useTelaLarga() {
  const q = '(min-width: 760px)'
  const [larga, setLarga] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const f = () => setLarga(mq.matches)
    mq.addEventListener?.('change', f)
    return () => mq.removeEventListener?.('change', f)
  }, [])
  return larga
}

// Foto/áudio/documento que o lojista mandou. Vive 24h no bucket (mig 0242);
// depois disso a mensagem fica, sem o anexo.
function Midia({ path, tipo }) {
  const [url, setUrl] = useState(null)
  const [erro, setErro] = useState(false)
  useEffect(() => {
    if (!path) return
    let vivo = true
    supabase.storage.from('chat-midias').createSignedUrl(path, 60 * 60).then(({ data, error }) => {
      if (!vivo) return
      if (error || !data?.signedUrl) setErro(true)
      else setUrl(data.signedUrl)
    })
    return () => { vivo = false }
  }, [path])

  if (erro) return <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 4 }}>(não consegui abrir o arquivo)</div>
  if (!url) return <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 4 }}>carregando…</div>
  if (tipo === 'imagem') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 6 }}>
        <img src={url} alt="Imagem enviada" loading="lazy"
          style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8, display: 'block' }} />
      </a>
    )
  }
  if (tipo === 'audio') return <audio src={url} controls preload="metadata" style={{ display: 'block', marginTop: 6, maxWidth: '100%' }} />
  if (tipo === 'video') return <video src={url} controls preload="metadata" style={{ display: 'block', marginTop: 6, maxWidth: '100%', maxHeight: 260, borderRadius: 8 }} />
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      style={{ display: 'inline-block', marginTop: 6, fontSize: 12, color: '#60a5fa', textDecoration: 'underline' }}>
      abrir arquivo
    </a>
  )
}

// ✓ saiu · ✓✓ entregue · ✓✓ azul leu · ⚠ não chegou (com o motivo da Meta).
function StatusEnvio({ m }) {
  if (m.status === 'falhou') {
    return <span title={m.erro || 'A Meta não entregou'} style={{ color: '#ef4444', fontWeight: 700 }}>⚠ não chegou</span>
  }
  if (m.status === 'lido') return <span style={{ color: '#3b82f6', fontWeight: 700 }}>✓✓</span>
  if (m.status === 'entregue') return <span>✓✓</span>
  return <span>✓</span>
}

export default function AtendimentoFWC() {
  const larga = useTelaLarga()
  const [aberto, setAberto] = useState(false)
  const [msgs, setMsgs] = useState([])
  const [empresas, setEmpresas] = useState([])
  const [numeroFwc, setNumeroFwc] = useState('')
  const [sel, setSel] = useState(null)          // chave (8 dígitos) da conversa aberta
  const [nova, setNova] = useState(null)        // conversa ainda sem mensagem: { chave, telefone, empresa }
  const [escolhendoNova, setEscolhendoNova] = useState(false)
  const [busca, setBusca] = useState('')
  const [outroNumero, setOutroNumero] = useState('')
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [aviso, setAviso] = useState(null)
  const [modelos, setModelos] = useState(null)  // null = ainda não buscou
  const [modeloSel, setModeloSel] = useState(null)
  const [params, setParams] = useState([])
  const [agora, setAgora] = useState(() => Date.now())
  const fimRef = useRef(null)

  const carregar = useCallback(async () => {
    const { data } = await supabase.from('admin_chat')
      .select('id, telefone, nome, empresa_id, remetente, texto, tipo, midia_path, midia_tipo, status, erro, lida, created_at')
      .order('created_at', { ascending: false })
      .limit(1500)
    if (Array.isArray(data)) setMsgs(data.reverse())
  }, [])

  useEffect(() => {
    carregar()
    supabase.from('empresas').select('id, nome, telefone_contato').order('nome')
      .then(({ data }) => setEmpresas(Array.isArray(data) ? data : []))
    supabase.from('config_global').select('valor').eq('chave', 'admin_cloud_display_number').maybeSingle()
      .then(({ data }) => setNumeroFwc(String(data?.valor ?? '')))

    // Tempo real pra mensagem nova; o intervalo é a rede de segurança quando a
    // conexão do realtime cai sem avisar (celular dormindo, wi-fi trocando).
    const canal = supabase.channel('atendimento-fwc')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_chat' }, () => carregar())
      .subscribe()
    const poll = setInterval(carregar, 30000)
    const relogio = setInterval(() => setAgora(Date.now()), 60000)
    return () => {
      supabase.removeChannel(canal)
      clearInterval(poll)
      clearInterval(relogio)
    }
  }, [carregar])

  useEffect(() => {
    if (!aberto) return
    const f = (e) => { if (e.key === 'Escape') setAberto(false) }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [aberto])

  const empPorId = useMemo(() => Object.fromEntries(empresas.map((e) => [e.id, e])), [empresas])
  const empPorChave = useMemo(() => {
    const m = {}
    for (const e of empresas) {
      const k = chaveTel(e.telefone_contato)
      if (k.length === 8) m[k] = e
    }
    return m
  }, [empresas])

  // Uma conversa por pessoa. A chave são os 8 últimos dígitos: a Meta entrega
  // o celular sem o 9 e a gente manda com o 9 — é o mesmo número.
  const conversas = useMemo(() => {
    const mapa = new Map()
    for (const m of msgs) {
      const k = chaveTel(m.telefone)
      if (!k) continue
      let c = mapa.get(k)
      if (!c) {
        c = { chave: k, telefone: m.telefone, nomePerfil: null, empresaId: null, msgs: [], naoLidas: 0, ultimaCliente: null }
        mapa.set(k, c)
      }
      c.msgs.push(m)
      if (m.remetente === 'cliente') {
        c.telefone = m.telefone
        if (m.nome) c.nomePerfil = m.nome
        c.ultimaCliente = m.created_at
        if (!m.lida) c.naoLidas++
      }
      if (m.empresa_id) c.empresaId = m.empresa_id
    }
    const lista = [...mapa.values()].map((c) => {
      const empresa = (c.empresaId && empPorId[c.empresaId]) || empPorChave[c.chave] || null
      return {
        ...c,
        empresa,
        titulo: empresa?.nome || c.nomePerfil || telefoneBonito(c.telefone),
        ultima: c.msgs[c.msgs.length - 1],
      }
    })
    lista.sort((a, b) => new Date(b.ultima.created_at) - new Date(a.ultima.created_at))
    return lista
  }, [msgs, empPorId, empPorChave])

  const naoLidasTotal = useMemo(() => conversas.reduce((s, c) => s + c.naoLidas, 0), [conversas])

  const antesRef = useRef(null)
  useEffect(() => {
    if (antesRef.current !== null && naoLidasTotal > antesRef.current) tocarAviso()
    antesRef.current = naoLidasTotal
  }, [naoLidasTotal])

  const atual = useMemo(() => {
    if (!sel) return null
    const c = conversas.find((x) => x.chave === sel)
    if (c) return c
    if (nova?.chave === sel) {
      return {
        chave: nova.chave, telefone: nova.telefone, empresa: nova.empresa, msgs: [], naoLidas: 0, ultimaCliente: null,
        titulo: nova.empresa?.nome || telefoneBonito(nova.telefone),
      }
    }
    return null
  }, [sel, conversas, nova])

  // Abriu a conversa com a janela aberta: o que ele mandou está sendo lido.
  useEffect(() => {
    if (!aberto || !atual?.naoLidas) return
    supabase.from('admin_chat').update({ lida: true })
      .eq('remetente', 'cliente').eq('lida', false).like('telefone', `%${atual.chave}`)
      .then(() => carregar())
  }, [aberto, atual?.chave, atual?.naoLidas, carregar])

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: 'end' })
  }, [atual?.chave, atual?.msgs.length, aberto])

  const janelaAte = atual?.ultimaCliente ? new Date(atual.ultimaCliente).getTime() + JANELA_MS : 0
  const janelaAberta = janelaAte > agora

  const buscarModelos = useCallback(async () => {
    const r = await chamar({ acao: 'modelos' })
    if (r.ok) setModelos(r.modelos ?? [])
    else { setModelos([]); setAviso(r.erro) }
  }, [])

  useEffect(() => {
    if (atual && !janelaAberta && modelos === null) buscarModelos()
  }, [atual, janelaAberta, modelos, buscarModelos])

  function abrirConversa(chave) {
    setSel(chave)
    setAviso(null)
    setTexto('')
    setModeloSel(null)
    setParams([])
    setEscolhendoNova(false)
  }

  function comecarCom(telefone, empresa) {
    const k = chaveTel(telefone)
    if (k.length < 8) { setAviso('Número incompleto.'); return }
    setNova({ chave: k, telefone: String(telefone).replace(/\D/g, ''), empresa: empresa ?? empPorChave[k] ?? null })
    setOutroNumero('')
    abrirConversa(k)
  }

  async function enviarTexto() {
    const t = texto.trim()
    if (!t || !atual || enviando) return
    setEnviando(true)
    setAviso(null)
    const r = await chamar({ acao: 'enviar', telefone: atual.telefone, texto: t })
    setEnviando(false)
    if (r.ok) { setTexto(''); carregar() }
    else setAviso(r.erro)
  }

  async function enviarModelo() {
    if (!atual || !modeloSel || enviando) return
    if (params.some((p) => !String(p).trim())) { setAviso('Preencha todos os campos do modelo.'); return }
    setEnviando(true)
    setAviso(null)
    const r = await chamar({
      acao: 'enviar_modelo', telefone: atual.telefone,
      nome: modeloSel.nome, idioma: modeloSel.idioma, params, corpo: modeloSel.corpo,
    })
    setEnviando(false)
    if (r.ok) { setModeloSel(null); setParams([]); carregar() }
    else setAviso(r.erro)
  }

  const listaFiltrada = useMemo(() => {
    const b = busca.trim().toLowerCase()
    if (!b) return conversas
    const dig = b.replace(/\D/g, '')
    return conversas.filter((c) =>
      c.titulo.toLowerCase().includes(b) || (dig && String(c.telefone).includes(dig)))
  }, [busca, conversas])

  const lojasComTelefone = useMemo(() => {
    const b = busca.trim().toLowerCase()
    return empresas
      .filter((e) => chaveTel(e.telefone_contato).length === 8)
      .filter((e) => !b || e.nome.toLowerCase().includes(b))
  }, [empresas, busca])

  const mostraLista = larga || !atual
  const mostraConversa = larga || !!atual

  // ── Visual ────────────────────────────────────────────────────────────────
  const botaoFlutuante = (
    <button
      type="button"
      onClick={() => setAberto(true)}
      aria-label={`Atendimento FWC${naoLidasTotal ? ` — ${naoLidasTotal} não lida(s)` : ''}`}
      title="Atendimento FWC — conversas do número oficial"
      style={{
        position: 'fixed', right: 20, bottom: 20, zIndex: 900,
        width: 58, height: 58, borderRadius: '50%', border: 'none', cursor: 'pointer',
        background: '#16a34a', color: '#fff', fontSize: 26, lineHeight: 1,
        boxShadow: '0 8px 24px rgba(0,0,0,.28)',
        display: aberto ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      💬
      {naoLidasTotal > 0 && (
        <span style={{
          position: 'absolute', top: -4, right: -4, minWidth: 22, height: 22, padding: '0 6px',
          borderRadius: 11, background: '#ef4444', color: '#fff', fontSize: 12, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--surface)',
        }}>{naoLidasTotal > 99 ? '99+' : naoLidasTotal}</span>
      )}
    </button>
  )

  if (!aberto) return botaoFlutuante

  const lista = (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%',
      width: larga ? 300 : '100%', flexShrink: 0,
      borderRight: larga ? '1px solid var(--border)' : 'none',
    }}>
      <div style={{ padding: 10, display: 'flex', gap: 6 }}>
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={escolhendoNova ? 'Buscar loja…' : 'Buscar conversa…'}
          style={{
            flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 8, fontSize: 13,
            border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
          }}
        />
        <button
          type="button"
          onClick={() => { setEscolhendoNova((v) => !v); setBusca('') }}
          style={{
            padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
            border: '1px solid var(--primary)', whiteSpace: 'nowrap',
            background: escolhendoNova ? 'var(--primary)' : 'var(--primary-bg)',
            color: escolhendoNova ? 'var(--primary-contrast)' : 'var(--primary)',
          }}
        >{escolhendoNova ? 'Voltar' : '+ Nova'}</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {escolhendoNova ? (
          <div>
            <div style={{ padding: '4px 12px 10px', display: 'flex', gap: 6 }}>
              <input
                value={outroNumero}
                onChange={(e) => setOutroNumero(e.target.value)}
                placeholder="Outro número: (84) 99999-0000"
                inputMode="tel"
                style={{
                  flex: 1, minWidth: 0, padding: '7px 9px', borderRadius: 8, fontSize: 12.5,
                  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                }}
              />
              <button type="button" onClick={() => comecarCom(outroNumero)}
                style={{ padding: '7px 10px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
                Abrir
              </button>
            </div>
            <div style={{ padding: '0 12px 6px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Lojas com telefone de contato
            </div>
            {lojasComTelefone.length === 0 && (
              <div style={{ padding: 12, fontSize: 12.5, color: 'var(--text-muted)' }}>Nenhuma loja com telefone de contato.</div>
            )}
            {lojasComTelefone.map((e) => (
              <button key={e.id} type="button" onClick={() => comecarCom(e.telefone_contato, e)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none',
                  borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer',
                }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{e.nome}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{telefoneBonito(e.telefone_contato)}</div>
              </button>
            ))}
          </div>
        ) : (
          <>
            {listaFiltrada.length === 0 && (
              <div style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {conversas.length === 0
                  ? 'Nenhuma conversa ainda. Quando um lojista escrever pro número oficial, ou responder a cobrança, aparece aqui.'
                  : 'Nada encontrado.'}
              </div>
            )}
            {listaFiltrada.map((c) => {
              const ativo = c.chave === sel
              return (
                <button key={c.chave} type="button" onClick={() => abrirConversa(c.chave)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', border: 'none',
                    borderBottom: '1px solid var(--border)', cursor: 'pointer', color: 'var(--text)',
                    background: ativo ? 'var(--primary-bg)' : 'transparent',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: c.naoLidas ? 800 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.titulo}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>{quando(c.ultima.created_at)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.ultima.remetente === 'fwc' ? 'Você: ' : ''}{c.ultima.texto}
                    </span>
                    {c.naoLidas > 0 && (
                      <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: '#16a34a', color: '#fff', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {c.naoLidas}
                      </span>
                    )}
                  </div>
                  {c.empresa && c.nomePerfil && c.nomePerfil !== c.empresa.nome && (
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>WhatsApp: {c.nomePerfil}</div>
                  )}
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )

  const conversa = atual ? (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        {!larga && (
          <button type="button" onClick={() => setSel(null)} aria-label="Voltar pra lista"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: 22, lineHeight: 1, padding: 0 }}>‹</button>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{atual.titulo}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {telefoneBonito(atual.telefone)}{atual.empresa ? ' · lojista' : ''}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px' }}>
        {atual.msgs.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', fontSize: 12.5, color: 'var(--text-muted)', maxWidth: 320, lineHeight: 1.5 }}>
            Conversa nova. Pra escrever primeiro, o WhatsApp oficial exige um <b>modelo aprovado</b> — escolha um aí embaixo.
          </div>
        )}
        {atual.msgs.map((m) => {
          const daFwc = m.remetente === 'fwc'
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: daFwc ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '82%', padding: '7px 11px', borderRadius: 13, fontSize: 13.5, lineHeight: 1.4,
                background: daFwc ? 'rgba(34,197,94,.16)' : 'var(--bg)',
                border: daFwc ? '1px solid rgba(34,197,94,.45)' : '1px solid var(--border)',
                borderBottomRightRadius: daFwc ? 3 : 13, borderBottomLeftRadius: daFwc ? 13 : 3,
                color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {m.tipo === 'modelo' && (
                  <div style={{ fontSize: 9.5, fontWeight: 800, opacity: 0.75, marginBottom: 2 }}>📋 Modelo</div>
                )}
                {m.texto}
                {m.midia_path && <Midia path={m.midia_path} tipo={m.midia_tipo} />}
                <div style={{ fontSize: 9.5, opacity: 0.7, marginTop: 3, textAlign: 'right', display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                  <span>{quando(m.created_at)}</span>
                  {daFwc && <StatusEnvio m={m} />}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={fimRef} />
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px 12px' }}>
        {aviso && (
          <div style={{ fontSize: 12, fontWeight: 600, padding: '6px 9px', borderRadius: 8, marginBottom: 8, background: 'rgba(234,179,8,.14)', color: '#b45309', lineHeight: 1.4 }}>
            {aviso}
          </div>
        )}

        {janelaAberta ? (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              Pode responder livre até {quando(new Date(janelaAte).toISOString())} (24h da última mensagem dele).
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarTexto() } }}
                placeholder="Escreva a resposta… (Enter envia, Shift+Enter pula linha)"
                rows={2}
                style={{
                  flex: 1, minWidth: 0, resize: 'vertical', padding: '8px 10px', borderRadius: 10, fontSize: 13.5,
                  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit',
                }}
              />
              <button type="button" onClick={enviarTexto} disabled={enviando || !texto.trim()}
                style={{
                  padding: '10px 14px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 13.5,
                  background: '#16a34a', color: '#fff', cursor: enviando || !texto.trim() ? 'default' : 'pointer',
                  opacity: enviando || !texto.trim() ? 0.55 : 1,
                }}>{enviando ? '…' : 'Enviar'}</button>
            </div>
          </>
        ) : (
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.4 }}>
              {atual.ultimaCliente
                ? 'Passou de 24h desde a última mensagem dele: agora só dá pra mandar um modelo aprovado. Quando ele responder, a conversa livre abre de novo.'
                : 'Ele ainda não escreveu pra FWC: o primeiro contato tem que ser um modelo aprovado.'}
            </div>
            {modelos === null ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Buscando os modelos aprovados…</div>
            ) : modelos.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                Nenhum modelo aprovado na conta. Crie no Gerenciador do WhatsApp da Meta (categoria Utilidade).
                <button type="button" onClick={() => { setModelos(null); buscarModelos() }}
                  style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontWeight: 700, padding: 0 }}>
                  buscar de novo
                </button>
              </div>
            ) : (
              <>
                <select
                  value={modeloSel ? `${modeloSel.nome}|${modeloSel.idioma}` : ''}
                  onChange={(e) => {
                    const m = modelos.find((x) => `${x.nome}|${x.idioma}` === e.target.value) ?? null
                    setModeloSel(m)
                    setParams(m ? Array.from({ length: m.campos }, () => '') : [])
                  }}
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
                    border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                  }}
                >
                  <option value="">Escolha o modelo…</option>
                  {modelos.map((m) => (
                    <option key={`${m.nome}|${m.idioma}`} value={`${m.nome}|${m.idioma}`} disabled={!m.suportado}>
                      {m.nome} ({m.idioma}){m.suportado ? '' : ' — tem foto/link, ainda não dá pra mandar daqui'}
                    </option>
                  ))}
                </select>
                {modeloSel && (
                  <div style={{ marginTop: 8 }}>
                    {params.map((p, i) => (
                      <input
                        key={i}
                        value={p}
                        onChange={(e) => setParams((ps) => ps.map((v, j) => (j === i ? e.target.value : v)))}
                        placeholder={`Campo {{${i + 1}}}`}
                        style={{
                          display: 'block', width: '100%', boxSizing: 'border-box', marginBottom: 6, padding: '7px 9px',
                          borderRadius: 8, fontSize: 13, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                        }}
                      />
                    ))}
                    <div style={{
                      fontSize: 12.5, lineHeight: 1.45, padding: '8px 10px', borderRadius: 10, marginBottom: 8,
                      background: 'rgba(34,197,94,.10)', border: '1px dashed rgba(34,197,94,.5)', color: 'var(--text)', whiteSpace: 'pre-wrap',
                    }}>
                      {modeloSel.cabecalho && <div style={{ fontWeight: 700, marginBottom: 4 }}>{modeloSel.cabecalho}</div>}
                      {montarTexto(modeloSel.corpo, params)}
                      {modeloSel.rodape && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{modeloSel.rodape}</div>}
                      {modeloSel.botoes.length > 0 && (
                        <div style={{ fontSize: 11.5, marginTop: 6, color: 'var(--text-muted)' }}>Botões: {modeloSel.botoes.join(' · ')}</div>
                      )}
                    </div>
                    <button type="button" onClick={enviarModelo} disabled={enviando}
                      style={{
                        width: '100%', padding: '10px 14px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 13.5,
                        background: '#16a34a', color: '#fff', cursor: enviando ? 'default' : 'pointer', opacity: enviando ? 0.6 : 1,
                      }}>{enviando ? 'Enviando…' : 'Enviar modelo'}</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  ) : (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5 }}>
      Escolha uma conversa, ou toque em <b>&nbsp;+ Nova&nbsp;</b> pra falar com um lojista.
    </div>
  )

  return (
    <>
      <div onClick={() => setAberto(false)}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 950 }} />
      <div role="dialog" aria-label="Atendimento FWC"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 960,
          width: larga ? 'min(900px, 94vw)' : '100vw',
          background: 'var(--surface)', color: 'var(--text)', borderLeft: '1px solid var(--border)',
          boxShadow: '-12px 0 40px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)', background: '#16a34a', color: '#fff' }}>
          <span style={{ fontSize: 20 }}>💬</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Atendimento FWC</div>
            <div style={{ fontSize: 11.5, opacity: 0.9 }}>
              Número oficial {numeroFwc ? telefoneBonito(numeroFwc) : ''} · só você responde, sem robô
            </div>
          </div>
          <button type="button" onClick={() => setAberto(false)} aria-label="Fechar"
            style={{ background: 'rgba(255,255,255,.18)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: 8, fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {mostraLista && lista}
          {mostraConversa && conversa}
        </div>
      </div>
    </>
  )
}
