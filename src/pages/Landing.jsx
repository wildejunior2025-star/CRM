import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import landingHtml from '../landing/landing.html?raw'
import { supabase } from '../lib/supabaseClient'
import AjudaIA from '../components/AjudaIA'
import { CARD_PARA_SISTEMA } from '../lib/tourSistema'

// O título/descrição do vídeo vêm do banco e entram via innerHTML no banner —
// escapa pra ninguém conseguir injetar marcação pelo cadastro.
function escapaHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Print interativo ("veja por dentro"): alguns cards, em vez de abrir um vídeo,
// abrem as TELAS REAIS do sistema (prints anonimizados) em abas. As chaves são
// as mesmas do data-video no landing.html. Card com demo tem prioridade sobre
// vídeo. Imagens em /public/demo (servidas na raiz).
const DEMOS = {
  entregador: {
    titulo: 'Aplicativo de Entregas — por dentro',
    telas: [
      { nome: 'Disponíveis', img: '/demo/entregas-1-disponiveis.png' },
      { nome: 'Aceitas', img: '/demo/entregas-2-aceitas.png' },
      { nome: 'Histórico', img: '/demo/entregas-3-historico.png' },
    ],
  },
}

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
  const navigate = useNavigate()
  const raizRef = useRef(null)
  const [videos, setVideos] = useState({})   // { chave: [ {id, titulo, descricao, youtube_id} ] }
  const [aberto, setAberto] = useState(null) // { chave, label, lista }
  const [atual, setAtual] = useState(0)      // índice do vídeo em exibição
  const [demo, setDemo] = useState(null)     // { titulo, telas, atual } — print interativo

  // IMPORTANTE: o objeto do dangerouslySetInnerHTML precisa ter identidade
  // ESTÁVEL. O React 19 compara os props por identidade — passando
  // `{{ __html: ... }}` direto no JSX, ele enxerga um objeto novo a cada
  // render e reescreve o HTML inteiro. Isso apagava os selos de ▶ e os
  // cliques dos cards no instante em que o vídeo abria.
  const html = useMemo(() => ({ __html: landingHtml }), [])

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
      const sistema = CARD_PARA_SISTEMA[chave]   // abre a página "Ver por dentro"
      const demoCfg = DEMOS[chave]               // abre as telas em abas (print)
      const lista = videos[chave]                // abre o vídeo
      // Prioridade: página do sistema > print > vídeo. Sem nenhum, card comum.
      if (!sistema && !demoCfg && !lista?.length) return

      const label = card.querySelector('.feature-title')?.textContent?.trim() || 'Como funciona'
      const porDentro = sistema || demoCfg

      card.style.cursor = 'pointer'
      card.setAttribute('role', 'button')
      card.setAttribute('tabindex', '0')
      card.setAttribute('aria-label', porDentro ? `Ver por dentro: ${label}` : `Assistir vídeos: ${label}`)

      // Selo de play — só uma vez por card.
      if (!card.querySelector('.fwc-video-selo')) {
        const selo = document.createElement('div')
        selo.className = 'fwc-video-selo'
        selo.textContent = porDentro
          ? '▶ Ver por dentro'
          : lista.length > 1
            ? `▶ Ver como funciona (${lista.length} vídeos)`
            : '▶ Ver como funciona'
        selo.style.cssText = 'margin-top:12px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;color:#7c3aed'
        card.appendChild(selo)
      }

      const abrir = sistema
        ? () => navigate(`/ver/${sistema}`)
        : demoCfg
          ? () => setDemo({ titulo: demoCfg.titulo, telas: demoCfg.telas, atual: 0 })
          : () => { setAtual(0); setAberto({ chave, label, lista }) }
      const tecla = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir() } }
      card.addEventListener('click', abrir)
      card.addEventListener('keydown', tecla)
      limpar.push(() => { card.removeEventListener('click', abrir); card.removeEventListener('keydown', tecla) })
    })

    return () => limpar.forEach(f => f())
  }, [videos, navigate])

  // Vídeo de apresentação — banner em destaque acima dos cards.
  useEffect(() => {
    const alvo = raizRef.current?.querySelector('[data-video-apresentacao]')
    if (!alvo) return
    const lista = videos.apresentacao
    alvo.innerHTML = ''
    if (!lista?.length) return

    const v = lista[0]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('aria-label', `Assistir: ${v.titulo}`)
    btn.style.cssText = [
      'display:flex', 'align-items:center', 'gap:16px', 'width:100%',
      'max-width:620px', 'margin:0 auto 34px', 'padding:14px 18px',
      'border:1px solid rgba(124,58,237,.35)', 'border-radius:16px',
      'background:rgba(124,58,237,.06)', 'cursor:pointer', 'text-align:left',
      'font:inherit', 'color:inherit',
    ].join(';')
    btn.innerHTML = `
      <span style="position:relative;flex-shrink:0">
        <img src="https://img.youtube.com/vi/${v.youtube_id}/mqdefault.jpg" alt=""
             width="132" height="74" style="border-radius:10px;object-fit:cover;display:block;background:#000" />
        <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:26px;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.6)">▶</span>
      </span>
      <span>
        <span style="display:block;font-weight:800;font-size:16px;line-height:1.3">${escapaHtml(v.titulo)}</span>
        <span style="display:block;font-size:13.5px;opacity:.75;margin-top:4px;line-height:1.5">
          ${escapaHtml(v.descricao || 'Comece por aqui — 2 minutos para entender como tudo funciona.')}
        </span>
      </span>`
    const abrir = () => { setAtual(0); setAberto({ chave: 'apresentacao', label: v.titulo, lista }) }
    btn.addEventListener('click', abrir)
    alvo.appendChild(btn)
    return () => btn.removeEventListener('click', abrir)
  }, [videos])

  // Fecha no ESC e trava o rolar da página enquanto vídeo OU demo está aberto.
  useEffect(() => {
    if (!aberto && !demo) return
    const onKey = e => { if (e.key === 'Escape') { setAberto(null); setDemo(null) } }
    document.addEventListener('keydown', onKey)
    const overflowAntes = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflowAntes
    }
  }, [aberto, demo])

  return (
    <>
      <div ref={raizRef} dangerouslySetInnerHTML={html} />

      {/* Ajuda por IA — traz o vídeo certo em vez de o visitante procurar entre os cards */}
      <AjudaIA onAbrirVideo={v => { setAtual(0); setAberto({ chave: v.chave, label: v.titulo, lista: [v] }) }} />

      {/* Print interativo — telas reais do sistema em abas */}
      {demo && (
        <div
          onClick={() => setDemo(null)}
          role="dialog" aria-modal="true" aria-label={demo.titulo}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.85)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, overflowY: 'auto',
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, margin: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <strong style={{ color: '#fff', fontSize: 17, flex: 1, lineHeight: 1.3 }}>{demo.titulo}</strong>
              <button
                type="button" onClick={() => setDemo(null)} aria-label="Fechar"
                style={{
                  background: 'rgba(255,255,255,.15)', color: '#fff', border: 'none',
                  width: 34, height: 34, borderRadius: '50%', cursor: 'pointer', fontSize: 18, lineHeight: 1, flexShrink: 0,
                }}
              >×</button>
            </div>

            {/* Abas das telas */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {demo.telas.map((t, i) => {
                const ativa = i === demo.atual
                return (
                  <button
                    key={i} type="button" onClick={() => setDemo(d => ({ ...d, atual: i }))}
                    aria-current={ativa}
                    style={{
                      fontSize: 13, fontWeight: 800, cursor: 'pointer', padding: '7px 14px', borderRadius: 999,
                      border: '1px solid ' + (ativa ? '#7c3aed' : 'rgba(255,255,255,.25)'),
                      background: ativa ? '#7c3aed' : 'transparent', color: '#fff',
                    }}
                  >{t.nome}</button>
                )
              })}
            </div>

            <img
              src={demo.telas[demo.atual].img} alt={`${demo.titulo} — ${demo.telas[demo.atual].nome}`}
              style={{ width: '100%', borderRadius: 12, display: 'block', background: '#fff', boxShadow: '0 10px 50px rgba(0,0,0,.55)' }}
            />
            <p style={{ color: 'rgba(255,255,255,.7)', fontSize: 13, textAlign: 'center', margin: '12px 2px 0', lineHeight: 1.6 }}>
              📱 Telas reais do aplicativo. Use as abas acima para navegar.
            </p>
          </div>
        </div>
      )}

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
