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
import { lerComandoConta, extrairData, somaDiasYmd } from "../_shared/contasParse.ts"

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
// A conversa livre com IA (Analista com raciocínio) vai ser um robô SEPARADO e mais caro, em outro grupo. Por ora só comandos fixos.
const ANALISTA_IA_LIGADA = false
const VALIDADE_PENDENTE_MIN = 60
const VALIDADE_DESFAZER_MIN = 180

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
const ok = () => new Response("ok")

type Item = { tipo: "produto" | "materia"; id: string; nome: string; quantidade: number; custo_unit: number | null; estoque_minimo?: number | null; mov?: Mov; motivo?: string }
type Mov = "entrada" | "saida" | "ajuste"
type NaoAchado = { nome: string; quantidade: number; custo_unit: number | null; unidade?: string; estoque_minimo?: number | null; mov?: Mov }
// O que o robô leu do documento (nota, cupom ou comprovante). Só nasce de
// FOTO/PDF: compra falada não tem fornecedor nem total confiável, e despesa
// errada no financeiro da loja é pior do que despesa faltando.
type NotaLida = {
  fornecedor: string
  documento: string | null
  numero?: string | null      // número da NF-e, quando aparece
  valor_total: number
  data: string | null         // emissão
  vencimento?: string | null  // quando é a prazo (boleto, duplicata, fatura)
  pago: boolean | null        // null = o documento não deixou claro
  forma: string | null
  // A nota quebrada por categoria de gasto (mig 0389), já conferida contra o
  // total por quem leu o papel. null/vazio = não deu pra separar.
  rateio?: { categoria: string; valor: number }[] | null
} | null

// "Alimentos R$ 92,29 · Limpeza e higiene R$ 18,07" — do jeito que o dono lê no
// zap. Sem rateio, a linha de sempre.
function linhasDoRateio(nota: NonNullable<NotaLida>): string {
  const r = Array.isArray(nota.rateio) ? nota.rateio : []
  if (!r.length) return "📊 Categoria: Fornecedores"
  return "📊 Categorias:\n" + r.map((l) => `   ▪️ ${l.categoria}: *${brl(l.valor)}*`).join("\n")
}

// A categoria da CONTA (a etiqueta que filtra no Portal) é a maior do rateio:
// numa compra de R$ 110 com R$ 92 de alimento, "Fornecedores" não diz nada e
// "Alimentos" diz quase tudo. Empate ou sem rateio: Fornecedores, como antes.
function categoriaDaConta(nota: NonNullable<NotaLida>): string {
  const r = Array.isArray(nota.rateio) ? nota.rateio : []
  return r.length ? r[0].categoria : "Fornecedores"
}

// ESTOQUE PELO ROBÔ: EM PAUSA (23/10/2026)
//
// Decisão do Wilde. A entrada de estoque pelo gestor já avisa o dono no
// WhatsApp (mig 0370-0374) — quem lança vê a tela, e o dono recebe o resumo
// com quem foi, quanto entrou e quanto ficou. O robô fazendo a mesma coisa por
// foto só acrescenta o erro de leitura da IA: ela chuta a quantidade e o
// casamento do item, e quando erra ninguém percebe até a contagem.
//
// O que ela NÃO chuta é o total do documento e o fornecedor — por isso o lado
// financeiro fica, e é só ele que fica.
//
// Ligar de novo é trocar pra true: o código do estoque continua inteiro aqui.
const ESTOQUE_PELO_ROBO = false
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
): Promise<{ itens: Item[]; naoAchados: NaoAchado[]; ignorar: boolean; pergunta: boolean; corrige: boolean; produtosNovos: ProdutoNovo[]; minimos: MinimoSolto[]; custoUsd: number; nota: NotaLida } | null> {
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
    '  "nao_encontrados": [ { "nome": string, "unidade": "kg"|"g"|"L"|"ml"|"un", "quantidade": number, "custo_unit": number|null, "custo_total": number|null, "estoque_minimo": number|null, "movimento": "entrada"|"saida"|"ajuste" } ],',
    '  "nota": { "fornecedor": string|null, "documento": string|null, "valor_total": number|null, "data": "AAAA-MM-DD"|null, "pago": boolean|null, "forma": string|null } | null }',
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
    // A compra é estoque E dinheiro saindo. Só NOTA/CUPOM/COMPROVANTE preenche
    // isso: mensagem falada ("comprei 50 pães") não tem fornecedor nem total
    // confiável, e chutar criaria despesa errada no financeiro da loja.
    "- 'nota': preencha SÓ quando a mensagem for uma NOTA, CUPOM FISCAL ou COMPROVANTE (foto ou PDF). Em texto ou áudio, nota = null.",
    "  'fornecedor' = a razão social de quem VENDEU (quem emitiu o documento), não a loja que comprou. 'documento' = o CNPJ do emitente.",
    "  'valor_total' = o total do documento (em cupom fiscal é 'VALOR TOTAL' / 'VALOR A PAGAR'), não a soma que você calcular.",
    "  'data' = a data de emissão. 'pago' = true quando o documento mostra que já foi pago (ex.: 'VALOR PAGO', 'FORMA PAGAMENTO',",
    "  comprovante de PIX/cartão); false quando é a prazo/boleto/duplicata; null se não dá pra saber.",
    "  'forma' = dinheiro | pix | credito | debito | boleto | transferencia, se o documento disser.",
    "- Comprovante de pagamento SEM itens (PIX, maquininha) é válido: devolva itens e nao_encontrados vazios, ignorar=false e a 'nota' preenchida.",
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
  // Dados do documento. Só vale com fornecedor E total: sem os dois não dá pra
  // montar uma despesa honesta, e meia despesa no financeiro é pior que nenhuma.
  const n = parsed.nota
  const totalNota = num(n?.valor_total)
  const fornecedor = String(n?.fornecedor ?? "").trim().slice(0, 120)
  const nota = (totalNota && fornecedor)
    ? {
      fornecedor,
      documento: String(n?.documento ?? "").replace(/\D/g, "").slice(0, 14) || null,
      valor_total: totalNota,
      data: /^\d{4}-\d{2}-\d{2}$/.test(String(n?.data)) ? String(n.data) : null,
      pago: typeof n?.pago === "boolean" ? n.pago : null,
      forma: ["dinheiro", "pix", "credito", "debito", "boleto", "transferencia"].includes(String(n?.forma))
        ? String(n.forma) : null,
    }
    : null

  return {
    itens, naoAchados, custoUsd, nota,
    // Comprovante sem item nenhum ainda é coisa pra fazer: vira só a despesa.
    ignorar: parsed.ignorar === true && !itens.length && !naoAchados.length && !nota,
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
async function lerNota(base64: string, mimetype: string, cat: Awaited<ReturnType<typeof carregarCatalogo>>, empresaId: string) {
  // O que esta loja já corrigiu (mig 0390). Vai junto da nota pra IA não repetir
  // o mesmo erro — papel toalha é Limpeza numa loja e Descartáveis na outra.
  const { data: dic } = await sb.from("categoria_item_aprendida")
    .select("termo, categoria").eq("empresa_id", empresaId)
    .order("atualizado_em", { ascending: false }).limit(300)
  const r = await fetch(`${SUPABASE_URL}/functions/v1/ler-nota-estoque`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
    body: JSON.stringify({
      imageBase64: base64, mimetype,
      produtos: cat.produtos, materias: cat.materias.map((m) => ({ id: m.id, nome: m.nome })),
      dicionario: dic ?? [],
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
  // Fornecedor, total e forma de pagamento vêm da mesma leitura: quem está
  // olhando a nota já tem isso na frente, e uma segunda chamada à IA só pra
  // perguntar "de quem é essa nota?" seria pagar duas vezes pelo mesmo papel.
  return {
    // O rateio vem solto na resposta (ele fala do documento inteiro, não de um
    // item): entra junto da nota, que é quem vira despesa.
    itens, naoAchados,
    nota: (d.nota ? { ...d.nota, rateio: Array.isArray(d.rateio) ? d.rateio : null } : null) as NotaLida,
    aviso: d.aviso as string | null,
    custoUsd: usd({ entrada: d.uso?.entrada ?? 0, saida: d.uso?.saida ?? 0 }),
  }
}

// Como a despesa aparece na confirmação, antes do SIM. O lojista precisa ver o
// que vai sair do caixa dele ANTES de confirmar, não descobrir depois.
function linhaDespesa(nota: any, temItens: boolean): string | null {
  if (!nota) return null
  const quando = nota.data ? ddmmBR(nota.data) : "hoje"
  const comoPagou = nota.forma ? ` (${ROTULO_FORMA[nota.forma] ?? nota.forma})` : ""
  // VERBO NO FUTURO, SEMPRE (23/10/2026)
  //
  // Dizia "despesa *já paga*: VHB — R$ 245,60". O "já paga" falava do
  // PAGAMENTO, mas o lojista do Agv Grill leu como "já lancei" — achou que
  // estava pronto, não respondeu SIM, e a nota ficou pendente até vencer.
  // Esta linha aparece ANTES do SIM: tem que soar como promessa, não como
  // recibo. Quem anuncia o que já foi feito é a mensagem depois do SIM.
  //
  // Comprovante sem itens: a despesa é a mensagem inteira, não um "e também".
  const abre = temItens ? "💸 E no financeiro, *vou lançar*" : "💸 Entendi este comprovante. *Vou lançar*"
  // A quebra por categoria aparece ANTES do SIM: é onde o dono percebe que a
  // nota do açougue trouxe R$ 18 de limpeza junto — e pode corrigir antes.
  const r = Array.isArray(nota.rateio) ? nota.rateio : []
  const cats = r.length ? "\n" + r.map((l: any) => `   ▪️ ${l.categoria}: *${brl(Number(l.valor))}*`).join("\n") : ""
  return nota.pago === false
    ? `${abre} uma conta *A PAGAR*: *${nota.fornecedor}* — ${brl(nota.valor_total)}, vence ${quando}.${cats}`
    : `${abre} uma despesa (já paga por você): *${nota.fornecedor}* — ${brl(nota.valor_total)} em ${quando}${comoPagou}.${cats}`
}
function resumo(itens: Item[], naoAchados: NaoAchado[], corrige = false, info: Map<string, { saldo: number; custo: number }> = new Map(), nota: any = null): string {
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
  const despesa = linhaDespesa(nota, linhas.length > 0 || naoAchados.length > 0)
  if (despesa) partes.push(despesa)
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
  let contaId: string | null = null
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
  // A COMPRA TAMBÉM É DINHEIRO SAINDO (23/10/2026)
  //
  // Até aqui a nota virava só movimento de estoque, e a loja comprava R$ 245,60
  // de carne sem que isso aparecesse no financeiro — lucro do dia inflado.
  //
  // Só nota/cupom/comprovante gera despesa (é de lá que vêm fornecedor e total
  // conferíveis). Compra falada não gera: "comprei 50 pães" não tem fornecedor
  // nem total confiável, e despesa errada é pior do que despesa faltando.
  //
  // Pago ou a prazo não é chute: o documento diz. O cupom fiscal traz "VALOR
  // PAGO" e a forma; nota a prazo não traz.
  let despesa = ""
  if (pend.nota?.fornecedor && Number(pend.nota?.valor_total) > 0) {
    const n = pend.nota
    const quando = /^\d{4}-\d{2}-\d{2}$/.test(String(n.data)) ? String(n.data) : hoje
    const quitada = n.pago !== false      // null (não deu pra ler) conta como paga
    try {
      const { data: c, error } = await sb.from("contas_financeiras").insert({
        empresa_id: empresaId, tipo: "pagar",
        descricao: `Compra — ${n.fornecedor}`,
        pessoa: n.fornecedor, categoria: "Fornecedores",
        valor: n.valor_total, vencimento: quando, recorrencia: "nenhuma", origem: "whatsapp",
      }).select("id").single()
      if (error) throw error
      contaId = c.id
      if (quitada) {
        const { error: eb } = await sb.from("contas_baixas").insert({
          empresa_id: empresaId, conta_id: c.id, valor: n.valor_total,
          data: quando, forma: n.forma ?? null, origem: "whatsapp",
        })
        if (eb) throw eb
      }
      despesa = quitada
        ? `\n💸 Despesa lançada: *${n.fornecedor}* ${brl(n.valor_total)} — paga em ${ddmmBR(quando)}.`
        : `\n💸 Conta a pagar: *${n.fornecedor}* ${brl(n.valor_total)}, vence ${ddmmBR(quando)}.`
    } catch (e) {
      // Estoque já entrou e está certo. Não dá pra desfazer tudo por causa da
      // despesa, mas também não dá pra ficar calado: o lojista precisa saber
      // que o financeiro ficou sem ela.
      console.error("[estoque-wpp] despesa da nota:", e)
      despesa = `\n⚠️ O estoque entrou, mas NÃO consegui lançar a despesa de ${brl(n.valor_total)} (${n.fornecedor}). Lance pelo Portal em Financeiro.`
    }
  }

  await sb.from("estoque_whatsapp").update({
    status: "lancado", lancado_em: new Date().toISOString(), mov_produtos: idsP, mov_materias: idsM,
    imprevistos: idsImp, conta_id: contaId,
  }).eq("id", pend.id)
  const feitos = linP.length + linM.length
  const novos = criados.length ? `\n🆕 Cadastrei como insumo: ${criados.join(", ")}.` : ""
  const prej = prejuizo > 0 ? `\n💸 Lançado como prejuízo no financeiro: ${brl(prejuizo)}.` : ""
  const ja = ignorados.length ? `\nℹ️ Já estava certo (sem ajuste): ${ignorados.join(", ")}.` : ""
  const cabeca = feitos
    ? `✅ Lancei ${feitos} ${feitos === 1 ? "movimento" : "movimentos"} no estoque.`
    : "✅ Registrado."
  return `${cabeca}${novos}${prej}${ja}${despesa}\nSe foi engano, responda *DESFAZER*.`
}

// NOTA → CONTA NO FINANCEIRO, NA HORA (23/10/2026)
//
// Enquanto o estoque pelo robô está em pausa, a nota vira SÓ dinheiro. E vira
// na hora, sem pedir SIM: o fornecedor e o total saem impressos do documento,
// não são chute da IA, e a espera pelo SIM foi justamente o que fez a loja
// achar que não tinha salvo e mandar a mesma nota de novo (duplicou).
//
// Paga ou a prazo não é chute: o documento diz. Cupom e comprovante trazem
// "VALOR PAGO"/forma; nota a prazo traz boleto, duplicata ou fatura — e dessa
// a gente tira o VENCIMENTO, senão a conta nasce invisível pro alerta.
async function contaDaNota(empresaId: string, jid: string, nota: NonNullable<NotaLida>, origem: string): Promise<string> {
  const hoje = hojeBRT()
  const emissao = /^\d{4}-\d{2}-\d{2}$/.test(String(nota.data)) ? String(nota.data) : hoje

  // PAPEL ESCRITO À MÃO NÃO DIZ SE FOI PAGO (24/10/2026)
  //
  // Antes: `pago !== false`, ou seja, null virava PAGA. Num cupom fiscal isso
  // está certo (ele imprime "VALOR PAGO"); num bloquinho de feira está errado
  // metade das vezes — e uma compra a prazo registrada como paga some do "a
  // pagar" e o dono leva o calote do esquecimento.
  //
  // Quando o papel não diz, o robô PERGUNTA. Mesma regra do gasto escrito
  // solto: só registra completo.
  if (typeof nota.pago !== "boolean" || (nota.pago === false && !nota.vencimento)) {
    return await rascunhoDaNota(empresaId, jid, nota, emissao)
  }
  const quitada = nota.pago
  const vence = quitada ? emissao
    : (/^\d{4}-\d{2}-\d{2}$/.test(String(nota.vencimento)) ? String(nota.vencimento) : emissao)

  // Já entrou? Mesmo fornecedor, total e data é a mesma nota na prática.
  const { data: iguais } = await sb.from("contas_financeiras")
    .select("id, created_at, valor_pago")
    .eq("empresa_id", empresaId).eq("pessoa", nota.fornecedor).eq("valor", nota.valor_total)
    .eq("vencimento", vence).limit(1)
  if (iguais?.length) {
    const hora = new Date(iguais[0].created_at).toLocaleTimeString("pt-BR", {
      timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit",
    })
    return `🚨 *Essa nota já está registrada.*\n*${nota.fornecedor}* — ${brl(nota.valor_total)}, lançada hoje às ${hora}.\n\nConfira no Portal: *Financeiro › Contas a pagar e receber*.\nNão lancei de novo pra não duplicar.`
  }

  const numero = nota.numero ? ` (NF ${nota.numero})` : ""
  const { data: c, error } = await sb.from("contas_financeiras").insert({
    empresa_id: empresaId, tipo: "pagar",
    descricao: `Compra — ${nota.fornecedor}${numero}`,
    pessoa: nota.fornecedor, categoria: categoriaDaConta(nota),
    rateio: (nota.rateio?.length ? nota.rateio : null),
    valor: nota.valor_total, vencimento: vence, recorrencia: "nenhuma", origem: "whatsapp",
  }).select("id").single()
  if (error) {
    console.error("[estoque-wpp] conta da nota:", error)
    return `❌ Não consegui registrar a despesa de ${brl(nota.valor_total)} (${nota.fornecedor}). Tente de novo, ou lance pelo Portal em Financeiro.`
  }

  if (quitada) {
    const { error: eb } = await sb.from("contas_baixas").insert({
      empresa_id: empresaId, conta_id: c.id, valor: nota.valor_total,
      data: emissao, forma: nota.forma ?? null, origem: "whatsapp",
    })
    if (eb) console.error("[estoque-wpp] baixa da nota:", eb)
  }

  // Guarda pro DESFAZER: é a mesma trilha que o lançamento de estoque usava.
  await sb.from("estoque_whatsapp").insert({
    empresa_id: empresaId, grupo_jid: jid, status: "lancado", origem,
    itens: [], nao_achados: [], nota, conta_id: c.id, lancado_em: new Date().toISOString(),
  }).then(() => {}, () => {})

  const forma = nota.forma ? ` (${ROTULO_FORMA[nota.forma] ?? nota.forma})` : ""
  return quitada
    ? `🟢 *Despesa registrada*\n\n` +
      `🏪 Fornecedor: *${nota.fornecedor}*\n` +
      `💸 Valor: *${brl(nota.valor_total)}*\n` +
      `📆 Pago em: ${ddmmBR(emissao)}${forma}\n` +
      `${linhasDoRateio(nota)}${nota.numero ? `\n🧾 Nota: ${nota.numero}` : ""}\n\n` +
      `Se foi engano, responda *DESFAZER*.`
    : `🟠 *Conta a pagar registrada*\n\n` +
      `🏪 Fornecedor: *${nota.fornecedor}*\n` +
      `💸 Valor: *${brl(nota.valor_total)}*\n` +
      `📆 Vence em: *${ddmmBR(vence)}*\n` +
      `${linhasDoRateio(nota)}${nota.numero ? `\n🧾 Nota: ${nota.numero}` : ""}\n\n` +
      `Quando pagar, me diga *"paguei ${nota.fornecedor.split(/\s+/)[0]}"* que eu dou baixa.\n` +
      `Se foi engano, responda *DESFAZER*.`
}

// A FOTO QUE NÃO DIZ TUDO VIRA PERGUNTA, NÃO CHUTE (24/10/2026)
//
// Guarda o que o papel já deu (fornecedor, valor, data) e pede só o que falta.
// O dono não precisa decorar formato nenhum: manda a foto e responde.
async function rascunhoDaNota(empresaId: string, jid: string, nota: NonNullable<NotaLida>, emissao: string): Promise<string> {
  const temFornecedor = !!String(nota.fornecedor ?? "").trim()
  const numero = nota.numero ? ` (NF ${nota.numero})` : ""

  await sb.from("assistente_acoes").update({ status: "cancelada" })
    .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente")
  const { error } = await sb.from("assistente_acoes").insert({
    empresa_id: empresaId, grupo_jid: jid, tipo: "conta_criar",
    params: {
      rascunho: true, tipo: "pagar",
      descricao: temFornecedor ? `Compra — ${nota.fornecedor}${numero}` : `Compra${numero}`,
      pessoa: temFornecedor ? nota.fornecedor : null,
      categoria: categoriaDaConta(nota),
      rateio: nota.rateio?.length ? nota.rateio : null,
      valor: nota.valor_total,
      falta_fornecedor: !temFornecedor,
      emissao,
    },
    resumo: `Rascunho da nota: ${nota.fornecedor ?? "(sem fornecedor)"} — ${brl(nota.valor_total)}`,
  })
  if (error) {
    console.error("[estoque-wpp] rascunho da nota:", error.message)
    return "Li o papel, mas não consegui preparar o lançamento agora. Tenta de novo em instantes."
  }

  const cabeca = `📄 *Li o papel* — *${brl(nota.valor_total)}*` +
    (temFornecedor ? `\n🏪 ${nota.fornecedor}` : "") +
    (nota.data ? `\n📆 Data no papel: ${ddmmBR(emissao)}` : "")

  // Uma pergunta por vez: quem é o fornecedor vem antes, porque sem ele a
  // conta nasce sem dono e o lojista não acha depois no Portal.
  if (!temFornecedor) {
    return `${cabeca}\n\n` +
      `Não achei de *quem* é essa compra no papel.\n` +
      `Me diz o nome do fornecedor (ex.: *Mar Vermelho*), ou *NÃO* pra cancelar.`
  }
  return `${cabeca}\n\n` +
    `Falta saber se já pagou. Me responde uma dessas:\n` +
    `• *paguei hoje*\n` +
    `• *paguei dia 20* (ou "ontem")\n` +
    `• *a pagar dia 30* — se for pra pagar depois\n\n` +
    `Ou *NÃO* pra cancelar.`
}

// SIM OU NÃO SEM NADA ESPERANDO (23/10/2026)
//
// Antes o robô ficava CALADO. O dono do Agv Grill respondeu SIM depois da
// pendência já ter sido resolvida e não recebeu nada de volta — e não tinha
// como saber se tinha lançado, se tinha duplicado, ou se o robô morreu.
// Silêncio é o pior erro deste robô: já parecia quebrado quando negava em
// silêncio quem não podia ativar.
//
// Quando existe um lançamento recente, dizer QUAL foi mata a dúvida de uma vez.
// SIM e NÃO são grátis, então responder não custa nada pra ninguém.
async function nadaPraConfirmar(empresaId: string, jid: string): Promise<string> {
  const { data: ult } = await sb.from("estoque_whatsapp").select("nota, lancado_em")
    .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "lancado")
    .gte("lancado_em", new Date(Date.now() - 6 * 3600 * 1000).toISOString())
    .order("lancado_em", { ascending: false }).limit(1).maybeSingle()
  if (!ult) return "Não tem nada esperando confirmação agora. Mande a compra ou a foto da nota que eu preparo a lista."
  const n: any = ult.nota
  const hora = new Date(ult.lancado_em as string).toLocaleTimeString("pt-BR", {
    timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit",
  })
  const qual = n?.fornecedor && Number(n?.valor_total) > 0
    ? ` O último foi *${n.fornecedor}* — ${brl(n.valor_total)}, lançado às ${hora}.`
    : ` O último lançamento foi às ${hora}.`
  return `Não tem nada esperando confirmação agora.${qual}\nNada foi lançado em dobro. Se quiser desfazer, responda *DESFAZER*.`
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
  } else if (a.tipo === "conta_criar") {
    const { data: c, error } = await sb.from("contas_financeiras").insert({
      empresa_id: empresaId, tipo: p.tipo, descricao: p.descricao, pessoa: p.pessoa ?? null, categoria: p.categoria ?? null,
      // Rateio do rascunho da nota (mig 0389): o papel já foi lido, a quebra
      // por categoria é a mesma — ela só esperava o SIM.
      rateio: Array.isArray(p.rateio) && p.rateio.length ? p.rateio : null,
      valor: p.valor, vencimento: p.vencimento, recorrencia: p.recorrencia ?? "nenhuma", origem: "whatsapp",
    }).select("id").single()
    if (error) throw error
    antes = { conta_id: c.id }
    if (p.quitada) {
      // A baixa é do dia em que o dinheiro SAIU, não de hoje. Estava fixo em
      // hoje: quem lançava o gasto de ontem via a conta certa, mas o dia errado
      // — e o total de "pago hoje" ficava inflado com a despesa da véspera.
      const diaPago = /^\d{4}-\d{2}-\d{2}$/.test(String(p.vencimento)) ? String(p.vencimento) : hojeBRT()
      const { error: eb } = await sb.from("contas_baixas").insert({
        empresa_id: empresaId, conta_id: c.id, valor: p.valor, data: diaPago, forma: p.forma ?? null, origem: "whatsapp",
      })
      if (eb) { await sb.from("contas_financeiras").delete().eq("id", c.id); throw eb }
    }
    const aPagar = p.tipo === "pagar"
    const quando = String(p.vencimento) === hojeBRT() ? "hoje" : `em ${ddmmBR(String(p.vencimento))}`
    ok_ = p.quitada
      ? `✅ Registrado: *${p.descricao}* ${brl(Number(p.valor))} — ${aPagar ? "paga" : "recebida"} ${quando}.`
      : `✅ Conta ${aPagar ? "a pagar" : "a receber"} criada: *${p.descricao}* ${brl(Number(p.valor))}, vence ${ddmmBR(p.vencimento)}${p.recorrencia ? ` (repete ${p.recorrencia === "mensal" ? "todo mês" : p.recorrencia})` : ""}.`
  } else if (a.tipo === "conta_baixar") {
    const { data: conta } = await sb.from("contas_financeiras").select("*").eq("id", p.conta_id).eq("empresa_id", empresaId).maybeSingle()
    if (!conta || conta.status !== "aberta") throw new Error("A conta não está mais em aberto.")
    const restante = Math.round((Number(conta.valor) - Number(conta.valor_pago || 0)) * 100) / 100
    if (Number(p.valor) > restante + 0.004) throw new Error(`Só faltam ${brl(restante)} nessa conta.`)
    const inicio = new Date().toISOString()
    const { data: b, error } = await sb.from("contas_baixas").insert({
      empresa_id: empresaId, conta_id: conta.id, valor: p.valor, data: hojeBRT(), forma: p.forma ?? null, origem: "whatsapp",
    }).select("id").single()
    if (error) throw error
    antes = { baixa_id: b.id, conta_id: conta.id }
    let proxima = false
    if (conta.recorrencia !== "nenhuma" && conta.grupo_id) {
      // A repetição nasce por gatilho no banco; guarda qual foi pra o DESFAZER apagar junto.
      const { data: prox } = await sb.from("contas_financeiras").select("id").eq("grupo_id", conta.grupo_id)
        .gt("vencimento", conta.vencimento).gte("created_at", inicio).order("vencimento").limit(1).maybeSingle()
      if (prox) { antes = { ...antes, proxima_id: prox.id }; proxima = true }
    }
    const falta = Math.round((restante - Number(p.valor)) * 100) / 100
    ok_ = `✅ ${conta.tipo === "pagar" ? "Pago" : "Recebido"}: *${conta.descricao}* ${brl(Number(p.valor))}${falta > 0.004 ? ` (parcial — ainda falta ${brl(falta)})` : ""}.${proxima ? " A próxima já foi criada." : ""}`
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
  if (a.tipo === "conta_criar") {
    await sb.from("contas_financeiras").delete().eq("id", x.conta_id).eq("empresa_id", empresaId)       // as baixas vão junto
  } else if (a.tipo === "conta_baixar") {
    await sb.from("contas_baixas").delete().eq("id", x.baixa_id).eq("empresa_id", empresaId)            // o gatilho reabre a conta
    if (x.proxima_id) await sb.from("contas_financeiras").delete().eq("id", x.proxima_id).eq("empresa_id", empresaId).eq("valor_pago", 0)
  } else if (a.tipo === "definir_minimo") {
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
const AJUDA_ASSISTENTE = `🤖 *Assistente — o dinheiro da loja*

🧾 *Foto ou PDF da nota*: eu registro a despesa na hora. Se for a prazo (boleto, duplicata), vira *conta a pagar* com o vencimento certo.

💸 *Já paguei*: "paguei 80 de gás" · "paguei 505,60 pra TMC"
📅 *Vou pagar*: "a pagar luz 350 dia 28" · "a pagar internet 119,90 todo mês dia 15"
💰 *Recebi*: "recebi 200 do João"
📆 *Vou receber*: "a receber João 200 dia 30"
✅ *Dar baixa*: "paguei a TMC" (acho a conta em aberto parecida)

🔎 *Consultas* (grátis): "o que está acabando?" · "lista o estoque" · "tem pão?"

📦 *Estoque está pausado por aqui* — lance pelo sistema, em *Catálogo* → *Entrada* / *Baixa*. O dono recebe o aviso no WhatsApp na hora.

💳 *Cada comando gasta 1 crédito* (foto/PDF = 3). *SIM, NÃO, DESFAZER e ajuda são grátis.*
*DESFAZER* tira o último lançamento (até 3 h).`

const AJUDA_ANALISTA = `📊 *Analista — o que eu faço aqui*

*Relatórios*:
• "vendas hoje" · "vendas ontem" · "vendas semana" · "vendas mês" · "vendas mês passado" · "vendas 15/10" · "vendas 01/10 a 15/10"
• "lucro mês" · "mais vendidos mês" · "melhores clientes" · "situação" · "fiado" · "entrega"
• "o que está acabando?" · "lista o estoque" · "tem pão?"
• *Contas*: "contas" · "contas a pagar" · "contas a receber" · "vence hoje" · "contas atrasadas" · "contas da semana"
• *Lançar conta*: "paguei 80 de gás" · "recebi 200 do João" · "a pagar luz 350 dia 28" · "a receber João 200 dia 30"

*Mudanças (eu mostro e espero SIM)*:
• "muda o preço da pizza pra 55"
• "taxa de entrega 6 reais" · "pedido mínimo 20"
• "aumenta a tabela de entrega em 1" · "reduz a tabela de entrega em 1"

💳 *Cada comando gasta 1 crédito. SIM, NÃO, DESFAZER e ajuda são grátis.*
Fale "certinho" do jeito dos exemplos que eu respondo na hora. Dá pra mandar por áudio também.`

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

// Mudanças por frase fixa (sem IA): vira uma proposta; o SIM aplica. Mesmas regras do propor_acao do assistente.
async function propostaFixa(t: string, empresaId: string, jid: string): Promise<{ texto: string; cobrar: boolean } | null> {
  if (t.length > 90) return null
  const R = "(?:r\\$\\s*)?(\\d+(?:[.,]\\d{1,2})?)\\s*(?:reais|real)?"
  const num = (v: string) => Number(v.replace(",", "."))
  const VERBO = "(?:muda|mudar|altera|alterar|troca|trocar|coloca|colocar|atualiza|atualizar|deixa|deixar)"
  let m: RegExpMatchArray | null
  let tipo = "", params: Record<string, unknown> = {}, resumoTxt = ""

  if ((m = t.match(new RegExp(`^${VERBO}\\s+(?:o\\s+)?preco\\s+(?:d[aeo]s?\\s+)?(.+?)\\s+(?:pra|para|por|em|=)\\s+${R}$`)))
    || (m = t.match(new RegExp(`^preco\\s+(?:d[aeo]s?\\s+)?(.+?)\\s+(?:pra|para|por|em|=)?\\s*${R}$`)))) {
    const busca = m[1].trim(), preco = num(m[2])
    if (!(preco > 0)) return null
    const { data: achados } = await sb.from("produtos").select("id, nome, preco_venda").eq("empresa_id", empresaId).eq("ativo", true).is("arquivado_em", null)
      .ilike("nome", `%${busca.replace(/[%_]/g, "")}%`).limit(8)
    if (!achados?.length) return { cobrar: false, texto: `Não achei produto parecido com "${busca}". Confira o nome (ou escreva *lista o estoque*).` }
    const exato = achados.filter((p: any) => norm(p.nome) === norm(busca))
    const alvo = exato.length === 1 ? exato[0] : achados.length === 1 ? achados[0] : null
    if (!alvo) return { cobrar: false, texto: `Achei mais de um: ${achados.map((p: any) => p.nome).join(", ")}. Escreva o nome completo.` }
    tipo = "mudar_preco"
    params = { produto_id: alvo.id, nome: alvo.nome, de: Number(alvo.preco_venda), para: preco }
    resumoTxt = `Mudar o preço de *${alvo.nome}* de ${brl(Number(alvo.preco_venda))} para ${brl(preco)}.`
  } else if ((m = t.match(new RegExp(`^(?:${VERBO}\\s+)?(?:a\\s+)?taxa(?:\\s+de\\s+entrega)?(?:\\s+fixa)?(?:\\s+(?:pra|para|em|=))?\\s+${R}$`)))) {
    const { data: e } = await sb.from("empresas").select("taxa_entrega").eq("id", empresaId).maybeSingle()
    tipo = "taxa_entrega_fixa"; params = { de: Number(e?.taxa_entrega ?? 0), para: num(m[1]) }
    resumoTxt = `Mudar a taxa de entrega fixa de ${brl(Number(e?.taxa_entrega ?? 0))} para ${brl(num(m[1]))}.`
  } else if ((m = t.match(new RegExp(`^(?:${VERBO}\\s+)?(?:o\\s+)?pedido\\s+minimo(?:\\s+(?:pra|para|em|=))?\\s+${R}$`)))) {
    const { data: e } = await sb.from("empresas").select("pedido_minimo").eq("id", empresaId).maybeSingle()
    tipo = "pedido_minimo"; params = { de: Number(e?.pedido_minimo ?? 0), para: num(m[1]) }
    resumoTxt = `Mudar o pedido mínimo de ${brl(Number(e?.pedido_minimo ?? 0))} para ${brl(num(m[1]))}.`
  } else if ((m = t.match(new RegExp(`^(aumenta|aumentar|sobe|subir|reduz|reduzir|diminui|diminuir|baixa|baixar)\\s+(?:a\\s+)?(?:tabela|taxas?)(?:\\s+de\\s+entrega)?(?:\\s+por\\s+km|\\s+km)?\\s+(?:em|de|por)?\\s*${R}$`)))) {
    const { data: e } = await sb.from("empresas").select("taxas_entrega_km").eq("id", empresaId).maybeSingle()
    const tab = Array.isArray(e?.taxas_entrega_km) ? e!.taxas_entrega_km : []
    if (!tab.length) return { cobrar: false, texto: "Esta loja não usa tabela de taxa por km." }
    const delta = /^(reduz|reduzir|diminui|diminuir|baixa|baixar)/.test(m[1]) ? -num(m[2]) : num(m[2])
    if (!delta) return null
    tipo = "ajustar_tabela_km"; params = { delta }
    resumoTxt = `${delta > 0 ? "Aumentar" : "Reduzir"} ${brl(Math.abs(delta))} em todas as faixas de km que cobram taxa (${tab.length} faixas; as grátis continuam grátis).`
  } else {
    return null
  }
  await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente")
  const { error } = await sb.from("assistente_acoes").insert({ empresa_id: empresaId, grupo_jid: jid, tipo, params, resumo: resumoTxt })
  if (error) { console.error("[estoque-wpp] proposta:", error.message); return { cobrar: false, texto: "Não consegui preparar a mudança agora. Tenta de novo em instantes." } }
  return `${resumoTxt}\n\nResponda *SIM* para aplicar ou *NÃO* para cancelar.`
}

// ── Contas a pagar e a receber pelo WhatsApp (frases fixas, sem IA) ─────────
const ddmmBR = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`
const diasEntreYmd = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)
const restanteConta = (c: any) => Math.round((Number(c.valor) - Number(c.valor_pago || 0)) * 100) / 100
const ROTULO_FORMA: Record<string, string> = { pix: "PIX", dinheiro: "dinheiro", credito: "cartão", debito: "débito", boleto: "boleto", transferencia: "transferência", cheque: "cheque" }

function linhaConta(c: any, hoje: string): string {
  const d = diasEntreYmd(hoje, c.vencimento)
  const quando = d < 0 ? `⚠️ venceu há ${-d} ${-d === 1 ? "dia" : "dias"}` : d === 0 ? "vence hoje" : d === 1 ? "vence amanhã" : `em ${d} dias`
  const parcial = Number(c.valor_pago) > 0 ? ` (já ${c.tipo === "pagar" ? "pago" : "recebido"} ${brl(Number(c.valor_pago))})` : ""
  return `• ${ddmmBR(c.vencimento)} ${c.descricao}${c.pessoa ? ` (${c.pessoa})` : ""} — ${brl(restanteConta(c))}${parcial} · ${quando}`
}

async function contasAbertas(empresaId: string, tipo?: "pagar" | "receber") {
  let q = sb.from("contas_financeiras").select("*").eq("empresa_id", empresaId).eq("status", "aberta").order("vencimento").order("created_at").limit(500)
  if (tipo) q = q.eq("tipo", tipo)
  const { data } = await q
  return data ?? []
}

// Palavras que dizem "isso é estoque, não é dinheiro". Com o estoque em pausa
// elas não viram lançamento nenhum, mas também não podem virar despesa: "pão
// mínimo 50" não é uma compra de R$ 50.
const FALA_DE_ESTOQUE = /\b(minimo|minima|contei|contagem|perda|perdi|venceu|vencido|vencida|estragou|estragado|consumo|brinde|bonificacao|devolucao|cadastra|cadastrar|estoque|sobrou|sobra)\b/

// Um gasto escrito do jeito que a pessoa fala: "Compra de verduras 20,00".
// Exige UM valor só na frase: com dois números ("50 pães a 2,00") não dá pra
// saber qual é o total, e chutar aqui vira despesa errada no financeiro.
function lerGastoSolto(textoNorm: string, original: string): { descricao: string; valor: number } | null {
  if (!textoNorm || FALA_DE_ESTOQUE.test(textoNorm)) return null
  // Frase que COMEÇA com verbo de conta é assunto do `lerComandoConta`. Se ele
  // devolveu null, é porque faltou alguma coisa nela — e aí o certo é ele
  // explicar o que falta, não eu inventar uma despesa. Sem esta linha,
  // "a pagar dia 30" virava uma despesa chamada "A pagar dia" de R$ 30,00.
  if (/^(a\s+pagar|a\s+receber|paguei|pagamos|pago|recebi|recebemos|pagar|receber|vou\s+pagar|vou\s+receber)\b/.test(textoNorm)) return null
  const achados = [...textoNorm.matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{1,2}|\d+\.\d{2}|\d+)/g)]
  if (achados.length !== 1) return null
  const cru = achados[0][1]
  const valor = Number(cru.includes(",") ? cru.replace(/\./g, "").replace(",", ".") : cru)
  if (!Number.isFinite(valor) || valor <= 0 || valor > 1_000_000) return null

  // A descrição sai do texto ORIGINAL (com acento e maiúscula), sem o valor.
  const semValor = (original || textoNorm)
    .replace(/r\$\s*/gi, " ")
    .replace(new RegExp(cru.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), " ")
    .replace(/\b(reais|real|conto|pila)\b/gi, " ")
    .replace(/\s+/g, " ").trim().replace(/^[-–—:,.]+|[-–—:,.]+$/g, "").trim()
  const letras = semValor.replace(/[^a-zA-ZÀ-ÿ]/g, "")
  if (letras.length < 3) return null      // só número não diz o que foi
  return { descricao: semValor.charAt(0).toUpperCase() + semValor.slice(1), valor }
}

// A resposta curta que fecha o rascunho: diz SE já pagou e QUANDO.
// Devolve os params prontos, ou null quando não deu pra entender (aí o robô
// pergunta de novo em vez de registrar com data chutada).
function completarRascunho(t: string, params: any, hoje: string): { params?: any; cancelar?: boolean } {
  if (/^(nao|n|cancela|cancelar|deixa|esquece)\W*$/.test(t)) return { cancelar: true }

  // "ontem" e "anteontem" não existem no `extrairData`: ele nasceu pra
  // VENCIMENTO, que é sempre pra frente. Despesa paga é o contrário — o mais
  // comum é a pessoa lançar o gasto de ontem.
  const diasAtras = /\banteontem\b/.test(t) ? 2 : /\bontem\b/.test(t) ? 1 : 0
  const { data: dataLida, resto } = extrairData(t, hoje)
  const data = diasAtras ? somaDiasYmd(hoje, -diasAtras) : dataLida
  const aPagar = /\b(a pagar|vou pagar|ainda nao paguei|nao paguei|pagar depois|vence|vencimento|prazo|boleto)\b/.test(t)
  const jaPagou = /\b(paguei|pago|pagamos|quitei|ja foi|foi pago)\b/.test(t)

  // "a pagar" sem data não dá: conta a pagar sem vencimento nasce invisível.
  if (aPagar && !data) return {}
  if (aPagar) {
    return { params: { ...params, rascunho: false, quitada: false, vencimento: data, forma: null, recorrencia: null } }
  }
  // Já pagou: a data é a do pagamento. "paguei" sozinho = hoje.
  if (jaPagou || data) {
    return { params: { ...params, rascunho: false, quitada: true, vencimento: data ?? hoje, forma: formaDoTexto(resto || t), recorrencia: null } }
  }
  return {}
}

const formaDoTexto = (t: string): string | null => {
  if (/\bpix\b/.test(t)) return "pix"
  if (/\b(dinheiro|especie)\b/.test(t)) return "dinheiro"
  if (/\b(credito|cartao de credito)\b/.test(t)) return "credito"
  if (/\b(debito|cartao de debito)\b/.test(t)) return "debito"
  if (/\bboleto\b/.test(t)) return "boleto"
  if (/\b(transferencia|ted|doc)\b/.test(t)) return "transferencia"
  return null
}

async function comandoContas(t: string, empresaId: string, jid: string, modo: "assistente" | "analista", original = ""): Promise<{ texto: string; cobrar: boolean } | null> {
  const hoje = hojeBRT()
  const limpo = t.replace(/[?!.]+$/g, "").trim()

  // ── Consultas (só no Analista: é número financeiro, não é pra equipe) ──
  if (modo === "analista") {
    const soma = (l: any[]) => l.reduce((x, c) => x + restanteConta(c), 0)
    const lista = (titulo: string, l: any[], vazio: string) => {
      if (!l.length) return { texto: vazio, cobrar: true }
      const linhas = l.slice(0, 20).map((c) => linhaConta(c, hoje))
      return { texto: `${titulo} (${l.length}) — total *${brl(soma(l))}*\n${linhas.join("\n")}${l.length > 20 ? `\n… e mais ${l.length - 20}` : ""}`, cobrar: true }
    }
    if (/^(contas|minhas contas|resumo das contas|resumo de contas)$/.test(limpo)) {
      const ab = await contasAbertas(empresaId)
      const pagar = ab.filter((c) => c.tipo === "pagar"), receber = ab.filter((c) => c.tipo === "receber")
      const venc = (l: any[]) => l.filter((c) => c.vencimento < hoje)
      const em7 = (l: any[]) => l.filter((c) => c.vencimento >= hoje && c.vencimento <= somaDiasBR(hoje, 7))
      return { cobrar: true, texto: [
        "🗓️ *Contas*",
        `A pagar em aberto: *${brl(soma(pagar))}* (${pagar.length})${venc(pagar).length ? ` · ⚠️ atrasadas: ${brl(soma(venc(pagar)))} (${venc(pagar).length})` : ""}`,
        `A receber em aberto: *${brl(soma(receber))}* (${receber.length})${venc(receber).length ? ` · atrasadas: ${brl(soma(venc(receber)))} (${venc(receber).length})` : ""}`,
        `Próximos 7 dias: sai ${brl(soma(em7(pagar)))} · entra ${brl(soma(em7(receber)))}`,
        `\nVeja: "contas a pagar" · "contas a receber" · "vence hoje" · "contas atrasadas" · "contas da semana"`,
      ].join("\n") }
    }
    if (/^(contas? a pagar|a pagar|contas pra pagar|o que (tenho|falta) (pra|para) pagar)$/.test(limpo))
      return lista("💸 *A pagar*", await contasAbertas(empresaId, "pagar"), "Nada a pagar em aberto. 🎉")
    if (/^(contas? a receber|a receber|o que (tenho|falta) (pra|para) receber)$/.test(limpo))
      return lista("💰 *A receber*", await contasAbertas(empresaId, "receber"), "Nada a receber em aberto.")
    if (/^(contas? (vencidas|atrasadas)|vencidas|atrasadas|o que (esta|ta) atrasado)$/.test(limpo))
      return lista("⚠️ *Contas atrasadas*", (await contasAbertas(empresaId)).filter((c) => c.vencimento < hoje), "Nenhuma conta atrasada. 👏")
    if (/^(vence hoje|contas? (de )?hoje|o que vence hoje)$/.test(limpo))
      return lista("📅 *Vencem hoje*", (await contasAbertas(empresaId)).filter((c) => c.vencimento === hoje), "Nada vence hoje.")
    if (/^(contas? (da )?semana|vence (essa|esta) semana|o que vence (essa|esta) semana|proximos 7 dias)$/.test(limpo))
      return lista("📅 *Próximos 7 dias*", (await contasAbertas(empresaId)).filter((c) => c.vencimento >= hoje && c.vencimento <= somaDiasBR(hoje, 7)), "Nada vence nos próximos 7 dias.")
  }

  // ── Gasto escrito solto: "Compra de verduras 20,00", "gás 80" ───────────
  //
  // Sem verbo na frente, `lerComandoConta` devolve null e a frase caía no
  // caminho do estoque — o dono do Agv Grill escreveu "Compra de verduras
  // 20,00" e levou "lançar estoque está pausado". É despesa, não estoque.
  //
  // Aqui NÃO registra: monta o rascunho e PERGUNTA o que falta. Despesa sem
  // data e sem saber se já foi paga entra torta no financeiro, e conta torta é
  // pior que conta faltando — ninguém confere o que parece certo.
  const solto = lerGastoSolto(limpo, original)
  if (solto) {
    await sb.from("assistente_acoes").update({ status: "cancelada" })
      .eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente")
    const { error } = await sb.from("assistente_acoes").insert({
      empresa_id: empresaId, grupo_jid: jid, tipo: "conta_criar",
      params: { rascunho: true, tipo: "pagar", descricao: solto.descricao, valor: solto.valor },
      resumo: `Rascunho: ${solto.descricao} — ${brl(solto.valor)}`,
    })
    if (error) { console.error("[estoque-wpp] rascunho:", error.message); return null }
    return {
      cobrar: true,
      texto: `📝 *${solto.descricao}* — *${brl(solto.valor)}*\n\n` +
        `Falta saber *quando*. Me responde uma dessas:\n` +
        `• *paguei hoje*\n` +
        `• *paguei dia 20* (ou "ontem", "20/10")\n` +
        `• *a pagar dia 30* — se ainda não pagou\n\n` +
        `Ou *NÃO* pra cancelar.`,
    }
  }

  // ── Registrar: "paguei 80 de gás", "a pagar luz 350 dia 28", "recebi 200 do João", "a receber João 200 dia 30" ──
  const cmd = lerComandoConta(limpo, hoje, original)
  if (!cmd) return null
  const tipo: "pagar" | "receber" = cmd.acao === "pagar" || cmd.acao === "paguei" ? "pagar" : "receber"
  const jaAconteceu = cmd.acao === "paguei" || cmd.acao === "recebi"
  const formaTxt = cmd.forma ? ` (${ROTULO_FORMA[cmd.forma] ?? cmd.forma})` : ""

  if (!jaAconteceu && !cmd.vencimento) {
    return { cobrar: false, texto: `Quando vence? Escreva de novo com a data, ex.: "${tipo === "pagar" ? "a pagar" : "a receber"} ${cmd.descricao.toLowerCase()} ${String(cmd.valor).replace(".", ",")} dia 28" (ou "amanhã", "05/11").` }
  }

  let params: Record<string, unknown>, tipoAcao: string, resumoTxt: string
  if (jaAconteceu) {
    // Já pagou/recebeu: acha a conta em aberto parecida pra dar baixa; se não tem, registra uma já quitada.
    const palavras = norm(`${cmd.descricao} ${cmd.pessoa ?? ""}`).split(/\s+/).filter((w) => w.length >= 3 && !["pagamento", "recebimento"].includes(w))
    const abertas = await contasAbertas(empresaId, tipo)
    const parecidas = abertas.filter((c) => palavras.some((w) => norm(`${c.descricao} ${c.pessoa ?? ""}`).includes(w)))
    const exatas = parecidas.filter((c) => Math.abs(restanteConta(c) - cmd.valor) < 0.01)
    let alvo: any = null
    if (exatas.length >= 1) alvo = [...exatas].sort((a, b) => a.vencimento.localeCompare(b.vencimento))[0]
    else if (parecidas.length === 1 && cmd.valor <= restanteConta(parecidas[0]) + 0.004) alvo = parecidas[0]
    else if (parecidas.length > 1) {
      return { cobrar: false, texto: `Achei mais de uma conta parecida:\n${parecidas.slice(0, 6).map((c) => linhaConta(c, hoje)).join("\n")}\n\nEscreva o nome inteiro, ex.: "${cmd.acao} ${String(cmd.valor).replace(".", ",")} ${parecidas[0].descricao.toLowerCase()}".` }
    }
    if (alvo) {
      const falta = Math.round((restanteConta(alvo) - cmd.valor) * 100) / 100
      tipoAcao = "conta_baixar"
      params = { conta_id: alvo.id, descricao: alvo.descricao, valor: cmd.valor, forma: cmd.forma }
      resumoTxt = `Dar baixa em *${alvo.descricao}*${alvo.pessoa ? ` (${alvo.pessoa})` : ""}: ${tipo === "pagar" ? "pagar" : "receber"} *${brl(cmd.valor)}* hoje${formaTxt}.${falta > 0.004 ? `\nFica faltando ${brl(falta)} (baixa parcial).` : ""}`
    } else {
      tipoAcao = "conta_criar"
      params = { tipo, descricao: cmd.descricao, pessoa: cmd.pessoa, categoria: cmd.categoria, valor: cmd.valor, vencimento: hoje, quitada: true, forma: cmd.forma, recorrencia: null }
      resumoTxt = `Registrar ${tipo === "pagar" ? "pagamento" : "recebimento"} já feito: *${cmd.descricao}*${cmd.pessoa ? ` (${cmd.pessoa})` : ""} — *${brl(cmd.valor)}* hoje${formaTxt}${cmd.categoria ? ` · categoria ${cmd.categoria}` : ""}.\n(Não achei conta em aberto parecida.)`
    }
  } else {
    tipoAcao = "conta_criar"
    params = { tipo, descricao: cmd.descricao, pessoa: cmd.pessoa, categoria: cmd.categoria, valor: cmd.valor, vencimento: cmd.vencimento, quitada: false, forma: null, recorrencia: cmd.recorrencia }
    resumoTxt = `Lançar conta *${tipo === "pagar" ? "A PAGAR" : "A RECEBER"}*: *${cmd.descricao}*${cmd.pessoa ? ` (${cmd.pessoa})` : ""} — *${brl(cmd.valor)}*, vence ${ddmmBR(cmd.vencimento!)}${cmd.recorrencia ? ` e repete ${cmd.recorrencia === "mensal" ? "todo mês" : cmd.recorrencia}` : ""}${cmd.categoria ? ` · categoria ${cmd.categoria}` : ""}.`
  }

  await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente")
  const { error } = await sb.from("assistente_acoes").insert({ empresa_id: empresaId, grupo_jid: jid, tipo: tipoAcao, params, resumo: resumoTxt })
  if (error) { console.error("[estoque-wpp] conta:", error.message); return { cobrar: false, texto: "Não consegui preparar agora. Tenta de novo em instantes." } }
  return { cobrar: true, texto: `${resumoTxt}\n\nResponda *SIM* para confirmar ou *NÃO* para cancelar.` }
}
const somaDiasBR = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

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

    // ── Ligar / desligar: quem está no grupo pode ───────────────────────────
    //
    // Antes só ligava quem tivesse telefone cadastrado como da loja (admin,
    // contato, super admin) ou a própria loja (fromMe). A ideia era proteger o
    // financeiro, já que o grupo do Analista responde venda e lucro.
    //
    // Só que a trava protegia pouco e atrapalhava muito:
    //
    // - Ela valia só pra LIGAR. Depois de ligado, qualquer um do grupo já
    //   lançava estoque e perguntava o que quisesse. Meia tranca não é tranca.
    // - Quem está no grupo foi o DONO que colocou. A porta é a entrada no
    //   grupo, não o número de quem digita — e essa porta já é dele.
    // - Negava em SILÊNCIO. O dono do Agv escrevia "ativar assistente" do
    //   celular dele, não acontecia nada, e parecia robô quebrado (23/10/2026).
    //   Erro que não fala é pior do que permissão larga.
    // - Obrigava a cadastrar o telefone de cada dono antes de ele usar o robô,
    //   ou seja: ninguém ativava sem a gente.
    // Dois robôs, um grupo pra cada: "ativar assistente" (estoque e cadastros, gasta créditos) e
    // "ativar analista" (perguntas e decisões do dono, gasta o saldo da IA). "estoque" segue valendo.
    const reAssist = "(assistente|estoque|entrada)"
    const alvo = (verbo: string): "assistente" | "analista" | null =>
      new RegExp(`^(#|\\/)?\\s*${verbo}\\s+(o\\s+)?${reAssist}`).test(t) ? "assistente"
        : new RegExp(`^(#|\\/)?\\s*${verbo}\\s+(o\\s+)?analista`).test(t) ? "analista" : null
    const ligar = alvo("(ativar|ligar)")
    if (ligar) {
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
      await sb.from("whatsapp_config").update(desligar === "assistente" ? { estoque_grupo_jid: null } : { analista_grupo_jid: null })
        .eq("empresa_id", empresaId).eq("instance_name", instance)
      await enviar(instance, jid, `Desligado. Este grupo não é mais o ${desligar === "assistente" ? "Assistente" : "Analista"}.`)
      return ok()
    }

    // Cada COMANDO gasta 1 crédito (R$ 0,07); SIM/NÃO/DESFAZER e "ajuda" são grátis. A resposta fixa não custa nada pra gente.
    const responderComCredito = async (msgs: string[], rotulo: string) => {
      const { data: emp } = await sb.from("empresas").select("whatsapp_creditos").eq("id", empresaId).maybeSingle()
      const saldo = Number(emp?.whatsapp_creditos ?? 0)
      if (saldo < 1) {
        await enviar(instance, jid, "Acabaram os créditos desta loja. Compre créditos no Portal > Automação > WhatsApp pra eu voltar a responder por aqui. (*ajuda*, *SIM*, *NÃO* e *DESFAZER* continuam grátis.)")
        return
      }
      const { data: saldoDepois, error } = await sb.rpc("descontar_creditos_whatsapp", { p_empresa_id: empresaId, p_qtd: 1, p_descricao: `Comando no grupo (${rotulo})` })
      if (error) console.error("[estoque-wpp] credito do comando:", error.message)
      const out = [...msgs]
      const resta = Number(saldoDepois)
      if (!error && resta <= 20) out[out.length - 1] += `\n\n⚠️ Restam *${resta}* créditos. Compre mais no Portal pra não ficar sem.`
      for (const m of out) await enviar(instance, jid, m)
      const { data: adm } = await sb.from("profiles").select("id").eq("empresa_id", empresaId).eq("perfil", "admin").limit(1).maybeSingle()
      if (adm?.id) await sb.from("assistente_conversas").insert({
        empresa_id: empresaId, user_id: adm.id, canal: "whatsapp_comando", modelo: "comando-fixo", pergunta: `[${rotulo}] ${texto.slice(0, 200)}`,
        resposta: msgs.join("\n").slice(0, 2000), custo_usd: 0, custo_brl: 0, creditos_cobrados: 1,
      })
    }

    // "ajuda": mostra as frases certas de cada robô (grátis). A loja falando "certinho" é o que mantém o custo em zero.
    if (/^(ajuda|comandos|menu|help|\?|o que voce faz|como uso)\W*$/.test(t)) {
      await enviar(instance, jid, modo === "analista" ? AJUDA_ANALISTA : AJUDA_ASSISTENTE)
      return ok()
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

    // ── Resposta ao rascunho de despesa ("paguei hoje", "a pagar dia 30") ──
    // O rascunho guarda o que a frase já tinha (descrição e valor) e espera só
    // o que faltava. Completar aqui evita obrigar a pessoa a escrever a frase
    // inteira de novo, que é o que faz ela desistir e deixar de lançar.
    if (pendAcao?.tipo === "conta_criar" && pendAcao?.params?.rascunho) {
      // Primeiro degrau: o papel não trazia o fornecedor. A resposta é o nome
      // dele — não é data nem "paguei", então não pode cair no completar.
      if (pendAcao.params.falta_fornecedor) {
        if (/^(nao|n|cancela|cancelar|deixa|esquece)\W*$/.test(t)) {
          await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("id", pendAcao.id)
          await enviar(instance, jid, "Cancelado. Não registrei nada.")
          return ok()
        }
        const nome = (texto || "").trim().slice(0, 120)
        if (nome.replace(/[^a-zA-ZÀ-ÿ]/g, "").length < 2) {
          await enviar(instance, jid, "Não entendi o nome. Escreve só o nome do fornecedor, ex.: *Mar Vermelho*. Ou *NÃO* pra cancelar.")
          return ok()
        }
        const p2 = {
          ...pendAcao.params, falta_fornecedor: false, pessoa: nome,
          descricao: `Compra — ${nome}`,
        }
        await sb.from("assistente_acoes").update({ params: p2 }).eq("id", pendAcao.id)
        await enviar(instance, jid,
          `🏪 Anotei: *${nome}* — *${brl(Number(p2.valor))}*\n\n` +
          `Agora: já pagou?\n` +
          `• *paguei hoje*\n• *paguei dia 20* (ou "ontem")\n• *a pagar dia 30*\n\n` +
          `Ou *NÃO* pra cancelar.`)
        return ok()
      }
      const r = completarRascunho(t, pendAcao.params, hojeBRT())
      if (r.cancelar) {
        await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("id", pendAcao.id)
        await enviar(instance, jid, "Cancelado. Não registrei nada.")
        return ok()
      }
      if (r.params) {
        await sb.from("assistente_acoes").update({ params: r.params }).eq("id", pendAcao.id)
        try {
          await enviar(instance, jid, await executarAcao(empresaId, { ...pendAcao, params: r.params }))
        } catch (e: any) {
          console.error("[estoque-wpp] rascunho:", e)
          await enviar(instance, jid, "❌ Não consegui registrar agora. Nada foi alterado — tente de novo.")
        }
        return ok()
      }
      // Não entendi a resposta: repete a pergunta em vez de registrar torto.
      await enviar(instance, jid,
        `Ainda falta a data de *${pendAcao.params.descricao}* (${brl(Number(pendAcao.params.valor))}).\n\n` +
        `• *paguei hoje*\n• *paguei dia 20*\n• *a pagar dia 30*\n• ou *NÃO* pra cancelar`)
      return ok()
    }



    // Consultas de estoque ("o que está acabando?", "lista o estoque", "tem pão?"): direto do banco, sem IA e sem cobrar.
    const respEstoque = await comandoEstoque(t, empresaId)
    if (respEstoque) {
      await responderComCredito(respEstoque, "consulta de estoque")
      return ok()
    }
    // Contas a pagar/receber ("paguei 80 de gás", "a pagar luz 350 dia 28", "contas atrasadas").
    const rContas = await comandoContas(t.replace(/[?!.]+$/g, ""), empresaId, jid, modo, texto)
    if (rContas) {
      if (rContas.cobrar) await responderComCredito([rContas.texto], "contas")
      else await enviar(instance, jid, rContas.texto)
      return ok()
    }
    // Relatórios fixos do Analista ("vendas ontem", "lucro mês", "mais vendidos"…): números prontos, sem IA e sem cobrar.
    if (modo === "analista") {
      const respAnalista = await comandoAnalista(t, empresaId)
      if (respAnalista) {
        await responderComCredito(respAnalista, "relatório")
        return ok()
      }
    }

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
      let porAudio = false
      if (tipoMsgA === "audioMessage") {
        porAudio = true
        const midia = await baixarMidia(instance, msg)
        const falado = midia ? await transcrever(midia.base64, midia.mimetype) : null
        if (!falado) { await enviar(instance, jid, "Não consegui ouvir o áudio. Escreve ou manda de novo?"); return ok() }
        pergunta = falado
        whisperUsd = ((msg.message?.audioMessage?.seconds ?? 30) / 60) * PRECO_WHISPER_MIN
      }
      // Papo solto ("valeu", "bom dia") não vale uma chamada cara à IA.
      const tp = norm(pergunta).replace(/[?!.,]+$/g, "").trim()
      if (tp.length < 5 || /^(oi+|ola|bom dia|boa tarde|boa noite|valeu|obrigad[oa]|blz|beleza|tmj|show|top|ok|kk+|rs+)\W*$/.test(tp)) return ok()

      // Texto já passou pelos comandos lá em cima; o ÁUDIO só virou texto agora, então roda os mesmos aqui.
      if (porAudio) {
        const rc = (await comandoEstoque(tp, empresaId)) ?? (await comandoAnalista(tp, empresaId))
        if (rc) { await responderComCredito(rc, "áudio"); return ok() }
        const rcc = await comandoContas(tp, empresaId, jid, "analista", pergunta)
        if (rcc) { if (rcc.cobrar) await responderComCredito([rcc.texto], "áudio"); else await enviar(instance, jid, rcc.texto); return ok() }
      }
      const fixa = await propostaFixa(tp, empresaId, jid)
      if (fixa) {
        if (fixa.cobrar) await responderComCredito([fixa.texto], "mudança")
        else await enviar(instance, jid, fixa.texto)        // não preparou nada: não cobra
        return ok()
      }
      if (!ANALISTA_IA_LIGADA) {
        await enviar(instance, jid, "Não entendi 🤔 Escreva *ajuda* pra ver as frases que eu conheço (é grátis). Fale do jeito dos exemplos que eu respondo na hora.")
        return ok()
      }

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
      // A despesa da nota vai junto: desfazer o estoque e deixar a conta de pé
      // deixaria o financeiro com uma compra que não existe mais. As baixas
      // saem primeiro porque apontam pra conta.
      if (ult.conta_id) {
        await sb.from("contas_baixas").delete().eq("conta_id", ult.conta_id).eq("empresa_id", empresaId)
        await sb.from("contas_financeiras").delete().eq("id", ult.conta_id).eq("empresa_id", empresaId)
      }
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

    // A palavra que destrava a nota repetida. Só serve pra isso: escrever
    // REPETIR sem nada esperando não faz nada, e numa lista normal não aparece.
    if (/^repetir\W*$/.test(t)) {
      if (!pend) { await enviar(instance, jid, await nadaPraConfirmar(empresaId, jid)); return ok() }
      if (!pend.nota?.repetida_de) {
        await enviar(instance, jid, "Essa lista não é repetida — responda *SIM* pra lançar.")
        return ok()
      }
      pend.nota = { ...pend.nota, repetida_de: null }
      await sb.from("estoque_whatsapp").update({ nota: pend.nota }).eq("id", pend.id)
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
      if (!pend) { await enviar(instance, jid, await nadaPraConfirmar(empresaId, jid)); return ok() }

      // NOTA REPETIDA: SIM NÃO BASTA (23/10/2026)
      //
      // O aviso de "essa nota parece repetida" já estava no ar quando a nota do
      // Agv Grill entrou em dobro — estoque e despesa, R$ 245,60 duas vezes.
      // Quem acha que a primeira não pegou responde SIM no automático, sem ler
      // o aviso. Pedir OUTRA palavra obriga a parar e decidir.
      if (pend.nota?.repetida_de) {
        const hora = new Date(pend.nota.repetida_de).toLocaleTimeString("pt-BR", {
          timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit",
        })
        await enviar(instance, jid,
          `🚨 Não lancei: *essa nota já entrou hoje às ${hora}* (${pend.nota.fornecedor} — ${brl(pend.nota.valor_total)}).\n\n` +
          `Confira no Portal: *Financeiro › Contas a pagar e receber*, filtro *Quitadas*.\n\n` +
          `Se ela chegou DUAS vezes de verdade e você quer lançar em dobro, responda *REPETIR*. Senão, responda *NÃO*.`)
        return ok()
      }

      // COMPROVANTE DE PIX NÃO TEM ITEM — E ISSO É NORMAL (23/10/2026)
      //
      // A instrução que o robô recebe já diz: "Comprovante de pagamento SEM
      // itens (PIX, maquininha) é válido". Ele lia o comprovante do Agv Grill
      // certinho (VHB Frios, R$ 245,60, pago em PIX), mostrava a despesa e
      // pedia o SIM — e aqui o SIM jogava tudo no lixo por "não tem item",
      // sem nem olhar a nota. A despesa nunca chegava no financeiro.
      const temDespesa = !!String(pend.nota?.fornecedor ?? "").trim()
        && Number(pend.nota?.valor_total) > 0
      if (!temDespesa && !(pend.itens ?? []).length && !(pend.nao_achados ?? []).length) {
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
      if (!pend) { await enviar(instance, jid, await nadaPraConfirmar(empresaId, jid)); return ok() }
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
    let resultado: { itens: Item[]; naoAchados: NaoAchado[]; ignorar?: boolean; pergunta?: boolean; corrige?: boolean; produtosNovos?: ProdutoNovo[]; minimos?: MinimoSolto[]; aviso?: string | null; custoUsd: number; nota?: NotaLida } | null = null
    let origem = "texto"
    let textoFalado = ""

    if (ehImagem || ehPdf) {
      origem = ehPdf ? "pdf" : "foto"
      const midia = await baixarMidia(instance, msg)
      if (!midia) { await enviar(instance, jid, "Não consegui baixar a foto. Manda de novo?"); return ok() }
      if (ehImagem && midia.mimetype === "image/webp") { await enviar(instance, jid, "Esse formato de imagem eu não leio. Manda como foto normal."); return ok() }
      const r = await lerNota(midia.base64, midia.mimetype, cat, empresaId)
      if ("erro" in r) { await enviar(instance, jid, `Não consegui ler a nota: ${r.erro}`); return ok() }
      resultado = r
    } else if (ehAudio) {
      origem = "audio"
      const midia = await baixarMidia(instance, msg)
      const falado = midia ? await transcrever(midia.base64, midia.mimetype) : null
      if (!falado) { await enviar(instance, jid, "Não consegui ouvir o áudio. Escreve ou manda de novo?"); return ok() }
      const rcA = await comandoEstoque(norm(falado).replace(/[?!.,]+$/g, "").trim(), empresaId)
      if (rcA) { await responderComCredito(rcA, "áudio"); return ok() }
      const rcC = await comandoContas(norm(falado).replace(/[?!.,]+$/g, "").trim(), empresaId, jid, "assistente", falado)
      if (rcC) { if (rcC.cobrar) await responderComCredito([rcC.texto], "áudio"); else await enviar(instance, jid, rcC.texto); return ok() }
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

    // ═══ ESTOQUE EM PAUSA: A NOTA VIRA SÓ DINHEIRO (23/10/2026) ═══
    // Foto/PDF: registra a despesa na hora. Fornecedor e total vêm impressos
    // no documento — não são chute da IA — então não há o que confirmar, e foi
    // a espera pelo SIM que fez a loja mandar a mesma nota duas vezes.
    if (!ESTOQUE_PELO_ROBO && (origem === "foto" || origem === "pdf")) {
      const n = resultado.nota
      if (!n?.fornecedor || !(Number(n.valor_total) > 0)) {
        const avisoC = await cobrarUso("(não achei fornecedor e total)")
        await enviar(instance, jid,
          "Li o documento, mas não achei o *fornecedor* e o *valor total* juntos — sem os dois eu não registro, pra não entrar despesa errada.\n\n" +
          "Manda uma foto mais nítida, ou me escreve: *\"paguei 505,60 pra TMC\"* (ou *\"a pagar TMC 505,60 dia 30\"*)." + avisoC)
        return ok()
      }
      const cartao = await contaDaNota(empresaId, jid, n, origem)
      const avisoC = await cobrarUso(cartao)
      await enviar(instance, jid, cartao + avisoC)
      return ok()
    }
    // Texto/áudio de estoque: o lugar disso agora é o sistema, que já avisa o
    // dono no WhatsApp a cada entrada e baixa. Não cobra crédito: não preparou
    // nada, e cobrar por "não faço mais isso" seria roubo.
    if (!ESTOQUE_PELO_ROBO && (resultado.itens.length || resultado.naoAchados.length
        || resultado.produtosNovos?.length || resultado.minimos?.length)) {
      await enviar(instance, jid,
        "📦 Lançar estoque por aqui está *pausado*.\n\n" +
        "Faça pelo sistema: *Catálogo* → botão *Entrada* ou *Baixa* no item. " +
        "O dono recebe um aviso no WhatsApp na hora, com quem lançou, a quantidade e quanto ficou.\n\n" +
        "Aqui comigo o que vale agora é *dinheiro*: me manda a *foto da nota* ou escreve " +
        "*\"paguei 80 de gás\"*, *\"a pagar luz 350 dia 28\"*, *\"recebi 200 do João\"*.")
      return ok()
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
    if (!resultado.itens.length && !resultado.naoAchados.length && !resultado.nota) {
      if (origem === "texto") return ok()
      await enviar(instance, jid, "Não achei nenhum item nessa " + (origem === "audio" ? "fala" : "nota") + ".")
      return ok()
    }
    // Comprovante de PIX ou de maquininha não tem item nenhum, e mesmo assim é
    // dinheiro que saiu: segue adiante e vira só a despesa.

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
      // Correção de um lançamento anterior não repete a despesa: a nota é a
      // mesma, e lançar de novo dobraria a saída no financeiro.
      // `repetida_de` viaja junto pra o SIM saber que esta aqui precisa de uma
      // confirmação mais forte (não dá pra confiar só no aviso da mensagem).
      nota: substitui ? null : (repetidaDe ? { ...resultado.nota, repetida_de: repetidaDe } : resultado.nota),
    })
    const aviso = resultado.aviso ? `\n\n⚠️ ${resultado.aviso}` : ""
    const nota = substitui ? null : resultado.nota

    // ESSA NOTA JÁ ENTROU? (23/10/2026)
    //
    // O Agv Grill mandou o mesmo comprovante duas vezes — achou que a primeira
    // não tinha pego (estava só esperando o SIM). Um SIM na segunda dobraria
    // tudo: estoque e despesa. Mandar a nota de novo é erro fácil de cometer e
    // caro de descobrir, porque some no meio do estoque.
    //
    // Mesmo fornecedor + mesmo total + mesma data já é a mesma nota na prática.
    // O aviso NÃO bloqueia: duas compras iguais no mesmo dia existem, e quem
    // sabe o que está fazendo responde SIM do mesmo jeito. Só não deixa passar
    // sem o lojista ver.
    let avisoRepetida = ""
    let repetidaDe: string | null = null
    if (nota?.fornecedor && Number(nota?.valor_total) > 0) {
      const { data: iguais } = await sb.from("estoque_whatsapp")
        .select("lancado_em, nota")
        .eq("empresa_id", empresaId).eq("status", "lancado")
        .gte("lancado_em", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
        .order("lancado_em", { ascending: false }).limit(40)
      const igual = (iguais ?? []).find((x: any) =>
        String(x.nota?.fornecedor ?? "") === String(nota.fornecedor) &&
        Number(x.nota?.valor_total) === Number(nota.valor_total) &&
        String(x.nota?.data ?? "") === String(nota.data ?? ""))
      if (igual) {
        repetidaDe = String(igual.lancado_em)
        const hora = new Date(igual.lancado_em as string).toLocaleTimeString("pt-BR", {
          timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit",
        })
        // SIM não serve aqui. Um aviso já esteve no ar e a nota do Agv Grill
        // duplicou assim mesmo: quem acha que "não entrou" responde SIM no
        // automático, sem ler. Exigir outra palavra obriga a parar e decidir.
        avisoRepetida = `\n\n🚨 *ESSA NOTA JÁ ENTROU.*\n*${nota.fornecedor}* — ${brl(nota.valor_total)}, lançada hoje às ${hora}.\n\nSe você mandou de novo achando que não tinha entrado: *ela entrou*, pode conferir no Portal (Financeiro › Contas, filtro *Quitadas*).\nSIM aqui *não vai funcionar*. Só lanço em dobro se você responder *REPETIR*.`
      }
    }

    const textoResumo = resumo(resultado.itens, resultado.naoAchados, !!substitui, infoResumo, nota) + aviso + avisoRepetida +
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
