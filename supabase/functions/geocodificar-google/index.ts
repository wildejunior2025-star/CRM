// Geocodificador do Google — SO quando o mapa gratis e o CEP nao acham a rua.
//
// A chave fica aqui, no servidor (secret GOOGLE_MAPS_KEY). No navegador qualquer
// um copiaria e gastaria por nos. Sem a chave configurada a funcao responde
// "sem_chave" e o gestor segue pelo caminho de antes (CEP, depois centro do bairro).
//
// Custo: o mesmo endereco nao paga duas vezes (cache de 30 dias) e cada loja tem
// um teto de consultas por dia. Alem disso, ponha um limite de gasto no painel
// do Google Cloud.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GOOGLE_KEY   = Deno.env.get('GOOGLE_MAPS_KEY') ?? ''
const TETO_DIA_POR_LOJA = 150
const DIAS_CACHE = 30

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

const LIMITE_DIA_TOTAL = 330

/**
 * A FOTO DO MAPA COM O PINO (25/10/2026).
 *
 * O atendente do balcão digita o endereço de uma casa que ele nunca viu — não
 * tem como saber se o ponto caiu certo. Mas ele reconhece o ERRO GRANDE: "isso
 * aí tá no Alecrim e o cliente falou Potengi". É pra isso que serve a foto.
 *
 * Vem pelo servidor, em base64, e não como URL: no <img src> a chave iria junto
 * e qualquer um copiaria do código-fonte da página.
 *
 * Mapa estático é o SKU barato do Google (US$ 2 por mil, com 10 mil grátis por
 * mês) — o mapa que arrasta custa US$ 7 e não serviria aqui, porque arrastar no
 * chute é pior que não arrastar.
 *
 * Se a chave não liberar o Static Maps, devolve null e a tela segue sem a foto:
 * o aviso de precisão sozinho já pega a maior parte dos erros.
 */
async function fotoDoMapa(lat: number, lng: number): Promise<string | null> {
  try {
    const url = 'https://maps.googleapis.com/maps/api/staticmap?' + new URLSearchParams({
      center: `${lat},${lng}`, zoom: '17', size: '440x240', scale: '2',
      language: 'pt-BR', region: 'br',
      markers: `color:red|${lat},${lng}`,
      key: GOOGLE_KEY,
    })
    const r = await fetch(url)
    if (!r.ok) { console.warn('[geocode-google] mapa recusado:', r.status, (await r.text()).slice(0, 120)); return null }
    const buf = new Uint8Array(await r.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
    return 'data:image/png;base64,' + btoa(bin)
  } catch (e) {
    console.warn('[geocode-google] mapa falhou:', e)
    return null
  }
}
const EVOLUTION_API_URL = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/$/, '')
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') ?? ''

// deno-lint-ignore no-explicit-any
async function avisarSePassou(supabase: any, hoje: string) {
  const { data: linhas } = await supabase.from('geocode_uso')
    .select('empresa_id, consultas').eq('dia', hoje)
  // deno-lint-ignore no-explicit-any
  const lista = (linhas ?? []) as any[]
  const total = lista.reduce((s, l) => s + (l.consultas ?? 0), 0)
  if (total < LIMITE_DIA_TOTAL) return

  // Primeira vez do dia que passa: a chave (dia) impede mandar de novo.
  const { data: novo } = await supabase.from('geocode_alerta')
    .upsert({ dia: hoje, total }, { onConflict: 'dia', ignoreDuplicates: true }).select('dia')
  if (!novo?.length) return

  const { data: dest } = await supabase.from('config_global').select('valor').eq('chave', 'aviso_fwc_destino').maybeSingle()
  const numero = String(dest?.valor ?? '').replace(/\D/g, '')
  const { data: cfgInst } = await supabase.from('config_global').select('valor').eq('chave', 'admin_sender_instance').maybeSingle()
  const instancia = String(cfgInst?.valor ?? '').trim() || 'crmadmin'
  if (!numero || !EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.warn('[geocode-google] passou de', LIMITE_DIA_TOTAL, 'mas sem como avisar. Total:', total)
    return
  }
  const top = lista.sort((a, b) => (b.consultas ?? 0) - (a.consultas ?? 0)).slice(0, 5)
  const { data: nomes } = await supabase.from('empresas').select('id, nome').in('id', top.map((l) => l.empresa_id))
  // deno-lint-ignore no-explicit-any
  const nomeDe = new Map(((nomes ?? []) as any[]).map((e) => [e.id, e.nome]))
  const porLoja = top.map((l) => `• ${nomeDe.get(l.empresa_id) ?? '?'}: ${l.consultas}`).join('\n')
  const texto = `⚠️ *Google Maps — consumo alto hoje*\n\nJá foram *${total} consultas pagas* hoje (limite de aviso: ${LIMITE_DIA_TOTAL}).\n\n${porLoja}\n\nA cota grátis do Google é por mês (cerca de 330 por dia). Vale olhar se alguma loja está em laço ou se o movimento cresceu.`
  const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
    body: JSON.stringify({ number: numero, text: texto }),
  })
  if (!r.ok) console.error('[geocode-google] Evolution recusou:', (await r.text()).slice(0, 200))
}

// Teto diario da loja + aviso de cota. Devolve false quando a loja ja gastou o
// dia. Virou funcao porque agora sao DOIS caminhos pagos (endereco escrito e
// ponto no mapa) e os dois tem que entrar na mesma conta.
// deno-lint-ignore no-explicit-any
async function cobrarConsulta(supabase: any, empresaId: string): Promise<boolean> {
  const hoje = new Date().toISOString().slice(0, 10)
  const { data: uso } = await supabase.from('geocode_uso')
    .select('consultas').eq('empresa_id', empresaId).eq('dia', hoje).maybeSingle()
  if ((uso?.consultas ?? 0) >= TETO_DIA_POR_LOJA) return false
  await supabase.from('geocode_uso').upsert(
    { empresa_id: empresaId, dia: hoje, consultas: (uso?.consultas ?? 0) + 1 },
    { onConflict: 'empresa_id,dia' })
  // Aviso no WhatsApp do dono da FWC se, somando TODAS as lojas, o dia passar
  // do limite (a cota gratis do Google e por mes, ~330/dia). So fala quando
  // passa, e uma vez por dia; abaixo disso nao manda nada.
  // deno-lint-ignore no-explicit-any
  await avisarSePassou(supabase, hoje).catch((e: any) => console.error('[geocode-google] aviso falhou:', e))
  return true
}

// As partes do endereco, pra tela (ou o robo) preencher os campos sozinha.
//
// Varre TODOS os resultados, nao so o primeiro: no reverso o de cima e a casa
// e vem sem CEP, enquanto o de baixo e o bairro e tem. Pegar so o primeiro
// deixava campo vazio com a resposta ali do lado.
// deno-lint-ignore no-explicit-any
function partesDoEndereco(results: any[]) {
  const de = (tipo: string, curto = false) => {
    for (const r of results) {
      // deno-lint-ignore no-explicit-any
      const c = ((r?.address_components ?? []) as any[]).find((x) => (x.types ?? []).includes(tipo))
      if (c) return String(curto ? c.short_name : c.long_name)
    }
    return ''
  }
  return {
    rua:    de('route'),
    numero: de('street_number'),
    bairro: de('sublocality_level_1') || de('sublocality') || de('neighborhood'),
    cidade: de('administrative_area_level_2') || de('locality'),
    estado: de('administrative_area_level_1', true),
    cep:    de('postal_code').replace(/\D/g, ''),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
    const b = await req.json().catch(() => ({}))

    // Quem chama tem que ser alguem LOGADO numa loja — a chave publica (anon)
    // sozinha nao basta, senao qualquer pagina gastaria a nossa cota.
    //
    // A EXCECAO e o nosso proprio servidor. O robo do WhatsApp atende sem
    // ninguem logado — quem fala com ele e o cliente, pelo celular dele — e
    // tambem precisa do Google pra achar a rua. Ele se identifica com a chave
    // de servico, que nunca sai do servidor, e diz de qual loja e a consulta
    // (senao o teto diario e o aviso de cota nao teriam dono).
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    let empresaId: string | undefined
    if (token && token === SERVICE_KEY) {
      empresaId = String(b.empresa_id ?? '').trim() || undefined
      if (!empresaId) return json({ ok: false, erro: 'sem_loja' }, 403)
    } else {
      const { data: u } = await supabase.auth.getUser(token)
      const { data: perfil } = u?.user
        ? await supabase.from('profiles').select('empresa_id').eq('id', u.user.id).maybeSingle()
        : { data: null }
      empresaId = perfil?.empresa_id as string | undefined

      // O CLIENTE TAMBEM PRECISA ACHAR A PROPRIA RUA (25/10/2026)
      //
      // Ate aqui so entrava funcionario de loja (crachao) ou o servidor. Mas
      // quem mais erra endereco e justamente quem digita o proprio: no link do
      // catalogo o cliente nem esta logado, e no app ele tem conta de CLIENTE,
      // que por definicao nao pertence a loja nenhuma. Os dois levavam 403 e
      // ficavam no mapa gratis, que e o que troca a rua e perde a entrega.
      //
      // Agora a pagina diz de qual loja e o pedido (ela ja sabe) e a consulta
      // passa a ter dono. O freio contra abuso continua sendo o mesmo de
      // sempre: o teto diario POR LOJA, que limita o estrago de uma pagina
      // publica a 150 consultas. Loja de verdade usa 24 no pico.
      if (!empresaId) {
        const daPagina = String(b.empresa_id ?? '').trim()
        if (!daPagina) return json({ ok: false, erro: 'sem_loja' }, 403)
        const { data: loja } = await supabase.from('empresas')
          .select('id').eq('id', daPagina).maybeSingle()
        if (!loja) return json({ ok: false, erro: 'sem_loja' }, 403)
        empresaId = loja.id as string
      }
    }

    if (!GOOGLE_KEY) return json({ ok: false, erro: 'sem_chave' })

    // ── SUGERIR ENDEREÇO ENQUANTO DIGITA (igual ao iFood) ────────────────────
    //
    // O Autocomplete do Google entende o endereço do jeito que a pessoa fala:
    // "av nascimento de castro 81" devolve "Av. Nascimento de Castro, 81 —
    // Lagoa Nova, Natal - RN". A busca dos Correios, que a tela usava, é
    // literal: procurava isso tudo como NOME de rua e trazia Vila Nascimento,
    // Travessa Nascimento... qualquer coisa menos a avenida (Agv, 25/10/2026).
    // E o Autocomplete ainda acha por NOME DE LUGAR — "escola hipócrates".
    //
    // SKU barato: US$ 2,83 por mil com 10 mil grátis por mês, e só dispara
    // depois que a pessoa para de digitar.
    if (b.acao === 'sugerir') {
      const texto = String(b.texto ?? '').trim()
      if (texto.length < 4) return json({ ok: true, sugestoes: [] })
      const corpo: Record<string, unknown> = {
        input: texto,
        languageCode: 'pt-BR',
        regionCode: 'BR',
        includedRegionCodes: ['br'],
      }
      // Puxa pro lado da loja: "Rua São José" existe em toda cidade do Brasil.
      if (Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lng))) {
        corpo.locationBias = {
          circle: { center: { latitude: Number(b.lat), longitude: Number(b.lng) }, radius: 30000 },
        }
      }
      const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
        },
        body: JSON.stringify(corpo),
      })
      if (!r.ok) {
        const t = (await r.text()).slice(0, 900)
        console.warn('[geocode-google] autocomplete recusou:', r.status, t)
        // 403 = a API "Places API (New)" não está ligada no projeto do Google.
        return json({ ok: false, erro: r.status === 403 ? 'places_desligado' : 'autocomplete_falhou', detalhe: t })
      }
      const d = await r.json()
      // deno-lint-ignore no-explicit-any
      const sug = ((d?.suggestions ?? []) as any[])
        .map((s) => s?.placePrediction)
        .filter(Boolean)
        .slice(0, 6)
        .map((p: Record<string, any>) => ({
          place_id: p.placeId,
          titulo: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
          detalhe: p.structuredFormat?.secondaryText?.text ?? '',
        }))
        .filter((s: { titulo: string }) => s.titulo)
      return json({ ok: true, sugestoes: sug })
    }

    // ── PONTO NO MAPA → ENDERECO ESCRITO (reverso) ─────────────────────
    //
    // E o caminho do pininho do WhatsApp: o cliente toca em "minha
    // localizacao" e o robo precisa saber que rua e aquela, porque o GPS manda
    // ponto, nao endereco. O mapa gratis erra justamente onde o nosso cliente
    // mora — conjunto novo, loteamento recente — e devolve a rua vizinha ou
    // nem o bairro, e aquele texto errado e o que o motoboy le.
    //
    // Mesmo SKU do Geocoding (reverso custa igual), entao entra no mesmo teto
    // e no mesmo cache.
    if (b.acao === 'reverso') {
      const lat = Number(b.lat), lng = Number(b.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ ok: false, erro: 'sem_ponto' }, 400)
      // 5 casas decimais ≈ 1 metro: o mesmo pino nao paga duas vezes.
      const chave = `rev:${lat.toFixed(5)},${lng.toFixed(5)}`
      const corte = new Date(Date.now() - DIAS_CACHE * 86400_000).toISOString()
      const { data: cache } = await supabase.from('geocode_cache')
        .select('precisao, formatado, partes').eq('chave', chave).gte('created_at', corte).maybeSingle()
      if (cache) {
        return json({ ok: true, lat, lng, precisao: cache.precisao, formatado: cache.formatado, partes: cache.partes ?? null, cache: true })
      }
      if (!await cobrarConsulta(supabase, empresaId)) return json({ ok: false, erro: 'teto_diario' })
      const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?' + new URLSearchParams({
        latlng: `${lat},${lng}`, language: 'pt-BR', key: GOOGLE_KEY,
      }))
      const g = await r.json()
      if (g.status !== 'OK' || !g.results?.length) {
        console.log('[geocode-google] reverso sem resultado:', g.status, lat, lng)
        return json({ ok: false, erro: g.status === 'ZERO_RESULTS' ? 'nao_achou' : (g.status ?? 'falhou') })
      }
      const res0 = g.results[0]
      const partes = partesDoEndereco(g.results)
      const precisao = String(res0.geometry?.location_type ?? '')
      await supabase.from('geocode_cache').upsert(
        { chave, lat, lng, precisao, formatado: res0.formatted_address ?? null, partes, created_at: new Date().toISOString() },
        { onConflict: 'chave' })
      return json({ ok: true, lat, lng, precisao, formatado: res0.formatted_address ?? null, partes })
    }

    const rua = String(b.rua ?? '').trim()
    const placeId = String(b.place_id ?? '').trim()
    if (!rua && !placeId) return json({ ok: false, erro: 'sem_rua' }, 400)
    const partes = [rua, b.numero, b.bairro, b.cidade, b.estado].map(v => String(v ?? '').trim()).filter(Boolean)
    // Endereco escolhido na lista do Google ja vem com identidade propria: a
    // chave e o place_id, que e o mesmo pra qualquer jeito de escrever a rua.
    const chave = placeId ? 'place:' + placeId : norm(partes.join('|'))

    // Ja pagamos por este endereco? (30 dias)
    const corte = new Date(Date.now() - DIAS_CACHE * 86400_000).toISOString()
    const { data: cache } = await supabase.from('geocode_cache')
      .select('lat, lng, precisao, formatado, partes').eq('chave', chave).gte('created_at', corte).maybeSingle()
    if (cache) {
      // A foto não entra no cache do banco (base64 pesa e o Google não deixa
      // guardar imagem). Endereço repetido não paga a BUSCA de novo; a foto
      // sim, e é o SKU barato.
      const foto = b.mapa === true ? await fotoDoMapa(cache.lat, cache.lng) : null
      // As PARTES vao junto (mig 0392). Sem elas, endereco repetido vinha do
      // cache so com o ponto e a tela nao preenchia bairro, cidade e CEP — o
      // atendente tinha que digitar tudo de novo justamente no caso mais comum,
      // que e o cliente que ja comprou antes.
      return json({ ok: true, lat: cache.lat, lng: cache.lng, precisao: cache.precisao, formatado: cache.formatado, mapa: foto, partes: cache.partes ?? null, cache: true })
    }

    if (!await cobrarConsulta(supabase, empresaId)) return json({ ok: false, erro: 'teto_diario' })

    const endereco = partes.join(', ')
    // Com place_id nao ha o que adivinhar: o Google devolve exatamente aquele
    // lugar, com rua, numero, bairro, cidade e CEP separados.
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?' + new URLSearchParams(
      placeId
        ? { place_id: placeId, language: 'pt-BR', key: GOOGLE_KEY }
        : { address: endereco, region: 'br', language: 'pt-BR', components: 'country:BR', key: GOOGLE_KEY },
    )
    const r = await fetch(url)
    const g = await r.json()
    if (g.status !== 'OK' || !g.results?.length) {
      console.log('[geocode-google] sem resultado:', g.status, endereco)
      return json({ ok: false, erro: g.status === 'ZERO_RESULTS' ? 'nao_achou' : (g.status ?? 'falhou') })
    }
    const res = g.results[0]
    const lat = res.geometry?.location?.lat
    const lng = res.geometry?.location?.lng
    if (typeof lat !== 'number' || typeof lng !== 'number') return json({ ok: false, erro: 'sem_ponto' })
    const precisao = String(res.geometry?.location_type ?? '')

    // O Google ignora o bairro quando a rua se repete na cidade (Rua São José dá
    // o MESMO ponto em 3 bairros). Só dá o bairro como confirmado se ele aparece
    // no endereço devolvido; senão o gestor trata como aproximado.
    const bairro = norm(b.bairro)
    const textos = [res.formatted_address, ...(res.address_components ?? []).map((c: { long_name?: string }) => c.long_name)]
    // Escolhido na lista do Google, o bairro e o DELE: nao ha o que conferir
    // contra o que o atendente tinha digitado (ele nem digitou ainda).
    const bairroConfere = !!placeId || !bairro || textos.some(t => norm(t).includes(bairro))

    const endereco_partes = partesDoEndereco([res])

    const precisaoFinal = bairroConfere ? precisao : 'BAIRRO_NAO_CONFERE'
    await supabase.from('geocode_cache').upsert(
      { chave, lat, lng, precisao: precisaoFinal, formatado: res.formatted_address ?? null, partes: endereco_partes, created_at: new Date().toISOString() },
      { onConflict: 'chave' })
    const foto = b.mapa === true ? await fotoDoMapa(lat, lng) : null
    return json({ ok: true, lat, lng, precisao: precisaoFinal, formatado: res.formatted_address ?? null, mapa: foto, partes: endereco_partes })
  } catch (e) {
    console.error('[geocode-google] erro:', e)
    return json({ ok: false, erro: 'erro_interno' }, 500)
  }
})
