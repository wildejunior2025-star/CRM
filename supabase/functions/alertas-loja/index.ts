import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" }
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
// Instância do WhatsApp da plataforma: vem do banco (config_global
// .admin_sender_instance), não fixa no código — ver resumo-diario.
const FALLBACK_INSTANCE = "crmadmin"

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })
  try {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return json({ ok: false, error: "Evolution API não configurada" }, 503)
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

    let empresaId: string | null = null
    try { empresaId = (await req.json())?.empresa_id ?? null } catch { empresaId = null }

    const { data: cfg } = await sb.from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
    const INSTANCE = (cfg?.valor ?? "").trim() || FALLBACK_INSTANCE

    let q = sb.from("empresas").select("id, nome, telefone_contato").in("status", ["ativo", "trial", "atrasado"])
    if (empresaId) q = q.eq("id", empresaId)
    const { data: empresas } = await q

    let enviadas = 0
    for (const emp of (empresas ?? [])) {
      const fone = (emp.telefone_contato ?? "").replace(/\D/g, "")
      if (fone.length < 10) continue
      try {
        // Itens no/abaixo do estoque mínimo (view estoque_catalogo)
        const { data: cat } = await sb.from("estoque_catalogo")
          .select("nome, quantidade_atual, estoque_minimo").eq("empresa_id", emp.id)
        const baixos = (cat ?? []).filter(p => Number(p.estoque_minimo) > 0 && Number(p.quantidade_atual) <= Number(p.estoque_minimo))
        if (baixos.length === 0) continue

        baixos.sort((a, b) => Number(a.quantidade_atual) - Number(b.quantidade_atual))
        let msg = `🏪 *${emp.nome}* — ⚠️ Alerta de estoque\n\n`
        msg += `${baixos.length} ${baixos.length === 1 ? "item" : "itens"} no/abaixo do mínimo:\n`
        for (const p of baixos.slice(0, 10)) {
          msg += `• ${p.nome} (${Number(p.quantidade_atual)} un · mín ${Number(p.estoque_minimo)})\n`
        }
        if (baixos.length > 10) msg += `…e mais ${baixos.length - 10}.\n`
        msg += `\nReabasteça pra não perder venda. 📦\n_FWC Inter_`

        const num = fone.startsWith("55") ? fone : "55" + fone
        const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${INSTANCE}`, {
          method: "POST", headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: num, text: msg }),
        })
        if (r.ok) enviadas++
        else console.error("envio falhou", emp.nome, await r.text())
      } catch (e) { console.error("erro empresa", emp.id, String(e)) }
    }
    return json({ ok: true, enviadas })
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})
