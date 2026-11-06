// Avisa no WhatsApp do dono da FWC quando uma loja fica dias sem usar o sistema.
// Toda a decisao mora na RPC `lojas_paradas_avisar()` (mig 0440); aqui so
// pergunta e entrega, pela mesma instancia (crmadmin = 99912-0349) e pro mesmo
// destino (aviso_fwc_destino = 99818-0774) dos outros alertas.
// `?forcar=1` manda a lista completa agora, sem marcar como avisado (teste).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
    const url = new URL(req.url)
    const forcar = url.searchParams.get("forcar") === "1"
    const dias = Number(url.searchParams.get("dias") ?? 3) || 3

    const { data: aviso, error } = await sb.rpc("lojas_paradas_avisar", { p_dias: dias, p_forcar: forcar })
    if (error) return json({ ok: false, erro: error.message }, 500)

    const mensagens: string[] = aviso?.mensagens ?? []
    if (!mensagens.length) return json({ ok: true, enviado: 0 })

    const numero = String(aviso?.telefone ?? "").replace(/\D/g, "")
    if (!numero) return json({ ok: false, erro: "sem aviso_fwc_destino configurado" }, 400)
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return json({ ok: false, erro: "sem_evolution", mensagens })

    const { data: cfg } = await sb.from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
    const instancia = (cfg?.valor ?? "").trim() || "crmadmin"

    let enviadas = 0
    for (const texto of mensagens) {
      const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: numero, text: texto }),
      })
      if (r.ok) enviadas++
      else console.error("[loja-parada-alerta] Evolution recusou:", (await r.text()).slice(0, 300))
    }
    return json({ ok: true, enviado: enviadas, de: mensagens.length, para: numero })
  } catch (e) {
    console.error("[loja-parada-alerta] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
