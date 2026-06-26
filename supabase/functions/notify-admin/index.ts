import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" }

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

  const res = await fetch(`${apiBase}/message/sendText/crmadmin`, {
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
