import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { corAvatar, inicialDe, horaCurta, horaLista, diaRotulo, agruparBolhas } from '../lib/chatVisual'
import './AtendimentoFWC.css'

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
//
// VISUAL (18/11/2026): refeito com cara de WhatsApp (lista com avatar, bolhas com
// rabinho, hora e ✓✓ dentro da bolha, separador de dia, caixa de escrever
// arredondada). A versão anterior usava fontes de ~22px e no celular era ruim de
// usar. Estilos em AtendimentoFWC.css; a lógica abaixo não mudou.

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

function rotuloMidia(tipo) {
  if (tipo === 'imagem') return '📷 Foto'
  if (tipo === 'audio') return '🎤 Áudio'
  if (tipo === 'video') return '🎥 Vídeo'
  return '📎 Arquivo'
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

  if (erro) return <div className="atw-midia-txt">(não consegui abrir o arquivo)</div>
  if (!url) return <div className="atw-midia-txt">carregando…</div>
  if (tipo === 'imagem') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img className="atw-midia-img" src={url} alt="Imagem enviada" loading="lazy" />
      </a>
    )
  }
  if (tipo === 'audio') return <audio src={url} controls preload="metadata" />
  if (tipo === 'video') return <video src={url} controls preload="metadata" />
  return <a href={url} target="_blank" rel="noopener noreferrer">abrir arquivo</a>
}

// ✓ saiu · ✓✓ entregue · ✓✓ azul leu · ⚠ não chegou (com o motivo da Meta).
function StatusEnvio({ m }) {
  if (m.status === 'falhou') {
    return <span className="atw-tick falhou" title={m.erro || 'A Meta não entregou'}>⚠ não chegou</span>
  }
  if (m.status === 'lido') return <span className="atw-tick lido">✓✓</span>
  if (m.status === 'entregue') return <span className="atw-tick">✓✓</span>
  return <span className="atw-tick">✓</span>
}

const IconeVoltar = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" /></svg>
)
const IconeFechar = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
)
const IconeNova = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-3 9h-4v4h-2v-4H7V9h4V5h2v4h4v2z" /></svg>
)
const IconeEnviar = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
)

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
  const corpoRef = useRef(null)
  const campoRef = useRef(null)

  const carregar = useCallback(async () => {
    const { data } = await supabase.from('admin_chat')
      .select('id, telefone, nome, empresa_id, remetente, texto, tipo, midia_path, midia_tipo, status, erro, lida, created_at, canal')
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

  // Uma conversa por pessoa E POR NÚMERO DA FWC. A chave são os 8 últimos
  // dígitos (a Meta entrega o celular sem o 9 e a gente manda com o 9 — é o
  // mesmo número) mais o canal: quem falou nos dois números da FWC tem duas
  // conversas, porque a resposta precisa sair pelo mesmo número que ele chamou.
  const conversas = useMemo(() => {
    const mapa = new Map()
    for (const m of msgs) {
      const tel = chaveTel(m.telefone)
      if (!tel) continue
      const canal = m.canal === 'evolution' ? 'evolution' : 'cloud'
      const k = `${canal}|${tel}`
      let c = mapa.get(k)
      if (!c) {
        c = { chave: k, chaveTel: tel, canal, telefone: m.telefone, nomePerfil: null, empresaId: null, msgs: [], naoLidas: 0, ultimaCliente: null }
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
      const empresa = (c.empresaId && empPorId[c.empresaId]) || empPorChave[c.chaveTel] || null
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
        chave: nova.chave, chaveTel: chaveTel(nova.telefone), canal: 'cloud',
        telefone: nova.telefone, empresa: nova.empresa, msgs: [], naoLidas: 0, ultimaCliente: null,
        titulo: nova.empresa?.nome || telefoneBonito(nova.telefone),
      }
    }
    return null
  }, [sel, conversas, nova])

  // Abriu a conversa com a janela aberta: o que ele mandou está sendo lido.
  useEffect(() => {
    if (!aberto || !atual?.naoLidas) return
    supabase.from('admin_chat').update({ lida: true })
      .eq('remetente', 'cliente').eq('lida', false).like('telefone', `%${atual.chaveTel}`)
      .then(() => carregar())
  }, [aberto, atual?.chave, atual?.chaveTel, atual?.naoLidas, carregar])

  // Sempre no fim da conversa (a mensagem mais nova). Rola só a caixa das
  // mensagens — scrollIntoView puxava a página inteira no celular.
  useEffect(() => {
    const el = corpoRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [atual?.chave, atual?.msgs.length, aberto])

  // Mensagens com o separador de dia e o "rabinho" (primeira bolha de cada
  // sequência do mesmo lado) já resolvidos.
  const msgsAtuais = atual?.msgs
  const bolhas = useMemo(() => agruparBolhas(msgsAtuais, (m) => m.remetente), [msgsAtuais])

  // A janela de 24h é regra da Meta. No número do Evolution ela não existe:
  // escreve e vai, a qualquer hora, sem modelo aprovado.
  const ehEvolution = atual?.canal === 'evolution'
  const janelaAte = atual?.ultimaCliente ? new Date(atual.ultimaCliente).getTime() + JANELA_MS : 0
  const janelaAberta = ehEvolution || janelaAte > agora

  const buscarModelos = useCallback(async () => {
    const r = await chamar({ acao: 'modelos' })
    if (r.ok) setModelos(r.modelos ?? [])
    else { setModelos([]); setAviso(r.erro) }
  }, [])

  useEffect(() => {
    if (atual && !ehEvolution && !janelaAberta && modelos === null) buscarModelos()
  }, [atual, ehEvolution, janelaAberta, modelos, buscarModelos])

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

  function ajustarAltura(el) {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  async function enviarTexto() {
    const t = texto.trim()
    if (!t || !atual || enviando) return
    setEnviando(true)
    setAviso(null)
    const r = await chamar({ acao: 'enviar', telefone: atual.telefone, texto: t, canal: atual.canal })
    setEnviando(false)
    if (r.ok) {
      setTexto('')
      if (campoRef.current) campoRef.current.style.height = 'auto'
      carregar()
    } else setAviso(r.erro)
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
  // No celular o Enter pula linha (quem envia é o botão); no computador Enter envia.
  const enterEnvia = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches

  // ── Visual ────────────────────────────────────────────────────────────────
  if (!aberto) {
    return (
      <div className="atw">
        <button
          type="button"
          className="atw-fab"
          onClick={() => setAberto(true)}
          aria-label={`Atendimento FWC${naoLidasTotal ? ` — ${naoLidasTotal} não lida(s)` : ''}`}
          title="Atendimento FWC — conversas do número oficial"
        >
          💬
          {naoLidasTotal > 0 && (
            <span className="atw-fab-badge">{naoLidasTotal > 99 ? '99+' : naoLidasTotal}</span>
          )}
        </button>
      </div>
    )
  }

  const lista = (
    <div className="atw-lista">
      <div className="atw-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="atw-head-titulo">Atendimento FWC</div>
          <div className="atw-head-sub">{numeroFwc ? `${telefoneBonito(numeroFwc)} · ` : ''}só você responde, sem robô</div>
        </div>
        <button type="button" className="atw-icone"
          onClick={() => { setEscolhendoNova((v) => !v); setBusca('') }}
          aria-label={escolhendoNova ? 'Voltar às conversas' : 'Nova conversa'}
          title={escolhendoNova ? 'Voltar às conversas' : 'Nova conversa'}>
          {escolhendoNova ? <IconeVoltar /> : <IconeNova />}
        </button>
        <button type="button" className="atw-icone" onClick={() => setAberto(false)} aria-label="Fechar" title="Fechar">
          <IconeFechar />
        </button>
      </div>

      <div className="atw-busca-caixa">
        <input
          className="atw-busca"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={escolhendoNova ? 'Buscar loja…' : 'Buscar conversa…'}
        />
      </div>

      <div className="atw-rolagem">
        {escolhendoNova ? (
          <div>
            <div className="atw-outro">
              <input
                className="atw-busca"
                value={outroNumero}
                onChange={(e) => setOutroNumero(e.target.value)}
                placeholder="Outro número: (84) 99999-0000"
                inputMode="tel"
              />
              <button type="button" className="atw-btn-verde" onClick={() => comecarCom(outroNumero)}>Abrir</button>
            </div>
            <div className="atw-subtitulo">Lojas com telefone de contato</div>
            {lojasComTelefone.length === 0 && (
              <div className="atw-vazio">Nenhuma loja com telefone de contato.</div>
            )}
            {lojasComTelefone.map((e) => (
              <button key={e.id} type="button" className="atw-item" onClick={() => comecarCom(e.telefone_contato, e)}>
                <span className="atw-avatar" style={{ background: corAvatar(e.id) }}>{inicialDe(e.nome)}</span>
                <span className="atw-item-corpo">
                  <span className="atw-item-nome">{e.nome}</span>
                  <span className="atw-item-previa">{telefoneBonito(e.telefone_contato)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {listaFiltrada.length === 0 && (
              <div className="atw-vazio">
                {conversas.length === 0
                  ? 'Nenhuma conversa ainda. Quando um lojista escrever pro número oficial, ou responder a cobrança, aparece aqui.'
                  : 'Nada encontrado.'}
              </div>
            )}
            {listaFiltrada.map((c) => {
              const u = c.ultima
              const previa = u.texto || (u.midia_tipo ? rotuloMidia(u.midia_tipo) : '')
              return (
                <button key={c.chave} type="button" className={`atw-item${c.chave === sel ? ' ativo' : ''}`} onClick={() => abrirConversa(c.chave)}>
                  <span className="atw-av-wrap">
                    <span className="atw-avatar" style={{ background: corAvatar(c.chaveTel) }}>{inicialDe(c.titulo)}</span>
                    {/* A bolinha mostra qual número da FWC a pessoa chamou. Sem ela, duas
                        conversas do mesmo nome ficariam iguais na lista. */}
                    <span className="atw-canal" style={{ background: c.canal === 'evolution' ? '#25d366' : '#2563eb' }}
                      title={c.canal === 'evolution' ? 'Chamou o 99912-0349' : 'Chamou o número oficial'} />
                  </span>
                  <span className="atw-item-corpo">
                    <span className="atw-item-linha">
                      <span className={`atw-item-nome${c.naoLidas ? ' forte' : ''}`}>{c.titulo}</span>
                      <span className={`atw-item-hora${c.naoLidas ? ' nova' : ''}`}>{horaLista(u.created_at)}</span>
                    </span>
                    <span className="atw-item-linha">
                      <span className="atw-item-previa">
                        {u.remetente === 'fwc' && <StatusEnvio m={u} />}
                        <span>{previa}</span>
                      </span>
                      {c.naoLidas > 0 && <span className="atw-badge">{c.naoLidas}</span>}
                    </span>
                  </span>
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )

  const conversa = atual ? (
    <section className="atw-conv">
      <div className="atw-head">
        {!larga && (
          <button type="button" className="atw-icone" onClick={() => setSel(null)} aria-label="Voltar pra lista">
            <IconeVoltar />
          </button>
        )}
        <span className="atw-avatar p" style={{ background: corAvatar(atual.chaveTel) }}>{inicialDe(atual.titulo)}</span>
        <div className="atw-conv-info">
          <div className="atw-conv-nome">{atual.titulo}</div>
          <div className="atw-conv-sub">
            {telefoneBonito(atual.telefone)}{atual.empresa ? ' · lojista' : ''}
            {' · '}{ehEvolution ? 'chamou o 99912-0349' : 'chamou o oficial'}
          </div>
        </div>
        {larga && (
          <button type="button" className="atw-icone" onClick={() => setAberto(false)} aria-label="Fechar" title="Fechar">
            <IconeFechar />
          </button>
        )}
      </div>

      <div className="atw-corpo" ref={corpoRef}>
        {bolhas.length === 0 && (
          <div className="atw-sistema">
            Conversa nova. Pra escrever primeiro, o WhatsApp oficial exige um <b>modelo aprovado</b> — escolha um aí embaixo.
          </div>
        )}
        {bolhas.map(({ m, novoDia, cauda }) => {
          const daFwc = m.remetente === 'fwc'
          return (
            <Fragment key={m.id}>
              {novoDia && <div className="atw-dia"><span>{diaRotulo(m.created_at)}</span></div>}
              <div className={`atw-linha ${daFwc ? 'out' : 'in'}${cauda ? ' cauda' : ''}`}>
                <div className="atw-bub">
                  {m.tipo === 'modelo' && <div className="atw-modelo-rotulo">📋 Modelo</div>}
                  {m.midia_path && <Midia path={m.midia_path} tipo={m.midia_tipo} />}
                  {m.texto}
                  <span className="atw-meta">
                    <span>{horaCurta(m.created_at)}</span>
                    {daFwc && <StatusEnvio m={m} />}
                  </span>
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>

      <div className="atw-rodape">
        {aviso && <div className="atw-erro">{aviso}</div>}

        {janelaAberta ? (
          <>
            {!ehEvolution && (
              <div className="atw-nota">
                Pode responder livre até {quando(new Date(janelaAte).toISOString())} (24h da última mensagem dele).
              </div>
            )}
            <div className="atw-compor">
              <textarea
                ref={campoRef}
                className="atw-campo"
                value={texto}
                rows={1}
                onChange={(e) => { setTexto(e.target.value); ajustarAltura(e.target) }}
                onKeyDown={(e) => { if (enterEnvia && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarTexto() } }}
                placeholder="Mensagem"
              />
              <button type="button" className="atw-enviar" onClick={enviarTexto}
                disabled={enviando || !texto.trim()} aria-label="Enviar">
                <IconeEnviar />
              </button>
            </div>
          </>
        ) : (
          <div className="atw-modelos">
            <div className="atw-nota" style={{ padding: 0, textAlign: 'left' }}>
              {atual.ultimaCliente
                ? 'Passou de 24h desde a última mensagem dele: agora só dá pra mandar um modelo aprovado. Quando ele responder, a conversa livre abre de novo.'
                : 'Ele ainda não escreveu pra FWC: o primeiro contato tem que ser um modelo aprovado.'}
            </div>
            {modelos === null ? (
              <div className="atw-nota" style={{ padding: 0 }}>Buscando os modelos aprovados…</div>
            ) : modelos.length === 0 ? (
              <div className="atw-nota" style={{ padding: 0, textAlign: 'left' }}>
                Nenhum modelo aprovado na conta. Crie no Gerenciador do WhatsApp da Meta (categoria Utilidade).{' '}
                <button type="button" className="atw-link" onClick={() => { setModelos(null); buscarModelos() }}>buscar de novo</button>
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
                >
                  <option value="">Escolha o modelo…</option>
                  {modelos.map((m) => (
                    <option key={`${m.nome}|${m.idioma}`} value={`${m.nome}|${m.idioma}`} disabled={!m.suportado}>
                      {m.nome} ({m.idioma}){m.suportado ? '' : ' — tem foto/link, ainda não dá pra mandar daqui'}
                    </option>
                  ))}
                </select>
                {modeloSel && (
                  <>
                    {params.map((p, i) => (
                      <input
                        key={i}
                        value={p}
                        onChange={(e) => setParams((ps) => ps.map((v, j) => (j === i ? e.target.value : v)))}
                        placeholder={`Campo {{${i + 1}}}`}
                      />
                    ))}
                    <div className="atw-previa">
                      {modeloSel.cabecalho && <div style={{ fontWeight: 700, marginBottom: 4 }}>{modeloSel.cabecalho}</div>}
                      {montarTexto(modeloSel.corpo, params)}
                      {modeloSel.rodape && <small>{modeloSel.rodape}</small>}
                      {modeloSel.botoes.length > 0 && <small>Botões: {modeloSel.botoes.join(' · ')}</small>}
                    </div>
                    <button type="button" className="atw-btn-largo" onClick={enviarModelo} disabled={enviando}>
                      {enviando ? 'Enviando…' : 'Enviar modelo'}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  ) : (
    <div className="atw-conv-vazia">
      Escolha uma conversa, ou toque no ícone de nova conversa pra falar com um lojista.
    </div>
  )

  return (
    <div className="atw">
      <div className="atw-fundo" onClick={() => setAberto(false)} />
      <div className="atw-panel" role="dialog" aria-label="Atendimento FWC">
        {mostraLista && lista}
        {mostraConversa && conversa}
      </div>
    </div>
  )
}
