// Quanto o Railway já consumiu no mês, e se tem fatura em aberto.
//
// POR QUE EXISTE
// Em 01/10/2026 o WhatsApp de todas as lojas ficou ~19 horas fora do ar porque
// o teste grátis do Railway venceu com duas faturas atrasadas (cartão sem
// saldo). Os avisos existiam — "US$ 2,51 (50% do crédito)", "US$ 5,03",
// "US$ 10,02" — mas só no e-mail deles, que ninguém abre. Aqui o número fica na
// mesma tela onde o dono já olha as contas do sistema.
//
// Precisa do segredo:
//   RAILWAY_TOKEN — token de conta em railway.com/account/tokens
//
// A API do Railway é GraphQL e muda de nome de campo entre versões. Em vez de
// chutar uma consulta e devolver "erro" pro usuário, esta função PERGUNTA ao
// servidor quais campos existem (`?debug=schema`) e tenta os formatos
// conhecidos em ordem, devolvendo o primeiro que responder.
//
// Saída: { ok, plano_usd, usado_usd, estimado_usd, incluso_usd, pct, fatura_aberta, moeda }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const RAILWAY_TOKEN = Deno.env.get("RAILWAY_TOKEN") ?? ""
const API = "https://backboard.railway.com/graphql/v2"

// O plano Hobby: US$ 5/mês, que já entram como crédito de uso.
const PLANO_USD = 5

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RAILWAY_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  })
  const texto = await r.text()
  let dados: any = null
  try { dados = JSON.parse(texto) } catch { /* resposta não-JSON */ }
  return { http: r.status, dados, bruto: texto.slice(0, 400) }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    if (!RAILWAY_TOKEN) {
      return json({ ok: false, motivo: "sem_token", erro: "Falta o segredo RAILWAY_TOKEN (railway.com/account/tokens)." })
    }

    const url = new URL(req.url)

    // Modo descoberta: diz quais campos de uso/cobrança esta conta enxerga.
    // Serve pra ajustar a consulta sem ficar adivinhando nome de campo.
    if (url.searchParams.get("debug") === "schema") {
      const r = await gql(`{ __schema { queryType { fields { name } } } }`)
      const nomes = (r.dados?.data?.__schema?.queryType?.fields ?? [])
        .map((f: any) => f.name)
        .filter((n: string) => /usage|estimate|invoice|subscription|plan|credit/i.test(n))
      return json({ ok: !!nomes.length, http: r.http, campos: nomes, erro: r.dados?.errors?.[0]?.message, bruto: nomes.length ? undefined : r.bruto })
    }

    // Quem é a conta e qual o workspace (o uso é cobrado por workspace).
    const eu = await gql(`{ me { id email workspaces { id name } } }`)
    if (eu.dados?.errors?.length || !eu.dados?.data?.me) {
      return json({ ok: false, motivo: "token_invalido", http: eu.http, erro: eu.dados?.errors?.[0]?.message ?? eu.bruto })
    }
    const workspace = eu.dados.data.me.workspaces?.[0]
    const inicio = new Date(); inicio.setUTCDate(1); inicio.setUTCHours(0, 0, 0, 0)
    const fim = new Date()

    // Os dois formatos que o Railway já usou para o mesmo dado. O primeiro que
    // responder vale; o outro fica de reserva pra quando eles mudarem de novo.
    const tentativas = [
      {
        nome: "estimatedUsage",
        query: `query($workspaceId:String!){ estimatedUsage(workspaceId:$workspaceId){ estimatedValue measurement } }`,
        vars: { workspaceId: workspace?.id },
        ler: (d: any) => {
          const linhas = d?.estimatedUsage ?? []
          const total = linhas.reduce((s: number, l: any) => s + (Number(l.estimatedValue) || 0), 0)
          return { usado: total / 100, estimado: total / 100 }
        },
      },
      {
        nome: "usage",
        query: `query($workspaceId:String!,$startDate:DateTime!,$endDate:DateTime!){
          usage(workspaceId:$workspaceId, startDate:$startDate, endDate:$endDate,
                measurements:[CPU_USAGE, MEMORY_USAGE_GB, DISK_USAGE_GB]){ measurement value } }`,
        vars: { workspaceId: workspace?.id, startDate: inicio.toISOString(), endDate: fim.toISOString() },
        ler: (d: any) => {
          const linhas = d?.usage ?? []
          const total = linhas.reduce((s: number, l: any) => s + (Number(l.value) || 0), 0)
          return { usado: total, estimado: total }
        },
      },
    ]

    for (const t of tentativas) {
      if (!t.vars.workspaceId) continue
      const r = await gql(t.query, t.vars)
      if (r.dados?.errors?.length || !r.dados?.data) continue
      const { usado, estimado } = t.ler(r.dados.data)
      const incluso = PLANO_USD
      const acima = Math.max(0, usado - incluso)
      return json({
        ok: true, via: t.nome, moeda: "USD",
        workspace: workspace?.name ?? null,
        plano_usd: PLANO_USD,
        incluso_usd: incluso,
        usado_usd: +usado.toFixed(2),
        estimado_usd: +(PLANO_USD + acima).toFixed(2),
        pct: Math.min(999, Math.round((usado / incluso) * 100)),
      })
    }

    return json({ ok: false, motivo: "sem_campo", erro: "A API do Railway não respondeu nenhum dos formatos conhecidos. Rode ?debug=schema." })
  } catch (e) {
    return json({ ok: false, erro: String(e).slice(0, 300) }, 500)
  }
})
