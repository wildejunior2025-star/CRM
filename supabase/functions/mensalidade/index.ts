// Mensalidade semanal/mensal das lojas — pagamento e aviso (migs 0263/0264).
//
// Tudo cai no Mercado Pago JURÍDICO da FWC (decisão do Wilde, 13/09/2026):
//   MP_ACCESS_TOKEN_FWC_PJ  — token de produção da conta CNPJ
//   MP_PUBLIC_KEY_FWC_PJ    — chave pública da mesma conta (cartão no navegador)
// NUNCA cair no MP_ACCESS_TOKEN (conta do CPF, que recebe os créditos do robô):
// sem a conta jurídica configurada, a função recusa em vez de cobrar no lugar
// errado.
//
// Ações (POST { action }):
//   com login do ADMIN da loja: pix · status · cartao_chave · assinar · cancelar_cartao
//   sem login: cron (diário) · webhook do Mercado Pago (?type=payment&data.id=...)
// As sem login não confiam no corpo: tudo é conferido de novo na API do MP.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { diaDoBloqueio, somaDiasYmd } from "../_shared/mensalidadeFase.ts"

const MP_TOKEN      = Deno.env.get("MP_ACCESS_TOKEN_FWC_PJ") ?? ""
const MP_PUBLIC_KEY = Deno.env.get("MP_PUBLIC_KEY_FWC_PJ") ?? ""
const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!
const SUPABASE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const CLOUD_TOKEN   = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"
const TEMPLATE_COBRANCA = "cobranca_mensalidade"
const APP_URL = "https://gestor.fwcinter.com"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } })

const hojeBR = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date())
const dataBr = (ymd: string) => { const [y, m, d] = ymd.split("-"); return `${d}/${m}/${y}` }
const valorBr = (v: number) => `R$ ${Number(v).toFixed(2).replace(".", ",")}`

async function mp(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

// ── Conferir pagamentos pendentes de uma loja (PIX e cartão) ────────────────
async function conferirPendentes(sb: any, empresaId: string) {
  if (!MP_TOKEN) return
  const { data: pend } = await sb.from("mensalidade_pagamentos")
    .select("id, mp_payment_id").eq("empresa_id", empresaId).eq("status", "pendente")
  for (const p of pend ?? []) {
    if (!p.mp_payment_id) continue
    const r = await mp(`/v1/payments/${p.mp_payment_id}`)
    if (r.data?.status === "approved") {
      await sb.rpc("mensalidade_aplicar_pagamento", { p_pagamento: p.id })
    } else if (["cancelled", "rejected", "expired", "refunded"].includes(r.data?.status)) {
      await sb.from("mensalidade_pagamentos").update({ status: "cancelado" }).eq("id", p.id).eq("status", "pendente")
    }
  }
}

// ── Cobranças do cartão (assinatura) que o MP já aprovou ────────────────────
// Não depende do webhook chegar: consulta os pagamentos autorizados da
// assinatura e aplica os que ainda não entraram.
async function conferirAssinatura(sb: any, empresaId: string) {
  if (!MP_TOKEN) return
  const { data: cfg } = await sb.from("mensalidade_config")
    .select("mp_assinatura_id").eq("empresa_id", empresaId).maybeSingle()
  if (!cfg?.mp_assinatura_id) return
  const assin = await mp(`/preapproval/${cfg.mp_assinatura_id}`)
  if (assin.data?.status) {
    await sb.from("mensalidade_config").update({ mp_assinatura_status: assin.data.status }).eq("empresa_id", empresaId)
  }
  const r = await mp(`/authorized_payments/search?preapproval_id=${cfg.mp_assinatura_id}`)
  for (const ap of r.data?.results ?? []) {
    const pagId = String(ap?.payment?.id ?? ap?.id ?? "")
    const aprovado = ap?.payment?.status === "approved" || ap?.status === "processed"
    if (!pagId || !aprovado) continue
    await aplicarCobrancaDoCartao(sb, empresaId, pagId, Number(ap?.transaction_amount ?? ap?.payment?.transaction_amount ?? 0))
  }
}

async function aplicarCobrancaDoCartao(sb: any, empresaId: string, mpPaymentId: string, valor: number) {
  const { data: ja } = await sb.from("mensalidade_pagamentos").select("id").eq("mp_payment_id", mpPaymentId).maybeSingle()
  if (ja) return
  // Quita a cobrança aberta mais antiga (a do cartão cobre uma por vez).
  const { data: aberta } = await sb.from("mensalidade_cobrancas")
    .select("id, valor").eq("empresa_id", empresaId).eq("status", "aberta")
    .order("vencimento").limit(1).maybeSingle()
  if (!aberta) return
  const { data: pg } = await sb.from("mensalidade_pagamentos").insert({
    empresa_id: empresaId, cobranca_ids: [aberta.id], valor: valor || aberta.valor,
    forma: "cartao", status: "pendente", mp_payment_id: mpPaymentId,
  }).select("id").single()
  if (pg?.id) await sb.rpc("mensalidade_aplicar_pagamento", { p_pagamento: pg.id })
}

// ── WhatsApp da cobrança (modelo aprovado pela Meta) ────────────────────────
async function enviarTemplate(phoneNumberId: string, to: string, params: string[]) {
  if (!CLOUD_TOKEN || !phoneNumberId) return { erro: "sem Cloud API", id: null }
  let d = String(to).replace(/\D/g, "")
  if (!d.startsWith("55")) d = "55" + d
  if (d.length === 12 && /^[6-9]/.test(d.slice(4))) d = `${d.slice(0, 4)}9${d.slice(4)}`
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_TOKEN}` },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to: d, type: "template",
      template: {
        name: TEMPLATE_COBRANCA, language: { code: "pt_BR" },
        components: [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p).replace(/\s+/g, " ").trim() })) }],
      },
    }),
  })
  if (!res.ok) return { erro: `Graph ${res.status}: ${(await res.text()).slice(0, 200)}`, id: null }
  const out = await res.json().catch(() => ({}))
  return { erro: null, id: out?.messages?.[0]?.id ?? null, telefone: d }
}

// ── PIX da mensalidade de uma loja ───────────────────────────────────────────
// Reaproveita o PIX pendente que ainda vale mais de 5 min; senão gera um novo
// (1h de validade). Usada pelo admin logado e pela página pública do link.
async function gerarPixLoja(sb: any, empresaId: string, o: { email?: string | null, profId?: string | null, quem: string, antecipar: boolean }) {
  await sb.rpc("mensalidade_gerar", { p_empresa: empresaId })
  const hoje = hojeBR()
  const { data: cfg } = await sb.from("mensalidade_config").select("desconto_antecipado").eq("empresa_id", empresaId).maybeSingle()
  const { data: abertas } = await sb.from("mensalidade_cobrancas")
    .select("id, vencimento, referencia, valor").eq("empresa_id", empresaId).eq("status", "aberta").order("vencimento")
  const vencidas = (abertas ?? []).filter((c: any) => c.vencimento <= hoje)
  // Nada vencido: dá pra pagar a próxima antes, com o desconto.
  const alvo = vencidas.length ? vencidas : (o.antecipar ? (abertas ?? []).slice(0, 1) : [])
  if (!alvo.length) return { status: 400, body: { error: "Não há mensalidade em aberto." } }
  const desconto = vencidas.length ? 0 : Number(cfg?.desconto_antecipado ?? 0)
  const valor = Math.max(0.01, Math.round((alvo.reduce((s: number, c: any) => s + Number(c.valor), 0) - desconto) * 100) / 100)

  // Já tem PIX valendo pro mesmo valor? Devolve o mesmo (não gera dois).
  const { data: aberto } = await sb.from("mensalidade_pagamentos")
    .select("id, valor, pix_copia_cola, pix_qr_base64, expira_em, cobranca_ids")
    .eq("empresa_id", empresaId).eq("status", "pendente").eq("forma", "pix")
    .gt("expira_em", new Date(Date.now() + 5 * 60000).toISOString())
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (aberto && Number(aberto.valor) === valor && (aberto.cobranca_ids ?? []).length === alvo.length) return { status: 200, body: { ok: true, ...aberto } }

  const { data: emp } = await sb.from("empresas").select("nome").eq("id", empresaId).single()
  const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const descricao = `FWC Inter — ${emp?.nome ?? "Loja"} — ${alvo.map((c: any) => c.referencia).join(", ")}`.slice(0, 250)
  const r = await mp("/v1/payments", "POST", {
    transaction_amount: valor,
    description: descricao,
    payment_method_id: "pix",
    date_of_expiration: expira,
    payer: { email: o.email ?? "loja@fwcinter.com" },
    external_reference: `mensalidade:${empresaId}`,
    notification_url: `${SUPABASE_URL}/functions/v1/mensalidade`,
    metadata: { tipo: "mensalidade", empresa_id: empresaId },
  })
  if (!r.data?.id) return { status: 502, body: { error: "Não consegui gerar o PIX agora. Tente de novo em instantes.", detalhe: r.data?.message } }

  const td = r.data.point_of_interaction?.transaction_data ?? {}
  const { data: pg } = await sb.from("mensalidade_pagamentos").insert({
    empresa_id: empresaId, cobranca_ids: alvo.map((c: any) => c.id), valor, forma: "pix",
    mp_payment_id: String(r.data.id), pix_copia_cola: td.qr_code ?? null, pix_qr_base64: td.qr_code_base64 ?? null,
    expira_em: expira, criado_por: o.profId ?? null,
  }).select("id, valor, pix_copia_cola, pix_qr_base64, expira_em").single()
  await sb.from("mensalidade_avisos").insert({
    empresa_id: empresaId, cobranca_id: alvo[0].id, tipo: "pix_gerado", profile_id: o.profId ?? null,
    quem: o.quem, detalhe: `PIX de ${valorBr(valor)}`,
  }).then(() => {}, () => {})
  return { status: 200, body: { ok: true, ...pg } }
}

// ── Link de pagamento (página pública /pagar/:token) ─────────────────────────
async function lojaDoLink(sb: any, token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token ?? "")) return null
  const { data } = await sb.from("mensalidade_config").select("empresa_id, desconto_antecipado, empresas(nome)")
    .eq("link_token", token).maybeSingle()
  return data ?? null
}

// ── WhatsApp da FWC (Evolution) ──────────────────────────────────────────────
async function enviarEvolution(sb: any, telefone: string, texto: string) {
  const url = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
  const key = Deno.env.get("EVOLUTION_API_KEY") ?? ""
  if (!url || !key) return { erro: "Evolution não configurada" }
  const { data: cg } = await sb.from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
  const instancia = String(cg?.valor ?? "").trim() || "crmadmin"
  let d = String(telefone).replace(/\D/g, "")
  if (!d.startsWith("55")) d = "55" + d
  const res = await fetch(`${url}/message/sendText/${instancia}`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: key },
    body: JSON.stringify({ number: d, text: texto }),
  })
  if (!res.ok) return { erro: `Evolution ${res.status}: ${(await res.text()).slice(0, 200)}` }
  return { erro: null, telefone: d }
}

function textoLink(nome: string | undefined, token: string, lista: any[], vencida: boolean) {
  const total = lista.reduce((s: number, c: any) => s + Number(c.valor), 0)
  return `Olá, ${nome ?? "tudo bem"}! Aqui é a FWC Inter. 👋\n\n` +
    (vencida
      ? `A mensalidade do sistema está em aberto: ${lista.map((c: any) => `${c.referencia} (${valorBr(c.valor)})`).join(", ")}. Total: *${valorBr(total)}*.`
      : `Sua próxima mensalidade do sistema: ${lista[0].referencia} (${valorBr(lista[0].valor)}), vence em ${dataBr(lista[0].vencimento)}.`) +
    `\n\nPague pelo PIX neste link (abre o QR Code e o copia e cola):\n${APP_URL}/pagar/${token}\n\nQualquer dúvida é só chamar!`
}

// ── Envio automático do link (só lojas com zap_auto ligado no Super ADM) ─────
// Roda às 8h (Fortaleza). Uma mensagem por cobrança vencida nova: a chave é a
// vencida mais recente, então cada semana que vence manda a sua. Falha não
// trava: grava outro tipo de aviso e tenta de novo no dia seguinte.
async function cronLinkWhatsApp(sb: any) {
  const hoje = hojeBR()
  const { data: cfgs } = await sb.from("mensalidade_config")
    .select("empresa_id, link_token, zap_telefone, empresas(nome)").eq("ativa", true).eq("zap_auto", true)
  const resumo: unknown[] = []
  for (const c of cfgs ?? []) {
    if (!c.zap_telefone) continue
    await conferirPendentes(sb, c.empresa_id)
    const { data: abertas } = await sb.from("mensalidade_cobrancas")
      .select("id, vencimento, referencia, valor").eq("empresa_id", c.empresa_id).eq("status", "aberta").lte("vencimento", hoje).order("vencimento")
    if (!abertas?.length) continue
    const chave = abertas[abertas.length - 1]
    const { data: jaFoi } = await sb.from("mensalidade_avisos").select("id")
      .eq("empresa_id", c.empresa_id).eq("cobranca_id", chave.id).eq("tipo", "whatsapp_link_auto").limit(1).maybeSingle()
    if (jaFoi) continue
    const total = abertas.reduce((s: number, x: any) => s + Number(x.valor), 0)
    const envio: any = await enviarEvolution(sb, c.zap_telefone, textoLink(c.empresas?.nome, c.link_token, abertas, true))
    await sb.from("mensalidade_avisos").insert({
      empresa_id: c.empresa_id, cobranca_id: chave.id, tipo: envio.erro ? "whatsapp_link_falha" : "whatsapp_link_auto",
      quem: "WhatsApp da FWC (automático)",
      detalhe: envio.erro ? `Falhou: ${envio.erro}` : `Link enviado pro ${c.zap_telefone} (${valorBr(total)})`,
    }).then(() => {}, () => {})
    resumo.push({ loja: c.empresas?.nome, erro: envio.erro })
    // Espaça os envios: número da FWC não é Cloud API, sem pressa.
    await new Promise(r => setTimeout(r, 4000))
  }
  return resumo
}

// ── Cron diário ──────────────────────────────────────────────────────────────
async function cronDiario(sb: any) {
  await sb.rpc("mensalidade_gerar_todas")
  const hoje = hojeBR()
  const { data: cfgs } = await sb.from("mensalidade_config")
    .select("empresa_id, carencia_dias, prazo_ate, empresas(nome, telefone_contato, horarios_funcionamento, feriados_fecha)")
    .eq("ativa", true)
  const { data: cg } = await sb.from("config_global").select("chave, valor").eq("chave", "admin_cloud_phone_number_id").maybeSingle()
  const phoneNumberId = String(cg?.valor ?? "").trim()

  const resumo: unknown[] = []
  for (const c of cfgs ?? []) {
    await conferirPendentes(sb, c.empresa_id)
    await conferirAssinatura(sb, c.empresa_id)

    const { data: vencida } = await sb.from("mensalidade_cobrancas")
      .select("id, vencimento, referencia, valor").eq("empresa_id", c.empresa_id).eq("status", "aberta")
      .lte("vencimento", hoje).order("vencimento").limit(1).maybeSingle()
    if (!vencida) continue
    if (c.prazo_ate && hoje <= c.prazo_ate) continue

    const { data: exc } = await sb.from("dias_excecao").select("data, aberto, periodos")
      .eq("empresa_id", c.empresa_id).gte("data", vencida.vencimento).lte("data", somaDiasYmd(hoje, 30))
    const excecoes = Object.fromEntries((exc ?? []).map((r: any) => [r.data, r]))
    let bloqueio = diaDoBloqueio(vencida.vencimento, Number(c.carencia_dias ?? 2), c.empresas ?? {}, excecoes)
    // Prazo combinado além da carência: o dia de travar passa a ser o primeiro
    // dia de funcionamento depois do prazo (mesma regra de src/lib/mensalidade.js).
    if (c.prazo_ate && c.prazo_ate >= bloqueio) bloqueio = diaDoBloqueio(c.prazo_ate, 0, c.empresas ?? {}, excecoes)

    // Dois avisos por cobrança: no dia seguinte ao vencimento e no dia que trava.
    let tipo: string | null = null
    if (hoje === bloqueio) tipo = "whatsapp_bloqueio"
    else if (hoje > vencida.vencimento && hoje < bloqueio) tipo = "whatsapp_atraso"
    if (!tipo || !c.empresas?.telefone_contato) continue

    const { data: jaFoi } = await sb.from("mensalidade_avisos").select("id")
      .eq("empresa_id", c.empresa_id).eq("cobranca_id", vencida.id).eq("tipo", tipo).limit(1).maybeSingle()
    if (jaFoi) continue

    const { data: todas } = await sb.from("mensalidade_cobrancas").select("valor")
      .eq("empresa_id", c.empresa_id).eq("status", "aberta").lte("vencimento", hoje)
    const total = (todas ?? []).reduce((s: number, x: any) => s + Number(x.valor), 0)
    const params = [c.empresas.nome, vencida.referencia, valorBr(total), dataBr(vencida.vencimento)]
    const envio: any = await enviarTemplate(phoneNumberId, c.empresas.telefone_contato, params)

    await sb.from("mensalidade_avisos").insert({
      empresa_id: c.empresa_id, cobranca_id: vencida.id, tipo, quem: "WhatsApp da FWC",
      detalhe: envio.erro ? `Falhou: ${envio.erro}` : `Enviado pro ${c.empresas.telefone_contato} (${params[1]}, ${params[2]})`,
    })
    if (!envio.erro) {
      await sb.from("admin_chat").insert({
        telefone: envio.telefone, empresa_id: c.empresa_id, remetente: "fwc", tipo: "modelo",
        texto: `🧾 Aviso de mensalidade — ${params[0]}: ${params[1]}, ${params[2]}, venceu em ${params[3]}.`,
        message_id: envio.id, status: "enviado", lida: true,
      })
    }
    resumo.push({ loja: c.empresas.nome, tipo, erro: envio.erro })
  }
  return resumo
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
  const url = new URL(req.url)
  let body: any = {}
  try { body = await req.json() } catch { /* webhook pode vir sem corpo */ }

  try {
    // ── Webhook do Mercado Pago ──────────────────────────────────────────────
    const tipoMp = url.searchParams.get("type") ?? url.searchParams.get("topic") ?? body?.type ?? body?.topic
    const idMp = url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? body?.data?.id
    // O aviso do MP também traz "action" ("payment.created") — por isso a
    // conferência é contra as ações desta função, e não pela presença do campo.
    const ACOES = ["cron", "cron_link", "status", "pix", "cartao_chave", "assinar", "cancelar_cartao", "link_info", "link_pix", "link_status", "enviar_link"]
    if (tipoMp && idMp && !ACOES.includes(body?.action)) {
      if (!MP_TOKEN) return json({ ok: true })
      if (tipoMp === "payment") {
        const r = await mp(`/v1/payments/${idMp}`)
        if (r.data?.status === "approved") {
          const { data: pg } = await sb.from("mensalidade_pagamentos").select("id").eq("mp_payment_id", String(idMp)).maybeSingle()
          if (pg) await sb.rpc("mensalidade_aplicar_pagamento", { p_pagamento: pg.id })
        }
      } else if (tipoMp === "subscription_authorized_payment") {
        const r = await mp(`/authorized_payments/${idMp}`)
        const pre = r.data?.preapproval_id
        if (pre && (r.data?.payment?.status === "approved" || r.data?.status === "processed")) {
          const { data: cfg } = await sb.from("mensalidade_config").select("empresa_id").eq("mp_assinatura_id", pre).maybeSingle()
          if (cfg) await aplicarCobrancaDoCartao(sb, cfg.empresa_id, String(r.data?.payment?.id ?? idMp), Number(r.data?.transaction_amount ?? 0))
        }
      } else if (tipoMp === "subscription_preapproval" || tipoMp === "preapproval") {
        const r = await mp(`/preapproval/${idMp}`)
        if (r.data?.status) await sb.from("mensalidade_config").update({ mp_assinatura_status: r.data.status }).eq("mp_assinatura_id", String(idMp))
      }
      return json({ ok: true })
    }

    const action = body?.action
    if (action === "cron") return json({ ok: true, avisos: await cronDiario(sb) })
    if (action === "cron_link") return json({ ok: true, envios: await cronLinkWhatsApp(sb) })

    // ── Página pública do link de pagamento (sem login; o token é a chave) ───
    if (action === "link_info" || action === "link_pix" || action === "link_status") {
      const loja = await lojaDoLink(sb, String(body?.token ?? ""))
      if (!loja) return json({ error: "Link inválido." }, 404)
      if (!MP_TOKEN) return json({ error: "O pagamento online ainda não foi ligado pela FWC." }, 503)
      if (action === "link_status" || action === "link_info") await conferirPendentes(sb, loja.empresa_id)
      const hoje = hojeBR()
      const { data: abertas } = await sb.from("mensalidade_cobrancas")
        .select("id, vencimento, referencia, valor").eq("empresa_id", loja.empresa_id).eq("status", "aberta").order("vencimento")
      const vencidas = (abertas ?? []).filter((c: any) => c.vencimento <= hoje)
      if (action === "link_status") {
        // Pago = ESTE PIX foi aprovado (não "não sobrou vencida": quem paga
        // adiantado não tem vencida e a tela confirmaria sem ninguém pagar).
        const { data: pg } = await sb.from("mensalidade_pagamentos").select("status")
          .eq("id", String(body?.pagamento_id ?? "")).eq("empresa_id", loja.empresa_id).maybeSingle()
        return json({ ok: true, pago: pg?.status === "aprovado" })
      }
      if (action === "link_info") {
        return json({
          ok: true, loja: loja.empresas?.nome ?? "Loja", hoje, vencidas,
          proxima: vencidas.length ? null : ((abertas ?? [])[0] ?? null),
          desconto_antecipado: Number(loja.desconto_antecipado ?? 0),
        })
      }
      const r = await gerarPixLoja(sb, loja.empresa_id, { quem: "Link de pagamento (WhatsApp)", antecipar: !vencidas.length })
      return json(r.body, r.status)
    }


    // ── Super ADM: manda o link de pagamento pelo WhatsApp da FWC ────────────
    if (action === "enviar_link") {
      const tk = (req.headers.get("Authorization") ?? "").replace("Bearer ", "")
      const { data: { user: su } } = await sb.auth.getUser(tk)
      if (!su) return json({ error: "Faça login de novo." }, 401)
      const { data: sp } = await sb.from("profiles").select("id, nome, perfil").eq("id", su.id).maybeSingle()
      if (sp?.perfil !== "super_admin") return json({ error: "Só o Super ADM." }, 403)
      const empId = String(body?.empresa_id ?? "")
      const tel = String(body?.telefone ?? "").replace(/\D/g, "")
      if (tel.length < 10) return json({ error: "Digite o número com DDD." }, 400)
      const { data: cfg } = await sb.from("mensalidade_config").select("link_token, empresas(nome)").eq("empresa_id", empId).maybeSingle()
      if (!cfg) return json({ error: "Essa loja não tem cobrança configurada." }, 400)
      const hoje = hojeBR()
      const { data: abertas } = await sb.from("mensalidade_cobrancas")
        .select("id, vencimento, referencia, valor").eq("empresa_id", empId).eq("status", "aberta").order("vencimento")
      const vencidas = (abertas ?? []).filter((c: any) => c.vencimento <= hoje)
      const lista = vencidas.length ? vencidas : (abertas ?? []).slice(0, 1)
      if (!lista.length) return json({ error: "Não há mensalidade em aberto." }, 400)
      const total = lista.reduce((s: number, c: any) => s + Number(c.valor), 0)
      const texto = textoLink(cfg.empresas?.nome, cfg.link_token, lista, vencidas.length > 0)
      const envio: any = await enviarEvolution(sb, tel, texto)
      await sb.from("mensalidade_avisos").insert({
        empresa_id: empId, cobranca_id: lista[0].id, tipo: "whatsapp_link", profile_id: sp.id,
        quem: `${sp.nome ?? "Super ADM"} (Super ADM)`,
        detalhe: envio.erro ? `Falhou: ${envio.erro}` : `Link enviado pro ${tel} (${valorBr(total)})`,
      }).then(() => {}, () => {})
      if (envio.erro) return json({ error: `Não consegui enviar: ${envio.erro}` }, 502)
      return json({ ok: true, telefone: envio.telefone, link })
    }

    // ── Daqui pra baixo: só o ADMIN logado da loja ───────────────────────────
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "")
    const { data: { user } } = await sb.auth.getUser(token)
    if (!user) return json({ error: "Faça login de novo." }, 401)
    const { data: prof } = await sb.from("profiles").select("id, nome, perfil, empresa_id").eq("id", user.id).maybeSingle()
    if (!prof?.empresa_id || prof.perfil !== "admin") return json({ error: "Só o administrador da loja." }, 403)
    const empresaId = prof.empresa_id

    if (action === "cartao_chave") return json({ public_key: MP_PUBLIC_KEY || null })

    if (!MP_TOKEN) {
      return json({ error: "O pagamento online ainda não foi ligado pela FWC. Fale com a FWC pelo WhatsApp pra pagar." }, 503)
    }

    if (action === "status") {
      await conferirPendentes(sb, empresaId)
      await conferirAssinatura(sb, empresaId)
      const hoje = hojeBR()
      const { count } = await sb.from("mensalidade_cobrancas").select("id", { count: "exact", head: true })
        .eq("empresa_id", empresaId).eq("status", "aberta").lte("vencimento", hoje)
      // Com o id do PIX na tela: pago = esse PIX foi aprovado (adiantado não tem vencida).
      let pago: boolean | undefined
      if (body?.pagamento_id) {
        const { data: pg } = await sb.from("mensalidade_pagamentos").select("status")
          .eq("id", String(body.pagamento_id)).eq("empresa_id", empresaId).maybeSingle()
        pago = pg?.status === "aprovado"
      }
      return json({ ok: true, em_aberto: count ?? 0, pago })
    }

    if (action === "pix") {
      const r = await gerarPixLoja(sb, empresaId, { email: user.email, profId: prof.id, quem: `${prof.nome} (admin)`, antecipar: !!body?.antecipar })
      return json(r.body, r.status)
    }

    if (action === "assinar") {
      // body: card_token (assinatura), card_token_agora? (cobra o que já venceu),
      //       payment_method_id, email, cpf, final, bandeira
      const { data: cfg } = await sb.from("mensalidade_config")
        .select("valor, periodicidade, mp_assinatura_id").eq("empresa_id", empresaId).maybeSingle()
      if (!cfg || Number(cfg.valor) <= 0) return json({ error: "A cobrança desta loja ainda não foi configurada." }, 400)
      const { data: emp } = await sb.from("empresas").select("nome").eq("id", empresaId).single()
      const email = String(body?.email || user.email || "").trim()
      if (!email) return json({ error: "Informe um e-mail." }, 400)

      // 1) O que já venceu é cobrado agora, no mesmo cartão.
      const hoje = hojeBR()
      const { data: vencidas } = await sb.from("mensalidade_cobrancas")
        .select("id, valor").eq("empresa_id", empresaId).eq("status", "aberta").lte("vencimento", hoje)
      if ((vencidas ?? []).length && body?.card_token_agora) {
        const valor = Math.round(vencidas!.reduce((s: number, c: any) => s + Number(c.valor), 0) * 100) / 100
        const pay = await mp("/v1/payments", "POST", {
          transaction_amount: valor, token: body.card_token_agora, installments: 1,
          payment_method_id: body.payment_method_id, description: `FWC Inter — ${emp?.nome} — mensalidade em aberto`,
          payer: { email, identification: body.cpf ? { type: "CPF", number: String(body.cpf).replace(/\D/g, "") } : undefined },
          external_reference: `mensalidade:${empresaId}`,
          notification_url: `${SUPABASE_URL}/functions/v1/mensalidade`,
          metadata: { tipo: "mensalidade", empresa_id: empresaId },
        })
        if (pay.data?.status !== "approved") {
          return json({ error: `O cartão recusou a cobrança (${pay.data?.status_detail ?? pay.data?.message ?? "sem detalhe"}). Tente outro cartão ou pague no PIX.` }, 402)
        }
        const { data: pg } = await sb.from("mensalidade_pagamentos").insert({
          empresa_id: empresaId, cobranca_ids: vencidas!.map((c: any) => c.id), valor, forma: "cartao",
          status: "pendente", mp_payment_id: String(pay.data.id), criado_por: prof.id,
        }).select("id").single()
        if (pg?.id) await sb.rpc("mensalidade_aplicar_pagamento", { p_pagamento: pg.id })
      }

      // 2) A assinatura cobra as próximas sozinha, a partir do próximo vencimento.
      const { data: proxima } = await sb.from("mensalidade_cobrancas")
        .select("vencimento").eq("empresa_id", empresaId).eq("status", "aberta").gt("vencimento", hoje)
        .order("vencimento").limit(1).maybeSingle()
      const inicio = proxima?.vencimento ? `${proxima.vencimento}T12:00:00.000-03:00` : new Date(Date.now() + 86400000).toISOString()
      const assin = await mp("/preapproval", "POST", {
        reason: `FWC Inter — ${emp?.nome ?? "Loja"} (${cfg.periodicidade})`,
        external_reference: `mensalidade:${empresaId}`,
        payer_email: email,
        card_token_id: body?.card_token,
        auto_recurring: {
          // Quinzenal (dia 1 e 15, mig 0272): o cartão do Mercado Pago só
          // repete em intervalo fixo — de 15 em 15 dias é o mais perto.
          frequency: cfg.periodicidade === "semanal" ? 7 : cfg.periodicidade === "quinzenal" ? 15 : 1,
          frequency_type: cfg.periodicidade === "mensal" ? "months" : "days",
          transaction_amount: Number(cfg.valor),
          currency_id: "BRL",
          start_date: inicio,
        },
        back_url: `${APP_URL}/mensalidade`,
        status: "authorized",
      })
      if (!assin.data?.id) {
        return json({ error: `Não consegui ativar a cobrança no cartão (${assin.data?.message ?? "sem detalhe"}).` }, 502)
      }
      if (cfg.mp_assinatura_id && cfg.mp_assinatura_id !== assin.data.id) {
        await mp(`/preapproval/${cfg.mp_assinatura_id}`, "PUT", { status: "cancelled" })
      }
      await sb.from("mensalidade_config").update({
        mp_assinatura_id: assin.data.id, mp_assinatura_status: assin.data.status,
        cartao_final: body?.final ?? null, cartao_bandeira: body?.bandeira ?? null, atualizado_em: new Date().toISOString(),
      }).eq("empresa_id", empresaId)
      await sb.from("mensalidade_avisos").insert({
        empresa_id: empresaId, tipo: "cartao_cadastrado", profile_id: prof.id, quem: `${prof.nome} (admin)`,
        detalhe: `Cartão ${body?.bandeira ?? ""} final ${body?.final ?? ""} — cobrança automática ${cfg.periodicidade}`,
      }).then(() => {}, () => {})
      return json({ ok: true, status: assin.data.status })
    }

    if (action === "cancelar_cartao") {
      const { data: cfg } = await sb.from("mensalidade_config").select("mp_assinatura_id").eq("empresa_id", empresaId).maybeSingle()
      if (cfg?.mp_assinatura_id) await mp(`/preapproval/${cfg.mp_assinatura_id}`, "PUT", { status: "cancelled" })
      await sb.from("mensalidade_config").update({
        mp_assinatura_id: null, mp_assinatura_status: null, cartao_final: null, cartao_bandeira: null,
      }).eq("empresa_id", empresaId)
      return json({ ok: true })
    }

    return json({ error: "Ação desconhecida." }, 400)
  } catch (e) {
    console.error("[mensalidade]", e)
    return json({ error: "Erro inesperado. Tente de novo." }, 500)
  }
})
