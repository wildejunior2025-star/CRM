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
      '  "itens": [ { "indice": number, "descricao": string, "quantidade": number, "custo_unit": number | null } ],',
      '  "nao_encontrados": [ { "nome": string, "descricao": string, "quantidade": number, "custo_unit": number | null, "unidade": "kg"|"g"|"L"|"ml"|"un" } ]',
      "}",
      "",
      "Regras:",
      "- 'quantidade' = quanto entrou no estoque daquele item. PODE TER CASA DECIMAL.",
      "- ATENÇÃO COM ITEM VENDIDO POR PESO (carne, frango, queijo — unidade KG/G/L):",
      "  a nota traz 'Qtde 1' (é 1 peça) e uma coluna PESO com o que importa de verdade.",
      "  Nesses casos 'quantidade' = O PESO, com os decimais (6,6 é 6.6 — NUNCA 6 nem 66).",
      "- CONFIRA CADA LINHA pela conta: quantidade x custo_unit tem que bater com o TOTAL da",
      "  linha. Se não bater, você leu o número errado — refaça. Ex.: total 79,13 e unitário",
      "  11,99 → a quantidade é 6.6, não 6.",
      "- 'custo_unit' = valor UNITÁRIO de compra (o que pagou por 1 unidade), só o número. Se a nota",
      "  só tiver o total da linha, divida pelo total de unidades. Se não der pra saber, use null.",
      "- Use ponto como separador decimal (ex.: 4.50).",
      "- Só use índices que existam no catálogo. Não invente itens que não estão na nota.",
      "- Em 'nao_encontrados', escreva o 'nome' POR EXTENSO e em minúsculo, desabreviando o que",
      "  a nota encurtou (ex.: 'COXA S/C FGO' -> 'coxa sobre coxa de frango'). Esse nome vai",
      "  ser cadastrado do jeito que você escrever. E diga a 'unidade' pela nota: kg, g, L, ml ou un.",
      "- Ignore linhas que não são produto (impostos, frete, subtotais, dados do fornecedor).",
      "- 'descricao' = o texto da linha COMO ESTÁ NA NOTA, abreviação e tudo (ex.: 'B MAIZN ESTRL 307G').",
      "  É o que a loja vê pra conferir se você casou com o item certo. Vale pra TODO item de 'itens'.",
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
        // Nota de PDF (DANFE) tem MUITO mais linha que foto de cupom. Com 3000 a resposta
        // vinha cortada no meio e o JSON não abria — o usuário só via "erro na função".
        max_tokens: 16000,
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
    const texto: string = (Array.isArray(data?.content) ? data.content : [])
      .filter((b: any) => b?.type === "text").map((b: any) => b?.text ?? "").join("")
    const stop: string = data?.stop_reason ?? ""
    console.log("ler-nota-estoque: stop_reason", stop, "| chars", texto.length)

    const ini = texto.indexOf("{")
    if (ini === -1) {
      console.error("Sem JSON na resposta:", texto.slice(0, 300))
      return json({ ok: false, error: "Não consegui interpretar a nota. Tente uma foto/PDF mais nítido." }, 422)
    }
    const bruto = texto.slice(ini)

    // Se a resposta veio cortada (nota gigante), o JSON não fecha. Em vez de perder tudo,
    // cata os itens que JÁ vieram inteiros — melhor lançar 30 de 40 do que nenhum.
    let parsed: any = null
    let truncado = false
    try {
      parsed = JSON.parse(bruto.slice(0, bruto.lastIndexOf("}") + 1))
    } catch {
      truncado = true
      const pega = (re: RegExp) => {
        const out: any[] = []
        for (const m of bruto.matchAll(re)) { try { out.push(JSON.parse(m[0])) } catch { /* objeto pela metade */ } }
        return out
      }
      const itensSalvos = pega(/\{[^{}]*"indice"[^{}]*\}/g)
      const naoSalvos = pega(/\{[^{}]*"nome"\s*:[^{}]*\}/g)
      if (itensSalvos.length || naoSalvos.length) parsed = { itens: itensSalvos, nao_encontrados: naoSalvos }
    }

    if (!parsed) {
      console.error("JSON não abriu. Trecho:", bruto.slice(0, 300), "...", bruto.slice(-200))
      return json({ ok: false, error: "Não consegui interpretar a nota. Tente uma foto/PDF mais nítido." }, 422)
    }

    // Quantidade PODE ser fracionada — carne vem em 6,6 kg. Arredondar pra inteiro aqui
    // perdia o peso da nota (6,6 virava 6). Guarda 3 casas, que cobre grama e mililitro.
    const qtd = (v: unknown) => {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return 1
      return Math.round(n * 1000) / 1000
    }

    const itens: { tipo: string; id: string; nome: string; descricao: string; quantidade: number; custo_unit: number | null }[] = []
    for (const it of (Array.isArray(parsed.itens) ? parsed.itens : [])) {
      const c = cat[Number(it?.indice)]
      if (!c) continue
      const q = qtd(it?.quantidade)
      const custo = it?.custo_unit != null && Number.isFinite(Number(it.custo_unit)) ? Number(it.custo_unit) : null
      itens.push({ tipo: c.tipo, id: c.id, nome: c.nome, descricao: String(it?.descricao ?? "").slice(0, 120), quantidade: q, custo_unit: custo })
    }

    const nao_encontrados = (Array.isArray(parsed.nao_encontrados) ? parsed.nao_encontrados : [])
      .map((n: any) => ({
        nome: String(n?.nome ?? "").slice(0, 120),
        descricao: String(n?.descricao ?? "").slice(0, 120),
        quantidade: qtd(n?.quantidade),
        custo_unit: n?.custo_unit != null && Number.isFinite(Number(n.custo_unit)) ? Number(n.custo_unit) : null,
        unidade: ["kg", "g", "L", "ml", "un"].includes(String(n?.unidade)) ? String(n.unidade) : "un",
      }))
      .filter((n: any) => n.nome)

    // Avisa o lojista quando a nota era grande demais e pode ter sobrado item de fora.
    const aviso = (truncado || stop === "max_tokens")
      ? "A nota é grande e pode ter ficado item de fora. Confira a lista contra o papel."
      : null
    return json({ ok: true, itens, nao_encontrados, aviso })
  } catch (e) {
    console.error("ler-nota-estoque:", e)
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500)
  }
})
