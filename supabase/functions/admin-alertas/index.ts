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

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })

  try {
    // Verifica configuração da Evolution API
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
      return json({ ok: false, error: "Evolution API não configurada (EVOLUTION_API_URL / EVOLUTION_API_KEY ausentes)" }, 503)
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Lê configurações globais: telefone do admin e flag de alertas ativo
    const { data: configs } = await supabaseAdmin
      .from("config_global")
      .select("chave, valor")
      .in("chave", ["super_admin_phone", "alertas_mensalidade_ativo"])

    const configMap: Record<string, string> = {}
    for (const row of configs ?? []) configMap[row.chave] = row.valor

    const alertasAtivo = configMap["alertas_mensalidade_ativo"] !== "false"
    const adminPhone = (configMap["super_admin_phone"] ?? "").replace(/\D/g, "")

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
      .select("id, nome, vencimento, telefone_contato")
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

    // Envia mensagem consolidada para o admin
    const adminRes = await fetch(`${EVOLUTION_API_URL}/message/sendText/${ADMIN_INSTANCE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: adminPhoneFormatado, text: mensagemAdmin }),
    })

    if (!adminRes.ok) {
      const errText = await adminRes.text()
      console.error("Erro ao enviar alerta para admin:", errText)
      return json({ ok: false, error: `Evolution API: ${errText}` }, 502)
    }

    // Envia mensagem individual para cada empresa que tiver telefone_contato preenchido
    let enviadas = 1 // conta o envio para o admin
    const errosEmpresa: string[] = []

    for (const emp of empresas) {
      if (!emp.telefone_contato) continue

      const phoneEmp = emp.telefone_contato.replace(/\D/g, "")
      if (!phoneEmp || phoneEmp.length < 10) continue

      const phoneFormatado = phoneEmp.startsWith("55") ? phoneEmp : "55" + phoneEmp

      const mensagemEmpresa =
        `Olá, *${emp.nome}*! 👋\n\n` +
        `Identificamos que sua mensalidade do *CRM FWC Inter* venceu em *${emp.vencimento}*.\n\n` +
        `Para evitar a suspensão do serviço, entre em contato com nosso suporte.\n\n` +
        `_Atenciosamente, equipe FWC Inter_`

      const empRes = await fetch(`${EVOLUTION_API_URL}/message/sendText/${ADMIN_INSTANCE}`, {
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
      empresas_em_atraso: empresas.length,
      erros: errosEmpresa.length > 0 ? errosEmpresa : undefined,
    })
  } catch (err) {
    console.error("admin-alertas error:", err)
    return json({ ok: false, error: String(err) }, 500)
  }
})
