// Botão flutuante "Perguntar à IA" — dentro do sistema da loja.
//
// É o mesmo gesto da IA do site (fwcinter.com), mas com uma diferença que muda
// tudo: aqui ela ENXERGA os dados da loja. O dono pergunta "quanto vendi hoje?",
// "qual foi o lucro de ontem?", "quem mais comprou esse mês?" e a resposta sai
// com o número dele — sem precisar saber em qual tela aquilo aparece.
//
// E continua ensinando o sistema ("como conecto o Mercado Pago?"), que é o que a
// maioria liga pra perguntar no primeiro mês.
//
// Quem responde é a edge function `assistente-loja`. Ela é quem exige login,
// checa que é admin e faz as consultas — o front aqui não sabe nada do banco.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import './AssistenteLoja.css'

const SUGESTOES = [
  'Quanto vendi hoje?',
  'Como está a loja agora?',
  'Como conecto o Mercado Pago?',
  'O que mais vendeu essa semana?',
]

export default function AssistenteLoja() {
  const { profile } = useAuth()
  const [aberto, setAberto] = useState(false)
  const [msgs, setMsgs] = useState([])       // { role, content, videos? }
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const [video, setVideo] = useState(null)   // vídeo aberto no lightbox
  const fimRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => { fimRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, enviando])
  useEffect(() => { if (aberto) inputRef.current?.focus() }, [aberto])

  useEffect(() => {
    if (!aberto) return
    const onKey = e => { if (e.key === 'Escape') { video ? setVideo(null) : setAberto(false) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [aberto, video])

  async function perguntar(pergunta) {
    const p = String(pergunta ?? texto).trim()
    if (!p || enviando) return
    setTexto(''); setErro(null); setEnviando(true)

    // Só o texto vai pro servidor (sem os vídeos sugeridos).
    const historico = msgs.map(m => ({ role: m.role, content: m.content }))
    setMsgs(m => [...m, { role: 'user', content: p }])

    try {
      const { data, error } = await supabase.functions.invoke('assistente-loja', {
        body: { pergunta: p, historico },
      })
      // A function responde 4xx com uma mensagem pronta pro dono ler ("sessão
      // expirada", "muitas perguntas seguidas"). O invoke trata isso como erro e
      // esconde o corpo — sem ler o context, o dono só veria "falhou".
      if (error) {
        const detalhe = await error.context?.json?.().catch(() => null)
        if (detalhe?.erro) { setErro(detalhe.erro); return }
        throw error
      }
      if (data?.erro) { setErro(data.erro); return }
      setMsgs(m => [...m, { role: 'assistant', content: data?.resposta || '', videos: data?.videos ?? [] }])
    } catch {
      setErro('Não consegui responder agora. Tente de novo em instantes.')
    } finally {
      setEnviando(false)
    }
  }

  // Números da loja são assunto do dono. O vendedor usa o sistema no balcão, às
  // vezes com o cliente vendo a tela — nem o botão deve aparecer pra ele.
  if (profile?.perfil !== 'admin' && profile?.perfil !== 'super_admin') return null

  if (!aberto) {
    return (
      <button type="button" className="ia-fab" onClick={() => setAberto(true)} title="Perguntar à IA" style={S.fab}>
        <span aria-hidden style={{ fontSize: 17 }}>🤖</span>
        <span style={S.fabTexto}>Perguntar à IA</span>
      </button>
    )
  }

  return (
    <>
      <div className="ia-janela" style={S.janela} role="dialog" aria-label="Assistente da loja">
        <div style={S.topo}>
          <span aria-hidden style={{ fontSize: 18 }}>🤖</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: 14.5, display: 'block' }}>Assistente da loja</strong>
            <span style={{ fontSize: 11.5, opacity: .85 }}>Pergunte sobre seus números ou sobre o sistema</span>
          </div>
          {msgs.length > 0 && (
            <button type="button" onClick={() => { setMsgs([]); setErro(null) }} title="Limpar conversa" style={S.btnTopo}>⟲</button>
          )}
          <button type="button" onClick={() => setAberto(false)} aria-label="Fechar" style={S.btnTopo}>×</button>
        </div>

        <div style={S.corpo}>
          {msgs.length === 0 && (
            <>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-muted)' }}>
                Eu enxergo os dados da sua loja. Pergunte quanto vendeu, qual foi o lucro,
                o que está acabando no estoque — ou como fazer alguma coisa aqui dentro.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                {SUGESTOES.map(s => (
                  <button key={s} type="button" onClick={() => perguntar(s)} style={S.sugestao}>{s}</button>
                ))}
              </div>
            </>
          )}

          {msgs.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '92%' }}>
              <div style={m.role === 'user' ? S.balaoUser : S.balaoIA}>{m.content}</div>
              {m.videos?.map(v => (
                <button key={v.youtube_id} type="button" onClick={() => setVideo(v)} style={S.cardVideo}>
                  <img src={`https://img.youtube.com/vi/${v.youtube_id}/default.jpg`} alt=""
                    width={62} height={35}
                    style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#000' }} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.35 }}>▶ {v.titulo}</span>
                </button>
              ))}
            </div>
          ))}

          {enviando && <div style={{ alignSelf: 'flex-start', fontSize: 13, color: 'var(--text-muted)' }}>Consultando…</div>}
          {erro && <div style={{ fontSize: 13, color: 'var(--danger)', lineHeight: 1.5 }}>{erro}</div>}
          <div ref={fimRef} />
        </div>

        <form onSubmit={e => { e.preventDefault(); perguntar() }} style={S.form}>
          <input ref={inputRef} type="text" value={texto} maxLength={500}
            onChange={e => setTexto(e.target.value)} placeholder="Pergunte alguma coisa…" style={S.input} />
          <button type="submit" disabled={enviando || !texto.trim()}
            style={{ ...S.btnEnviar, opacity: (enviando || !texto.trim()) ? .5 : 1 }}>Enviar</button>
        </form>
      </div>

      {video && (
        <div style={S.overlay} onClick={() => setVideo(null)} role="dialog" aria-label={video.titulo}>
          <div style={S.videoBox} onClick={e => e.stopPropagation()}>
            <div style={S.videoTopo}>
              <strong style={{ fontSize: 14, flex: 1 }}>{video.titulo}</strong>
              <button type="button" onClick={() => setVideo(null)} aria-label="Fechar" style={S.btnTopo}>×</button>
            </div>
            <div style={{ position: 'relative', paddingTop: '56.25%', background: '#000' }}>
              <iframe
                src={`https://www.youtube.com/embed/${video.youtube_id}?autoplay=1&rel=0`}
                title={video.titulo} allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Onde o botão fica (canto inferior esquerdo, fugindo do "Admin") mora no CSS,
// que é onde dá pra tratar o desktop e o celular de forma diferente.
const S = {
  fab: {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    padding: '12px 17px', borderRadius: 999, border: 'none', cursor: 'pointer',
    background: 'var(--primary)', color: 'var(--primary-contrast)',
    fontSize: 14, fontWeight: 800, fontFamily: 'inherit', whiteSpace: 'nowrap',
    boxShadow: '0 8px 26px var(--primary-ring)',
  },
  fabTexto: { fontSize: 14, fontWeight: 800 },
  janela: {
    display: 'flex', flexDirection: 'column',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 16,
    boxShadow: '0 18px 50px rgba(0,0,0,.28)', overflow: 'hidden',
  },
  topo: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
    background: 'var(--primary)', color: 'var(--primary-contrast)', flexShrink: 0,
  },
  btnTopo: {
    background: 'rgba(255,255,255,.2)', color: 'inherit', border: 'none',
    width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', fontSize: 16,
    lineHeight: 1, flexShrink: 0, fontFamily: 'inherit',
  },
  corpo: {
    flex: 1, overflowY: 'auto', padding: 14,
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  sugestao: {
    textAlign: 'left', padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
    border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text)', fontSize: 13.5, fontFamily: 'inherit',
  },
  balaoUser: {
    padding: '9px 12px', borderRadius: 12, fontSize: 14, lineHeight: 1.55,
    whiteSpace: 'pre-wrap', background: 'var(--primary)', color: 'var(--primary-contrast)',
  },
  balaoIA: {
    padding: '9px 12px', borderRadius: 12, fontSize: 14, lineHeight: 1.55,
    whiteSpace: 'pre-wrap', background: 'var(--primary-bg)', color: 'var(--text)',
  },
  cardVideo: {
    display: 'flex', alignItems: 'center', gap: 9, marginTop: 7, width: '100%',
    padding: 7, borderRadius: 10, cursor: 'pointer', textAlign: 'left',
    border: '1px solid var(--primary-ring)', background: 'var(--primary-bg)',
    color: 'var(--text)', fontFamily: 'inherit',
  },
  form: {
    display: 'flex', gap: 7, padding: 12,
    borderTop: '1px solid var(--border)', flexShrink: 0,
  },
  input: {
    flex: 1, minWidth: 0, padding: '9px 12px', borderRadius: 10, fontSize: 14,
    border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit',
  },
  btnEnviar: {
    padding: '9px 15px', borderRadius: 10, border: 'none', cursor: 'pointer',
    background: 'var(--primary)', color: 'var(--primary-contrast)',
    fontWeight: 800, fontSize: 14, fontFamily: 'inherit',
  },
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18,
  },
  videoBox: {
    width: 'min(860px, 100%)', background: 'var(--surface)', color: 'var(--text)',
    borderRadius: 14, overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,.5)',
  },
  videoTopo: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
    background: 'var(--primary)', color: 'var(--primary-contrast)',
  },
}
