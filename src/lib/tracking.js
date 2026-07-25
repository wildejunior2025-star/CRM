// Rastreamento de anúncios da Loja Online (Google Ads + Pixel da Meta).
//
// Como funciona
// -------------
// Cada loja tem os IDs DELA salvos em `empresas` (migration 0119). Ao abrir a
// vitrine, `iniciarTags(loja)` injeta os scripts daquela loja e só dela. Loja
// sem ID configurado não carrega script nenhum — nada de terceiro entra na
// página de quem não anuncia.
//
// O que cada plataforma recebe
// ----------------------------
// Google Ads: page view (remarketing, automático pelo config) + a conversão de
//   compra. Só isso — o Google Ads otimiza pela conversão, eventos de meio de
//   funil viram ruído na conta.
// Meta: funil inteiro (PageView, ViewContent, AddToCart, InitiateCheckout,
//   Purchase). O Pixel usa esses eventos pra montar público e otimizar entrega.
//
// A compra dispara na tela de acompanhamento do pedido (DeliveryPedido), não no
// checkout: pedido no PIX só conta depois que o Mercado Pago confirma o
// pagamento. Um pedido nunca conta duas vezes (trava em localStorage), mesmo se
// o cliente recarregar a página ou voltar no link depois.

// Consentimento (LGPD)
// --------------------
// Quem carrega o script de terceiro é a plataforma, então o pedido de
// consentimento é responsabilidade nossa e não da loja. O aviso só aparece nas
// lojas que realmente anunciam — loja sem tag não usa cookie de terceiro e não
// tem o que perguntar.
//
// O Google entra em Consent Mode v2: a tag carrega desde o começo, mas em modo
// negado (sem cookie, só um ping anônimo que o Google usa pra estimar a
// conversão). Aceitando, sobe pra concedido. A Meta não tem modo equivalente,
// então o Pixel só carrega depois do aceite.

const MOEDA = 'BRL'
const CHAVE_CONVERSAO = 'fwc_conv_'   // + id do pedido
const CHAVE_CONSENT = 'fwc_consent_'  // + id da loja (cada loja é um anunciante diferente)

// Estado do módulo: a Loja Online é SPA, então os scripts sobrevivem à
// navegação entre vitrine → checkout → pedido. Guardamos o que já foi injetado
// pra não carregar duas vezes.
const carregado = { google: new Set(), meta: new Set() }

function ehNavegador() {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

/** Injeta um <script src> uma única vez. */
function injetarScript(src) {
  const s = document.createElement('script')
  s.async = true
  s.src = src
  document.head.appendChild(s)
}

function permissoes(aceito) {
  const v = aceito ? 'granted' : 'denied'
  return { ad_storage: v, ad_user_data: v, ad_personalization: v, analytics_storage: v }
}

function iniciarGoogle(adsId, aceito) {
  if (carregado.google.has(adsId)) return
  carregado.google.add(adsId)

  if (!window.dataLayer) window.dataLayer = []
  if (!window.gtag) {
    // Precisa ser `arguments` (o gtag guarda o objeto arguments cru na fila).
    window.gtag = function gtag() { window.dataLayer.push(arguments) }
  }
  // O consentimento padrão tem que ser declarado ANTES de carregar a tag.
  window.gtag('consent', 'default', permissoes(aceito))
  window.gtag('js', new Date())
  injetarScript(`https://www.googletagmanager.com/gtag/js?id=${adsId}`)
  window.gtag('config', adsId)
}

function iniciarMeta(pixelId) {
  if (carregado.meta.has(pixelId)) return
  carregado.meta.add(pixelId)

  if (!window.fbq) {
    // Snippet oficial do Pixel: usa `arguments` cru porque o fbevents.js lê a
    // fila nesse formato depois que carrega.
    const fbq = function () {
      if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments)
      else fbq.queue.push(arguments)
    }
    fbq.push = fbq
    fbq.loaded = true
    fbq.version = '2.0'
    fbq.queue = []
    window.fbq = fbq
    if (!window._fbq) window._fbq = fbq
    injetarScript('https://connect.facebook.net/en_US/fbevents.js')
  }
  window.fbq('init', pixelId)
  window.fbq('track', 'PageView')
}

/**
 * Liga as tags da loja. Chamar quando a loja terminar de carregar.
 * Seguro chamar várias vezes — só injeta na primeira.
 */
export function iniciarTags(loja) {
  if (!ehNavegador() || !loja) return
  const aceito = consentimento(loja) === 'aceito'
  const adsId = (loja.google_ads_id ?? '').trim()
  const pixelId = (loja.meta_pixel_id ?? '').trim()
  if (adsId) iniciarGoogle(adsId, aceito)
  if (pixelId && aceito) iniciarMeta(pixelId)
}

/** Loja está com algum rastreamento ligado? */
export function temTags(loja) {
  return Boolean((loja?.google_ads_id ?? '').trim() || (loja?.meta_pixel_id ?? '').trim())
}

/** 'aceito' | 'recusado' | null (ainda não respondeu) */
export function consentimento(loja) {
  if (!ehNavegador() || !loja?.id) return null
  try {
    return localStorage.getItem(CHAVE_CONSENT + loja.id)
  } catch {
    return null
  }
}

/** Precisa mostrar o aviso? Só em loja que anuncia e cliente que não respondeu. */
export function precisaPerguntar(loja) {
  return temTags(loja) && consentimento(loja) === null
}

/** Guarda a resposta do cliente e aplica na hora. */
export function registrarConsentimento(loja, aceito) {
  if (!ehNavegador() || !loja?.id) return
  try {
    localStorage.setItem(CHAVE_CONSENT + loja.id, aceito ? 'aceito' : 'recusado')
  } catch {
    // Storage bloqueado: vale só nesta visita.
  }
  if (!aceito) return
  if (window.gtag) window.gtag('consent', 'update', permissoes(true))
  const pixelId = (loja.meta_pixel_id ?? '').trim()
  if (pixelId) iniciarMeta(pixelId)
}

/** Evento de funil — só a Meta usa (ver comentário do topo). */
function eventoMeta(nome, dados) {
  if (!ehNavegador() || !window.fbq || !carregado.meta.size) return
  window.fbq('track', nome, dados)
}

export function verProduto(produto) {
  eventoMeta('ViewContent', {
    content_type: 'product',
    content_ids: [String(produto?.id ?? '')],
    content_name: produto?.nome ?? '',
    value: Number(produto?.preco ?? 0),
    currency: MOEDA,
  })
}

export function adicionarAoCarrinho(produto, precoUnit) {
  eventoMeta('AddToCart', {
    content_type: 'product',
    content_ids: [String(produto?.id ?? '')],
    content_name: produto?.nome ?? '',
    value: Number(precoUnit ?? produto?.preco ?? 0),
    currency: MOEDA,
  })
}

export function iniciarCheckout(itens, valor) {
  const lista = itens ?? []
  eventoMeta('InitiateCheckout', {
    content_type: 'product',
    content_ids: lista.map(i => String(i.id)),
    num_items: lista.reduce((s, i) => s + Number(i.quantidade ?? 1), 0),
    value: Number(valor ?? 0),
    currency: MOEDA,
  })
}

/**
 * Conversão de compra. Manda pro Google Ads e pra Meta.
 * Trava por pedido: chamar de novo com o mesmo id não conta outra vez.
 */
export function registrarCompra({ pedidoId, valor, itens, loja }) {
  if (!ehNavegador() || !pedidoId) return false

  const chave = CHAVE_CONVERSAO + pedidoId
  try {
    if (localStorage.getItem(chave)) return false
    localStorage.setItem(chave, '1')
  } catch {
    // Navegador com storage bloqueado (aba anônima travada): deixa passar. Pior
    // caso é contar duas vezes se recarregar — melhor que não contar nunca.
  }

  const total = Number(valor ?? 0)
  const lista = itens ?? []

  const adsId = (loja?.google_ads_id ?? '').trim()
  const label = (loja?.google_ads_label ?? '').trim()
  if (adsId && label && window.gtag) {
    window.gtag('event', 'conversion', {
      send_to: `${adsId}/${label}`,
      value: total,
      currency: MOEDA,
      transaction_id: String(pedidoId),
    })
  }

  if (window.fbq && carregado.meta.size) {
    window.fbq('track', 'Purchase', {
      content_type: 'product',
      content_ids: lista.map(i => String(i.produto_id ?? i.id ?? '')),
      num_items: lista.reduce((s, i) => s + Number(i.quantidade ?? 1), 0),
      value: total,
      currency: MOEDA,
    }, { eventID: String(pedidoId) })   // eventID evita duplicar se um dia entrar API de Conversões
  }

  return true
}
