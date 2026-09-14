import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// "DEVOLVER PRO ROBÔ" QUE RESPONDE NA HORA.
//
// O botão só tirava a pausa, e o robô ficava esperando o cliente escrever de
// novo. Na CDBom (14/09/2026) o cliente mandou "Não sei mexe muito não" e "Não
// sei se deu certo 🤔" com o robô pausado; a loja devolveu a conversa e ninguém
// respondeu — as mensagens já tinham chegado.
//
// Aqui: tira a pausa automática, fecha o chamado aberto e, se as últimas
// mensagens da conversa forem do cliente e sem resposta, entrega elas ao robô
// como se tivessem acabado de chegar. Se a última fala foi da loja ou do robô,
// não há o que responder e ele segue esperando.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const CLOUD_TOKEN   = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

// Mensagem do cliente mais velha que isso não é mais "sem resposta": é conversa
// que esfriou, e o robô aparecer do nada seria estranho.
const JANELA_MS = 3 * 60 * 60 * 1000

const digitos = (s: unknown) => String(s ?? "").replace(/[^0-9]/g, "")

function numeroBr(n: string) {
  const d = digitos(n)
  if (d.startsWith("55") && d.length === 12 && /^[6-9]/.test(d.slice(4))) {
    return `55${d.slice(2, 4)}9${d.slice(4)}`
  }
  return d
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)

  try {
    // Quem apertou o botão tem que ser da loja dona da conversa.
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
    const { data: u } = await sb.auth.getUser(jwt)
    if (!u?.user) return json({ ok: false, erro: "sem login" }, 401)
    const { data: perfil } = await sb.from("profiles")
      .select("empresa_id, perfil").eq("id", u.user.id).maybeSingle()
    const empresaId = perfil?.empresa_id
    if (!empresaId || perfil?.perfil === "cliente" || perfil?.perfil === "entregador") {
      return json({ ok: false, erro: "sem permissão" }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const chave = digitos(body.phone).slice(-8)
    if (chave.length < 8) return json({ ok: false, erro: "telefone inválido" }, 400)

    // Pausa automática sai (a manual, expira_em nulo, é decisão da loja e fica).
    await sb.from("whatsapp_bot_pausado").delete()
      .eq("empresa_id", empresaId).like("phone", `%${chave}`).not("expira_em", "is", null)
    // Chamado aberto deixa o robô calado — devolver é dar a conversa por atendida.
    await sb.from("whatsapp_chamados").update({ atendido_em: new Date().toISOString() })
      .eq("empresa_id", empresaId).like("phone", `%${chave}`).is("atendido_em", null)

    const { data: manual } = await sb.from("whatsapp_bot_pausado")
      .select("phone").eq("empresa_id", empresaId).like("phone", `%${chave}`).limit(1)
    if (manual?.length) return json({ ok: true, respondeu: false, motivo: "pausa manual neste número" })

    const { data: cfg } = await sb.from("whatsapp_config")
      .select("instance_name, cloud_phone_number_id, ativo, ia_ativo")
      .eq("empresa_id", empresaId).maybeSingle()
    if (!cfg?.ativo || !cfg.ia_ativo) return json({ ok: true, respondeu: false, motivo: "robô desligado" })

    // O que ficou sem resposta: as mensagens do cliente depois da última fala
    // da loja ou do robô.
    const { data: ultimas } = await sb.from("whatsapp_conversas")
      .select("phone, role, content, created_at")
      .eq("empresa_id", empresaId).like("phone", `%${chave}`)
      .order("created_at", { ascending: false }).limit(20)
    const pendentes: { phone: string; content: string; created_at: string }[] = []
    for (const m of ultimas ?? []) {
      if (m.role !== "user") break
      pendentes.unshift(m)
    }
    if (!pendentes.length) return json({ ok: true, respondeu: false, motivo: "nada sem resposta" })
    const maisNova = pendentes[pendentes.length - 1]
    if (Date.now() - new Date(maisNova.created_at).getTime() > JANELA_MS) {
      return json({ ok: true, respondeu: false, motivo: "mensagens antigas demais" })
    }

    const phone = digitos(maisNova.phone)
    const texto = pendentes.map(m => String(m.content ?? "").trim()).filter(Boolean).join("\n")
    const cloudId = String(cfg.cloud_phone_number_id ?? "")
    const instancia = String(cfg.instance_name ?? "").trim() || `cloud_${String(empresaId).replace(/-/g, "")}`

    // O cérebro de sempre. `_retomada` diz a ele que as mensagens já estão
    // gravadas (não grava de novo nem espera rajada). Na Cloud ele roda em modo
    // teste e devolve a resposta, e quem manda pela Meta é esta função.
    const res = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({
        event: "messages.upsert",
        instance: instancia,
        _retomada: true,
        ...(cloudId ? { _test: true } : {}),
        data: {
          key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false },
          messageType: "conversation",
          message: { conversation: texto },
        },
      }),
    })
    const out = await res.json().catch(() => ({} as Record<string, unknown>))

    if (cloudId) {
      let token = CLOUD_TOKEN
      const { data: tok } = await sb.from("whatsapp_cloud_tokens")
        .select("token").eq("empresa_id", empresaId).maybeSingle()
      if (tok?.token) token = tok.token
      const enviar = (t: string) => fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cloudId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messaging_product: "whatsapp", recipient_type: "individual",
          to: numeroBr(phone), type: "text", text: { body: t, preview_url: true },
        }),
      })
      const resposta = String((out as any)?.resposta ?? "")
      if (resposta && !resposta.startsWith("(")) await enviar(resposta)
      for (const extra of Array.isArray((out as any)?.extraMsgs) ? (out as any).extraMsgs : []) {
        if (extra) await enviar(String(extra))
      }
    }

    return json({ ok: true, respondeu: true, mensagens: pendentes.length })
  } catch (e) {
    return json({ ok: false, erro: String(e) }, 500)
  }
})
