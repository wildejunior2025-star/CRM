// Monta o banner promocional no navegador: a CENA vem da IA (foto real do
// produto recriada numa cena de propaganda, sem nenhuma letra) e o TEXTO é
// escrito aqui, com as fontes aprovadas pelo usuário em 14/09/2026 (Barlow
// Condensed + Pacifico). Assim o preço sai do cadastro, o acento sai certo e a
// loja ajusta qualquer texto e vê na hora, sem gastar geração de imagem.
//
// É a versão em canvas do estudo `FWC geral/estudo-banner-ia/compor2.py`.

export const BANNER_W = 1536
export const BANNER_H = 1024

const OURO_CLARO = '#FFE882'
const OURO = '#FFB800'
const OURO_ESCURO = '#D68000'
const CREME = '#FFF3DC'
const MARROM = '#281204'
const VERMELHO = '#DC221E'
const VERMELHO_ESC = '#96100E'

const FONTES = [
  ['BannerBlackItalic', '/fonts/banner/BarlowCondensed-BlackItalic.ttf'],
  ['BannerXBoldItalic', '/fonts/banner/BarlowCondensed-ExtraBoldItalic.ttf'],
  ['BannerBold', '/fonts/banner/BarlowCondensed-Bold.ttf'],
  ['BannerScript', '/fonts/banner/Pacifico-Regular.ttf'],
]

let fontesProntas = null
export function carregarFontesBanner() {
  if (!fontesProntas) {
    fontesProntas = Promise.all(FONTES.map(async ([familia, url]) => {
      const face = new FontFace(familia, `url(${url})`)
      await face.load()
      document.fonts.add(face)
    }))
  }
  return fontesProntas
}

export function carregarImagem(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

const fonte = (familia, tam) => `${tam}px ${familia}`

// Texto com degradê vertical, contorno e sombra suave (o "cartaz" dourado).
function textoCartaz(ctx, txt, x, y, familia, tam, { topo, base, contorno, larg = 0, sombra = true, rot = 0 }) {
  ctx.save()
  ctx.font = fonte(familia, tam)
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  ctx.translate(x, y)
  if (rot) ctx.rotate((-rot * Math.PI) / 180)
  if (sombra) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,.72)'
    ctx.shadowBlur = Math.max(6, tam / 11)
    ctx.shadowOffsetX = Math.max(2, tam / 40)
    ctx.shadowOffsetY = Math.max(4, tam / 26)
    ctx.fillStyle = contorno || 'rgba(0,0,0,.6)'
    if (larg) { ctx.lineWidth = larg * 2; ctx.strokeStyle = contorno; ctx.strokeText(txt, 0, 0) }
    ctx.fillText(txt, 0, 0)
    ctx.restore()
  }
  if (larg) {
    ctx.lineWidth = larg * 2
    ctx.strokeStyle = contorno
    ctx.strokeText(txt, 0, 0)
  }
  const g = ctx.createLinearGradient(0, tam * 0.1, 0, tam * 1.0)
  g.addColorStop(0, topo)
  g.addColorStop(1, base)
  ctx.fillStyle = g
  ctx.fillText(txt, 0, 0)
  ctx.restore()
}

function medir(ctx, txt, familia, tam) {
  ctx.font = fonte(familia, tam)
  return ctx.measureText(txt).width
}

// Diminui a fonte até caber na largura.
function caber(ctx, txt, familia, tamMax, larguraMax) {
  const w = medir(ctx, txt, familia, tamMax)
  return w <= larguraMax ? tamMax : Math.floor(tamMax * (larguraMax / w))
}

function fundo(ctx, cena) {
  const DES = 190
  const { width: cw, height: ch } = cena
  const escala = BANNER_H / ch
  const largCena = cw * escala

  ctx.fillStyle = '#0c0602'
  ctx.fillRect(0, 0, BANNER_W, BANNER_H)

  // faixa da esquerda: continuação desfocada da própria cena
  ctx.save()
  ctx.filter = 'blur(18px)'
  ctx.drawImage(cena, 0, 0, (DES + 320) / escala, ch, -20, -20, DES + 340, BANNER_H + 40)
  ctx.restore()

  // cena afastada pra direita, com degradê na junção (sem emenda)
  const tmp = document.createElement('canvas')
  tmp.width = BANNER_W
  tmp.height = BANNER_H
  const t = tmp.getContext('2d')
  t.drawImage(cena, DES, 0, largCena, BANNER_H)
  t.globalCompositeOperation = 'destination-in'
  const m = t.createLinearGradient(DES, 0, DES + 260, 0)
  m.addColorStop(0, 'rgba(0,0,0,0)')
  m.addColorStop(0.35, 'rgba(0,0,0,.2)')
  m.addColorStop(0.7, 'rgba(0,0,0,.6)')
  m.addColorStop(1, 'rgba(0,0,0,1)')
  t.fillStyle = m
  t.fillRect(0, 0, BANNER_W, BANNER_H)
  ctx.drawImage(tmp, 0, 0)

  // escurece a esquerda pro texto respirar
  const e = ctx.createLinearGradient(0, 0, BANNER_W * 0.57, 0)
  e.addColorStop(0, 'rgba(12,6,2,.88)')
  e.addColorStop(0.35, 'rgba(12,6,2,.52)')
  e.addColorStop(0.7, 'rgba(12,6,2,.2)')
  e.addColorStop(1, 'rgba(12,6,2,0)')
  ctx.fillStyle = e
  ctx.fillRect(0, 0, BANNER_W, BANNER_H)
}

function riscos(ctx, cx, cy, angulos, cor = OURO, larg = 9, L = 36) {
  ctx.save()
  ctx.strokeStyle = cor
  ctx.lineWidth = larg
  ctx.lineCap = 'round'
  angulos.forEach(([dx, dy, ang]) => {
    const a = (ang * Math.PI) / 180
    ctx.beginPath()
    ctx.moveTo(cx + dx, cy + dy)
    ctx.lineTo(cx + dx + L * Math.cos(a), cy + dy + L * Math.sin(a))
    ctx.stroke()
  })
  ctx.restore()
}

function selo(ctx, linhas, x, y) {
  const diam = 330
  const c = diam / 2
  ctx.save()
  ctx.translate(x + c, y + c)
  ctx.rotate((12 * Math.PI) / 180)

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.55)'
  ctx.shadowBlur = 22
  ctx.shadowOffsetX = 10
  ctx.shadowOffsetY = 16
  ctx.beginPath()
  for (let i = 0; i < 60; i++) {
    const a = (Math.PI * 2 * i) / 60
    const r = c * (i % 2 === 0 ? 0.985 : 0.9)
    const px = r * Math.cos(a)
    const py = r * Math.sin(a)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fillStyle = OURO
  ctx.fill()
  ctx.restore()

  ctx.beginPath()
  ctx.arc(0, 0, c * 0.84, 0, Math.PI * 2)
  ctx.fillStyle = '#FFCD28'
  ctx.fill()

  ctx.save()
  ctx.setLineDash([9, 14])
  ctx.strokeStyle = MARROM
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(0, 0, c * 0.8, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  const estilos = {
    pequeno: { familia: 'BannerXBoldItalic', tam: 26, alt: 27, cor: MARROM },
    faixa: { familia: 'BannerBlackItalic', tam: 36, alt: 42, cor: '#fff', fundo: VERMELHO },
    grande: { familia: 'BannerBlackItalic', tam: 68, alt: 64, cor: MARROM },
    destaque: { familia: 'BannerBlackItalic', tam: 50, alt: 50, cor: VERMELHO },
  }
  const itens = linhas.filter(l => l?.texto?.trim()).slice(0, 5)
  const total = itens.reduce((s, l) => s + (estilos[l.estilo] ?? estilos.pequeno).alt, 0)
  let yy = -total / 2 + 2
  ctx.textBaseline = 'top'
  for (const l of itens) {
    const est = estilos[l.estilo] ?? estilos.pequeno
    const txt = l.texto.trim()
    const tam = caber(ctx, txt, est.familia, est.tam, diam * 0.62)
    ctx.font = fonte(est.familia, tam)
    const w = ctx.measureText(txt).width
    if (est.fundo) {
      ctx.fillStyle = est.fundo
      ctx.beginPath()
      ctx.moveTo(-w / 2 - 12 + 6, yy + 4)
      ctx.lineTo(w / 2 + 12 + 6, yy + 4)
      ctx.lineTo(w / 2 + 12, yy + est.alt + 4)
      ctx.lineTo(-w / 2 - 12, yy + est.alt + 4)
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = est.cor
    ctx.fillText(txt, -w / 2, yy)
    yy += est.alt
  }
  ctx.restore()
}

function botao(ctx, txt) {
  const bw = 400
  const bh = 108
  const x = BANNER_W - bw - 70
  const y = BANNER_H - bh - 70
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.5)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 10
  ctx.fillStyle = VERMELHO_ESC
  ctx.beginPath()
  ctx.roundRect(x, y + 8, bw, bh, 30)
  ctx.fill()
  ctx.restore()
  ctx.fillStyle = VERMELHO
  ctx.beginPath()
  ctx.roundRect(x, y, bw, bh, 30)
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = '#FFECC8'
  ctx.stroke()
  const tam = caber(ctx, txt, 'BannerBlackItalic', 74, bw - 40)
  ctx.font = fonte('BannerBlackItalic', tam)
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  const tw = ctx.measureText(txt).width
  ctx.fillText(txt, x + (bw - tw) / 2, y + bh / 2 + 2)
  riscos(ctx, x + bw - 4, y - 16, [[0, 0, -60], [24, 22, -30]], OURO, 7, 30)
}

/**
 * Desenha o banner inteiro num canvas 1536x1024.
 * textos: { loja, tema, titulo, subtitulo, preco (número), selo: [{texto, estilo}], cta }
 */
export async function desenharBanner(canvas, cena, textos) {
  await carregarFontesBanner()
  canvas.width = BANNER_W
  canvas.height = BANNER_H
  const ctx = canvas.getContext('2d')
  fundo(ctx, cena)

  const x0 = 76
  // marca da loja
  if (textos.loja) {
    ctx.save()
    ctx.font = fonte('BannerBold', caber(ctx, textos.loja.toUpperCase(), 'BannerBold', 38, 620))
    ctx.textBaseline = 'top'
    ctx.fillStyle = CREME
    ctx.fillText(textos.loja.toUpperCase(), x0, 52)
    ctx.fillStyle = OURO
    ctx.fillRect(x0, 100, 70, 5)
    ctx.restore()
  }

  // tema em letra cursiva
  if (textos.tema) {
    const tam = caber(ctx, textos.tema, 'BannerScript', 84, 620)
    textoCartaz(ctx, textos.tema, x0 + 6, 142, 'BannerScript', tam, { topo: CREME, base: '#FFD696', rot: 4 })
  }

  // título grande
  const titulo = (textos.titulo || '').toUpperCase()
  const tamTit = caber(ctx, titulo, 'BannerBlackItalic', 250, 720)
  const yTit = 238 + (250 - tamTit) * 0.55
  textoCartaz(ctx, titulo, x0 - 10, yTit, 'BannerBlackItalic', tamTit, { topo: OURO_CLARO, base: OURO_ESCURO, contorno: MARROM, larg: 6 })
  const wTit = medir(ctx, titulo, 'BannerBlackItalic', tamTit)
  riscos(ctx, Math.min(x0 + wTit + 12, 900), yTit + 24, [[0, 0, -50], [26, 34, -20], [30, 80, 10]])

  // etiqueta inclinada
  if (textos.subtitulo) {
    const sub = textos.subtitulo.toUpperCase()
    const tam = caber(ctx, sub, 'BannerBlackItalic', 84, 560)
    ctx.font = fonte('BannerBlackItalic', tam)
    const tw = ctx.measureText(sub).width
    const ty = 478
    const inc = 22
    ctx.fillStyle = OURO
    ctx.beginPath()
    ctx.moveTo(x0 + inc, ty)
    ctx.lineTo(x0 + tw + 56 + inc, ty)
    ctx.lineTo(x0 + tw + 56, ty + 96)
    ctx.lineTo(x0, ty + 96)
    ctx.closePath()
    ctx.fill()
    ctx.textBaseline = 'middle'
    ctx.fillStyle = MARROM
    ctx.fillText(sub, x0 + 30, ty + 50)
    ctx.fillStyle = CREME
    for (let i = 0; i < tw + 50; i += 18) {
      ctx.beginPath()
      ctx.arc(x0 + 9 + i, ty + 115, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // preço: R$ + inteiro grande + centavos elevados
  const valor = Number(textos.preco)
  if (Number.isFinite(valor) && valor > 0) {
    const [inteiro, cents] = valor.toFixed(2).split('.')
    const py = 632
    // o preço não pode invadir o prato: encolhe junto se o número for grande
    const base = 380
    const larguraDisp = 560
    const wInt = medir(ctx, inteiro, 'BannerBlackItalic', base)
    const wCent = medir(ctx, `,${cents}`, 'BannerBlackItalic', base * 0.53)
    const fator = Math.min(1, larguraDisp / (118 + wInt + wCent))
    const tInt = Math.floor(base * fator)
    const tCent = Math.floor(base * 0.53 * fator)
    textoCartaz(ctx, 'R$', x0, py + 70 * fator, 'BannerBlackItalic', Math.floor(96 * Math.max(fator, 0.8)), { topo: CREME, base: '#EBD7B9', contorno: MARROM, larg: 3 })
    ctx.save()
    ctx.strokeStyle = CREME
    ctx.lineWidth = 5
    for (let i = 0; i < 3; i++) {
      const yy = py + 196 * Math.max(fator, 0.8) + i * 16
      ctx.beginPath()
      ctx.moveTo(x0 + 4, yy)
      ctx.bezierCurveTo(x0 + 16, yy - 10, x0 + 26, yy - 10, x0 + 34, yy)
      ctx.bezierCurveTo(x0 + 42, yy + 10, x0 + 52, yy + 10, x0 + 60, yy)
      ctx.stroke()
    }
    ctx.restore()
    const xInt = x0 + 118
    const yInt = py - 34 + (1 - fator) * 160
    textoCartaz(ctx, inteiro, xInt, yInt, 'BannerBlackItalic', tInt, { topo: OURO_CLARO, base: OURO_ESCURO, contorno: MARROM, larg: 8 })
    const wIntReal = medir(ctx, inteiro, 'BannerBlackItalic', tInt)
    textoCartaz(ctx, `,${cents}`, xInt + wIntReal - 4, yInt + 54 * fator, 'BannerBlackItalic', tCent, { topo: OURO_CLARO, base: OURO_ESCURO, contorno: MARROM, larg: 6 })
  }

  if (Array.isArray(textos.selo) && textos.selo.some(l => l?.texto?.trim())) {
    selo(ctx, textos.selo, 1118, 40)
  }

  botao(ctx, (textos.cta || 'PEÇA AGORA!').toUpperCase())
  return canvas
}
