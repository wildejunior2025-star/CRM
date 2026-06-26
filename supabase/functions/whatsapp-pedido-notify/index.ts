import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

function getMensagem(status: string, tipoEntrega: string, num: string, codigo: string, motivo: string): string | null {
  switch (status) {
    case "confirmado":
      return `✅ *Pedido #${num} confirmado pela loja!*\nSeu pedido está sendo preparado. Em breve você recebe uma atualização! 🎉`
    case "em_preparo":
      return `👨‍🍳 *Pedido #${num} em preparo!*\nFique de olho, logo logo fica pronto!`
    case "saiu_entrega":
      if (tipoEntrega === "retirada") {
        return `🏪 *Pedido #${num} pronto para retirada!*\nPode vir buscar na loja! Seu código de confirmação: *${codigo}* 🎉`
      }
      return `🛵 *Pedido #${num} saiu para entrega!*\nEstá a caminho! Seu código de entrega: *${codigo}*`
    case "entregue":
      return `📦 *Pedido #${num} entregue!*\nEsperamos que tenha gostado! Como foi sua experiência?\n\nAvalie de *1 a 5* ⭐`
    case "cancelado":
      const motivoTxt = motivo ? `\n\n*Motivo:* ${motivo}` : ""
      return `❌ *Pedido #${num} foi cancelado.*${motivoTxt}\n\nQualquer dúvida, entre em contato conosco.`
    default:
      return null
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok")

  try {
    const { pedido_id, novo_status } = await req.json()
    if (!pedido_id || !novo_status) return new Response("ok")

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    const { data: pedido } = await supabase
      .from("pedidos_delivery")
      .select("numero_pedido, cliente_telefone, empresa_id, codigo_entrega, tipo_entrega, motivo_cancelamento")
      .eq("id", pedido_id)
      .single()

    if (!pedido?.cliente_telefone) return new Response("ok")

    const { data: waCfg } = await supabase
      .from("whatsapp_config")
      .select("instance_name")
      .eq("empresa_id", pedido.empresa_id)
      .eq("ativo", true)
      .single()

    if (!waCfg?.instance_name) return new Response("ok")

    const mensagem = getMensagem(
      novo_status,
      pedido.tipo_entrega ?? "entrega",
      String(pedido.numero_pedido ?? ""),
      String(pedido.codigo_entrega ?? ""),
      String(pedido.motivo_cancelamento ?? "")
    )
    if (!mensagem) return new Response("ok")

    const phone = pedido.cliente_telefone.replace(/\D/g, "")
    const phoneWpp = phone.startsWith("55") ? phone : `55${phone}`
    // Evolution entrega BR sem o 9 migratório (13→12 chars): normaliza para bater com whatsapp_conversas
    const phoneHistory = phoneWpp.startsWith("55") && phoneWpp.length === 13
      ? phoneWpp.slice(0, 4) + phoneWpp.slice(5)
      : phoneWpp

    await fetch(`${EVOLUTION_API_URL}/message/sendText/${waCfg.instance_name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phoneWpp, text: mensagem }),
    })

    await supabase.from("whatsapp_conversas").insert({
      empresa_id: pedido.empresa_id,
      phone:      phoneHistory,
      role:       "assistant",
      content:    mensagem,
    })

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
  } catch (err) {
    console.error("Error:", err)
    return new Response("ok")
  }
})
