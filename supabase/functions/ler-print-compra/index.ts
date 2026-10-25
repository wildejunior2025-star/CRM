// Lê o print de um pedido de compra (app do Assaí, iFood Mercado, Amazon etc.)
// e devolve os itens e os valores. Usado pelo painel de e-mails (painel.cncloudi.com,
// projeto separado do CRM) pra anotar a compra feita em cada e-mail gerado.
// Só aceita chamada com o header x-segredo = PAINEL_PRINT_SEGREDO.
//
// Entrada (POST JSON): { imageBase64, mimetype }
// Saída: { ok, dados: { loja, pedido, data, itens: [{ nome, quantidade, valor }],
//                       subtotal, descontos, taxa, total } }   (valores em reais)

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const SEGREDO = Deno.env.get("PAINEL_PRINT_SEGREDO") ?? ""

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } })

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

Deno.serve(async (req) => {
  try {
    if (!SEGREDO || req.headers.get("x-segredo") !== SEGREDO) return json({ ok: false, error: "não autorizado" }, 401)
    if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "IA não configurada." }, 503)

    const body = await req.json().catch(() => ({}))
    const imageBase64: string = body?.imageBase64 ?? ""
    const mimetype: string = body?.mimetype || "image/jpeg"
    if (!imageBase64) return json({ ok: false, error: "Nenhuma imagem recebida." }, 400)

    const system = [
      "Você lê o PRINT (captura de tela) de um pedido de compra feito em app de mercado/loja",
      "(Assaí, Atacadão, iFood, Rappi, Amazon, Mercado Livre etc.) e devolve os dados em JSON.",
      "",
      "Responda SOMENTE com um JSON válido, sem texto antes ou depois, neste formato:",
      "{",
      '  "loja": string | null,',
      '  "pedido": string | null,',
      '  "data": string | null,',
      '  "itens": [ { "nome": string, "quantidade": number, "valor": number } ],',
      '  "subtotal": number | null,',
      '  "descontos": number | null,',
      '  "taxa": number | null,',
      '  "total": number | null',
      "}",
      "",
      "Regras:",
      "- 'pedido' = número do pedido como aparece (só o número/código).",
      "- 'data' = data e hora do pedido como aparece, no formato dd/mm/aaaa hh:mm quando der.",
      "- 'itens': um por produto, com o nome do produto como está escrito (sem a linha de aviso tipo 'Produto para maiores de 18 anos').",
      "  'quantidade' = o número de unidades (o número ao lado do item). 'valor' = o preço que aparece no item, em reais.",
      "- 'descontos' = soma dos descontos como número POSITIVO. 'taxa' = taxa de serviço/entrega somadas.",
      "- 'total' = o valor TOTAL pago que aparece no print.",
      "- Valores em reais como número (ex: 18.4). Não invente: o que não aparece fica null.",
    ].join("\n")

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimetype, data: imageBase64 } },
            { type: "text", text: "Extraia o pedido deste print e responda só com o JSON." },
          ],
        }],
      }),
    })
    if (!r.ok) {
      const err = await r.text()
      console.error("Claude error:", err)
      return json({ ok: false, error: "Falha ao ler o print." }, 502)
    }
    const data = await r.json()
    const texto: string = data?.content?.[0]?.text ?? ""
    const ini = texto.indexOf("{"), fim = texto.lastIndexOf("}")
    if (ini === -1 || fim === -1) return json({ ok: false, error: "Não consegui ler o print." }, 422)
    let p: any
    try { p = JSON.parse(texto.slice(ini, fim + 1)) } catch { return json({ ok: false, error: "Não consegui ler o print." }, 422) }

    const itens = (Array.isArray(p.itens) ? p.itens : [])
      .filter((it: any) => it && String(it.nome || "").trim())
      .map((it: any) => ({
        nome: String(it.nome).trim().slice(0, 200),
        quantidade: Math.max(1, Math.round(Number(it.quantidade) || 1)),
        valor: num(it.valor),
      }))
    if (!itens.length) return json({ ok: false, error: "Não achei itens nesse print." }, 422)

    const descontos = num(p.descontos)
    return json({
      ok: true,
      dados: {
        loja: p.loja ? String(p.loja).slice(0, 120) : null,
        pedido: p.pedido ? String(p.pedido).slice(0, 60) : null,
        data: p.data ? String(p.data).slice(0, 40) : null,
        itens,
        subtotal: num(p.subtotal),
        descontos: descontos != null ? Math.abs(descontos) : null,
        taxa: num(p.taxa),
        total: num(p.total),
      },
    })
  } catch (e) {
    console.error("ler-print-compra:", e)
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500)
  }
})
