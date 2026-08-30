// Compra de saldo do assistente de IA, por PIX.
//
// Mesma mecânica dos créditos do bot (whatsapp-creditos): o PIX é gerado na
// CONTA CENTRAL da FWC — não na conta da loja —, porque quem paga a API da
// Anthropic sou eu, não ela. Isso é o oposto do PIX de pedido, que cai direto
// na conta do lojista.
//
// Quem credita é o `mercadopago-webhook` chamando a RPC confirmar_pagamento_ia,
// que é atômica e idempotente. Aqui nunca se credita nada direto: o MP repete o
// mesmo aviso várias vezes, e crédito em dobro é dinheiro perdido de verdade.
//
// A reconciliação em `saldo` é a rede de segurança pra quando o webhook se
// perde — sem ela, o lojista paga, não recebe, e liga achando que foi roubado.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const MP_ACCESS_TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? ""
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const MIN_REAIS = 5
const MAX_REAIS = 500
const VALORES = [10, 20, 50, 100]   // atalhos da tela

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

async function mp(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

// Confere no MP os PIX ainda pendentes desta loja e credita os que já foram
// pagos. Roda a cada consulta de saldo — barato, e resolve sozinho o caso do
// webhook que não chegou.
async function reconciliar(sb: any, empresaId: string) {
  const { data: pendentes } = await sb.from("ia_saldo_pagamentos")
    .select("mp_payment_id").eq("empresa_id", empresaId).eq("status", "pendente")
    .order("created_at", { ascending: false }).limit(10)

  for (const p of (pendentes ?? [])) {
    try {
      const pag = await mp(`/v1/payments/${p.mp_payment_id}`)
      if (pag?.status === "approved") {
        await sb.rpc("confirmar_pagamento_ia", { p_mp_payment_id: String(p.mp_payment_id) })
      } else if (["cancelled", "rejected", "expired"].includes(pag?.status)) {
        await sb.from("ia_saldo_pagamentos").update({ status: "cancelado" })
          .eq("mp_payment_id", p.mp_payment_id).eq("status", "pendente")
      }
    } catch (e) {
      console.error("[ia-saldo] reconciliar", p.mp_payment_id, e)
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return json({ error: "Método não suportado." }, 405)

  try {
    const auth = req.headers.get("Authorization") ?? ""
    const token = auth.replace(/^Bearer\s+/i, "").trim()
    if (!token) return json({ error: "Faça login." }, 401)

    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
    const { data: { user }, error: authErr } = await sb.auth.getUser(token)
    if (authErr || !user) return json({ error: "Sessão expirada. Entre de novo." }, 401)

    const { data: perfil } = await sb.from("profiles")
      .select("empresa_id, perfil").eq("id", user.id).maybeSingle()
    if (!perfil?.empresa_id) return json({ error: "Não achei sua loja." }, 400)
    // Comprar saldo é gastar dinheiro da loja: só o dono.
    if (perfil.perfil !== "admin") return json({ error: "Só o administrador compra saldo." }, 403)

    const empresaId: string = perfil.empresa_id
    const body = await req.json().catch(() => ({}))
    const acao = String(body?.acao ?? "saldo")

    // ── SALDO ────────────────────────────────────────────────────────────────
    if (acao === "saldo") {
      await reconciliar(sb, empresaId)
      const { data: emp } = await sb.from("empresas")
        .select("ia_saldo_centavos, ia_franquia_centavos").eq("id", empresaId).maybeSingle()
      return json({
        saldo: Number(emp?.ia_saldo_centavos ?? 0) / 100,
        franquia: Number(emp?.ia_franquia_centavos ?? 500) / 100,
        valores: VALORES, min: MIN_REAIS, max: MAX_REAIS,
      })
    }

    // ── COMPRAR (gera o PIX) ─────────────────────────────────────────────────
    if (acao === "comprar") {
      if (!MP_ACCESS_TOKEN) return json({ error: "Pagamento não configurado." }, 503)
      const valor = Math.round(Number(body?.valor) * 100) / 100
      if (!(valor >= MIN_REAIS && valor <= MAX_REAIS)) {
        return json({ error: `Escolha um valor entre R$ ${MIN_REAIS} e R$ ${MAX_REAIS}.` }, 400)
      }

      const { data: emp } = await sb.from("empresas").select("nome").eq("id", empresaId).maybeSingle()
      // 30 minutos é o mínimo que o MP aceita para PIX.
      const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString()

      const pag = await mp("/v1/payments", "POST", {
        transaction_amount: valor,
        description: `Saldo Assistente IA - ${emp?.nome ?? "Loja"}`,
        payment_method_id: "pix",
        date_of_expiration: expira,
        payer: { email: user.email ?? `loja_${empresaId}@fwcinter.com` },
        notification_url: `${SUPABASE_URL}/functions/v1/mercadopago-webhook`,
        metadata: { tipo: "saldo_ia", empresa_id: empresaId },
      })
      if (!pag?.id) {
        console.error("[ia-saldo] mp", pag)
        return json({ error: "Não consegui gerar o PIX agora. Tente de novo." }, 502)
      }

      // Grava ANTES de devolver: é esta linha que o webhook procura pra saber
      // que o pagamento é de IA. Sem ela, o dinheiro entra e ninguém credita.
      const { error: insErro } = await sb.from("ia_saldo_pagamentos").insert({
        empresa_id: empresaId,
        mp_payment_id: String(pag.id),
        valor_reais: valor,
        status: "pendente",
      })
      if (insErro) {
        console.error("[ia-saldo] insert", insErro.message)
        return json({ error: "Não consegui registrar a compra. Tente de novo." }, 500)
      }

      return json({
        mp_payment_id: String(pag.id),
        valor,
        expira_em: expira,
        qr_code:        pag.point_of_interaction?.transaction_data?.qr_code,
        qr_code_base64: pag.point_of_interaction?.transaction_data?.qr_code_base64,
      })
    }

    // ── CONFERIR (a tela pergunta de tempos em tempos se já caiu) ────────────
    if (acao === "conferir") {
      const id = String(body?.mp_payment_id ?? "")
      if (!id) return json({ error: "Pagamento não informado." }, 400)

      const { data: compra } = await sb.from("ia_saldo_pagamentos")
        .select("status, valor_reais").eq("mp_payment_id", id)
        .eq("empresa_id", empresaId).maybeSingle()
      if (!compra) return json({ error: "Pagamento não encontrado." }, 404)

      if (compra.status === "pendente") {
        // Não espera o webhook: pergunta direto ao MP. O lojista está parado na
        // frente da tela esperando, e o aviso do MP às vezes demora ou se perde.
        const pag = await mp(`/v1/payments/${id}`)
        if (pag?.status === "approved") {
          await sb.rpc("confirmar_pagamento_ia", { p_mp_payment_id: id })
        } else if (["cancelled", "rejected", "expired"].includes(pag?.status)) {
          await sb.from("ia_saldo_pagamentos").update({ status: "cancelado" })
            .eq("mp_payment_id", id).eq("status", "pendente")
        }
      }

      const { data: dep } = await sb.from("ia_saldo_pagamentos")
        .select("status").eq("mp_payment_id", id).maybeSingle()
      const { data: emp } = await sb.from("empresas")
        .select("ia_saldo_centavos").eq("id", empresaId).maybeSingle()

      return json({
        status: dep?.status ?? "pendente",
        saldo: Number(emp?.ia_saldo_centavos ?? 0) / 100,
      })
    }

    return json({ error: "Ação desconhecida." }, 400)
  } catch (e) {
    console.error("[ia-saldo]", e)
    return json({ error: "Deu erro aqui. Tente de novo em instantes." }, 500)
  }
})
