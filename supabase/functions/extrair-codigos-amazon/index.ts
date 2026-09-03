// Recebe o print de pedidos Amazon e extrai os números de pedido.
// Entrada: { imageBase64: string, mimetype?: string }
// Saída:   { ok: true, codigos: string[] }

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
    if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY não configurada." }, 503)

    const body = await req.json().catch(() => ({}))
    const imageBase64: string = body?.imageBase64 ?? ""
    const mimetype: string = body?.mimetype ?? "image/jpeg"

    if (!imageBase64) return json({ ok: false, error: "Imagem não enviada." }, 400)

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimetype, data: imageBase64 },
            },
            {
              type: "text",
              text: `Esta imagem pode conter UM ou VÁRIOS pedidos Amazon. Encontre e liste TODOS os números de pedido.
Procure por textos como "Nº do pedido", "Order ID", "Número do pedido" seguidos do código.
O formato do código é sempre: 3 dígitos - 7 dígitos - 7 dígitos (ex: 702-0310350-3249874).
Inclua TODOS os códigos que encontrar, sem exceção.
Responda SOMENTE com JSON puro, sem markdown, sem explicação:
{"codigos":["701-6419795-2617063","702-2879020-9905848","702-0341331-5545832"]}
Se não encontrar nenhum, retorne: {"codigos":[]}`,
            },
          ],
        }],
      }),
    })

    if (!resp.ok) {
      const err = await resp.text()
      return json({ ok: false, error: `Erro IA: ${err}` }, 502)
    }

    const data = await resp.json()
    const texto: string = data?.content?.[0]?.text ?? ""

    // Extrai o JSON da resposta (pode vir com texto ao redor)
    const match = texto.match(/\{[\s\S]*\}/)
    if (!match) return json({ ok: true, codigos: [] })

    const parsed = JSON.parse(match[0])
    const codigos: string[] = (parsed?.codigos ?? [])
      .map((c: string) => c.trim())
      .filter((c: string) => /^\d{3}-\d{7}-\d{7}$/.test(c))

    return json({ ok: true, codigos })
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})
