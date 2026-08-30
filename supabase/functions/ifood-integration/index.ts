// Versão fixa: o "@2" hoje cai na 2.112.2, que está quebrada no esm.sh
// (postgrest-js 404) e faz o deploy falhar no bundle.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0"

// =====================================================================
// ifood-integration
// ---------------------------------------------------------------------
// acao: "poll"   -> varre empresas com iFood ativo, busca eventos no iFood,
//                   grava os pedidos novos em pedidos_delivery (origem=ifood)
//                   e dá acknowledge nos eventos. Chamado pelo cron (30s).
// acao: "status" -> { pedido_id, novo_status }. Devolve o status pro iFood
//                   (confirm / dispatch / readyToPickup / cancel). Chamado
//                   pelo /painel quando o lojista avança o pedido.
// acao: "test"   -> { empresa_id }. Testa as credenciais (autentica) e
//                   devolve ok/erro. Usado pelo botão "Testar conexão".
// acao: "detectar_merchant" -> { empresa_id }. Descobre o Merchant ID da loja
//                   lendo as lojas autorizadas dentro do token e liga a
//                   integração sozinho. Botão "Detectar minha loja".
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Host único da Merchant API (loja de teste e produção usam o mesmo host;
// o que muda é o conjunto de credenciais / merchant).
const IFOOD = "https://merchant-api.ifood.com.br"
// Teto por envio: cada produto é um upload de foto + um PUT no iFood, e a
// edge function tem tempo limitado. Acima disso o lojista manda em duas levas.
const LIMITE_ENVIO = 25

type Config = {
  empresa_id: string
  client_id: string | null
  client_secret: string | null
  merchant_id: string | null
  ambiente: string
  ativo: boolean
  polling_ativo: boolean
  access_token: string | null
  token_expira_em: string | null
  auto_criar_produtos?: boolean
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  )

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const acao = body?.acao ?? "poll"

  try {
    if (acao === "poll") return json(await runPoll(sb))
    if (acao === "test") return json(await runTest(sb, body?.empresa_id))
    if (acao === "status") return json(await runStatus(sb, body?.pedido_id, body?.novo_status))
    if (acao === "verify_delivery_code") return json(await runVerifyDeliveryCode(sb, body?.pedido_id, body?.codigo))
    if (acao === "catalogo") return json(await runImportarCatalogo(sb, body?.empresa_id, body?.categoria_ids))
    if (acao === "catalogo_listar") return json(await runCatalogoListar(sb, body?.empresa_id))
    if (acao === "catalogo_pausar") return json(await runCatalogoPausar(sb, body?.empresa_id, body?.item_id, body?.pausar))
    // ── Gerência de cardápio no iFood (homologação módulo Catalog) ──
    if (acao === "catalogo_categorias") return json(await runCatalogoCategorias(sb, body?.empresa_id))
    if (acao === "catalogo_criar_categoria") return json(await runCriarCategoria(sb, body?.empresa_id, body?.nome))
    if (acao === "catalogo_upload_imagem") return json(await runUploadImagem(sb, body?.empresa_id, body?.image))
    if (acao === "catalogo_salvar_item") return json(await runSalvarItem(sb, body?.empresa_id, body?.payload))
    if (acao === "catalogo_enviar_loja") return json(await runEnviarDaLoja(sb, body?.empresa_id, body))
    if (acao === "produto_foto_da_url") return json(await runFotoDaUrl(sb, body?.empresa_id, body?.produto_id, body?.url, body?.image))
    if (acao === "catalogo_fotos_para_ca") return json(await runTrazerFotos(sb, body?.empresa_id))
    if (acao === "catalogo_excluir_por_produto") return json(await runExcluirPorProduto(sb, body?.empresa_id, body?.item_id, body?.product_id))
    if (acao === "catalogo_excluir_categoria") return json(await runExcluirCategoria(sb, body?.empresa_id, body?.categoria_id))
    if (acao === "catalogo_excluir_item") return json(await runExcluirItem(sb, body?.empresa_id, body?.categoria_id, body?.product_id))
    if (acao === "catalogo_itens") return json(await runCatalogoItensCompletos(sb, body?.empresa_id))
    if (acao === "catalogo_pausar_complemento") return json(await runPausarComplemento(sb, body?.empresa_id, body?.option_id, body?.pausar))
    if (acao === "detectar_merchant") return json(await runDetectarMerchant(sb, body?.empresa_id, body?.merchant_id))
    return json({ ok: false, error: `ação desconhecida: ${acao}` }, 400)
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ─────────────────────────────────────────────────────────────────────
// OAuth — token com cache no próprio ifood_config
// ─────────────────────────────────────────────────────────────────────
// Resolve as credenciais: usa as da própria empresa se existirem; senão cai
// nas credenciais padrão da plataforma (tabela ifood_app) — modelo Centralizado
// onde o mesmo app crm-fwc atende todos os clientes.
async function resolverCreds(sb: any, cfg: Config): Promise<{ clientId: string | null; clientSecret: string | null }> {
  let clientId = cfg.client_id
  let clientSecret = cfg.client_secret
  if (!clientId || !clientSecret) {
    const { data: app } = await sb.from("ifood_app").select("client_id, client_secret").eq("id", 1).maybeSingle()
    clientId = clientId || app?.client_id || null
    clientSecret = clientSecret || app?.client_secret || null
  }
  return { clientId, clientSecret }
}

async function getToken(sb: any, cfg: Config): Promise<string> {
  // Reaproveita o token em cache se ainda faltar > 60s pra expirar
  if (cfg.access_token && cfg.token_expira_em) {
    const restante = new Date(cfg.token_expira_em).getTime() - Date.now()
    if (restante > 60_000) return cfg.access_token
  }

  const { clientId, clientSecret } = await resolverCreds(sb, cfg)
  if (!clientId || !clientSecret) throw new Error("sem credenciais iFood (nem da empresa nem padrão)")

  const form = new URLSearchParams()
  form.set("grantType", "client_credentials")
  form.set("clientId", clientId)
  form.set("clientSecret", clientSecret)

  const res = await fetch(`${IFOOD}/authentication/v1.0/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`auth iFood falhou (${res.status}): ${txt.slice(0, 300)}`)
  }
  const data = await res.json()
  const token: string = data.accessToken ?? data.access_token
  const expiresIn: number = data.expiresIn ?? data.expires_in ?? 10800

  await sb.from("ifood_config").update({
    access_token: token,
    token_expira_em: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }).eq("empresa_id", cfg.empresa_id)

  return token
}

// ─────────────────────────────────────────────────────────────────────
// POLL — busca eventos de todas as empresas e grava os pedidos novos
// ─────────────────────────────────────────────────────────────────────
async function runPoll(sb: any) {
  const { data: configs } = await sb
    .from("ifood_config")
    .select("*")
    .eq("ativo", true)
    .eq("polling_ativo", true)

  let totalEventos = 0
  let totalPedidos = 0
  const erros: string[] = []

  for (const cfg of (configs ?? []) as Config[]) {
    // Precisa do merchant_id pra rotear os pedidos pra empresa certa.
    // As credenciais podem vir do padrão da plataforma (resolverCreds).
    if (!cfg.merchant_id) continue
    try {
      const token = await getToken(sb, cfg)

      // 1. Polling de eventos
      const headers: Record<string, string> = { "Authorization": `Bearer ${token}` }
      if (cfg.merchant_id) headers["x-polling-merchants"] = cfg.merchant_id
      const evRes = await fetch(`${IFOOD}/events/v1.0/events:polling`, { headers })

      // 204 = sem eventos novos
      if (evRes.status === 204) {
        await sb.from("ifood_config").update({
          ultimo_polling_em: new Date().toISOString(), ultimo_erro: null,
        }).eq("empresa_id", cfg.empresa_id)
        continue
      }
      if (!evRes.ok) throw new Error(`polling ${evRes.status}: ${(await evRes.text()).slice(0, 200)}`)

      const eventos: any[] = await evRes.json()
      totalEventos += eventos.length

      // 2. Processa cada evento de pedido novo (PLACED)
      for (const ev of eventos) {
        const code = ev.code ?? ev.fullCode
        const orderId = ev.orderId
        if (!orderId) continue
        // Só criamos o pedido no "colocado". Os demais (CFM, DSP, CON, CAN)
        // só atualizam o status do que já existe.
        const full = (ev.fullCode ?? "").toUpperCase()
        if (code === "PLC" || code === "PLACED") {
          const criou = await criarPedidoDoIfood(sb, cfg, token, orderId)
          if (criou) totalPedidos++
        } else if (code === "DDCR" || full === "DELIVERY_DROP_CODE_REQUESTED") {
          // Pedido exige código de confirmação de entrega (F1) — marca pro app
          // do motoqueiro pedir o código do cliente ao concluir. Em pedidos
          // on-demand/POS o iFood manda o código no metadata.CODE (guardamos).
          const cod = ev.metadata?.CODE ?? ev.metadata?.code ?? null
          const upd: Record<string, unknown> = { ifood_requer_codigo: true }
          if (cod) upd.ifood_codigo_entrega = String(cod)
          await sb.from("pedidos_delivery").update(upd).eq("ifood_order_id", orderId)
        } else {
          await atualizarStatusLocal(sb, orderId, code)
        }
      }

      // 3. Acknowledge de TODOS os eventos recebidos (senão repetem)
      if (eventos.length > 0) {
        await fetch(`${IFOOD}/events/v1.0/events/acknowledgment`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(eventos.map((e) => ({ id: e.id }))),
        })
      }

      await sb.from("ifood_config").update({
        ultimo_polling_em: new Date().toISOString(), ultimo_erro: null,
      }).eq("empresa_id", cfg.empresa_id)
    } catch (e) {
      const msg = String(e?.message ?? e)
      erros.push(`${cfg.empresa_id}: ${msg}`)
      await sb.from("ifood_config").update({ ultimo_erro: msg.slice(0, 500) }).eq("empresa_id", cfg.empresa_id)
    }
  }

  return { ok: true, eventos: totalEventos, pedidos_criados: totalPedidos, erros }
}

// ─────────────────────────────────────────────────────────────────────
// Busca detalhes do pedido no iFood e insere em pedidos_delivery
// ─────────────────────────────────────────────────────────────────────
async function criarPedidoDoIfood(sb: any, cfg: Config, token: string, orderId: string): Promise<boolean> {
  // Já existe? (idempotência — o polling pode repetir antes do ack)
  const { data: existente } = await sb
    .from("pedidos_delivery")
    .select("id")
    .eq("ifood_order_id", orderId)
    .maybeSingle()
  if (existente) return false

  const res = await fetch(`${IFOOD}/order/v1.0/orders/${orderId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`detalhe pedido ${orderId} ${res.status}`)
  const o = await res.json()

  const ehEntrega = (o.orderType ?? "DELIVERY") === "DELIVERY"
  const addr = o.delivery?.deliveryAddress ?? {}
  // Coordenadas GPS do cliente (à prova de erro de geocodificação na rota).
  const coord = addr.coordinates ?? {}
  const lat = coord.latitude ?? coord.lat ?? null
  const lng = coord.longitude ?? coord.lng ?? null

  // Itens -> formato usado pelo painel/cupom. Os complementos/adicionais ficam
  // numa lista separada (não mais colados no nome) pra exibir cada um em sua
  // linha, igual o iFood mostra.
  const itens = (o.items ?? []).map((it: any) => {
    const complementos = (it.options ?? [])
      .map((op: any) => ({ nome: op.name, qtd: Number(op.quantity ?? 1) }))
      .filter((c: any) => c.nome)
    return {
      nome: it.name,
      qtd: Number(it.quantity ?? 1),
      quantidade: Number(it.quantity ?? 1),
      preco_unitario: Number(it.unitPrice ?? it.price ?? 0),
      subtotal: Number(it.totalPrice ?? it.price ?? 0),
      observacao: it.observations ?? null,
      complementos,
    }
  })

  // Observação da ENTREGA. O iFood não manda nada em `observations` na raiz do
  // pedido (era o que a gente lia — por isso chegava sempre vazio). O recado do
  // cliente vem espalhado: o ponto de referência em deliveryAddress.reference
  // ("Loja da Yamaha"), o recado da entrega em delivery.observations e, em
  // alguns pedidos, em extraInfo. Junta tudo pro motoboy ver na tela e no cupom.
  const obsPartes = [
    addr.reference ? `Referência: ${addr.reference}` : null,
    o.delivery?.observations ?? null,
    o.extraInfo ?? null,
    o.observations ?? null,
  ]
    .map((s: unknown) => (typeof s === "string" ? s.trim() : null))
    .filter((s): s is string => Boolean(s))
  const observacoes = obsPartes.length ? [...new Set(obsPartes)].join(" · ") : null

  const total = o.total ?? {}
  const { forma, troco, pago: pagoOnline } = mapearPagamento(o.payments)

  // Detalhamento financeiro pra mostrar no gestor igual ao app do iFood:
  // incentivos separados por patrocinador (loja x iFood) + valor pago via iFood.
  const beneficios = Array.isArray(o.benefits) ? o.benefits : []
  let incLoja = 0, incIfood = 0
  for (const b of beneficios) {
    const svs = Array.isArray(b.sponsorshipValues) ? b.sponsorshipValues : []
    if (svs.length) {
      for (const s of svs) {
        const nome = String(s.name ?? s.sponsor ?? "").toUpperCase()
        const val = Number(s.value ?? s.amount ?? 0)
        if (nome.includes("MERCHANT") || nome.includes("LOJA")) incLoja += val
        else incIfood += val
      }
    } else {
      incIfood += Number(b.value ?? b.amount ?? 0)
    }
  }
  const incTotal = Number(total.benefits ?? (incLoja + incIfood))
  // Quem faz a entrega decide de quem é a taxa de entrega:
  //   MERCHANT = motoboy da loja  → o iFood devolve o frete no repasse
  //   IFOOD    = entrega parceira → o frete é do entregador do iFood, a loja não vê esse dinheiro
  // Sem o campo (pedido de retirada, ou payload antigo), o Financeiro cai no
  // ajuste "quem entrega" da loja.
  const entreguePor = String(o.delivery?.deliveredBy ?? "").toUpperCase() || null
  const ifoodValores = {
    itens: Number(total.subTotal ?? 0),
    taxa: Number(total.deliveryFee ?? 0),
    entregue_por: entreguePor,
    entrega_modo: o.delivery?.mode ?? null,
    incentivo_loja: Number(incLoja.toFixed(2)),
    incentivo_ifood: Number(incIfood.toFixed(2)),
    incentivos_total: Number(incTotal.toFixed(2)),
    pago: Number(total.orderAmount ?? 0),
    pago_online: pagoOnline, // true = pago no app; false = cobrar na entrega
  }

  const novo: Record<string, unknown> = {
    empresa_id: cfg.empresa_id,
    origem: "ifood",
    status: "aguardando",
    tipo_entrega: ehEntrega ? "entrega" : "retirada",

    cliente_nome: o.customer?.name ?? "Cliente iFood",
    cliente_telefone: o.customer?.phone?.number ?? o.customer?.phone ?? "—",
    // ID/Localizador que o entregador digita ao ligar no 0800 do iFood (F2)
    ifood_phone_localizer: o.customer?.phone?.localizer ?? null,

    endereco_rua: ehEntrega ? (addr.streetName ?? "Endereço iFood") : "Retirada na loja",
    endereco_numero: ehEntrega ? (addr.streetNumber ?? null) : null,
    // O iFood manda complemento vazio ("") quando não tem — vira null pra não
    // aparecer uma linha em branco no card do entregador.
    endereco_complemento: (typeof addr.complement === "string" ? addr.complement.trim() : "") || null,
    endereco_bairro: addr.neighborhood ?? null,
    endereco_cidade: ehEntrega ? (addr.city ?? "—") : "Retirada",
    endereco_lat: ehEntrega ? lat : null,
    endereco_lng: ehEntrega ? lng : null,

    itens,
    subtotal: Number(total.subTotal ?? 0),
    taxa_entrega: Number(total.deliveryFee ?? 0),
    total: Number(total.orderAmount ?? total.subTotal ?? 0),

    forma_pagamento: forma,
    troco_para: troco,

    observacoes,

    ifood_order_id: o.id ?? orderId,
    ifood_display_id: o.displayId ?? null,
    ifood_status: "PLACED",
    ifood_valores: ifoodValores,
    // Horário previsto de entrega que o iFood informa (mostrado pro motoboy)
    entrega_prevista_at: o.delivery?.deliveryDateTime ?? null,
    // Endereço FISCAL do cliente (SINIEF 9/26). O iFood passa a mandar em
    // pedidos de RETIRADA a partir de 03/08/2026. Só usado pra NFC-e — NÃO é o
    // endereço da operação/rota (esse continua em endereco_*). Fica null até lá.
    ifood_billing_address: o.customer?.billingAddress ?? null,
  }

  const { error } = await sb.from("pedidos_delivery").insert(novo)
  if (error) {
    // Corrida: outro polling inseriu primeiro (viola índice único) — ok
    if (String(error.message).includes("uq_pedidos_delivery_ifood_order")) return false
    throw new Error(`insert pedido: ${error.message}`)
  }

  // Opção B (OPCIONAL, off por padrão): preenche o catálogo automaticamente
  // com os itens do pedido que ainda não existem. Só roda se a loja ligou a
  // opção — senão, loja que já tem cardápio ficaria com itens duplicados
  // espelhando o cadastro do iFood. Não trava a criação do pedido se falhar.
  if (cfg.auto_criar_produtos) {
    try {
      for (const it of (o.items ?? [])) {
        await upsertProduto(sb, cfg.empresa_id, {
          nome: it.name,
          preco: it.unitPrice ?? it.price ?? 0,
          categoria: "iFood",
          publicar: false,
        })
      }
    } catch { /* não atrapalha o pedido */ }
  }

  return true
}

// `pago`=true → cliente já pagou (online no app do iFood). `pago`=false → o
// entregador COBRA na entrega (dinheiro/crédito/débito/vale "via loja").
function mapearPagamento(payments: any): { forma: string; troco: number | null; pago: boolean } {
  const methods = payments?.methods ?? []
  // Pago online no app do iFood (prepaid, sem valor pendente pra cobrar)
  if (payments?.prepaid && Number(payments.prepaid) > 0 && (!payments.pending || Number(payments.pending) === 0)) {
    return { forma: "online", troco: null, pago: true }
  }
  const m = methods[0]
  if (!m) return { forma: "online", troco: null, pago: true }
  const tipo = (m.type ?? "").toUpperCase()
  if (tipo === "ONLINE" || tipo === "PREPAID") return { forma: "online", troco: null, pago: true }

  // PENDING = cobrar na entrega (maquininha/dinheiro do entregador)
  const metodo = (m.method ?? "").toUpperCase()
  if (metodo === "CASH") {
    const changeFor = m.cash?.changeFor != null ? Number(m.cash.changeFor) : null
    return { forma: "dinheiro", troco: changeFor && changeFor > 0 ? changeFor : null, pago: false }
  }
  if (metodo === "CREDIT") return { forma: "credito", troco: null, pago: false }
  if (metodo === "DEBIT") return { forma: "debito", troco: null, pago: false }
  if (metodo === "MEAL_VOUCHER" || metodo === "FOOD_VOUCHER") return { forma: "vale", troco: null, pago: false }
  return { forma: "outro", troco: null, pago: false }
}

// ─────────────────────────────────────────────────────────────────────
// Catálogo: cria produtos no CRM a partir dos itens do iFood
// ─────────────────────────────────────────────────────────────────────
// Garante que a categoria exista na lista de categorias da empresa.
// Devolve o nome da categoria COMO ELA JÁ ESTÁ CADASTRADA aqui, criando se não
// existir. O nome importa: o produto guarda a categoria por texto, e o iFood
// escreve "Almoço" enquanto a loja cadastrou "almoço". Gravar o nome do iFood
// criava um grupo paralelo que não aparecia em lugar nenhum — produto importado
// "sumia" mesmo tendo entrado.
async function ensureCategoria(sb: any, empresaId: string, nome: string): Promise<string> {
  if (!nome) return nome
  const { data } = await sb.from("categorias").select("nome")
    .eq("empresa_id", empresaId).ilike("nome", nome).maybeSingle()
  if (data?.nome) return data.nome
  try { await sb.from("categorias").insert({ empresa_id: empresaId, nome }) } catch { /* corrida/duplicado ok */ }
  return nome
}

// Cria um produto a partir de um item do iFood, se ainda não existir (por nome).
// Retorna true se criou. `publicar` define se aparece na loja online.
// Copia a foto do iFood pro nosso storage.
//
// A URL que o iFood devolve aponta pro servidor DELES: funciona hoje, mas o dia
// em que trocarem o endereço (ou o item sair de lá) o produto fica sem imagem
// no nosso cardápio, no app e na Loja Online. Guardar a cópia deixa o catálogo
// daqui de pé sozinho.
//
// Se o download ou o upload falhar, devolve a URL do iFood mesmo: foto emprestada
// é melhor que produto sem foto, e não vale derrubar a importação por causa disso.
async function guardarFotoLocal(sb: any, empresaId: string, urlIfood: string): Promise<string> {
  try {
    // fetch resolve data-uri também, então imagem em base64 entra pelo mesmo caminho.
    const r = await fetch(urlIfood)
    if (!r.ok) return urlIfood
    const bytes = new Uint8Array(await r.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return urlIfood

    // A extensão sai do content-type, não da URL: endereço sem ".jpg" no fim
    // (link com query, CDN que serve por id) fazia a "extensão" virar um pedaço
    // do domínio — e com barra dentro, criando subpasta no bucket.
    const tipo = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim()
    const ext = ({
      "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
      "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
    } as Record<string, string>)[tipo] ?? "jpg"
    const path = `${empresaId}/ifood_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`

    const { error } = await sb.storage.from("produto-fotos")
      .upload(path, bytes, { contentType: tipo, upsert: true })
    if (error) return urlIfood

    const { data } = sb.storage.from("produto-fotos").getPublicUrl(path)
    return data?.publicUrl || urlIfood
  } catch {
    return urlIfood
  }
}

// Põe no produto uma foto que está em algum lugar da internet, baixando e
// guardando no NOSSO storage. Nunca aponta pro endereço de fora: o dia em que o
// site mudar a URL, o cardápio fica sem imagem — foi o que quase aconteceu com as
// fotos que vinham penduradas no iFood.
async function runFotoDaUrl(sb: any, empresaId: string, produtoId: string, url: string, image?: string) {
  // `image` (data-uri) entra quando a foto foi tratada antes de subir — recorte
  // de tarja de supermercado, por exemplo. `url` é o caminho normal.
  if (!empresaId || !produtoId || (!url && !image)) return { ok: false, error: "empresa_id, produto_id e url (ou image) obrigatórios" }
  const { data: prod } = await sb.from("produtos").select("id, nome")
    .eq("empresa_id", empresaId).eq("id", produtoId).maybeSingle()
  if (!prod) return { ok: false, error: "produto não encontrado nesta loja" }

  const origem = image ?? url
  const nova = await guardarFotoLocal(sb, empresaId, origem)
  if (nova === origem) return { ok: false, error: "não deu pra baixar/guardar essa imagem" }

  const { error } = await sb.from("produtos").update({ foto_url: nova }).eq("id", produtoId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, nome: prod.nome, foto_url: nova }
}

// Traz pro nosso storage as fotos que ficaram hospedadas no iFood — produtos
// importados antes de a cópia existir. Roda quantas vezes precisar: quem já
// está no nosso storage é ignorado.
async function runTrazerFotos(sb: any, empresaId: string) {
  if (!empresaId) return { ok: false, error: "empresa_id obrigatório" }
  const { data: produtos } = await sb.from("produtos")
    .select("id, nome, foto_url")
    .eq("empresa_id", empresaId)
    .like("foto_url", "%static-images.ifood.com.br%")
  if (!produtos?.length) return { ok: true, copiadas: 0, total: 0, avisos: [] }

  const avisos: string[] = []
  let copiadas = 0
  for (const p of produtos) {
    const nova = await guardarFotoLocal(sb, empresaId, p.foto_url)
    if (nova === p.foto_url) { avisos.push(`${p.nome}: não deu pra copiar a foto`); continue }
    await sb.from("produtos").update({ foto_url: nova }).eq("id", p.id)
    copiadas++
  }
  return { ok: true, copiadas, total: produtos.length, avisos }
}

async function upsertProduto(
  sb: any,
  empresaId: string,
  item: { nome: string; preco: number; descricao?: string | null; foto?: string | null; categoria?: string | null; publicar?: boolean; ifoodItemId?: string | null; ifoodProductId?: string | null },
): Promise<boolean> {
  const nome = (item.nome ?? "").trim()
  if (!nome) return false
  const { data: existe } = await sb.from("produtos").select("id, ifood_item_id")
    .eq("empresa_id", empresaId).ilike("nome", nome).maybeSingle()
  if (existe) {
    // Produto que já existe aqui não é recriado, mas ganha o vínculo com o item
    // do iFood — assim importar numa loja que já tem o cardápio montado serve
    // pra casar os dois lados sem duplicar nada.
    if (item.ifoodItemId && !existe.ifood_item_id) {
      await sb.from("produtos")
        .update({ ifood_item_id: item.ifoodItemId, ifood_product_id: item.ifoodProductId ?? null })
        .eq("id", existe.id)
    }
    return false
  }
  const catPedida = (item.categoria ?? "iFood").trim() || "iFood"
  const cat = await ensureCategoria(sb, empresaId, catPedida)
  const preco = Number(item.preco) || 0
  const { error } = await sb.from("produtos").insert({
    empresa_id: empresaId,
    nome,
    categoria: cat,
    descricao: item.descricao || null,
    foto_url: item.foto || null,
    preco_venda: preco,
    preco_app: preco,
    ativo: true,
    disponivel_delivery: item.publicar !== false,
    ifood_item_id: item.ifoodItemId ?? null,
    ifood_product_id: item.ifoodProductId ?? null,
  })
  return !error
}

// Importa o cardápio inteiro do iFood (Opção A — botão "Importar cardápio").
// `categoriaIds` vazio = cardápio inteiro (como sempre foi). Com a lista, traz
// só as categorias escolhidas — quem já tem as bebidas cadastradas aqui e quer
// só o Prato Executivo não precisa trazer o resto junto.
async function runImportarCatalogo(sb: any, empresaId: string, categoriaIds?: string[]) {
  if (!empresaId) return { ok: false, error: "empresa_id obrigatório" }
  const { data: cfg } = await sb.from("ifood_config").select("*").eq("empresa_id", empresaId).maybeSingle()
  if (!cfg) return { ok: false, error: "iFood não configurado" }
  if (!cfg.merchant_id) return { ok: false, error: "Informe o Merchant ID primeiro" }

  const token = await getToken(sb, cfg as Config)
  const mid = cfg.merchant_id
  const auth = { "Authorization": `Bearer ${token}` }

  // 1. Lista de catálogos da loja
  const catRes = await fetch(`${IFOOD}/catalog/v2.0/merchants/${mid}/catalogs`, { headers: auth })
  if (!catRes.ok) {
    return { ok: false, error: `iFood ${catRes.status} ao ler catálogo. O módulo "Catálogo" pode não estar liberado no app crm-fwc.` }
  }
  let catalogs: any = await catRes.json()
  if (!Array.isArray(catalogs)) catalogs = catalogs ? [catalogs] : []

  let total = 0
  let criados = 0
  for (const cat of catalogs) {
    const catalogId = cat.catalogId ?? cat.id
    if (!catalogId) continue
    const cRes = await fetch(`${IFOOD}/catalog/v2.0/merchants/${mid}/catalogs/${catalogId}/categories?includeItems=true`, { headers: auth })
    if (!cRes.ok) continue
    const categorias: any[] = await cRes.json()
    const filtro = Array.isArray(categoriaIds) && categoriaIds.length > 0 ? new Set(categoriaIds) : null
    for (const c of (Array.isArray(categorias) ? categorias : [])) {
      if (filtro && !filtro.has(c.id)) continue
      const nomeCat = c.name ?? "iFood"
      for (const it of (c.items ?? [])) {
        total++
        const preco = it.price?.value ?? it.price ?? 0
        // O iFood às vezes devolve a URL completa da foto e às vezes só o
        // caminho. Colar o prefixo sem olhar gerava
        // ".../image/upload/https://static-images..." — endereço inválido, e o
        // produto entrava aqui sem foto nenhuma.
        const foto = it.imagePath
          ? (String(it.imagePath).startsWith("http")
              ? String(it.imagePath)
              : `https://static-images.ifood.com.br/pratos/${it.imagePath}`)
          : null
        // Só baixa a foto de quem vai entrar mesmo: produto que já existe aqui
        // mantém a foto dele e só ganha o vínculo.
        const jaTem = await sb.from("produtos").select("id").eq("empresa_id", empresaId)
          .ilike("nome", (it.name ?? "").trim()).maybeSingle()
        const fotoFinal = (foto && !jaTem.data) ? await guardarFotoLocal(sb, empresaId, foto) : foto

        const ok = await upsertProduto(sb, empresaId, {
          nome: it.name, preco, descricao: it.description, foto: fotoFinal,
          categoria: nomeCat, publicar: true,
          ifoodItemId: it.id ?? null, ifoodProductId: it.productId ?? null,
        })
        if (ok) criados++
      }
    }
  }
  return { ok: true, total, criados }
}

// ─────────────────────────────────────────────────────────────────────
// CATÁLOGO — listar itens (com status) e pausar/despausar item (F3)
// ─────────────────────────────────────────────────────────────────────
async function runCatalogoListar(sb: any, empresaId: string) {
  if (!empresaId) return { ok: false, error: "empresa_id obrigatório" }
  const { data: cfg } = await sb.from("ifood_config").select("*").eq("empresa_id", empresaId).maybeSingle()
  if (!cfg) return { ok: false, error: "iFood não configurado" }
  if (!cfg.merchant_id) return { ok: false, error: "Informe o Merchant ID primeiro" }
  const token = await getToken(sb, cfg as Config)
  const mid = cfg.merchant_id
  const auth = { "Authorization": `Bearer ${token}` }

  const catRes = await fetch(`${IFOOD}/catalog/v2.0/merchants/${mid}/catalogs`, { headers: auth })
  if (!catRes.ok) {
    return { ok: false, error: `iFood ${catRes.status} ao ler catálogo. O módulo Catálogo pode não estar homologado/autorizado ainda.` }
  }
  let catalogs: any = await catRes.json()
  if (!Array.isArray(catalogs)) catalogs = catalogs ? [catalogs] : []

  const itens: any[] = []
  for (const cat of catalogs) {
    const catalogId = cat.catalogId ?? cat.id
    if (!catalogId) continue
    const cRes = await fetch(`${IFOOD}/catalog/v2.0/merchants/${mid}/catalogs/${catalogId}/categories?includeItems=true`, { headers: auth })
    if (!cRes.ok) continue
    const categorias: any[] = await cRes.json()
    for (const c of (Array.isArray(categorias) ? categorias : [])) {
      for (const it of (c.items ?? [])) {
        itens.push({
          id: it.id ?? it.itemId,
          nome: it.name,
          categoria: c.name ?? "",
          status: it.status ?? "AVAILABLE",
          preco: it.price?.value ?? it.price ?? 0,
        })
      }
    }
  }
  return { ok: true, itens }
}

async function runCatalogoPausar(sb: any, empresaId: string, itemId: string, pausar: boolean) {
  if (!empresaId || !itemId) return { ok: false, error: "empresa_id e item_id obrigatórios" }
  const { data: cfg } = await sb.from("ifood_config").select("*").eq("empresa_id", empresaId).maybeSingle()
  if (!cfg) return { ok: false, error: "iFood não configurado" }
  if (!cfg.merchant_id) return { ok: false, error: "Informe o Merchant ID primeiro" }
  const token = await getToken(sb, cfg as Config)
  const mid = cfg.merchant_id
  const status = pausar ? "UNAVAILABLE" : "AVAILABLE"

  const res = await fetch(`${IFOOD}/catalog/v2.0/merchants/${mid}/items/status`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, status }),
  })
  if (!res.ok && res.status !== 202) {
    return { ok: false, error: `iFood ${res.status}: ${(await res.text()).slice(0, 200)}` }
  }
  return { ok: true, status }
}

// ─────────────────────────────────────────────────────────────────────
// CATÁLOGO — GERÊNCIA (criar/editar categoria, item, foto, complemento)
// Contrato validado direto na Merchant API v2.0:
//   POST  /catalogs/{catalogId}/categories   { name, status, template }
//   POST  /image/upload                       { image:"data:...base64" } -> { imagePath }
//   PUT   /items                              { item, products, optionGroups, options }
//   PATCH /options/status                     { optionId, status }
// ─────────────────────────────────────────────────────────────────────
type CatCtx = { mid: string; auth: Record<string, string>; catalogId: string }
// Resolve merchant + token + primeiro catálogo DEFAULT da loja (o que a UI usa).
async function catalogoCtx(sb: any, empresaId: string): Promise<CatCtx | { error: string }> {
  if (!empresaId) return { error: "empresa_id obrigatório" }
  const { data: cfg } = await sb.from("ifood_config").select("*").eq("empresa_id", empresaId).maybeSingle()
  if (!cfg) return { error: "iFood não configurado" }
  if (!cfg.merchant_id) return { error: "Informe o Merchant ID primeiro" }
  const token = await getToken(sb, cfg as Config)
  const mid = cfg.merchant_id
  const auth = { "Authorization": `Bearer ${token}` }
  const catRes = await fetch(`${IFOOD}/catalog/v2.0/merchants/${mid}/catalogs`, { headers: auth })
  if (!catRes.ok) return { error: `iFood ${catRes.status} ao ler catálogos (módulo Catalog liberado?)` }
  let catalogs: any = await catRes.json()
  if (!Array.isArray(catalogs)) catalogs = catalogs ? [catalogs] : []
  // prefere o catálogo com contexto DEFAULT
  const def = catalogs.find((c: any) => (c.context ?? []).includes("DEFAULT")) ?? catalogs[0]
  const catalogId = def?.catalogId ?? def?.id
  if (!catalogId) return { error: "loja sem catálogo no iFood" }
  return { mid, auth, catalogId }
}

// Lista as categorias do catálogo (id + nome) — a UI usa pra escolher onde cai o item.
async function runCatalogoCategorias(sb: any, empresaId: string) {
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/catalogs/${ctx.catalogId}/categories`, { headers: ctx.auth })
  if (!r.ok) return { ok: false, error: `iFood ${r.status} ao listar categorias` }
  const cats: any[] = await r.json()
  return { ok: true, categorias: (Array.isArray(cats) ? cats : []).map(c => ({ id: c.id, nome: c.name, status: c.status })) }
}

async function runCriarCategoria(sb: any, empresaId: string, nome: string) {
  if (!nome || !nome.trim()) return { ok: false, error: "nome da categoria obrigatório" }
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/catalogs/${ctx.catalogId}/categories`, {
    method: "POST",
    headers: { ...ctx.auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: nome.trim(), status: "AVAILABLE", template: "DEFAULT" }),
  })
  const txt = await r.text()
  if (!r.ok) {
    // 409 = já existe categoria com esse nome. O iFood devolve o id dela em
    // `conflictingResources`, então dá pra dizer QUAL é — quem está publicando
    // uma leva de produtos aproveita essa em vez de parar tudo.
    let jaExisteId: string | null = null
    if (r.status === 409) {
      // O id vem aninhado: {"error":{"code":"Conflict","conflictingResources":["<id>"]}}
      try {
        const j = JSON.parse(txt)
        jaExisteId = j?.error?.conflictingResources?.[0] ?? j?.conflictingResources?.[0] ?? null
      } catch { /* corpo fora do formato: segue sem o id */ }
    }
    return { ok: false, error: `iFood ${r.status}: ${txt.slice(0, 300)}`, jaExisteId }
  }
  const cat = txt ? JSON.parse(txt) : {}
  return { ok: true, id: cat.id, nome: cat.name }
}

// Sobe uma foto (base64 data-uri) e devolve o imagePath que o item/complemento usa.
async function runUploadImagem(sb: any, empresaId: string, image: string) {
  if (!image) return { ok: false, error: "imagem (base64) obrigatória" }
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  const dataUri = image.startsWith("data:") ? image : `data:image/png;base64,${image}`
  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/image/upload`, {
    method: "POST",
    headers: { ...ctx.auth, "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUri }),
  })
  const txt = await r.text()
  if (!r.ok) return { ok: false, error: `iFood ${r.status}: ${txt.slice(0, 300)}` }
  const j = txt ? JSON.parse(txt) : {}
  return { ok: true, imagePath: j.imagePath }
}

const uuid = () => crypto.randomUUID()

// Cria OU edita um item (PUT é idempotente — mesmo id = substitui). Aceita um
// formato simples vindo da UI e monta o payload aninhado do iFood. Reaproveita os
// ids quando vierem (edição); senão gera novos (criação).
async function runSalvarItem(sb: any, empresaId: string, p: any) {
  if (!p || !p.nome) return { ok: false, error: "payload do item inválido (falta nome)" }
  if (!p.categoriaId) return { ok: false, error: "categoriaId obrigatório" }
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }

  const itemId = p.itemId || uuid()
  const productId = p.productId || uuid()
  const status = p.status === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE"
  const grupos = Array.isArray(p.grupos) ? p.grupos : []

  // produtos: o principal + um por opção de complemento
  const products: any[] = [{
    id: productId, name: p.nome, description: p.descricao ?? "",
    ...(p.imagePath ? { imagePath: p.imagePath } : {}),
    optionGroups: grupos.map((g: any) => ({ id: g.grupoId, min: Number(g.min ?? 0), max: Number(g.max ?? 1) })),
  }]
  const optionGroups: any[] = []
  const options: any[] = []
  for (const g of grupos) {
    const opcoes = Array.isArray(g.opcoes) ? g.opcoes : []
    optionGroups.push({
      id: g.grupoId, name: g.nome, status: "AVAILABLE",
      min: Number(g.min ?? 0), max: Number(g.max ?? 1),
      optionIds: opcoes.map((o: any) => o.opcaoId),
    })
    for (const o of opcoes) {
      products.push({ id: o.produtoId, name: o.nome, ...(o.imagePath ? { imagePath: o.imagePath } : {}) })
      options.push({
        id: o.opcaoId, productId: o.produtoId,
        status: o.status === "UNAVAILABLE" ? "UNAVAILABLE" : "AVAILABLE",
        price: { value: Number(o.preco ?? 0) },
      })
    }
  }

  const bodyItem = {
    item: {
      id: itemId, type: "DEFAULT", categoryId: p.categoriaId, status,
      price: { value: Number(p.preco ?? 0) },
      externalCode: p.externalCode || `FWC-${itemId.slice(0, 8)}`,
      index: Number(p.index ?? 1), productId,
    },
    products, optionGroups, options,
  }
  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/items`, {
    method: "PUT",
    headers: { ...ctx.auth, "Content-Type": "application/json" },
    body: JSON.stringify(bodyItem),
  })
  const txt = await r.text()
  if (!r.ok) return { ok: false, error: `iFood ${r.status}: ${txt.slice(0, 400)}` }
  // devolve os ids gerados pra UI guardar (necessário pra depois editar/pausar)
  return { ok: true, itemId, productId,
    grupos: grupos.map((g: any) => ({ grupoId: g.grupoId, opcoes: (g.opcoes ?? []).map((o: any) => ({ opcaoId: o.opcaoId, produtoId: o.produtoId })) })) }
}

// Lista os itens do iFood JÁ COMPLETOS (com grupos/complementos) no formato que a
// UI usa pra editar — assim dá pra carregar um item existente no formulário e
// alterar/pausar sem recriar. imagePath volta como caminho cru (pra re-PUT) +
// imagemUrl (a URL do iFood, pra mostrar a miniatura).
function stripImg(u: any): string | null {
  if (!u) return null
  return String(u).replace(/^https?:\/\/static-images\.ifood\.com\.br\/(pratos|image\/upload)\//, "")
}
// ---------------------------------------------------------------------------
// Manda produtos do catálogo DAQUI pro iFood (o contrário do "Importar").
//
// Serve pra loja que já tem o cardápio montado aqui e vai entrar no iFood, ou
// que criou uma categoria nova e quer publicar dos dois lados sem digitar tudo
// de novo.
//
// O preço vai com um acréscimo em % escolhido pelo lojista: no iFood saem ~12%
// de comissão + ~4% da transação, então mandar o preço do balcão significaria
// entregar essa diferença da própria margem. Quem decide o número é ele — a
// tela mostra o antes/depois de cada item antes de confirmar.
//
// A imagem é buscada aqui no servidor (a URL é do nosso storage) e reenviada
// pro iFood, que só aceita base64. Foto que falhar não derruba o item: ele vai
// sem imagem e o nome aparece na lista de avisos.
async function runEnviarDaLoja(sb: any, empresaId: string, body: any) {
  const ids: string[] = Array.isArray(body?.produto_ids) ? body.produto_ids : []
  if (ids.length === 0) return { ok: false, error: "nenhum produto escolhido" }
  if (ids.length > LIMITE_ENVIO) return { ok: false, error: `manda no máximo ${LIMITE_ENVIO} produtos por vez` }

  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }

  const pct = Number(body?.acrescimo_pct ?? 0) || 0
  const { data: produtos } = await sb
    .from("produtos")
    .select("id, nome, descricao, preco_venda, foto_url, ifood_item_id, ifood_product_id")
    .eq("empresa_id", empresaId)
    .in("id", ids)
  if (!produtos?.length) return { ok: false, error: "produtos não encontrados" }

  // Categoria de destino: uma que já existe no iFood, ou cria com o nome dado.
  let categoriaId = body?.categoria_ifood_id ?? null
  let reusouCategoria: string | null = null
  if (!categoriaId) {
    const nome = String(body?.categoria_nome ?? "").trim()
    if (!nome) return { ok: false, error: "escolha ou nomeie a categoria de destino" }
    const nova = await runCriarCategoria(sb, empresaId, nome)
    if (nova.ok) categoriaId = nova.id
    else if (nova.jaExisteId) {
      // Já tinha uma categoria com esse nome lá: publica nela. Parar aqui só
      // obrigaria o lojista a voltar e escolher a mesma categoria na mão.
      categoriaId = nova.jaExisteId
      reusouCategoria = nome
    } else return { ok: false, error: `não deu pra criar a categoria: ${nova.error}` }
  }

  const avisos: string[] = []
  let enviados = 0      // itens novos no iFood
  let atualizados = 0   // já estavam lá e foram atualizados
  for (const p of produtos) {
    let imagePath: string | null = null
    if (p.foto_url) {
      try {
        const b64 = await baixarComoBase64(p.foto_url)
        const up = await runUploadImagem(sb, empresaId, b64)
        if (up.ok) imagePath = up.imagePath
        else avisos.push(`${p.nome}: foto não subiu (${String(up.error).slice(0, 80)})`)
      } catch (e) {
        avisos.push(`${p.nome}: foto não subiu (${String(e).slice(0, 80)})`)
      }
    }
    const preco = Math.round(Number(p.preco_venda ?? 0) * (1 + pct / 100) * 100) / 100
    // Produto que JÁ foi publicado reusa o id do item lá: o PUT do iFood é por
    // id, então mandar o mesmo id atualiza (preço, foto, descrição) em vez de
    // criar um segundo. Sem isso, reenviar a categoria duplicava o cardápio —
    // e o vínculo passava a apontar pro item novo, deixando o antigo órfão.
    const r = await runSalvarItem(sb, empresaId, {
      categoriaId, nome: p.nome, descricao: p.descricao ?? "", preco, imagePath,
      itemId: p.ifood_item_id ?? undefined,
      productId: p.ifood_product_id ?? undefined,
      externalCode: `FWC-${String(p.id).slice(0, 8)}`,
    })
    if (r.ok) {
      if (p.ifood_item_id) atualizados++
      else enviados++
      // Guarda o par produto↔item: é o que permite pausar aqui e pausar lá
      // (gatilho trg_ifood_espelha_pausa, migração 0207).
      await sb.from("produtos")
        .update({ ifood_item_id: r.itemId, ifood_product_id: r.productId })
        .eq("id", p.id)
    } else avisos.push(`${p.nome}: ${String(r.error).slice(0, 120)}`)
  }
  return { ok: true, enviados, atualizados, total: produtos.length, categoriaId, avisos, reusouCategoria }
}

// O iFood só aceita imagem em base64; a nossa fica no storage do Supabase.
// Converte em pedaços — passar o array inteiro pro fromCharCode estoura a pilha
// numa foto grande.
async function baixarComoBase64(url: string): Promise<string> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (bytes.length > 8 * 1024 * 1024) throw new Error("foto acima de 8MB")
  let bin = ""
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  const tipo = r.headers.get("content-type") ?? "image/jpeg"
  return `data:${tipo};base64,${btoa(bin)}`
}

// Apaga a categoria inteira do iFood, com os itens que estão dentro dela.
//
// Antes de apagar, lê o que tem lá pra soltar o vínculo dos nossos produtos: sem
// isso o espelho de pausa continuaria mandando pausar itens que não existem mais,
// e o reenvio acharia que já estavam publicados.
//
// Os PRODUTOS daqui não são tocados — some do iFood, continua no seu catálogo.
async function runExcluirCategoria(sb: any, empresaId: string, categoriaId: string) {
  if (!categoriaId) return { ok: false, error: "categoria_id obrigatório" }
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }

  const produtosIds: string[] = []
  try {
    const lista = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/catalogs/${ctx.catalogId}/categories?includeItems=true`, { headers: ctx.auth })
    if (lista.ok) {
      const cats: any[] = await lista.json()
      const alvo = (Array.isArray(cats) ? cats : []).find((c: any) => c.id === categoriaId)
      for (const it of (alvo?.items ?? [])) if (it.productId) produtosIds.push(it.productId)
    }
  } catch { /* sem a lista, apaga do mesmo jeito e os vínculos ficam pra limpeza seguinte */ }

  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/categories/${categoriaId}`, {
    method: "DELETE", headers: ctx.auth,
  })
  if (!r.ok && r.status !== 404) {
    return { ok: false, error: `iFood ${r.status}: ${(await r.text()).slice(0, 300)}` }
  }

  if (produtosIds.length > 0) {
    await sb.from("produtos")
      .update({ ifood_item_id: null, ifood_product_id: null })
      .eq("empresa_id", empresaId)
      .in("ifood_product_id", produtosIds)
  }
  return { ok: true, itens: produtosIds.length }
}

// Exclui pelo par (item, produto) sem saber a categoria — é o que o gatilho de
// exclusão do produto (0209) tem em mãos. A categoria vem de uma varredura do
// catálogo: custa uma chamada, e é o que evita guardar mais um id no produto
// só pra este caso.
async function runExcluirPorProduto(sb: any, empresaId: string, itemId: string, productId: string) {
  if (!itemId || !productId) return { ok: false, error: "item_id e product_id obrigatórios" }
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }

  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/catalogs/${ctx.catalogId}/categories?includeItems=true`, { headers: ctx.auth })
  if (!r.ok) return { ok: false, error: `iFood ${r.status} ao procurar o item` }
  const cats: any[] = await r.json()
  for (const c of (Array.isArray(cats) ? cats : [])) {
    if ((c.items ?? []).some((it: any) => it.id === itemId)) {
      return await runExcluirItem(sb, empresaId, c.id, productId)
    }
  }
  // Não achou: o item já não está no cardápio, que era o objetivo.
  return { ok: true, jaNaoExistia: true }
}

// Tira o item do cardápio do iFood de vez. NÃO tem desfazer lá — quem só quer
// esconder por hoje usa o pausar.
//
// O endpoint é por (categoria, produto): remove o produto daquela categoria, que
// é o que o cliente vê como "o item". O cadastro do produto continua existindo
// no iFood, então nada some de pedidos antigos.
async function runExcluirItem(sb: any, empresaId: string, categoriaId: string, productId: string) {
  if (!categoriaId || !productId) return { ok: false, error: "categoria_id e product_id obrigatórios" }
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }

  const r = await fetch(
    `${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/categories/${categoriaId}/products/${productId}`,
    { method: "DELETE", headers: ctx.auth },
  )
  if (!r.ok && r.status !== 404) {
    return { ok: false, error: `iFood ${r.status}: ${(await r.text()).slice(0, 300)}` }
  }
  // Se algum produto nosso apontava pra esse item, o vínculo morre junto —
  // senão o espelho de pausa ficaria mandando pausar um item que não existe.
  await sb.from("produtos")
    .update({ ifood_item_id: null, ifood_product_id: null })
    .eq("empresa_id", empresaId)
    .eq("ifood_product_id", productId)
  return { ok: true, jaNaoExistia: r.status === 404 }
}

async function runCatalogoItensCompletos(sb: any, empresaId: string) {
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/catalogs/${ctx.catalogId}/categories?includeItems=true`, { headers: ctx.auth })
  if (!r.ok) return { ok: false, error: `iFood ${r.status} ao listar itens` }
  const cats: any[] = await r.json()
  const itens: any[] = []
  for (const c of (Array.isArray(cats) ? cats : [])) {
    for (const it of (c.items ?? [])) {
      itens.push({
        itemId: it.id, productId: it.productId, categoriaId: c.id, categoriaNome: c.name,
        nome: it.name, descricao: it.description ?? "", preco: it.price?.value ?? 0,
        imagePath: stripImg(it.imagePath), imagemUrl: it.imagePath ?? null,
        status: it.status ?? "AVAILABLE",
        grupos: (it.optionGroups ?? []).map((g: any) => ({
          grupoId: g.id, nome: g.name, min: g.min ?? 0, max: g.max ?? 1,
          opcoes: (g.options ?? []).map((o: any) => ({
            opcaoId: o.id, produtoId: o.productId, nome: o.name, preco: o.price?.value ?? 0,
            imagePath: stripImg(o.imagePath), imagemUrl: o.imagePath ?? null, status: o.status ?? "AVAILABLE",
          })),
        })),
      })
    }
  }
  return { ok: true, itens }
}

// Pausa/despausa um COMPLEMENTO (option) — PATCH /options/status.
async function runPausarComplemento(sb: any, empresaId: string, optionId: string, pausar: boolean) {
  if (!optionId) return { ok: false, error: "option_id obrigatório" }
  const ctx = await catalogoCtx(sb, empresaId)
  if ("error" in ctx) return { ok: false, error: ctx.error }
  const status = pausar ? "UNAVAILABLE" : "AVAILABLE"
  const r = await fetch(`${IFOOD}/catalog/v2.0/merchants/${ctx.mid}/options/status`, {
    method: "PATCH",
    headers: { ...ctx.auth, "Content-Type": "application/json" },
    body: JSON.stringify({ optionId, status }),
  })
  if (!r.ok && r.status !== 202) return { ok: false, error: `iFood ${r.status}: ${(await r.text()).slice(0, 200)}` }
  return { ok: true, status }
}

// Espelha no nosso painel QUALQUER status que vier do iFood — assim, se o
// lojista aceitar/despachar direto no app do iFood, o painel acompanha sozinho.
// O trigger notify_ifood_status tem guard anti-eco (não devolve pro iFood o que
// já bate com ifood_status), então isso não gera loop.
const IFOOD_CODE_TO_STATUS: Record<string, string> = {
  CFM: "confirmado", CONFIRMED: "confirmado",
  RTP: "pronto", READYTOPICKUP: "pronto", READY_TO_PICKUP: "pronto",
  DSP: "saiu_entrega", DISPATCHED: "saiu_entrega",
  CON: "entregue", CONCLUDED: "entregue",
  CAN: "cancelado", CANCELLED: "cancelado", CANCELLATION_REQUESTED: "cancelado",
}
// Ranking pra não regredir o status (eventos do iFood podem chegar fora de ordem)
const STATUS_RANK: Record<string, number> = {
  aguardando: 0, confirmado: 1, em_preparo: 2, pronto: 3, saiu_entrega: 3, entregue: 4,
}

async function atualizarStatusLocal(sb: any, orderId: string, code: string) {
  const c = (code ?? "").toUpperCase()
  const patch: Record<string, unknown> = { ifood_status: code }
  const novo = IFOOD_CODE_TO_STATUS[c]

  if (novo) {
    const { data: atual } = await sb
      .from("pedidos_delivery")
      .select("status")
      .eq("ifood_order_id", orderId)
      .maybeSingle()
    const stAtual: string | undefined = atual?.status
    const finalizado = stAtual === "entregue" || stAtual === "cancelado"

    if (novo === "cancelado") {
      // iFood cancelou = a loja NÃO recebe por esse pedido. Reflete SEMPRE, inclusive
      // quando já estava "entregue" — senão vira venda fantasma (infla faturamento/líquido).
      if (stAtual !== "cancelado") {
        patch.status = "cancelado"
        patch.motivo_cancelamento = "Cancelado pelo iFood/cliente"
      }
    } else if (!finalizado && (STATUS_RANK[novo] ?? 0) > (STATUS_RANK[stAtual ?? ""] ?? -1)) {
      // Só avança (nunca volta atrás)
      patch.status = novo
    }
  }

  await sb.from("pedidos_delivery").update(patch).eq("ifood_order_id", orderId)
}

// ─────────────────────────────────────────────────────────────────────
// STATUS — devolve o status pro iFood quando o lojista avança no painel
// ─────────────────────────────────────────────────────────────────────
async function runStatus(sb: any, pedidoId: string, novoStatus: string) {
  if (!pedidoId || !novoStatus) return { ok: false, error: "pedido_id e novo_status obrigatórios" }

  const { data: pedido } = await sb
    .from("pedidos_delivery")
    .select("id, empresa_id, origem, ifood_order_id, tipo_entrega")
    .eq("id", pedidoId)
    .maybeSingle()

  if (!pedido) return { ok: false, error: "pedido não encontrado" }
  if (pedido.origem !== "ifood" || !pedido.ifood_order_id) {
    return { ok: true, skip: "pedido não é do iFood" }
  }

  const { data: cfg } = await sb
    .from("ifood_config")
    .select("*")
    .eq("empresa_id", pedido.empresa_id)
    .maybeSingle()
  if (!cfg) return { ok: false, error: "iFood não configurado para esta empresa" }

  const token = await getToken(sb, cfg as Config)
  const orderId = pedido.ifood_order_id
  const ehRetirada = pedido.tipo_entrega === "retirada"

  // Mapeia o status do nosso painel -> ação no iFood
  let acaoIfood: { path: string; body?: unknown } | null = null
  if (novoStatus === "confirmado") {
    acaoIfood = { path: `orders/${orderId}/confirm` }
  } else if (novoStatus === "pronto") {
    acaoIfood = { path: `orders/${orderId}/readyToPickup` }
  } else if (novoStatus === "saiu_entrega") {
    acaoIfood = { path: `orders/${orderId}/dispatch` }
  } else if (novoStatus === "entregue" && ehRetirada) {
    // Retirada: a CONCLUSÃO no iFood é feita pelo verifyDeliveryCode (código do
    // cliente) no momento da confirmação. Marcar 'entregue' aqui NÃO deve reenviar
    // nada ao iFood (senão faria readyToPickup num pedido já concluído).
    return { ok: true, skip: "retirada concluída via verifyDeliveryCode" }
  } else if (novoStatus === "cancelado") {
    // Consulta os motivos de cancelamento válidos pra ESTE pedido e usa o
    // primeiro disponível (cada pedido aceita códigos diferentes conforme o
    // momento do ciclo). Exigência da homologação + evita código inválido.
    let code = "501"
    let desc = "PROBLEMAS_SISTEMA"
    try {
      const rRes = await fetch(`${IFOOD}/order/v1.0/orders/${orderId}/cancellationReasons`, {
        headers: { "Authorization": `Bearer ${token}` },
      })
      if (rRes.ok) {
        const reasons = await rRes.json()
        if (Array.isArray(reasons) && reasons.length > 0) {
          code = reasons[0].cancelCodeId ?? reasons[0].code ?? code
          desc = reasons[0].description ?? desc
        }
      }
    } catch { /* mantém o fallback */ }
    acaoIfood = {
      path: `orders/${orderId}/requestCancellation`,
      body: { reason: desc, cancellationCode: code },
    }
  }

  if (!acaoIfood) return { ok: true, skip: `status ${novoStatus} sem ação no iFood` }

  const res = await fetch(`${IFOOD}/order/v1.0/${acaoIfood.path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      ...(acaoIfood.body ? { "Content-Type": "application/json" } : {}),
    },
    body: acaoIfood.body ? JSON.stringify(acaoIfood.body) : undefined,
  })

  if (!res.ok && res.status !== 202) {
    return { ok: false, error: `iFood ${res.status}: ${(await res.text()).slice(0, 200)}` }
  }

  await sb.from("pedidos_delivery").update({ ifood_status: novoStatus }).eq("id", pedidoId)
  return { ok: true, enviado: novoStatus }
}

// ─────────────────────────────────────────────────────────────────────
// VERIFY DELIVERY CODE — F1: motoqueiro digita o código do cliente e a gente
// valida no iFood (POST verifyDeliveryCode). Se válido, o iFood conclui e a
// gente marca 'entregue' localmente.
// ─────────────────────────────────────────────────────────────────────
async function runVerifyDeliveryCode(sb: any, pedidoId: string, codigo: string) {
  if (!pedidoId || !codigo) return { ok: false, error: "pedido_id e codigo obrigatórios" }

  const { data: pedido } = await sb
    .from("pedidos_delivery")
    .select("id, empresa_id, origem, ifood_order_id")
    .eq("id", pedidoId)
    .maybeSingle()
  if (!pedido) return { ok: false, error: "pedido não encontrado" }
  if (pedido.origem !== "ifood" || !pedido.ifood_order_id) {
    return { ok: false, error: "pedido não é do iFood" }
  }

  const { data: cfg } = await sb
    .from("ifood_config")
    .select("*")
    .eq("empresa_id", pedido.empresa_id)
    .maybeSingle()
  if (!cfg) return { ok: false, error: "iFood não configurado para esta empresa" }

  const token = await getToken(sb, cfg as Config)
  const res = await fetch(`${IFOOD}/order/v1.0/orders/${pedido.ifood_order_id}/verifyDeliveryCode`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(codigo).trim() }),
  })

  // 400/422 = código inválido (o iFood recusa). Não é erro nosso.
  if (!res.ok) {
    const txt = await res.text()
    return { ok: true, valid: false, status: res.status, detalhe: txt.slice(0, 200) }
  }
  const data = await res.json().catch(() => ({}))
  const valid = data?.valid !== false // 200 sem "valid:false" = válido

  if (valid) {
    // Conclui do nosso lado. ifood_status=CONCLUDED evita eco do trigger.
    await sb.from("pedidos_delivery")
      .update({ status: "entregue", ifood_status: "CONCLUDED" })
      .eq("id", pedidoId)
  }
  return { ok: true, valid }
}

// ─────────────────────────────────────────────────────────────────────
// TEST — valida as credenciais autenticando no iFood
// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// DETECTAR MERCHANT — descobre sozinho o ID da loja no iFood
// ─────────────────────────────────────────────────────────────────────
// O lojista autoriza o app CRM FWC no Portal do Parceiro dele e pronto: não
// precisa caçar nem colar o "Merchant ID". O iFood devolve as lojas que
// autorizaram o app dentro do próprio token (claim merchant_scope, no formato
// "<merchant>:order" / "<merchant>:events"), então a gente lê de lá.
//
// Sobra o problema de saber QUAL das lojas autorizadas é esta empresa — o
// módulo Merchant (que traria nome/CNPJ) ainda não está liberado pro nosso app.
// Resolvemos por eliminação: tira as que já estão em outra empresa do CRM. Se
// sobrar exatamente uma, liga sozinho. Se sobrar mais de uma (alguém autorizou
// e nunca conectou), devolve a lista pro lojista escolher em vez de chutar.
function merchantsDoToken(token: string): string[] {
  const parte = token.split(".")[1]
  if (!parte) return []
  const b64 = parte.replace(/-/g, "+").replace(/_/g, "/")
  const claims = JSON.parse(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)))
  const escopo = claims?.merchant_scope
  const lista: string[] = Array.isArray(escopo)
    ? escopo
    : (escopo && typeof escopo === "object" ? Object.keys(escopo) : [])
  const ids = lista.map((s) => String(s).split(":")[0]).filter(Boolean)
  return [...new Set(ids)]
}

async function runDetectarMerchant(sb: any, empresaId: string, merchantEscolhido?: string) {
  if (!empresaId) return { ok: false, error: "empresa_id obrigatório" }

  // Autentica com as credenciais da plataforma (ou as da empresa, se tiver).
  const { data: cfgAtual } = await sb
    .from("ifood_config").select("*").eq("empresa_id", empresaId).maybeSingle()
  const creds = await resolverCreds(sb, (cfgAtual ?? { empresa_id: empresaId }) as Config)
  if (!creds.clientId || !creds.clientSecret) {
    return { ok: false, error: "Credenciais do iFood não configuradas na plataforma" }
  }

  const form = new URLSearchParams()
  form.set("grantType", "client_credentials")
  form.set("clientId", creds.clientId)
  form.set("clientSecret", creds.clientSecret)
  const res = await fetch(`${IFOOD}/authentication/v1.0/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  })
  if (!res.ok) {
    return { ok: false, error: `Não consegui falar com o iFood (${res.status}). Tente de novo em instantes.` }
  }
  const token: string = (await res.json()).accessToken

  const autorizados = merchantsDoToken(token)
  if (!autorizados.length) {
    return {
      ok: false,
      error: "Nenhuma loja autorizou o CRM FWC ainda. Autorize o app no Portal do Parceiro do iFood e tente de novo.",
    }
  }

  // Merchants já vinculados a OUTRAS empresas do CRM
  const { data: usados } = await sb
    .from("ifood_config").select("empresa_id, merchant_id").not("merchant_id", "is", null)
  const deOutros = new Set(
    (usados ?? []).filter((u: any) => u.empresa_id !== empresaId).map((u: any) => u.merchant_id),
  )
  const livres = autorizados.filter((m) => !deOutros.has(m))

  let merchantId: string | null = null
  if (merchantEscolhido) {
    if (!livres.includes(merchantEscolhido)) {
      return { ok: false, error: "Essa loja não está mais disponível. Atualize a página e tente de novo." }
    }
    merchantId = merchantEscolhido
  } else if (livres.length === 1) {
    merchantId = livres[0]
  } else if (livres.length === 0) {
    return {
      ok: false,
      error: "As lojas autorizadas já estão ligadas a outras contas do CRM. Autorize o app no iFood com a loja certa.",
    }
  } else {
    // Mais de uma candidata: quem escolhe é o lojista.
    return { ok: false, escolher: true, opcoes: livres }
  }

  const { error } = await sb.from("ifood_config").upsert({
    empresa_id: empresaId,
    merchant_id: merchantId,
    ambiente: "producao",
    ativo: true,
    polling_ativo: true,
    access_token: null,
    token_expira_em: null,
    ultimo_erro: null,
  }, { onConflict: "empresa_id" })
  if (error) return { ok: false, error: error.message }

  return { ok: true, merchant_id: merchantId }
}

async function runTest(sb: any, empresaId: string) {
  if (!empresaId) return { ok: false, error: "empresa_id obrigatório" }
  const { data: cfg } = await sb
    .from("ifood_config")
    .select("*")
    .eq("empresa_id", empresaId)
    .maybeSingle()
  if (!cfg) return { ok: false, error: "iFood não configurado" }
  const creds = await resolverCreds(sb, cfg as Config)
  if (!creds.clientId || !creds.clientSecret) return { ok: false, error: "Credenciais do iFood não configuradas na plataforma" }

  // Força reautenticação ignorando o cache
  await sb.from("ifood_config").update({ access_token: null, token_expira_em: null }).eq("empresa_id", empresaId)
  await getToken(sb, { ...cfg, access_token: null, token_expira_em: null } as Config)
  return { ok: true, mensagem: "Autenticação no iFood OK" }
}
