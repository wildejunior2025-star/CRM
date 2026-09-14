import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import {
  lojaAbertaAgora, carregarExcecoes, hojeNaLoja, roboPausado,
} from "../_shared/respostaSemIA.ts"

// "JÁ ABRIMOS!" — pra quem chamou no WhatsApp com a loja fechada (mig 0267).
//
// O robô anota o número em aviso_abertura quando responde "Estamos fechados".
// Este worker roda de 2 em 2 minutos e, quando a loja abre de verdade (dentro
// da grade E sem o botão "Loja fechada"), manda o link do cardápio.
//
// Regras:
//   - Só o mesmo dia. Pendente de ontem vira "pulado" e nunca sai.
//   - Não manda pra quem já foi atendido depois do aviso (robô ou loja
//     respondeu), pra quem já pediu hoje, nem pra conversa com gente atendendo.
//   - Devagar: poucas por rodada, com pausa sorteada. Uma recusa para a loja
//     nesta rodada. O cliente acabou de escrever, então está dentro das 24h da
//     Meta e texto livre é permitido.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const CLOUD_TOKEN       = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION     = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

const POR_LOJA_RODADA = 4
const TOTAL_RODADA    = 10
const MARCA_FECHADO   = "Estamos fechados"

const digitos = (s: unknown) => String(s ?? "").replace(/[^0-9]/g, "")
const chave8 = (s: unknown) => digitos(s).slice(-8)
const esperar = (s: number) => new Promise((r) => setTimeout(r, s * 1000))

function saudacao() {
  const h = Number(new Date().toLocaleString("en-GB", { timeZone: "America/Fortaleza", hour: "2-digit", hour12: false }))
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"
}

// 55 + DDD + 8 dígitos = celular sem o 9 (a Cloud API precisa dele).
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
    const hoje = hojeNaLoja()

    // Virou o dia: quem ficou pendente não recebe mais.
    await sb.from("aviso_abertura")
      .update({ status: "pulado", motivo: "passou o dia" })
      .eq("status", "pendente").lt("dia", hoje)

    const { data: pendentes } = await sb.from("aviso_abertura")
      .select("id, empresa_id, phone, criado_em")
      .eq("dia", hoje).eq("status", "pendente")
      .order("criado_em", { ascending: true })
      .limit(200)
    if (!pendentes?.length) return json({ nada: true })

    const porLoja = new Map<string, typeof pendentes>()
    for (const p of pendentes) {
      if (!porLoja.has(p.empresa_id)) porLoja.set(p.empresa_id, [])
      porLoja.get(p.empresa_id)!.push(p)
    }

    const marcar = (id: string, campos: Record<string, unknown>) =>
      sb.from("aviso_abertura").update(campos).eq("id", id)

    const resultado: Record<string, unknown>[] = []
    let enviadosRodada = 0

    for (const [empresaId, linhas] of porLoja) {
      if (enviadosRodada >= TOTAL_RODADA) break

      const { data: cfg } = await sb.from("whatsapp_config")
        .select("ativo, ia_ativo, aviso_abertura_ativo, instance_name, cloud_phone_number_id, empresas(slug, delivery_ativo, delivery_fechado_por, feriados_fecha, horarios_funcionamento)")
        .eq("empresa_id", empresaId).maybeSingle()

      if (!cfg?.ativo || cfg.aviso_abertura_ativo === false) {
        for (const l of linhas) await marcar(l.id, { status: "pulado", motivo: "aviso desligado" })
        continue
      }
      // Robô desligado agora: espera. A loja pode estar ligando ele ao abrir.
      if (!cfg.ia_ativo) continue

      const empresa = (cfg.empresas ?? {}) as Record<string, unknown>
      const excecoes = await carregarExcecoes(sb, empresaId)
      if (!lojaAbertaAgora(empresa, excecoes)) {
        resultado.push({ empresaId, esperando: "loja ainda fechada", pendentes: linhas.length })
        continue
      }

      const link = empresa.slug
        ? `https://lojaonline.fwcinter.com/${empresa.slug}`
        : "https://lojaonline.fwcinter.com"

      const cloudId = String(cfg.cloud_phone_number_id ?? "")
      let token = CLOUD_TOKEN
      if (cloudId) {
        const { data: tok } = await sb.from("whatsapp_cloud_tokens")
          .select("token").eq("empresa_id", empresaId).maybeSingle()
        if (tok?.token) token = tok.token
      }

      // Pedidos de hoje da loja, pra não chamar quem já pediu pelo link.
      const { data: pedidosHoje } = await sb.from("pedidos_delivery")
        .select("cliente_telefone, created_at")
        .eq("empresa_id", empresaId)
        .gte("created_at", linhas[0].criado_em)
        .limit(500)

      let daLoja = 0
      for (const l of linhas) {
        if (daLoja >= POR_LOJA_RODADA || enviadosRodada >= TOTAL_RODADA) break
        const k = chave8(l.phone)
        if (k.length < 8 || digitos(l.phone) === "5500000000001") {
          await marcar(l.id, { status: "pulado", motivo: "número inválido" })
          continue
        }

        if (await roboPausado(sb, empresaId, l.phone)) {
          await marcar(l.id, { status: "pulado", motivo: "tem gente atendendo" })
          continue
        }

        const jaPediu = (pedidosHoje ?? []).some((p) =>
          chave8(p.cliente_telefone) === k && p.created_at >= l.criado_em)
        if (jaPediu) {
          await marcar(l.id, { status: "pulado", motivo: "já pediu" })
          continue
        }

        // Alguém (robô ou loja) já falou com ele depois do "fechado"? Então a
        // conversa andou e o "já abrimos" chegaria atrasado.
        const { data: depois } = await sb.from("whatsapp_conversas")
          .select("content")
          .eq("empresa_id", empresaId).like("phone", `%${k}`)
          .eq("role", "assistant").gt("created_at", l.criado_em)
          .limit(10)
        if ((depois ?? []).some((m) => !String(m.content ?? "").includes(MARCA_FECHADO))) {
          await marcar(l.id, { status: "pulado", motivo: "já foi atendido" })
          continue
        }

        const texto = `${saudacao()}! 😊 *Já estamos abertos!*\n\nPode fazer seu pedido pelo link:\n👉 ${link}\n\nOu, se preferir, é só me dizer aqui o que vai querer.`

        let ok = false
        let erro = ""
        try {
          let res: Response
          if (cloudId) {
            res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cloudId}/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                messaging_product: "whatsapp", recipient_type: "individual",
                to: numeroBr(l.phone), type: "text",
                text: { body: texto, preview_url: true },
              }),
            })
          } else {
            res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${cfg.instance_name}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
              body: JSON.stringify({ number: l.phone, text: texto }),
            })
          }
          ok = res.ok
          if (!ok) erro = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`
        } catch (e) {
          erro = String(e)
        }

        if (!ok) {
          await marcar(l.id, { status: "falhou", motivo: erro })
          resultado.push({ empresaId, phone: l.phone, falhou: erro })
          break   // uma recusa: essa loja para nesta rodada
        }

        await marcar(l.id, { status: "enviado", enviado_em: new Date().toISOString() })
        // Na memória do robô, pra ele saber o que já disse se o cliente responder.
        await sb.from("whatsapp_conversas").insert({
          empresa_id: empresaId, phone: l.phone, role: "assistant", content: texto,
        })
        // Espelho no gestor, marcado como fala do robô.
        try {
          const { data: conversa } = await sb.from("mensagens_chat")
            .select("canal, cliente_ref, cliente_nome")
            .eq("empresa_id", empresaId).like("cliente_ref", `%${k}`)
            .order("created_at", { ascending: false }).limit(1).maybeSingle()
          await sb.from("mensagens_chat").insert({
            empresa_id: empresaId,
            canal: conversa?.canal ?? "whatsapp",
            cliente_ref: conversa?.cliente_ref ?? digitos(l.phone),
            cliente_nome: conversa?.cliente_nome ?? null,
            remetente: "loja", texto, bot: true,
          })
        } catch (_e) { /* espelho é bônus */ }

        resultado.push({ empresaId, phone: l.phone, enviado: true })
        daLoja++
        enviadosRodada++
        // Pausa sorteada: espaçamento certinho é assinatura de robô.
        await esperar(4 + Math.floor(Math.random() * 7))
      }
    }

    return json({ enviados: enviadosRodada, resultado })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
