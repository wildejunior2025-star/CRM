import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Liga o aviso de mensagem nova no WhatsApp da FWC: aponta o webhook da
// instância do admin (Evolution) pra função aviso-fwc-entrada e devolve o que
// estava lá antes. Roda uma vez, na mão, por quem tem a chave de serviço.
//
// Deploy com verify_jwt LIGADO: o portão da Supabase confere a assinatura, e
// aqui só olhamos se o papel é service_role (mesmo esquema do admin-chat).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/[/]$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

serve(async (req) => {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
  let papel = ""
  try {
    const p = jwt.split(".")[1] ?? ""
    papel = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4)))?.role ?? ""
  } catch { /* não é JWT */ }
  if (!jwt || (jwt !== SERVICE_KEY && papel !== "service_role")) return json({ error: "sem permissão" }, 403)

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)
  const { data } = await sb.from("config_global").select("chave, valor")
    .in("chave", ["admin_sender_instance", "aviso_fwc_token"])
  const cfg: Record<string, string> = {}
  for (const r of data ?? []) cfg[r.chave] = String(r.valor ?? "").trim()
  const instancia = cfg.admin_sender_instance || "crmadmin"
  if (!cfg.aviso_fwc_token) return json({ error: "config_global.aviso_fwc_token vazio" }, 400)

  const antes = await fetch(`${EVOLUTION_API_URL}/webhook/find/${instancia}`, {
    headers: { apikey: EVOLUTION_API_KEY },
  }).then(r => r.json()).catch(() => null)

  const url = `${SUPABASE_URL}/functions/v1/aviso-fwc-entrada?token=${cfg.aviso_fwc_token}`
  const res = await fetch(`${EVOLUTION_API_URL}/webhook/set/${instancia}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
    body: JSON.stringify({
      webhook: { enabled: true, url, webhookByEvents: false, webhookBase64: false, events: ["MESSAGES_UPSERT"] },
    }),
  })
  const depois = await res.json().catch(() => ({}))
  return json({ ok: res.ok, instancia, antes, depois })
})
