// Botão flutuante "Falar com a IA" — o visitante pergunta como faz alguma
// coisa no sistema e a IA responde, já trazendo o vídeo tutorial quando existe.
//
// Ninguém acha o vídeo certo procurando entre 24 cards. Perguntar "como
// configuro a impressora?" e receber a resposta + o vídeo é muito mais rápido.
//
// A resposta vem da edge function `ajuda-ia`. Os links de vídeo NÃO vêm da IA —
// ela cita a chave e o servidor devolve o vídeo real do banco, então não tem
// como aparecer link inventado.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

const SUGESTOES = [
  'Como configuro a impressora?',
  'Como ligo a integração com o iFood?',
  'Como monto o cardápio da loja online?',
]

export default function AjudaIA({ onAbrirVideo }) {
  const [aberto, setAberto] = useState(false)
  const [msgs, setMsgs] = useState([])       // { role, content, videos? }
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)
  const fimRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => { fimRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, enviando])
  useEffect(() => { if (aberto) inputRef.current?.focus() }, [aberto])

  useEffect(() => {
    if (!aberto) return
    const onKey = e => { if (e.key === 'Escape') setAberto(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [aberto])

  async function perguntar(pergunta) {
    const p = String(pergunta ?? texto).trim()
    if (!p || enviando) return
    setTexto(''); setErro(null); setEnviando(true)

    // Só o histórico de texto vai pro servidor (sem os vídeos sugeridos).
    const historico = msgs.map(m => ({ role: m.role, content: m.content }))
    setMsgs(m => [...m, { role: 'user', content: p }])

    try {
      const { data, error } = await supabase.functions.invoke('ajuda-ia', {
        body: { pergunta: p, historico },
      })
      if (error) throw error
      if (data?.erro) { setErro(data.erro); return }
      setMsgs(m => [...m, { role: 'assistant', content: data?.resposta || '', videos: data?.videos ?? [] }])
    } catch {
      setErro('Não consegui responder agora. Tente de novo em instantes.')
    } finally {
      setEnviando(false)
    }
  }

  if (!aberto) {
    return (
      <button
        type="button" onClick={() => setAberto(true)}
        style={{
          position: 'fixed', right: 18, bottom: 18, zIndex: 9998,
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '13px 20px', borderRadius: 999, border: 'none', cursor: 'pointer',
          background: '#7c3aed', color: '#fff', fontSize: 14.5, fontWeight: 800,
          boxShadow: '0 8px 26px rgba(124,58,237,.45)',
        }}
      >
        <span aria-hidden>🤖</span> Falar com a IA
      </button>
    )
  }

  return (
    <div
      style={{
        position: 'fixed', right: 18, bottom: 18, zIndex: 9998,
        width: 'min(390px, calc(100vw - 36px))', maxHeight: 'min(620px, calc(100vh - 36px))',
        display: 'flex', flexDirection: 'column',
        background: '#fff', color: '#1f2937',
        border: '1px solid rgba(124,58,237,.3)', borderRadius: 16,
        boxShadow: '0 18px 50px rgba(0,0,0,.28)', overflow: 'hidden',
      }}
      role="dialog" aria-label="Ajuda por IA"
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        background: '#7c3aed', color: '#fff', flexShrink: 0,
      }}>
        <span aria-hidden style={{ fontSize: 18 }}>🤖</span>
        <strong style={{ flex: 1, fontSize: 14.5 }}>Ajuda do FWC Inter</strong>
        <button type="button" onClick={() => setAberto(false)} aria-label="Fechar"
          style={{ background: 'rgba(255,255,255,.2)', color: '#fff', border: 'none', width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.length === 0 && (
          <>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, opacity: .8 }}>
              Pergunte como fazer qualquer coisa no sistema. Se existir vídeo sobre o assunto,
              eu já trago o link pra você assistir.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {SUGESTOES.map(s => (
                <button key={s} type="button" onClick={() => perguntar(s)}
                  style={{
                    textAlign: 'left', padding: '9px 12px', borderRadius: 10, cursor: 'pointer',
                    border: '1px solid #d0d3da', background: 'transparent',
                    color: '#1f2937', fontSize: 13.5, font: 'inherit',
                  }}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}

        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '92%' }}>
            <div style={{
              padding: '9px 12px', borderRadius: 12, fontSize: 14, lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              background: m.role === 'user' ? '#7c3aed' : 'rgba(124,58,237,.09)',
              color: m.role === 'user' ? '#fff' : 'inherit',
            }}>
              {m.content}
            </div>
            {m.videos?.map(v => (
              <button key={v.youtube_id} type="button"
                onClick={() => onAbrirVideo?.(v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, marginTop: 7, width: '100%',
                  padding: 7, borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                  border: '1px solid rgba(124,58,237,.35)', background: 'rgba(124,58,237,.05)',
                  color: 'inherit', font: 'inherit',
                }}>
                <img src={`https://img.youtube.com/vi/${v.youtube_id}/default.jpg`} alt=""
                  width={62} height={35} style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#000' }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.35 }}>▶ {v.titulo}</span>
              </button>
            ))}
          </div>
        ))}

        {enviando && (
          <div style={{ alignSelf: 'flex-start', fontSize: 13, opacity: .65 }}>Pensando…</div>
        )}
        {erro && (
          <div style={{ fontSize: 13, color: '#ef4444', lineHeight: 1.5 }}>{erro}</div>
        )}
        <div ref={fimRef} />
      </div>

      <form
        onSubmit={e => { e.preventDefault(); perguntar() }}
        style={{ display: 'flex', gap: 7, padding: 12, borderTop: '1px solid #eee', flexShrink: 0 }}
      >
        <input
          ref={inputRef} type="text" value={texto} maxLength={500}
          onChange={e => setTexto(e.target.value)}
          placeholder="Digite sua dúvida…"
          style={{
            flex: 1, padding: '9px 12px', borderRadius: 10, fontSize: 14,
            border: '1px solid #d0d3da', background: '#fff', color: '#1f2937',
          }}
        />
        <button type="submit" disabled={enviando || !texto.trim()}
          style={{
            padding: '9px 15px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 14,
            opacity: (enviando || !texto.trim()) ? .5 : 1,
          }}>
          Enviar
        </button>
      </form>
    </div>
  )
}
