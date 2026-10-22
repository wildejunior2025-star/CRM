// Entrada de estoque pelo WhatsApp, num GRUPO escolhido pelo lojista.
//
// O whatsapp-webhook repassa pra cá toda mensagem de grupo (antes ele jogava fora).
// Aqui só reage ao grupo que a loja ativou ("ativar estoque" escrito no grupo);
// qualquer outro grupo é ignorado em silêncio. O atendimento no privado não passa
// por esta função.
//
// Fluxo: texto / áudio / foto / PDF → a IA acha os itens no cadastro → responde a
// lista e espera SIM → lança em estoque_movimentos (produto) e
// materia_prima_movimentos (insumo). DESFAZER apaga o último lançamento.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { verCarteira, cobrar } from "../_shared/carteiraIa.ts"
import { AsyncLocalStorage } from "node:async_hooks"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""

// Toda resposta do robô começa com esta marca. O número do robô é o da loja, então
// o que ele manda volta pelo webhook como mensagem "fromMe" — sem a marca ele
// responderia a si mesmo pra sempre.
const MARCA = "🤖 *FWC Assistente*"
const VALIDADE_PENDENTE_MIN = 60
const VALIDADE_DESFAZER_MIN = 180

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const ok = () => new Response("ok")

type Item = { tipo: "produto" | "materia"; id: string; nome: string; quantidade: number; custo_unit: number | null; estoque_minimo?: number | null; mov?: Mov; motivo?: string }
type Mov = "entrada" | "saida" | "ajuste"
type NaoAchado = { nome: string; quantidade: number; custo_unit: number | null; unidade?: string; estoque_minimo?: number | null; mov?: Mov }
// Motivos (mesmos do Portal > Estoque). Perda e vencimento viram prejuízo (imprevisto) no financeiro.
const MOTIVOS: Record<Mov, string[]> = {
  entrada: ["compra", "devolucao", "bonificacao"],
  saida: ["perda", "vencimento", "consumo", "brinde"],
  ajuste: ["ajuste_inventario"],
}
const ROTULO: Record<string, string> = {
  compra: "compra", devolucao: "devolução", bonificacao: "bonificação", perda: "perda", vencimento: "vencimento",
  consumo: "consumo", brinde: "brinde", ajuste_inventario: "contagem",
}
const GERA_PREJUIZO = new Set(["perda", "vencimento"])
// Só COMPRA exige preço: bonificação é de graça, devolução e saída valem pelo custo já cadastrado.
const precisaPreco = (x: { mov?: Mov; motivo?: string }) => (x.mov ?? "entrada") === "entrada" && (x.motivo ?? "compra") === "compra"
type ProdutoNovo = { nome: string; preco_venda: number | null; preco_custo: number | null; categoria: string; quantidade_inicial: number | null; estoque_minimo: number | null }
type MinimoSolto = { tipo: "produto" | "materia"; id: string; nome: string; minimo: number }

// Haiku 4.5 (US$ por milhão de tokens) e Whisper (US$ por minuto) — pra cobrar o uso real.
const PRECO_HAIKU = { entrada: 1, saida: 5 }
const PRECO_WHISPER_MIN = 0.006
const usd = (u: { entrada: number; saida: number }) => (u.entrada * PRECO_HAIKU.entrada + u.saida * PRECO_HAIKU.saida) / 1_000_000

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
const qtdTxt = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",")
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

// Modo de teste (cabeçalho x-teste, só com a chave interna): as respostas voltam no HTTP em vez de ir pro WhatsApp.
const capturaTeste = new AsyncLocalStorage<string[]>()

async function enviar(instance: string, jid: string, texto: string) {
  const captura = capturaTeste.getStore()
  if (captura) { captura.push(texto); return }
  await fetch(`${EVOLUTION_API_URL}/message/sendText/${instance}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
    body: JSON.stringify({ number: jid, text: `${MARCA}\n${texto}` }),
  }).catch((e) => console.error("[estoque-wpp] sendText:", e?.message))
}

async function baixarMidia(instance: string, msg: any): Promise<{ base64: string; mimetype: string } | null> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instance}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ message: msg }),
    })
    if (!res.ok) return null
    const d = await res.json()
    if (!d?.base64) return null
    return { base64: d.base64, mimetype: String(d.mimetype ?? "application/octet-stream").split(";")[0] }
  } catch { return null }
}

async function transcrever(base64: string, mimetype: string): Promise<string | null> {
  if (!OPENAI_API_KEY) return null
  try {
    const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const ext = mimetype.includes("ogg") ? "ogg" : mimetype.includes("mp4") ? "mp4" : "mp3"
    const form = new FormData()
    form.append("file", new Blob([bin], { type: mimetype }), `audio.${ext}`)
    form.append("model", "whisper-1")
    form.append("language", "pt")
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, body: form,
    })
    if (!r.ok) return null
    return (await r.json()).text ?? null
  } catch { return null }
}

async function carregarCatalogo(empresaId: string) {
  const produtos: { id: string; nome: string }[] = []
  for (let de = 0; de < 3000; de += 1000) {
    const { data } = await sb.from("produtos").select("id, nome, controla_estoque")
      .eq("empresa_id", empresaId).eq("ativo", true).is("arquivado_em", null)
      .order("nome").order("id").range(de, de + 999)
    for (const p of data ?? []) if (p.controla_estoque !== false) produtos.push({ id: p.id, nome: p.nome })
    if ((data?.length ?? 0) < 1000) break
  }
  const { data: m } = await sb.from("materias_primas").select("id, nome, unidade")
    .eq("empresa_id", empresaId).eq("ativo", true).order("nome").limit(1000)
  return {
    produtos: produtos.slice(0, 700),
    materias: (m ?? []).map((x: any) => ({ id: x.id, nome: x.nome, unidade: x.unidade })),
  }
}

function jsonDaResposta(txt: string): any | null {
  const i = txt.indexOf("{"), f = txt.lastIndexOf("}")
  if (i < 0 || f < i) return null
  try { return JSON.parse(txt.slice(i, f + 1)) } catch { return null }
}

// Lê o que o lojista escreveu/falou. Com `pendentes` na mão, a frase é uma
// CORREÇÃO da lista que já está esperando o SIM.
async function entenderTexto(
  texto: string,
  cat: { produtos: { id: string; nome: string }[]; materias: { id: string; nome: string; unidade: string }[] },
  pendentes: Item[],
  pendNovos: NaoAchado[] = [],
  jaLancado = false,
): Promise<{ itens: Item[]; naoAchados: NaoAchado[]; ignorar: boolean; pergunta: boolean; corrige: boolean; produtosNovos: ProdutoNovo[]; minimos: MinimoSolto[]; custoUsd: number } | null> {
  const lista = [
    ...cat.produtos.map((p) => ({ tipo: "produto" as const, id: p.id, nome: p.nome, un: "" })),
    ...cat.materias.map((m) => ({ tipo: "materia" as const, id: m.id, nome: m.nome, un: m.unidade })),
  ]
  const catTxt = lista.map((c, i) => `${i}\t[${c.tipo === "produto" ? "PRODUTO" : "INSUMO"}] ${c.nome}${c.un ? ` (${c.un})` : ""}`).join("\n")
  const pendTxt = pendentes.map((p) => {
    const i = lista.findIndex((c) => c.id === p.id)
    return `${i}\t${p.nome}\tqtd ${p.quantidade}\tcusto ${p.custo_unit ?? "?"}`
  }).join("\n") + pendNovos.map((n) => `\nNOVO (fora do catálogo)\t${n.nome}\tqtd ${n.quantidade}\tcusto ${n.custo_unit ?? "?"}`).join("")

  const system = [
    "Você é o assistente de ESTOQUE de uma loja, num grupo de WhatsApp. O lojista conta o que COMPROU",
    "(escrevendo ou falando) e você devolve os itens pra dar ENTRADA no estoque.",
    "",
    "Responda SOMENTE com JSON válido:",
    '{ "ignorar": boolean, "pergunta": boolean, "corrige": boolean,',
    '  "produtos_novos": [ { "nome": string, "preco_venda": number|null, "preco_custo": number|null, "categoria": string|null, "quantidade_inicial": number|null, "estoque_minimo": number|null } ],',
    '  "minimos": [ { "indice": number, "estoque_minimo": number } ],',
    '  "itens": [ { "indice": number, "quantidade": number, "custo_unit": number|null, "custo_total": number|null, "estoque_minimo": number|null, "movimento": "entrada"|"saida"|"ajuste", "motivo": string } ],',
    '  "nao_encontrados": [ { "nome": string, "unidade": "kg"|"g"|"L"|"ml"|"un", "quantidade": number, "custo_unit": number|null, "custo_total": number|null, "estoque_minimo": number|null, "movimento": "entrada"|"saida"|"ajuste" } ] }',
    "",
    "Regras:",
    "- 'ignorar' = true quando a mensagem NÃO é sobre uma compra/entrada de mercadoria (papo, pergunta, cumprimento).",
    "  Nesse caso devolva itens e nao_encontrados vazios.",
    "- 'pergunta' = true quando (e só quando) a pessoa PEDE uma informação, análise ou ajuda sobre a loja ou o sistema,",
    "  ou pede pro robô FAZER algo na loja que NÃO seja estoque nem cadastro de produto novo (ex.: 'quanto vendi hoje',",
    "  'o que tá acabando', 'faz um diagnóstico', 'muda o preço da pizza', 'aumenta a taxa de entrega'). Cumprimento e papo = false.",
    "- 'produtos_novos' = pedido de CADASTRAR um produto de venda novo no cardápio ('cadastra o produto Coca 2L por 12 reais').",
    "  Isso NÃO é pergunta (pergunta=false). Preencha nome, preco_venda (null se não disse) e categoria se disse. Não confunda com",
    "  insumo/matéria-prima comprada, que vai em itens/nao_encontrados. 'quantidade_inicial' = quanto já tem em estoque do produto novo",
    "  ('cadastra X por 12, tenho 20, custo 5'); 'preco_custo' = quanto pagou por unidade.",
    "- 'estoque_minimo' = o mínimo que a pessoa disse ('mínimo 50', 'avisa quando tiver menos de 20'): vale pro item em itens,",
    "  nao_encontrados e produtos_novos. 'minimos' = pedido SÓ de definir/mudar o mínimo de item(ns) que já existem no catálogo,",
    "  sem compra ('pão brioche mínimo 50', 'mínimo de hambúrguer 30'): use o indice e itens/nao_encontrados vazios.",
    "- ENTRADA DE ESTOQUE tem prioridade sobre 'pergunta': qualquer pedido de criar/cadastrar matéria-prima ou insumo,",
    "  de lançar/dar entrada/adicionar/colocar quantidade no estoque ('crie matéria prima pães e lance 120 no estoque',",
    "  'coloca 50 hambúrguer no estoque', 'comecei com 30 kg de carne') é ENTRADA: devolva em itens/nao_encontrados,",
    "  mesmo sem preço (custo null), e pergunta=false. Quando o item não está no catálogo, vai em nao_encontrados",
    "  (será criado como insumo). Só use pergunta=true se o pedido NÃO envolver colocar quantidade no estoque.",
    "- TIPO de cada item em 'movimento': 'entrada' (padrão: comprei, chegou), 'saida' (tirou do estoque sem vender: perdeu, estragou,",
    "  quebrou, venceu, consumo da casa/funcionário, brinde/amostra/cortesia) ou 'ajuste' (CONTAGEM: a pessoa diz quanto TEM agora,",
    "  ex.: 'contei 12 pães', 'o pão está com 80'; em ajuste 'quantidade' = o que tem AGORA, não a diferença).",
    "  'motivo': entrada → compra | devolucao (cliente devolveu) | bonificacao (ganhou do fornecedor); saida → perda (estragou/quebrou/",
    "  caiu) | vencimento (venceu) | consumo | brinde; ajuste → ajuste_inventario. Sem dizer, é entrada/compra.",
    "  Saída e ajuste só valem pra item que JÁ está no catálogo (se não estiver, vai em nao_encontrados com o mesmo movimento).",
    "- Mensagem que só informa o PREÇO de item(ns) da lista ('pão brioche 1,30', 'falta o preço, 1.3 a unidade') preenche o",
    "  custo_unit desse item (se a lista tem um item só, vale pra ele) e mantém o resto igual. Preço dito sem 'cada'/'a unidade'",
    "  em mensagem de preço isolado é por unidade.",
    "- Cada item comprado: ache a linha do CATÁLOGO que corresponde (apelido e nome abreviado valem) e use o INDICE.",
    "  Nada razoável no catálogo → 'nao_encontrados', com o nome por extenso em minúsculo e a 'unidade'",
    "  (kg, g, L, ml ou un) — esse item vai ser CADASTRADO com esse nome.",
    "- 'quantidade' = quanto ENTROU (decimal com ponto: 6,5 kg → 6.5). 'meia dúzia'=6, 'dúzia'=12, 'cento'=100.",
    "  Se falou 'caixa/fardo/pacote com N', quantidade = total de unidades, a menos que o item do catálogo seja a própria caixa.",
    "- Preço: se disse o preço de CADA UNIDADE ('a 0,50 cada'), é custo_unit. Se disse o valor da compra daquele item",
    "  ('25 reais de pão'), é custo_total. Não souber, ambos null. Nunca invente preço.",
    "- Só inclua o que foi dito. Não invente item.",
    (pendentes.length || pendNovos.length)
      ? (jaLancado
        ? "- A LISTA ABAIXO JÁ FOI LANÇADA no estoque há pouco. Se a mensagem CORRIGE ou COMPLETA esses mesmos itens (ex.: 'faltou o preço', 'eram 40 e não 50', 'o pão custa 1,30'), corrige=true e devolva a lista COMPLETA já corrigida. Só é correção se mexer em quantidade, preço ou nome da MESMA compra. Saída (perda, vencimento, consumo, brinde), contagem, bonificação, devolução ou item/compra diferente NUNCA é correção: corrige=false e devolva SÓ o movimento novo. Papo sem relação: ignorar=true."
        : "- JÁ EXISTE UMA LISTA ESPERANDO CONFIRMAÇÃO (abaixo). A mensagem é uma CORREÇÃO ou ACRÉSCIMO a ela: devolva a lista COMPLETA e atualizada\n  (itens que ela já tinha + mudanças). Se a mensagem não tem nada a ver com a lista, ignorar=true.")
      : "",
    "",
    "CATÁLOGO (indice<TAB>[TIPO] nome):",
    catTxt || "(vazio)",
    (pendentes.length || pendNovos.length) ? "\nLISTA PENDENTE (indice, nome, qtd, custo unitário):\n" + pendTxt : "",
  ].filter(Boolean).join("\n")

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", max_tokens: 3000, system,
      messages: [{ role: "user", content: texto }],
    }),
  })
  if (!r.ok) { console.error("[estoque-wpp] claude:", (await r.text()).slice(0, 300)); return null }
  const d = await r.json()
  const custoUsd = usd({ entrada: Number(d?.usage?.input_tokens || 0), saida: Number(d?.usage?.output_tokens || 0) })
  const parsed = jsonDaResposta((d?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(""))
  if (!parsed) return null

  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  const unit = (x: any, q: number) => num(x?.custo_unit) ?? (num(x?.custo_total) ? Math.round((num(x.custo_total)! / q) * 10000) / 10000 : null)
  const itens: Item[] = []
  for (const x of parsed.itens ?? []) {
    const c = lista[Number(x?.indice)]
    const q = num(x?.quantidade)
    if (!c || !q) continue
    const mov: Mov = ["entrada", "saida", "ajuste"].includes(String(x?.movimento)) ? x.movimento : "entrada"
    const motivo = MOTIVOS[mov].includes(String(x?.motivo)) ? String(x.motivo) : MOTIVOS[mov][0]
    itens.push({
      tipo: c.tipo, id: c.id, nome: c.nome, quantidade: Math.round(q * 1000) / 1000,
      custo_unit: motivo === "bonificacao" ? 0 : unit(x, q),             // 0 = "sem preço" confirmado (é de graça)
      estoque_minimo: num(x?.estoque_minimo), mov, motivo,
    })
  }
  const naoAchados: NaoAchado[] = []
  for (const x of parsed.nao_encontrados ?? []) {
    const q = num(x?.quantidade) ?? 1
    const nome = String(x?.nome ?? "").trim().slice(0, 80)
    const un = ["kg", "g", "L", "ml", "un"].includes(String(x?.unidade)) ? String(x.unidade) : "un"
    const movN: Mov = ["entrada", "saida", "ajuste"].includes(String(x?.movimento)) ? x.movimento : "entrada"
    if (nome) naoAchados.push({ nome, quantidade: q, custo_unit: unit(x, q), unidade: un, estoque_minimo: num(x?.estoque_minimo), mov: movN })
  }
  return {
    itens, naoAchados, custoUsd,
    ignorar: parsed.ignorar === true && !itens.length && !naoAchados.length,
    pergunta: parsed.pergunta === true,
    corrige: parsed.corrige === true,
    produtosNovos: (Array.isArray(parsed.produtos_novos) ? parsed.produtos_novos : [])
      .map((x: any) => ({
        nome: String(x?.nome ?? "").trim().slice(0, 80),
        preco_venda: num(x?.preco_venda), preco_custo: num(x?.preco_custo),
        quantidade_inicial: num(x?.quantidade_inicial), estoque_minimo: num(x?.estoque_minimo),
        categoria: String(x?.categoria ?? "").trim().slice(0, 40),
      })).filter((x: any) => x.nome),
    minimos: (Array.isArray(parsed.minimos) ? parsed.minimos : []).flatMap((x: any) => {
      const c = lista[Number(x?.indice)]
      const m = Number(x?.estoque_minimo)
      return c && Number.isFinite(m) && m >= 0 ? [{ tipo: c.tipo, id: c.id, nome: c.nome, minimo: m }] : []
    }),
  }
}

// Foto / PDF da nota: reaproveita a função que a tela "Lançar nota IA" já usa.
async function lerNota(base64: string, mimetype: string, cat: Awaited<ReturnType<typeof carregarCatalogo>>) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/ler-nota-estoque`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
    body: JSON.stringify({
      imageBase64: base64, mimetype,
      produtos: cat.produtos, materias: cat.materias.map((m) => ({ id: m.id, nome: m.nome })),
    }),
  })
  const d = await r.json().catch(() => null)
  if (!d?.ok) return { erro: d?.error || "Não consegui ler a nota." as string }
  const itens: Item[] = (d.itens ?? []).map((i: any) => ({
    tipo: i.tipo, id: i.id, nome: i.nome, quantidade: Number(i.quantidade), custo_unit: i.custo_unit ?? null,
  }))
  const naoAchados: NaoAchado[] = (d.nao_encontrados ?? []).map((n: any) => ({
    nome: n.nome, quantidade: Number(n.quantidade) || 1, custo_unit: n.custo_unit ?? null, unidade: n.unidade || "un",
  }))
  return { itens, naoAchados, aviso: d.aviso as string | null, custoUsd: usd({ entrada: d.uso?.entrada ?? 0, saida: d.uso?.saida ?? 0 }) }
}

function resumo(itens: Item[], naoAchados: NaoAchado[], corrige = false, info: Map<string, { saldo: number; custo: number }> = new Map()): string {
  let total = 0, temPreco = false, prejuizo = 0
  const linhas = itens.map((i) => {
    const mov = i.mov ?? "entrada", motivo = i.motivo ?? "compra", inf = info.get(i.id)
    if (mov === "ajuste") {
      const delta = i.quantidade - (inf?.saldo ?? 0)
      return `• ${i.nome} — contagem: o sistema tem ${qtdTxt(inf?.saldo ?? 0)}, vai ficar ${qtdTxt(i.quantidade)} (${delta >= 0 ? "+" : ""}${qtdTxt(delta)})`
    }
    if (mov === "saida") {
      const v = (inf?.custo ?? 0) * i.quantidade
      const gera = GERA_PREJUIZO.has(motivo)
      if (gera) prejuizo += v
      return `• ${i.nome} × ${qtdTxt(i.quantidade)} — saída por *${ROTULO[motivo] ?? motivo}*${gera && v > 0 ? ` (≈ ${brl(v)} de prejuízo)` : ""}${inf && inf.saldo < i.quantidade ? ` ⚠️ só tem ${qtdTxt(inf.saldo)}` : ""}`
    }
    let s = `• ${i.nome} × ${qtdTxt(i.quantidade)}${motivo !== "compra" ? ` (${ROTULO[motivo] ?? motivo})` : ""}${i.estoque_minimo != null ? ` (mínimo ${qtdTxt(i.estoque_minimo)})` : ""}`
    if (i.custo_unit) { const v = i.custo_unit * i.quantidade; total += v; temPreco = true; s += ` — ${brl(i.custo_unit)} un (${brl(v)})` }
    return s
  })
  const so = (m: Mov) => itens.length > 0 && itens.every((i) => (i.mov ?? "entrada") === m)
  const titulo = so("saida") ? "Entendi esta saída de estoque:" : so("ajuste") ? "Entendi esta contagem:"
    : itens.some((i) => (i.mov ?? "entrada") !== "entrada") ? "Entendi este lançamento:"
    : itens.every((i) => (i.motivo ?? "compra") === "compra") ? "Entendi esta compra:" : "Entendi esta entrada:"
  const partes: string[] = []
  if (linhas.length) partes.push(`${corrige ? "Corrigindo o último lançamento — vai ficar assim:" : titulo}\n${linhas.join("\n")}`)
  if (prejuizo > 0) partes.push(`💸 Vai entrar no financeiro como prejuízo: ${brl(prejuizo)}.`)
  if (temPreco) partes.push(`Total: ${brl(total)}`)
  if (naoAchados.length) {
    partes.push(`🆕 Não existem no cadastro — vou CRIAR como insumo:\n${naoAchados.map((n) => `• ${n.nome} × ${qtdTxt(n.quantidade)} ${n.unidade ?? "un"}${n.estoque_minimo != null ? ` (mínimo ${qtdTxt(n.estoque_minimo)})` : ""}${n.custo_unit ? ` — ${brl(n.custo_unit)}` : ""}`).join("\n")}`)
  }
  const semPreco = [...itens, ...naoAchados].filter((x) => precisaPreco(x) && x.custo_unit == null).map((x) => x.nome)
  if (semPreco.length) {
    // Entrada sem preço deixa o custo e o lucro às cegas: só lança com o preço (ou com um "sem preço" explícito).
    partes.push(`❓ *Falta o preço (por unidade)* de: ${semPreco.join(", ")}.\nMe diga o valor, ex.: "${semPreco[0]} 1,30". Só lanço com o preço.\n(Se não souber, responda *SEM PREÇO*. Ou *NÃO* para cancelar.)`)
  } else {
    partes.push(`${corrige ? "Responda *SIM* para trocar o lançamento anterior por este" : "Responda *SIM* para lançar"}, *NÃO* para cancelar, ou escreva a correção (ex.: "o pão foram 40").`)
  }
  return partes.join("\n\n")
}

// Loja com o controle de estoque DESLIGADO: um gatilho do banco descarta os lançamentos de produto em silêncio.
// Sem este aviso o robô diria "lancei" sem ter lançado nada.
const ERRO_ESTOQUE_OFF = "estoque_desligado"
async function exigirEstoqueLigado(empresaId: string) {
  const { data } = await sb.from("empresas").select("estoque_ativo").eq("id", empresaId).maybeSingle()
  if (data?.estoque_ativo === false) throw new Error(ERRO_ESTOQUE_OFF)
}
const AVISO_ESTOQUE_OFF = "⚠️ O controle de estoque está *desligado* nesta loja, então não lancei nada de produto. Ligue no Portal (Estoque) e me mande de novo."

async function lancar(empresaId: string, pend: any): Promise<string> {
  if ((pend.itens ?? []).some((i: any) => i.tipo === "produto")) await exigirEstoqueLigado(empresaId)
  const itens: Item[] = [...(pend.itens ?? [])]
  // Item que não existe no cadastro é CRIADO como insumo (matéria-prima). Produto de venda
  // não é criado daqui: nasceria sem preço e apareceria zerado na loja online.
  const criados: string[] = []
  for (const n of (pend.nao_achados ?? []) as NaoAchado[]) {
    const { data: ja } = await sb.from("materias_primas").select("id, nome")
      .eq("empresa_id", empresaId).eq("ativo", true).ilike("nome", n.nome.replace(/[%_]/g, "")).limit(1).maybeSingle()
    let id = ja?.id as string | undefined
    if (!id) {
      const { data: nova, error } = await sb.from("materias_primas")
        .insert({ empresa_id: empresaId, nome: n.nome, unidade: n.unidade || "un", custo: n.custo_unit ?? 0, estoque_minimo: n.estoque_minimo ?? 0 })
        .select("id").single()
      if (error) throw error
      id = nova.id; criados.push(n.nome)
    }
    itens.push({ tipo: "materia", id: id!, nome: n.nome, quantidade: n.quantidade, custo_unit: n.custo_unit, estoque_minimo: n.estoque_minimo })
  }
  const movDe = (i: Item): Mov => i.mov ?? "entrada"
  const motivoDe = (i: Item) => i.motivo ?? MOTIVOS[movDe(i)][0]
  // Saída e contagem precisam do saldo atual e do custo cadastrado (pra valorizar a perda e calcular a diferença).
  const infoId = await infoDosItens(empresaId, itens.filter((i) => movDe(i) !== "entrada").map((i) => i.id))
  const ignorados: string[] = []
  type Lin = { i: Item; row: Record<string, unknown>; motivo: string; valor: number }
  const linP: Lin[] = [], linM: Lin[] = []
  for (const i of itens) {
    const mov = movDe(i), motivo = motivoDe(i), inf = infoId.get(i.id)
    let quantidade = i.quantidade, custo = i.custo_unit || null
    if (mov === "saida") custo = inf?.custo || null
    if (mov === "ajuste") {
      quantidade = Math.round((i.quantidade - (inf?.saldo ?? 0)) * 1000) / 1000
      if (quantidade === 0) { ignorados.push(i.nome); continue }       // contagem já bate
      custo = inf?.custo || null
    }
    const valor = custo ? Math.round(custo * Math.abs(quantidade) * 100) / 100 : 0
    const base = { tipo: mov, quantidade, custo_unit: custo, valor_total: custo ? valor : null }
    if (i.tipo === "produto") linP.push({ i, motivo, valor, row: { empresa_id: empresaId, produto_id: i.id, motivo, observacao: `${ROTULO[motivo] ?? motivo} pelo WhatsApp`, ...base } })
    else linM.push({ i, motivo, valor, row: { empresa_id: empresaId, materia_prima_id: i.id, observacao: `${ROTULO[motivo] ?? motivo} pelo WhatsApp`, ...base } })
  }
  let idsP: string[] = [], idsM: string[] = [], idsImp: string[] = []
  if (linP.length) {
    const { data, error } = await sb.from("estoque_movimentos").insert(linP.map((l) => l.row)).select("id")
    if (error) throw error
    idsP = (data ?? []).map((x: any) => x.id)
  }
  if (linM.length) {
    const { data, error } = await sb.from("materia_prima_movimentos").insert(linM.map((l) => l.row)).select("id")
    if (error) {
      if (idsP.length) await sb.from("estoque_movimentos").delete().in("id", idsP)   // não deixa lançar metade
      throw error
    }
    idsM = (data ?? []).map((x: any) => x.id)
  }
  // Perda e vencimento são prejuízo: entram em "imprevistos" do financeiro, como o "Produto perdido" do Portal.
  let prejuizo = 0
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
  const imps: Record<string, unknown>[] = []
  linP.forEach((l, k) => { if (GERA_PREJUIZO.has(l.motivo) && l.valor > 0) { prejuizo += l.valor; imps.push({ empresa_id: empresaId, data: hoje, descricao: `${ROTULO[l.motivo]} (WhatsApp): ${l.i.nome} × ${qtdTxt(l.i.quantidade)}`, valor: l.valor, produto_id: l.i.id, quantidade: l.i.quantidade, estoque_movimento_id: idsP[k], registrado_por_nome: "WhatsApp" }) } })
  linM.forEach((l, k) => { if (GERA_PREJUIZO.has(l.motivo) && l.valor > 0) { prejuizo += l.valor; imps.push({ empresa_id: empresaId, data: hoje, descricao: `${ROTULO[l.motivo]} (WhatsApp): ${l.i.nome} × ${qtdTxt(l.i.quantidade)}`, valor: l.valor, materia_prima_id: l.i.id, quantidade: l.i.quantidade, mp_movimento_id: idsM[k], registrado_por_nome: "WhatsApp" }) } })
  if (imps.length) {
    const { data, error } = await sb.from("custos_imprevistos").insert(imps).select("id")
    if (error) console.error("[estoque-wpp] imprevisto:", error.message)
    else idsImp = (data ?? []).map((x: any) => x.id)
  }
  // Igual à tela: quem acabou de pagar sabe o preço de hoje, então atualiza o custo do cadastro (só em COMPRA).
  for (const i of itens) {
    if (i.custo_unit && movDe(i) === "entrada" && motivoDe(i) === "compra") {
      if (i.tipo === "produto") await sb.from("produtos").update({ preco_custo: i.custo_unit }).eq("id", i.id)
      else await sb.from("materias_primas").update({ custo: i.custo_unit }).eq("id", i.id)
    }
    // Estoque mínimo dito na mesma mensagem ("mínimo 50") vale pro item.
    if (i.estoque_minimo != null) {
      await sb.from(i.tipo === "produto" ? "produtos" : "materias_primas").update({ estoque_minimo: i.estoque_minimo }).eq("id", i.id).eq("empresa_id", empresaId)
    }
  }
  await sb.from("estoque_whatsapp").update({
    status: "lancado", lancado_em: new Date().toISOString(), mov_produtos: idsP, mov_materias: idsM, imprevistos: idsImp,
  }).eq("id", pend.id)
  const feitos = linP.length + linM.length
  const novos = criados.length ? `\n🆕 Cadastrei como insumo: ${criados.join(", ")}.` : ""
  const prej = prejuizo > 0 ? `\n💸 Lançado como prejuízo no financeiro: ${brl(prejuizo)}.` : ""
  const ja = ignorados.length ? `\nℹ️ Já estava certo (sem ajuste): ${ignorados.join(", ")}.` : ""
  return `✅ Lancei ${feitos} ${feitos === 1 ? "movimento" : "movimentos"} no estoque.${novos}${prej}${ja}\nSe foi engano, responda *DESFAZER*.`
}

// Saldo atual e custo cadastrado dos itens (pra valorizar perda e calcular contagem).
async function infoDosItens(empresaId: string, ids: string[]): Promise<Map<string, { saldo: number; custo: number }>> {
  const out = new Map<string, { saldo: number; custo: number }>()
  if (!ids.length) return out
  const [saldos, prods, mats] = await Promise.all([
    sb.rpc("estoque_bot_saldos", { p_empresa_id: empresaId }),
    sb.from("produtos").select("id, preco_custo").in("id", ids),
    sb.from("materias_primas").select("id, custo").in("id", ids),
  ])
  const custos = new Map<string, number>()
  for (const p of prods.data ?? []) custos.set(p.id, Number(p.preco_custo || 0))
  for (const m of mats.data ?? []) custos.set(m.id, Number(m.custo || 0))
  for (const r of saldos.data ?? []) if (ids.includes(r.id)) out.set(r.id, { saldo: Number(r.saldo), custo: custos.get(r.id) ?? 0 })
  return out
}

// Aplica uma proposta do assistente (depois do SIM). Guarda em `antes` o que precisa pro DESFAZER.
async function executarAcao(empresaId: string, a: any): Promise<string> {
  const p = a.params ?? {}
  let antes: Record<string, unknown> = {}
  let ok_ = ""
  if (a.tipo === "cadastrar_produto") {
    if (Number(p.quantidade_inicial) > 0) await exigirEstoqueLigado(empresaId)
    const { data, error } = await sb.from("produtos").insert({
      empresa_id: empresaId, nome: p.nome, categoria: p.categoria || "outros",
      preco_venda: p.preco_venda, preco_custo: p.preco_custo ?? 0, estoque_minimo: p.estoque_minimo ?? 0,
    }).select("id").single()
    if (error) throw error
    antes = { produto_id: data.id }
    // Estoque inicial: entra como ENTRADA (a regra da loja é "entrada só soma", nunca ajuste que esconde furo).
    if (Number(p.quantidade_inicial) > 0) {
      const { data: mov, error: eMov } = await sb.from("estoque_movimentos").insert({
        empresa_id: empresaId, produto_id: data.id, tipo: "entrada", quantidade: p.quantidade_inicial, motivo: "compra",
        observacao: "Estoque inicial (cadastro pelo WhatsApp)", custo_unit: p.preco_custo || null,
        valor_total: p.preco_custo ? Math.round(p.preco_custo * p.quantidade_inicial * 100) / 100 : null,
      }).select("id").single()
      if (eMov) { await sb.from("produtos").delete().eq("id", data.id); throw eMov }
      antes = { produto_id: data.id, mov_id: mov.id }
    }
    ok_ = `✅ Produto *${p.nome}* cadastrado por ${brl(Number(p.preco_venda))}${Number(p.quantidade_inicial) > 0 ? `, com ${qtdTxt(Number(p.quantidade_inicial))} em estoque` : ""}${p.estoque_minimo ? ` e mínimo ${qtdTxt(Number(p.estoque_minimo))}` : ""}. Falta só a foto — coloque pelo Portal em Catálogo.`
  } else if (a.tipo === "definir_minimo") {
    const antesItens: any[] = []
    for (const it of (p.itens ?? [])) {
      const tab = it.tipo === "produto" ? "produtos" : "materias_primas"
      const { error } = await sb.from(tab).update({ estoque_minimo: it.para }).eq("id", it.id).eq("empresa_id", empresaId)
      if (error) throw error
      antesItens.push({ tab, id: it.id, de: it.de })
    }
    antes = { itens: antesItens }
    ok_ = `✅ Estoque mínimo definido: ${(p.itens ?? []).map((it: any) => `${it.nome} = ${qtdTxt(Number(it.para))}`).join(", ")}. Agora eu aviso quando chegar nesse número.`
  } else if (a.tipo === "mudar_preco") {
    const { error } = await sb.from("produtos").update({ preco_venda: p.para }).eq("id", p.produto_id).eq("empresa_id", empresaId)
    if (error) throw error
    antes = { produto_id: p.produto_id, preco_venda: p.de }
    ok_ = `✅ Preço de *${p.nome}* agora é ${brl(Number(p.para))}.`
  } else if (a.tipo === "taxa_entrega_fixa" || a.tipo === "pedido_minimo") {
    const campo = a.tipo === "taxa_entrega_fixa" ? "taxa_entrega" : "pedido_minimo"
    const { error } = await sb.from("empresas").update({ [campo]: p.para }).eq("id", empresaId)
    if (error) throw error
    antes = { campo, valor: p.de }
    ok_ = a.tipo === "taxa_entrega_fixa" ? `✅ Taxa de entrega fixa agora é ${brl(Number(p.para))}.` : `✅ Pedido mínimo agora é ${brl(Number(p.para))}.`
  } else if (a.tipo === "ajustar_tabela_km") {
    const { data: e } = await sb.from("empresas").select("taxas_entrega_km").eq("id", empresaId).maybeSingle()
    const tab: any[] = Array.isArray(e?.taxas_entrega_km) ? e!.taxas_entrega_km : []
    const nova = tab.map((f) => Number(f.taxa) > 0 ? { ...f, taxa: Math.max(0, Math.round((Number(f.taxa) + Number(p.delta)) * 100) / 100) } : f)
    const { error } = await sb.from("empresas").update({ taxas_entrega_km: nova }).eq("id", empresaId)
    if (error) throw error
    antes = { tabela: tab }
    ok_ = `✅ Tabela de entrega por km ajustada em ${brl(Number(p.delta))} (${tab.length} faixas).`
  } else {
    throw new Error("tipo desconhecido")
  }
  await sb.from("assistente_acoes").update({ status: "executada", antes, executada_em: new Date().toISOString() }).eq("id", a.id)
  return `${ok_}
Se foi engano, responda *DESFAZER*.`
}

async function desfazerAcao(empresaId: string, a: any): Promise<string> {
  const x = a.antes ?? {}
  if (a.tipo === "definir_minimo") {
    for (const it of (x.itens ?? [])) await sb.from(it.tab).update({ estoque_minimo: it.de }).eq("id", it.id).eq("empresa_id", empresaId)
  } else if (a.tipo === "cadastrar_produto") {
    if (x.mov_id) await sb.from("estoque_movimentos").delete().eq("id", x.mov_id)
    const { error } = await sb.from("produtos").delete().eq("id", x.produto_id).eq("empresa_id", empresaId)
    if (error) await sb.from("produtos").update({ ativo: false, arquivado_em: new Date().toISOString() }).eq("id", x.produto_id)
  } else if (a.tipo === "mudar_preco") {
    await sb.from("produtos").update({ preco_venda: x.preco_venda }).eq("id", x.produto_id).eq("empresa_id", empresaId)
  } else if (a.tipo === "taxa_entrega_fixa" || a.tipo === "pedido_minimo") {
    await sb.from("empresas").update({ [x.campo]: x.valor }).eq("id", empresaId)
  } else if (a.tipo === "ajustar_tabela_km") {
    await sb.from("empresas").update({ taxas_entrega_km: x.tabela }).eq("id", empresaId)
  }
  await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("id", a.id)
  return `↩️ Desfeito: ${a.resumo}`
}

// Últimas trocas do assistente no zap (30 min), pra a pergunta seguinte ter contexto ("e ontem?").
async function ultimasConversas(empresaId: string) {
  const desde = new Date(Date.now() - 30 * 60000).toISOString()
  const { data } = await sb.from("assistente_conversas").select("pergunta, resposta")
    .eq("empresa_id", empresaId).eq("canal", "whatsapp_pergunta").neq("resposta", "(transcrição)").gte("created_at", desde)
    .order("created_at", { ascending: false }).limit(3)
  return (data ?? []).reverse().flatMap((r: any) => [
    { role: "user", content: r.pergunta }, { role: "assistant", content: r.resposta },
  ])
}

// ── Comandos de estoque SEM IA (custo zero) ────────────────────────────────
// "o que está acabando?", "lista o estoque", "estoque de bebidas", "tem pão?" são consultas fixas:
// o robô responde direto do banco. Chamar a IA pra isso custava ~R$ 0,3 por pergunta e dava o mesmo resultado.
type Saldo = { tipo: "produto" | "insumo"; id: string; nome: string; categoria: string; unidade: string; saldo: number; minimo: number; controla: boolean }

function paginar(linhas: string[], cabecalho: string, limite = 3200): string[] {
  const out: string[] = []
  let atual = cabecalho
  for (const l of linhas) {
    if (atual.length + l.length + 1 > limite) { out.push(atual); atual = "(continua)" }
    atual += "\n" + l
  }
  out.push(atual)
  return out
}
const linhaSaldo = (s: Saldo) => {
  const baixo = s.minimo > 0 && s.saldo <= s.minimo
  return `• ${s.nome} — ${qtdTxt(s.saldo)} ${s.unidade}${s.minimo > 0 ? ` (mín ${qtdTxt(s.minimo)})` : ""}${baixo ? " ⚠️" : ""}`
}

async function comandoEstoque(t: string, empresaId: string): Promise<string[] | null> {
  if (t.length > 90 || /\d/.test(t)) return null                       // com número é compra/lançamento, não consulta
  const baixo = /(estoque baixo|baixo estoque|acabando|em falta|faltando|abaixo do minimo|precisa(m)? repor|o que repor|repor)/.test(t)
  const lista = t.match(/^(lista|listar|liste|mostra|mostrar|manda|mandar|ver|me (da|passa|manda|mostra)|quero ver|como (esta|ta)|qual (e )?o)\s+(o\s+|todo\s+o\s+|todos\s+os\s+|meu\s+|meus\s+)?(estoque|produtos|insumos|materias? primas?)(\s+(de|da|do|dos|das)\s+(.+?))?\s*\??$/)
  const estoqueDe = t.match(/^estoque(\s+(de|da|do|dos|das))?\s+(.+?)\s*\??$/)
  const tem = t.match(/^(ainda\s+)?(tem|temos|quanto\s+(tenho|tem|temos)\s+(de|do|da)|saldo\s+(de|do|da))\s+(.+?)(\s+(no|em)\s+estoque)?\s*\??$/)
  if (!baixo && !lista && !estoqueDe && !tem) return null

  const { data, error } = await sb.rpc("estoque_bot_saldos", { p_empresa_id: empresaId })
  if (error) { console.error("[estoque-wpp] saldos:", error.message); return ["Não consegui consultar o estoque agora. Tenta de novo em instantes."] }
  const todos: Saldo[] = (data ?? []).map((r: any) => ({
    tipo: r.tipo, id: r.id, nome: r.nome, categoria: r.categoria || "Sem categoria", unidade: r.unidade,
    saldo: Number(r.saldo), minimo: Number(r.minimo || 0), controla: r.controla !== false,
  }))
  const controlados = todos.filter((s) => s.controla)

  if (baixo && !lista && !estoqueDe && !tem) {
    const abaixo = controlados.filter((s) => s.minimo > 0 && s.saldo <= s.minimo)
    const zerados = controlados.filter((s) => s.minimo <= 0 && s.saldo <= 0)
    const semMinimo = controlados.filter((s) => s.minimo <= 0).length
    const msgs: string[] = []
    if (abaixo.length) msgs.push(...paginar(abaixo.sort((a, b) => a.nome.localeCompare(b.nome)).map(linhaSaldo), `⚠️ *Abaixo do mínimo* (${abaixo.length}):`))
    else msgs.push(`✅ Nada abaixo do mínimo.`)
    if (zerados.length) msgs.push(`📉 *Zerados ou negativos, sem mínimo definido* (${zerados.length}):\n${zerados.slice(0, 25).map((s) => `• ${s.nome}`).join("\n")}${zerados.length > 25 ? `\n… e mais ${zerados.length - 25}` : ""}`)
    if (semMinimo) msgs.push(`💡 ${semMinimo} ${semMinimo === 1 ? "item não tem" : "itens não têm"} estoque mínimo e por isso não entram no alerta. Defina com: "pão brioche mínimo 50".`)
    return msgs
  }

  // Termo pedido (categoria, "insumos" ou nome de item).
  let termo = norm((lista?.[9] ?? estoqueDe?.[3] ?? tem?.[6] ?? "").replace(/\?/g, ""))
  const geral = lista && !termo && /estoque|produtos/.test(lista[6] ?? "")
  const soInsumos = /insumo|materia/.test(lista?.[6] ?? "") || /^(insumos?|materias? primas?)$/.test(termo)
  if (/^(estoque|todo estoque|tudo)$/.test(termo)) termo = ""

  if (geral || (!termo && !soInsumos && !tem)) {
    const cats = new Map<string, number>()
    for (const s of controlados) cats.set(s.categoria, (cats.get(s.categoria) ?? 0) + 1)
    if (controlados.length <= 40) return paginar(controlados.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.nome.localeCompare(b.nome)).map(linhaSaldo), `📦 *Estoque* (${controlados.length} itens):`)
    return [`📦 *Estoque*: ${controlados.filter((s) => s.tipo === "produto").length} produtos e ${controlados.filter((s) => s.tipo === "insumo").length} insumos.\n\nCategorias:\n${[...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `• ${c} (${n})`).join("\n")}\n\nPeça uma: *estoque de ${[...cats.keys()][0].toLowerCase()}* ou *estoque de insumos*. Pra ver o que está acabando: *o que está acabando?*`]
  }
  if (soInsumos) {
    const ins = controlados.filter((s) => s.tipo === "insumo").sort((a, b) => a.nome.localeCompare(b.nome))
    return ins.length ? paginar(ins.map(linhaSaldo), `🥩 *Insumos* (${ins.length}):`) : ["Nenhum insumo cadastrado ainda."]
  }
  const cat = controlados.filter((s) => norm(s.categoria) === termo || norm(s.categoria).startsWith(termo))
  if (cat.length && !tem) return paginar(cat.sort((a, b) => a.nome.localeCompare(b.nome)).map(linhaSaldo), `📦 *${cat[0].categoria}* (${cat.length}):`)
  const achados = todos.filter((s) => norm(s.nome).includes(termo))
  if (!achados.length && tem && !lista && !estoqueDe) return null     // "tem algum problema…?" não é consulta de estoque
  if (!achados.length) return [`Não achei "${termo}" no estoque (nem produto nem insumo). Pra cadastrar: mande o que comprou, ex.: "comprei 20 ${termo} a 5 reais".`]
  return paginar(achados.slice(0, 40).map((s) => linhaSaldo(s) + (s.controla ? "" : " (não controla estoque)")), `🔎 *${termo}* (${achados.length}):`)
}

// ── Ajuda e comandos fixos do Analista (SEM IA, custo zero) ─────────────────
const AJUDA_ASSISTENTE = `🤖 *Assistente — o que eu faço aqui*

📥 *Entrada*: "comprei 20 kg de queijo a 30" · "bonificação 5 queijo" · "devolução 2 coca" · ou mande a foto/PDF da nota, ou fale em áudio
📤 *Saída*: "perda 3 queijo" · "venceu 2 pão" · "consumo 1 hambúrguer" · "brinde 1 coca"
🔢 *Contagem*: "contei 18 queijo" (eu ajusto a diferença)
🆕 *Cadastro*: "cadastra Coca 2L por 12, tenho 20, custo 5, mínimo 6"
⚠️ *Mínimo*: "pão mínimo 50"

🔎 *Consultas (grátis)*: "o que está acabando?" · "lista o estoque" · "estoque de bebidas" · "estoque de insumos" · "tem pão?"

Antes de lançar eu mostro e espero *SIM*. *DESFAZER* tira o último lançamento (até 3 h).
💳 Cada mensagem gasta 1 crédito (nota/foto = 3). Consultas e ajuda são grátis.`

const AJUDA_ANALISTA = `📊 *Analista — o que eu faço aqui*

*Comandos grátis* (resposta na hora):
• "vendas hoje" · "vendas ontem" · "vendas semana" · "vendas mês" · "vendas mês passado" · "vendas 15/10" · "vendas 01/10 a 15/10"
• "lucro mês" · "mais vendidos mês" · "melhores clientes" · "situação" · "fiado" · "entrega"
• "o que está acabando?" · "lista o estoque" · "tem pão?"

*Pergunta livre ou diagnóstico*: escreva normal ("faz um diagnóstico", "analisa meu cardápio", "meu faturamento caiu?"). Gasta saldo da IA (cerca de R$ 0,30 a 0,50).

*Mudanças (eu mostro e espero SIM)*: "muda o preço da pizza pra 55" · "taxa de entrega 6 reais" · "pedido mínimo 20"

Dica: use os comandos grátis sempre que der. A IA fica pro que precisa de raciocínio.`

const hojeBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const somaDiasBRT = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`
const valor = (v: unknown) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? brl(Number(v)) : String(v ?? "—"))
const FILLER = new Set(["de", "do", "da", "dos", "das", "no", "na", "em", "o", "a", "os", "as", "e", "pra", "para", "ate", "ao", "meu", "minha", "meus", "minhas", "dia", "loja",
  "total", "geral", "quanto", "qual", "foi", "fui", "ultimos", "ultimas", "dias", "esta", "essa", "este", "esse", "passado", "anterior", "mes", "semana", "hoje", "ontem", "anteontem",
  "mais", "vendidos", "vendido", "produtos", "produto", "clientes", "cliente", "melhores", "top", "vendi", "vendas", "venda", "lucro", "lucrei", "faturamento", "faturei", "fiz", "ate"])

// Lê o período dito ("hoje", "ontem", "semana", "mês passado", "15/10", "01/10 a 15/10"). null = tem palavra que eu não entendo → IA.
function lerPeriodo(rest: string): { ini: string; fim: string; rotulo: string } | null {
  const hoje = hojeBRT()
  const ano = Number(hoje.slice(0, 4))
  const data = (d: string, m: string, a?: string) => `${a ? (a.length === 2 ? "20" + a : a) : ano}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
  let ini = hoje, fim = hoje, rotulo = `hoje (${ddmm(hoje)})`
  let resto = rest
  const rg = rest.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:a|ate|ao|-)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/)
  const un = rest.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/)
  if (rg) { ini = data(rg[1], rg[2], rg[3]); fim = data(rg[4], rg[5], rg[6]); rotulo = `${ddmm(ini)} a ${ddmm(fim)}`; resto = resto.replace(rg[0], " ") }
  else if (un) { ini = fim = data(un[1], un[2], un[3]); rotulo = ddmm(ini); resto = resto.replace(un[0], " ") }
  else if (/\bmes (passado|anterior)\b/.test(rest)) {
    const p = somaDiasBRT(hoje.slice(0, 8) + "01", -1)
    ini = p.slice(0, 8) + "01"; fim = p; rotulo = "mês passado"; resto = resto.replace(/\bmes (passado|anterior)\b/, " ")
  }
  else if (/\bmes\b/.test(rest)) { ini = hoje.slice(0, 8) + "01"; fim = hoje; rotulo = `mês (${ddmm(ini)} a ${ddmm(fim)})`; resto = resto.replace(/\b(este |esse |no |do )?mes\b/, " ") }
  else if (/\bsemana\b/.test(rest)) { ini = somaDiasBRT(hoje, -6); fim = hoje; rotulo = `últimos 7 dias (${ddmm(ini)} a ${ddmm(fim)})`; resto = resto.replace(/\bsemana\b/, " ") }
  else if (/\banteontem\b/.test(rest)) { ini = fim = somaDiasBRT(hoje, -2); rotulo = `anteontem (${ddmm(ini)})`; resto = resto.replace(/\banteontem\b/, " ") }
  else if (/\bontem\b/.test(rest)) { ini = fim = somaDiasBRT(hoje, -1); rotulo = `ontem (${ddmm(ini)})`; resto = resto.replace(/\bontem\b/, " ") }
  else resto = resto.replace(/\bhoje\b/, " ")
  if (fim < ini) return null
  // Sobrou palavra que não é de período ("ifood", "comparado", "por que"…)? Então não é comando: vai pra IA.
  const sobras = resto.split(/[^a-z0-9]+/).filter((w) => w && !/^\d+$/.test(w) && !FILLER.has(w))
  return sobras.length ? null : { ini, fim, rotulo }
}

async function chamarComando(empresaId: string, tool: string, args: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/assistente-loja`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
    body: JSON.stringify({ empresa_id: empresaId, comando: { tool, args } }),
  })
  const d = await r.json().catch(() => null)
  return d?.dados ?? null
}

async function comandoAnalista(t: string, empresaId: string): Promise<string[] | null> {
  const limpo = t.replace(/[?!.,]+$/g, "").trim()
  if (limpo.length > 70) return null
  const erro = ["Não consegui consultar isso agora. Tenta de novo em instantes."]
  let m: RegExpMatchArray | null

  if ((m = limpo.match(/^(quanto\s+)?(vendas?|vendi|faturamento|faturei|fiz de venda)\b(.*)$/))) {
    const per = lerPeriodo(m[3]); if (!per) return null
    const d = await chamarComando(empresaId, "consultar_vendas", { data_inicio: per.ini, data_fim: per.fim })
    if (!d) return erro
    const lista = (l: any[]) => (l ?? []).map((x: any) => `• ${x.nome}: ${valor(x.valor)}`).join("\n")
    const partes = [`💰 *Vendas — ${per.rotulo}*\nFaturamento: *${valor(d.faturamento)}* · Pedidos: ${d.pedidos} · Ticket médio: ${valor(d.ticket_medio)}`]
    if (d.por_canal?.length) partes.push(`*Por canal*\n${lista(d.por_canal)}`)
    if (d.por_forma_pagamento?.length) partes.push(`*Por forma de pagamento*\n${lista(d.por_forma_pagamento)}`)
    if (d.recebido_de_fiado?.length) partes.push(`*Recebido de fiado antigo* (não é venda do período)\n${lista(d.recebido_de_fiado)}`)
    if (Array.isArray(d.por_dia) && d.por_dia.length > 1 && d.por_dia.length <= 15)
      partes.push(`*Dia a dia*\n${d.por_dia.map((x: any) => `• ${ddmm(x.dia)}: ${valor(x.total)} (${x.pedidos})`).join("\n")}`)
    return [partes.join("\n\n")]
  }
  if ((m = limpo.match(/^(quanto\s+)?(lucro|lucrei)\b(.*)$/))) {
    const per = lerPeriodo(m[3]); if (!per) return null
    const d = await chamarComando(empresaId, "consultar_lucro", { data_inicio: per.ini, data_fim: per.fim })
    if (!d) return erro
    const tot = d.totais_dos_dias_fechados ?? {}
    const naoFech = (d.dias_nao_fechados ?? []).length
    let txt = `📈 *Lucro — ${per.rotulo}*\n`
    txt += (d.dias_fechados ?? []).length
      ? `Dias fechados: ${(d.dias_fechados ?? []).length}\nReceita: ${valor(tot.receita)} · Custos: ${valor(tot.custos)}\n*Lucro: ${valor(tot.lucro)}*`
      : "Nenhum dia fechado nesse período, então não há lucro calculado."
    if (naoFech) txt += `\n\n⚠️ ${naoFech} ${naoFech === 1 ? "dia ainda não foi fechado" : "dias ainda não foram fechados"} (faturamento deles: ${valor(d.faturamento_dos_dias_nao_fechados)}). Feche em Financeiro > Despesas & Lucro pra o lucro aparecer.`
    return [txt]
  }
  if ((m = limpo.match(/^(mais vendidos?|produtos? mais vendidos?|top produtos|campeoes|carro chefe)\b(.*)$/))) {
    const per = lerPeriodo(m[2]); if (!per) return null
    const d = await chamarComando(empresaId, "top_produtos", { data_inicio: per.ini, data_fim: per.fim, limite: 10 })
    if (!d) return erro
    const l = d.produtos ?? []
    return [l.length ? `🏆 *Mais vendidos — ${per.rotulo}*\n${l.map((x: any, i: number) => `${i + 1}. ${x.produto} — ${valor(x.valor_vendido)} (${x.quantidade} un)`).join("\n")}` : `Nenhuma venda em ${per.rotulo}.`]
  }
  if ((m = limpo.match(/^(melhores clientes|top clientes|quem mais compra|clientes que mais compram)\b(.*)$/))) {
    const per = lerPeriodo(m[2]); if (!per) return null
    const d = await chamarComando(empresaId, "top_clientes", { data_inicio: per.ini, data_fim: per.fim, limite: 10 })
    if (!d) return erro
    const l = d.clientes ?? []
    return [l.length ? `⭐ *Melhores clientes — ${per.rotulo}*\n${l.map((x: any, i: number) => `${i + 1}. ${x.cliente} — ${valor(x.gastou)} (${x.pedidos} pedidos)`).join("\n")}` : `Nenhum cliente identificado em ${per.rotulo}.`]
  }
  if (/^(situacao|como esta a loja|como ta a loja|como estamos|resumo|painel|fiado|quanto tenho de fiado|quem deve)$/.test(limpo)) {
    const d = await chamarComando(empresaId, "situacao_agora", {})
    if (!d) return erro
    const st = Object.entries(d.pedidos_de_hoje?.por_status ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ")
    const baixos = (d.estoque_baixo?.itens ?? []).map((i: any) => `• ${i.produto} — ${qtdTxt(i.tem)} (mín ${qtdTxt(i.minimo)})`).join("\n")
    if (/fiado|deve/.test(limpo)) return [`🧾 *Fiado*\nEm aberto: *${valor(d.fiado?.total_em_aberto)}* · ${d.fiado?.clientes_devendo ?? 0} clientes devendo`]
    return [[
      `🏪 *Situação agora (${d.hoje ? ddmm(d.hoje) : ""})*`,
      `Pedidos de hoje: ${d.pedidos_de_hoje?.total ?? 0}${st ? ` (${st})` : ""}`,
      `Faturamento do mês: *${valor(d.faturamento_do_mes)}* · Meta: ${valor(d.meta_do_mes)}${d.falta_para_a_meta != null ? ` (faltam ${valor(d.falta_para_a_meta)})` : ""}`,
      `Fiado em aberto: ${valor(d.fiado?.total_em_aberto)} (${d.fiado?.clientes_devendo ?? 0} clientes)`,
      d.estoque_baixo?.quantidade ? `⚠️ Estoque baixo (${d.estoque_baixo.quantidade}):\n${baixos}` : "✅ Nada abaixo do estoque mínimo.",
    ].join("\n")]
  }
  if (/^(entrega|entregas|taxa de entrega|minha taxa de entrega|como esta minha entrega)$/.test(limpo)) {
    const d = await chamarComando(empresaId, "ver_entrega", {})
    if (!d) return erro
    const c = d.configuracao ?? {}, u = d.ultimos_30_dias ?? {}
    const bairros = (u.bairros_que_mais_pedem ?? []).slice(0, 5).map((b: any) => `• ${b.bairro}: ${b.entregas} entregas, taxa média ${valor(b.taxa_media)}, entregador ${valor(b.entregador_medio)}`).join("\n")
    return [[
      `🛵 *Entrega*`,
      `Taxa fixa: ${valor(c.taxa_fixa)} · Pedido mínimo: ${valor(c.pedido_minimo)} · Raio: ${c.raio_km ?? "—"} km · Tempo: ${c.tempo_min ?? "—"}`,
      `*Últimos 30 dias*: ${u.pedidos ?? 0} pedidos, ${u.entregas_com_taxa_ou_entregador ?? 0} com entrega`,
      `Cobrado dos clientes: ${valor(u.taxa_cobrada_dos_clientes)} · Pago aos entregadores: ${valor(u.pago_aos_entregadores)}`,
      `*Saldo da entrega: ${valor(u.saldo_da_entrega)}*`,
      bairros ? `\nBairros que mais pedem:\n${bairros}` : "",
    ].filter(Boolean).join("\n")]
  }
  return null
}

function textoDaMensagem(m: any): string {
  const x = m?.message ?? {}
  return String(
    x.conversation ?? x.extendedTextMessage?.text ?? x.imageMessage?.caption ?? x.documentMessage?.caption
      ?? x.documentWithCaptionMessage?.message?.documentMessage?.caption ?? "",
  ).trim()
}

async function tratar(req: Request): Promise<Response> {
  try {
    const payload = await req.json()
    if (payload.event !== "messages.upsert") return ok()
    const msg = payload.data
    const instance: string = payload.instance ?? ""
    const jid: string = msg?.key?.remoteJid ?? ""
    if (!msg || !instance || !jid.endsWith("@g.us")) return ok()

    // Mensagem velha (Evolution reenvia histórico depois de reiniciar) não se lança.
    {
      const ts = msg.messageTimestamp
      let seg = Number(typeof ts === "object" && ts !== null ? (ts.low ?? 0) : (ts ?? 0))
      if (seg > 1e12) seg /= 1000
      if (seg > 0 && Date.now() / 1000 - seg > 600) return ok()
    }

    const texto = textoDaMensagem(msg)
    if (texto.startsWith(MARCA)) return ok()      // eco do próprio robô

    const { data: cfg } = await sb.from("whatsapp_config")
      .select("empresa_id, estoque_grupo_jid, analista_grupo_jid").eq("instance_name", instance).eq("ativo", true).maybeSingle()
    if (!cfg?.empresa_id) return ok()
    const empresaId: string = cfg.empresa_id
    const t = norm(texto)

    // ── Ligar / desligar. Quem ativa passa a consultar o financeiro da loja pelo grupo, então só ──
    // o número da loja (fromMe) ou um telefone DA loja (admin, contato, super admin) pode.
    const autorizado = async (): Promise<boolean> => {
      if (msg.key?.fromMe) return true
      const fim8 = (v: unknown) => String(v ?? "").split("@")[0].replace(/\D/g, "").slice(-8)
      const quem = [msg.key?.participant, msg.key?.participantAlt, msg.participant].map(fim8).filter((x) => x.length === 8)
      if (!quem.length) return false
      const [c, e, p, g] = await Promise.all([
        sb.from("whatsapp_config").select("admin_phone, connected_phone").eq("empresa_id", empresaId).eq("instance_name", instance).maybeSingle(),
        sb.from("empresas").select("telefone_contato").eq("id", empresaId).maybeSingle(),
        sb.from("profiles").select("telefone").eq("empresa_id", empresaId).in("perfil", ["admin", "super_admin"]),
        sb.from("config_global").select("valor").eq("chave", "super_admin_phone").maybeSingle(),
      ])
      const lojistas = new Set([c.data?.admin_phone, c.data?.connected_phone, e.data?.telefone_contato, g.data?.valor,
        ...(p.data ?? []).map((x: any) => x.telefone)].map(fim8).filter((x) => x.length === 8))
      return quem.some((q) => lojistas.has(q))
    }
    // Dois robôs, um grupo pra cada: "ativar assistente" (estoque e cadastros, gasta créditos) e
    // "ativar analista" (perguntas e decisões do dono, gasta o saldo da IA). "estoque" segue valendo.
    const reAssist = "(assistente|estoque|entrada)"
    const alvo = (verbo: string): "assistente" | "analista" | null =>
      new RegExp(`^(#|\\/)?\\s*${verbo}\\s+(o\\s+)?${reAssist}`).test(t) ? "assistente"
        : new RegExp(`^(#|\\/)?\\s*${verbo}\\s+(o\\s+)?analista`).test(t) ? "analista" : null
    const ligar = alvo("(ativar|ligar)")
    if (ligar) {
      if (!(await autorizado())) {
        console.log("[estoque-wpp] ativar negado: numero nao autorizado", msg.key?.participant, msg.key?.participantAlt)
        return ok()
      }
      // Um grupo é de UM robô só: ligar um desliga o outro neste mesmo grupo.
      const upd: Record<string, string | null> = ligar === "assistente"
        ? { estoque_grupo_jid: jid, ...(cfg.analista_grupo_jid === jid ? { analista_grupo_jid: null } : {}) }
        : { analista_grupo_jid: jid, ...(cfg.estoque_grupo_jid === jid ? { estoque_grupo_jid: null } : {}) }
      await sb.from("whatsapp_config").update(upd).eq("empresa_id", empresaId).eq("instance_name", instance)
      await enviar(instance, jid, ligar === "assistente"
        ? "Pronto, este grupo agora é o *Assistente*: eu lanço *entrada de estoque* e cadastro produto.\n\nEscreva ou fale o que comprou (ex.: \"comprei 50 pães a 1,30\") ou mande a foto/PDF da nota. Eu mostro a lista e você responde *SIM* pra lançar.\n\nPra desligar: \"desativar assistente\"."
        : "Pronto, este grupo agora é o *Analista*: pergunte sobre vendas, lucro, cardápio, entrega, peça um diagnóstico ou mude preço e taxa (com *SIM* antes).\n\nExemplos: \"quanto vendi hoje?\", \"faz um diagnóstico da loja\", \"muda o preço da pizza pra 55\".\n\nPra desligar: \"desativar analista\".")
      return ok()
    }
    const modo: "assistente" | "analista" | null =
      jid === cfg.estoque_grupo_jid ? "assistente" : jid === cfg.analista_grupo_jid ? "analista" : null
    if (!modo) return ok()                                  // outro grupo: nem responde

    const desligar = alvo("(desativar|desligar)")
    if (desligar) {
      if (!(await autorizado())) return ok()
      await sb.from("whatsapp_config").update(desligar === "assistente" ? { estoque_grupo_jid: null } : { analista_grupo_jid: null })
        .eq("empresa_id", empresaId).eq("instance_name", instance)
      await enviar(instance, jid, `Desligado. Este grupo não é mais o ${desligar === "assistente" ? "Assistente" : "Analista"}.`)
      return ok()
    }

    // "ajuda": mostra as frases certas de cada robô (grátis). A loja falando "certinho" é o que mantém o custo em zero.
    if (/^(ajuda|comandos|menu|help|\?|o que voce faz|como uso)\W*$/.test(t)) {
      await enviar(instance, jid, modo === "analista" ? AJUDA_ANALISTA : AJUDA_ASSISTENTE)
      return ok()
    }
    // Consultas de estoque ("o que está acabando?", "lista o estoque", "tem pão?"): direto do banco, sem IA e sem cobrar.
    const respEstoque = await comandoEstoque(t, empresaId)
    if (respEstoque) {
      for (const m of respEstoque) await enviar(instance, jid, m)
      return ok()
    }
    // Relatórios fixos do Analista ("vendas ontem", "lucro mês", "mais vendidos"…): números prontos, sem IA e sem cobrar.
    if (modo === "analista") {
      const respAnalista = await comandoAnalista(t, empresaId)
      if (respAnalista) {
        for (const m of respAnalista) await enviar(instance, jid, m)
        return ok()
      }
    }

    // ── Pendente / último lançamento ────────────────────────────────────────
    const desde =new Date(Date.now() - VALIDADE_PENDENTE_MIN * 60000).toISOString()
    const { data: pend } = await sb.from("estoque_whatsapp").select("*")
      .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente").gte("created_at", desde)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()

    const { data: pendAcao } = await sb.from("assistente_acoes").select("*")
      .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente").gte("created_at", desde)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    // O que o dono confirma é sempre a coisa mais RECENTE que o robô mostrou.
    const acaoMaisNova = !!pendAcao && (!pend || pendAcao.created_at > pend.created_at)

    // ═══ ROBÔ ANALISTA ═══ perguntas, diagnóstico e decisões do dono. Gasta o SALDO DA IA (em reais).
    if (modo === "analista") {
      const lim = new Date(Date.now() - VALIDADE_DESFAZER_MIN * 60000).toISOString()
      if (/^(sim|s|ok|pode|pode fazer|faz|aplicar|aplica|confirmo|confirmar|isso|certo)\W*$/.test(t)) {
        if (!acaoMaisNova) return ok()
        try { await enviar(instance, jid, await executarAcao(empresaId, pendAcao)) }
        catch (e: any) {
          console.error("[estoque-wpp] acao:", e)
          await enviar(instance, jid, e?.message === ERRO_ESTOQUE_OFF ? AVISO_ESTOQUE_OFF : "❌ Não consegui aplicar agora (erro no sistema). Nada foi alterado — tente de novo em instantes.")
        }
        return ok()
      }
      if (/^(nao|n|cancela|cancelar|deixa|esquece)\W*$/.test(t)) {
        if (!acaoMaisNova) return ok()
        await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("id", pendAcao.id)
        await enviar(instance, jid, "Cancelado. Nada foi alterado.")
        return ok()
      }
      if (/^desfaz(er)?\W*$/.test(t)) {
        const { data: ultAcao } = await sb.from("assistente_acoes").select("*")
          .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "executada").gte("executada_em", lim)
          .order("executada_em", { ascending: false }).limit(1).maybeSingle()
        await enviar(instance, jid, ultAcao ? await desfazerAcao(empresaId, ultAcao) : "Não achei nada recente pra desfazer (só dá até 3 horas depois).")
        return ok()
      }

      const tipoMsgA: string = msg.messageType ?? ""
      if (tipoMsgA === "imageMessage" || tipoMsgA === "documentMessage" || tipoMsgA === "documentWithCaptionMessage") {
        await enviar(instance, jid, "Nota e foto de compra são no grupo do *Assistente* (lá eu lanço no estoque). Aqui eu respondo perguntas e análises.")
        return ok()
      }
      let pergunta = texto
      let whisperUsd = 0
      if (tipoMsgA === "audioMessage") {
        const midia = await baixarMidia(instance, msg)
        const falado = midia ? await transcrever(midia.base64, midia.mimetype) : null
        if (!falado) { await enviar(instance, jid, "Não consegui ouvir o áudio. Escreve ou manda de novo?"); return ok() }
        pergunta = falado
        whisperUsd = ((msg.message?.audioMessage?.seconds ?? 30) / 60) * PRECO_WHISPER_MIN
      }
      // Papo solto ("valeu", "bom dia") não vale uma chamada cara à IA.
      const tp = norm(pergunta)
      if (tp.length < 5 || /^(oi+|ola|bom dia|boa tarde|boa noite|valeu|obrigad[oa]|blz|beleza|tmj|show|top|ok|kk+|rs+)\W*$/.test(tp)) return ok()

      const carteira = await verCarteira(sb, empresaId)
      if (carteira.disponivel <= 0) {
        await enviar(instance, jid, "Acabou o saldo da IA desta loja (franquia do ciclo + saldo comprado). Compre saldo no Portal > Automação > Assistente IA pra eu voltar a responder.")
        return ok()
      }
      const r = await fetch(`${SUPABASE_URL}/functions/v1/assistente-loja`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
        body: JSON.stringify({ empresa_id: empresaId, pergunta, grupo_jid: jid, historico: await ultimasConversas(empresaId) }),
      })
      const d = await r.json().catch(() => null)
      await enviar(instance, jid, d?.resposta || d?.erro || "Não consegui responder agora. Tenta de novo em instantes.")
      if (whisperUsd > 0) {
        const { data: adm } = await sb.from("profiles").select("id").eq("empresa_id", empresaId).eq("perfil", "admin").limit(1).maybeSingle()
        if (adm?.id) await cobrar(sb, carteira, {
          empresaId, userId: adm.id, custoUsd: whisperUsd, descricao: "Áudio no grupo do analista", pergunta: "[áudio] " + pergunta.slice(0, 200),
          resposta: "(transcrição)", modelo: "whisper-1", canal: "whatsapp_pergunta",
        })
      }
      return ok()
    }

    // ═══ ROBÔ ASSISTENTE ═══ estoque e cadastros. Gasta CRÉDITOS (empresas.whatsapp_creditos).
    // Último lançamento (30 min): "faltou o preço" depois do SIM vira uma correção desse lançamento.
    const { data: ultLancado } = pend ? { data: null } : await sb.from("estoque_whatsapp").select("*")
      .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "lancado")
      .gte("lancado_em", new Date(Date.now() - 30 * 60000).toISOString())
      .order("lancado_em", { ascending: false }).limit(1).maybeSingle()

    const reverter = async (ult: any) => {
      if (ult.imprevistos?.length) await sb.from("custos_imprevistos").delete().in("id", ult.imprevistos)
      if (ult.mov_produtos?.length) await sb.from("estoque_movimentos").delete().in("id", ult.mov_produtos)
      if (ult.mov_materias?.length) await sb.from("materia_prima_movimentos").delete().in("id", ult.mov_materias)
      await sb.from("estoque_whatsapp").update({ status: "cancelado" }).eq("id", ult.id)
    }
    // Lança a lista pendente; se ela corrige um lançamento anterior, troca um pelo outro.
    const confirmar = async (p: any) => {
      try {
        const msgOk = await lancar(empresaId, p)
        if (p.substitui_id) {
          const { data: velho } = await sb.from("estoque_whatsapp").select("*").eq("id", p.substitui_id).maybeSingle()
          if (velho && velho.status === "lancado") await reverter(velho)
        }
        await enviar(instance, jid, msgOk)
      } catch (e: any) {
        console.error("[estoque-wpp] lancar:", e)
        await enviar(instance, jid, e?.message === ERRO_ESTOQUE_OFF ? AVISO_ESTOQUE_OFF
          : "❌ Não consegui lançar agora (erro no sistema). Nada foi gravado — tente de novo em instantes.")
      }
    }
    const faltaPreco = (p: any) => [...(p.itens ?? []), ...(p.nao_achados ?? [])].filter((x: any) => precisaPreco(x) && x.custo_unit == null)

    if (pend && /^(sem (o )?(preco|valor|custo)|nao sei( o preco| o valor)?|(lanca|lancar|pode lancar) sem (preco|valor|custo))\W*$/.test(t)) {
      const zera = (l: any[]) => (l ?? []).map((x: any) => ({ ...x, custo_unit: x.custo_unit ?? 0 }))
      pend.itens = zera(pend.itens); pend.nao_achados = zera(pend.nao_achados)
      await sb.from("estoque_whatsapp").update({ itens: pend.itens, nao_achados: pend.nao_achados }).eq("id", pend.id)
      await confirmar(pend)
      return ok()
    }

    if (/^(sim|s|ok|pode|pode lancar|lanca|lancar|confirmo|confirmar|isso|isso mesmo|certo|pode fazer|faz|aplicar|aplica)\W*$/.test(t)) {
      if (acaoMaisNova) {
        try { await enviar(instance, jid, await executarAcao(empresaId, pendAcao)) }
        catch (e: any) {
          console.error("[estoque-wpp] acao:", e)
          await enviar(instance, jid, e?.message === ERRO_ESTOQUE_OFF ? AVISO_ESTOQUE_OFF : "❌ Não consegui aplicar agora (erro no sistema). Nada foi alterado — tente de novo em instantes.")
        }
        return ok()
      }
      if (!pend) return ok()
      if (!(pend.itens ?? []).length && !(pend.nao_achados ?? []).length) {
        await enviar(instance, jid, "Não tem nenhum item reconhecido pra lançar. Mande de novo o que comprou.")
        await sb.from("estoque_whatsapp").update({ status: "cancelado" }).eq("id", pend.id)
        return ok()
      }
      const sem = faltaPreco(pend)
      if (sem.length) {
        await enviar(instance, jid, `❓ Ainda falta o preço (por unidade) de: ${sem.map((x: any) => x.nome).join(", ")}.\nMe diga o valor, ex.: "${sem[0].nome} 1,30". Ou responda *SEM PREÇO* para lançar assim mesmo.`)
        return ok()
      }
      await confirmar(pend)
      return ok()
    }
    if (/^(nao|n|cancela|cancelar|cancelado|deixa|esquece)\W*$/.test(t)) {
      if (acaoMaisNova) {
        await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("id", pendAcao.id)
        await enviar(instance, jid, "Cancelado. Nada foi alterado.")
        return ok()
      }
      if (!pend) return ok()
      await sb.from("estoque_whatsapp").update({ status: "cancelado" }).eq("id", pend.id)
      await enviar(instance, jid, "Cancelado. Nada foi lançado.")
      return ok()
    }
    if (/^desfaz(er)?\W*$/.test(t)) {
      const lim = new Date(Date.now() - VALIDADE_DESFAZER_MIN * 60000).toISOString()
      const { data: ult } = await sb.from("estoque_whatsapp").select("*")
        .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "lancado").gte("lancado_em", lim)
        .order("lancado_em", { ascending: false }).limit(1).maybeSingle()
      const { data: ultAcao } = await sb.from("assistente_acoes").select("*")
        .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "executada").gte("executada_em", lim)
        .order("executada_em", { ascending: false }).limit(1).maybeSingle()
      if (ultAcao && (!ult || ultAcao.executada_em > ult.lancado_em)) {
        await enviar(instance, jid, await desfazerAcao(empresaId, ultAcao))
        return ok()
      }
      if (!ult) { await enviar(instance, jid, "Não achei nada recente pra desfazer (só dá até 3 horas depois)."); return ok() }
      await reverter(ult)
      await enviar(instance, jid, `↩️ Desfeito. Tirei o último lançamento do estoque (os insumos novos continuam cadastrados; prejuízo lançado no financeiro também foi apagado).\n(O custo que atualizei no cadastro não volta sozinho — confira se precisar.)`)
      return ok()
    }

    // ── Conteúdo novo: texto, áudio ou nota (foto/PDF) ──────────────────────
    const tipoMsg: string = msg.messageType ?? ""
    const m = msg.message ?? {}
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage
    const ehImagem = tipoMsg === "imageMessage"
    const ehPdf = !!doc && String(doc.mimetype ?? "").includes("pdf")
    const ehAudio = tipoMsg === "audioMessage"

    // Créditos: o Assistente gasta CRÉDITOS (1 por texto/áudio/cadastro, 3 por nota). Sem crédito, o grupo para.
    const creditosDoUso = ehImagem || ehPdf ? 3 : 1
    const { data: empCred } = await sb.from("empresas").select("whatsapp_creditos").eq("id", empresaId).maybeSingle()
    const saldoCred = Number(empCred?.whatsapp_creditos ?? 0)
    if (saldoCred < creditosDoUso) {
      if (ehImagem || ehPdf || ehAudio || /\d/.test(texto)) {
        await enviar(instance, jid, `Acabaram os créditos desta loja (${saldoCred} restantes; esta ação gasta ${creditosDoUso}). Compre créditos no Portal > Automação > WhatsApp pra eu voltar a lançar por aqui.`)
      }
      return ok()
    }
    const { data: adm } = await sb.from("profiles").select("id").eq("empresa_id", empresaId).eq("perfil", "admin").limit(1).maybeSingle()
    const donoId: string | undefined = adm?.id

    const cat = await carregarCatalogo(empresaId)
    const base = pend ?? ultLancado     // a lista que a mensagem pode estar corrigindo
    let resultado: { itens: Item[]; naoAchados: NaoAchado[]; ignorar?: boolean; pergunta?: boolean; corrige?: boolean; produtosNovos?: ProdutoNovo[]; minimos?: MinimoSolto[]; aviso?: string | null; custoUsd: number } | null = null
    let origem = "texto"
    let textoFalado = ""

    if (ehImagem || ehPdf) {
      origem = ehPdf ? "pdf" : "foto"
      const midia = await baixarMidia(instance, msg)
      if (!midia) { await enviar(instance, jid, "Não consegui baixar a foto. Manda de novo?"); return ok() }
      if (ehImagem && midia.mimetype === "image/webp") { await enviar(instance, jid, "Esse formato de imagem eu não leio. Manda como foto normal."); return ok() }
      const r = await lerNota(midia.base64, midia.mimetype, cat)
      if ("erro" in r) { await enviar(instance, jid, `Não consegui ler a nota: ${r.erro}`); return ok() }
      resultado = r
    } else if (ehAudio) {
      origem = "audio"
      const midia = await baixarMidia(instance, msg)
      const falado = midia ? await transcrever(midia.base64, midia.mimetype) : null
      if (!falado) { await enviar(instance, jid, "Não consegui ouvir o áudio. Escreve ou manda de novo?"); return ok() }
      resultado = await entenderTexto(falado, cat, base?.itens ?? [], base?.nao_achados ?? [], !pend && !!ultLancado)
      if (resultado) resultado.custoUsd += ((msg.message?.audioMessage?.seconds ?? 30) / 60) * PRECO_WHISPER_MIN
      textoFalado = falado
    } else if (texto) {
      resultado = await entenderTexto(texto, cat, base?.itens ?? [], base?.nao_achados ?? [], !pend && !!ultLancado)
    } else {
      return ok()
    }

    if (!resultado) { await enviar(instance, jid, "Tive um problema pra entender agora. Tenta de novo em instantes."); return ok() }
    // Cobra os créditos e guarda o custo REAL no histórico (o Super Admin vê quanto cada uso custou de verdade).
    const cobrarUso = async (resposta: string): Promise<string> => {
      const { data: saldoDepois, error } = await sb.rpc("descontar_creditos_whatsapp", {
        p_empresa_id: empresaId, p_qtd: creditosDoUso, p_descricao: `Assistente do grupo (${origem})`,
      })
      if (error) console.error("[estoque-wpp] creditos:", error.message)
      if (donoId) {
        const { error: e2 } = await sb.from("assistente_conversas").insert({
          empresa_id: empresaId, user_id: donoId, canal: "whatsapp_estoque", modelo: "claude-haiku-4-5",
          pergunta: `[estoque/${origem}] ${(textoFalado || texto).slice(0, 200)}`, resposta: resposta.slice(0, 2000),
          custo_usd: Number(resultado!.custoUsd.toFixed(6)), custo_brl: 0, creditos_cobrados: creditosDoUso,
        })
        if (e2) console.error("[estoque-wpp] historico:", e2.message)
      }
      const resta = Number(saldoDepois)
      return !error && resta <= 20 ? `\n\n⚠️ Restam *${resta}* créditos. Compre mais no Portal pra não ficar sem.` : ""
    }

    // Só definir estoque mínimo de item que já existe ("pão brioche mínimo 50"): proposta com SIM.
    if (resultado.minimos?.length && !resultado.itens.length && !resultado.naoAchados.length && !resultado.produtosNovos?.length) {
      const itensMin: any[] = []
      for (const m of resultado.minimos) {
        const { data: atual } = await sb.from(m.tipo === "produto" ? "produtos" : "materias_primas").select("estoque_minimo").eq("id", m.id).maybeSingle()
        itensMin.push({ tipo: m.tipo, id: m.id, nome: m.nome, de: Number(atual?.estoque_minimo ?? 0), para: m.minimo })
      }
      const resumoMin = `Definir estoque mínimo: ${itensMin.map((i) => `*${i.nome}* de ${qtdTxt(i.de)} para ${qtdTxt(i.para)}`).join(", ")}.`
      await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente")
      await sb.from("assistente_acoes").insert({ empresa_id: empresaId, grupo_jid: jid, tipo: "definir_minimo", resumo: resumoMin, params: { itens: itensMin } })
      const aviso = await cobrarUso(resumoMin)
      await enviar(instance, jid, `${resumoMin}

Responda *SIM* para aplicar ou *NÃO* para cancelar.${aviso}`)
      return ok()
    }
    // Cadastro de produto novo (só preço de venda é obrigatório). Vira uma proposta; o SIM aplica.
    if (resultado.produtosNovos?.length && !resultado.itens.length && !resultado.naoAchados.length) {
      const pn = resultado.produtosNovos[0]
      if (!pn.preco_venda) {
        await enviar(instance, jid, `Qual o preço de venda de *${pn.nome}*? Me mande tudo de novo, ex.: "cadastra ${pn.nome} por 12 reais".`)
        return ok()
      }
      const { data: ja } = await sb.from("produtos").select("nome").eq("empresa_id", empresaId).eq("ativo", true).is("arquivado_em", null)
        .ilike("nome", pn.nome.replace(/[%_]/g, "")).limit(1)
      if (ja?.length) { await enviar(instance, jid, `Já existe um produto chamado "${ja[0].nome}". Quem muda preço é o grupo do *Analista*.`); return ok() }
      const { data: cats } = await sb.from("produtos").select("categoria").eq("empresa_id", empresaId).eq("ativo", true).limit(500)
      const existentes = [...new Set((cats ?? []).map((c: any) => String(c.categoria)))] as string[]
      const categoria = existentes.find((c) => norm(c) === norm(pn.categoria)) ?? (pn.categoria || "outros")
      // Com estoque inicial, o custo é obrigatório (mesma regra da compra: entrada sem preço deixa o lucro às cegas).
      if (pn.quantidade_inicial && !pn.preco_custo) {
        await enviar(instance, jid, `Quanto você pagou em cada unidade de *${pn.nome}* (custo)? Me mande tudo de novo, ex.: "cadastra ${pn.nome} por ${brl(pn.preco_venda)}, tenho ${pn.quantidade_inicial}, custo 5".`)
        return ok()
      }
      const resumoCad = `Cadastrar produto *${pn.nome}* por ${brl(pn.preco_venda)} na categoria ${categoria}${pn.preco_custo ? ` (custo ${brl(pn.preco_custo)})` : ""}${pn.quantidade_inicial ? `, com ${qtdTxt(pn.quantidade_inicial)} em estoque` : ""}${pn.estoque_minimo ? `, mínimo ${qtdTxt(pn.estoque_minimo)}` : ""}${existentes.includes(categoria) ? "" : " — categoria nova"}.`
      await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente")
      await sb.from("assistente_acoes").insert({
        empresa_id: empresaId, grupo_jid: jid, tipo: "cadastrar_produto", resumo: resumoCad,
        params: { nome: pn.nome, preco_venda: pn.preco_venda, categoria, preco_custo: pn.preco_custo, quantidade_inicial: pn.quantidade_inicial, estoque_minimo: pn.estoque_minimo },
      })
      const aviso = await cobrarUso(resumoCad)
      await enviar(instance, jid, `${resumoCad}\n\nResponda *SIM* para cadastrar ou *NÃO* para cancelar.${aviso}`)
      return ok()
    }
    // Pergunta ou decisão do dono: não é aqui. Não cobra nada.
    if (!resultado.itens.length && !resultado.naoAchados.length && resultado.pergunta) {
      await enviar(instance, jid, cfg.analista_grupo_jid
        ? "Isso é pergunta ou decisão pro grupo do *Analista*. Aqui eu cuido de estoque e cadastro de produto."
        : "Isso é pergunta ou decisão pro robô *Analista*. Crie outro grupo com o número da loja e escreva *ativar analista*. Aqui eu cuido de estoque e cadastro de produto.")
      return ok()
    }
    if (resultado.ignorar) return ok()                      // papo do grupo, não é compra
    if (!resultado.itens.length && !resultado.naoAchados.length) {
      if (origem === "texto") return ok()
      await enviar(instance, jid, "Não achei nenhum item nessa " + (origem === "audio" ? "fala" : "nota") + ".")
      return ok()
    }

    // Saída e contagem só valem pra item que JÁ existe: o que não achou não vira insumo novo.
    const naoExiste = resultado.naoAchados.filter((n) => (n.mov ?? "entrada") !== "entrada")
    if (naoExiste.length) {
      resultado.naoAchados = resultado.naoAchados.filter((n) => (n.mov ?? "entrada") === "entrada")
      if (!resultado.itens.length && !resultado.naoAchados.length) {
        await enviar(instance, jid, `Não achei no estoque: ${naoExiste.map((n) => n.nome).join(", ")}. Pra dar saída ou contagem o item precisa existir. Se chegou agora, mande a compra primeiro (ex.: "comprei 10 ${naoExiste[0].nome} a 5 reais").`)
        return ok()
      }
    }
    const infoResumo = await infoDosItens(empresaId, resultado.itens.filter((i) => (i.mov ?? "entrada") !== "entrada").map((i) => i.id))

    // Lista nova substitui a que estava esperando.
    if (pend) await sb.from("estoque_whatsapp").update({ status: "cancelado" }).eq("id", pend.id)
    // Corrige um lançamento já feito? A lista nova guarda qual substitui (o SIM troca um pelo outro).
    // Corrigir lançamento só vale pra COMPRA (faltou preço, quantidade errada). Saída, contagem e bonificação são movimentos
    // novos: substituir um deles desfazia a perda sem querer, e a contagem era calculada com o saldo antigo.
    const soCompra = (l: { mov?: Mov; motivo?: string }[]) => l.every((x) => (x.mov ?? "entrada") === "entrada" && (x.motivo ?? "compra") === "compra")
    const podeCorrigir = !!ultLancado && soCompra(resultado.itens) && soCompra(resultado.naoAchados) &&
      soCompra(ultLancado.itens ?? []) && soCompra(ultLancado.nao_achados ?? [])
    const substitui = pend?.substitui_id ?? (resultado.corrige && podeCorrigir ? ultLancado!.id : null)
    await sb.from("estoque_whatsapp").insert({
      empresa_id: empresaId, grupo_jid: jid, status: "pendente", origem,
      itens: resultado.itens, nao_achados: resultado.naoAchados, substitui_id: substitui,
    })
    const aviso = resultado.aviso ? `\n\n⚠️ ${resultado.aviso}` : ""
    const textoResumo = resumo(resultado.itens, resultado.naoAchados, !!substitui, infoResumo) + aviso +
      (naoExiste.length ? `\n\n⚠️ Não achei pra dar saída/contagem (ignorei): ${naoExiste.map((n) => n.nome).join(", ")}.` : "")
    const avisoCred = await cobrarUso(textoResumo)
    await enviar(instance, jid, textoResumo + avisoCred)
    return ok()
  } catch (e) {
    console.error("[estoque-wpp] erro:", e)
    return ok()
  }
}

// Esta função age na loja (lança estoque, muda preço…), então só aceita quem tem a chave de SERVIÇO: o webhook
// principal repassa com ela. Sem isso qualquer um podia forjar uma mensagem de grupo. A chave é conferida chamando
// uma função do banco que só o service_role executa (vale pra qualquer formato de chave de serviço).
const chavesValidas = new Map<string, number>()
async function ehChaveDeServico(token: string): Promise<boolean> {
  if (!token) return false
  if (token === SUPABASE_KEY) return true
  const vistoEm = chavesValidas.get(token)
  if (vistoEm && Date.now() - vistoEm < 10 * 60_000) return true
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/estoque_bot_saldos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: token, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ p_empresa_id: "00000000-0000-0000-0000-000000000000" }),
  }).catch(() => null)
  if (r?.ok) { chavesValidas.set(token, Date.now()); return true }
  return false
}

serve(async (req) => {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  if (!(await ehChaveDeServico(token))) return new Response("forbidden", { status: 403 })
  if (req.headers.get("x-teste") === "1") {
    const captura: string[] = []
    await capturaTeste.run(captura, () => tratar(req))
    return new Response(JSON.stringify({ respostas: captura }), { headers: { "Content-Type": "application/json" } })
  }
  return tratar(req)
})
