// whatsapp-cloud-signup — finaliza o Cadastro Incorporado (Embedded Signup) do
// WhatsApp Cloud API. O lojista clica em "Conectar meu WhatsApp" no CRM, faz o
// popup da Meta e conecta O PRÓPRIO número. O frontend nos manda o `code` + os
// IDs (waba_id, phone_number_id) que a Meta devolveu; aqui a gente:
//   1. Troca o code por um token da integração (system user do negócio do lojista)
//   2. Assina o app na WABA do lojista (pra receber webhooks)
//   3. Registra o número no Cloud API (com um PIN de 2 etapas)
//   4. Salva tudo no whatsapp_config da loja e ativa o robô
//
// Depois disso o número passa a cair no webhook whatsapp-cloud como qualquer outro.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v21.0"
const APP_ID        = Deno.env.get("WHATSAPP_APP_ID") ?? ""
const APP_SECRET    = Deno.env.get("WHATSAPP_APP_SECRET") ?? ""

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

// PIN determinístico de 6 dígitos por empresa (não aleatório pra sobreviver a
// re-tentativas; guardado no banco de qualquer forma).
function gerarPin(empresaId: string) {
  let h = 0
  for (const c of empresaId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return String(100000 + (h % 900000))
}

async function graph(path: string, token: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method,
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (req.method !== "POST")    return json({ error: "Método não suportado" }, 405)

  if (!APP_ID || !APP_SECRET) {
    return json({ error: "App do WhatsApp não configurado (WHATSAPP_APP_ID/SECRET). Contate o suporte." }, 503)
  }

  try {
    // ── Auth do lojista ──
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return json({ error: "Não autorizado" }, 401)

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user }, error: authError } = await supabaseUser.auth.getUser()
    if (authError || !user) return json({ error: "Não autorizado" }, 401)

    const { data: profile } = await supabaseUser
      .from("profiles").select("empresa_id, perfil").eq("id", user.id).single()

    const body = await req.json().catch(() => ({}))
    const { code, waba_id, phone_number_id } = body as Record<string, string>

    // super_admin pode conectar em nome de uma loja específica; lojista usa a dele
    const empresaId = (profile?.perfil === "super_admin" && body.empresa_id)
      ? String(body.empresa_id)
      : profile?.empresa_id
    if (!empresaId)        return json({ error: "Empresa não encontrada" }, 400)
    if (!code)             return json({ error: "Faltou o código do cadastro (code)." }, 400)
    if (!waba_id)          return json({ error: "Faltou o WABA (waba_id)." }, 400)
    if (!phone_number_id)  return json({ error: "Faltou o número (phone_number_id)." }, 400)

    // ── 1. Troca o code por um token da integração ──
    const tokenRes = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
        + `?client_id=${APP_ID}&client_secret=${APP_SECRET}&code=${encodeURIComponent(code)}`,
    )
    const tokenData = await tokenRes.json().catch(() => ({}))
    const bizToken = tokenData?.access_token
    if (!bizToken) {
      console.error("[signup] troca de code falhou", JSON.stringify(tokenData).slice(0, 400))
      return json({ error: "Não consegui validar a conexão com a Meta. Tente conectar de novo." }, 400)
    }

    // ── 2. Assina o app na WABA do lojista (pra receber os webhooks) ──
    const sub = await graph(`${waba_id}/subscribed_apps`, bizToken, "POST")
    if (!sub.ok) console.error("[signup] subscribe falhou", sub.status, JSON.stringify(sub.data).slice(0, 300))

    // ── 3. Registra o número no Cloud API com um PIN ──
    const pin = gerarPin(empresaId)
    const reg = await graph(`${phone_number_id}/register`, bizToken, "POST", {
      messaging_product: "whatsapp",
      pin,
    })
    // "já registrado" também é sucesso pra gente
    const jaRegistrado = !reg.ok && JSON.stringify(reg.data).includes("already")
    if (!reg.ok && !jaRegistrado) {
      console.error("[signup] register falhou", reg.status, JSON.stringify(reg.data).slice(0, 400))
      const userMsg = reg.data?.error?.error_user_msg
      return json({
        error: userMsg
          ? `A Meta pediu: ${userMsg}`
          : "Não consegui ativar o número no Cloud API. Confira se o número foi verificado no popup e tente de novo.",
      }, 400)
    }

    // ── 4. Puxa dados de exibição e salva no whatsapp_config ──
    const info = await graph(
      `${phone_number_id}?fields=display_phone_number,verified_name`, bizToken,
    )
    const displayNumber = info.data?.display_phone_number ?? null
    const verifiedName  = info.data?.verified_name ?? null

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    const { error: upErr } = await supabaseAdmin
      .from("whatsapp_config")
      .upsert({
        empresa_id:            empresaId,
        instance_name:         `cloud_${empresaId.replace(/-/g, "")}`,
        ativo:                 true,
        cloud_phone_number_id: phone_number_id,
        cloud_display_number:  displayNumber,
        cloud_waba_id:         waba_id,
        cloud_pin:             pin,
        cloud_verified_name:   verifiedName,
        updated_at:            new Date().toISOString(),
      }, { onConflict: "empresa_id" })

    if (upErr) {
      console.error("[signup] salvar config falhou", upErr.message)
      return json({ error: "Conectou na Meta mas falhou ao salvar. Contate o suporte." }, 500)
    }

    return json({
      ok: true,
      phone_number_id,
      display_number: displayNumber,
      verified_name: verifiedName,
    })
  } catch (e) {
    console.error("[signup] exceção", String(e))
    return json({ error: "Erro inesperado. Tente novamente." }, 500)
  }
})
