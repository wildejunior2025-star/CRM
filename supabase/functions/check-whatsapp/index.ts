import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""

// Consulta (sem enviar mensagem) se cada numero existe no WhatsApp.
// Usa a instancia Evolution do admin (config_global.admin_sender_instance).
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  try {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return json({ error: "Evolution nao configurada" }, 500)

    const body = await req.json().catch(() => ({}))
    const numbers: string[] = (body.numbers ?? []).map((n: string) => String(n).replace(/\D/g, "")).filter(Boolean)
    if (!numbers.length) return json({ error: "informe numbers[]" }, 400)

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    let instance = body.instance as string | undefined
    if (!instance) {
      const { data } = await supabaseAdmin
        .from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
      instance = data?.valor ?? "crmadmin"
    }

    const stateRes = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instance}`, {
      headers: { apikey: EVOLUTION_API_KEY },
    }).then(r => r.json()).catch(() => ({}))
    const state = stateRes?.instance?.state ?? stateRes?.state ?? "close"
    if (state !== "open") return json({ error: "instancia desconectada", instance, state, detalhe: stateRes }, 409)

    const res = await fetch(`${EVOLUTION_API_URL}/chat/whatsappNumbers/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ numbers }),
    })
    const data = await res.json()
    return json({ instance, state, ok: res.ok, resultado: data })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
