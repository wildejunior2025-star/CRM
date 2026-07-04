import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

function toInstanceName(empresaId: string) {
  return "crm" + empresaId.replace(/-/g, "")
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
    const instanceName = toInstanceName(empresaId)

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    const body = await req.json()
    const { action } = body

    // ─────────────────────────────────────────
    // STATUS
    // ─────────────────────────────────────────
    if (action === "status") {
      try {
        const res = await fetch(`${apiBase}/instance/connectionState/${instanceName}`, {
          headers: { apikey: apiKey }
        })
        if (!res.ok) {
          // Tenta retornar o phone salvo no banco mesmo sem conexão ativa
          const { data: cfg } = await supabaseAdmin
            .from("whatsapp_config").select("connected_phone").eq("empresa_id", empresaId).single()
          return new Response(JSON.stringify({ state: "not_found", phone: cfg?.connected_phone ?? null }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          })
        }
        const data = await res.json()
        const state = data.instance?.state ?? "close"
        let phone: string | null = data.instance?.ownerJid?.replace(/@s\.whatsapp\.net$/, "") ?? null

        // Fallback: tenta fetchInstances se ownerJid não veio
        if (!phone && state === "open") {
          try {
            const fetchRes = await fetch(`${apiBase}/instance/fetchInstances?instanceName=${instanceName}`, {
              headers: { apikey: apiKey }
            })
            if (fetchRes.ok) {
              const fetchData = await fetchRes.json()
              const inst = Array.isArray(fetchData) ? fetchData[0] : fetchData
              phone = inst?.owner?.replace(/@s\.whatsapp\.net$/, "")
                ?? inst?.instance?.owner?.replace(/@s\.whatsapp\.net$/, "")
                ?? null
            }
          } catch { /* ignora */ }
        }

        // Se ainda não temos o phone da Evolution, busca do banco (conexão anterior)
        if (!phone) {
          const { data: cfg } = await supabaseAdmin
            .from("whatsapp_config").select("connected_phone").eq("empresa_id", empresaId).single()
          phone = cfg?.connected_phone ?? null
        }

        // "open" só conta como conectado se há um número real. "open" SEM número é
        // instância fantasma (travada) → reporta como desconectado pra loja clicar
        // em Conectar e gerar um QR novo.
        const conectadoDeVerdade = state === "open" && !!phone
        if (conectadoDeVerdade) {
          await supabaseAdmin.from("whatsapp_config").upsert(
            { empresa_id: empresaId, ativo: true, instance_name: instanceName, connected_phone: phone },
            { onConflict: "empresa_id" }
          )
        }

        return new Response(JSON.stringify({ state: conectadoDeVerdade ? "open" : (state === "open" ? "close" : state), phone }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      } catch {
        return new Response(JSON.stringify({ state: "error" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }
    }

    // ─────────────────────────────────────────
    // CONNECT: sempre recria a instância limpa
    // ─────────────────────────────────────────
    if (action === "connect") {
      // Se já está conectado, retorna direto
      const stateRes = await fetch(`${apiBase}/instance/connectionState/${instanceName}`, {
        headers: { apikey: apiKey }
      })
      if (stateRes.ok) {
        const stateData = await stateRes.json()
        if (stateData.instance?.state === "open") {
          let phone: string | null = stateData.instance?.ownerJid?.replace(/@s\.whatsapp\.net$/, "") ?? null
          if (!phone) {
            try {
              const fetchRes = await fetch(`${apiBase}/instance/fetchInstances?instanceName=${instanceName}`, {
                headers: { apikey: apiKey }
              })
              if (fetchRes.ok) {
                const fetchData = await fetchRes.json()
                const inst = Array.isArray(fetchData) ? fetchData[0] : fetchData
                phone = inst?.owner?.replace(/@s\.whatsapp\.net$/, "")
                  ?? inst?.instance?.owner?.replace(/@s\.whatsapp\.net$/, "")
                  ?? null
              }
            } catch { /* ignora */ }
          }
          // Só considera "conectado" se tem um número real (ownerJid). Estado "open"
          // SEM número é fantasma (instância travada) → cai pro delete+recriar abaixo
          // e gera um QR novo, em vez de fingir que já está conectado.
          if (phone) {
            await supabaseAdmin.from("whatsapp_config").upsert(
              { empresa_id: empresaId, ativo: true, instance_name: instanceName, connected_phone: phone },
              { onConflict: "empresa_id" }
            )
            // Sempre reaplicar webhook (pode ter sido perdido se servidor reiniciou)
            const supabaseUrl2 = Deno.env.get("SUPABASE_URL") ?? ""
            const projectRef2 = supabaseUrl2.match(/https:\/\/([^.]+)/)?.[1] ?? ""
            if (projectRef2) {
              fetch(`${apiBase}/webhook/set/${instanceName}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKey },
                body: JSON.stringify({
                  webhook: {
                    enabled: true,
                    url: `https://${projectRef2}.supabase.co/functions/v1/whatsapp-webhook?apikey=${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
                    webhookByEvents: false,
                    webhookBase64: false,
                    events: ["MESSAGES_UPSERT"]
                  }
                })
              }).catch(() => {})
            }
            return new Response(JSON.stringify({ connected: true, phone }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            })
          }
        }

        // Instância existe mas não está conectada: deleta para recriar limpa
        await fetch(`${apiBase}/instance/delete/${instanceName}`, {
          method: "DELETE",
          headers: { apikey: apiKey }
        })
        await new Promise(r => setTimeout(r, 1500))
      }

      // Cria instância do zero
      const createRes = await fetch(`${apiBase}/instance/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({
          instanceName,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
        })
      })

      let qrFromCreate: string | null = null
      if (createRes.ok) {
        const createData = await createRes.json()
        qrFromCreate = createData.qrcode?.base64 ?? createData.base64 ?? null
      } else {
        // Create falhou (ex.: a instância fantasma ainda não terminou de apagar).
        // Não aborta: apaga de novo, espera e tenta recriar uma vez.
        console.error("[connect] create falhou:", createRes.status, await createRes.text().catch(() => ""))
        await fetch(`${apiBase}/instance/delete/${instanceName}`, { method: "DELETE", headers: { apikey: apiKey } }).catch(() => {})
        await new Promise(r => setTimeout(r, 2500))
        const retryRes = await fetch(`${apiBase}/instance/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: apiKey },
          body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true })
        })
        if (retryRes.ok) {
          const retryData = await retryRes.json()
          qrFromCreate = retryData.qrcode?.base64 ?? retryData.base64 ?? null
        } else {
          return new Response(
            JSON.stringify({ error: `Erro ao criar instância (${retryRes.status}): ${await retryRes.text().catch(() => "")}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          )
        }
      }

      await supabaseAdmin.from("whatsapp_config").upsert(
        { empresa_id: empresaId, instance_name: instanceName, ativo: false },
        { onConflict: "empresa_id" }
      )

      // Configura webhook automaticamente na nova instância
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
      const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? ""
      if (projectRef) {
        await fetch(`${apiBase}/webhook/set/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: apiKey },
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: `https://${projectRef}.supabase.co/functions/v1/whatsapp-webhook?apikey=${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`,
              webhookByEvents: false,
              webhookBase64: false,
              events: ["MESSAGES_UPSERT"]
            }
          })
        })
      }

      if (qrFromCreate) {
        return new Response(
          JSON.stringify({ connected: false, qrcode: qrFromCreate }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        )
      }

      // Fallback: busca QR via /instance/connect
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
    // DISCONNECT
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

    // ─────────────────────────────────────────
    // SEND MESSAGE
    // ─────────────────────────────────────────
    if (action === "send_message") {
      const { phone, text } = body
      if (!phone || !text) {
        return new Response(JSON.stringify({ error: "phone e text obrigatórios" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }
      const numero = String(phone).replace(/\D/g, "")
      const numeroFull = numero.startsWith("55") ? numero : `55${numero}`

      const res = await fetch(`${apiBase}/message/sendText/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ number: numeroFull, text }),
      })
      const data = await res.json().catch(() => ({}))
      return new Response(JSON.stringify({ ok: res.ok, data }), {
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
