// Quanto da cota grátis do Cloudflare Workers já foi usada.
//
// O plano grátis dá 100.000 requisições por dia somando TODOS os workers da
// conta (crm, card-system-api, painel-email…). Passou disso, o Cloudflare
// obriga a migrar pro Workers Paid — US$ 5/mês. Esta função serve a barra que
// aparece no card do Cloudflare, em "Despesas do sistema".
//
// Precisa de dois segredos:
//   CF_API_TOKEN   — token do Cloudflare com permissão "Account Analytics: Read"
//   CF_ACCOUNT_ID  — id da conta
//
// Saída:
//   { ok, limite_dia, hoje, pico7d, pct_hoje, pct_pico, dias:[{data,requisicoes}],
//     workers:[{nome,requisicoes}], plano_pago_usd }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const CF_API_TOKEN  = Deno.env.get("CF_API_TOKEN") ?? ""
// A conta é sempre a mesma (não é segredo, é só um identificador); o segredo
// pode sobrescrever se um dia mudar de conta.
const CF_ACCOUNT_ID = Deno.env.get("CF_ACCOUNT_ID") ?? "5c5a632f5e523596c4ac9467099fffb6"

const LIMITE_DIA = 100_000   // requisições/dia no plano grátis
const PLANO_PAGO_USD = 5     // Workers Paid, por mês

const QUERY = `
query($acct:String!,$ini:Date!,$fim:Date!){
  viewer { accounts(filter:{accountTag:$acct}) {
    workersInvocationsAdaptive(limit:1000, filter:{date_geq:$ini, date_leq:$fim}) {
      dimensions { date scriptName }
      sum { requests errors }
    }
  } }
}`

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    if (!CF_API_TOKEN || !CF_ACCOUNT_ID) {
      return json({ ok: false, motivo: "sem_token", erro: "Faltam os segredos CF_API_TOKEN / CF_ACCOUNT_ID." })
    }

    const hoje = new Date()
    const iso = (d: Date) => d.toISOString().slice(0, 10)
    const ini = new Date(hoje.getTime() - 6 * 86400000)

    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: { acct: CF_ACCOUNT_ID, ini: iso(ini), fim: iso(hoje) },
      }),
    })
    const data = await r.json().catch(() => null)
    const linhas = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive
    if (!Array.isArray(linhas)) {
      const msg = data?.errors?.[0]?.message || `Cloudflare respondeu ${r.status}`
      return json({ ok: false, motivo: "erro_api", erro: String(msg).slice(0, 200) })
    }

    // Soma por dia e por worker
    const porDia: Record<string, number> = {}
    const porWorker: Record<string, number> = {}
    for (const l of linhas) {
      const dia = l?.dimensions?.date
      const nome = l?.dimensions?.scriptName ?? "?"
      const req = Number(l?.sum?.requests ?? 0)
      if (dia) porDia[dia] = (porDia[dia] ?? 0) + req
      porWorker[nome] = (porWorker[nome] ?? 0) + req
    }

    const dias = Object.keys(porDia).sort().map(d => ({ data: d, requisicoes: porDia[d] }))
    const hojeReq = porDia[iso(hoje)] ?? 0
    const pico = dias.reduce((m, d) => Math.max(m, d.requisicoes), 0)
    const pct = (v: number) => Math.min(100, Math.round((v / LIMITE_DIA) * 1000) / 10)

    return json({
      ok: true,
      limite_dia: LIMITE_DIA,
      plano_pago_usd: PLANO_PAGO_USD,
      hoje: hojeReq,
      pico7d: pico,
      pct_hoje: pct(hojeReq),
      pct_pico: pct(pico),
      dias,
      workers: Object.entries(porWorker)
        .map(([nome, requisicoes]) => ({ nome, requisicoes }))
        .sort((a, b) => b.requisicoes - a.requisicoes),
    })
  } catch (e) {
    return json({ ok: false, motivo: "erro", erro: String(e).slice(0, 200) })
  }
})
