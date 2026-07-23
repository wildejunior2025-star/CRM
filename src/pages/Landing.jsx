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
  const [videos, setVideos] = useState({})   // { chave: {titulo, descricao, youtube_id} }
  const [aberto, setAberto] = useState(null) // vídeo em exibição

  useEffect(() => {
    const anterior = document.title
    document.title = 'FWC Inter — Sistema de Gestão para Distribuidoras'
    return () => { document.title = anterior }
  }, [])

  useEffect(() => {
    supabase.from('videos_tutorial')
      .select('chave, titulo, descricao, youtube_id')
      .eq('ativo', true)
      .then(({ data }) => {
        const mapa = {}
        for (const v of (data ?? [])) if (v.youtube_id) mapa[v.chave] = v
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
      const v = videos[chave]
      if (!v) return

      card.style.cursor = 'pointer'
      card.setAttribute('role', 'button')
      card.setAttribute('tabindex', '0')
      card.setAttribute('aria-label', `Assistir: ${v.titulo}`)

      // Selo de play — só uma vez por card.
      if (!card.querySelector('.fwc-video-selo')) {
        const selo = document.createElement('div')
        selo.className = 'fwc-video-selo'
        selo.textContent = '▶ Ver como funciona'
        selo.style.cssText = 'margin-top:12px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;color:#7c3aed'
        card.appendChild(selo)
      }

      const abrir = () => setAberto(v)
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

      {aberto && (
        <div
          onClick={() => setAberto(null)}
          role="dialog" aria-modal="true" aria-label={aberto.titulo}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.82)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 880 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <strong style={{ color: '#fff', fontSize: 17, flex: 1, lineHeight: 1.3 }}>{aberto.titulo}</strong>
              <button
                type="button" onClick={() => setAberto(null)} aria-label="Fechar"
                style={{
                  background: 'rgba(255,255,255,.15)', color: '#fff', border: 'none',
                  width: 34, height: 34, borderRadius: '50%', cursor: 'pointer',
                  fontSize: 18, lineHeight: 1, flexShrink: 0,
                }}
              >×</button>
            </div>

            {/* 16:9 responsivo */}
            <div style={{ position: 'relative', paddingTop: '56.25%', background: '#000', borderRadius: 12, overflow: 'hidden' }}>
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${aberto.youtube_id}?autoplay=1&rel=0&modestbranding=1`}
                title={aberto.titulo}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              />
            </div>

            {aberto.descricao && (
              <p style={{ color: 'rgba(255,255,255,.8)', fontSize: 14, lineHeight: 1.6, margin: '12px 2px 0' }}>
                {aberto.descricao}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
}
