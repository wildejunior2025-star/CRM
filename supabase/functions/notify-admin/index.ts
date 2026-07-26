import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors ={ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })

  const apiBase = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
  const apiKey  = Deno.env.get("EVOLUTION_API_KEY") ?? ""

  if (!apiBase || !apiKey) {
    return new Response(JSON.stringify({ error: "Evolution API não configurada" }), {
      status: 503, headers: { ...cors, "Content-Type": "application/json" }
    })
  }

  const { phone, message } = await req.json()
  if (!phone || !message) {
    return new Response(JSON.stringify({ error: "phone e message obrigatórios" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" }
    })
  }

  let num = phone.replace(/\D/g, "")
  if (!num.startsWith("55")) num = "55" + num

  // Instância da plataforma vem do banco (o Super Admin salva ao parear o QR).
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
  const { data: cfg } = await sb.from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
  const instance = (cfg?.valor ?? "").trim() || "crmadmin"

  const res = await fetch(`${apiBase}/message/sendText/${instance}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ number: num, text: message }),
  })

  const body = await res.text()
  return new Response(body, {
    status: res.status,
    headers: { ...cors, "Content-Type": "application/json" }
  })
})
