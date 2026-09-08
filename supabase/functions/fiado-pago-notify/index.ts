// "Recebemos seu pagamento" no WhatsApp do cliente, na hora em que o fiado é pago.
//
// O outro lado do fiado-comanda-notify
// ------------------------------------
// Quando a conta fecha no fiado o cliente recebe a comanda pra conferir. Quando
// ele PAGA, não recebia nada — a loja dava baixa e ele ia embora sem nenhum
// comprovante de que a dívida saiu. É a hora em que o comprovante vale mais:
// acaba a dúvida de "será que deram baixa?" e ele fica com a conta zerada por
// escrito, sem precisar acreditar na palavra de ninguém.
//
// Chamado de dois lugares, porque fiado se paga de dois jeitos:
//   • Financeiro → Fiado, quando a atendente registra o recebimento;
//   • PIX pelo link do cliente, quando o Mercado Pago confirma (mercadopago-webhook).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const CLOUD_TOKEN       = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION     = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Mesma regra do aviso de compra: o que sobra depois do 55 tem que ser telefone
// brasileiro de 10 ou 11 dígitos, com DDD de verdade e sem começar com 0.
function recebeWhatsapp(phoneRaw: string): boolean {
  const d = String(phoneRaw ?? "").replace(/\D/g, "")
  const local = d.startsWith("55") ? d.slice(2) : d
  if (local.length !== 10 && local.length !== 11) return false
  if (local.startsWith("0")) return false
  const ddd = Number(local.slice(0, 2))
  return ddd >= 11 && ddd <= 99
}

// Template aprovado na conta da loja — o único jeito de falar com quem não
// escreveu nas últimas 24h. Criado junto com o comanda_fiado, no signup.
const TEMPLATE_PAGO = "fiado_pago"
const TEMPLATE_IDIOMA = "pt_BR"

function brl(v: unknown): string {
  return "R$ " + Number(v ?? 0).toFixed(2).replace(".", ",")
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
  const responde = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  try {
    const { cliente_id, empresa_id, valor } = await req.json()
    if (!cliente_id || !empresa_id) return responde({ ok: false, erro: "cliente_id e empresa_id obrigatórios" })
    const pago = Number(valor ?? 0)
    if (!(pago > 0)) return responde({ ok: true, ignorado: "valor zerado" })

    // Interruptor por loja: quem não ligou não manda nada. No WhatsApp oficial
    // cada aviso fora da janela é cobrado, então isso não pode ser automático.
    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("instance_name, cloud_phone_number_id, cloud_waba_id, ativo, notif_fiado_pago")
      .eq("empresa_id", empresa_id)
      .maybeSingle()
    if (!cfg?.ativo || !cfg?.notif_fiado_pago) {
      return responde({ ok: true, ignorado: "aviso de fiado pago desligado nesta loja" })
    }

    const { data: cliente } = await supabase
      .from("clientes").select("nome, telefone, token").eq("id", cliente_id).maybeSingle()

    const phone = String(cliente?.telefone ?? "").replace(/\D/g, "")
    const phoneFull = phone.startsWith("55") ? phone : `55${phone}`
    if (!recebeWhatsapp(phoneFull)) {
      // Cliente de fiado sem telefone é comum (cadastro feito às pressas no
      // balcão). Não é erro — só não dá pra avisar.
      return responde({ ok: true, ignorado: "cliente sem telefone valido" })
    }

    const { data: empresa } = await supabase
      .from("empresas").select("nome").eq("id", empresa_id).maybeSingle()

    // O saldo é lido DEPOIS da baixa: é ele que decide se a mensagem diz
    // "quitado" ou "ainda falta tanto". Ler antes diria o número errado.
    const { data: saldoRow } = await supabase
      .from("clientes_saldo_fiado").select("saldo_fiado").eq("cliente_id", cliente_id).maybeSingle()
    const resta = Number(saldoRow?.saldo_fiado ?? 0)
    const quitado = resta <= 0.005

    const agora = new Date()
    const quando = `${agora.toLocaleString("pt-BR", { timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit" })}`
      + ` às ${agora.toLocaleString("pt-BR", { timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" })}`

    const primeiroNome = String(cliente?.nome ?? "").trim().split(" ")[0]
    const saudacao = primeiroNome
      ? `Oi ${primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1)}!`
      : "Oi!"

    // A frase do saldo é a informação que o cliente quer de verdade: acabou ou
    // não acabou. Vai numa linha só, porque é ela que vira parâmetro do template.
    const situacao = quitado
      ? "Sua conta está *quitada*, não ficou nada em aberto. ✅"
      : `Ainda ficou *${brl(resta)}* em aberto.`

    const mensagem = [
      `${saudacao} Aqui é da *${empresa?.nome ?? "loja"}*.`,
      "",
      `Recebemos o seu pagamento de *${brl(pago)}* em ${quando}. Obrigado! 🙏`,
      "",
      situacao,
      cliente?.token
        ? `\nO seu histórico completo está no seu link:\nhttps://lojaonline.fwcinter.com/c/${cliente.token}`
        : null,
    ].filter(l => l !== null).join("\n")

    // A JANELA DE 24 HORAS — mesma história do aviso de compra: a Meta só aceita
    // texto livre até 24h depois da última mensagem DO CLIENTE. Fora disso ela
    // responde 200 e joga fora depois (erro 131047), a falha que se disfarça de
    // sucesso. Por isso a escolha é feita ANTES, não por tentativa e erro.
    // 20h de margem cobre o tempo entre decidir aqui e a Meta entregar.
    const chave = phoneFull.slice(-8)
    const { data: ultimaDele } = await supabase
      .from("whatsapp_conversas")
      .select("created_at")
      .eq("empresa_id", empresa_id)
      .eq("role", "user")
      .like("phone", `%${chave}`)
      .gte("created_at", new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle()
    const janelaAberta = !!ultimaDele

    let erro: string | null = null
    let messageId: string | null = null

    // Cloud SÓ com a conta completa (WABA). Um phone_number_id sozinho é número
    // de teste da Meta, que só fala com uma lista de permitidos.
    if (cfg.cloud_phone_number_id && cfg.cloud_waba_id) {
      let token = CLOUD_TOKEN
      const { data: tok } = await supabase
        .from("whatsapp_cloud_tokens").select("token").eq("empresa_id", empresa_id).maybeSingle()
      if (tok?.token) token = tok.token

      // Parâmetro de template não aceita quebra de linha nem asterisco solto:
      // a versão do template vai sem formatação.
      const situacaoLisa = quitado
        ? "Sua conta está quitada, não ficou nada em aberto."
        : `Ainda ficou ${brl(resta)} em aberto.`

      const corpoEnvio = janelaAberta
        ? {
            messaging_product: "whatsapp", recipient_type: "individual",
            to: phoneFull, type: "text", text: { body: mensagem, preview_url: false },
          }
        : {
            messaging_product: "whatsapp", recipient_type: "individual",
            to: phoneFull, type: "template",
            template: {
              name: TEMPLATE_PAGO,
              language: { code: TEMPLATE_IDIOMA },
              components: [{
                type: "body",
                parameters: [
                  { type: "text", text: primeiroNome || "tudo bem" },
                  { type: "text", text: empresa?.nome ?? "loja" },
                  { type: "text", text: brl(pago) },
                  { type: "text", text: quando },
                  { type: "text", text: situacaoLisa },
                ],
              }],
            },
          }

      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.cloud_phone_number_id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(corpoEnvio),
      })
      const corpo = await res.json().catch(() => ({} as any))
      if (!res.ok) erro = `cloud ${res.status}: ${JSON.stringify(corpo).slice(0, 250)}`
      else messageId = corpo?.messages?.[0]?.id ?? null
    } else {
      try {
        const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${cfg.instance_name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: phoneFull, text: mensagem }),
        })
        if (!res.ok) erro = `evolution ${res.status}: ${(await res.text()).slice(0, 250)}`
      } catch (e) {
        erro = `evolution inacessivel: ${String(e).slice(0, 200)}`
      }
    }

    if (erro) console.error("[fiado] recibo NAO enviado", cliente_id, phoneFull, erro)

    // Entra no histórico mesmo quando falha: é assim que a loja descobre que o
    // cliente NÃO foi avisado, em vez de descobrir na discussão.
    await supabase.from("whatsapp_conversas").insert({
      empresa_id, phone: phoneFull, role: "assistant",
      content: mensagem, falhou: !!erro, erro, message_id: messageId,
    })

    console.log("[fiado] recibo", cliente_id, janelaAberta ? "texto livre" : "template", erro ? "FALHOU" : "ok")
    return responde({ ok: !erro, erro })
  } catch (err) {
    console.error("[fiado] erro no recibo:", err)
    return responde({ ok: false, erro: String(err) })
  }
})
