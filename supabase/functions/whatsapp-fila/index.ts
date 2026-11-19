// deno-lint-ignore-file no-explicit-any
// O CARTEIRO DA FILA DO WHATSAPP (19/11/2026)
//
// POR QUE EXISTE
// A CDBom levou 24h de restrição da Meta por "mensagens automáticas ou em
// massa" sem ter feito disparo nenhum — foi o ritmo: a mesma resposta, com o
// mesmo link, pra 11 números em 40 minutos, três deles em 49 segundos.
//
// A regra do Wilde é clara: NUNCA deixar de enviar. Então o que não cabe na
// hora não é descartado, entra na fila (mig 0459) com a hora marcada — e este
// aqui entrega quando chega a vez.
//
// Roda de minuto em minuto pelo cron. O espaçamento já vem gravado em
// `enviar_apos` por quem agendou, então aqui é só entregar o que venceu.
//
// Deploy com --no-verify-jwt (quem chama é o cron do banco).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { espelharNoChat } from "../_shared/espelhoChat.ts"
import { INTERVALO_SEG } from "../_shared/ritmoWhatsapp.ts"

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const CLOUD_TOKEN       = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION     = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

// Quanto tempo a rodada pode durar. O cron chama de novo em 1 minuto, então
// o que sobrar sai na próxima — nada se perde por estourar o tempo.
const TETO_RODADA_MS = 45_000
// Quantas por loja em cada rodada. Mais que isso já seria a rajada de volta.
const POR_LOJA = 3

const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } })

/** Manda de verdade. Cloud API quando a loja está nela; senão Evolution. */
async function entregar(
  cfg: any, phone: string, texto: string,
): Promise<{ erro: string | null; messageId: string | null }> {
  const numero = String(phone).replace(/\D/g, "")
  if (cfg?.cloud_phone_number_id && CLOUD_TOKEN) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.cloud_phone_number_id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_TOKEN}` },
          body: JSON.stringify({
            messaging_product: "whatsapp", to: numero,
            type: "text", text: { body: texto },
          }),
        })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) return { erro: `cloud ${res.status}: ${JSON.stringify(out).slice(0, 220)}`, messageId: null }
      return { erro: null, messageId: out?.messages?.[0]?.id ?? null }
    } catch (e) {
      return { erro: `cloud inacessivel: ${String(e).slice(0, 200)}`, messageId: null }
    }
  }
  if (!cfg?.instance_name) return { erro: "loja sem WhatsApp configurado", messageId: null }
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${cfg.instance_name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: numero, text: texto }),
    })
    if (!res.ok) return { erro: `evolution ${res.status}: ${(await res.text()).slice(0, 220)}`, messageId: null }
    return { erro: null, messageId: null }
  } catch (e) {
    return { erro: `evolution inacessivel: ${String(e).slice(0, 200)}`, messageId: null }
  }
}

serve(async () => {
  const comecou = Date.now()
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  try {
    // O que já venceu, na ordem da vez.
    const { data: espera } = await supabase.from("whatsapp_fila")
      .select("id, empresa_id, phone, texto, tipo, enviar_apos, tentativas")
      .is("enviado_em", null)
      .lte("enviar_apos", new Date().toISOString())
      .order("enviar_apos", { ascending: true })
      .limit(120)

    const itens = Array.isArray(espera) ? espera : []
    if (!itens.length) return json({ ok: true, fila: 0 })

    // Agrupa por loja: cada loja tem o ritmo DELA. Uma loja cheia não pode
    // segurar o aviso de outra.
    const porLoja = new Map<string, any[]>()
    for (const it of itens) {
      const lista = porLoja.get(it.empresa_id) ?? []
      if (lista.length < POR_LOJA) lista.push(it)
      porLoja.set(it.empresa_id, lista)
    }

    // A configuração de cada loja, de uma vez só.
    const { data: cfgs } = await supabase.from("whatsapp_config")
      .select("empresa_id, ativo, instance_name, cloud_phone_number_id")
      .in("empresa_id", [...porLoja.keys()])
    const config = new Map((cfgs ?? []).map((c: any) => [c.empresa_id, c]))

    let enviados = 0, falhas = 0, adiados = 0

    // Lojas em paralelo, mensagens da mesma loja uma a uma e espaçadas.
    await Promise.all([...porLoja.entries()].map(async ([empresaId, lista]) => {
      const cfg = config.get(empresaId)
      for (let i = 0; i < lista.length; i++) {
        if (Date.now() - comecou > TETO_RODADA_MS) { adiados += lista.length - i; return }
        // Entre uma e outra DA MESMA LOJA, o intervalo. A primeira sai já: a
        // hora dela foi marcada lá atrás, quando entrou na fila.
        if (i > 0) await dormir(INTERVALO_SEG * 1000)

        const it = lista[i]
        if (cfg?.ativo === false) {
          // Loja com WhatsApp desligado (caso da CDBom em 19/11). Não insiste:
          // marca como não enviada, com o motivo, e sai da fila. Insistir
          // contra um número restrito é pedir punição maior.
          await supabase.from("whatsapp_fila").update({
            enviado_em: new Date().toISOString(), erro: "WhatsApp da loja desligado",
          }).eq("id", it.id)
          falhas++
          continue
        }

        const { erro, messageId } = await entregar(cfg, it.phone, it.texto)

        if (erro && it.tentativas < 3) {
          // Tenta de novo na próxima rodada, 1 minuto depois.
          await supabase.from("whatsapp_fila").update({
            tentativas: it.tentativas + 1, erro,
            enviar_apos: new Date(Date.now() + 60_000).toISOString(),
          }).eq("id", it.id)
          adiados++
          continue
        }

        await supabase.from("whatsapp_fila").update({
          enviado_em: new Date().toISOString(), erro, tentativas: it.tentativas + 1,
        }).eq("id", it.id)

        // O histórico só agora: mensagem que esperou a vez entra na conversa
        // quando SAI, não quando foi agendada. Senão a loja veria no chat uma
        // resposta que o cliente ainda não recebeu.
        await supabase.from("whatsapp_conversas").insert({
          empresa_id: empresaId, phone: it.phone, role: "assistant",
          content: it.texto, falhou: !!erro, erro, message_id: messageId,
        })
        if (!erro) {
          // Aviso de pedido não espelha: ele já tem o lugar dele na tela do
          // pedido, e repetir na caixa de Mensagens polui a conversa.
          if (it.tipo === "robo") {
            await espelharNoChat(supabase, empresaId, it.phone, it.texto, "loja", true)
          }
          enviados++
        } else falhas++
      }
    }))

    return json({ ok: true, fila: itens.length, enviados, falhas, adiados, ms: Date.now() - comecou })
  } catch (e) {
    console.error("[fila] erro:", e)
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
