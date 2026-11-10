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

// Apaga uma instância do Evolution DE VERDADE e confirma que saiu.
//
// POR QUE EXISTE (10/11/2026): o "connect" fazia DELETE e, 1,5 s depois,
// create com o mesmo nome. Quando o delete não tinha terminado, o create
// falhava — e o código inventava um nome novo com sufixo de tempo, deixando a
// anterior pendurada em "connecting" PARA SEMPRE. O servidor chegou a 52
// instâncias para 8 lojas; só o pareamento da Zebu de uma manhã gerou 20.
//
// Logout antes do delete porque instância que já começou o handshake recusa o
// delete enquanto o socket não cai. E CONFERE o resultado em vez de confiar:
// delete que falha calado foi a causa de todo o entulho.
async function apagarInstancia(apiBase: string, apiKey: string, nome: string) {
  if (!nome) return true
  await fetch(`${apiBase}/instance/logout/${nome}`, {
    method: "DELETE", headers: { apikey: apiKey },
  }).catch(() => null)

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await fetch(`${apiBase}/instance/delete/${nome}`, {
      method: "DELETE", headers: { apikey: apiKey },
    }).catch(() => null)
    await new Promise((r) => setTimeout(r, 900))
    const res = await fetch(`${apiBase}/instance/connectionState/${nome}`, {
      headers: { apikey: apiKey },
    }).catch(() => null)
    // 404 = não existe mais, que é o que a gente quer.
    if (!res || res.status === 404) return true
  }
  console.error("[limpeza] nao consegui apagar a instancia", nome)
  return false
}

// Varre as instâncias órfãs DESTA loja: mesmo prefixo, nenhuma conexão viva.
// QR que não virou conexão não serve pra nada, então some. Nunca encosta em
// instância "open", que é loja atendendo cliente agora.
async function limparOrfasDaLoja(
  apiBase: string, apiKey: string, empresaId: string,
) {
  const prefixo = toInstanceName(empresaId)
  const res = await fetch(`${apiBase}/instance/fetchInstances`, {
    headers: { apikey: apiKey },
  }).catch(() => null)
  if (!res?.ok) return []
  const corpo = await res.json().catch(() => [])
  const lista = Array.isArray(corpo) ? corpo : (corpo?.instances ?? [])
  const apagadas: string[] = []
  for (const it of lista as Record<string, unknown>[]) {
    const i = (it.instance ?? it) as Record<string, unknown>
    const nome = String(i.instanceName ?? i.name ?? "")
    const estado = String(i.connectionStatus ?? i.state ?? i.status ?? "")
    if (!nome.startsWith(prefixo)) continue
    if (estado === "open") continue
    if (await apagarInstancia(apiBase, apiKey, nome)) apagadas.push(nome)
  }
  if (apagadas.length) console.log("[limpeza] orfas apagadas:", apagadas.join(", "))
  return apagadas
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
            // Sempre reaplicar webhook (pode ter sido perdido se servidor reiniciou).
            //
            // COM await, DE PROPÓSITO. Sem ele a chamada ficava solta e a função
            // devolvia a resposta em seguida: a edge é desligada assim que
            // responde, e o pedido morria antes de sair. Resultado no 25/09: a
            // loja de demonstração pareou às 15:10, o webhook não existia na
            // Evolution, e a mensagem do cliente não chegava em lugar nenhum —
            // WhatsApp "conectado" na tela e robô mudo, sem erro em canto nenhum.
            const supabaseUrl2 = Deno.env.get("SUPABASE_URL") ?? ""
            const projectRef2 = supabaseUrl2.match(/https:\/\/([^.]+)/)?.[1] ?? ""
            if (projectRef2) {
              try {
                const wh = await fetch(`${apiBase}/webhook/set/${instanceName}`, {
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
                })
                if (!wh.ok) console.error("[webhook] set falhou", instanceName, wh.status, await wh.text())
              } catch (e) {
                console.error("[webhook] set estourou", instanceName, String(e))
              }
            }
            return new Response(JSON.stringify({ connected: true, phone }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            })
          }
        }

        // Instância existe mas não está conectada: apaga pra recriar limpa.
        await apagarInstancia(apiBase, apiKey, instanceName)
      }

      // Varre o resto do entulho desta loja antes de criar a nova. Toda
      // instância com o prefixo da loja e sem conexão viva é QR que não foi
      // escaneado — não serve pra nada e só atrapalha o create.
      await limparOrfasDaLoja(apiBase, apiKey, empresaId)

      // Volta pro nome limpo da loja. O nome só ganhava sufixo quando o create
      // falhava, e aí nunca mais voltava: a Zebu estava em
      // "...cc20xtdun9", quinto sufixo empilhado. Aqui a loja vai parear de
      // novo de qualquer forma, então é o momento certo de desempilhar.
      instanceName = toInstanceName(empresaId)

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
        // Create falhou (quase sempre: o nome ainda está ocupado no Evolution).
        console.error("[connect] create falhou:", createRes.status, await createRes.text().catch(() => ""))

        // ANTES este trecho inventava na hora um nome com sufixo de tempo. Era
        // o que enchia o servidor de entulho: o nome mudava a cada tentativa e
        // a instância velha ficava pra trás. Agora a primeira coisa é LIBERAR
        // o nome certo, com confirmação, e tentar de novo nele.
        await apagarInstancia(apiBase, apiKey, instanceName)
        let retryRes = await fetch(`${apiBase}/instance/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: apiKey },
          body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true })
        })

        // Só se o nome certo for impossível de liberar (acontece com número que
        // ficou preso ao Facebook/Meta) é que cai no sufixo — última saída, e
        // avisando no log, porque é ele que cria instância sobrando.
        if (!retryRes.ok) {
          console.error("[connect] nome", instanceName, "nao liberou; caindo pro sufixo")
          instanceName = toInstanceName(empresaId) + "x" + Date.now().toString(36).slice(-5)
          retryRes = await fetch(`${apiBase}/instance/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKey },
            body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true })
          })
        }

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
        const wh = await fetch(`${apiBase}/webhook/set/${instanceName}`, {
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
        // Sem webhook a instância pareia e fica muda. Se falhar aqui, o log é a
        // única pista — a tela mostra "conectado" do mesmo jeito.
        if (!wh.ok) console.error("[webhook] set falhou na criação", instanceName, wh.status, await wh.text())
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
    // QR ATUAL — só lê, não destrói nada.
    //
    // POR QUE EXISTE (10/11/2026): a tela renovava o QR de 25 em 25 segundos
    // chamando "connect", e "connect" APAGA a instância e cria outra. Resultado:
    // a conexão era destruída antes de a loja conseguir escanear (daí o
    // "Gerando QR Code..." que rodava sem parar) e cada ciclo que falhava
    // deixava uma instância órfã no servidor.
    //
    // Não precisa recriar nada pra ter QR novo: o Evolution passa
    // `qrTimeout: 45_000` pro Baileys, então o WhatsApp manda um QR novo a cada
    // 45 segundos NA MESMA instância — igual ao WhatsApp Web, que troca o
    // desenho e mantém a sessão. É isso que esta ação devolve.
    //
    // Depois de 30 QR (QRCODE_LIMIT), ou seja ~22 minutos, o Evolution desiste:
    // estado "refused" e sessão encerrada. Aí devolve esgotou=true e a tela
    // pede pra gerar de novo — essa é a única hora em que recriar faz sentido.
    if (action === "qr_atual") {
      const stateRes = await fetch(`${apiBase}/instance/connectionState/${instanceName}`, {
        headers: { apikey: apiKey },
      }).catch(() => null)

      // Instância não existe mais: a tela precisa chamar "connect" uma vez.
      if (!stateRes || stateRes.status === 404) {
        return new Response(JSON.stringify({ connected: false, sumiu: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }

      const stateData = await stateRes.json().catch(() => ({}))
      const estado = stateData?.instance?.state ?? stateData?.state ?? ""
      const phone = stateData?.instance?.ownerJid?.replace(/@s\.whatsapp\.net$/, "") ?? null

      // Mesmo cuidado do resto do arquivo: "open" sem número é fantasma.
      if (estado === "open" && phone) {
        return new Response(JSON.stringify({ connected: true, phone }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }

      if (estado === "refused") {
        return new Response(JSON.stringify({ connected: false, esgotou: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        })
      }

      const qrRes = await fetch(`${apiBase}/instance/connect/${instanceName}`, {
        headers: { apikey: apiKey },
      }).catch(() => null)
      const qrData = qrRes?.ok ? await qrRes.json().catch(() => ({})) : {}
      const qr = qrData?.base64 ?? qrData?.qrcode?.base64 ?? null

      return new Response(
        JSON.stringify({ connected: false, qrcode: qr, esgotou: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    if (action === "disconnect") {
      await fetch(`${apiBase}/instance/logout/${instanceName}`, {
        method: "DELETE",
        headers: { apikey: apiKey }
      })

      // Desligar o QR NÃO pode derrubar a Cloud API. As duas conexões dividem o
      // mesmo `ativo`, e o webhook da Meta só acha a loja com ele ligado: no
      // depósito do Thiago o lojista tirou o Evolution que estava sobrando e o
      // número oficial ficou mudo — mensagem chegava e voltava "nenhuma loja
      // para phone_number_id".
      const { data: cfgAtual } = await supabaseAdmin.from("whatsapp_config")
        .select("cloud_phone_number_id").eq("empresa_id", empresaId).maybeSingle()
      const seguePelaMeta = !!cfgAtual?.cloud_phone_number_id

      await supabaseAdmin.from("whatsapp_config").upsert(
        { empresa_id: empresaId, ativo: seguePelaMeta, instance_name: "" },
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
            // Prévia do link (miniatura + título), igual ao WhatsApp do celular.
            to: numeroFull, type: "text", text: { body: text, preview_url: true },
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
        // Link do YouTube: a prévia (miniatura + título) quem monta é o servidor
        // do Evolution abrindo a página — e o YouTube não entrega pra servidor.
        // Mesmo com linkPreview o link chegava cru (14/09/2026). Então a gente
        // pega título e miniatura no oEmbed oficial e manda como foto com a
        // mensagem (e o link) na legenda. Falhou qualquer coisa: texto normal.
        let foiComoFoto = false
        const linkYoutube = text.match(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/)|youtu\.be\/)[^\s]+/i)?.[0]
        if (linkYoutube) {
          try {
            const oe = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(linkYoutube)}`)
            const info = oe.ok ? await oe.json() : null
            if (info?.thumbnail_url) {
              const resFoto = await fetch(`${apiBase}/message/sendMedia/${instanceName}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey: apiKey },
                body: JSON.stringify({
                  number: numeroFull, mediatype: "image", mimetype: "image/jpeg",
                  fileName: "video.jpg", media: info.thumbnail_url,
                  caption: `▶️ *${info.title ?? "Vídeo"}*\n\n${text}`,
                }),
              })
              data = await resFoto.json().catch(() => ({}))
              foiComoFoto = resFoto.ok
              ok = resFoto.ok
              if (!resFoto.ok) console.error("[send_message] foto do YouTube falhou:", JSON.stringify(data).slice(0, 300))
            }
          } catch (e) {
            console.error("[send_message] oEmbed falhou:", String(e))
          }
        }
        if (!foiComoFoto) {
          const res = await fetch(`${apiBase}/message/sendText/${instanceName}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: apiKey },
            body: JSON.stringify({ number: numeroFull, text, linkPreview: true }),
          })
          data = await res.json().catch(() => ({}))
          ok = res.ok
          if (!ok) erro = String(data?.message ?? data?.error ?? `erro ${res.status}`)
        }
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
