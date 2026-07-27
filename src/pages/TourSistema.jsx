import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { SISTEMAS } from '../lib/tourSistema'

// Link do teste grátis — o mesmo botão da landing (src/landing/landing.html).
const LINK_TESTE = 'https://admin.fwcinter.com/entrar?ref=89612b50'

// Página pública "Ver por dentro" — fwcinter.com/ver/:sistema.
// Mostra a lateral real do sistema; cada item abre o vídeo cadastrado naquela
// chave. Item sem vídeo mostra "vídeo em breve".
//
// Visual: segue a MESMA identidade da landing (fonte Inter, roxo #7c3aed,
// cartões claros com sombra). Não depende do tema do app — quem chega aqui
// vem do site de marketing e não pode sentir que trocou de produto.
export default function TourSistema() {
  const { sistema } = useParams()
  const navigate = useNavigate()
  const cfg = SISTEMAS[sistema]

  const [videos, setVideos] = useState({})   // { chave: [ {youtube_id, titulo, descricao} ] }
  const [sel, setSel] = useState(null)        // chave selecionada
  const [idxVideo, setIdxVideo] = useState(0) // vídeo em exibição (quando há vários)

  // Lista plana dos itens (pai e filho), na ordem do menu — usada pra buscar os
  // vídeos e pra montar os atalhos da tela inicial.
  const itens = useMemo(() => {
    if (!cfg) return []
    const acc = []
    for (const it of cfg.menu) {
      if (it.chave) acc.push({ chave: it.chave, label: it.label })
      for (const c of (it.children || [])) acc.push({ chave: c.chave, label: c.label })
    }
    return acc
  }, [cfg])
  const chaves = useMemo(() => itens.map(i => i.chave), [itens])

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
  const comVideo = itens.filter(i => temVideo(i.chave))
  const rotuloDe = (chave) => itens.find(i => i.chave === chave)?.label ?? ''

  // Item do menu (pai ou filho). Pai com filhos serve de cabeçalho de grupo
  // clicável (abre o próprio vídeo se tiver). Filhos ficam sempre visíveis.
  const Item = ({ it, filho }) => {
    const ativo = sel === it.chave
    const tem = temVideo(it.chave)
    return (
      <button
        type="button"
        onClick={() => abrir(it.chave)}
        className={'tour-item' + (ativo ? ' ativo' : '') + (filho ? ' filho' : '') + (tem ? ' tem' : '')}
      >
        <span className="tour-label">{it.label}</span>
        {tem
          ? <span className="tour-play" title="Tem vídeo">▶</span>
          : <span className="tour-soon" title="Vídeo em breve">em breve</span>}
      </button>
    )
  }

  const v = lista[idxVideo] || lista[0]

  return (
    <div className="tour-root">
      <style>{CSS}</style>

      <header className="tour-top">
        <div className="tour-top-in">
          <button className="tour-back" onClick={() => navigate('/')}>← Voltar ao site</button>
          <div className="tour-brand"><span className="tour-brand-mark">FWC</span> Inter</div>
          <a className="tour-cta" href={LINK_TESTE}>Começar teste grátis</a>
        </div>
      </header>

      {/* Cabeçalho do sistema — mesmo desenho do hero da landing. Com vídeo
          aberto ele encolhe, senão empurraria o player pra fora da tela. */}
      <section className={'tour-head' + (sel ? ' compacto' : '')}>
        <div className="tour-head-in">
          <span className="tour-badge">Ver por dentro</span>
          <h1><span className="tour-head-emoji">{cfg.emoji}</span> {cfg.titulo}</h1>
          <p>{cfg.subtitulo}</p>
        </div>
      </section>

      <div className="tour-shell">
        {/* Lateral = menu real do sistema */}
        <aside className="tour-side">
          <p className="tour-side-t">Telas do sistema</p>
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

        {/* Palco = vídeo / atalhos iniciais */}
        <main className="tour-stage">
          {!sel ? (
            <div className="tour-start">
              {comVideo.length > 0 ? (
                <>
                  <h2>Comece por aqui</h2>
                  <p className="tour-start-sub">
                    {comVideo.length} vídeo{comVideo.length === 1 ? '' : 's'} curto{comVideo.length === 1 ? '' : 's'},
                    direto ao ponto. Clique num atalho ou procure no menu completo.
                  </p>
                  <div className="tour-cards">
                    {comVideo.slice(0, 6).map(i => (
                      <button key={i.chave} type="button" className="tour-card" onClick={() => abrir(i.chave)}>
                        <span className="tour-card-play">▶</span>
                        <span className="tour-card-txt">
                          <strong>{i.label}</strong>
                          <small>{(videos[i.chave] || []).length} vídeo{(videos[i.chave] || []).length === 1 ? '' : 's'}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  {comVideo.length > 6 && (
                    <p className="tour-start-mais">
                      + {comVideo.length - 6} outros no menu completo
                    </p>
                  )}
                </>
              ) : (
                <div className="tour-vazio">
                  <div className="tour-vazio-emoji">🎬</div>
                  <h2>Vídeos chegando</h2>
                  <p>Estamos gravando as telas deste sistema. Enquanto isso, dá pra testar tudo de graça.</p>
                  <a className="tour-cta grande" href={LINK_TESTE}>Começar teste grátis</a>
                </div>
              )}
            </div>
          ) : v ? (
            <div className="tour-player-wrap">
              <div className="tour-crumb">
                <button type="button" className="tour-crumb-back" onClick={() => setSel(null)}>← Todos os vídeos</button>
                <span>{cfg.titulo} · <strong>{rotuloDe(sel)}</strong></span>
              </div>
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
              <div className="tour-pos-video">
                <strong>Gostou do que viu?</strong>
                <span>Crie sua conta e use o sistema inteiro sem pagar nada pra testar.</span>
                <a className="tour-cta" href={LINK_TESTE}>Começar teste grátis</a>
              </div>
            </div>
          ) : (
            <div className="tour-vazio">
              <div className="tour-vazio-emoji">🎬</div>
              <h2>{rotuloDe(sel)}</h2>
              <p>Estamos gravando este vídeo. Volte em breve!</p>
              <button className="tour-btn-sec" onClick={() => setSel(null)}>Ver outros itens</button>
            </div>
          )}
        </main>
      </div>

      <footer className="tour-foot">
        <span>FWC Inter · Sistema de gestão para distribuidoras</span>
        <button type="button" onClick={() => navigate('/')}>Voltar ao site</button>
      </footer>
    </div>
  )
}

const S = {
  vazioWrap: { minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' },
  btnVoltar: { padding: '10px 18px', borderRadius: 10, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 700, cursor: 'pointer' },
}

// Tokens iguais aos da landing (src/landing/landing.html): mesma fonte, mesmo
// roxo, mesmas bordas — pra quem vem do site não sentir que mudou de lugar.
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');

.tour-root{--pp:#7c3aed;--pp-dark:#5b21b6;--pp-soft:#f5f3ff;--ink:#111827;--muted:#6b7280;
  --line:#e5e7eb;
  min-height:100vh;background:#fff;color:var(--ink);line-height:1.6;
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
.tour-root *{box-sizing:border-box}

/* ── Topo (mesmo desenho da nav da landing) ── */
.tour-top{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.92);
  backdrop-filter:blur(12px);border-bottom:1px solid var(--line);padding:0 24px}
.tour-top-in{max-width:1180px;margin:0 auto;height:64px;display:flex;align-items:center;gap:14px}
.tour-back{background:transparent;color:var(--ink);border:1.5px solid var(--line);border-radius:8px;
  padding:9px 16px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;
  transition:border-color .15s,color .15s}
.tour-back:hover{border-color:var(--pp);color:var(--pp)}
.tour-brand{font-size:18px;font-weight:800;display:flex;align-items:center;gap:8px}
.tour-brand-mark{background:var(--pp);color:#fff;font-size:12px;font-weight:900;
  padding:4px 8px;border-radius:8px;letter-spacing:.5px}
.tour-cta{margin-left:auto;background:var(--pp);color:#fff;border:none;border-radius:8px;
  padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;
  display:inline-block;transition:background .15s}
.tour-cta:hover{background:var(--pp-dark)}
.tour-cta.grande{margin:6px 0 0;padding:14px 30px;font-size:16px}

/* ── Cabeçalho do sistema ── */
.tour-head{background:linear-gradient(180deg,var(--pp-soft) 0%,#fff 100%);
  padding:52px 24px 34px;text-align:center}
.tour-head-in{max-width:720px;margin:0 auto}
.tour-badge{display:inline-flex;align-items:center;gap:6px;background:#ede9fe;color:var(--pp);
  border-radius:999px;padding:6px 16px;font-size:13px;font-weight:700;margin-bottom:18px}
.tour-head h1{font-size:clamp(30px,5vw,46px);font-weight:900;letter-spacing:-1.2px;
  line-height:1.1;margin:0 0 12px;display:flex;align-items:center;justify-content:center;gap:14px}
.tour-head-emoji{display:inline-flex;align-items:center;justify-content:center;
  width:64px;height:64px;border-radius:18px;background:#fff;font-size:32px;
  box-shadow:0 8px 24px rgba(124,58,237,.18);border:1px solid #ede9fe}
.tour-head p{font-size:17px;color:var(--muted);margin:0}
.tour-head.compacto{padding:20px 24px 14px}
.tour-head.compacto h1{font-size:clamp(22px,3vw,28px);margin:0}
.tour-head.compacto .tour-head-emoji{width:44px;height:44px;font-size:22px;border-radius:13px}
.tour-head.compacto p,.tour-head.compacto .tour-badge{display:none}

/* ── Miolo: menu + palco, dentro de um cartão só ── */
.tour-shell{max-width:1180px;margin:0 auto 56px;padding:0 24px;
  display:grid;grid-template-columns:296px 1fr;gap:24px;align-items:start}
.tour-side{background:#fff;border:1px solid var(--line);border-radius:16px;padding:10px 10px 16px;
  box-shadow:0 4px 20px rgba(17,24,39,.05);position:sticky;top:88px;
  max-height:calc(100vh - 112px);overflow:auto}
.tour-side-t{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;
  color:var(--muted);padding:10px 12px 4px;margin:0}
.tour-group{font-size:10.5px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;
  color:#9aa0ad;padding:16px 12px 6px}
.tour-block{margin-bottom:2px}
.tour-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;
  background:none;border:none;cursor:pointer;padding:10px 12px;border-radius:10px;
  font:inherit;font-size:14px;font-weight:600;color:var(--ink);line-height:1.25;
  transition:background .13s,color .13s}
.tour-item:hover{background:var(--pp-soft);color:var(--pp)}
.tour-item.ativo{background:var(--pp);color:#fff}
.tour-item.filho{padding-left:24px;font-size:13.5px;font-weight:500;color:#4b5563;position:relative}
.tour-item.filho::before{content:'';position:absolute;left:13px;top:50%;width:6px;height:1.5px;
  background:#d7d9e0;transform:translateY(-50%)}
.tour-item.filho:hover{color:var(--pp)}
.tour-item.ativo.filho{color:#fff}
.tour-item.ativo.filho::before{background:rgba(255,255,255,.6)}
.tour-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tour-play{flex-shrink:0;width:22px;height:22px;border-radius:50%;background:var(--pp-soft);
  color:var(--pp);font-size:9px;display:inline-flex;align-items:center;justify-content:center}
.tour-item.ativo .tour-play{background:rgba(255,255,255,.22);color:#fff}
.tour-soon{flex-shrink:0;font-size:10px;font-weight:700;color:#9aa0ad;
  background:#f3f4f6;border-radius:999px;padding:2px 8px;text-transform:uppercase;letter-spacing:.3px}
.tour-item.ativo .tour-soon{background:rgba(255,255,255,.2);color:#fff}

.tour-stage{min-width:0;background:#fff;border:1px solid var(--line);border-radius:16px;
  box-shadow:0 4px 20px rgba(17,24,39,.05);padding:28px}

/* Tela inicial do palco: atalhos pros vídeos que já existem */
.tour-start h2{font-size:24px;font-weight:800;margin:0 0 6px;letter-spacing:-.4px}
.tour-start-sub{color:var(--muted);font-size:15px;margin:0 0 22px}
.tour-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.tour-card{display:flex;align-items:center;gap:12px;text-align:left;cursor:pointer;
  background:#fff;border:1.5px solid var(--line);border-radius:12px;padding:14px;
  font:inherit;color:var(--ink);transition:border-color .15s,box-shadow .15s,transform .15s}
.tour-card:hover{border-color:var(--pp);box-shadow:0 8px 20px rgba(124,58,237,.12);transform:translateY(-2px)}
.tour-card-play{flex-shrink:0;width:38px;height:38px;border-radius:11px;background:var(--pp-soft);
  color:var(--pp);font-size:13px;display:inline-flex;align-items:center;justify-content:center}
.tour-card-txt{display:flex;flex-direction:column;min-width:0}
.tour-card-txt strong{font-size:14.5px;font-weight:700;line-height:1.3}
.tour-card-txt small{font-size:12px;color:var(--muted)}
.tour-start-mais{margin:16px 2px 0;font-size:13.5px;color:var(--muted)}

/* Player */
.tour-crumb{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:13.5px;
  color:var(--muted);margin-bottom:14px}
.tour-crumb strong{color:var(--ink)}
.tour-crumb-back{background:none;border:none;padding:0;font:inherit;font-size:13.5px;
  font-weight:700;color:var(--pp);cursor:pointer}
.tour-crumb-back:hover{text-decoration:underline}
.tour-player{position:relative;padding-top:56.25%;background:#000;border-radius:14px;
  overflow:hidden;box-shadow:0 12px 40px rgba(17,24,39,.16)}
.tour-player iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.tour-vtitulo{font-size:20px;font-weight:800;margin:18px 2px 4px;letter-spacing:-.3px}
.tour-vdesc{font-size:14.5px;color:var(--muted);line-height:1.6;margin:0 2px}
.tour-vlista{display:flex;flex-direction:column;gap:6px;margin-top:16px}
.tour-vlista-item{display:flex;align-items:center;gap:10px;text-align:left;background:#fff;
  border:1.5px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit;font-size:14px;
  font-weight:600;cursor:pointer;color:var(--ink);transition:border-color .15s,background .15s}
.tour-vlista-item:hover{border-color:var(--pp)}
.tour-vlista-item.ativo{border-color:var(--pp);background:var(--pp-soft)}
.tour-vlista-n{background:var(--pp);color:#fff;font-size:12px;font-weight:800;width:22px;
  height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}

/* Chamada depois do vídeo */
.tour-pos-video{margin-top:24px;background:var(--pp-soft);border:1px solid #ede9fe;border-radius:14px;
  padding:18px 20px;display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap}
.tour-pos-video strong{font-size:15.5px;font-weight:800}
.tour-pos-video span{font-size:14px;color:var(--muted);flex:1;min-width:200px}

/* Estado vazio */
.tour-vazio{max-width:440px;margin:4vh auto;text-align:center}
.tour-vazio-emoji{font-size:48px}
.tour-vazio h2{font-size:23px;font-weight:800;margin:8px 0 6px}
.tour-vazio p{color:var(--muted);font-size:15px;margin:0 0 18px}
.tour-btn-sec{background:#fff;color:var(--ink);border:1.5px solid var(--line);border-radius:10px;
  padding:11px 22px;font:inherit;font-weight:700;cursor:pointer}
.tour-btn-sec:hover{border-color:var(--pp);color:var(--pp)}

/* Rodapé */
.tour-foot{border-top:1px solid var(--line);padding:22px 24px;display:flex;gap:12px;
  align-items:center;justify-content:center;flex-wrap:wrap;font-size:13.5px;color:var(--muted)}
.tour-foot button{background:none;border:none;font:inherit;font-weight:700;color:var(--pp);cursor:pointer}
.tour-foot button:hover{text-decoration:underline}

@media (max-width:900px){
  /* No celular o palco vem primeiro: senão o visitante rolaria 28 itens de
     menu antes de ver o conteúdo. */
  .tour-shell{display:flex;flex-direction:column;gap:16px}
  .tour-stage{order:1}
  .tour-side{order:2;position:static;max-height:none;overflow:visible}
  .tour-head{padding:36px 20px 26px}
  .tour-head h1{gap:10px}
  .tour-head-emoji{width:52px;height:52px;font-size:26px;border-radius:15px}
  .tour-stage{padding:20px}
  .tour-top{padding:0 16px}
  .tour-top-in{gap:10px}
  .tour-brand{display:none}
  .tour-cta{padding:10px 16px;font-size:13.5px}
}
`
