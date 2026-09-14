import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// GERAR BANNER COM IA (mig 0270).
//
// Faz duas coisas ao mesmo tempo e devolve pro navegador:
//   1. TEXTOS — o Claude organiza o que a loja escreveu: título curto do
//      produto, etiqueta, tema em letra cursiva e as linhas do selo, com a
//      acentuação corrigida (a loja digita "cafe gratis", sai "CAFÉ GRÁTIS").
//   2. CENA — a OpenAI recria a foto REAL do produto numa cena de propaganda,
//      SEM nenhuma letra. Letra de IA erra acento e preço (testado em
//      14/09/2026: "CAFĚ GRĂTIS"); por isso quem escreve é o navegador.
//
// A cena vai pro bucket "banners" e cada geração conta no limite do mês.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const LIMITE_MES = 16

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } })

async function textosDoBanner(produto: string, tema: string, promocao: string) {
  const system = `Você organiza textos de um banner promocional de delivery brasileiro. Responda SÓ com JSON.
Corrija acentuação e ortografia do português (cafe → café, gratis → grátis, voce → você), sem mudar o sentido.
Campos:
- "titulo": o nome principal do produto em 1 ou 2 palavras curtas, MAIÚSCULAS (ex.: "Cuscuz + Adicionais" → "CUSCUZ"; "Picolé Sabor da Fruta" → "PICOLÉ").
- "subtitulo": o complemento do nome, curto, MAIÚSCULAS, começando com "+" quando for adicional (ex.: "+ ADICIONAIS"; "SABOR DA FRUTA"). Vazio se não houver.
- "tema": frase curtinha pra letra cursiva, 2 a 3 palavras, a partir do tema (ex.: "monte seu cuscuz" → "Monte seu"; "dia dos namorados" → "Dia dos Namorados"). Nunca repita o título.
- "selo": lista de 3 a 5 linhas curtas da promoção, cada uma {"texto","estilo"}; estilos: "pequeno" (frase de apoio), "faixa" (verbo/chamada, 1 linha só), "grande" (o benefício principal, 1 ou 2 palavras), "destaque" (complemento do benefício). Ex.: "na compra de um cuscuz voce ganha um cafe gratis" → [{"texto":"NA COMPRA DE","estilo":"pequeno"},{"texto":"UM CUSCUZ","estilo":"pequeno"},{"texto":"GANHE UM","estilo":"faixa"},{"texto":"CAFÉ","estilo":"grande"},{"texto":"GRÁTIS","estilo":"destaque"}]. Tudo MAIÚSCULO. Lista vazia se não houver promoção.
- "cta": "PEÇA AGORA!" (ou algo equivalente curto se a promoção pedir).
- "cena_en": em inglês, 1 a 2 frases descrevendo adereços e clima da cena que combinam com o produto, o tema e a promoção (ex.: "a small cup of black coffee blurred in the background, cozy Brazilian breakfast diner"). Nunca peça texto na imagem.`
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: `Produto: ${produto}\nTema: ${tema || "(sem tema)"}\nPromoção: ${promocao || "(sem promoção)"}` }],
    }),
  })
  const data = await res.json()
  const txt: string = data?.content?.[0]?.text ?? ""
  const ini = txt.indexOf("{")
  const fim = txt.lastIndexOf("}")
  if (ini === -1 || fim === -1) throw new Error("textos: resposta sem JSON")
  return JSON.parse(txt.slice(ini, fim + 1))
}

function promptCena(produto: string, tema: string, extra: string, temFoto: boolean) {
  return [
    `Professional food advertising photograph for a Brazilian delivery restaurant promotion${tema ? ` with the theme "${tema}"` : ""}.`,
    temFoto
      ? `Use EXACTLY the food from the reference photo (${produto}). Keep the same food, same ingredients and the same kind of plate or packaging; make it look fresh, glossy and appetizing.`
      : `The product is: ${produto}. Show it beautifully plated or packaged, fresh and appetizing.`,
    "Place the product on the RIGHT side of the frame, slightly angled, on a rustic dark wooden table.",
    "Warm cinematic golden lighting, soft steam when it makes sense, shallow depth of field, warm blurred bokeh lights in the background.",
    extra || "",
    "Keep the LEFT 45% of the image darker and clean (out of focus) so text can be placed there later.",
    "Absolutely NO text, NO letters, NO numbers, NO logos, NO signs with words anywhere in the image.",
  ].filter(Boolean).join(" ")
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (!OPENAI_API_KEY || !ANTHROPIC_API_KEY) return json({ ok: false, error: "IA não configurada" }, 503)

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
    const { data: u } = await sb.auth.getUser(jwt)
    if (!u?.user) return json({ ok: false, error: "Faça login de novo." }, 401)
    const { data: perfil } = await sb.from("profiles").select("empresa_id, perfil").eq("id", u.user.id).maybeSingle()
    const empresaId = perfil?.empresa_id
    if (!empresaId || !["admin", "super_admin"].includes(String(perfil?.perfil))) {
      return json({ ok: false, error: "Só o administrador da loja gera banners." }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const produtoId = String(body.produto_id ?? "")
    const tema = String(body.tema ?? "").trim().slice(0, 120)
    const promocao = String(body.promocao ?? "").trim().slice(0, 200)
    if (!produtoId) return json({ ok: false, error: "Escolha o produto." }, 400)

    // Limite do mês (cada cena custa).
    const inicioMes = new Date()
    inicioMes.setUTCDate(1)
    inicioMes.setUTCHours(3, 0, 0, 0)   // meia-noite de Brasília do dia 1
    const { count: usados } = await sb.from("banner_geracoes")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", empresaId).gte("criado_em", inicioMes.toISOString())
    if ((usados ?? 0) >= LIMITE_MES) {
      return json({ ok: false, error: `Você já gerou ${LIMITE_MES} banners este mês. O limite renova no dia 1.` }, 429)
    }

    const [{ data: produto }, { data: empresa }] = await Promise.all([
      sb.from("produtos").select("id, nome, preco_venda, preco_promocional, foto_url, empresa_id").eq("id", produtoId).maybeSingle(),
      sb.from("empresas").select("nome").eq("id", empresaId).maybeSingle(),
    ])
    if (!produto || produto.empresa_id !== empresaId) return json({ ok: false, error: "Produto não encontrado." }, 404)

    // Textos primeiro (rápido): a descrição da cena sai deles.
    const textos = await textosDoBanner(produto.nome, tema, promocao)
    const prompt = promptCena(produto.nome, tema, String(textos?.cena_en ?? ""), !!produto.foto_url)

    let resImg: Response
    if (produto.foto_url) {
      const foto = await fetch(produto.foto_url)
      if (!foto.ok) return json({ ok: false, error: "Não consegui abrir a foto do produto." }, 422)
      const tipo = foto.headers.get("content-type") ?? "image/jpeg"
      const form = new FormData()
      form.append("model", "gpt-image-1")
      form.append("prompt", prompt)
      form.append("size", "1536x1024")
      form.append("quality", "high")
      form.append("output_format", "jpeg")
      form.append("output_compression", "90")
      form.append("image[]", new Blob([await foto.arrayBuffer()], { type: tipo }), "produto")
      resImg = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form,
      })
    } else {
      resImg = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1536x1024", quality: "high", output_format: "jpeg", output_compression: 90 }),
      })
    }
    const img = await resImg.json().catch(() => ({}))
    const b64 = img?.data?.[0]?.b64_json
    if (!resImg.ok || !b64) {
      console.error("[gerar-banner] OpenAI:", resImg.status, JSON.stringify(img).slice(0, 400))
      return json({ ok: false, error: "A IA não conseguiu gerar a imagem agora. Tente de novo em instantes." }, 502)
    }

    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const caminho = `${empresaId}/cenas/${crypto.randomUUID()}.jpg`
    const { error: upErr } = await sb.storage.from("banners").upload(caminho, bytes, { contentType: "image/jpeg" })
    if (upErr) return json({ ok: false, error: "Não consegui guardar a imagem: " + upErr.message }, 500)
    const cenaUrl = sb.storage.from("banners").getPublicUrl(caminho).data.publicUrl

    await sb.from("banner_geracoes").insert({ empresa_id: empresaId, produto_id: produto.id, cena_url: cenaUrl, criado_por: u.user.id })

    const preco = Number(produto.preco_promocional) > 0 ? Number(produto.preco_promocional) : Number(produto.preco_venda)
    return json({
      ok: true,
      cena_url: cenaUrl,
      textos: {
        loja: empresa?.nome ?? "",
        tema: textos?.tema ?? "",
        titulo: textos?.titulo ?? produto.nome,
        subtitulo: textos?.subtitulo ?? "",
        preco,
        selo: Array.isArray(textos?.selo) ? textos.selo : [],
        cta: textos?.cta || "PEÇA AGORA!",
      },
      usados: (usados ?? 0) + 1,
      limite: LIMITE_MES,
    })
  } catch (e) {
    console.error("[gerar-banner]", e)
    return json({ ok: false, error: String(e) }, 500)
  }
})
