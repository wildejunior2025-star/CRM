// Lê um print (screenshot) de um pedido feito em outro canal (iFood, WhatsApp,
// planilha, etc.) e extrai os dados estruturados pra pré-preencher a tela de
// "Nova venda (balcão)" do gestor. Usado por lojas que estão migrando pro CRM
// e ainda recebem pedidos por fora.
//
// Entrada (POST JSON):
//   { imageBase64: string, mimetype: string, produtos: [{ id, nome, preco }] }
// Saída:
//   { ok, dados: { cliente_nome, telefone, tipo, endereco{...}, pagamento,
//                  troco_para, observacoes, itens: [{ produto_id, nome, quantidade }],
//                  nao_encontrados: [string] } }

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
    const produtos: { id: string; nome: string; preco?: number; comps?: { nome: string; preco?: number }[] }[] = Array.isArray(body?.produtos) ? body.produtos : []

    if (!imageBase64) return json({ ok: false, error: "Nenhum arquivo recebido." }, 400)

    // Aceita imagem (print) OU PDF do pedido. O PDF vai como bloco "document".
    const isPdf = mimetype === "application/pdf"
    const arquivoBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: imageBase64 } }
      : { type: "image", source: { type: "base64", media_type: mimetype, data: imageBase64 } }

    // Catálogo enviado pro modelo: id curto (índice) + nome. Usamos o índice pra
    // não gastar tokens com UUIDs e evitar o modelo "inventar" ids.
    // Se o produto tem adicionais/complementos, listamos com sub-índices [comps: 0=..].
    const cap = produtos.slice(0, 600)
    const catalogoTxt = cap.map((p, i) => {
      const comps = Array.isArray(p.comps) ? p.comps : []
      const compsTxt = comps.length
        ? ` [comps: ${comps.map((c, j) => `${j}=${c.nome}${Number(c.preco) ? `(+${c.preco})` : ""}`).join(" ")}]`
        : ""
      return `${i}\t${p.nome}${compsTxt}`
    }).join("\n")

    const system = [
      "Você lê o PRINT (captura de tela) ou o PDF de um pedido de comida/mercado feito em OUTRO canal",
      "(iFood, WhatsApp, planilha, comanda, nota, etc.) e devolve os dados do pedido em JSON,",
      "pra preencher a tela de venda de um sistema de PDV.",
      "",
      "Você recebe o CATÁLOGO da loja como linhas 'indice<TAB>nome'.",
      "Para CADA item que aparecer no print, encontre o produto do catálogo que corresponde",
      "(mesmo que o nome esteja escrito diferente/abreviado). Use o INDICE do catálogo.",
      "Se nenhum produto do catálogo corresponder de forma razoável, coloque o texto do item em 'nao_encontrados'.",
      "",
      "Responda SOMENTE com um JSON válido, sem texto antes ou depois, neste formato:",
      "{",
      '  "cliente_nome": string | null,',
      '  "telefone": string | null,',
      '  "tipo": "entrega" | "retirada",',
      '  "endereco": { "rua": string|null, "numero": string|null, "bairro": string|null, "cidade": string|null } | null,',
      '  "pagamento": "dinheiro" | "pix" | "cartao" | null,',
      '  "troco_para": number | null,',
      '  "observacoes": string | null,',
      '  "itens": [ { "indice": number, "quantidade": number, "comps": [ number ] } ],',
      '  "nao_encontrados": [ string ]',
      "}",
      "",
      "Regras:",
      "- 'tipo' = 'entrega' se houver endereço de entrega; senão 'retirada'.",
      "- Só use índices que existam no catálogo. Quantidade sempre >= 1.",
      "- ADICIONAIS/COMPLEMENTOS: se o item traz extras escolhidos (sabores, acompanhamentos, molhos, 'com X', 'sem X' que na verdade é opção, tamanho, etc.),",
      "  ponha em 'comps' os SUB-ÍNDICES desses adicionais — os números que aparecem em [comps: 0=.. 1=..] DAQUELE produto. Se não tiver adicional, use 'comps': [].",
      "- Só use sub-índices que existam nos comps daquele produto. Se o extra do print não bater com nenhum comp, cite em 'observacoes'.",
      "- Telefone: só os dígitos, sem formatação.",
      "- 'troco_para' só quando o print disser 'troco para X'.",
      "- 'observacoes': junte adicionais/sem-tal-coisa/recados do print.",
      "- Não invente dados que não estão no print (deixe null).",
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
        max_tokens: 1500,
        system,
        messages: [
          {
            role: "user",
            content: [
              arquivoBlock,
              { type: "text", text: "Extraia o pedido deste arquivo e responda só com o JSON." },
            ],
          },
        ],
      }),
    })

    if (!claudeRes.ok) {
      const err = await claudeRes.text()
      console.error("Claude error:", err)
      return json({ ok: false, error: "Falha ao ler o print.", detalhe: err.slice(0, 400) }, 502)
    }

    const data = await claudeRes.json()
    let texto: string = data?.content?.[0]?.text ?? ""

    // Isola o JSON (o modelo às vezes embrulha em ```json ... ```)
    const ini = texto.indexOf("{")
    const fim = texto.lastIndexOf("}")
    if (ini === -1 || fim === -1) return json({ ok: false, error: "Não consegui interpretar o print." }, 422)

    let parsed: any
    try { parsed = JSON.parse(texto.slice(ini, fim + 1)) } catch {
      return json({ ok: false, error: "Não consegui interpretar o print." }, 422)
    }

    // Converte índices → produtos reais do catálogo (+ complementos escolhidos)
    const itens: { produto_id: string; nome: string; quantidade: number; complementos: { nome: string; preco: number }[] }[] = []
    for (const it of (Array.isArray(parsed.itens) ? parsed.itens : [])) {
      const idx = Number(it?.indice)
      const p = cap[idx]
      if (!p) continue
      const q = Math.max(1, Math.floor(Number(it?.quantidade) || 1))
      const compsAll = Array.isArray(p.comps) ? p.comps : []
      const complementos: { nome: string; preco: number }[] = []
      for (const ci of (Array.isArray(it?.comps) ? it.comps : [])) {
        const c = compsAll[Number(ci)]
        if (c) complementos.push({ nome: c.nome, preco: Number(c.preco) || 0 })
      }
      itens.push({ produto_id: p.id, nome: p.nome, quantidade: q, complementos })
    }

    const dados = {
      cliente_nome: parsed.cliente_nome ?? null,
      telefone: parsed.telefone ? String(parsed.telefone).replace(/\D/g, "") : null,
      tipo: parsed.tipo === "entrega" ? "entrega" : "retirada",
      endereco: parsed.endereco ?? null,
      pagamento: ["dinheiro", "pix", "cartao"].includes(parsed.pagamento) ? parsed.pagamento : null,
      troco_para: parsed.troco_para != null ? Number(parsed.troco_para) : null,
      observacoes: parsed.observacoes ?? null,
      itens,
      nao_encontrados: Array.isArray(parsed.nao_encontrados) ? parsed.nao_encontrados : [],
    }

    return json({ ok: true, dados })
  } catch (e) {
    console.error("ler-print-pedido:", e)
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500)
  }
})
