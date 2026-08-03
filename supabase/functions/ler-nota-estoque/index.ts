// Lê uma NOTA DE COMPRA (nota fiscal, cupom do fornecedor, foto ou PDF) e extrai os
// itens comprados — quantidade e custo unitário — casando com o catálogo da loja.
// A nota do mercado vem MISTURADA: itens de REVENDA (produto do catálogo, ex.: refri)
// e INSUMOS (matéria-prima da ficha técnica, ex.: farinha). A IA identifica cada um e
// diz o TIPO, pra dar entrada no estoque certo.
//
// Entrada (POST JSON):
//   { imageBase64, mimetype, produtos: [{id,nome}], materias: [{id,nome}] }
// Saída:
//   { ok, itens: [{ tipo:'produto'|'materia', id, nome, quantidade, custo_unit }],
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
    const prod: { id: string; nome: string }[] = (Array.isArray(body?.produtos) ? body.produtos : []).slice(0, 600)
    const mats: { id: string; nome: string }[] = (Array.isArray(body?.materias) ? body.materias : []).slice(0, 400)

    if (!imageBase64) return json({ ok: false, error: "Nenhum arquivo recebido." }, 400)

    const isPdf = mimetype === "application/pdf"
    const arquivoBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
      : { type: "image", source: { type: "base64", media_type: mimetype, data: imageBase64 } }

    // Catálogo combinado por índice: produtos de revenda + insumos (matéria-prima).
    const cat = [
      ...prod.map((p) => ({ id: p.id, nome: p.nome, tipo: "produto" as const })),
      ...mats.map((m) => ({ id: m.id, nome: m.nome, tipo: "materia" as const })),
    ]
    const catalogoTxt = cat.map((c, i) => `${i}\t[${c.tipo === "produto" ? "PRODUTO" : "INSUMO"}] ${c.nome}`).join("\n")

    const system = [
      "Você lê uma NOTA DE COMPRA (nota fiscal, cupom fiscal, nota do fornecedor, pedido de compra)",
      "— foto ou PDF — e devolve os ITENS COMPRADOS em JSON, pra dar entrada no estoque de um PDV.",
      "",
      "O CATÁLOGO da loja vem como linhas 'indice<TAB>[TIPO] nome'. O TIPO é:",
      "- PRODUTO = item de revenda (ex.: refrigerante, cerveja) — entra no estoque de produtos.",
      "- INSUMO  = matéria-prima da cozinha (ex.: farinha, frango, óleo) — entra no estoque de insumos.",
      "A MESMA nota costuma ter os dois tipos misturados.",
      "",
      "Para CADA item comprado na nota, ache a linha do catálogo que corresponde melhor",
      "(mesmo com o nome abreviado/diferente). Use o INDICE dessa linha.",
      "Se nada corresponder de forma razoável, coloque em 'nao_encontrados'.",
      "",
      "Responda SOMENTE com um JSON válido, sem texto antes ou depois:",
      "{",
      '  "itens": [ { "indice": number, "quantidade": number, "custo_unit": number | null } ],',
      '  "nao_encontrados": [ { "nome": string, "quantidade": number, "custo_unit": number | null } ]',
      "}",
      "",
      "Regras:",
      "- 'quantidade' = quantas UNIDADES foram compradas daquele item (>= 1, número).",
      "- 'custo_unit' = valor UNITÁRIO de compra (o que pagou por 1 unidade), só o número. Se a nota",
      "  só tiver o total da linha, divida pelo total de unidades. Se não der pra saber, use null.",
      "- Use ponto como separador decimal (ex.: 4.50).",
      "- Só use índices que existam no catálogo. Não invente itens que não estão na nota.",
      "- Ignore linhas que não são produto (impostos, frete, subtotais, dados do fornecedor).",
      "",
      "CATÁLOGO DA LOJA (indice<TAB>[TIPO] nome):",
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

    const itens: { tipo: string; id: string; nome: string; quantidade: number; custo_unit: number | null }[] = []
    for (const it of (Array.isArray(parsed.itens) ? parsed.itens : [])) {
      const c = cat[Number(it?.indice)]
      if (!c) continue
      const q = Math.max(1, Math.floor(Number(it?.quantidade) || 1))
      const custo = it?.custo_unit != null && Number.isFinite(Number(it.custo_unit)) ? Number(it.custo_unit) : null
      itens.push({ tipo: c.tipo, id: c.id, nome: c.nome, quantidade: q, custo_unit: custo })
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
