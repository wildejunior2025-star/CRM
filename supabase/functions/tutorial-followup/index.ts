import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { roboPausado, chamadoAberto } from "../_shared/respostaSemIA.ts"

// VÍDEO TUTORIAL PRO PRIMEIRO CONTATO (mig 0269).
//
// O robô agenda uma linha em tutorial_followup quando responde alguém que
// nunca tinha falado com a loja. Este worker roda de minuto em minuto e, na
// hora marcada (5 min depois), manda o vídeo — só se o cliente continua calado:
// não respondeu, não fez pedido, ninguém da loja assumiu e o robô não foi
// pausado. Qualquer uma dessas, a linha vira "pulado" e nunca sai.
//
// Link do YouTube vai como FOTO (miniatura do oEmbed) com o link na legenda: a
// prévia normal quem monta é o servidor do Evolution, e o YouTube não entrega
// pra servidor (14/09/2026).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const CLOUD_TOKEN       = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION     = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

const VIDEO_PADRAO = "https://www.youtube.com/watch?v=7MshC1_gzNI"
const POR_RODADA = 10

const digitos = (s: unknown) => String(s ?? "").replace(/[^0-9]/g, "")
const chave8 = (s: unknown) => digitos(s).slice(-8)

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

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

  try {
    const { data: fila } = await sb.from("tutorial_followup")
      .select("id, empresa_id, phone, criado_em")
      .eq("status", "pendente").lte("agendado_para", new Date().toISOString())
      .order("agendado_para", { ascending: true }).limit(POR_RODADA)
    if (!fila?.length) return json({ nada: true })

    const marcar = (id: string, campos: Record<string, unknown>) =>
      sb.from("tutorial_followup").update(campos).eq("id", id)
    const resultado: unknown[] = []

    for (const l of fila) {
      const k = chave8(l.phone)
      const pular = async (motivo: string) => {
        await marcar(l.id, { status: "pulado", motivo })
        resultado.push({ phone: l.phone, pulado: motivo })
      }

      if (digitos(l.phone).length < 12 || digitos(l.phone) === "5500000000001") { await pular("número de teste"); continue }

      // Velho demais (worker parado, fila acumulada): mandar horas depois
      // seria mensagem do nada.
      if (Date.now() - new Date(l.criado_em).getTime() > 60 * 60 * 1000) { await pular("passou da hora"); continue }

      const { data: cfg } = await sb.from("whatsapp_config")
        .select("ativo, ia_ativo, tutorial_ativo, tutorial_url, instance_name, cloud_phone_number_id")
        .eq("empresa_id", l.empresa_id).maybeSingle()
      if (!cfg?.ativo || !cfg.ia_ativo || cfg.tutorial_ativo === false) { await pular("desligado"); continue }

      // O cliente escreveu depois da boas-vindas? Então está conversando.
      const { data: respondeu } = await sb.from("whatsapp_conversas")
        .select("id").eq("empresa_id", l.empresa_id).like("phone", `%${k}`)
        .eq("role", "user").gt("created_at", l.criado_em).limit(1)
      if (respondeu?.length) { await pular("cliente respondeu"); continue }

      // Alguém da loja falou com ele (celular ou gestor)?
      const { data: lojaFalou } = await sb.from("whatsapp_conversas")
        .select("id").eq("empresa_id", l.empresa_id).like("phone", `%${k}`)
        .eq("origem", "loja").gt("created_at", l.criado_em).limit(1)
      if (lojaFalou?.length) { await pular("loja assumiu"); continue }

      if (await roboPausado(sb, l.empresa_id, l.phone)) { await pular("robô pausado"); continue }
      if (await chamadoAberto(sb, l.empresa_id, l.phone)) { await pular("chamado aberto"); continue }

      // Já pediu pelo link? Não precisa de tutorial.
      const { data: pedidos } = await sb.from("pedidos_delivery")
        .select("cliente_telefone").eq("empresa_id", l.empresa_id)
        .gte("created_at", l.criado_em).limit(200)
      if ((pedidos ?? []).some(p => chave8(p.cliente_telefone) === k)) { await pular("já pediu"); continue }

      const video = String(cfg.tutorial_url ?? "").trim() || VIDEO_PADRAO
      let titulo = "Como fazer seu pedido"
      let miniatura = ""
      try {
        const oe = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(video)}`)
        if (oe.ok) {
          const info = await oe.json()
          titulo = info?.title || titulo
          miniatura = info?.thumbnail_url || ""
        }
      } catch (_e) { /* sem miniatura, vai texto */ }

      const texto = `Tá com dificuldade de comprar pelo link? 😊\nAssiste esse tutorial rapidinho:\n\n▶️ *${titulo}*\n\n${video}`

      let ok = false
      let erro = ""
      try {
        const cloudId = String(cfg.cloud_phone_number_id ?? "")
        let res: Response
        if (cloudId) {
          let token = CLOUD_TOKEN
          const { data: tok } = await sb.from("whatsapp_cloud_tokens")
            .select("token").eq("empresa_id", l.empresa_id).maybeSingle()
          if (tok?.token) token = tok.token
          // Na Meta a prévia do link sai sozinha (preview_url).
          res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cloudId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              messaging_product: "whatsapp", recipient_type: "individual",
              to: numeroBr(l.phone), type: "text", text: { body: texto, preview_url: true },
            }),
          })
        } else if (miniatura) {
          res = await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${cfg.instance_name}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({
              number: l.phone, mediatype: "image", mimetype: "image/jpeg",
              fileName: "tutorial.jpg", media: miniatura, caption: texto,
            }),
          })
        } else {
          res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${cfg.instance_name}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({ number: l.phone, text: texto, linkPreview: true }),
          })
        }
        ok = res.ok
        if (!ok) erro = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`
      } catch (e) {
        erro = String(e)
      }

      if (!ok) {
        await marcar(l.id, { status: "falhou", motivo: erro })
        resultado.push({ phone: l.phone, falhou: erro })
        continue
      }

      await marcar(l.id, { status: "enviado", enviado_em: new Date().toISOString() })
      await sb.from("whatsapp_conversas").insert({
        empresa_id: l.empresa_id, phone: l.phone, role: "assistant", content: texto,
      })
      // Espelho no gestor, marcado como fala do robô.
      try {
        const { data: conversa } = await sb.from("mensagens_chat")
          .select("canal, cliente_ref, cliente_nome")
          .eq("empresa_id", l.empresa_id).like("cliente_ref", `%${k}`)
          .order("created_at", { ascending: false }).limit(1).maybeSingle()
        await sb.from("mensagens_chat").insert({
          empresa_id: l.empresa_id,
          canal: conversa?.canal ?? "whatsapp",
          cliente_ref: conversa?.cliente_ref ?? digitos(l.phone),
          cliente_nome: conversa?.cliente_nome ?? null,
          remetente: "loja", texto, bot: true,
        })
      } catch (_e) { /* espelho é bônus */ }
      resultado.push({ phone: l.phone, enviado: true })
    }

    return json({ resultado })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
