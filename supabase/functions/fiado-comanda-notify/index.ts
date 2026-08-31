// Comanda do FIADO no WhatsApp do cliente, na hora em que a conta é fechada.
//
// O problema que isto resolve (Estação do Sabor, agosto/2026)
// ----------------------------------------------------------
// Fiado gera discussão: dias depois o cliente diz que não comprou aquilo, e não
// tem como saber se foi ele que esqueceu ou se a atendente anotou na conta
// errada. Ninguém lembra de um almoço de duas semanas atrás.
//
// Mandar a comanda NO DIA resolve os dois lados: o cliente confere na hora, com
// a memória fresca, e a loja fica com a prova de que avisou. Se a anotação foi
// errada mesmo, dá pra corrigir enquanto ainda é fácil.
//
// Só FIADO. Dinheiro, PIX e cartão o cliente já pagou e foi embora — mandar
// comprovante do que ele quitou é só barulho no WhatsApp dele.
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

// O número recebe WhatsApp? Mesma regra do aviso de pedido: o que sobra depois
// do 55 tem que ser telefone brasileiro de 10 ou 11 dígitos, com DDD de verdade
// e sem começar com 0 (0800 é central, não celular). Os 10 dígitos valem de
// propósito — muito celular chega sem o 9 migratório.
function recebeWhatsapp(phoneRaw: string): boolean {
  const d = String(phoneRaw ?? "").replace(/\D/g, "")
  const local = d.startsWith("55") ? d.slice(2) : d
  if (local.length !== 10 && local.length !== 11) return false
  if (local.startsWith("0")) return false
  const ddd = Number(local.slice(0, 2))
  return ddd >= 11 && ddd <= 99
}

function brl(v: unknown): string {
  return "R$ " + Number(v ?? 0).toFixed(2).replace(".", ",")
}

// "1" em vez de "1.00", mas "0,5" continua "0,5" (almoço no peso, granel).
function qtd(v: unknown): string {
  const n = Number(v ?? 1)
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",")
}

// De onde veio a conta, pra pessoa se localizar: "Comanda 33", "Mesa 4".
// Sai do texto que o fechamento grava em vendas.observacoes.
function ondeFoi(observacoes: string | null): string {
  const s = String(observacoes ?? "")
  const m = s.match(/(Comanda\s+\S+|Mesa\s+\S+)/i)
  return m ? m[1].replace(/·.*$/, "").trim() : ""
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

  try {
    const { venda_id } = await req.json()
    if (!venda_id) return new Response(JSON.stringify({ ok: false, erro: "venda_id obrigatório" }), { headers: corsHeaders })

    const { data: venda } = await supabase
      .from("vendas")
      .select("id, empresa_id, cliente_id, total, forma_pagamento, observacoes, created_at")
      .eq("id", venda_id)
      .maybeSingle()

    if (!venda) return new Response(JSON.stringify({ ok: true, ignorado: "venda nao encontrada" }), { headers: corsHeaders })
    if (venda.forma_pagamento !== "fiado") {
      return new Response(JSON.stringify({ ok: true, ignorado: "nao e fiado" }), { headers: corsHeaders })
    }
    if (!venda.cliente_id) {
      return new Response(JSON.stringify({ ok: true, ignorado: "fiado sem cliente" }), { headers: corsHeaders })
    }

    // Interruptor por loja: quem não ligou não manda nada.
    const { data: cfg } = await supabase
      .from("whatsapp_config")
      .select("instance_name, cloud_phone_number_id, ativo, notif_fiado_compra")
      .eq("empresa_id", venda.empresa_id)
      .maybeSingle()
    if (!cfg?.ativo || !cfg?.notif_fiado_compra) {
      return new Response(JSON.stringify({ ok: true, ignorado: "aviso de fiado desligado nesta loja" }), { headers: corsHeaders })
    }

    const { data: cliente } = await supabase
      .from("clientes")
      .select("nome, telefone, token")
      .eq("id", venda.cliente_id)
      .maybeSingle()

    const phone = String(cliente?.telefone ?? "").replace(/\D/g, "")
    const phoneFull = phone.startsWith("55") ? phone : `55${phone}`
    if (!recebeWhatsapp(phoneFull)) {
      // Cliente de fiado sem telefone é comum (cadastro antigo, feito às pressas
      // no balcão). Não é erro — só não dá pra avisar.
      console.log("[fiado] cliente sem telefone valido, nada enviado:", venda.cliente_id, cliente?.telefone)
      return new Response(JSON.stringify({ ok: true, ignorado: "cliente sem telefone valido" }), { headers: corsHeaders })
    }

    // Os itens são gravados na mesma transação da venda. O gatilho usa pg_net,
    // que só dispara depois do commit — mesmo assim, se a lista vier vazia a
    // gente espera e tenta de novo: comanda sem item vira mensagem sem sentido.
    let itens: any[] = []
    for (let i = 0; i < 3; i++) {
      const { data } = await supabase
        .from("venda_itens")
        .select("nome_produto, quantidade, preco_unitario, subtotal")
        .eq("venda_id", venda.id)
      itens = data ?? []
      if (itens.length) break
      await new Promise(r => setTimeout(r, 700))
    }
    if (!itens.length) {
      console.error("[fiado] venda sem itens, nada enviado:", venda.id)
      return new Response(JSON.stringify({ ok: false, erro: "venda sem itens" }), { headers: corsHeaders })
    }

    const { data: empresa } = await supabase
      .from("empresas").select("nome").eq("id", venda.empresa_id).maybeSingle()
    const { data: saldoRow } = await supabase
      .from("clientes_saldo_fiado").select("saldo_fiado").eq("cliente_id", venda.cliente_id).maybeSingle()

    const dia = new Date(venda.created_at).toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit",
    })
    const hora = new Date(venda.created_at).toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit",
    })
    const quando = `${dia} às ${hora}`
    const local = ondeFoi(venda.observacoes)
    const primeiroNome = String(cliente?.nome ?? "").trim().split(" ")[0]
    const saudacao = primeiroNome
      ? `Oi ${primeiroNome.charAt(0).toUpperCase() + primeiroNome.slice(1)}!`
      : "Oi!"

    const linhas = itens.map(i =>
      `• ${qtd(i.quantidade)}x ${String(i.nome_produto ?? "item").trim()} — ${brl(i.subtotal ?? Number(i.preco_unitario) * Number(i.quantidade))}`
    ).join("\n")

    const saldo = Number(saldoRow?.saldo_fiado ?? 0)
    const mensagem = [
      `${saudacao} Aqui é da *${empresa?.nome ?? "loja"}*.`,
      "",
      `Ficou anotado no seu *fiado* agora${local ? ` (${local})` : ""}, ${quando}:`,
      "",
      linhas,
      "",
      `Total desta conta: *${brl(venda.total)}*`,
      `Forma de pagamento: *FIADO*`,
      // O saldo só entra se for maior que esta conta — repetir o mesmo número
      // duas vezes seguidas confunde mais do que informa.
      saldo > Number(venda.total) + 0.005 ? `\nSeu total em aberto: *${brl(saldo)}*` : null,
      "",
      // É esta linha que faz o aviso valer a pena: confere hoje, enquanto todo
      // mundo lembra. Depois de duas semanas ninguém resolve mais.
      "Se tiver algo errado aqui, me avisa *hoje mesmo* que a gente confere. 🙏",
      cliente?.token ? `\nVer tudo o que está em aberto:\nhttps://lojaonline.fwcinter.com/c/${cliente.token}` : null,
    ].filter(l => l !== null).join("\n")

    // Mesmo caminho do aviso de pedido: Cloud quando a loja é oficial da Meta,
    // Evolution nas outras.
    let erro: string | null = null
    // Id da mensagem na Meta. A Meta responde 200 na hora e só depois avisa,
    // por webhook, se ENTREGOU — sem guardar o id esse aviso não tem onde
    // encaixar, e o histórico fica dizendo "enviado" pra mensagem que morreu.
    let messageId: string | null = null
    if (cfg.cloud_phone_number_id) {
      let token = CLOUD_TOKEN
      const { data: tok } = await supabase
        .from("whatsapp_cloud_tokens").select("token").eq("empresa_id", venda.empresa_id).maybeSingle()
      if (tok?.token) token = tok.token
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.cloud_phone_number_id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messaging_product: "whatsapp", recipient_type: "individual",
          to: phoneFull, type: "text", text: { body: mensagem, preview_url: false },
        }),
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

    if (erro) console.error("[fiado] comanda NAO enviada", venda.id, phoneFull, erro)

    // Entra no histórico do WhatsApp mesmo quando falha: é assim que a loja
    // descobre que o cliente NÃO foi avisado, em vez de descobrir na discussão.
    await supabase.from("whatsapp_conversas").insert({
      empresa_id: venda.empresa_id, phone: phoneFull,
      role: "assistant", content: mensagem, falhou: !!erro, erro,
      message_id: messageId,
    })

    return new Response(JSON.stringify({ ok: !erro, erro }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("[fiado] erro:", err)
    return new Response(JSON.stringify({ ok: false, erro: String(err) }), { headers: corsHeaders })
  }
})
