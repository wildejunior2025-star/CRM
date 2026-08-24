import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// WORKER DA CAMPANHA — manda UMA mensagem por vez, devagar.
//
// Roda de 2 em 2 minutos pelo cron. Em cada rodada ele manda no máximo uma
// mensagem, e só se todos os freios deixarem. Foi escrito depois de o WhatsApp
// da Estação levar 5h de restrição por disparo em rajada (21/08/2026).
//
// Os freios, em ordem:
//   1. Falhou uma vez → a campanha inteira para (não insiste)
//   2. Fora de 08h-20h (BRT) → não manda
//   3. Já mandou 15 na última hora → não manda
//   4. A próxima só é liberada depois de 2 a 5 minutos, sorteados
//
// O intervalo é sorteado de propósito: espaçamento regular é a assinatura de
// robô que o antispam procura.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const CLOUD_TOKEN       = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION     = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

const TETO_POR_HORA = 15
const HORA_INICIO = 8
const HORA_FIM = 20
const PAUSA_MIN_S = 120
const PAUSA_MAX_S = 300

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  )

  try {
    const body = await req.json().catch(() => ({}))
    const campanha = String(body.campanha ?? "").trim()
    if (!campanha) return json({ error: "informe a campanha" }, 400)

    // Estado da campanha, pra responder sempre com o placar
    const contar = async (st: string) => {
      const { count } = await sb.from("campanha_fila")
        .select("id", { count: "exact", head: true }).eq("campanha", campanha).eq("status", st)
      return count ?? 0
    }
    const placar = async () => ({
      pendente: await contar("pendente"),
      enviado: await contar("enviado"),
      falhou: await contar("falhou"),
    })

    // FREIO 1 — uma recusa e a campanha inteira para. Insistir depois de o
    // WhatsApp dizer não é o caminho mais curto pro bloqueio.
    const { data: falhas } = await sb.from("campanha_fila")
      .select("id, telefone, erro").eq("campanha", campanha).eq("status", "falhou").limit(1)
    if (falhas?.length) {
      return json({ parado: "houve falha - campanha travada de proposito", falha: falhas[0], ...(await placar()) })
    }

    // FREIO 2 — horário comercial (BRT = UTC-3)
    const agora = new Date()
    const horaBRT = (agora.getUTCHours() + 24 - 3) % 24
    if (horaBRT < HORA_INICIO || horaBRT >= HORA_FIM) {
      return json({ esperando: `fora do horario (${horaBRT}h BRT)`, ...(await placar()) })
    }

    // FREIO 3 — teto por hora
    const umaHoraAtras = new Date(Date.now() - 3600_000).toISOString()
    const { count: naHora } = await sb.from("campanha_fila")
      .select("id", { count: "exact", head: true })
      .eq("campanha", campanha).eq("status", "enviado").gte("enviado_em", umaHoraAtras)
    if ((naHora ?? 0) >= TETO_POR_HORA) {
      return json({ esperando: `teto de ${TETO_POR_HORA}/h atingido`, ...(await placar()) })
    }

    // FREIO 4 — a próxima só depois da hora marcada
    const { data: fila } = await sb.from("campanha_fila")
      .select("*").eq("campanha", campanha).eq("status", "pendente")
      .lte("agendado_para", agora.toISOString())
      .order("agendado_para", { ascending: true }).limit(1)

    const alvo = fila?.[0]
    if (!alvo) {
      const p = await placar()
      return json({ ...(p.pendente ? { esperando: "aguardando o intervalo" } : { fim: "campanha concluida" }), ...p })
    }

    // Dois canos. Com template_nome preenchido vai pela Cloud API da Meta, que
    // é o único jeito legítimo de puxar conversa com quem não fala com a loja
    // há mais de 24h (texto livre nesse caso volta 131047). Sem template,
    // continua o caminho antigo: texto pela Evolution.
    let res: Response
    let resposta: any = {}
    let wamid: string | null = null

    if (alvo.template_nome) {
      const { data: cfg } = await sb.from("whatsapp_config")
        .select("cloud_phone_number_id").eq("empresa_id", alvo.empresa_id).eq("ativo", true).maybeSingle()

      if (!cfg?.cloud_phone_number_id || !CLOUD_TOKEN) {
        return json({ error: "template pedido mas a loja nao esta na Cloud API" }, 500)
      }

      // O corpo leva as variáveis na ordem ({{1}}, {{2}}...). O botão de URL
      // dinâmica leva só o pedaço que completa o link (o token do cliente).
      const componentes: unknown[] = []
      const params = Array.isArray(alvo.template_params) ? alvo.template_params : []
      if (params.length) {
        componentes.push({
          type: "body",
          parameters: params.map((p: unknown) => ({ type: "text", text: String(p) })),
        })
      }
      if (alvo.botao_param) {
        componentes.push({
          type: "button", sub_type: "url", index: "0",
          parameters: [{ type: "text", text: String(alvo.botao_param) }],
        })
      }

      res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.cloud_phone_number_id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLOUD_TOKEN}` },
          body: JSON.stringify({
            messaging_product: "whatsapp", recipient_type: "individual",
            to: alvo.telefone, type: "template",
            template: {
              name: alvo.template_nome,
              language: { code: alvo.template_lang || "pt_BR" },
              ...(componentes.length ? { components: componentes } : {}),
            },
          }),
        }
      )
      resposta = await res.json().catch(() => ({}))
      wamid = resposta?.messages?.[0]?.id ?? null
    } else {
      if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return json({ error: "Evolution nao configurada" }, 500)

      res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${alvo.instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: alvo.telefone, text: alvo.mensagem }),
      })
      resposta = await res.json().catch(() => ({}))
    }

    if (!res.ok) {
      await sb.from("campanha_fila").update({
        status: "falhou",
        erro: `HTTP ${res.status}: ${JSON.stringify(resposta).slice(0, 400)}`,
      }).eq("id", alvo.id)
      return json({ parou: "o WhatsApp recusou - campanha travada", telefone: alvo.telefone, resposta, ...(await placar()) })
    }

    await sb.from("campanha_fila").update({
      status: "enviado", enviado_em: new Date().toISOString(), message_id: wamid,
    }).eq("id", alvo.id)

    // Sorteia quando a próxima pode sair
    const pausa = PAUSA_MIN_S + Math.floor(Math.random() * (PAUSA_MAX_S - PAUSA_MIN_S))
    const proximaHora = new Date(Date.now() + pausa * 1000).toISOString()
    const { data: proximos } = await sb.from("campanha_fila")
      .select("id").eq("campanha", campanha).eq("status", "pendente")
      .order("agendado_para", { ascending: true }).limit(1)
    if (proximos?.[0]) {
      await sb.from("campanha_fila").update({ agendado_para: proximaHora }).eq("id", proximos[0].id)
    }

    return json({
      enviado: { nome: alvo.nome, telefone: alvo.telefone },
      proxima_em_segundos: pausa,
      ...(await placar()),
    })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
