import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { SISTEMAS } from '../lib/tourSistema'

// Página pública "Ver por dentro" — fwcinter.com/ver/:sistema.
// Mostra a lateral real do sistema; cada item abre o vídeo cadastrado naquela
// chave. Item sem vídeo mostra "vídeo em breve". Visual próprio (claro), não
// depende do tema do app nem do CSS da landing.
export default function TourSistema() {
  const { sistema } = useParams()
  const navigate = useNavigate()
  const cfg = SISTEMAS[sistema]

  const [videos, setVideos] = useState({})   // { chave: [ {youtube_id, titulo, descricao} ] }
  const [sel, setSel] = useState(null)        // chave selecionada
  const [idxVideo, setIdxVideo] = useState(0) // vídeo em exibição (quando há vários)

  // Todas as chaves deste sistema, pra buscar só os vídeos que interessam.
  const chaves = useMemo(() => {
    if (!cfg) return []
    const acc = []
    for (const it of cfg.menu) {
      if (it.chave) acc.push(it.chave)
      for (const c of (it.children || [])) acc.push(c.chave)
    }
    return acc
  }, [cfg])

  useEffect(() => {
    document.title = cfg ? `${cfg.titulo} — Ver por dentro | FWC Inter` : 'FWC Inter'
  }, [cfg])

  useEffect(() => {
    if (!chaves.length) return
    supabase.from('videos_tutorial')
      .select('chave, titulo, descricao, youtube_id, ordem, ativo')
      .in('chave', chaves)
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
  }, [chaves.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg) {
    return (
      <div style={S.vazioWrap}>
        <p style={{ fontSize: 18, fontWeight: 700 }}>Página não encontrada.</p>
        <button style={S.btnVoltar} onClick={() => navigate('/')}>← Voltar ao site</button>
      </div>
    )
  }

  const abrir = (chave) => { setIdxVideo(0); setSel(chave) }
  const lista = sel ? (videos[sel] || []) : []
  const temVideo = (chave) => (videos[chave]?.length || 0) > 0
  const rotuloDe = (chave) => {
    for (const it of cfg.menu) {
      if (it.chave === chave) return it.label
      for (const c of (it.children || [])) if (c.chave === chave) return c.label
    }
    return ''
  }

  // Item do menu (pai ou filho). Pai com filhos só serve de cabeçalho de grupo
  // clicável (abre o próprio vídeo se tiver). Filhos ficam sempre visíveis.
  const Item = ({ it, filho }) => {
    const ativo = sel === it.chave
    return (
      <button
        type="button"
        onClick={() => abrir(it.chave)}
        className={'tour-item' + (ativo ? ' ativo' : '') + (filho ? ' filho' : '')}
      >
        {filho && <span className="tour-elbow">└</span>}
        <span className="tour-label">{it.label}</span>
        {temVideo(it.chave)
          ? <span className="tour-play" title="Tem vídeo">▶</span>
          : <span className="tour-soon" title="Vídeo em breve">•</span>}
      </button>
    )
  }

  const v = lista[idxVideo] || lista[0]

  return (
    <div className="tour-root">
      <style>{CSS}</style>

      <header className="tour-top">
        <button className="tour-back" onClick={() => navigate('/')}>← Voltar ao site</button>
        <div className="tour-brand"><span className="tour-brand-mark">FWC</span> Inter</div>
        <div className="tour-sys">{cfg.emoji} {cfg.titulo}</div>
      </header>

      <div className="tour-body">
        {/* Lateral = menu real do sistema */}
        <aside className="tour-side">
          {cfg.menu.map((it, i) => it.group
            ? <div key={'g' + i} className="tour-group">{it.group}</div>
            : (
              <div key={it.chave} className="tour-block">
                <Item it={it} />
                {(it.children || []).map(c => <Item key={c.chave} it={c} filho />)}
              </div>
            )
          )}
        </aside>

        {/* Palco = vídeo / boas-vindas */}
        <main className="tour-stage">
          {!sel ? (
            <div className="tour-hero">
              <div className="tour-hero-emoji">{cfg.emoji}</div>
              <h1>{cfg.titulo}</h1>
              <p>{cfg.subtitulo}</p>
              <div className="tour-hint">👈 Escolha um item do menu para começar</div>
            </div>
          ) : v ? (
            <div className="tour-player-wrap">
              <div className="tour-crumb">{cfg.titulo} · <strong>{rotuloDe(sel)}</strong></div>
              <div className="tour-player">
                <iframe
                  key={v.youtube_id}
                  src={`https://www.youtube-nocookie.com/embed/${v.youtube_id}?autoplay=1&rel=0&modestbranding=1`}
                  title={v.titulo}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              </div>
              <h2 className="tour-vtitulo">{v.titulo}</h2>
              {v.descricao && <p className="tour-vdesc">{v.descricao}</p>}
              {lista.length > 1 && (
                <div className="tour-vlista">
                  {lista.map((item, i) => (
                    <button key={item.youtube_id} type="button"
                      onClick={() => setIdxVideo(i)}
                      className={'tour-vlista-item' + (i === idxVideo ? ' ativo' : '')}>
                      <span className="tour-vlista-n">{i + 1}</span> {item.titulo}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="tour-soon-wrap">
              <div className="tour-soon-emoji">🎬</div>
              <h2>{rotuloDe(sel)}</h2>
              <p>Estamos gravando este vídeo. Volte em breve!</p>
              <button className="tour-soon-cta" onClick={() => setSel(null)}>Ver outros itens</button>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

const S = {
  vazioWrap: { minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' },
  btnVoltar: { padding: '10px 18px', borderRadius: 10, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}

const CSS = `
.tour-root{--pp:#7c3aed;--pp-bg:#f3effe;--ink:#1f2430;--muted:#6b7280;--line:#e7e7ef;
  min-height:100vh;background:#f6f6fb;color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.tour-top{display:flex;align-items:center;gap:16px;padding:14px 20px;background:#fff;
  border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;}
.tour-back{background:none;border:1px solid var(--line);border-radius:9px;padding:8px 14px;
  font-size:13.5px;font-weight:700;color:var(--ink);cursor:pointer}
.tour-back:hover{background:#f6f6fb}
.tour-brand{font-weight:800;font-size:16px;display:flex;align-items:center;gap:8px}
.tour-brand-mark{background:var(--pp);color:#fff;font-size:12px;font-weight:900;
  padding:3px 7px;border-radius:7px;letter-spacing:.5px}
.tour-sys{margin-left:auto;font-weight:800;font-size:15px;color:var(--pp)}

.tour-body{display:grid;grid-template-columns:270px 1fr;gap:0;max-width:1200px;margin:0 auto}
.tour-side{background:#fff;border-right:1px solid var(--line);min-height:calc(100vh - 57px);
  padding:14px 12px 40px}
.tour-group{font-size:10.5px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;
  color:#9aa0ad;padding:16px 10px 6px}
.tour-block{margin-bottom:2px}
.tour-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;
  background:none;border:none;cursor:pointer;padding:9px 10px;border-radius:9px;
  font-size:14px;font-weight:600;color:var(--ink);line-height:1.2}
.tour-item:hover{background:#f4f4fa}
.tour-item.ativo{background:var(--pp);color:#fff}
.tour-item.filho{padding-left:14px;font-size:13.5px;font-weight:500;color:#565b67}
.tour-item.filho.ativo{color:#fff}
.tour-elbow{color:#e08a3c;font-weight:700;flex-shrink:0}
.tour-item.ativo .tour-elbow{color:rgba(255,255,255,.85)}
.tour-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tour-play{font-size:10px;color:var(--pp);flex-shrink:0}
.tour-item.ativo .tour-play{color:#fff}
.tour-soon{font-size:16px;color:#cfd3db;flex-shrink:0;line-height:0}

.tour-stage{padding:28px;min-width:0}
.tour-hero{max-width:560px;margin:6vh auto 0;text-align:center}
.tour-hero-emoji{font-size:56px}
.tour-hero h1{font-size:30px;font-weight:800;margin:10px 0 8px}
.tour-hero p{font-size:16px;color:var(--muted);line-height:1.6;margin:0 0 22px}
.tour-hint{display:inline-block;background:var(--pp-bg);color:var(--pp);font-weight:800;
  font-size:14px;padding:12px 20px;border-radius:12px}

.tour-crumb{font-size:13.5px;color:var(--muted);margin-bottom:12px}
.tour-crumb strong{color:var(--ink)}
.tour-player{position:relative;padding-top:56.25%;background:#000;border-radius:14px;
  overflow:hidden;box-shadow:0 12px 40px rgba(20,20,50,.12)}
.tour-player iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.tour-vtitulo{font-size:19px;font-weight:800;margin:16px 2px 4px}
.tour-vdesc{font-size:14.5px;color:var(--muted);line-height:1.6;margin:0 2px}
.tour-vlista{display:flex;flex-direction:column;gap:6px;margin-top:14px}
.tour-vlista-item{display:flex;align-items:center;gap:10px;text-align:left;background:#fff;
  border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;
  font-weight:600;cursor:pointer;color:var(--ink)}
.tour-vlista-item:hover{border-color:var(--pp)}
.tour-vlista-item.ativo{border-color:var(--pp);background:var(--pp-bg)}
.tour-vlista-n{background:var(--pp);color:#fff;font-size:12px;font-weight:800;width:22px;
  height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}

.tour-soon-wrap{max-width:460px;margin:8vh auto 0;text-align:center}
.tour-soon-emoji{font-size:52px}
.tour-soon-wrap h2{font-size:24px;font-weight:800;margin:8px 0 6px}
.tour-soon-wrap p{color:var(--muted);font-size:15px;margin:0 0 18px}
.tour-soon-cta{background:var(--pp);color:#fff;border:none;border-radius:10px;
  padding:11px 20px;font-weight:700;cursor:pointer}

@media (max-width:820px){
  .tour-body{grid-template-columns:1fr}
  .tour-side{min-height:0;border-right:none;border-bottom:1px solid var(--line);
    display:flex;flex-wrap:wrap;gap:4px;padding:10px}
  .tour-group{width:100%;padding:8px 6px 2px}
  .tour-block{margin:0}
  .tour-item{width:auto;border:1px solid var(--line)}
  .tour-item.filho{padding-left:10px}
  .tour-sys{display:none}
  .tour-stage{padding:18px}
}
`
