// whatsapp-cloud — "cano" novo do WhatsApp via Cloud API oficial da Meta.
//
// Por que existe: o Evolution segura cada número na RAM e só aguenta ~5-10 lojas
// ao mesmo tempo. No Cloud API a Meta hospeda as conexões → escala pra 50-100+.
//
// Arquitetura (sem duplicar o cérebro e sem tocar no Evolution):
//   1. Recebe o webhook da Meta.
//   2. Acha a loja pelo cloud_phone_number_id (whatsapp_config).
//   3. Chama o whatsapp-webhook em modo _test — ele roda TODO o cérebro
//      (Claude, carrinho, cadastro, CEP, fechar pedido) e devolve a resposta
//      SEM enviar pelo Evolution.
//   4. Envia a resposta ao cliente pela Graph API da Meta.
//
// MVP: trata texto. Áudio/imagem/PIX-QR entram numa próxima etapa (precisam do
// download/upload de mídia pela Graph API).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const CLOUD_TOKEN   = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""       // token permanente (System User)
const VERIFY_TOKEN  = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? ""      // token que a gente define no webhook
const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

// ── Envio de texto pela Graph API ────────────────────────────────────────────
async function sendText(phoneNumberId: string, to: string, text: string) {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CLOUD_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text, preview_url: true },
      }),
    })
    if (!res.ok) console.error("[cloud send] erro", res.status, (await res.text()).slice(0, 400))
  } catch (e) {
    console.error("[cloud send] exceção", String(e))
  }
}

// ── Processa uma mensagem recebida ───────────────────────────────────────────
async function processar(body: any) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  const value   = body?.entry?.[0]?.changes?.[0]?.value
  const phoneNumberId = value?.metadata?.phone_number_id
  const message = value?.messages?.[0]
  if (!phoneNumberId || !message) return          // status de entrega / outros eventos: ignora

  const from = String(message.from ?? "").replace(/\D/g, "")
  if (!from) return

  // Acha a loja dona desse número
  const { data: cfg } = await supabase
    .from("whatsapp_config")
    .select("instance_name, cloud_phone_number_id, ativo")
    .eq("cloud_phone_number_id", phoneNumberId)
    .eq("ativo", true)
    .maybeSingle()
  if (!cfg) { console.error("[cloud] nenhuma loja para phone_number_id", phoneNumberId); return }
  const instanceName = cfg.instance_name ?? `cloud_${phoneNumberId}`

  // Extrai o texto (MVP: texto e botões/listas)
  let text = ""
  if (message.type === "text") {
    text = String(message.text?.body ?? "").trim()
  } else if (message.type === "interactive") {
    text = String(
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ?? ""
    ).trim()
  } else {
    // áudio/imagem/documento ainda não suportados por aqui
    await sendText(phoneNumberId, from, "Oi! 😊 Por enquanto consigo te atender melhor por *texto*. Pode escrever o que você precisa?")
    return
  }
  if (!text) return

  // Chama o cérebro (whatsapp-webhook) em modo _test — roda tudo e devolve a
  // resposta, sem enviar pelo Evolution.
  const payload = {
    event: "messages.upsert",
    instance: instanceName,
    _test: true,
    data: {
      key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false },
      messageType: "conversation",
      message: { conversation: text },
    },
  }

  let resposta = ""
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "x-bot-test": "1",
      },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({} as any))
    resposta = data?.resposta ?? ""
    // Loja fechada: o cérebro salva a mensagem mas não a devolve no corpo — busca a última do bot
    if (!resposta && data?.fechado) {
      const { data: ult } = await supabase
        .from("whatsapp_conversas")
        .select("content")
        .eq("phone", from)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      resposta = ult?.content ?? ""
    }
  } catch (e) {
    console.error("[cloud] erro ao chamar o cérebro", String(e))
  }

  if (resposta) await sendText(phoneNumberId, from, resposta)
}

// ── serve ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  const url = new URL(req.url)

  // Verificação do webhook exigida pela Meta (GET com hub.challenge)
  if (req.method === "GET") {
    const mode      = url.searchParams.get("hub.mode")
    const token     = url.searchParams.get("hub.verify_token")
    const challenge = url.searchParams.get("hub.challenge")
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge ?? "", { status: 200 })
    }
    return new Response("forbidden", { status: 403 })
  }

  if (req.method !== "POST") return new Response("ok", { status: 200 })

  let body: any = null
  try { body = await req.json() } catch { return new Response("ok", { status: 200 }) }

  // A Meta exige 200 rápido — responde já e processa em background.
  const work = processar(body).catch((e) => console.error("[cloud] processar exceção", String(e)))
  // @ts-ignore EdgeRuntime existe no runtime Deno da Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(work)
  } else {
    await work
  }

  return new Response("ok", { status: 200 })
})
