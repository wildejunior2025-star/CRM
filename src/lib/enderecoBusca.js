// Busca de endereço pelo NOME DA RUA (igual à Loja Online): sugere as ruas, acha o
// ponto no mapa e devolve bairro/cidade/CEP. Usado pelo modal de endereço do app.
//
// A lógica de busca é a mesma do DeliveryCheckout (ViaCEP ao contrário + OpenStreetMap
// no estado inteiro). Fica aqui, separada, pra não mexer no checkout que está no ar.

export const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']

// O Nominatim é gratuito, limita 1 consulta por segundo e às vezes não responde.
// Sem tempo limite a busca fica pendurada.
async function buscarJson(url, ms = 5000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'CRM-FWC/1.0' }, signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

const limpa = t => String(t ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

const TIPO_LOGRADOURO = /^(r|rua|av|avn|avenida|trav|travessa|al|alameda|pc|praca|rod|rodovia|estr|estrada|beco|conj|conjunto|lot|loteamento|vl|vila)\.?\s+/i

export const semTipoLogradouro = t => String(t ?? '').replace(TIPO_LOGRADOURO, '').trim()

// Tolerante de propósito: "Nossa Senhora da Apresentação" x "Nossa Sra. da Apresentação".
// Faltando um dos lados, responde SIM — ausência de informação não desmente nada.
function mesmoLugar(a, b) {
  const x = limpa(semTipoLogradouro(a)), y = limpa(semTipoLogradouro(b))
  if (!x || !y) return true
  return x.includes(y) || y.includes(x)
}

// Quantas palavras do que o cliente digitou aparecem no nome da rua.
function pontosDaRua(nomeRua, termo) {
  const alvo = limpa(nomeRua)
  const palavras = limpa(termo).split(' ').filter(w => w.length >= 3)
  if (!palavras.length) return 0
  return palavras.filter(w => alvo.includes(w)).length
}
function ruaCasouInteira(nomeRua, termo) {
  const palavras = limpa(termo).split(' ').filter(w => w.length >= 3)
  return palavras.length > 0 && pontosDaRua(nomeRua, termo) === palavras.length
}

// Rua no ESTADO INTEIRO pelo OpenStreetMap: devolve em que cidade e bairro ela fica,
// que é a pergunta de quem mora na cidade vizinha.
async function buscarRuaNoEstado(uf, termo) {
  if (!uf || !termo || termo.length < 3) return []
  const params = new URLSearchParams({
    street: termo, state: uf, country: 'Brazil',
    format: 'json', addressdetails: '1', limit: '8',
  })
  const d = await buscarJson(`https://nominatim.openstreetmap.org/search?${params}`, 6000)
  if (!Array.isArray(d)) return []
  return d.map(x => {
    const a = x.address ?? {}
    return {
      logradouro: a.road ?? a.pedestrian ?? a.footway ?? '',
      bairro:     a.suburb ?? a.neighbourhood ?? a.city_district ?? '',
      localidade: a.city ?? a.town ?? a.municipality ?? a.village ?? '',
      uf,
      cep:        String(a.postcode ?? '').replace(/[^0-9]/g, ''),
    }
  }).filter(r => r.logradouro && r.localidade)
}

// Sugestões de rua pelo nome. `cidades` = cidades conhecidas do cliente (opcional);
// sem elas, procura só no estado inteiro.
export async function buscarRuas({ termo, uf, cidades = [] }) {
  const t = String(termo ?? '').trim()
  if (t.length < 3 || !uf) return []
  // A busca do ViaCEP é literal: "Rua Eliane Barros" não acha "Rua Doutora Eliane
  // Barros". Tira o tipo do logradouro e, não achando, tenta a maior palavra.
  const semTipo = semTipoLogradouro(t)
  const maior = semTipo.split(/\s+/).filter(w => w.length >= 4).sort((x, y) => y.length - x.length)[0]
  const viacep = async (q, cidade) => {
    if (!q || q.length < 3 || !cidade) return []
    try {
      const r = await fetch(`https://viacep.com.br/ws/${uf}/${encodeURIComponent(cidade)}/${encodeURIComponent(q)}/json/`)
      const j = await r.json()
      return Array.isArray(j) ? j : []
    } catch { return [] }
  }
  const alvos = [...new Set(cidades.filter(c => c && c.length >= 3))].slice(0, 4)
  let d = (await Promise.all(alvos.map(c => viacep(semTipo || t, c)))).flat()
  if (!d.length && maior) d = (await Promise.all(alvos.map(c => viacep(maior, c)))).flat()
  // O estado inteiro entra sempre que NENHUMA rua casou com tudo o que ele escreveu:
  // lista com a rua errada dentro é pior que lista vazia.
  if (!d.some(x => ruaCasouInteira(x.logradouro, semTipo || t))) {
    d = [...d, ...(await buscarRuaNoEstado(uf, semTipo || t))]
  }
  // Sem repetir a mesma rua em CEPs diferentes (numa avenida longa o ViaCEP devolve dezenas).
  const vistas = new Set()
  const lista = d.filter(x => {
    const k = `${x.logradouro}|${x.bairro}|${x.localidade}`
    if (vistas.has(k)) return false
    vistas.add(k)
    return !!x.logradouro
  })
  lista.sort((a, b) => pontosDaRua(b.logradouro, semTipo || t) - pontosDaRua(a.logradouro, semTipo || t))
  return lista.slice(0, 8)
}

// Ponto da RUA no mapa (o número vem depois). O Nominatim quase nunca diz "não achei":
// devolve rua de nome parecido em outro canto da cidade. Por isso o ponto só vale se a
// rua e a cidade que vieram com ele baterem com o que foi escolhido.
export async function geocodeRua({ rua, bairro, cidade, estado, cep } = {}) {
  const confere = d => {
    const it = d?.[0]
    if (!it) return null
    const a = it.address
    if (a) {
      const ruaOsm = a.road ?? a.pedestrian ?? a.footway ?? ''
      const cidadeOsm = a.city ?? a.town ?? a.municipality ?? a.village ?? ''
      if (rua && ruaOsm && !mesmoLugar(rua, ruaOsm)) return null
      if (cidade && cidadeOsm && !mesmoLugar(cidade, cidadeOsm)) return null
    }
    return { lat: parseFloat(it.lat), lng: parseFloat(it.lon) }
  }
  const cepLimpo = String(cep || '').replace(/\D/g, '')
  if (cepLimpo.length === 8) {
    const params = new URLSearchParams({
      street: rua || '', city: cidade || '', state: estado || '', postalcode: cepLimpo,
      country: 'Brazil', format: 'json', limit: '1', addressdetails: '1',
    })
    const c = confere(await buscarJson(`https://nominatim.openstreetmap.org/search?${params}`))
    if (c) return c
  }
  const q = [rua, bairro, cidade, estado].filter(s => s && String(s).trim()).join(', ')
  const c = confere(await buscarJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Brasil')}&format=json&limit=1&addressdetails=1`))
  if (c) return c
  // O Nominatim engasga com mais de 1 consulta por segundo: uma repetida depois de 1,2s costuma passar.
  await new Promise(r => setTimeout(r, 1200))
  return confere(await buscarJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Brasil')}&format=json&limit=1&addressdetails=1`))
}

// Centro da cidade — só pra abrir o mapa no lugar certo quando a rua não foi achada.
export async function geocodeCidade({ cidade, estado } = {}) {
  if (!cidade) return null
  const q = [cidade, estado, 'Brasil'].filter(Boolean).join(', ')
  const d = await buscarJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`)
  return d?.[0] ? { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) } : null
}

// Do ponto arrastado de volta pro endereço (rua, bairro, cidade, CEP).
export async function reverseGeocode(lat, lng) {
  const d = await buscarJson(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`)
  const a = d?.address
  if (!a) return null
  return {
    rua: a.road || a.pedestrian || a.footway || '',
    bairro: a.suburb || a.neighbourhood || a.village || a.quarter || '',
    cidade: a.city || a.town || a.municipality || a.county || '',
    estado: String(a['ISO3166-2-lvl4'] || '').split('-')[1] || '',
    cep: String(a.postcode || '').replace(/\D/g, ''),
  }
}
