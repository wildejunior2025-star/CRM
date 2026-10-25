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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

    // Quem chama tem que ser alguem LOGADO numa loja — a chave publica (anon)
    // sozinha nao basta, senao qualquer pagina gastaria a nossa cota.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: u } = await supabase.auth.getUser(token)
    if (!u?.user) return json({ ok: false, erro: 'nao_autenticado' }, 401)
    const { data: perfil } = await supabase.from('profiles')
      .select('empresa_id').eq('id', u.user.id).maybeSingle()
    const empresaId = perfil?.empresa_id as string | undefined
    if (!empresaId) return json({ ok: false, erro: 'sem_loja' }, 403)

    if (!GOOGLE_KEY) return json({ ok: false, erro: 'sem_chave' })

    const b = await req.json().catch(() => ({}))
    const rua = String(b.rua ?? '').trim()
    if (!rua) return json({ ok: false, erro: 'sem_rua' }, 400)
    const partes = [rua, b.numero, b.bairro, b.cidade, b.estado].map(v => String(v ?? '').trim()).filter(Boolean)
    const chave = norm(partes.join('|'))

    // Ja pagamos por este endereco? (30 dias)
    const corte = new Date(Date.now() - DIAS_CACHE * 86400_000).toISOString()
    const { data: cache } = await supabase.from('geocode_cache')
      .select('lat, lng, precisao, formatado').eq('chave', chave).gte('created_at', corte).maybeSingle()
    if (cache) {
      // A foto não entra no cache do banco (base64 pesa e o Google não deixa
      // guardar imagem). Endereço repetido não paga a BUSCA de novo; a foto
      // sim, e é o SKU barato.
      const foto = b.mapa === true ? await fotoDoMapa(cache.lat, cache.lng) : null
      return json({ ok: true, lat: cache.lat, lng: cache.lng, precisao: cache.precisao, formatado: cache.formatado, mapa: foto, cache: true })
    }

    // Teto diario da loja.
    const hoje = new Date().toISOString().slice(0, 10)
    const { data: uso } = await supabase.from('geocode_uso')
      .select('consultas').eq('empresa_id', empresaId).eq('dia', hoje).maybeSingle()
    if ((uso?.consultas ?? 0) >= TETO_DIA_POR_LOJA) return json({ ok: false, erro: 'teto_diario' })
    await supabase.from('geocode_uso').upsert(
      { empresa_id: empresaId, dia: hoje, consultas: (uso?.consultas ?? 0) + 1 },
      { onConflict: 'empresa_id,dia' })

    // Aviso no WhatsApp do dono da FWC se, somando TODAS as lojas, o dia passar do
    // limite (a cota grátis do Google é por mês, ~330/dia). Só fala quando passa,
    // e uma vez por dia; abaixo disso não manda nada.
    await avisarSePassou(supabase, hoje).catch((e) => console.error('[geocode-google] aviso falhou:', e))

    const endereco = partes.join(', ')
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?' + new URLSearchParams({
      address: endereco, region: 'br', language: 'pt-BR', components: 'country:BR', key: GOOGLE_KEY,
    })
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
    const bairroConfere = !bairro || textos.some(t => norm(t).includes(bairro))

    const precisaoFinal = bairroConfere ? precisao : 'BAIRRO_NAO_CONFERE'
    await supabase.from('geocode_cache').upsert(
      { chave, lat, lng, precisao: precisaoFinal, formatado: res.formatted_address ?? null, created_at: new Date().toISOString() },
      { onConflict: 'chave' })
    const foto = b.mapa === true ? await fotoDoMapa(lat, lng) : null
    return json({ ok: true, lat, lng, precisao: precisaoFinal, formatado: res.formatted_address ?? null, mapa: foto })
  } catch (e) {
    console.error('[geocode-google] erro:', e)
    return json({ ok: false, erro: 'erro_interno' }, 500)
  }
})
