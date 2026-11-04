import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const ADMIN_INSTANCE = "crmadmin"

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  )

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  try {
    const body = await req.json()
    const { action, instanceName: reqInstance } = body

    // Retorna info do remetente atual
    if (action === "current") {
      const { data } = await supabaseAdmin
        .from("config_global").select("valor").eq("chave", "admin_sender_instance").single()
      const instanceName = data?.valor ?? ""
      if (!instanceName) return json({ instanceName: "", state: "none", phone: "" })

      const stateRes = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instanceName}`, {
        headers: { apikey: EVOLUTION_API_KEY },
      }).then(r => r.json()).catch(() => ({}))

      const state = stateRes?.instance?.state ?? stateRes?.state ?? "close"
      const ownerJid = stateRes?.instance?.ownerJid ?? stateRes?.ownerJid ?? ""
      const phone = ownerJid.replace("@s.whatsapp.net", "")
      return json({ instanceName, state, phone })
    }

    // Cria instância admin e retorna QR
    if (action === "create_qr") {
      // Tenta deletar instância antiga se existir
      await fetch(`${EVOLUTION_API_URL}/instance/delete/${ADMIN_INSTANCE}`, {
        method: "DELETE",
        headers: { apikey: EVOLUTION_API_KEY },
      }).catch(() => {})

      // Cria nova instância
      const createRes = await fetch(`${EVOLUTION_API_URL}/instance/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ instanceName: ADMIN_INSTANCE, integration: "WHATSAPP-BAILEYS", qrcode: true }),
      })
      const createData = await createRes.json()

      const qr = createData?.qrcode?.base64 ?? createData?.hash?.qrcode ?? ""
      return json({ ok: true, qr, instanceName: ADMIN_INSTANCE })
    }

    // Verifica status da instância admin (polling após mostrar QR)
    if (action === "check_status") {
      const stateRes = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${ADMIN_INSTANCE}`, {
        headers: { apikey: EVOLUTION_API_KEY },
      }).then(r => r.json()).catch(() => ({}))

      const state = stateRes?.instance?.state ?? stateRes?.state ?? "close"
      const ownerJid = stateRes?.instance?.ownerJid ?? stateRes?.ownerJid ?? ""
      const phone = ownerJid.replace("@s.whatsapp.net", "")

      if (state === "open") {
        // Salva como remetente padrão
        await supabaseAdmin.from("config_global").upsert({
          chave: "admin_sender_instance", valor: ADMIN_INSTANCE, atualizado_em: new Date().toISOString(),
        })
      }
      return json({ state, phone })
    }

    // LISTA tudo o que existe no servidor Evolution, sem mexer: nome da
    // instância, número pareado, estado e quanto tempo faz que o servidor viu
    // mensagem. Serve pra descobrir instância órfã (loja repareada com outro
    // nome) e socket parado — connectionState sozinho não conta essa história.
    if (action === "debug_instances") {
      const res = await fetch(`${EVOLUTION_API_URL}/instance/fetchInstances`, {
        headers: { apikey: EVOLUTION_API_KEY },
      }).catch(() => null)
      const corpo = res ? await res.json().catch(() => ({})) : {}
      const lista = Array.isArray(corpo) ? corpo : (corpo?.instances ?? [])
      const enxuto = lista.map((it: Record<string, unknown>) => {
        const i = (it.instance ?? it) as Record<string, unknown>
        return {
          nome: i.instanceName ?? i.name ?? "",
          estado: i.connectionStatus ?? i.state ?? i.status ?? "",
          numero: String(i.ownerJid ?? i.owner ?? "").replace("@s.whatsapp.net", ""),
          perfil: i.profileName ?? "",
          atualizado: i.updatedAt ?? i.updated_at ?? "",
          contagem: i._count ?? null,
        }
      })
      return json({ ok: true, total: enxuto.length, instancias: enxuto })
    }

    // OLHA o webhook de uma instância (ou de todas as lojas ativas), sem mexer.
    //
    // POR QUE EXISTE: em 04/11/2026 o Zebu ficou das 08:45 às 11:50 sem receber
    // mensagem nenhuma de cliente. O vigia (monitor-whatsapp) dizia "aberto",
    // porque o celular ESTAVA conectado e os avisos de pedido saíam normais — o
    // que tinha caído era só a entrega dos eventos pra cá. Connection state não
    // enxerga isso; o webhook da instância, sim.
    if (action === "check_webhook") {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
      const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? ""
      const esperado = `https://${projectRef}.supabase.co/functions/v1/whatsapp-webhook`

      let alvos: { instance: string; loja: string }[] = []
      if (reqInstance) {
        alvos = [{ instance: reqInstance, loja: "" }]
      } else {
        const { data } = await supabaseAdmin
          .from("whatsapp_config")
          .select("instance_name, empresas(nome)")
          .eq("ativo", true).not("instance_name", "is", null)
        alvos = (data ?? [])
          .filter((r: Record<string, unknown>) => String(r.instance_name ?? "").trim())
          .map((r: Record<string, unknown>) => ({
            instance: String(r.instance_name),
            loja: String((r.empresas as Record<string, unknown>)?.nome ?? ""),
          }))
      }

      const linhas = []
      for (const alvo of alvos) {
        const res = await fetch(`${EVOLUTION_API_URL}/webhook/find/${alvo.instance}`, {
          headers: { apikey: EVOLUTION_API_KEY },
        }).catch(() => null)
        const corpo = res ? await res.json().catch(() => ({})) : {}
        const w = (corpo?.webhook ?? corpo ?? {}) as Record<string, unknown>
        const url = String(w.url ?? "")
        const eventos = Array.isArray(w.events) ? w.events : []
        linhas.push({
          loja: alvo.loja,
          instancia: alvo.instance,
          http: res?.status ?? 0,
          ligado: w.enabled === true,
          url,
          url_ok: url.startsWith(esperado),
          eventos,
          pega_mensagem: eventos.includes("MESSAGES_UPSERT"),
          cru: res && !res.ok ? JSON.stringify(corpo).slice(0, 200) : undefined,
        })
      }
      return json({ ok: true, esperado, webhooks: linhas })
    }

    // Reconfigura o webhook de uma instância específica
    if (action === "fix_webhook") {
      const targetInstance = reqInstance ?? "crma95b716bd97342abace9dae0fd1acd62"
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
      const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? ""
      const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/whatsapp-webhook?apikey=${Deno.env.get("SUPABASE_ANON_KEY") ?? ""}`
      const res = await fetch(`${EVOLUTION_API_URL}/webhook/set/${targetInstance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({
          webhook: { enabled: true, url: webhookUrl, webhookByEvents: false, webhookBase64: false, events: ["MESSAGES_UPSERT"] }
        }),
      })
      const data = await res.json().catch(() => ({}))
      return json({ ok: res.ok, status: res.status, webhookUrl, data })
    }

    return json({ error: "action inválida" }, 400)
  } catch (err) {
    console.error("admin-whatsapp-connect error:", err)
    return json({ error: String(err) }, 500)
  }
})
