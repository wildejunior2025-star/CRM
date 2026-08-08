import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const ADMIN_INSTANCE = "crmadmin"

// Cloud API oficial — usada para avisar a LOJA da mensalidade vencida.
// Fora da janela de 24h a Meta só entrega template aprovado, então texto livre
// pelo Evolution não serve mais para quem não falou com a gente hoje.
const CLOUD_TOKEN   = Deno.env.get("WHATSAPP_CLOUD_TOKEN") ?? ""
const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"
const TEMPLATE_COBRANCA = "cobranca_mensalidade"
const TEMPLATE_IDIOMA   = "pt_BR"

// A Meta manda/aceita o wa_id de celular BR sem o 9º dígito; para ENVIAR
// costuma exigir o 9. Mesma regra do whatsapp-cloud.
function normalizeBrNumber(n: string): string {
  const d = String(n ?? "").replace(/\D/g, "")
  if (d.startsWith("55") && d.length === 12) {
    const ddd = d.slice(2, 4)
    const local = d.slice(4)
    if (/^[6-9]/.test(local)) return `55${ddd}9${local}`
  }
  return d
}

// Parâmetro de template não aceita quebra de linha, tab nem 4+ espaços seguidos.
function limparParam(v: string): string {
  return String(v ?? "").replace(/\s+/g, " ").trim()
}

function mesDeReferencia(vencimento: string): string {
  const meses = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
                 "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
  const [ano, mes] = String(vencimento ?? "").split("-")
  const i = Number(mes) - 1
  return (meses[i] && ano) ? `${meses[i]}/${ano}` : String(vencimento ?? "")
}

function dataBr(iso: string): string {
  const [ano, mes, dia] = String(iso ?? "").split("-")
  return (dia && mes && ano) ? `${dia}/${mes}/${ano}` : String(iso ?? "")
}

function valorBr(v: unknown): string {
  const n = Number(v)
  return Number.isFinite(n) && n > 0
    ? `R$ ${n.toFixed(2).replace(".", ",")}`
    : "conforme seu plano"
}

// Envia o template de cobrança pela Graph API.
// Devolve null se deu certo, ou o motivo da falha (para cair no Evolution).
async function enviarTemplateCobranca(
  phoneNumberId: string,
  to: string,
  params: string[],
): Promise<string | null> {
  if (!CLOUD_TOKEN)   return "sem WHATSAPP_CLOUD_TOKEN"
  if (!phoneNumberId) return "sem admin_cloud_phone_number_id"
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CLOUD_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizeBrNumber(to),
        type: "template",
        template: {
          name: TEMPLATE_COBRANCA,
          language: { code: TEMPLATE_IDIOMA },
          components: [{
            type: "body",
            parameters: params.map((p) => ({ type: "text", text: limparParam(p) })),
          }],
        },
      }),
    })
    if (res.ok) return null
    return `Graph ${res.status}: ${(await res.text()).slice(0, 300)}`
  } catch (e) {
    return String(e)
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })

  try {
    // Precisa de pelo menos um caminho de envio: Cloud API oficial ou Evolution.
    const temEvolution = Boolean(EVOLUTION_API_URL && EVOLUTION_API_KEY)
    if (!temEvolution && !CLOUD_TOKEN) {
      return json({ ok: false, error: "Nenhum caminho de envio configurado (Evolution API nem WHATSAPP_CLOUD_TOKEN)" }, 503)
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Lê configurações globais: telefone do admin e flag de alertas ativo
    const { data: configs } = await supabaseAdmin
      .from("config_global")
      .select("chave, valor")
      .in("chave", ["super_admin_phone", "alertas_mensalidade_ativo", "admin_sender_instance", "admin_cloud_phone_number_id"])

    const configMap: Record<string, string> = {}
    for (const row of configs ?? []) configMap[row.chave] = row.valor
    // Instância do WhatsApp da plataforma: a que o Super Admin pareou, não fixa
    // no código (a antiga "crmadmin" nem existe mais na Evolution).
    const INSTANCE = (configMap.admin_sender_instance ?? "").trim() || ADMIN_INSTANCE

    const alertasAtivo = configMap["alertas_mensalidade_ativo"] !== "false"
    const adminPhone = (configMap["super_admin_phone"] ?? "").replace(/\D/g, "")
    const cloudPhoneId = (configMap["admin_cloud_phone_number_id"] ?? "").trim()

    if (!alertasAtivo) {
      return json({ ok: true, enviadas: 0, msg: "Alertas desativados nas configurações" })
    }

    if (!adminPhone || adminPhone.length < 10) {
      return json({ ok: false, error: "Número do admin não configurado (super_admin_phone)" }, 400)
    }

    // Busca empresas ativas com vencimento anterior a hoje
    const hoje = new Date().toISOString().split("T")[0]
    const { data: empresas, error: empError } = await supabaseAdmin
      .from("empresas")
      .select("id, nome, vencimento, telefone_contato, valor_mensalidade")
      .eq("status", "ativo")
      .lt("vencimento", hoje)

    if (empError) {
      return json({ ok: false, error: "Erro ao buscar empresas: " + empError.message }, 500)
    }

    if (!empresas || empresas.length === 0) {
      return json({ ok: true, enviadas: 0 })
    }

    // Monta mensagem consolidada para o número do admin
    const linhas = empresas.map((e: { nome: string; vencimento: string }) =>
      `• *${e.nome}* — venceu em ${e.vencimento}`
    )
    const mensagemAdmin =
      `🚨 *Alertas de Mensalidade Vencida*\n\n` +
      `As empresas abaixo estão com pagamento em atraso:\n\n` +
      linhas.join("\n") +
      `\n\n_Enviado automaticamente pelo CRM FWC Inter_`

    // Garante DDI 55 no número do admin
    const adminPhoneFormatado = adminPhone.startsWith("55") ? adminPhone : "55" + adminPhone

    let enviadas = 0
    let erroAdmin: string | undefined

    // Envia mensagem consolidada para o admin. Continua pelo Evolution: é uma
    // lista variável, não cabe em template, e o admin é o nosso próprio número.
    // Sem Evolution, o resumo é apenas registrado — o aviso às lojas (que é o que
    // importa) segue pelo template mesmo assim.
    if (!temEvolution) {
      console.warn("[alertas] sem Evolution — resumo do admin não enviado:", mensagemAdmin)
    } else {
      const adminRes = await fetch(`${EVOLUTION_API_URL}/message/sendText/${INSTANCE}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({ number: adminPhoneFormatado, text: mensagemAdmin }),
      })

      if (!adminRes.ok) {
        // Não aborta: o aviso às lojas é o que importa e vai por outro caminho.
        const errText = await adminRes.text()
        console.error("Erro ao enviar alerta para admin:", errText)
        erroAdmin = `Evolution API: ${errText.slice(0, 200)}`
      } else {
        enviadas++
      }
    }

    // Envia mensagem individual para cada empresa que tiver telefone_contato preenchido.
    // Caminho preferido: template oficial pela Cloud API (único que entrega fora da
    // janela de 24h). Se o template ainda não estiver aprovado ou a Cloud falhar,
    // cai no texto livre pelo Evolution — que é o que sempre funcionou até aqui.
    let porTemplate = 0
    const errosEmpresa: string[] = []

    for (const emp of empresas) {
      if (!emp.telefone_contato) continue

      const phoneEmp = emp.telefone_contato.replace(/\D/g, "")
      if (!phoneEmp || phoneEmp.length < 10) continue

      const phoneFormatado = phoneEmp.startsWith("55") ? phoneEmp : "55" + phoneEmp

      const falhaCloud = await enviarTemplateCobranca(cloudPhoneId, phoneFormatado, [
        emp.nome,
        mesDeReferencia(emp.vencimento),
        valorBr((emp as { valor_mensalidade?: unknown }).valor_mensalidade),
        dataBr(emp.vencimento),
      ])

      if (!falhaCloud) {
        enviadas++
        porTemplate++
        continue
      }
      console.warn(`[alertas] template não saiu para ${emp.nome}, tentando Evolution:`, falhaCloud)

      if (!temEvolution) {
        errosEmpresa.push(emp.nome)
        continue
      }

      const mensagemEmpresa =
        `Olá, *${emp.nome}*! 👋\n\n` +
        `Identificamos que sua mensalidade do *CRM FWC Inter* venceu em *${emp.vencimento}*.\n\n` +
        `Para evitar a suspensão do serviço, entre em contato com nosso suporte.\n\n` +
        `_Atenciosamente, equipe FWC Inter_`

      const empRes = await fetch(`${EVOLUTION_API_URL}/message/sendText/${INSTANCE}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({ number: phoneFormatado, text: mensagemEmpresa }),
      })

      if (empRes.ok) {
        enviadas++
      } else {
        const errText = await empRes.text()
        console.error(`Erro ao notificar empresa ${emp.nome}:`, errText)
        errosEmpresa.push(emp.nome)
      }
    }

    return json({
      ok: true,
      enviadas,
      por_template: porTemplate,
      empresas_em_atraso: empresas.length,
      erros: errosEmpresa.length > 0 ? errosEmpresa : undefined,
      erro_admin: erroAdmin,
    })
  } catch (err) {
    console.error("admin-alertas error:", err)
    return json({ ok: false, error: String(err) }, 500)
  }
})
