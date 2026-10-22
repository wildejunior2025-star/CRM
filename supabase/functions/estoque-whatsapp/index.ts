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

type Item = { tipo: "produto" | "materia"; id: string; nome: string; quantidade: number; custo_unit: number | null }
type NaoAchado = { nome: string; quantidade: number; custo_unit: number | null; unidade?: string }

// Haiku 4.5 (US$ por milhão de tokens) e Whisper (US$ por minuto) — pra cobrar o uso real.
const PRECO_HAIKU = { entrada: 1, saida: 5 }
const PRECO_WHISPER_MIN = 0.006
const usd = (u: { entrada: number; saida: number }) => (u.entrada * PRECO_HAIKU.entrada + u.saida * PRECO_HAIKU.saida) / 1_000_000

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
const qtdTxt = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",")
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()

async function enviar(instance: string, jid: string, texto: string) {
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
): Promise<{ itens: Item[]; naoAchados: NaoAchado[]; ignorar: boolean; pergunta: boolean; corrige: boolean; produtosNovos: { nome: string; preco_venda: number | null; preco_custo: number | null; categoria: string }[]; custoUsd: number } | null> {
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
    '  "produtos_novos": [ { "nome": string, "preco_venda": number|null, "preco_custo": number|null, "categoria": string|null } ],',
    '  "itens": [ { "indice": number, "quantidade": number, "custo_unit": number|null, "custo_total": number|null } ],',
    '  "nao_encontrados": [ { "nome": string, "unidade": "kg"|"g"|"L"|"ml"|"un", "quantidade": number, "custo_unit": number|null, "custo_total": number|null } ] }',
    "",
    "Regras:",
    "- 'ignorar' = true quando a mensagem NÃO é sobre uma compra/entrada de mercadoria (papo, pergunta, cumprimento).",
    "  Nesse caso devolva itens e nao_encontrados vazios.",
    "- 'pergunta' = true quando (e só quando) a pessoa PEDE uma informação, análise ou ajuda sobre a loja ou o sistema,",
    "  ou pede pro robô FAZER algo na loja que NÃO seja estoque nem cadastro de produto novo (ex.: 'quanto vendi hoje',",
    "  'o que tá acabando', 'faz um diagnóstico', 'muda o preço da pizza', 'aumenta a taxa de entrega'). Cumprimento e papo = false.",
    "- 'produtos_novos' = pedido de CADASTRAR um produto de venda novo no cardápio ('cadastra o produto Coca 2L por 12 reais').",
    "  Isso NÃO é pergunta (pergunta=false). Preencha nome, preco_venda (null se não disse) e categoria se disse. Não confunda com",
    "  insumo/matéria-prima comprada, que vai em itens/nao_encontrados.",
    "- ENTRADA DE ESTOQUE tem prioridade sobre 'pergunta': qualquer pedido de criar/cadastrar matéria-prima ou insumo,",
    "  de lançar/dar entrada/adicionar/colocar quantidade no estoque ('crie matéria prima pães e lance 120 no estoque',",
    "  'coloca 50 hambúrguer no estoque', 'comecei com 30 kg de carne') é ENTRADA: devolva em itens/nao_encontrados,",
    "  mesmo sem preço (custo null), e pergunta=false. Quando o item não está no catálogo, vai em nao_encontrados",
    "  (será criado como insumo). Só use pergunta=true se o pedido NÃO envolver colocar quantidade no estoque.",
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
        ? "- A LISTA ABAIXO JÁ FOI LANÇADA no estoque há pouco. Se a mensagem CORRIGE ou COMPLETA esses mesmos itens (ex.: 'faltou o preço', 'eram 40 e não 50', 'o pão custa 1,30'), corrige=true e devolva a lista COMPLETA já corrigida. Se for uma compra NOVA e diferente, corrige=false e devolva SÓ os itens novos. Papo sem relação: ignorar=true."
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
    itens.push({ tipo: c.tipo, id: c.id, nome: c.nome, quantidade: Math.round(q * 1000) / 1000, custo_unit: unit(x, q) })
  }
  const naoAchados: NaoAchado[] = []
  for (const x of parsed.nao_encontrados ?? []) {
    const q = num(x?.quantidade) ?? 1
    const nome = String(x?.nome ?? "").trim().slice(0, 80)
    const un = ["kg", "g", "L", "ml", "un"].includes(String(x?.unidade)) ? String(x.unidade) : "un"
    if (nome) naoAchados.push({ nome, quantidade: q, custo_unit: unit(x, q), unidade: un })
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
        categoria: String(x?.categoria ?? "").trim().slice(0, 40),
      })).filter((x: any) => x.nome),
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

function resumo(itens: Item[], naoAchados: NaoAchado[], corrige = false): string {
  let total = 0, temPreco = false
  const linhas = itens.map((i) => {
    let s = `• ${i.nome} × ${qtdTxt(i.quantidade)}`
    if (i.custo_unit) { const v = i.custo_unit * i.quantidade; total += v; temPreco = true; s += ` — ${brl(i.custo_unit)} un (${brl(v)})` }
    return s
  })
  const partes: string[] = []
  if (linhas.length) partes.push(`${corrige ? "Corrigindo o último lançamento — vai ficar assim:" : "Entendi esta compra:"}\n${linhas.join("\n")}`)
  if (temPreco) partes.push(`Total: ${brl(total)}`)
  if (naoAchados.length) {
    partes.push(`🆕 Não existem no cadastro — vou CRIAR como insumo:\n${naoAchados.map((n) => `• ${n.nome} × ${qtdTxt(n.quantidade)} ${n.unidade ?? "un"}${n.custo_unit ? ` — ${brl(n.custo_unit)}` : ""}`).join("\n")}`)
  }
  const semPreco = [...itens, ...naoAchados].filter((x) => x.custo_unit == null).map((x) => x.nome)
  if (semPreco.length) {
    // Entrada sem preço deixa o custo e o lucro às cegas: só lança com o preço (ou com um "sem preço" explícito).
    partes.push(`❓ *Falta o preço (por unidade)* de: ${semPreco.join(", ")}.\nMe diga o valor, ex.: "${semPreco[0]} 1,30". Só lanço com o preço.\n(Se não souber, responda *SEM PREÇO*. Ou *NÃO* para cancelar.)`)
  } else {
    partes.push(`${corrige ? "Responda *SIM* para trocar o lançamento anterior por este" : "Responda *SIM* para lançar"}, *NÃO* para cancelar, ou escreva a correção (ex.: "o pão foram 40").`)
  }
  return partes.join("\n\n")
}

async function lancar(empresaId: string, pend: any): Promise<string> {
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
        .insert({ empresa_id: empresaId, nome: n.nome, unidade: n.unidade || "un", custo: n.custo_unit ?? 0 })
        .select("id").single()
      if (error) throw error
      id = nova.id; criados.push(n.nome)
    }
    itens.push({ tipo: "materia", id: id!, nome: n.nome, quantidade: n.quantidade, custo_unit: n.custo_unit })
  }
  const prod = itens.filter((i) => i.tipo === "produto")
  const mat = itens.filter((i) => i.tipo === "materia")
  const linha = (i: Item) => ({
    tipo: "entrada", quantidade: i.quantidade, custo_unit: i.custo_unit || null,   // 0 = "sem preço" confirmado
    valor_total: i.custo_unit ? Math.round(i.custo_unit * i.quantidade * 100) / 100 : null,
  })
  let idsP: string[] = [], idsM: string[] = []
  if (prod.length) {
    const { data, error } = await sb.from("estoque_movimentos").insert(prod.map((i) => ({
      empresa_id: empresaId, produto_id: i.id, motivo: "compra", observacao: "Entrada pelo WhatsApp", ...linha(i),
    }))).select("id")
    if (error) throw error
    idsP = (data ?? []).map((x: any) => x.id)
  }
  if (mat.length) {
    const { data, error } = await sb.from("materia_prima_movimentos").insert(mat.map((i) => ({
      empresa_id: empresaId, materia_prima_id: i.id, observacao: "Entrada pelo WhatsApp", ...linha(i),
    }))).select("id")
    if (error) {
      if (idsP.length) await sb.from("estoque_movimentos").delete().in("id", idsP)   // não deixa lançar metade
      throw error
    }
    idsM = (data ?? []).map((x: any) => x.id)
  }
  // Igual à tela: quem acabou de pagar sabe o preço de hoje, então atualiza o custo do cadastro.
  for (const i of itens) {
    if (!i.custo_unit) continue
    if (i.tipo === "produto") await sb.from("produtos").update({ preco_custo: i.custo_unit }).eq("id", i.id)
    else await sb.from("materias_primas").update({ custo: i.custo_unit }).eq("id", i.id)
  }
  await sb.from("estoque_whatsapp").update({
    status: "lancado", lancado_em: new Date().toISOString(), mov_produtos: idsP, mov_materias: idsM,
  }).eq("id", pend.id)
  const novos = criados.length ? `\n🆕 Cadastrei como insumo: ${criados.join(", ")}.` : ""
  return `✅ Lancei ${itens.length} ${itens.length === 1 ? "item" : "itens"} no estoque.${novos}\nSe foi engano, responda *DESFAZER*.`
}

// Aplica uma proposta do assistente (depois do SIM). Guarda em `antes` o que precisa pro DESFAZER.
async function executarAcao(empresaId: string, a: any): Promise<string> {
  const p = a.params ?? {}
  let antes: Record<string, unknown> = {}
  let ok_ = ""
  if (a.tipo === "cadastrar_produto") {
    const { data, error } = await sb.from("produtos").insert({
      empresa_id: empresaId, nome: p.nome, categoria: p.categoria || "outros",
      preco_venda: p.preco_venda, preco_custo: p.preco_custo ?? 0,
    }).select("id").single()
    if (error) throw error
    antes = { produto_id: data.id }
    ok_ = `✅ Produto *${p.nome}* cadastrado por ${brl(Number(p.preco_venda))}. Falta só a foto — coloque pelo Portal em Catálogo.`
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
  if (a.tipo === "cadastrar_produto") {
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

function textoDaMensagem(m: any): string {
  const x = m?.message ?? {}
  return String(
    x.conversation ?? x.extendedTextMessage?.text ?? x.imageMessage?.caption ?? x.documentMessage?.caption
      ?? x.documentWithCaptionMessage?.message?.documentMessage?.caption ?? "",
  ).trim()
}

serve(async (req) => {
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

    // ── Pendente / último lançamento ────────────────────────────────────────
    const desde = new Date(Date.now() - VALIDADE_PENDENTE_MIN * 60000).toISOString()
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
          await enviar(instance, jid, "❌ Não consegui aplicar agora (erro no sistema). Nada foi alterado — tente de novo em instantes.")
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
        await enviar(instance, jid, "❌ Não consegui lançar agora (erro no sistema). Nada foi gravado — tente de novo em instantes.")
      }
    }
    const faltaPreco = (p: any) => [...(p.itens ?? []), ...(p.nao_achados ?? [])].filter((x: any) => x.custo_unit == null)

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
          await enviar(instance, jid, "❌ Não consegui aplicar agora (erro no sistema). Nada foi alterado — tente de novo em instantes.")
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
      await enviar(instance, jid, `↩️ Desfeito. Tirei as entradas do estoque (os insumos novos continuam cadastrados).\n(O custo que atualizei no cadastro não volta sozinho — confira se precisar.)`)
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
    let resultado: { itens: Item[]; naoAchados: NaoAchado[]; ignorar?: boolean; pergunta?: boolean; corrige?: boolean; produtosNovos?: { nome: string; preco_venda: number | null; preco_custo: number | null; categoria: string }[]; aviso?: string | null; custoUsd: number } | null = null
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
      const resumoCad = `Cadastrar produto *${pn.nome}* por ${brl(pn.preco_venda)} na categoria ${categoria}${pn.preco_custo ? ` (custo ${brl(pn.preco_custo)})` : ""}${existentes.includes(categoria) ? "" : " — categoria nova"}.`
      await sb.from("assistente_acoes").update({ status: "cancelada" }).eq("empresa_id", empresaId).eq("grupo_jid", jid).eq("status", "pendente")
      await sb.from("assistente_acoes").insert({
        empresa_id: empresaId, grupo_jid: jid, tipo: "cadastrar_produto", resumo: resumoCad,
        params: { nome: pn.nome, preco_venda: pn.preco_venda, categoria, preco_custo: pn.preco_custo },
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

    // Lista nova substitui a que estava esperando.
    if (pend) await sb.from("estoque_whatsapp").update({ status: "cancelado" }).eq("id", pend.id)
    // Corrige um lançamento já feito? A lista nova guarda qual substitui (o SIM troca um pelo outro).
    const substitui = pend?.substitui_id ?? (resultado.corrige && ultLancado ? ultLancado.id : null)
    await sb.from("estoque_whatsapp").insert({
      empresa_id: empresaId, grupo_jid: jid, status: "pendente", origem,
      itens: resultado.itens, nao_achados: resultado.naoAchados, substitui_id: substitui,
    })
    const aviso = resultado.aviso ? `\n\n⚠️ ${resultado.aviso}` : ""
    const textoResumo = resumo(resultado.itens, resultado.naoAchados, !!substitui) + aviso
    const avisoCred = await cobrarUso(textoResumo)
    await enviar(instance, jid, textoResumo + avisoCred)
    return ok()
  } catch (e) {
    console.error("[estoque-wpp] erro:", e)
    return ok()
  }
})
