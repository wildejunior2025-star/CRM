// Ajuda por IA — o visitante/cliente pergunta como faz alguma coisa no sistema
// e a IA responde em poucas linhas, indicando o video tutorial quando existir.
//
// Por que existe: mesmo com 24 cards e video em cada um, ninguem acha o video
// certo procurando na mao. Perguntar "como configuro a impressora?" e receber a
// resposta + o link e muito mais rapido — e tira ligacao do suporte.
//
// SEGURANCA: este endpoint e PUBLICO (fica na landing, sem login). Por isso:
//   - limite de tamanho da pergunta e do historico
//   - limite de perguntas por sessao/IP na janela de tempo
//   - a IA so fala do sistema; qualquer outro assunto ela recusa
// Sem isso, um endpoint de IA aberto na internet vira conta alta no fim do mes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const MAX_PERGUNTA   = 500   // caracteres
const MAX_HISTORICO  = 8     // mensagens (4 idas e voltas)
const LIMITE_JANELA  = 15    // perguntas...
const JANELA_MIN     = 10    // ...a cada 10 minutos, por IP

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  })

// Contagem simples por IP em memoria. Reinicia quando a function reinicia — o
// suficiente pra travar abuso casual sem depender de tabela nova no banco.
const usos = new Map<string, number[]>()
function passouDoLimite(ip: string): boolean {
  const agora = Date.now()
  const desde = agora - JANELA_MIN * 60_000
  const lista = (usos.get(ip) ?? []).filter(t => t > desde)
  lista.push(agora)
  usos.set(ip, lista)
  if (usos.size > 5000) usos.clear() // trava de memoria
  return lista.length > LIMITE_JANELA
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return json({ erro: "Método não suportado." }, 405)

  try {
    if (!ANTHROPIC_API_KEY) return json({ erro: "IA não configurada." }, 503)

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "sem-ip"
    if (passouDoLimite(ip)) {
      return json({ erro: "Muitas perguntas seguidas. Aguarde alguns minutos e tente de novo." }, 429)
    }

    const body = await req.json().catch(() => ({}))
    const pergunta = String(body?.pergunta ?? "").trim().slice(0, MAX_PERGUNTA)
    if (!pergunta) return json({ erro: "Escreva sua dúvida." }, 400)

    const historico = (Array.isArray(body?.historico) ? body.historico : [])
      .slice(-MAX_HISTORICO)
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))

    // Catalogo de videos — e o que a IA pode indicar. Sem isso ela inventaria link.
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
    const { data: videos } = await supabase
      .from("videos_tutorial")
      .select("chave, titulo, descricao, youtube_id")
      .eq("ativo", true)
      .order("ordem")

    const catalogo = (videos ?? [])
      .map(v => `- [${v.chave}] "${v.titulo}"${v.descricao ? ` — ${v.descricao}` : ""} (id: ${v.youtube_id})`)
      .join("\n") || "(nenhum vídeo cadastrado ainda)"

    const system = `Você é o assistente de ajuda do FWC Inter, um sistema de gestão para \
distribuidoras, pizzarias, restaurantes e lojas de delivery.

O QUE O SISTEMA FAZ
Integração com iFood, loja online (cardápio com link próprio), app do cliente, \
gestor de pedidos, painel do entregador, atendimento no salão (mesas e comandas), \
CRM de clientes, delivery, controle de estoque, pagamento por Pix, financeiro, \
portal do cliente, atendimento por WhatsApp com IA, relatórios e comissões, \
multi-empresa, rota automática do motoboy, leitor de print com IA, tela da cozinha, \
complementos e adicionais, marketplace de pagamentos, reservas, horários \
inteligentes, metas e resumo diário.

VÍDEOS DISPONÍVEIS (só estes existem)
${catalogo}

COMO RESPONDER
- Português do Brasil, direto, sem enrolação. No máximo 4 frases.
- Escreva para dono de loja, não para programador. Nada de jargão técnico.
- Quando existir vídeo que ajude, cite a chave dele entre colchetes no fim, \
assim: [chave]. Pode citar no máximo 2. Só use chaves da lista acima.
- Se não existir vídeo sobre aquilo, responda mesmo assim com a orientação e \
diga que ainda não há vídeo sobre esse ponto.
- Se não souber, diga que não sabe e oriente a falar com o suporte. Nunca invente \
tela, botão ou caminho que você não tem certeza que existe.
- Se a pergunta não for sobre o sistema, responda que você só ajuda com dúvidas \
do FWC Inter.`

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 600,
        system,
        messages: [...historico, { role: "user", content: pergunta }],
      }),
    })

    if (!resp.ok) {
      const detalhe = await resp.text()
      console.error("[ajuda-ia] anthropic", resp.status, detalhe)
      return json({ erro: "A IA está indisponível agora. Tente de novo em instantes." }, 502)
    }

    const data = await resp.json()

    // A IA pode recusar por segurança — nesse caso não há texto pra mostrar.
    if (data?.stop_reason === "refusal") {
      return json({ resposta: "Não consigo ajudar com isso. Me pergunte algo sobre o sistema.", videos: [] })
    }

    let texto = (data?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("")
      .trim()

    // Extrai as [chaves] citadas e devolve os vídeos reais — o link nunca vem
    // da IA, sempre do banco. Assim não tem como ela inventar um vídeo.
    const validas = new Set((videos ?? []).map(v => v.chave))
    const citadas: string[] = []
    texto = texto.replace(/\[([a-z0-9-]+)\]/gi, (todo: string, chave: string) => {
      const k = chave.toLowerCase()
      if (!validas.has(k)) return todo
      if (!citadas.includes(k)) citadas.push(k)
      return ""
    }).replace(/[ \t]+\n/g, "\n").trim()

    const sugeridos = citadas.slice(0, 2).flatMap(k =>
      (videos ?? []).filter(v => v.chave === k).slice(0, 1)
    )

    return json({ resposta: texto, videos: sugeridos })
  } catch (e) {
    console.error("[ajuda-ia]", e)
    return json({ erro: "Não consegui responder agora. Tente de novo." }, 500)
  }
})
