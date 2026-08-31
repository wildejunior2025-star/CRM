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

// Templates que a loja precisa ter na conta dela, criados na conexão.
//
// Por que na conexão e não na hora de usar: template não é instantâneo — a
// Meta leva de minutos a horas pra aprovar. Se a gente só criasse quando
// precisasse mandar, a PRIMEIRA comanda de fiado de cada loja nova ia falhar
// esperando aprovação, e ninguém entenderia por quê. Criando agora, quando a
// loja conecta, a aprovação sai muito antes da primeira venda fiada.
//
// Cada loja que conecta o número próprio tem a conta Meta dela, e template
// mora na conta — não dá pra reaproveitar o de outra loja. O que dá pra
// reaproveitar é este código: o lojista não abre o Facebook, não preenche
// formulário, não espera ninguém.
const TEMPLATES_PADRAO = [
  {
    name: "comanda_fiado",
    language: "pt_BR",
    category: "UTILITY",
    components: [{
      type: "BODY",
      text: "Oi {{1}}! Aqui é da {{2}}.\n\nFicou anotado no seu FIADO em {{3}}: {{4}}\n\nTotal desta conta: {{5}}\nSeu total em aberto: {{6}}\n\nSe tiver algo errado, me avisa hoje mesmo que a gente confere.",
      example: {
        body_text: [[
          "Antonio", "Estação do Sabor", "20/08 às 12:52",
          "1x Almoço no Peso R$ 11,50; 1x suco de caju R$ 6,00",
          "R$ 34,00", "R$ 192,50",
        ]],
      },
    }],
  },
]

async function criarTemplatesDaLoja(wabaId: string, token: string) {
  for (const tpl of TEMPLATES_PADRAO) {
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(tpl),
      })
      const corpo = await res.json().catch(() => ({}))
      // Template repetido devolve erro (já existe) — e isso é sucesso, não
      // falha: quer dizer que a loja reconectou e o template continua lá.
      console.log("[signup] template", tpl.name, res.status, JSON.stringify(corpo).slice(0, 200))
    } catch (e) {
      // Nunca derruba a conexão: a loja fica conectada e conversando por texto
      // livre do mesmo jeito. Só o envio fora das 24h que espera o template.
      console.error("[signup] template", tpl.name, "falhou:", String(e).slice(0, 200))
    }
  }
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
    const { code } = body as Record<string, string>
    let waba_id = body.waba_id ? String(body.waba_id) : ""
    let phone_number_id = body.phone_number_id ? String(body.phone_number_id) : ""

    // super_admin pode conectar em nome de uma loja específica; lojista usa a dele
    const empresaId = (profile?.perfil === "super_admin" && body.empresa_id)
      ? String(body.empresa_id)
      : profile?.empresa_id
    if (!empresaId) return json({ error: "Empresa não encontrada" }, 400)
    if (!code)      return json({ error: "Faltou o código do cadastro (code)." }, 400)

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

    // ── 1b. Descobre a WABA e o número quando o popup não mandou ──
    // O popup manda os IDs por um evento à parte, que às vezes se perde (ele
    // termina numa página em branco e o aviso nunca chega ao navegador). O
    // token que acabamos de trocar sabe a quais WABAs ele dá acesso, então dá
    // pra achar tudo por aqui em vez de mandar a loja refazer o cadastro.
    if (!waba_id || !phone_number_id) {
      const dbg = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/debug_token`
          + `?input_token=${encodeURIComponent(bizToken)}`
          + `&access_token=${APP_ID}|${APP_SECRET}`,
      )
      const dbgData = await dbg.json().catch(() => ({}))
      const escopos = dbgData?.data?.granular_scopes ?? []
      const candidatas: string[] = waba_id ? [waba_id] : [...new Set(
        escopos
          .filter((s: { scope: string }) => s.scope?.startsWith("whatsapp_business_"))
          .flatMap((s: { target_ids?: string[] }) => s.target_ids ?? []),
      )] as string[]

      if (!candidatas.length) {
        console.error("[signup] sem waba no token", JSON.stringify(dbgData).slice(0, 400))
        return json({ error: "A Meta não disse qual conta foi conectada. Refaça a conexão até o fim." }, 400)
      }

      // A loja pode ter mais de uma conta compartilhada — inclusive uma recém
      // criada e VAZIA, se ela repetiu o cadastro. A que vale é a que tem número:
      // conta sem número não recebe mensagem nenhuma.
      for (const cand of candidatas) {
        const nums = await graph(`${cand}/phone_numbers?fields=id,display_phone_number`, bizToken)
        const primeiro = nums.data?.data?.[0]?.id
        if (primeiro) {
          waba_id = cand
          phone_number_id = phone_number_id || primeiro
          break
        }
      }

      if (!waba_id || !phone_number_id) {
        console.error("[signup] nenhuma waba com número", JSON.stringify(candidatas))
        return json({
          error: "A conta conectou mas ainda não tem número dentro dela. "
            + "Refaça a conexão escolhendo o número da loja até o fim.",
        }, 400)
      }
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
    // Nem toda recusa aqui é problema:
    //  • "already"  — número já registrado, que é o que a gente queria mesmo.
    //  • "not available for SMB businesses" — CONEXÃO POR COEXISTÊNCIA. Quando a
    //    loja pluga o número lendo o QR com o WhatsApp Business do celular, quem
    //    registra é o próprio app; esse endpoint nem existe pra ela. Tratar como
    //    falha derrubava justamente o caminho que as lojas vão usar.
    const textoReg = JSON.stringify(reg.data)
    const registroDispensado = !reg.ok
      && (textoReg.includes("already") || textoReg.includes("not available for SMB"))
    if (!reg.ok && !registroDispensado) {
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

    // ── 5. Guarda o token DESTA loja ──
    // Vai numa tabela sem policy (só service_role) porque o lojista consegue ler
    // a linha dele em whatsapp_config, e o token não pode vazar. É ele que o
    // whatsapp-cloud usa para responder por este número.
    const { error: tokErr } = await supabaseAdmin
      .from("whatsapp_cloud_tokens")
      .upsert({
        empresa_id: empresaId,
        token:      bizToken,
        waba_id:    waba_id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "empresa_id" })

    // Não é fatal: o token global do app ainda atende as WABAs compartilhadas.
    if (tokErr) console.error("[signup] salvar token falhou", tokErr.message)

    // Templates da loja, criados agora pra estarem aprovados quando precisar.
    // Não espera: a conexão termina na hora e a criação segue por trás.
    if (waba_id && bizToken) {
      criarTemplatesDaLoja(String(waba_id), String(bizToken)).catch(() => {})
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
