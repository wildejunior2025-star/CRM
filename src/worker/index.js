// Worker do Cardapio Online — injeta as tags Open Graph da loja no HTML.
//
// Por que isto existe: o robo do WhatsApp (e do Facebook, Telegram, etc.) NAO
// executa JavaScript. Ele baixa o HTML cru e le as meta tags. Como o site e um
// SPA, todo mundo recebia o mesmo index.html com <title>FWC Inter</title> e
// nenhuma tag og:*, entao a previa de QUALQUER loja mostrava a logo do FWC.
//
// Aqui interceptamos /nome-da-loja, buscamos a loja no Supabase e reescrevemos
// o <title> + acrescentamos as og:* antes de entregar. O visitante normal recebe
// exatamente o mesmo app — so o HTML inicial muda.
//
// REGRA DE OURO: se qualquer coisa der errado, devolve o asset original intacto.
// Um preview feio e um problema pequeno; derrubar o cardapio nao e.

// Caminho de UM segmento so: /marajo-pizzaria. Rotas internas do app com mais
// de um nivel (/super-admin/config) nem chegam aqui.
const SLUG_RE = /^\/([a-z0-9][a-z0-9-]{1,60})\/?$/i

// Rotas conhecidas do app — evita ida ao banco a toa nas telas mais usadas.
const ROTAS_APP = new Set([
  'painel', 'vendas', 'caixa', 'produtos', 'clientes', 'estoque', 'pedidos',
  'delivery', 'entregas', 'cozinha', 'mesas', 'comandas', 'relatorios',
  'configuracoes', 'minha-loja', 'complementos', 'login', 'entrar', 'cadastro',
  'portal', 'super-admin', 'assets', 'favicon.ico', 'robots.txt',
])

const CACHE_SEG = 300 // 5 min

export default {
  async fetch(request, env, ctx) {
    // ── /api/ping ────────────────────────────────────────────────────────────
    // Responde "pong" sem encostar no banco. E o que permite a tela saber DE QUEM
    // e a culpa quando ela trava: se este ping responde e o banco nao, o problema
    // e o servidor do banco; se nem este responde, a internet daqui e que caiu.
    // Precisa vir ANTES do ASSETS pra nao virar o index.html do app.
    const p = new URL(request.url).pathname
    if (p === '/api/ping') {
      return new Response('pong', {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate',
        },
      })
    }

    const resposta = await env.ASSETS.fetch(request)

    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return resposta

      const url = new URL(request.url)
      const m = url.pathname.match(SLUG_RE)
      if (!m) return resposta

      const slug = m[1].toLowerCase()
      if (ROTAS_APP.has(slug)) return resposta

      // So mexe em HTML. Imagens, JS, CSS e o sw.js passam direto.
      const tipo = resposta.headers.get('content-type') || ''
      if (!tipo.includes('text/html')) return resposta

      const loja = await buscarLoja(env, slug, ctx)
      if (!loja) return resposta

      return injetarTags(resposta, loja, url)
    } catch {
      return resposta
    }
  },
}

// Busca a loja pelo slug, com cache na borda (inclusive quando nao acha, pra
// nao bater no banco toda vez que alguem abre uma rota que nao e loja).
async function buscarLoja(env, slug, ctx) {
  const base = env.SUPABASE_URL
  const chave = env.SUPABASE_ANON_KEY
  if (!base || !chave) return null

  const cache = caches.default
  const chaveCache = new Request(`https://og-cache.fwcinter.com/loja/${slug}`)

  const guardado = await cache.match(chaveCache)
  if (guardado) {
    const j = await guardado.json()
    return j && j.nome ? j : null
  }

  // `or` pra pegar tambem o link que a loja ja teve e trocou (slugs_antigos):
  // link velho compartilhado no WhatsApp continua com a previa certa.
  const s = encodeURIComponent(slug)
  const alvo =
    `${base}/rest/v1/empresas` +
    `?or=(slug.eq.${s},slugs_antigos.cs.{${s}})` +
    `&select=nome,descricao,logo_url,banner_url` +
    `&limit=1`

  const r = await fetch(alvo, {
    headers: { apikey: chave, Authorization: `Bearer ${chave}`, Accept: 'application/json' },
  })
  if (!r.ok) return null

  const linhas = await r.json()
  const loja = Array.isArray(linhas) && linhas[0] ? linhas[0] : {}

  const guardar = new Response(JSON.stringify(loja), {
    headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SEG}` },
  })
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(chaveCache, guardar))

  return loja.nome ? loja : null
}

function injetarTags(resposta, loja, url) {
  const nome = String(loja.nome || '').trim()
  const descricao =
    String(loja.descricao || '').trim() ||
    `Peça pelo cardápio online do ${nome} — entrega e retirada.`

  // og:image precisa ser um endereco que o robo consiga BAIXAR. Logo gravada
  // como data:image/...;base64 nao serve — nesse caso e melhor nao mandar tag
  // nenhuma do que mandar uma quebrada.
  const imagem = primeiraImagemValida([loja.logo_url, loja.banner_url])

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(nome)}" />`,
    `<meta property="og:title" content="${esc(nome)}" />`,
    `<meta property="og:description" content="${esc(descricao)}" />`,
    `<meta property="og:url" content="${esc(url.toString())}" />`,
    `<meta property="og:locale" content="pt_BR" />`,
    `<meta name="description" content="${esc(descricao)}" />`,
    `<meta name="twitter:title" content="${esc(nome)}" />`,
    `<meta name="twitter:description" content="${esc(descricao)}" />`,
  ]

  if (imagem) {
    tags.push(
      `<meta property="og:image" content="${esc(imagem)}" />`,
      `<meta property="og:image:width" content="800" />`,
      `<meta property="og:image:height" content="800" />`,
      `<meta property="og:image:alt" content="${esc(nome)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${esc(imagem)}" />`,
    )
  } else {
    tags.push(`<meta name="twitter:card" content="summary" />`)
  }

  return new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(nome)
      },
    })
    .on('head', {
      element(el) {
        el.append(tags.join('\n    '), { html: true })
      },
    })
    .transform(resposta)
}

function primeiraImagemValida(lista) {
  for (const u of lista) {
    const s = String(u || '').trim()
    if (s.startsWith('https://')) return s
  }
  return null
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
