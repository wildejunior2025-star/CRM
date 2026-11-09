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

    // MANDA uma mensagem do número da FWC pra um número qualquer. Existe pra
    // UMA coisa: testar se a instância de uma loja está recebendo. Esperar
    // mensagem de cliente aparecer não prova nada quando a loja está parada;
    // esta aqui chega na hora e dá a resposta.
    if (action === "ping_loja") {
      const { phone, text } = body
      if (!phone) return json({ ok: false, erro: "phone é obrigatório" }, 400)
      const numero = String(phone).replace(/\D/g, "")
      const res = await fetch(`${EVOLUTION_API_URL}/message/sendText/${ADMIN_INSTANCE}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: numero, text: String(text ?? "Teste do suporte FWC — pode ignorar.") }),
      }).catch(() => null)
      const corpo = res ? await res.text() : "(sem resposta)"
      return json({ ok: !!res?.ok, http: res?.status ?? 0, corpo: corpo.slice(0, 300) })
    }

    // REINICIA a instância: derruba e levanta o socket mantendo a sessão. É o
    // conserto de socket travado — Evolution dizendo "open" e não entregando
    // evento nenhum (Zebu, 04/11/2026: 3 horas sem receber mensagem).
    //
    // O verbo muda de versão pra versão do Evolution, então tenta os três e
    // conta qual pegou. Depois devolve o estado, que é o que diz se voltou
    // sozinho ou se a loja vai ter que ler o QR.
    if (action === "restart_instance") {
      if (!reqInstance) return json({ ok: false, erro: "instanceName é obrigatório" }, 400)
      const tentativas = []
      let venceu = null
      for (const verbo of ["PUT", "POST", "GET"]) {
        const res = await fetch(`${EVOLUTION_API_URL}/instance/restart/${reqInstance}`, {
          method: verbo, headers: { apikey: EVOLUTION_API_KEY },
        }).catch(() => null)
        const corpo = res ? await res.text() : "(sem resposta)"
        tentativas.push({ verbo, http: res?.status ?? 0, corpo: corpo.slice(0, 160) })
        if (res?.ok) { venceu = verbo; break }
      }
      // Dá um respiro pro socket subir antes de perguntar o estado.
      await new Promise((r) => setTimeout(r, 6000))
      const est = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${reqInstance}`, {
        headers: { apikey: EVOLUTION_API_KEY },
      }).then((r) => r.json()).catch(() => ({}))
      const estado = est?.instance?.state ?? est?.state ?? "?"
      return json({ ok: !!venceu, venceu, tentativas, estado })
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

    // ── Ajustes da instância (syncFullHistory e companhia) ──────────────────
    //
    // POR QUE ISSO EXISTE (09/11/2026): quatro instâncias (CDBom, Zebu, CL
    // Pescados, DayCakes) só entregavam mensagem com 24 a 45 horas de atraso,
    // sempre as mesmas, repetidas. O webhook recebia e jogava fora como
    // "mensagem antiga". É a ressincronização de histórico do Baileys: com
    // syncFullHistory ligado, cada reconexão despeja a conversa inteira na
    // fila do webhook, e a fila nunca alcança o presente.
    if (action === "check_settings" || action === "set_settings") {
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
        const res = await fetch(`${EVOLUTION_API_URL}/settings/find/${alvo.instance}`, {
          headers: { apikey: EVOLUTION_API_KEY },
        }).catch(() => null)
        const atual = (res ? await res.json().catch(() => ({})) : {}) as Record<string, unknown>
        const linha: Record<string, unknown> = {
          loja: alvo.loja, instancia: alvo.instance, http: res?.status ?? 0,
          syncFullHistory: atual.syncFullHistory,
          alwaysOnline: atual.alwaysOnline,
          readMessages: atual.readMessages,
          groupsIgnore: atual.groupsIgnore,
          cru: res && !res.ok ? JSON.stringify(atual).slice(0, 200) : undefined,
        }
        if (action === "set_settings") {
          // Manda o conjunto inteiro: o Evolution troca tudo, não só o campo
          // enviado. O que não veio no body vira false/padrão.
          // groupsIgnore pode vir no pedido. Serve pra calar o despejo de
          // histórico de grupo que entope o webhook (09/11/2026): numa loja
          // doente, 391 de 563 mensagens repetidas eram de grupo. Só mande
          // true em loja SEM estoque_grupo_jid, senão o estoque para.
          const corpo = {
            rejectCall: atual.rejectCall === true,
            msgCall: String(atual.msgCall ?? ""),
            groupsIgnore: typeof body.groupsIgnore === "boolean"
              ? body.groupsIgnore
              : atual.groupsIgnore === true,
            alwaysOnline: atual.alwaysOnline === true,
            readMessages: atual.readMessages === true,
            readStatus: atual.readStatus === true,
            syncFullHistory: false,
          }
          const put = await fetch(`${EVOLUTION_API_URL}/settings/set/${alvo.instance}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
            body: JSON.stringify(corpo),
          }).catch(() => null)
          linha.gravou = put?.ok ?? false
          linha.gravou_http = put?.status ?? 0
          linha.enviado = corpo
        }
        linhas.push(linha)
      }
      return json({ ok: true, acao: action, instancias: linhas })
    }

    return json({ error: "action inválida" }, 400)
  } catch (err) {
    console.error("admin-whatsapp-connect error:", err)
    return json({ error: String(err) }, 500)
  }
})
