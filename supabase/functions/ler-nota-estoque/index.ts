// Lê uma NOTA DE COMPRA (nota fiscal, cupom do fornecedor, foto ou PDF) e extrai os
// itens comprados — quantidade e custo unitário — casando com o catálogo da loja,
// pra dar ENTRADA no estoque de uma vez. Mesma infra do `ler-print-pedido`.
//
// Entrada (POST JSON):
//   { imageBase64: string, mimetype: string, produtos: [{ id, nome }] }
// Saída:
//   { ok, itens: [{ produto_id, nome, quantidade, custo_unit }],
//        nao_encontrados: [{ nome, quantidade, custo_unit }] }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "IA não configurada (ANTHROPIC_API_KEY)." }, 503)

    const body = await req.json().catch(() => ({}))
    const imageBase64: string = body?.imageBase64 ?? ""
    const mimetype: string = body?.mimetype || "image/png"
    const produtos: { id: string; nome: string }[] = Array.isArray(body?.produtos) ? body.produtos : []

    if (!imageBase64) return json({ ok: false, error: "Nenhum arquivo recebido." }, 400)

    const isPdf = mimetype === "application/pdf"
    const arquivoBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
      : { type: "image", source: { type: "base64", media_type: mimetype, data: imageBase64 } }

    // Catálogo por índice (economiza tokens e evita o modelo inventar ids).
    const cap = produtos.slice(0, 600)
    const catalogoTxt = cap.map((p, i) => `${i}\t${p.nome}`).join("\n")

    const system = [
      "Você lê uma NOTA DE COMPRA (nota fiscal, cupom fiscal, nota do fornecedor, pedido de compra)",
      "— foto ou PDF — e devolve os ITENS COMPRADOS em JSON, pra dar entrada no estoque de um PDV.",
      "",
      "Você recebe o CATÁLOGO da loja como linhas 'indice<TAB>nome'.",
      "Para CADA item comprado que aparecer na nota, encontre o produto do catálogo que corresponde",
      "(mesmo com o nome abreviado/diferente, ex.: 'REFRIG COCA 2L' = 'Coca 2 litros'). Use o INDICE.",
      "Se nenhum produto do catálogo corresponder de forma razoável, coloque em 'nao_encontrados'.",
      "",
      "Responda SOMENTE com um JSON válido, sem texto antes ou depois, neste formato:",
      "{",
      '  "itens": [ { "indice": number, "quantidade": number, "custo_unit": number | null } ],',
      '  "nao_encontrados": [ { "nome": string, "quantidade": number, "custo_unit": number | null } ]',
      "}",
      "",
      "Regras:",
      "- 'quantidade' = quantas UNIDADES foram compradas daquele item (>= 1, número).",
      "- 'custo_unit' = valor UNITÁRIO de compra (o que a loja pagou por 1 unidade), só o número. Se a nota",
      "  só tiver o total da linha, divida pelo total de unidades. Se não der pra saber, use null.",
      "- Use o ponto como separador decimal (ex.: 4.50).",
      "- Só use índices que existam no catálogo. Não invente itens que não estão na nota.",
      "- Ignore linhas que não são produto (impostos, frete, subtotais, dados do fornecedor).",
      "",
      "CATÁLOGO DA LOJA (indice<TAB>nome):",
      catalogoTxt || "(vazio)",
    ].join("\n")

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 3000,
        system,
        messages: [
          {
            role: "user",
            content: [
              arquivoBlock,
              { type: "text", text: "Extraia os itens comprados desta nota e responda só com o JSON." },
            ],
          },
        ],
      }),
    })

    if (!claudeRes.ok) {
      const err = await claudeRes.text()
      console.error("Claude error:", err)
      return json({ ok: false, error: "Falha ao ler a nota.", detalhe: err.slice(0, 400) }, 502)
    }

    const data = await claudeRes.json()
    const texto: string = data?.content?.[0]?.text ?? ""
    const ini = texto.indexOf("{")
    const fim = texto.lastIndexOf("}")
    if (ini === -1 || fim === -1) return json({ ok: false, error: "Não consegui interpretar a nota." }, 422)

    let parsed: any
    try { parsed = JSON.parse(texto.slice(ini, fim + 1)) } catch {
      return json({ ok: false, error: "Não consegui interpretar a nota." }, 422)
    }

    const itens: { produto_id: string; nome: string; quantidade: number; custo_unit: number | null }[] = []
    for (const it of (Array.isArray(parsed.itens) ? parsed.itens : [])) {
      const p = cap[Number(it?.indice)]
      if (!p) continue
      const q = Math.max(1, Math.floor(Number(it?.quantidade) || 1))
      const custo = it?.custo_unit != null && Number.isFinite(Number(it.custo_unit)) ? Number(it.custo_unit) : null
      itens.push({ produto_id: p.id, nome: p.nome, quantidade: q, custo_unit: custo })
    }

    const nao_encontrados = (Array.isArray(parsed.nao_encontrados) ? parsed.nao_encontrados : [])
      .map((n: any) => ({
        nome: String(n?.nome ?? "").slice(0, 120),
        quantidade: Math.max(1, Math.floor(Number(n?.quantidade) || 1)),
        custo_unit: n?.custo_unit != null && Number.isFinite(Number(n.custo_unit)) ? Number(n.custo_unit) : null,
      }))
      .filter((n: any) => n.nome)

    return json({ ok: true, itens, nao_encontrados })
  } catch (e) {
    console.error("ler-nota-estoque:", e)
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500)
  }
})
