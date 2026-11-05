import { useEffect, useMemo, useRef, useState } from 'react'

// Tela de corte da foto do produto.
//
// A vitrine mostra a foto num QUADRADO (no celular, 92×92). Antes o corte era
// automático, no centro: prato fora do centro saía cortado e ninguém via isso
// até abrir a loja. Aqui quem cadastra vê o quadrado, arrasta a foto e dá zoom
// pra escolher o pedaço que vai aparecer. Devolve um JPEG 800×800.
//
// `onConcluir(file)`  → foto cortada.
// `onCancelar()`      → desistiu (nada é enviado).
// Se o navegador não consegue mostrar a imagem (ex.: HEIC fora do Safari), pula
// o corte e devolve o arquivo original — melhor subir sem corte que travar.
const SAIDA = 800

export default function CortadorFoto({ arquivo, onConcluir, onCancelar }) {
  const url = useMemo(() => URL.createObjectURL(arquivo), [arquivo])
  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const [dim, setDim] = useState(null)               // { w, h } naturais
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })     // centro da foto em relação ao centro do quadro
  const [moldura, setMoldura] = useState(300)
  const imgRef = useRef(null)
  const arrasto = useRef(null)

  useEffect(() => {
    const ajustar = () => setMoldura(Math.max(220, Math.min(340, window.innerWidth - 56)))
    ajustar()
    window.addEventListener('resize', ajustar)
    return () => window.removeEventListener('resize', ajustar)
  }, [])

  const escala = dim ? (moldura / Math.min(dim.w, dim.h)) * zoom : 1

  function limitar(p, z = zoom) {
    if (!dim) return p
    const s = (moldura / Math.min(dim.w, dim.h)) * z
    const mx = Math.max(0, (dim.w * s - moldura) / 2)
    const my = Math.max(0, (dim.h * s - moldura) / 2)
    return { x: Math.min(mx, Math.max(-mx, p.x)), y: Math.min(my, Math.max(-my, p.y)) }
  }

  function mudarZoom(z) {
    setZoom(z)
    setPos(p => limitar(p, z))
  }

  function aoPressionar(e) {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    arrasto.current = { x: e.clientX, y: e.clientY, p: pos }
  }
  function aoMover(e) {
    const a = arrasto.current
    if (!a) return
    setPos(limitar({ x: a.p.x + (e.clientX - a.x), y: a.p.y + (e.clientY - a.y) }))
  }
  function aoSoltar() { arrasto.current = null }

  function concluir() {
    const img = imgRef.current
    if (!img || !dim) { onConcluir(arquivo); return }
    const sx = (dim.w * escala / 2 - moldura / 2 - pos.x) / escala
    const sy = (dim.h * escala / 2 - moldura / 2 - pos.y) / escala
    const lado = moldura / escala
    const canvas = document.createElement('canvas')
    canvas.width = SAIDA
    canvas.height = SAIDA
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, SAIDA, SAIDA)
    ctx.drawImage(img, sx, sy, lado, lado, 0, 0, SAIDA, SAIDA)
    canvas.toBlob(b => {
      if (!b) { onConcluir(arquivo); return }
      onConcluir(new File([b], 'foto.jpg', { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.88)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Cortar a foto"
      style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,.82)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: moldura + 40, background: 'var(--surface, #16161f)', color: 'var(--text, #fff)',
        borderRadius: 16, padding: 16, boxSizing: 'border-box' }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Ajuste a foto</div>
        <div style={{ fontSize: 12.5, opacity: .75, marginBottom: 12 }}>
          Arraste para escolher o que aparece no quadrado. Use o zoom para aproximar.
        </div>

        <div
          onPointerDown={aoPressionar} onPointerMove={aoMover} onPointerUp={aoSoltar} onPointerCancel={aoSoltar}
          style={{ position: 'relative', width: moldura, height: moldura, margin: '0 auto', overflow: 'hidden',
            borderRadius: 12, background: '#000', touchAction: 'none', cursor: 'grab', userSelect: 'none' }}>
          <img ref={imgRef} src={url} alt="" draggable={false}
            onLoad={e => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => onConcluir(arquivo)}
            style={dim ? {
              position: 'absolute', left: '50%', top: '50%', maxWidth: 'none',
              width: dim.w * escala, height: dim.h * escala,
              transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`,
              pointerEvents: 'none',
            } : { opacity: 0, position: 'absolute' }} />
          {/* Grade de terços: ajuda a centrar o prato */}
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', border: '2px solid rgba(255,255,255,.9)',
            borderRadius: 12,
            backgroundImage: 'linear-gradient(to right, transparent 33%, rgba(255,255,255,.35) 33%, rgba(255,255,255,.35) calc(33% + 1px), transparent calc(33% + 1px), transparent 66%, rgba(255,255,255,.35) 66%, rgba(255,255,255,.35) calc(66% + 1px), transparent calc(66% + 1px)), linear-gradient(to bottom, transparent 33%, rgba(255,255,255,.35) 33%, rgba(255,255,255,.35) calc(33% + 1px), transparent calc(33% + 1px), transparent 66%, rgba(255,255,255,.35) 66%, rgba(255,255,255,.35) calc(66% + 1px), transparent calc(66% + 1px))' }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 4px 4px' }}>
          <span aria-hidden="true" style={{ fontSize: 16 }}>🔍</span>
          <input type="range" min="1" max="4" step="0.02" value={zoom} aria-label="Zoom"
            onChange={e => mudarZoom(Number(e.target.value))} style={{ flex: 1 }} />
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" onClick={onCancelar}
            style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: '1px solid var(--border, #444)', background: 'transparent',
              color: 'inherit', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
            Cancelar
          </button>
          <button type="button" onClick={concluir} disabled={!dim}
            style={{ flex: 2, padding: '12px 0', borderRadius: 10, border: 'none', background: 'var(--primary, #7c3aed)',
              color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer', opacity: dim ? 1 : .5 }}>
            ✓ Usar esta foto
          </button>
        </div>
      </div>
    </div>
  )
}
