import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

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

    const { data: profile } = await supabaseUser
      .from("profiles")
      .select("empresa_id")
      .eq("id", user.id)
      .single()

    if (!profile?.empresa_id) {
      return new Response(JSON.stringify({ error: "Empresa não encontrada" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const empresaId    = profile.empresa_id
    const instanceName = `empresa_${empresaId}`

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    const body = await req.json()
    const { action } = body

    // ─────────────────────────────────────────
    // STATUS: retorna estado atual da instância
    // ─────────────────────────────────────────
    if (action === "status") {
      try {
        const res = await fetch(`${apiBase}/instance/connectionState/${instanceName}`, {
          headers: { apikey: apiKey }
        })
        if (!res.ok) {
          return new Response(JSON.stringify({ state: "not_found" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          })
        }
        const data = await res.json()
        const state = data.instance?.state ?? "close"
        const phone = data.instance?.ownerJid?.replace(/@s\.whatsapp\.net$/, "") ?? null

        // Quando conectado, garante ativo=true no banco
        if (state === "open") {
          await supabaseAdmin.from("whatsapp_config").upsert(
            { empresa_id: empresaId, ativo: true, instance_name: instanceName },
            { onConflict: "empresa_id" }
          )
        }

        return new Response(JSON.stringify({ state, phone }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      } catch {
        return new Response(JSON.stringify({ state: "error" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }
    }

    // ─────────────────────────────────────────
    // CONNECT: cria instância e retorna QR Code
    // ─────────────────────────────────────────
    if (action === "connect") {
      // Verifica se já está conectado
      const stateRes = await fetch(`${apiBase}/instance/connectionState/${instanceName}`, {
        headers: { apikey: apiKey }
      })
      if (stateRes.ok) {
        const stateData = await stateRes.json()
        if (stateData.instance?.state === "open") {
          const phone = stateData.instance?.ownerJid?.replace(/@s\.whatsapp\.net$/, "") ?? null
          await supabaseAdmin.from("whatsapp_config").upsert(
            { empresa_id: empresaId, ativo: true, instance_name: instanceName },
            { onConflict: "empresa_id" }
          )
          return new Response(JSON.stringify({ connected: true, phone }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          })
        }
      }

      // Cria instância (ignora erro se já existir)
      await fetch(`${apiBase}/instance/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({
          instanceName,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
        })
      })

      // Registra instance_name no banco
      await supabaseAdmin.from("whatsapp_config").upsert(
        { empresa_id: empresaId, instance_name: instanceName, ativo: false },
        { onConflict: "empresa_id" }
      )

      // Busca QR Code
      const qrRes = await fetch(`${apiBase}/instance/connect/${instanceName}`, {
        headers: { apikey: apiKey }
      })

      if (!qrRes.ok) {
        const errText = await qrRes.text()
        return new Response(JSON.stringify({ error: `Erro ao obter QR Code: ${errText}` }), {
          status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }

      const qrData = await qrRes.json()
      return new Response(
        JSON.stringify({ connected: false, qrcode: qrData.base64 ?? qrData.code ?? null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // ─────────────────────────────────────────
    // DISCONNECT: desvincula o WhatsApp
    // ─────────────────────────────────────────
    if (action === "disconnect") {
      await fetch(`${apiBase}/instance/logout/${instanceName}`, {
        method: "DELETE",
        headers: { apikey: apiKey }
      })

      await supabaseAdmin.from("whatsapp_config").upsert(
        { empresa_id: empresaId, ativo: false, instance_name: "" },
        { onConflict: "empresa_id" }
      )

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    return new Response(JSON.stringify({ error: "Ação inválida" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  }
})
