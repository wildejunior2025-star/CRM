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
// O número recebe WhatsApp?
//
// O iFood NÃO entrega o telefone do cliente: ele manda o 0800 da central dele
// ("0800 200 5011"). A loja recebia esse número como se fosse do cliente e o
// sistema mandava aviso de pedido pra ele a cada troca de status. Só no Zebu
// foram 4.094 mensagens em 30 dias — 70% de tudo que saiu — para 12 números
// que não existem no WhatsApp. Ninguém recebeu nada, e do lado da loja parecia
// que o cliente tinha sido avisado.
//
// Regra: depois de tirar o 55, o que sobra tem que ser um telefone brasileiro
// de 10 ou 11 dígitos com DDD de verdade. Os 10 dígitos ficam valendo de
// propósito — o WhatsApp entrega muito celular sem o 9 migratório, e barrar
// isso calaria cliente de verdade pra resolver problema de 0800.
function recebeWhatsapp(phoneRaw: string): boolean {
  const d = String(phoneRaw ?? "").replace(/\D/g, "")
  const local = d.startsWith("55") ? d.slice(2) : d
  if (local.length !== 10 && local.length !== 11) return false
  if (local.startsWith("0")) return false           // 0800, 0300, 0500: central, não celular
  const ddd = Number(local.slice(0, 2))
  if (!(ddd >= 11 && ddd <= 99)) return false
  return true
}

// Devolve { erro, id }: o id é o wamid da Meta, que o webhook de status usa
// depois pra dizer se ENTREGOU (mig 0215). A Meta responde 200 na hora mesmo
// quando vai recusar a mensagem um minuto depois.
async function sendViaCloud(phoneNumberId: string, to: string, text: string): Promise<{ erro: string | null, id: string | null }> {
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CLOUD_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual",
        to, type: "text", text: { body: text, preview_url: false },
      }),
    })
    const corpo = await res.json().catch(() => ({} as any))
    if (res.ok) return { erro: null, id: corpo?.messages?.[0]?.id ?? null }
    console.error("[notify cloud] erro", res.status, JSON.stringify(corpo).slice(0, 250))
    return { erro: `cloud ${res.status}: ${JSON.stringify(corpo).slice(0, 250)}`, id: null }
  } catch (e) {
    return { erro: `cloud inacessivel: ${String(e).slice(0, 200)}`, id: null }
  }
}

function getMensagem(status: string, tipoEntrega: string, num: string, codigo: string, motivo: string): string | null {
  switch (status) {
    case "confirmado":
      return `✅ *Pedido #${num} confirmado pela loja!*\nSeu pedido está sendo preparado. Em breve você recebe uma atualização! 🎉`
    case "em_preparo":
      return `👨‍🍳 *Pedido #${num} em preparo!*\nFique de olho, logo logo fica pronto!`
    // Sem código o pedido segue normal — a loja pode ter desligado o código de
    // entrega no Super Admin. Sem esse cuidado o cliente receberia a frase pela
    // metade: "Seu código de entrega: **".
    case "saiu_entrega":
      if (tipoEntrega === "retirada") {
        return `🏪 *Pedido #${num} pronto para retirada!*\nPode vir buscar na loja! 🎉` +
          (codigo ? `\nSeu código de confirmação: *${codigo}*` : "")
      }
      return `🛵 *Pedido #${num} saiu para entrega!*\nEstá a caminho!` +
        (codigo ? `\nSeu código de entrega: *${codigo}*` : "")
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
      .select("numero_pedido, cliente_telefone, empresa_id, codigo_entrega, tipo_entrega, motivo_cancelamento, agendado_para")
      .eq("id", pedido_id)
      .single()

    if (!pedido?.cliente_telefone) return new Response("ok")

    const { data: waCfg } = await supabase
      .from("whatsapp_config")
      .select("instance_name, cloud_phone_number_id, cloud_waba_id")
      .eq("empresa_id", pedido.empresa_id)
      .eq("ativo", true)
      .single()

    if (!waCfg?.instance_name && !waCfg?.cloud_phone_number_id) return new Response("ok")

// Cloud SÓ com a conta completa (WABA). Um phone_number_id sozinho é setup
// pela metade — número de teste da Meta, que só fala com uma lista de
// permitidos. A CD Bom tinha um desses parado no cadastro: as mensagens dela
// saíam pelo Cloud e voltavam "131030 Recipient phone number not in allowed
// list", enquanto o WhatsApp de verdade dela (o do servidor) estava ali do
// lado, funcionando. 22 avisos perdidos em 30 dias, calados.
    const usaCloud = !!(waCfg.cloud_phone_number_id && waCfg.cloud_waba_id)

    // Aviso de status é módulo de mensalidade, NÃO consome crédito: o texto é
    // pronto, não passa por IA. Crédito continua sendo só do robô, que gasta
    // IA a cada mensagem lida. Quem não contratou o módulo tem `avisos: false`
    // em empresas.modulos — ausente = ligado, pra não quebrar quem já usa.
    const { data: empresaMod } = await supabase
      .from("empresas").select("modulos").eq("id", pedido.empresa_id).single()
    const avisosAtivos = (empresaMod?.modulos ?? {}).avisos !== false

    let mensagem = getMensagem(
      novo_status,
      pedido.tipo_entrega ?? "entrega",
      String(pedido.numero_pedido ?? ""),
      String(pedido.codigo_entrega ?? ""),
      String(pedido.motivo_cancelamento ?? "")
    )
    if (!mensagem) return new Response("ok")

    // Pedido agendado (mig 0222): sem essa linha, o "seu pedido foi aceito,
    // chega em 40 min" contradiz a hora que o proprio cliente escolheu.
    if (pedido.agendado_para && !["entregue", "cancelado"].includes(novo_status)) {
      const d = new Date(pedido.agendado_para)
      const dia = d.toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit" })
      const hora = d.toLocaleTimeString("pt-BR", { timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" })
      const hojeBR = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit" })
      mensagem += `

🗓️ *Agendado para ${dia === hojeBR ? "hoje" : dia} às ${hora}* — é nesse horário que a gente prepara.`
    }

    // Cashback e indicacao (mig 0177): so no "entregue", e so quando a loja
    // ligou o programa. Vai anexado ao aviso que ele ja ia receber - mandar uma
    // segunda mensagem gastaria outra janela de 24h e pareceria spam.
    //
    // Quem NAO ganhou nada tambem recebe: e o convite pra indicar. Sem isso o
    // cliente so descobre que tem um link se o lojista mandar um por um, e o
    // programa nunca sai do lugar.
    //
    // O link e sempre do lojaonline: a rota /c/<token> existe nos dois
    // dominios, mas quem recebe precisa de um endereco que funcione sozinho.
    if (novo_status === "entregue") {
      try {
        const { data: cb } = await supabase.rpc("pedido_cashback", { p_pedido_id: pedido_id })
        if (cb?.ativo && cb?.token) {
          const link   = `https://lojaonline.fwcinter.com/c/${cb.token}`
          const ganhou = Number(cb.ganhou ?? 0)
          const reais  = (v: number) => Number(v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })

          mensagem += ganhou > 0
            ? [
                "",
                `🎁 *Voce ganhou R$ ${reais(ganhou)} de cashback!*`,
                `Seu saldo na loja: *R$ ${reais(cb.saldo)}*. E so avisar na hora de pagar que a gente desconta.`,
                "",
                "Veja seu saldo e indique amigos pra ganhar mais:",
                link,
              ].join("\n")
            : [
                "",
                `🎟️ *Indique e ganhe ${Number(cb.pct_indicacao ?? 0).toLocaleString("pt-BR")}%*`,
                "Chame um amigo pelo seu link: quando ele fizer a primeira compra, voces dois ganham credito aqui.",
                link,
              ].join("\n")
        }
      } catch (e) {
        // Aviso de pedido nao pode cair por causa do cashback.
        console.error("[notify] cashback falhou", String(e).slice(0, 200))
      }
    }

    const phone = pedido.cliente_telefone.replace(/\D/g, "")
    const phoneWpp = phone.startsWith("55") ? phone : `55${phone}`

    // Número que não recebe WhatsApp (o 0800 do iFood, por exemplo): sai daqui
    // sem mandar e sem gravar. Gravar criaria uma "conversa" com a central do
    // iFood na caixa de entrada da loja, cheia de mensagem que ninguém leu.
    if (!recebeWhatsapp(phoneWpp)) {
      console.log("[notify] numero nao recebe whatsapp, aviso nao enviado:", phoneWpp)
      return new Response(JSON.stringify({ ok: true, ignorado: "numero nao recebe whatsapp" }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    // Evolution entrega BR sem o 9 migratório (13→12 chars): normaliza para bater com whatsapp_conversas
    const phoneHistory = phoneWpp.startsWith("55") && phoneWpp.length === 13
      ? phoneWpp.slice(0, 4) + phoneWpp.slice(5)
      : phoneWpp

    // Cloud API (Meta) quando a loja está no cano Cloud; senão, Evolution (compat).
    // A resposta do envio IMPORTA: número desconectado ou servidor fora devolvem
    // erro, e sem olhar isso a gente gravava o aviso como enviado e o cliente
    // ficava sem receber, ninguém sabendo.
    let erro: string | null = null
    let messageId: string | null = null
    if (!avisosAtivos) {
      // Fica registrado no histórico pra loja entender por que o cliente não
      // recebeu — e pro dono ver que é módulo desligado, não falha técnica.
      erro = "modulo de avisos desligado para esta loja"
      console.error("[notify] modulo avisos off", pedido.empresa_id, phoneWpp)
    } else if (usaCloud) {
      const envio = await sendViaCloud(String(waCfg.cloud_phone_number_id), phoneWpp, mensagem)
      erro = envio.erro
      messageId = envio.id
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


    await supabase.from("whatsapp_conversas").insert({
      empresa_id: pedido.empresa_id,
      phone:      phoneHistory,
      role:       "assistant",
      content:    mensagem,
      falhou:     !!erro,
      erro,
      message_id: messageId,
    })

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } })
  } catch (err) {
    console.error("Error:", err)
    return new Response("ok")
  }
})
