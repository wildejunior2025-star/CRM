// Montar treino com IA — o professor responde 4 coisas e a IA devolve o
// rascunho dos treinos (A, B, C...) e o microciclo de 8 semanas.
//
// Por que existe: o professor leva uns 15 minutos montando ficha no papel,
// aluno por aluno. Aqui ele ganha o rascunho em segundos e só ajeita.
//
// REGRAS QUE IMPORTAM:
//   - A IA só pode usar os exercícios QUE A ACADEMIA TEM (vão na lista, com o
//     número da máquina). Nada de sugerir aparelho que não existe lá.
//   - Quem prescreve é o professor: isto é RASCUNHO. Nada vai pro aluno sem
//     ele revisar e salvar.
//   - Restrição de saúde do aluno (diabetes, hipertensão, cardiopata, lesão)
//     entra no pedido e a IA tem que respeitar.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const MODELO = "claude-opus-5"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } })

type Exercicio = { id: string; nome: string; grupo: string; maquina: string | null }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return json({ erro: "Método não suportado." }, 405)

  try {
    if (!ANTHROPIC_API_KEY) return json({ erro: "IA não configurada." }, 503)

    const body = await req.json()
    const exercicios: Exercicio[] = body.exercicios ?? []
    const aluno = body.aluno ?? {}
    const pedido = body.pedido ?? {}

    if (!exercicios.length) return json({ erro: "A academia não tem exercícios cadastrados." }, 400)

    const lista = exercicios
      .map(e => `- ${e.nome} [${e.grupo}]${e.maquina ? ` (máquina ${e.maquina})` : " (peso livre)"} id=${e.id}`)
      .join("\n")

    const restricoes = [
      aluno.diabetes && "diabetes",
      aluno.hipertensao && "hipertensão",
      aluno.cardiopata && "cardiopata",
      aluno.saude_outra,
      pedido.restricoes,
    ].filter(Boolean).join(", ")

    const prompt = `Você é um professor de educação física montando o RASCUNHO de um treino de musculação.

ALUNO
Nome: ${aluno.nome ?? "—"}
Idade: ${aluno.idade ?? "não informada"}
Sexo: ${aluno.sexo === "F" ? "feminino" : aluno.sexo === "M" ? "masculino" : "não informado"}
Objetivo: ${pedido.objetivo ?? aluno.objetivo ?? "condicionamento geral"}
Nível: ${pedido.nivel ?? "iniciante"}
Dias por semana: ${pedido.dias ?? 3}
Restrições de saúde: ${restricoes || "nenhuma informada"}

EXERCÍCIOS QUE ESTA ACADEMIA TEM (use SOMENTE estes, pelo id):
${lista}

REGRAS
1. Monte exatamente ${pedido.dias ?? 3} treinos, nomeados A, B, C, D, E nessa ordem.
2. Cada treino tem de 5 a 8 exercícios, na ordem de execução (dos maiores grupos para os menores).
3. Use SOMENTE os ids da lista. Nunca invente exercício.
4. Distribua os grupos musculares ao longo da semana sem repetir o mesmo grupo em dias seguidos.
5. Respeite as restrições de saúde; se houver, evite exercícios de risco e diga por quê em "observacao".
5b. "variacao" só aceita: vazio, H (halteres), UNI (unilateral), ABERTO (pegada) ou CROSS. Dica de
   execução vai em "obs", curta (até 40 caracteres).
6. Monte o microciclo de 8 semanas variando séries e repetições conforme o objetivo
   (ex.: iniciante 3x12-15; hipertrofia 3-4x8-12; força 4x6-10), e marque "aumentar_peso": true
   nas semanas em que a carga deve subir. Sistema pode ser "Série única" ou "Bissérie".

Devolva o plano pela ferramenta montar_treino.`

    // Formato travado pela ferramenta: o modelo devolve o plano já pronto, em
    // vez de texto que a gente teria que adivinhar como ler.
    const ferramenta = {
      name: "montar_treino",
      description: "Devolve os treinos e o microciclo do aluno.",
      input_schema: {
        type: "object",
        properties: {
          treinos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                letra: { type: "string" },
                dia_semana: { type: "string" },
                foco: { type: "string" },
                itens: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      // Códigos curtos, do jeito que o professor escreve no
                      // cartão. Recado grande vai em "obs".
                      variacao: { type: "string", enum: ["", "H", "UNI", "ABERTO", "CROSS"] },
                      obs: { type: "string", description: "Dica curta de execução, até 40 caracteres" },
                    },
                    required: ["id"],
                  },
                },
              },
              required: ["letra", "itens"],
            },
          },
          semanas: {
            type: "array",
            items: {
              type: "object",
              properties: {
                numero: { type: "integer" },
                series: { type: "integer" },
                rep_min: { type: "integer" },
                rep_max: { type: "integer" },
                sistema: { type: "string" },
                aumentar_peso: { type: "boolean" },
              },
              required: ["numero", "series", "rep_min", "rep_max"],
            },
          },
          observacao: { type: "string" },
        },
        required: ["treinos", "semanas"],
      },
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: 6000,
        tools: [ferramenta],
        tool_choice: { type: "tool", name: "montar_treino" },
        messages: [{ role: "user", content: prompt }],
      }),
    })

    if (!resp.ok) {
      const txt = await resp.text()
      console.error("anthropic", resp.status, txt.slice(0, 400))
      return json({ erro: "A IA não respondeu agora. Tente de novo." }, 502)
    }

    const data = await resp.json()
    const uso = (data?.content ?? []).find((c: { type: string }) => c.type === "tool_use")
    const plano = uso?.input
    if (!plano?.treinos?.length) {
      console.error("sem plano", JSON.stringify(data).slice(0, 500))
      return json({ erro: "A IA respondeu fora do formato. Tente de novo." }, 502)
    }

    // Trava final: só passa exercício que existe mesmo na academia.
    const porId = new Map(exercicios.map(e => [e.id, e]))
    plano.treinos = (plano.treinos ?? []).map((t: Record<string, unknown>) => ({
      ...t,
      itens: ((t.itens ?? []) as { id: string; variacao?: string }[])
        .filter(i => porId.has(i.id))
        .map(i => ({
          ...i,
          variacao: ["H", "UNI", "ABERTO", "CROSS"].includes(i.variacao ?? "") ? i.variacao : "",
          nome: porId.get(i.id)!.nome,
          maquina: porId.get(i.id)!.maquina,
        })),
    })).filter((t: { itens: unknown[] }) => t.itens.length)

    return json(plano)
  } catch (e) {
    console.error(e)
    return json({ erro: "Deu erro ao montar o treino." }, 500)
  }
})
