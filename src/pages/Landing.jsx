import { useEffect, useRef, useState } from 'react'
import landingHtml from '../landing/landing.html?raw'
import { supabase } from '../lib/supabaseClient'

// Landing pública de marketing servida em fwcinter.com (raiz), quando o
// visitante não está logado. O HTML/CSS vem do site original (FWC geral/
// vendamais-site) importado como raw — todo o CSS é escopado em .fwc-landing
// pra não vazar pro resto do app.
//
// Vídeo tutorial: cada card tem data-video="chave". Buscamos os vídeos
// cadastrados (tabela videos_tutorial) e só os cards que TÊM vídeo viram
// clicáveis, ganhando um ▶. Card sem vídeo continua exatamente como era —
// assim dá pra publicar um vídeo de cada vez, conforme grava.
export default function Landing() {
  const raizRef = useRef(null)
  const [videos, setVideos] = useState({})   // { chave: [ {id, titulo, descricao, youtube_id} ] }
  const [aberto, setAberto] = useState(null) // { chave, label, lista }
  const [atual, setAtual] = useState(0)      // índice do vídeo em exibição

  useEffect(() => {
    const anterior = document.title
    document.title = 'FWC Inter — Sistema de Gestão para Distribuidoras'
    return () => { document.title = anterior }
  }, [])

  useEffect(() => {
    supabase.from('videos_tutorial')
      .select('id, chave, titulo, descricao, youtube_id, ordem')
      .eq('ativo', true)
      .order('ordem')
      .then(({ data }) => {
        const mapa = {}
        for (const v of (data ?? [])) {
          if (!v.youtube_id) continue
          ;(mapa[v.chave] ??= []).push(v)
        }
        setVideos(mapa)
      })
  }, [])

  // Liga os cards que têm vídeo. Roda de novo quando os vídeos chegam.
  useEffect(() => {
    const raiz = raizRef.current
    if (!raiz) return
    const cards = raiz.querySelectorAll('[data-video]')
    const limpar = []

    cards.forEach(card => {
      const chave = card.getAttribute('data-video')
      const lista = videos[chave]
      if (!lista?.length) return

      const label = card.querySelector('.feature-title')?.textContent?.trim() || 'Como funciona'

      card.style.cursor = 'pointer'
      card.setAttribute('role', 'button')
      card.setAttribute('tabindex', '0')
      card.setAttribute('aria-label', `Assistir vídeos: ${label}`)

      // Selo de play — só uma vez por card.
      if (!card.querySelector('.fwc-video-selo')) {
        const selo = document.createElement('div')
        selo.className = 'fwc-video-selo'
        selo.textContent = lista.length > 1
          ? `▶ Ver como funciona (${lista.length} vídeos)`
          : '▶ Ver como funciona'
        selo.style.cssText = 'margin-top:12px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;color:#7c3aed'
        card.appendChild(selo)
      }

      const abrir = () => { setAtual(0); setAberto({ chave, label, lista }) }
      const tecla = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir() } }
      card.addEventListener('click', abrir)
      card.addEventListener('keydown', tecla)
      limpar.push(() => { card.removeEventListener('click', abrir); card.removeEventListener('keydown', tecla) })
    })

    return () => limpar.forEach(f => f())
  }, [videos])

  // Fecha no ESC e trava o rolar da página enquanto o vídeo está aberto.
  useEffect(() => {
    if (!aberto) return
    const onKey = e => { if (e.key === 'Escape') setAberto(null) }
    document.addEventListener('keydown', onKey)
    const overflowAntes = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflowAntes
    }
  }, [aberto])

  return (
    <>
      <div ref={raizRef} dangerouslySetInnerHTML={{ __html: landingHtml }} />

      {aberto && (() => {
        const lista = aberto.lista
        const v = lista[atual] ?? lista[0]
        const varios = lista.length > 1
        return (
          <div
            onClick={() => setAberto(null)}
            role="dialog" aria-modal="true" aria-label={aberto.label}
            style={{
              position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
              overflowY: 'auto',
            }}
          >
            {/* No celular a lista vai pra baixo do player, não pro lado. */}
            <style>{'@media (max-width: 860px){.fwc-video-wrap{grid-template-columns:1fr !important}}'}</style>
            <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: varios ? 1080 : 880, margin: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <strong style={{ color: '#fff', fontSize: 17, flex: 1, lineHeight: 1.3 }}>
                  {aberto.label}
                  {varios && (
                    <span style={{ color: 'rgba(255,255,255,.6)', fontWeight: 600, fontSize: 14, marginLeft: 8 }}>
                      {atual + 1} de {lista.length}
                    </span>
                  )}
                </strong>
                <button
                  type="button" onClick={() => setAberto(null)} aria-label="Fechar"
                  style={{
                    background: 'rgba(255,255,255,.15)', color: '#fff', border: 'none',
                    width: 34, height: 34, borderRadius: '50%', cursor: 'pointer',
                    fontSize: 18, lineHeight: 1, flexShrink: 0,
                  }}
                >×</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: varios ? 'minmax(0,1fr) 280px' : '1fr', gap: 14, alignItems: 'start' }}
                className="fwc-video-wrap">
                <div style={{ minWidth: 0 }}>
                  {/* 16:9 responsivo */}
                  <div style={{ position: 'relative', paddingTop: '56.25%', background: '#000', borderRadius: 12, overflow: 'hidden' }}>
                    <iframe
                      key={v.id}
                      src={`https://www.youtube-nocookie.com/embed/${v.youtube_id}?autoplay=1&rel=0&modestbranding=1`}
                      title={v.titulo}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
                    />
                  </div>
                  <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, margin: '10px 2px 0' }}>{v.titulo}</div>
                  {v.descricao && (
                    <p style={{ color: 'rgba(255,255,255,.75)', fontSize: 13.5, lineHeight: 1.6, margin: '4px 2px 0' }}>
                      {v.descricao}
                    </p>
                  )}
                </div>

                {varios && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                    {lista.map((item, i) => (
                      <button
                        key={item.id} type="button" onClick={() => setAtual(i)}
                        aria-current={i === atual}
                        style={{
                          display: 'flex', gap: 10, alignItems: 'center', textAlign: 'left',
                          background: i === atual ? 'rgba(124,58,237,.35)' : 'rgba(255,255,255,.08)',
                          border: i === atual ? '1px solid #7c3aed' : '1px solid transparent',
                          borderRadius: 10, padding: 8, cursor: 'pointer', color: '#fff',
                        }}
                      >
                        <img src={`https://img.youtube.com/vi/${item.youtube_id}/default.jpg`} alt=""
                          width={64} height={36}
                          style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#000' }} />
                        <span style={{ fontSize: 13, lineHeight: 1.35, flex: 1 }}>
                          <span style={{ opacity: .6, marginRight: 5 }}>{i + 1}.</span>{item.titulo}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}
