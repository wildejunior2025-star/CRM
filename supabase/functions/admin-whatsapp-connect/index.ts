import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const ADMIN_INSTANCE = "crmadmin"

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  )

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  try {
    const body = await req.json()
    const { action, instanceName: reqInstance } = body

    // Retorna info do remetente atual
    if (action === "current") {
      const { data } = await supabaseAdmin
        .from("config_global").select("valor").eq("chave", "admin_sender_instance").single()
      const instanceName = data?.valor ?? ""
      if (!instanceName) return json({ instanceName: "", state: "none", phone: "" })

      const stateRes = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instanceName}`, {
        headers: { apikey: EVOLUTION_API_KEY },
      }).then(r => r.json()).catch(() => ({}))

      const state = stateRes?.instance?.state ?? stateRes?.state ?? "close"
      const ownerJid = stateRes?.instance?.ownerJid ?? stateRes?.ownerJid ?? ""
      const phone = ownerJid.replace("@s.whatsapp.net", "")
      return json({ instanceName, state, phone })
    }

    // Cria instância admin e retorna QR
    if (action === "create_qr") {
      // Tenta deletar instância antiga se existir
      await fetch(`${EVOLUTION_API_URL}/instance/delete/${ADMIN_INSTANCE}`, {
        method: "DELETE",
        headers: { apikey: EVOLUTION_API_KEY },
      }).catch(() => {})

      // Cria nova instância
      const createRes = await fetch(`${EVOLUTION_API_URL}/instance/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ instanceName: ADMIN_INSTANCE, integration: "WHATSAPP-BAILEYS", qrcode: true }),
      })
      const createData = await createRes.json()

      const qr = createData?.qrcode?.base64 ?? createData?.hash?.qrcode ?? ""
      return json({ ok: true, qr, instanceName: ADMIN_INSTANCE })
    }

    // Verifica status da instância admin (polling após mostrar QR)
    if (action === "check_status") {
      const stateRes = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${ADMIN_INSTANCE}`, {
        headers: { apikey: EVOLUTION_API_KEY },
      }).then(r => r.json()).catch(() => ({}))

      const state = stateRes?.instance?.state ?? stateRes?.state ?? "close"
      const ownerJid = stateRes?.instance?.ownerJid ?? stateRes?.ownerJid ?? ""
      const phone = ownerJid.replace("@s.whatsapp.net", "")

      if (state === "open") {
        // Salva como remetente padrão
        await supabaseAdmin.from("config_global").upsert({
          chave: "admin_sender_instance", valor: ADMIN_INSTANCE, atualizado_em: new Date().toISOString(),
        })
      }
      return json({ state, phone })
    }

    // Reconfigura o webhook de uma instância específica
    if (action === "fix_webhook") {
      const targetInstance = reqInstance ?? "crma95b716bd97342abace9dae0fd1acd62"
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
      const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? ""
      const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/whatsapp-webhook?apikey=${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`
      const res = await fetch(`${EVOLUTION_API_URL}/webhook/set/${targetInstance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({
          webhook: { enabled: true, url: webhookUrl, webhookByEvents: false, webhookBase64: false, events: ["MESSAGES_UPSERT"] }
        }),
      })
      const data = await res.json().catch(() => ({}))
      return json({ ok: res.ok, status: res.status, webhookUrl, data })
    }

    return json({ error: "action inválida" }, 400)
  } catch (err) {
    console.error("admin-whatsapp-connect error:", err)
    return json({ error: String(err) }, 500)
  }
})
