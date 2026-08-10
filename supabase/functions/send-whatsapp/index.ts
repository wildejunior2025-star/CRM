import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const CLOUD_TOKEN   = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""   // Meta Cloud API
const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  // URL e chave global vêm de variáveis de ambiente (configuradas pelo super_admin)
  const apiBase = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
  const apiKey  = Deno.env.get("EVOLUTION_API_KEY") ?? ""

  if (!apiBase || !apiKey) {
    return new Response(
      JSON.stringify({ error: "Evolution API não configurada. Contate o suporte." }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const body = await req.json()
    const { phone, message, empresa_id } = body

    if (!phone || !message) {
      return new Response(JSON.stringify({ error: "phone e message são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    let targetEmpresaId = empresa_id

    if (!targetEmpresaId) {
      const { data: profile } = await supabaseUser
        .from("profiles")
        .select("empresa_id")
        .eq("id", user.id)
        .single()
      targetEmpresaId = profile?.empresa_id
    }

    if (!targetEmpresaId) {
      return new Response(JSON.stringify({ error: "Empresa não identificada" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    const { data: config } = await supabaseAdmin
      .from("whatsapp_config")
      .select("instance_name, ativo, cloud_phone_number_id")
      .eq("empresa_id", targetEmpresaId)
      .eq("ativo", true)
      .single()

    if (!config) {
      return new Response(JSON.stringify({ error: "WhatsApp não configurado para esta empresa" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // Verifica e desconta créditos antes de enviar
    const { data: empresaData, error: creditError } = await supabaseAdmin
      .from("empresas")
      .select("whatsapp_creditos")
      .eq("id", targetEmpresaId)
      .single()

    if (creditError || !empresaData || empresaData.whatsapp_creditos <= 0) {
      return new Response(
        JSON.stringify({ error: "Créditos WhatsApp insuficientes. Contate o suporte para recarregar." }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Desconta 1 crédito atomicamente via RPC (evita condição de corrida)
    const { error: debitError } = await supabaseAdmin.rpc("descontar_credito_whatsapp", {
      p_empresa_id: targetEmpresaId
    })

    if (debitError) {
      return new Response(
        JSON.stringify({ error: "Erro ao processar crédito." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // instance_name salvo no banco; fallback para nome padrão SaaS
    const instanceName = config.instance_name || `empresa_${targetEmpresaId}`

    // Sanitiza telefone: remove não-dígitos e garante DDI 55 (Brasil)
    let cleanPhone = phone.replace(/\D/g, "")
    if (!cleanPhone.startsWith("55")) cleanPhone = "55" + cleanPhone
    if (cleanPhone.length < 12 || cleanPhone.length > 13) {
      return new Response(JSON.stringify({ error: "Número de telefone inválido: " + phone }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // A loja pode estar em dois canos: Cloud API da Meta (quem tem
    // cloud_phone_number_id) ou Evolution (o antigo). Sem esta bifurcação, loja
    // migrada pro Cloud caía na Evolution, que não conhece a instância "cloud_*"
    // — foi o que aconteceu com a Estação em 09/08/2026.
    if (config.cloud_phone_number_id) {
      const cloudRes = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${config.cloud_phone_number_id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CLOUD_TOKEN}` },
          body: JSON.stringify({
            messaging_product: "whatsapp", recipient_type: "individual",
            to: cleanPhone, type: "text", text: { body: message, preview_url: true },
          }),
        }
      )
      if (!cloudRes.ok) {
        const errJson = await cloudRes.json().catch(() => null)
        const code = errJson?.error?.code
        // 131047 / 131026: a Meta só deixa mandar texto livre pra quem falou com a
        // loja nas últimas 24h. Fora disso só com template aprovado — então aqui a
        // saída é o envio manual, e o motivo tem que chegar claro na tela.
        const msg = code === 131047 || code === 131026
          ? "Esse cliente não fala com a loja no WhatsApp há mais de 24h — a Meta não deixa mandar mensagem nova pra ele."
          : `WhatsApp da Meta: ${errJson?.error?.message ?? await cloudRes.text()}`
        // O crédito é descontado ANTES de enviar; se o envio falhou, devolve —
        // senão a loja pagava por mensagem que nunca saiu.
        await supabaseAdmin.rpc("adicionar_credito_whatsapp", { p_empresa_id: targetEmpresaId, p_quantidade: 1 })
        return new Response(JSON.stringify({ error: msg, code }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }
    } else {
      const evoRes = await fetch(`${apiBase}/message/sendText/${instanceName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": apiKey,
        },
        body: JSON.stringify({ number: cleanPhone, text: message }),
      })

      if (!evoRes.ok) {
        const errText = await evoRes.text()
        await supabaseAdmin.rpc("adicionar_credito_whatsapp", { p_empresa_id: targetEmpresaId, p_quantidade: 1 })
        return new Response(JSON.stringify({ error: `Evolution API: ${errText}` }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  }
})
