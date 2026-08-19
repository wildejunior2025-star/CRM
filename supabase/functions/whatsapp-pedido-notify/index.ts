import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const CLOUD_TOKEN       = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""   // Meta Cloud API
const GRAPH_VERSION     = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

// Envia texto pela Cloud API (Meta Graph). Usado quando a loja está no cano Cloud.
// Devolve null quando a Meta aceitou, ou o motivo da recusa.
// Atenção: texto livre só é entregue dentro da janela de 24h desde a última
// mensagem do cliente. Fora dela a Meta recusa (erro 131047) e só um template
// aprovado passa — quem pediu pelo site e nunca escreveu no zap não recebe.
async function sendViaCloud(phoneNumberId: string, to: string, text: string): Promise<string | null> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CLOUD_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual",
        to, type: "text", text: { body: text, preview_url: false },
      }),
    })
    if (res.ok) return null
    const corpo = (await res.text()).slice(0, 250)
    console.error("[notify cloud] erro", res.status, corpo)
    return `cloud ${res.status}: ${corpo}`
  } catch (e) {
    return `cloud inacessivel: ${String(e).slice(0, 200)}`
  }
}

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

    // Trava de duplicata: o mesmo pedido+status só avisa UMA vez. Duas gravações
    // quase simultâneas (painel + sincronismo do iFood, por exemplo) disparavam o
    // trigger duas vezes e o cliente recebia a mesma mensagem repetida — agora
    // que o aviso custa crédito, repetir cobraria em dobro. A chave é PK, então
    // quem chegar em segundo lugar leva erro de duplicidade e sai fora.
    {
      const { error: errDedup } = await supabase
        .from("whatsapp_notify_dedup")
        .insert({ id: `${pedido_id}:${novo_status}` })
      if (errDedup) {
        console.log("[notify] duplicata ignorada", pedido_id, novo_status)
        return new Response("ok")
      }
    }

    const { data: pedido } = await supabase
      .from("pedidos_delivery")
      .select("numero_pedido, cliente_telefone, empresa_id, codigo_entrega, tipo_entrega, motivo_cancelamento")
      .eq("id", pedido_id)
      .single()

    if (!pedido?.cliente_telefone) return new Response("ok")

    const { data: waCfg } = await supabase
      .from("whatsapp_config")
      .select("instance_name, cloud_phone_number_id")
      .eq("empresa_id", pedido.empresa_id)
      .eq("ativo", true)
      .single()

    if (!waCfg?.instance_name && !waCfg?.cloud_phone_number_id) return new Response("ok")

    // Aviso de pedido também consome crédito (1 por aviso entregue), igual à
    // conversa do robô. Sem saldo, não manda — senão a loja usaria o canal de
    // graça, e no cano oficial da Meta cada aviso desses é template cobrado.
    const { data: empresaCred } = await supabase
      .from("empresas").select("whatsapp_creditos").eq("id", pedido.empresa_id).single()
    const saldo = Number(empresaCred?.whatsapp_creditos ?? 0)

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

    // Cloud API (Meta) quando a loja está no cano Cloud; senão, Evolution (compat).
    // A resposta do envio IMPORTA: número desconectado ou servidor fora devolvem
    // erro, e sem olhar isso a gente gravava o aviso como enviado e o cliente
    // ficava sem receber, ninguém sabendo.
    let erro: string | null = null
    if (saldo <= 0) {
      // Fica registrado no histórico pra loja entender por que o cliente não
      // recebeu — e pro dono ver que é falta de crédito, não falha técnica.
      erro = "sem credito: aviso nao enviado"
      console.error("[notify] sem credito", pedido.empresa_id, phoneWpp)
    } else if (waCfg.cloud_phone_number_id) {
      erro = await sendViaCloud(String(waCfg.cloud_phone_number_id), phoneWpp, mensagem)
    } else {
      try {
        const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${waCfg.instance_name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: phoneWpp, text: mensagem }),
        })
        if (!res.ok) {
          erro = `evolution ${res.status}: ${(await res.text()).slice(0, 250)}`
        }
      } catch (e) {
        erro = `evolution inacessivel: ${String(e).slice(0, 200)}`
      }
    }
    if (erro) console.error("[notify] aviso NAO enviado", waCfg.instance_name, phoneWpp, erro)

    // Só cobra o que realmente saiu: Evolution fora do ar ou número inválido
    // não debitam crédito nenhum.
    if (!erro) {
      const { error: errCred } = await supabase.rpc("descontar_credito_whatsapp", {
        p_empresa_id: pedido.empresa_id,
        p_descricao: `Aviso de pedido #${pedido.numero_pedido ?? ""} (${novo_status})`,
      })
      if (errCred) console.error("[notify] falha ao debitar credito:", errCred.message)
    }

    await supabase.from("whatsapp_conversas").insert({
      empresa_id: pedido.empresa_id,
      phone:      phoneHistory,
      role:       "assistant",
      content:    mensagem,
      falhou:     !!erro,
      erro,
    })

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
  } catch (err) {
    console.error("Error:", err)
    return new Response("ok")
  }
})
