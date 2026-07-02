import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

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
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Host único da Merchant API (loja de teste e produção usam o mesmo host;
// o que muda é o conjunto de credenciais / merchant).
const IFOOD = "https://merchant-api.ifood.com.br"

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
    if (acao === "catalogo") return json(await runImportarCatalogo(sb, body?.empresa_id))
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

  const total = o.total ?? {}
  const { forma, troco } = mapearPagamento(o.payments)

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
    endereco_complemento: addr.complement ?? null,
    endereco_bairro: addr.neighborhood ?? null,
    endereco_cidade: ehEntrega ? (addr.city ?? "—") : "Retirada",

    itens,
    subtotal: Number(total.subTotal ?? 0),
    taxa_entrega: Number(total.deliveryFee ?? 0),
    total: Number(total.orderAmount ?? total.subTotal ?? 0),

    forma_pagamento: forma,
    troco_para: troco,

    observacoes: o.observations ?? null,

    ifood_order_id: o.id ?? orderId,
    ifood_display_id: o.displayId ?? null,
    ifood_status: "PLACED",
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

function mapearPagamento(payments: any): { forma: string; troco: number | null } {
  const methods = payments?.methods ?? []
  // Pago online no app do iFood
  if (payments?.prepaid && Number(payments.prepaid) > 0 && (!payments.pending || Number(payments.pending) === 0)) {
    return { forma: "online", troco: null }
  }
  const m = methods[0]
  if (!m) return { forma: "online", troco: null }
  if ((m.type ?? "").toUpperCase() === "ONLINE") return { forma: "online", troco: null }

  const metodo = (m.method ?? "").toUpperCase()
  if (metodo === "CASH") {
    const changeFor = m.cash?.changeFor != null ? Number(m.cash.changeFor) : null
    return { forma: "dinheiro", troco: changeFor && changeFor > 0 ? changeFor : null }
  }
  if (metodo === "CREDIT") return { forma: "credito", troco: null }
  if (metodo === "DEBIT") return { forma: "debito", troco: null }
  if (metodo === "MEAL_VOUCHER" || metodo === "FOOD_VOUCHER") return { forma: "vale", troco: null }
  return { forma: "outro", troco: null }
}

// ─────────────────────────────────────────────────────────────────────
// Catálogo: cria produtos no CRM a partir dos itens do iFood
// ─────────────────────────────────────────────────────────────────────
// Garante que a categoria exista na lista de categorias da empresa.
async function ensureCategoria(sb: any, empresaId: string, nome: string) {
  if (!nome) return
  const { data } = await sb.from("categorias").select("id")
    .eq("empresa_id", empresaId).ilike("nome", nome).maybeSingle()
  if (!data) {
    try { await sb.from("categorias").insert({ empresa_id: empresaId, nome }) } catch { /* corrida/duplicado ok */ }
  }
}

// Cria um produto a partir de um item do iFood, se ainda não existir (por nome).
// Retorna true se criou. `publicar` define se aparece na loja online.
async function upsertProduto(
  sb: any,
  empresaId: string,
  item: { nome: string; preco: number; descricao?: string | null; foto?: string | null; categoria?: string | null; publicar?: boolean },
): Promise<boolean> {
  const nome = (item.nome ?? "").trim()
  if (!nome) return false
  const { data: existe } = await sb.from("produtos").select("id")
    .eq("empresa_id", empresaId).ilike("nome", nome).maybeSingle()
  if (existe) return false
  const cat = (item.categoria ?? "iFood").trim() || "iFood"
  await ensureCategoria(sb, empresaId, cat)
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
  })
  return !error
}

// Importa o cardápio inteiro do iFood (Opção A — botão "Importar cardápio").
async function runImportarCatalogo(sb: any, empresaId: string) {
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
    for (const c of (Array.isArray(categorias) ? categorias : [])) {
      const nomeCat = c.name ?? "iFood"
      for (const it of (c.items ?? [])) {
        total++
        const preco = it.price?.value ?? it.price ?? 0
        const foto = it.imagePath ? `https://static-images.ifood.com.br/image/upload/${it.imagePath}` : null
        const ok = await upsertProduto(sb, empresaId, {
          nome: it.name, preco, descricao: it.description, foto,
          categoria: nomeCat, publicar: true,
        })
        if (ok) criados++
      }
    }
  }
  return { ok: true, total, criados }
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
      // Cancelamento sempre reflete (a não ser que já tenha sido entregue)
      if (stAtual !== "entregue") {
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
    acaoIfood = { path: `orders/${orderId}/readyToPickup` }
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
