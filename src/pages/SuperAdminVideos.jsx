// Super Admin → Vídeos tutoriais.
//
// A tela é dividida em CATEGORIAS recolhidas (Gestor, Portal, Aplicativo de
// Entregas e Outros). Clique na setinha da categoria para abrir, ache o botão
// e cole o vídeo. Cada botão pode ter VÁRIOS vídeos (ex: um por ação da tela).
// Botão sem vídeo continua sem ▶ na landing — dá pra publicar aos poucos.

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { APRESENTACAO, catalogoAgrupado, extrairYoutubeId } from '../lib/videosTutorial'
import '../components/Page.css'

const vazio = { titulo: '', link: '' }
const CATS = catalogoAgrupado()

export default function SuperAdminVideos() {
  const [videos, setVideos] = useState({})     // { chave: [linhas] }
  const [form, setForm] = useState({})          // { chave: {titulo, link} }
  const [aberta, setAberta] = useState(null)    // botão (funcionalidade) expandido
  const [catAberta, setCatAberta] = useState(null) // categoria expandida
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(null)
  const [msg, setMsg] = useState(null)

  async function carregar() {
    setLoading(true)
    const { data, error } = await supabase.from('videos_tutorial').select('*').order('ordem')
    if (error) setMsg({ tipo: 'erro', texto: error.message })
    const mapa = {}
    for (const v of (data ?? [])) (mapa[v.chave] ??= []).push(v)
    setVideos(mapa)
    setLoading(false)
  }
  useEffect(() => { carregar() }, [])

  async function adicionar(f) {
    const dados = form[f.chave] ?? vazio
    const id = extrairYoutubeId(dados.link)
    if (!id) { setMsg({ tipo: 'erro', texto: 'Link inválido. Cole o endereço do vídeo no YouTube.' }); return }
    const titulo = dados.titulo.trim()
    if (!titulo) { setMsg({ tipo: 'erro', texto: 'Dê um nome ao vídeo (ex: "Como imprimir o cupom").' }); return }

    const atuais = videos[f.chave] ?? []
    if (atuais.some(v => v.youtube_id === id)) {
      setMsg({ tipo: 'erro', texto: 'Esse vídeo já está nessa funcionalidade.' }); return
    }

    setSalvando(f.chave); setMsg(null)
    const { error } = await supabase.from('videos_tutorial').insert({
      chave: f.chave, titulo, youtube_id: id, ativo: true,
      ordem: atuais.length ? Math.max(...atuais.map(v => v.ordem ?? 0)) + 1 : 0,
    })
    setSalvando(null)
    if (error) { setMsg({ tipo: 'erro', texto: error.message }); return }
    setForm(p => ({ ...p, [f.chave]: vazio }))
    setMsg({ tipo: 'ok', texto: `"${titulo}" publicado em ${f.label}.` })
    carregar()
  }

  async function alternarAtivo(v) {
    await supabase.from('videos_tutorial').update({ ativo: !v.ativo }).eq('id', v.id)
    carregar()
  }

  async function remover(v) {
    if (!window.confirm(`Remover o vídeo "${v.titulo}"?`)) return
    await supabase.from('videos_tutorial').delete().eq('id', v.id)
    carregar()
  }

  // Troca a posição com o vizinho, gravando a `ordem` dos dois.
  async function mover(chave, i, passo) {
    const lista = [...(videos[chave] ?? [])]
    const j = i + passo
    if (j < 0 || j >= lista.length) return
    const a = lista[i], b = lista[j]
    await Promise.all([
      supabase.from('videos_tutorial').update({ ordem: j }).eq('id', a.id),
      supabase.from('videos_tutorial').update({ ordem: i }).eq('id', b.id),
    ])
    carregar()
  }

  const totalVideos = Object.values(videos).flat().length
  // Quantos vídeos existem numa categoria (soma de todas as chaves dela).
  const contarCat = cat => cat.itens.reduce((n, it) => n + (it.chave ? (videos[it.chave]?.length || 0) : 0), 0)

  // Um botão (funcionalidade) = accordion que abre o formulário de adicionar vídeo.
  function renderItem(f) {
    const lista = videos[f.chave] ?? []
    const exp = aberta === f.chave
    const dados = form[f.chave] ?? vazio
    return (
      <div key={f.chave} style={{
        background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)',
        borderRadius: 10, padding: 12,
      }}>
        <button
          type="button"
          onClick={() => setAberta(exp ? null : f.chave)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            color: 'var(--text)', textAlign: 'left',
          }}
        >
          <strong style={{ fontSize: 14, flex: 1, fontWeight: 600 }}>{f.label}</strong>
          <span style={{
            fontSize: 11, fontWeight: 800, padding: '2px 9px', borderRadius: 999,
            background: lista.length ? 'rgba(22,163,74,.15)' : 'var(--border)',
            color: lista.length ? '#16a34a' : 'var(--text-muted)',
          }}>
            {lista.length ? `${lista.length} vídeo${lista.length > 1 ? 's' : ''}` : 'sem vídeo'}
          </span>
          <span aria-hidden style={{ fontSize: 11, color: 'var(--text-muted)', transform: exp ? 'rotate(180deg)' : 'none' }}>▼</span>
        </button>

        {exp && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            {lista.map((v, i) => (
              <div key={v.id} style={{
                display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
                padding: '8px 0', borderBottom: '1px solid var(--border)',
              }}>
                <span style={{ color: 'var(--text-muted)', fontSize: 12, width: 18, flexShrink: 0 }}>{i + 1}.</span>
                <img src={`https://img.youtube.com/vi/${v.youtube_id}/default.jpg`} alt=""
                  width={72} height={40}
                  style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#000', opacity: v.ativo ? 1 : .45 }} />
                <span style={{ flex: 1, minWidth: 150 }}>
                  <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{v.titulo}</span>
                  <a href={`https://youtu.be/${v.youtube_id}`} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11.5, color: 'var(--primary)' }}>youtu.be/{v.youtube_id}</a>
                  {!v.ativo && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>· pausado</span>}
                </span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button className="btn btn-secondary" type="button" onClick={() => mover(f.chave, i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
                  <button className="btn btn-secondary" type="button" onClick={() => mover(f.chave, i, 1)} disabled={i === lista.length - 1} aria-label="Descer">↓</button>
                  <button className="btn btn-secondary" type="button" onClick={() => alternarAtivo(v)}>{v.ativo ? 'Pausar' : 'Reativar'}</button>
                  <button className="btn btn-secondary" type="button" onClick={() => remover(v)}>Remover</button>
                </span>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <input
                type="text" placeholder="Nome do vídeo (ex: Como imprimir o cupom)"
                value={dados.titulo}
                onChange={e => setForm(p => ({ ...p, [f.chave]: { ...dados, titulo: e.target.value } }))}
                style={{
                  flex: '1 1 240px', padding: '8px 12px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))',
                  color: 'var(--text)', fontSize: 14,
                }}
              />
              <input
                type="text" placeholder="Link do YouTube"
                value={dados.link}
                onChange={e => setForm(p => ({ ...p, [f.chave]: { ...dados, link: e.target.value } }))}
                onKeyDown={e => { if (e.key === 'Enter') adicionar(f) }}
                style={{
                  flex: '1 1 200px', padding: '8px 12px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))',
                  color: 'var(--text)', fontSize: 14,
                }}
              />
              <button className="btn btn-primary" type="button"
                onClick={() => adicionar(f)} disabled={salvando === f.chave}>
                {salvando === f.chave ? 'Salvando…' : 'Adicionar'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="page-header"><h1>Vídeos tutoriais</h1></div>

      <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6, maxWidth: 760, marginTop: 0 }}>
        Os vídeos são divididos por <strong>categoria</strong> (Gestor, Portal, App de Entregas…).
        Abra a categoria na setinha, ache o botão e cole o link do vídeo — cada botão pode ter
        vários. Eles aparecem no card da landing (fwcinter.com) na ordem definida aqui.
        Hoje: <strong>{totalVideos} vídeo(s)</strong> publicados.
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 900 }}>
          {/* Vídeo de apresentação — fora das categorias, no topo. */}
          {renderItem(APRESENTACAO)}

          {/* Categorias recolhidas. */}
          {CATS.map(cat => {
            const abertaCat = catAberta === cat.id
            const n = contarCat(cat)
            return (
              <div key={cat.id} style={{
                background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)',
                borderRadius: 12, padding: 14,
              }}>
                <button
                  type="button"
                  onClick={() => setCatAberta(abertaCat ? null : cat.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    color: 'var(--text)', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 22 }} aria-hidden>{cat.emoji}</span>
                  <strong style={{ fontSize: 16, flex: 1 }}>{cat.titulo}</strong>
                  <span style={{
                    fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 999,
                    background: n ? 'rgba(22,163,74,.15)' : 'var(--border)',
                    color: n ? '#16a34a' : 'var(--text-muted)',
                  }}>
                    {n ? `${n} vídeo${n > 1 ? 's' : ''}` : 'sem vídeo'}
                  </span>
                  <span aria-hidden style={{ fontSize: 13, color: 'var(--text-muted)', transform: abertaCat ? 'rotate(180deg)' : 'none' }}>▼</span>
                </button>

                {abertaCat && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {cat.itens.map((it, idx) => it.group
                      ? (
                        <div key={`g${idx}`} style={{
                          fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .6,
                          color: 'var(--text-muted)', margin: '10px 2px 0',
                        }}>{it.group}</div>
                      )
                      : renderItem(it)
                    )}
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
