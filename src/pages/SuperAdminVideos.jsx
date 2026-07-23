// Super Admin → Vídeos. Cola o link do YouTube em cada funcionalidade e ele
// aparece no card correspondente da landing (fwcinter.com).
//
// Funcionalidade sem link cadastrado continua um card comum, sem ▶. Assim dá
// pra publicar um vídeo por vez, conforme grava, sem precisar ter todos.

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { FUNCIONALIDADES, extrairYoutubeId } from '../lib/videosTutorial'
import '../components/Page.css'

export default function SuperAdminVideos() {
  const [videos, setVideos] = useState({})   // { chave: linha do banco }
  const [rascunho, setRascunho] = useState({}) // { chave: texto do input }
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(null)
  const [msg, setMsg] = useState(null)

  async function carregar() {
    setLoading(true)
    const { data, error } = await supabase.from('videos_tutorial').select('*')
    if (error) setMsg({ tipo: 'erro', texto: error.message })
    const mapa = {}
    for (const v of (data ?? [])) mapa[v.chave] = v
    setVideos(mapa)
    setLoading(false)
  }
  useEffect(() => { carregar() }, [])

  async function salvar(f) {
    const bruto = rascunho[f.chave] ?? ''
    const id = extrairYoutubeId(bruto)
    if (!id) {
      setMsg({ tipo: 'erro', texto: `Link inválido em "${f.label}". Cole o endereço do vídeo no YouTube.` })
      return
    }
    setSalvando(f.chave); setMsg(null)
    const { error } = await supabase.from('videos_tutorial').upsert({
      chave: f.chave, titulo: f.label, youtube_id: id, ativo: true,
    }, { onConflict: 'chave' })
    setSalvando(null)
    if (error) { setMsg({ tipo: 'erro', texto: error.message }); return }
    setRascunho(p => ({ ...p, [f.chave]: '' }))
    setMsg({ tipo: 'ok', texto: `Vídeo de "${f.label}" publicado na landing.` })
    carregar()
  }

  async function alternarAtivo(v) {
    await supabase.from('videos_tutorial').update({ ativo: !v.ativo }).eq('chave', v.chave)
    carregar()
  }

  async function remover(v) {
    if (!window.confirm(`Tirar o vídeo de "${v.titulo}" da landing?`)) return
    await supabase.from('videos_tutorial').delete().eq('chave', v.chave)
    carregar()
  }

  const total = Object.values(videos).filter(v => v.ativo).length

  return (
    <div>
      <div className="page-header">
        <h1>Vídeos tutoriais</h1>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, maxWidth: 720, marginTop: 0 }}>
        Cole o link do YouTube na funcionalidade e o card dela na landing (fwcinter.com) vira
        clicável, com um ▶. Funcionalidade sem vídeo continua um card comum — publique um de cada
        vez, conforme gravar. <strong>{total} de {FUNCIONALIDADES.length}</strong> com vídeo.
      </p>

      {msg && (
        <div style={{
          margin: '0 0 16px', padding: '10px 14px', borderRadius: 10, fontSize: 14,
          background: msg.tipo === 'erro' ? 'rgba(239,68,68,.12)' : 'rgba(22,163,74,.12)',
          border: `1px solid ${msg.tipo === 'erro' ? 'rgba(239,68,68,.35)' : 'rgba(22,163,74,.35)'}`,
          color: msg.tipo === 'erro' ? '#ef4444' : '#16a34a',
        }}>{msg.texto}</div>
      )}

      {loading ? <p style={{ color: 'var(--text-muted)' }}>Carregando…</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 860 }}>
          {FUNCIONALIDADES.map(f => {
            const v = videos[f.chave]
            return (
              <div key={f.chave} style={{
                background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)',
                borderRadius: 12, padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                  <strong style={{ fontSize: 14.5 }}>{f.label}</strong>
                  {v && (
                    <span style={{
                      fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 999,
                      background: v.ativo ? 'rgba(22,163,74,.15)' : 'var(--border)',
                      color: v.ativo ? '#16a34a' : 'var(--text-muted)',
                    }}>{v.ativo ? 'No ar' : 'Pausado'}</span>
                  )}
                </div>

                {v ? (
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <img
                      src={`https://img.youtube.com/vi/${v.youtube_id}/mqdefault.jpg`}
                      alt="" width={112} height={63}
                      style={{ borderRadius: 8, objectFit: 'cover', flexShrink: 0, background: '#000' }}
                    />
                    <a href={`https://youtu.be/${v.youtube_id}`} target="_blank" rel="noreferrer"
                      style={{ fontSize: 13, color: 'var(--primary)' }}>
                      youtu.be/{v.youtube_id}
                    </a>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button className="btn btn-secondary" type="button" onClick={() => alternarAtivo(v)}>
                        {v.ativo ? 'Pausar' : 'Reativar'}
                      </button>
                      <button className="btn btn-secondary" type="button" onClick={() => remover(v)}>
                        Remover
                      </button>
                    </span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      placeholder="Cole aqui o link do YouTube"
                      value={rascunho[f.chave] ?? ''}
                      onChange={e => setRascunho(p => ({ ...p, [f.chave]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') salvar(f) }}
                      style={{
                        flex: 1, minWidth: 240, padding: '8px 12px', borderRadius: 8,
                        border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))',
                        color: 'var(--text)', fontSize: 14,
                      }}
                    />
                    <button className="btn btn-primary" type="button"
                      onClick={() => salvar(f)} disabled={salvando === f.chave}>
                      {salvando === f.chave ? 'Salvando…' : 'Publicar'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
