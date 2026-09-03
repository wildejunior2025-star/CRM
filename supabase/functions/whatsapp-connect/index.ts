import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { pausarPorAtendimentoHumano } from "../_shared/respostaSemIA.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Espelha a mensagem no chat do painel (a aba Mensagens), pra loja atender tudo
// num lugar só — WhatsApp e link da Loja Online na mesma conversa.
//
// Se o cliente já tinha falado pelo link, a mensagem entra NAQUELA conversa,
// não numa nova: duas linhas do mesmo cliente fariam o atendente responder na
// errada e o cliente receber pela metade. O casamento é pelos 8 últimos
// dígitos, porque o WhatsApp entrega o número com e sem o 9 do celular.
async function espelharNoChat(
  supabase: any, empresaId: string, phone: string, texto: string, remetente: "cliente" | "loja",
) {
  try {
    const digitos = String(phone ?? "").replace(/\D/g, "")
    const chave = digitos.slice(-8)
    if (!empresaId || !chave || !texto) return
    const { data: existente } = await supabase
      .from("mensagens_chat")
      .select("canal, cliente_ref, cliente_nome")
      .eq("empresa_id", empresaId)
      .like("cliente_ref", `%${chave}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    let nome = existente?.cliente_nome ?? null
    if (!nome) {
      const { data: cli } = await supabase
        .from("clientes").select("nome")
        .eq("empresa_id", empresaId)
        .like("telefone_digitos", `%${chave}`)
        .limit(1).maybeSingle()
      nome = cli?.nome ?? null
    }
    await supabase.from("mensagens_chat").insert({
      empresa_id: empresaId,
      canal: existente?.canal ?? "whatsapp",
      cliente_ref: existente?.cliente_ref ?? digitos,
      cliente_nome: nome,
      remetente,
      texto,
    })
  } catch (_e) {
    // O espelho é bônus: se falhar, o atendimento pelo WhatsApp segue igual.
  }
}

// O número recebe WhatsApp?
//
// O iFood NÃO entrega o telefone do cliente: ele manda o 0800 da central dele
// ("0800 200 5011"). A loja recebia esse número como se fosse do cliente e o
// sistema mandava aviso de pedido pra ele a cada troca de status. Só no Zebu
// foram 4.094 mensagens em 30 dias — 70% de tudo que saiu — para 12 números
// que não existem no WhatsApp. Ninguém recebeu nada, e do lado da loja parecia
// que o cliente tinha sido avisado.
//
// Regra: depois de tirar o 55, o que sobra tem que ser um telefone brasileiro
// de 10 ou 11 dígitos com DDD de verdade. Os 10 dígitos ficam valendo de
// propósito — o WhatsApp entrega muito celular sem o 9 migratório, e barrar
// isso calaria cliente de verdade pra resolver problema de 0800.
function recebeWhatsapp(phoneRaw: string): boolean {
  const d = String(phoneRaw ?? "").replace(/\D/g, "")
  const local = d.startsWith("55") ? d.slice(2) : d
  if (local.length !== 10 && local.length !== 11) return false
  if (local.startsWith("0")) return false           // 0800, 0300, 0500: central, não celular
  const ddd = Number(local.slice(0, 2))
  if (!(ddd >= 11 && ddd <= 99)) return false
  return true
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

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Nome da instância: usa o guardado no config (pode ter sido trocado por um novo
    // quando o antigo travou no Evolution); senão, deriva do empresa_id.
    const { data: cfgInst } = await supabaseAdmin
      .from("whatsapp_config").select("instance_name").eq("empresa_id", empresaId).maybeSingle()
    let instanceName = (cfgInst?.instance_name && cfgInst.instance_name.length > 0)
      ? cfgInst.instance_name
      : toInstanceName(empresaId)

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
              // Evolution v2 usa "ownerJid"; v1 usava "owner". Tenta os dois.
              phone = inst?.ownerJid?.replace(/@s\.whatsapp\.net$/, "")
                ?? inst?.owner?.replace(/@s\.whatsapp\.net$/, "")
                ?? inst?.instance?.ownerJid?.replace(/@s\.whatsapp\.net$/, "")
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

        // "open" = conectado (mesmo que o número ainda não tenha vindo — ele chega em
        // seguida). O caso fantasma (open sem número) é tratado no 'connect', que
        // recria a instância quando a loja clica em Conectar.
        if (state === "open") {
          await supabaseAdmin.from("whatsapp_config").upsert(
            { empresa_id: empresaId, ativo: true, instance_name: instanceName, ...(phone ? { connected_phone: phone } : {}) },
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
                // Evolution v2 usa "ownerJid"; v1 usava "owner". Tenta os dois.
                phone = inst?.ownerJid?.replace(/@s\.whatsapp\.net$/, "")
                  ?? inst?.owner?.replace(/@s\.whatsapp\.net$/, "")
                  ?? inst?.instance?.ownerJid?.replace(/@s\.whatsapp\.net$/, "")
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
        // A instância antiga está travada no Evolution (ex.: número que estava
        // ligado ao Facebook/Meta). Cria com um nome NOVO e passa a usar ele.
        instanceName = toInstanceName(empresaId) + "x" + Date.now().toString(36).slice(-5)
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

      // Pedido do iFood vem com o 0800 da central no lugar do telefone. Sem
      // este aviso, quem clica em "mandar mensagem" no card acha que falou com
      // o cliente — e o cliente nunca soube de nada.
      if (!recebeWhatsapp(numeroFull)) {
        return new Response(JSON.stringify({
          ok: false,
          erro: "Este número não recebe WhatsApp. Pedido do iFood não traz o telefone do cliente, e sim o 0800 da central — fale com ele pelo chat do próprio iFood.",
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }

      // Loja no WhatsApp Cloud (o oficial da Meta) não fala com o Evolution: o
      // envio tem que sair pela Graph API. Sem isto o botão de mensagem do painel
      // dizia que enviou e não chegava nada — era o caso da Estação do Sabor.
      const { data: cfgEnvio } = await supabaseAdmin
        .from("whatsapp_config")
        .select("cloud_phone_number_id, cloud_waba_id")
        .eq("empresa_id", empresaId)
        .maybeSingle()

      let ok = false
      let erro: string | null = null
      let data: any = {}
      // Ver mig 0215: guarda o id pra o webhook de status poder dizer depois se
      // a mensagem ENTREGOU mesmo.
      let messageId: string | null = null

  // Cloud SÓ com a conta completa (WABA). Um phone_number_id sozinho é setup
  // pela metade — número de teste da Meta, que só fala com uma lista de
  // permitidos. A CD Bom tinha um desses parado no cadastro: as mensagens dela
  // saíam pelo Cloud e voltavam "131030 Recipient phone number not in allowed
  // list", enquanto o WhatsApp de verdade dela (o do servidor) estava ali do
  // lado, funcionando. 22 avisos perdidos em 30 dias, calados.
      if (cfgEnvio?.cloud_phone_number_id && cfgEnvio?.cloud_waba_id) {
        // Token da própria loja (Cadastro Incorporado) quando existir; senão o do app.
        let cloudToken = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
        const { data: tok } = await supabaseAdmin
          .from("whatsapp_cloud_tokens").select("token").eq("empresa_id", empresaId).maybeSingle()
        if (tok?.token) cloudToken = tok.token
        const graph = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"
        const res = await fetch(`https://graph.facebook.com/${graph}/${cfgEnvio.cloud_phone_number_id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cloudToken}` },
          body: JSON.stringify({
            messaging_product: "whatsapp", recipient_type: "individual",
            to: numeroFull, type: "text", text: { body: text, preview_url: false },
          }),
        })
        data = await res.json().catch(() => ({}))
        ok = res.ok
        if (ok) messageId = data?.messages?.[0]?.id ?? null
        if (!ok) {
          // A Meta só deixa escrever livremente até 24h depois da última mensagem
          // do cliente (erro 131047). Quem está no balcão precisa saber POR QUE
          // não foi — um "erro" seco faz a pessoa tentar de novo pra sempre.
          const msgMeta = String(data?.error?.message ?? "")
          erro = (data?.error?.code === 131047 || /24 ?h|re-?engagement/i.test(msgMeta))
            ? "Passou de 24h desde a última mensagem do cliente. O WhatsApp oficial não deixa a loja escrever primeiro fora dessa janela — peça pra ele mandar um oi."
            : (msgMeta || `erro ${res.status}`)
        }
      } else {
        const res = await fetch(`${apiBase}/message/sendText/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: apiKey },
          body: JSON.stringify({ number: numeroFull, text }),
        })
        data = await res.json().catch(() => ({}))
        ok = res.ok
        if (!ok) erro = String(data?.message ?? data?.error ?? `erro ${res.status}`)
      }

      // Enviou? Entra na conversa daquele número, marcada como escrita pela LOJA
      // (mig 0213). Sem isso o atendente respondia e a própria resposta dele não
      // aparecia na tela — dava a impressão de que não tinha saído.
      if (ok) {
        await supabaseAdmin.from("whatsapp_conversas").insert({
          empresa_id: empresaId, phone: numeroFull, role: "assistant",
          content: text, origem: "loja", message_id: messageId,
        })
        // Também no chat do painel/link, pra quem pediu pelo site ver a mesma
        // resposta ali. Quem chama passando espelhar_no_chat:false já gravou
        // lá (é o caso da própria aba Mensagens) e não pode duplicar.
        if (body.espelhar_no_chat !== false) {
          await espelharNoChat(supabaseAdmin, empresaId, numeroFull, text, "loja")
        }
        // Gente digitou essa resposta (caixa de conversa do gestor). O robô sai
        // de cena nesse número por umas horas: os dois respondendo junto é o
        // jeito mais rápido de o lojista desligar a resposta automática.
        // Aviso de pedido e disparo NÃO mandam esta bandeira — são automáticos,
        // e calariam o robô pra quem acabou de pedir.
        if (body.assumir_conversa === true) {
          await pausarPorAtendimentoHumano(supabaseAdmin, empresaId, numeroFull)
        }
      }

      return new Response(JSON.stringify({ ok, erro, data }), {
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
