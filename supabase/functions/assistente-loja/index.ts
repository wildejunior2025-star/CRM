// Assistente da loja — o botao flutuante do sistema (o dono pergunta e a IA
// responde OLHANDO OS DADOS DELE).
//
// Diferenca pra `ajuda-ia` (a da landing): aquela e publica e so sabe explicar o
// sistema. Esta exige login e responde "quanto vendi hoje", "qual foi o lucro de
// ontem", "quem mais comprou esse mes" — indo no banco na hora.
//
// COMO A IA VE OS DADOS: ela NAO escreve SQL. Ela escolhe entre 5 consultas
// prontas (as tools abaixo) e recebe o resultado ja somado. Assim nao tem como
// pedir uma tabela que nao devia, nem inventar um numero: o que ela nao pediu,
// ela nao tem.
//
// SEGURANCA (o ponto mais importante deste arquivo):
//   - exige o token do usuario logado; sem token, 401;
//   - so perfil `admin` (o dono/gerente) — vendedor e garcom nao veem o caixa;
//   - as consultas usam a chave ANON com o token DELE, entao a RLS do banco
//     continua valendo: mesmo com um bug aqui, a loja so alcanca a propria loja.
//     Nunca troque por SERVICE_ROLE — isso desligaria a RLS e uma loja poderia
//     ler o faturamento da outra.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { MANUAL } from "./manual.ts"

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? ""
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY") ?? ""
// Usada SÓ pra gravar a conversa no histórico. A loja não tem permissão de
// inserir lá (de propósito: senão ela poderia forjar o próprio histórico).
// Nenhuma consulta de dado da loja passa por aqui — essas usam o token do
// usuário, com a RLS ligada.
const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const MODELO = "claude-opus-5"
// Preço por 1 milhão de tokens (USD). Serve pra gravar quanto custou cada
// pergunta — com um mês disso dá pra decidir trocar de modelo com número na
// mão, em vez de no chute. Mudou o modelo? Mude aqui junto.
const PRECO = { entrada: 5, cacheGravar: 6.25, cacheLer: 0.5, saida: 25 }

const MAX_PERGUNTA  = 500
const MAX_HISTORICO = 10
const MAX_VOLTAS    = 6     // idas e voltas de ferramenta numa pergunta so
const LIMITE_JANELA = 20    // perguntas...
const JANELA_MIN    = 10    // ...a cada 10 minutos, por usuario
const OFFSET_BRT    = 3     // Brasilia = UTC-3

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } })

// ── datas em horario de Brasilia ─────────────────────────────────────────────
const ehData = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)
const iniISO = (dia: string) => new Date(`${dia}T00:00:00-03:00`).toISOString()
const fimISO = (dia: string) => {
  const d = new Date(`${dia}T00:00:00-03:00`)
  d.setUTCDate(d.getUTCDate() + 1)                       // fim exclusivo
  return d.toISOString()
}
const diaBRT = (ts: string) =>
  new Date(new Date(ts).getTime() - OFFSET_BRT * 3600_000).toISOString().slice(0, 10)
const hojeBRT = () => diaBRT(new Date().toISOString())
const somaDias = (dia: string, n: number) => {
  const d = new Date(`${dia}T00:00:00-03:00`)
  d.setUTCDate(d.getUTCDate() + n)
  return diaBRT(d.toISOString())
}
const dias = (ini: string, fim: string) => {
  const saida: string[] = []
  for (let d = ini; d <= fim && saida.length < 400; d = somaDias(d, 1)) saida.push(d)
  return saida
}
const brl = (v: number) => Number(v || 0).toFixed(2)

// Limite por usuario, em memoria. Reinicia junto com a function — segura abuso
// casual sem precisar de tabela nova.
const usos = new Map<string, number[]>()
function passouDoLimite(chave: string): boolean {
  const agora = Date.now()
  const lista = (usos.get(chave) ?? []).filter(t => t > agora - JANELA_MIN * 60_000)
  lista.push(agora)
  usos.set(chave, lista)
  if (usos.size > 5000) usos.clear()
  return lista.length > LIMITE_JANELA
}

// O PostgREST corta em 1000 linhas. Loja movimentada perde venda silenciosamente
// sem paginar — e a IA responderia um faturamento MENOR que o real.
const PAGINA = 1000
async function todos(monta: (de: number, ate: number) => any): Promise<any[]> {
  const saida: any[] = []
  for (let de = 0; de < 20_000; de += PAGINA) {
    const { data, error } = await monta(de, de + PAGINA - 1)
    if (error) throw new Error(error.message)
    saida.push(...(data ?? []))
    if (!data || data.length < PAGINA) break
  }
  return saida
}

const pedidoVale = (status: string) => !["cancelado", "aguardando_pagamento"].includes(status)
const CANAL: Record<string, string> = {
  app: "App do cliente", whatsapp: "WhatsApp", cardapio: "Loja online", ifood: "iFood",
}
const canalDoPedido = (origem: string) => CANAL[origem] ?? "Balcao"

// ── as consultas que a IA pode pedir ────────────────────────────────────────
const TOOLS: any[] = [
  {
    name: "consultar_vendas",
    description:
      "Quanto a loja vendeu num periodo: faturamento, quantidade de pedidos, ticket medio, " +
      "quebra por canal (balcao, salao, app, WhatsApp, loja online, iFood), por forma de " +
      "pagamento e o total de cada dia. Use para 'quanto vendi hoje', 'quanto foi o " +
      "faturamento da semana', 'vendi mais no iFood ou no balcao', 'qual foi meu melhor dia'.",
    input_schema: {
      type: "object",
      properties: {
        data_inicio: { type: "string", description: "Primeiro dia, AAAA-MM-DD (inclusive)." },
        data_fim:    { type: "string", description: "Ultimo dia, AAAA-MM-DD (inclusive)." },
      },
      required: ["data_inicio", "data_fim"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "consultar_lucro",
    description:
      "Lucro e custos dos dias JA FECHADOS pelo dono em Financeiro > Despesas & Lucro " +
      "(receita liquida, custo fixo, funcionarios, producao, imprevistos, cashback e lucro). " +
      "Dia que ainda nao foi fechado nao tem lucro gravado e vem na lista 'dias_nao_fechados'. " +
      "Use para 'qual foi o lucro de ontem', 'quanto lucrei esse mes', 'fechamento do dia'.",
    input_schema: {
      type: "object",
      properties: {
        data_inicio: { type: "string", description: "Primeiro dia, AAAA-MM-DD (inclusive)." },
        data_fim:    { type: "string", description: "Ultimo dia, AAAA-MM-DD (inclusive)." },
      },
      required: ["data_inicio", "data_fim"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "top_produtos",
    description:
      "Produtos mais vendidos no periodo, por valor vendido e quantidade. Junta o que saiu " +
      "no balcao/salao com o que saiu no delivery. Use para 'o que mais vende', 'meu carro-chefe'.",
    input_schema: {
      type: "object",
      properties: {
        data_inicio: { type: "string", description: "Primeiro dia, AAAA-MM-DD (inclusive)." },
        data_fim:    { type: "string", description: "Ultimo dia, AAAA-MM-DD (inclusive)." },
        limite:      { type: "integer", description: "Quantos produtos trazer (1 a 20)." },
      },
      required: ["data_inicio", "data_fim", "limite"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "top_clientes",
    description:
      "Clientes que mais compraram no periodo, por valor gasto e numero de pedidos. Venda sem " +
      "cliente identificado fica de fora. Use para 'quem mais compra', 'melhores clientes'.",
    input_schema: {
      type: "object",
      properties: {
        data_inicio: { type: "string", description: "Primeiro dia, AAAA-MM-DD (inclusive)." },
        data_fim:    { type: "string", description: "Ultimo dia, AAAA-MM-DD (inclusive)." },
        limite:      { type: "integer", description: "Quantos clientes trazer (1 a 20)." },
      },
      required: ["data_inicio", "data_fim", "limite"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "situacao_agora",
    description:
      "Foto da loja neste momento: pedidos de hoje por status, faturamento do mes contra a " +
      "meta, produtos abaixo do estoque minimo, total em fiado e a configuracao da loja " +
      "(delivery ligado, Mercado Pago conectado, iFood conectado). Use para 'como esta a loja', " +
      "'to batendo a meta', 'o que esta acabando', 'meu Mercado Pago esta conectado'.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
]

// ── execucao das consultas ──────────────────────────────────────────────────
async function rodarTool(sb: any, empresaId: string, nome: string, arg: any) {
  const ini = ehData(arg?.data_inicio) ? arg.data_inicio : hojeBRT()
  const fimBruto = ehData(arg?.data_fim) ? arg.data_fim : ini
  const fim = fimBruto < ini ? ini : fimBruto
  const limite = Math.min(20, Math.max(1, Number(arg?.limite) || 5))
  const de = iniISO(ini), ate = fimISO(fim)

  if (nome === "consultar_vendas") return await consultarVendas(sb, ini, fim, de, ate)
  if (nome === "consultar_lucro")  return await consultarLucro(sb, empresaId, ini, fim, de, ate)
  if (nome === "top_produtos")     return await topProdutos(sb, ini, fim, de, ate, limite)
  if (nome === "top_clientes")     return await topClientes(sb, ini, fim, de, ate, limite)
  if (nome === "situacao_agora")   return await situacaoAgora(sb, empresaId)
  if (nome === "consultar_estoque")   return await consultarEstoque(sb, String(arg?.busca ?? ""))
  if (nome === "analisar_cardapio")   return await analisarCardapio(sb)
  if (nome === "analisar_financeiro") return await analisarFinanceiro(sb, empresaId)
  if (nome === "ver_entrega")         return await verEntrega(sb, empresaId)
  return { erro: "Consulta desconhecida." }
}

// Por que os pagamentos entram aqui
// -------------------------------
// `vendas.forma_pagamento` não guarda COMO o cliente pagou: no salão ele grava
// "a_vista" pra tudo que não é fiado. PIX, dinheiro, débito e crédito viram a
// mesma palavra. Por isso o assistente respondia "não sei" quando perguntavam
// quanto entrou no PIX — e não era falta de dado, era o lugar errado.
//
// A forma de verdade mora em `pagamentos`, uma linha por forma. Conta dividida
// (metade PIX, metade dinheiro) vira duas linhas ali, o que a coluna da venda
// nunca conseguiria representar.
async function carregarVendasEPedidos(sb: any, de: string, ate: string) {
  const [vendas, pedidos, pagamentos] = await Promise.all([
    todos((a, b) => sb.from("vendas")
      .select("id, total, created_at, forma_pagamento, observacoes")
      .neq("status", "cancelado").gte("created_at", de).lt("created_at", ate)
      .order("created_at").range(a, b)),
    todos((a, b) => sb.from("pedidos_delivery")
      .select("total, created_at, forma_pagamento, pagamentos, origem, status")
      .gte("created_at", de).lt("created_at", ate)
      .order("created_at").range(a, b)),
    todos((a, b) => sb.from("pagamentos")
      .select("venda_id, valor, forma_pagamento, created_at")
      .gte("created_at", de).lt("created_at", ate)
      .order("created_at").range(a, b)),
  ])
  return { vendas, pedidos: pedidos.filter((p: any) => pedidoVale(p.status)), pagamentos }
}

async function consultarVendas(sb: any, ini: string, fim: string, de: string, ate: string) {
  const { vendas, pedidos, pagamentos } = await carregarVendasEPedidos(sb, de, ate)

  // Pagamento com venda_id: é o "como pagou" daquela venda.
  // Pagamento SEM venda_id: é cliente quitando fiado antigo — dinheiro que
  // entrou no caixa hoje, mas de uma venda de outro dia. Somar junto inflaria
  // o faturamento do período com venda que já foi contada lá atrás.
  const pagPorVenda: Record<string, { forma: string; valor: number }[]> = {}
  const fiadoRecebido: Record<string, number> = {}
  for (const p of (pagamentos ?? [])) {
    const forma = String(p.forma_pagamento || "nao informado")
    const valor = Number(p.valor) || 0
    if (p.venda_id) (pagPorVenda[p.venda_id] ??= []).push({ forma, valor })
    else fiadoRecebido[forma] = (fiadoRecebido[forma] ?? 0) + valor
  }

  let faturamento = 0, qtd = 0
  const canal: Record<string, number> = {}
  const forma: Record<string, number> = {}
  const porDia: Record<string, { total: number; pedidos: number }> = {}
  for (const d of dias(ini, fim)) porDia[d] = { total: 0, pedidos: 0 }

  // `linhas` é como o valor se reparte entre as formas. Uma só na maioria dos
  // casos; duas ou mais quando a conta foi dividida.
  const somar = (ts: string, valor: number, ch: string, fp: string,
                 linhas?: { forma: string; valor: number }[]) => {
    faturamento += valor; qtd++
    canal[ch] = (canal[ch] ?? 0) + valor
    if (linhas?.length) {
      for (const l of linhas) forma[l.forma] = (forma[l.forma] ?? 0) + l.valor
    } else {
      const k = fp || "nao informado"
      forma[k] = (forma[k] ?? 0) + valor
    }
    const d = porDia[diaBRT(ts)]
    if (d) { d.total += valor; d.pedidos++ }
  }
  for (const v of vendas) {
    // Venda de mesa/comanda nasce com observacoes comecando em "Presencial" —
    // e o unico jeito de separar salao de balcao (as duas viram linha em `vendas`).
    const ch = String(v.observacoes || "").startsWith("Presencial") ? "Salao (mesa)" : "Balcao"
    // Fiado fica como fiado: ainda não entrou dinheiro nenhum. Quando o cliente
    // pagar, aparece em recebido_de_fiado, na forma em que ele pagou.
    const linhas = v.forma_pagamento === "fiado" ? undefined : pagPorVenda[v.id]
    somar(v.created_at, Number(v.total), ch, v.forma_pagamento, linhas)
  }
  // Pedido pago em duas formas (mig 0274): cada parte soma na sua forma.
  for (const p of pedidos) {
    const partes = Array.isArray(p.pagamentos) && p.pagamentos.length > 1
      ? p.pagamentos.map((x: { forma: string; valor: number }) => ({ forma: String(x.forma), valor: Number(x.valor) || 0 }))
      : undefined
    somar(p.created_at, Number(p.total), canalDoPedido(p.origem), p.forma_pagamento, partes)
  }

  const ordena = (o: Record<string, number>) =>
    Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ nome: k, valor: brl(v) }))

  const lista = dias(ini, fim)
  return {
    periodo: { de: ini, ate: fim },
    faturamento: brl(faturamento),
    pedidos: qtd,
    ticket_medio: brl(qtd ? faturamento / qtd : 0),
    por_canal: ordena(canal),
    por_forma_pagamento: ordena(forma),
    // Dinheiro que entrou no caixa no período mas NÃO é venda do período: é
    // cliente quitando fiado antigo. Fica separado de propósito — somar junto
    // contaria a mesma venda duas vezes.
    recebido_de_fiado: ordena(fiadoRecebido),
    nota_formas: "por_forma_pagamento e o que foi VENDIDO no periodo, ja separado por PIX, dinheiro, debito e credito. Venda no fiado aparece como fiado ate o cliente pagar. recebido_de_fiado e divida antiga quitada agora: e dinheiro que entrou, mas nao e venda deste periodo.",
    // Periodo longo demais viraria uma lista gigantesca dentro do prompt sem
    // ajudar a responder — acima de 62 dias so o total interessa.
    por_dia: lista.length <= 62
      ? lista.map(d => ({ dia: d, total: brl(porDia[d].total), pedidos: porDia[d].pedidos }))
      : "periodo longo demais para detalhar dia a dia",
  }
}

async function consultarLucro(sb: any, empresaId: string, ini: string, fim: string, de: string, ate: string) {
  const { data: hist, error } = await sb.from("historico_dia")
    .select("data, receita_liquida, custo_fixo, custo_funcionarios, custo_producao, custo_imprevisto, custo_cashback, lucro")
    .eq("empresa_id", empresaId).gte("data", ini).lte("data", fim).order("data")
  if (error) throw new Error(error.message)

  const fechados = hist ?? []
  const soma = (campo: string) => fechados.reduce((s: number, h: any) => s + Number(h[campo] || 0), 0)
  const naoFechados = dias(ini, fim).filter(d => !fechados.some((h: any) => h.data === d))

  // Dia sem fechamento nao tem lucro gravado — mas o dono ainda quer saber o
  // que entrou. Sem isso a IA responderia so "nao sei", que nao ajuda ninguem.
  let faturamentoNaoFechado = null
  if (naoFechados.length) {
    const { vendas, pedidos } = await carregarVendasEPedidos(sb, de, ate)
    const total = [...vendas, ...pedidos]
      .filter((r: any) => naoFechados.includes(diaBRT(r.created_at)))
      .reduce((s: number, r: any) => s + Number(r.total || 0), 0)
    faturamentoNaoFechado = brl(total)
  }

  return {
    periodo: { de: ini, ate: fim },
    dias_fechados: fechados.map((h: any) => ({
      dia: h.data,
      receita: brl(Number(h.receita_liquida)),
      custo_fixo: brl(Number(h.custo_fixo)),
      custo_funcionarios: brl(Number(h.custo_funcionarios)),
      custo_producao: brl(Number(h.custo_producao)),
      custo_imprevisto: brl(Number(h.custo_imprevisto)),
      custo_cashback: brl(Number(h.custo_cashback)),
      lucro: brl(Number(h.lucro)),
    })),
    totais_dos_dias_fechados: {
      receita: brl(soma("receita_liquida")),
      custos: brl(soma("custo_fixo") + soma("custo_funcionarios") + soma("custo_producao") +
                  soma("custo_imprevisto") + soma("custo_cashback")),
      lucro: brl(soma("lucro")),
    },
    dias_nao_fechados: naoFechados,
    faturamento_dos_dias_nao_fechados: faturamentoNaoFechado,
    observacao: naoFechados.length
      ? "Estes dias ainda nao foram fechados em Financeiro > Despesas & Lucro, entao NAO existe lucro calculado para eles — so o faturamento."
      : "Todos os dias do periodo estao fechados.",
  }
}

async function topProdutos(sb: any, ini: string, fim: string, de: string, ate: string, limite: number) {
  const [itens, pedidos, produtos] = await Promise.all([
    todos((a, b) => sb.from("venda_itens")
      .select("produto_id, quantidade, subtotal, vendas!inner(created_at, status)")
      .neq("vendas.status", "cancelado")
      .gte("vendas.created_at", de).lt("vendas.created_at", ate)
      .order("id").range(a, b)),
    todos((a, b) => sb.from("pedidos_delivery")
      .select("itens, status, created_at")
      .gte("created_at", de).lt("created_at", ate).order("created_at").range(a, b)),
    todos((a, b) => sb.from("produtos").select("id, nome").order("id").range(a, b)),
  ])
  const nome: Record<string, string> = {}
  for (const p of produtos) nome[p.id] = p.nome

  const agg: Record<string, { valor: number; qtd: number }> = {}
  const add = (n: string, valor: number, qtd: number) => {
    const k = n || "Produto"
    agg[k] ??= { valor: 0, qtd: 0 }
    agg[k].valor += valor; agg[k].qtd += qtd
  }
  for (const it of itens) add(nome[it.produto_id], Number(it.subtotal || 0), Number(it.quantidade || 0))
  for (const p of pedidos) {
    if (!pedidoVale(p.status)) continue
    for (const it of (Array.isArray(p.itens) ? p.itens : [])) {
      const qtd = Number(it?.quantidade || 1)
      add(it?.nome, Number(it?.subtotal ?? (Number(it?.preco_unitario || 0) * qtd)), qtd)
    }
  }
  return {
    periodo: { de: ini, ate: fim },
    produtos: Object.entries(agg)
      .sort((a, b) => b[1].valor - a[1].valor).slice(0, limite)
      .map(([n, v]) => ({ produto: n, valor_vendido: brl(v.valor), quantidade: v.qtd })),
  }
}

async function topClientes(sb: any, ini: string, fim: string, de: string, ate: string, limite: number) {
  const [vendas, pedidos] = await Promise.all([
    todos((a, b) => sb.from("vendas")
      .select("total, cliente_id, clientes(nome)")
      .neq("status", "cancelado").gte("created_at", de).lt("created_at", ate)
      .order("created_at").range(a, b)),
    todos((a, b) => sb.from("pedidos_delivery")
      .select("total, status, cliente_nome")
      .gte("created_at", de).lt("created_at", ate).order("created_at").range(a, b)),
  ])
  const agg: Record<string, { valor: number; pedidos: number }> = {}
  const add = (n: string | null | undefined, valor: number) => {
    const k = String(n || "").trim()
    // Venda sem cliente vira "Consumidor" e ganharia de todo mundo — o ranking
    // so serve pra decidir alguma coisa se for gente de verdade.
    if (!k || ["consumidor", "consumidor (mesa)", "cliente"].includes(k.toLowerCase())) return
    agg[k] ??= { valor: 0, pedidos: 0 }
    agg[k].valor += valor; agg[k].pedidos++
  }
  for (const v of vendas) add(v.clientes?.nome, Number(v.total))
  for (const p of pedidos) { if (pedidoVale(p.status)) add(p.cliente_nome, Number(p.total)) }

  return {
    periodo: { de: ini, ate: fim },
    clientes: Object.entries(agg)
      .sort((a, b) => b[1].valor - a[1].valor).slice(0, limite)
      .map(([n, v]) => ({ cliente: n, gastou: brl(v.valor), pedidos: v.pedidos })),
  }
}

async function situacaoAgora(sb: any, empresaId: string) {
  const hoje = hojeBRT()
  const mesIni = hoje.slice(0, 8) + "01"
  const [pedidosHoje, estoque, fiado, empRes, ifoodRes, mes] = await Promise.all([
    todos((a, b) => sb.from("pedidos_delivery").select("status, total, origem")
      .gte("created_at", iniISO(hoje)).lt("created_at", fimISO(hoje)).order("created_at").range(a, b)),
    sb.from("estoque_saldo").select("nome, quantidade_atual, estoque_minimo, controla_estoque"),
    // A view só traz cliente_id e saldo — o nome não interessa aqui, o que o
    // dono quer saber é quanto tem na rua e quanta gente está devendo.
    sb.from("clientes_saldo_fiado").select("saldo_fiado"),
    sb.from("empresas")
      .select("nome, delivery_ativo, mp_conectado, meta_faturamento_mensal, slug")
      .eq("id", empresaId).maybeSingle(),
    sb.from("ifood_config").select("ativo").eq("empresa_id", empresaId).eq("ativo", true).limit(1),
    consultarVendas(sb, mesIni, hoje, iniISO(mesIni), fimISO(hoje)),
  ])

  const porStatus: Record<string, number> = {}
  for (const p of pedidosHoje) porStatus[p.status] = (porStatus[p.status] ?? 0) + 1

  // Produto sem minimo definido NAO e "estoque baixo" — senao a loja que nunca
  // mexeu no estoque veria o catalogo inteiro como alerta.
  const baixos = (estoque.data ?? [])
    .filter((s: any) => s.controla_estoque !== false &&
      Number(s.estoque_minimo) > 0 && Number(s.quantidade_atual) <= Number(s.estoque_minimo))
    .map((s: any) => ({ produto: s.nome, tem: Number(s.quantidade_atual), minimo: Number(s.estoque_minimo) }))

  const devedores = (fiado.data ?? []).filter((f: any) => Number(f.saldo_fiado) > 0)
  const totalFiado = devedores.reduce((s: number, f: any) => s + Number(f.saldo_fiado), 0)
  const meta = Number(empRes.data?.meta_faturamento_mensal || 0)
  const fatMes = Number(mes.faturamento)

  return {
    hoje,
    pedidos_de_hoje: { total: pedidosHoje.length, por_status: porStatus },
    faturamento_do_mes: brl(fatMes),
    meta_do_mes: meta > 0 ? brl(meta) : "nao definida",
    falta_para_a_meta: meta > 0 ? brl(Math.max(0, meta - fatMes)) : null,
    estoque_baixo: { quantidade: baixos.length, itens: baixos.slice(0, 15) },
    fiado: { total_em_aberto: brl(totalFiado), clientes_devendo: devedores.length },
    configuracao: {
      loja: empRes.data?.nome ?? null,
      delivery_ligado: empRes.data?.delivery_ativo !== false,
      mercado_pago_conectado: empRes.data?.mp_conectado === true,
      ifood_conectado: (ifoodRes.data ?? []).length > 0,
      endereco_da_loja_online: empRes.data?.slug ? `lojaonline.fwcinter.com/${empRes.data.slug}` : null,
    },
  }
}

// ── análise: cardápio, financeiro, entrega (só leitura) ─────────────────────
const SEM_ARGS = { type: "object", properties: {}, required: [], additionalProperties: false }
TOOLS.push(
  {
    name: "analisar_cardapio",
    description:
      "Raio-X do cardapio dos ultimos 30 dias: produtos sem foto, sem descricao, com preco zerado, sem custo " +
      "(lucro as cegas), margem baixa, duplicados, sem nenhuma venda e o que mais vende. Use para 'analisa meu " +
      "cardapio', 'o que ta errado nos meus produtos', 'o que tirar do cardapio', e dentro de um diagnostico.",
    input_schema: SEM_ARGS, strict: true,
  },
  {
    name: "analisar_financeiro",
    description:
      "Financeiro dos ultimos 30 dias contra os 30 anteriores: faturamento, ticket medio, canais, formas de " +
      "pagamento, lucro dos dias fechados, taxas da maquininha e fiado. Use para 'como ta meu financeiro', " +
      "'to ganhando ou perdendo', 'meu faturamento caiu?', e dentro de um diagnostico.",
    input_schema: SEM_ARGS, strict: true,
  },
  {
    name: "ver_entrega",
    description:
      "Taxa de entrega: configuracao atual (taxa fixa, tabela por km, bairros, pedido minimo, tempos) e o que " +
      "aconteceu nos ultimos 30 dias — quanto foi cobrado do cliente, quanto foi pago ao entregador e o saldo, por " +
      "bairro. Use para 'minha taxa de entrega ta boa', 'to perdendo dinheiro na entrega', e dentro de um diagnostico.",
    input_schema: SEM_ARGS, strict: true,
  },
)

TOOLS.push({
  name: "consultar_estoque",
  description:
    "Quanto tem em estoque de cada item, PRODUTOS do catalogo e INSUMOS (materia-prima). Sem busca, traz o " +
    "resumo e os itens com menos saldo; com busca, traz os itens cujo nome contem o texto. Use para 'tem pao " +
    "cadastrado?', 'quanto tenho de hamburguer', 'o que ta zerado', 'valor parado em estoque'.",
  input_schema: {
    type: "object",
    properties: { busca: { type: "string", description: "Parte do nome do item; vazio para o resumo geral." } },
    required: ["busca"], additionalProperties: false,
  },
  strict: true,
})

async function consultarEstoque(sb: any, busca: string) {
  const termo = normNome(busca)
  const [prod, mat] = await Promise.all([
    todos((a, b) => sb.from("estoque_saldo").select("nome, categoria, quantidade_atual, estoque_minimo, controla_estoque").order("nome").range(a, b)),
    todos((a, b) => sb.from("materia_prima_saldo").select("nome, unidade, custo, quantidade_atual").order("nome").range(a, b)),
  ])
  const p = prod.map((x: any) => ({ tipo: "produto", nome: x.nome, tem: Number(x.quantidade_atual), minimo: Number(x.estoque_minimo), controla: x.controla_estoque !== false }))
  const m = mat.map((x: any) => ({ tipo: "insumo", nome: x.nome, unidade: x.unidade, tem: Number(x.quantidade_atual), valor_parado: brl(Number(x.quantidade_atual) * Number(x.custo || 0)) }))
  if (termo) {
    const achados = [...p, ...m].filter((i: any) => normNome(i.nome).includes(termo))
    return { busca, encontrados: achados.slice(0, 30), total_encontrado: achados.length,
             nota: achados.length ? undefined : "Nenhum produto nem insumo tem esse nome no cadastro." }
  }
  const comEstoque = p.filter((i: any) => i.controla)
  return {
    produtos_cadastrados: p.length, insumos_cadastrados: m.length,
    produtos_zerados_ou_negativos: comEstoque.filter((i: any) => i.tem <= 0).length,
    menores_saldos_produtos: [...comEstoque].sort((a: any, b: any) => a.tem - b.tem).slice(0, 12),
    menores_saldos_insumos: [...m].sort((a: any, b: any) => a.tem - b.tem).slice(0, 12),
    valor_parado_em_insumos: brl(m.reduce((s: number, i: any) => s + Number(i.valor_parado.replace(/[^0-9.]/g, "") || 0), 0)),
  }
}

// Propostas de escrita — SÓ no WhatsApp. Gravam um pedido pendente; quem aplica é o SIM do dono.
const TOOL_PROPOR_ACAO = {
  name: "propor_acao",
  description:
    "Prepara uma MUDANCA na loja para o dono confirmar com SIM. Voce NAO executa nada: so propoe. Tipos: " +
    "cadastrar_produto (nome, preco_venda, categoria opcional, preco_custo opcional), mudar_preco (produto, preco_venda), " +
    "taxa_entrega_fixa (valor), pedido_minimo (valor), ajustar_tabela_km (valor = quanto somar, negativo reduz, em todas " +
    "as faixas de km que cobram taxa). Depois de chamar, mostre o resumo ao dono e diga que ele confirma com *SIM* " +
    "(ou *NAO* para cancelar). So proponha quando o dono PEDIR a mudanca.",
  input_schema: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: ["cadastrar_produto", "mudar_preco", "taxa_entrega_fixa", "pedido_minimo", "ajustar_tabela_km"] },
      nome: { type: "string", description: "cadastrar_produto: nome do produto novo." },
      produto: { type: "string", description: "mudar_preco: nome (ou parte) do produto existente." },
      preco_venda: { type: "number", description: "Preco de venda em reais." },
      preco_custo: { type: "number", description: "Custo em reais, se o dono disse." },
      categoria: { type: "string", description: "Categoria do produto novo, se o dono disse." },
      valor: { type: "number", description: "Valor em reais (taxa, pedido minimo ou ajuste)." },
    },
    required: ["tipo"],
  },
}

const normNome = (t: string) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
const reais = (v: number) => "R$ " + Number(v).toFixed(2).replace(".", ",")
const pct = (v: number) => Math.round(v * 10) / 10

async function analisarCardapio(sb: any) {
  const hoje = hojeBRT(), ini = somaDias(hoje, -29)
  const [produtos, vendidos] = await Promise.all([
    todos((a, b) => sb.from("produtos")
      .select("id, nome, categoria, preco_custo, preco_venda, foto_url, descricao")
      .eq("ativo", true).is("arquivado_em", null).order("id").range(a, b)),
    topProdutos(sb, ini, hoje, iniISO(ini), fimISO(hoje), 20_000),
  ])
  const vendeu = new Set(vendidos.produtos.map((p: any) => normNome(p.produto)))
  const nomes = (l: any[], n = 15) => l.slice(0, n).map((p: any) => p.nome)

  const semFoto = produtos.filter((p: any) => !p.foto_url)
  const semDesc = produtos.filter((p: any) => !String(p.descricao ?? "").trim())
  const precoZero = produtos.filter((p: any) => !(Number(p.preco_venda) > 0))
  const semCusto = produtos.filter((p: any) => !(Number(p.preco_custo) > 0) && Number(p.preco_venda) > 0)
  const margens = produtos
    .filter((p: any) => Number(p.preco_custo) > 0 && Number(p.preco_venda) > 0)
    .map((p: any) => ({ nome: p.nome, margem_pct: pct((1 - Number(p.preco_custo) / Number(p.preco_venda)) * 100) }))
    .sort((a: any, b: any) => a.margem_pct - b.margem_pct)
  const porNome: Record<string, number> = {}
  for (const p of produtos) { const k = normNome(p.nome); porNome[k] = (porNome[k] ?? 0) + 1 }
  const porCat: Record<string, number> = {}
  for (const p of produtos) porCat[p.categoria || "sem categoria"] = (porCat[p.categoria || "sem categoria"] ?? 0) + 1
  const semVenda = produtos.filter((p: any) => !vendeu.has(normNome(p.nome)))

  return {
    periodo_vendas: { de: ini, ate: hoje },
    produtos_ativos: produtos.length,
    categorias: Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c, n]) => ({ categoria: c, produtos: n })),
    sem_foto: { quantidade: semFoto.length, exemplos: nomes(semFoto) },
    sem_descricao: { quantidade: semDesc.length },
    preco_de_venda_zerado: { quantidade: precoZero.length, exemplos: nomes(precoZero) },
    sem_custo_cadastrado: { quantidade: semCusto.length, exemplos: nomes(semCusto, 10), efeito: "sem custo o lucro desse produto nao e calculado" },
    margem_mais_baixa: margens.slice(0, 10),
    margem_media_pct: margens.length ? pct(margens.reduce((s: number, m: any) => s + m.margem_pct, 0) / margens.length) : null,
    nomes_duplicados: Object.entries(porNome).filter(([, n]) => n > 1).map(([k, n]) => ({ nome: k, vezes: n })).slice(0, 15),
    sem_nenhuma_venda_30d: { quantidade: semVenda.length, exemplos: nomes(semVenda, 20) },
    mais_vendidos_30d: vendidos.produtos.slice(0, 8),
  }
}

async function analisarFinanceiro(sb: any, empresaId: string) {
  const hoje = hojeBRT(), ini = somaDias(hoje, -29), iniAnt = somaDias(hoje, -59), fimAnt = somaDias(hoje, -30)
  const [atual, anterior, lucro, emp, fiado] = await Promise.all([
    consultarVendas(sb, ini, hoje, iniISO(ini), fimISO(hoje)),
    consultarVendas(sb, iniAnt, fimAnt, iniISO(iniAnt), fimISO(fimAnt)),
    consultarLucro(sb, empresaId, ini, hoje, iniISO(ini), fimISO(hoje)),
    sb.from("empresas").select("taxa_cartao_pct, taxa_credito_pct, taxa_debito_pct, meta_faturamento_mensal").eq("id", empresaId).maybeSingle(),
    sb.from("clientes_saldo_fiado").select("saldo_fiado"),
  ])
  const { por_dia: _a, ...a } = atual as any
  const { por_dia: _b, ...b } = anterior as any
  const fa = Number(a.faturamento), fb = Number(b.faturamento)
  const devedores = (fiado.data ?? []).filter((f: any) => Number(f.saldo_fiado) > 0)
  return {
    ultimos_30_dias: { de: ini, ate: hoje, ...a },
    trinta_dias_anteriores: { de: iniAnt, ate: fimAnt, faturamento: b.faturamento, pedidos: b.pedidos, ticket_medio: b.ticket_medio },
    variacao_faturamento_pct: fb > 0 ? pct(((fa - fb) / fb) * 100) : null,
    lucro_dos_dias_fechados: lucro.totais_dos_dias_fechados,
    dias_fechados: (lucro.dias_fechados as any[]).length,
    dias_nao_fechados: (lucro.dias_nao_fechados as any[]).length,
    taxas_maquininha_pct: { cartao: emp.data?.taxa_cartao_pct, credito: emp.data?.taxa_credito_pct, debito: emp.data?.taxa_debito_pct },
    meta_mensal: Number(emp.data?.meta_faturamento_mensal || 0) > 0 ? brl(Number(emp.data.meta_faturamento_mensal)) : "nao definida",
    fiado_em_aberto: brl(devedores.reduce((s: number, f: any) => s + Number(f.saldo_fiado), 0)),
    clientes_devendo: devedores.length,
  }
}

async function verEntrega(sb: any, empresaId: string) {
  const hoje = hojeBRT(), ini = somaDias(hoje, -29)
  const [empRes, pedidos] = await Promise.all([
    sb.from("empresas").select("aceita_entrega, aceita_retirada, taxa_entrega, pedido_minimo, raio_entrega_km, tempo_entrega_min, tempo_entrega_max, taxas_entrega_km, taxas_entrega_bairro")
      .eq("id", empresaId).maybeSingle(),
    todos((a, b) => sb.from("pedidos_delivery")
      .select("tipo_entrega, taxa_entrega, valor_entregador, endereco_bairro, status, total")
      .gte("created_at", iniISO(ini)).lt("created_at", fimISO(hoje)).order("created_at").range(a, b)),
  ])
  const e = empRes.data ?? {}
  const validos = pedidos.filter((p: any) => pedidoVale(p.status))
  const porTipo: Record<string, number> = {}
  for (const p of validos) porTipo[p.tipo_entrega || "nao informado"] = (porTipo[p.tipo_entrega || "nao informado"] ?? 0) + 1
  const comTaxa = validos.filter((p: any) => Number(p.taxa_entrega) > 0 || Number(p.valor_entregador) > 0)
  const cobrado = comTaxa.reduce((s: number, p: any) => s + Number(p.taxa_entrega || 0), 0)
  const pago = comTaxa.reduce((s: number, p: any) => s + Number(p.valor_entregador || 0), 0)
  const bairros: Record<string, { n: number; cobrado: number; pago: number }> = {}
  for (const p of comTaxa) {
    const k = String(p.endereco_bairro || "sem bairro").trim()
    bairros[k] ??= { n: 0, cobrado: 0, pago: 0 }
    bairros[k].n++; bairros[k].cobrado += Number(p.taxa_entrega || 0); bairros[k].pago += Number(p.valor_entregador || 0)
  }
  const tabelaKm = Array.isArray(e.taxas_entrega_km) ? e.taxas_entrega_km : []
  return {
    configuracao: {
      entrega_ligada: e.aceita_entrega !== false, retirada_ligada: e.aceita_retirada !== false,
      taxa_fixa: brl(Number(e.taxa_entrega || 0)), pedido_minimo: brl(Number(e.pedido_minimo || 0)),
      raio_km: e.raio_entrega_km, tempo_min: `${e.tempo_entrega_min}-${e.tempo_entrega_max} min`,
      tabela_por_km: tabelaKm.length ? tabelaKm.map((f: any) => ({ ate_km: f.km, taxa: brl(Number(f.taxa)) })) : "nao usa",
      taxas_por_bairro: Array.isArray(e.taxas_entrega_bairro) && e.taxas_entrega_bairro.length ? e.taxas_entrega_bairro : "nao usa",
    },
    ultimos_30_dias: {
      pedidos: validos.length, por_tipo: porTipo,
      entregas_com_taxa_ou_entregador: comTaxa.length,
      taxa_cobrada_dos_clientes: brl(cobrado), pago_aos_entregadores: brl(pago),
      saldo_da_entrega: brl(cobrado - pago),
      taxa_media_cobrada: brl(comTaxa.length ? cobrado / comTaxa.length : 0),
      custo_medio_entregador: brl(comTaxa.length ? pago / comTaxa.length : 0),
      bairros_que_mais_pedem: Object.entries(bairros).sort((a, b) => b[1].n - a[1].n).slice(0, 8)
        .map(([k, v]) => ({ bairro: k, entregas: v.n, taxa_media: brl(v.cobrado / v.n), entregador_medio: brl(v.pago / v.n) })),
    },
    nota: "Se pago_aos_entregadores for 0, a loja provavelmente nao registra o valor do entregador nos pedidos — o saldo nao e confiavel.",
  }
}

// Registra a PROPOSTA (nada muda na loja ainda). O SIM do dono, no grupo, é quem aplica.
async function proporAcao(sb: any, admin: any, empresaId: string, grupoJid: string, a: any) {
  const tipo = String(a?.tipo ?? "")
  let params: Record<string, unknown> = {}
  let resumo = ""
  if (tipo === "cadastrar_produto") {
    const nome = String(a?.nome ?? "").trim().slice(0, 80), preco = Number(a?.preco_venda)
    if (!nome || !(preco > 0)) return { erro: "Preciso do nome e do preco de venda do produto novo." }
    const { data: ja } = await sb.from("produtos").select("id, nome").eq("ativo", true).is("arquivado_em", null).ilike("nome", nome.replace(/[%_]/g, "")).limit(1)
    if (ja?.length) return { erro: `Ja existe um produto chamado "${ja[0].nome}". Quer mudar o preco dele?` }
    const { data: cats } = await sb.from("produtos").select("categoria").eq("ativo", true).limit(500)
    const existentes = [...new Set((cats ?? []).map((c: any) => String(c.categoria)))] as string[]
    const pedida = String(a?.categoria ?? "").trim()
    const categoria = existentes.find((c) => normNome(c) === normNome(pedida)) ?? (pedida || "outros")
    const custo = Number(a?.preco_custo) > 0 ? Number(a.preco_custo) : null
    params = { nome, preco_venda: preco, categoria, preco_custo: custo }
    resumo = `Cadastrar produto *${nome}* por ${reais(preco)} na categoria ${categoria}${custo ? ` (custo ${reais(custo)})` : ""}${existentes.includes(categoria) ? "" : " — categoria nova"}.`
  } else if (tipo === "mudar_preco") {
    const busca = String(a?.produto ?? "").trim(), preco = Number(a?.preco_venda)
    if (!busca || !(preco > 0)) return { erro: "Preciso do nome do produto e do preco novo." }
    const { data: achados } = await sb.from("produtos").select("id, nome, preco_venda")
      .eq("ativo", true).is("arquivado_em", null).ilike("nome", `%${busca.replace(/[%_]/g, "")}%`).limit(8)
    const exato = (achados ?? []).filter((p: any) => normNome(p.nome) === normNome(busca))
    const alvo = exato.length === 1 ? exato[0] : (achados?.length === 1 ? achados[0] : null)
    if (!achados?.length) return { erro: `Nao achei produto parecido com "${busca}".` }
    if (!alvo) return { erro: `Achei mais de um: ${achados.map((p: any) => p.nome).join(", ")}. Pergunte qual deles.` }
    params = { produto_id: alvo.id, nome: alvo.nome, de: Number(alvo.preco_venda), para: preco }
    resumo = `Mudar o preço de *${alvo.nome}* de ${reais(Number(alvo.preco_venda))} para ${reais(preco)}.`
  } else if (tipo === "taxa_entrega_fixa" || tipo === "pedido_minimo") {
    const v = Number(a?.valor)
    if (!(v >= 0) || a?.valor == null) return { erro: "Preciso do valor em reais." }
    const campo = tipo === "taxa_entrega_fixa" ? "taxa_entrega" : "pedido_minimo"
    const { data: e } = await sb.from("empresas").select(campo).eq("id", empresaId).maybeSingle()
    params = { de: Number(e?.[campo] ?? 0), para: v }
    resumo = tipo === "taxa_entrega_fixa"
      ? `Mudar a taxa de entrega fixa de ${reais(Number(e?.[campo] ?? 0))} para ${reais(v)}.`
      : `Mudar o pedido mínimo de ${reais(Number(e?.[campo] ?? 0))} para ${reais(v)}.`
  } else if (tipo === "ajustar_tabela_km") {
    const v = Number(a?.valor)
    if (!Number.isFinite(v) || v === 0) return { erro: "Preciso de quanto somar (ou tirar) em reais." }
    const { data: e } = await sb.from("empresas").select("taxas_entrega_km").eq("id", empresaId).maybeSingle()
    const tab = Array.isArray(e?.taxas_entrega_km) ? e.taxas_entrega_km : []
    if (!tab.length) return { erro: "Esta loja nao usa tabela de taxa por km." }
    params = { delta: v }
    resumo = `${v > 0 ? "Aumentar" : "Reduzir"} ${reais(Math.abs(v))} em todas as faixas de km que cobram taxa (de ${tab.length} faixas; as gratis continuam gratis).`
  } else {
    return { erro: "Tipo de acao desconhecido." }
  }
  await admin.from("assistente_acoes").update({ status: "cancelada" })
    .eq("empresa_id", empresaId).eq("grupo_jid", grupoJid).eq("status", "pendente")
  const { error } = await admin.from("assistente_acoes").insert({ empresa_id: empresaId, grupo_jid: grupoJid, tipo, params, resumo })
  if (error) return { erro: "Nao consegui preparar a mudanca agora." }
  return { ok: true, resumo, proximo_passo: "Mostre este resumo ao dono e peca que responda SIM para aplicar ou NAO para cancelar. Nada mudou ainda." }
}

// ── carteira: franquia do mes + saldo comprado ──────────────────────────────
// A loja tem uma franquia mensal (R$ 5,00 por padrao) que renova todo dia 1.
// Gastou tudo, comeca a sair do saldo que ela comprou. Sem saldo, o assistente
// para — senao o custo da IA cresce sem teto e come a mensalidade.
//
// O preco de cada pergunta e o CUSTO REAL em dolar, convertido, mais a margem.
// Pergunta com cache quente sai barata e desconta pouco; e o mais justo que da.
async function verCarteira(admin: any, empresaId: string) {
  const [cfg, emp] = await Promise.all([
    admin.from("config_global").select("chave, valor").in("chave", ["ia_cotacao_usd", "ia_margem"]),
    admin.from("empresas").select("ia_saldo_centavos, ia_franquia_centavos, vencimento")
      .eq("id", empresaId).maybeSingle(),
  ])

  // O ciclo segue o VENCIMENTO da loja, não o dia 1. A CDBom vence dia 20 e a
  // Marajó dia 1: contar pelo mês civil daria franquia nova no meio do ciclo de
  // quem vence dia 20, e a loja usaria quase dois meses de IA pagando um.
  const cicloIni = inicioDoCiclo(emp.data?.vencimento)
  const mes = await admin.from("assistente_conversas").select("custo_brl")
    .eq("empresa_id", empresaId).gte("created_at", iniISO(cicloIni))

  const conf: Record<string, string> = {}
  for (const c of (cfg.data ?? [])) conf[c.chave] = c.valor
  // Se alguem apagar a configuracao, o padrao tem que ser CARO, nao de graca:
  // errar pra baixo aqui significa dar IA de presente sem ninguem perceber.
  const cotacao = Number(conf.ia_cotacao_usd) > 0 ? Number(conf.ia_cotacao_usd) : 5.5
  const margem  = Number(conf.ia_margem)      > 0 ? Number(conf.ia_margem)      : 1.2

  const franquia = Number(emp.data?.ia_franquia_centavos ?? 500) / 100
  const saldo    = Number(emp.data?.ia_saldo_centavos ?? 0) / 100
  const gastoMes = (mes.data ?? []).reduce((s: number, r: any) => s + Number(r.custo_brl || 0), 0)
  const franquiaRestante = Math.max(0, franquia - gastoMes)

  return { cotacao, margem, franquia, saldo, gastoMes, franquiaRestante, cicloIni,
           renovaEm: proximaRenovacao(emp.data?.vencimento),
           disponivel: franquiaRestante + saldo }
}

// Espelho de src/lib/cicloIa.js — o servidor precisa da mesma conta pra decidir
// se bloqueia. Mexeu lá, mexa aqui.
const diaDeRenovacao = (vencimento: string | null | undefined) => {
  const d = Number(String(vencimento ?? "").slice(8, 10))
  return d >= 1 && d <= 31 ? d : 1     // loja em trial ainda não tem vencimento
}
// Dia preso ao mês: quem vence dia 31 renova dia 30 em novembro.
const ultimoDiaDoMes = (ano: number, mes: number) =>
  new Date(Date.UTC(ano, mes, 0)).getUTCDate()
const diaNoMes = (ano: number, mes: number, dia: number) =>
  Math.min(dia, ultimoDiaDoMes(ano, mes))
const ymd = (ano: number, mes: number, dia: number) =>
  `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`

function inicioDoCiclo(vencimento: string | null | undefined): string {
  const dia = diaDeRenovacao(vencimento)
  const [ano, mes, hojeDia] = hojeBRT().split("-").map(Number)
  if (hojeDia >= diaNoMes(ano, mes, dia)) return ymd(ano, mes, diaNoMes(ano, mes, dia))
  const mesAnt = mes === 1 ? 12 : mes - 1
  const anoAnt = mes === 1 ? ano - 1 : ano
  return ymd(anoAnt, mesAnt, diaNoMes(anoAnt, mesAnt, dia))
}

function proximaRenovacao(vencimento: string | null | undefined): string {
  const dia = diaDeRenovacao(vencimento)
  const [ano, mes] = inicioDoCiclo(vencimento).split("-").map(Number)
  const mesFim = mes === 12 ? 1 : mes + 1
  const anoFim = mes === 12 ? ano + 1 : ano
  return ymd(anoFim, mesFim, diaNoMes(anoFim, mesFim, dia))
}

const resumoCarteira = (c: any) => ({
  franquia: c.franquia,
  renova_em: c.renovaEm,
  usado_no_mes: Number(c.gastoMes.toFixed(2)),
  franquia_restante: Number(c.franquiaRestante.toFixed(2)),
  saldo: Number(c.saldo.toFixed(2)),
  disponivel: Number(c.disponivel.toFixed(2)),
})

// ── handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  if (req.method !== "POST") return json({ erro: "Metodo nao suportado." }, 405)

  try {
    if (!ANTHROPIC_API_KEY) return json({ erro: "IA nao configurada." }, 503)

    const auth = req.headers.get("Authorization") ?? ""
    const token = auth.replace(/^Bearer\s+/i, "").trim()
    if (!token) return json({ erro: "Faca login para usar o assistente." }, 401)

    const body = await req.json().catch(() => ({}))
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

    // MODO WHATSAPP: quem chama é a função estoque-whatsapp, com a chave de serviço, em
    // nome de uma loja. Não existe token de usuário, então a gente CRIA um de verdade
    // (link mágico do admin da loja, trocado na hora, sem mandar e-mail). Assim as
    // consultas seguem sob a RLS daquela loja — nunca roda com service role.
    let sb: any, user: { id: string }, perfil: { empresa_id: string; perfil: string }
    // Só vale com verify_jwt LIGADO nesta função (o gateway já conferiu a assinatura): o papel vem do próprio JWT.
    let papelDoToken = ""
    try { papelDoToken = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role ?? "" } catch { /* token de usuário comum */ }
    // A chave de serviço pode ser um JWT (papel service_role) ou a chave nova sb_secret_… (não é JWT):
    // por isso vale também a igualdade exata com a chave do ambiente.
    const ehServico = (SERVICE_KEY !== "" && token === SERVICE_KEY) || papelDoToken === "service_role"
    const canal: string = ehServico && typeof body?.empresa_id === "string" ? "whatsapp" : "portal"
    if (canal === "whatsapp") {
      const { data: adm } = await admin.from("profiles").select("id, empresa_id, perfil")
        .eq("empresa_id", body.empresa_id).eq("perfil", "admin").limit(1).maybeSingle()
      if (!adm) return json({ erro: "A loja nao tem um administrador cadastrado." }, 400)
      const email = (await admin.auth.admin.getUserById(adm.id)).data.user?.email
      if (!email) return json({ erro: "O administrador da loja nao tem e-mail." }, 400)
      const { data: lk, error: lkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email })
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
      const { data: ses, error: sesErr } = lkErr || !lk?.properties?.hashed_token
        ? { data: null, error: lkErr ?? new Error("sem token") }
        : await anon.auth.verifyOtp({ token_hash: lk.properties.hashed_token, type: "magiclink" })
      if (sesErr || !ses?.session?.access_token) {
        console.error("[assistente-loja] sessao whatsapp", sesErr?.message)
        return json({ erro: "Nao consegui abrir o acesso da loja." }, 500)
      }
      sb = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${ses.session.access_token}` } },
        auth: { persistSession: false },
      })
      user = { id: adm.id }
      perfil = { empresa_id: adm.empresa_id, perfil: adm.perfil }
    } else {
      // A chave ANON + o token do usuario mantem a RLS ligada: a loja so alcanca
      // a propria loja, mesmo se algo aqui estiver errado.
      sb = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false },
      })
      const { data: { user: u }, error: authErr } = await sb.auth.getUser(token)
      if (authErr || !u) return json({ erro: "Sessao expirada. Entre de novo." }, 401)
      user = u
      const { data: pf } = await sb.from("profiles")
        .select("empresa_id, perfil, nome").eq("id", u.id).maybeSingle()
      if (!pf?.empresa_id) return json({ erro: "Nao achei sua loja." }, 400)
      // Numero de caixa e lucro e assunto de dono. Vendedor, garcom e cozinheiro
      // usam o sistema no balcao, muitas vezes com o celular na mao de outra pessoa.
      if (!["admin", "super_admin"].includes(pf.perfil)) {
        return json({ erro: "O assistente com os numeros da loja e so para o administrador." }, 403)
      }
      perfil = pf
    }
    if (passouDoLimite(user.id)) {
      return json({ erro: "Muitas perguntas seguidas. Aguarde alguns minutos." }, 429)
    }

    // Cliente com service role: le a configuracao de preco, o saldo da loja e
    // grava a conversa. Nenhuma consulta de DADO da loja passa por ele.
    const carteira = await verCarteira(admin, perfil.empresa_id)
    if (carteira.disponivel <= 0) {
      return json({
        erro: `Seu assistente usou os R$ ${carteira.franquia.toFixed(2).replace(".", ",")} deste ciclo e o saldo acabou. ` +
              `Compre saldo em Automacao > Assistente IA pra continuar hoje, ou espere renovar com a sua mensalidade.`,
        sem_saldo: true,
        carteira: resumoCarteira(carteira),
      }, 402)
    }

    const pergunta = String(body?.pergunta ?? "").trim().slice(0, MAX_PERGUNTA)
    if (!pergunta) return json({ erro: "Escreva sua pergunta." }, 400)

    const historico = (Array.isArray(body?.historico) ? body.historico : [])
      .slice(-MAX_HISTORICO)
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))

    const { data: videos } = await sb.from("videos_tutorial")
      .select("chave, titulo, descricao, youtube_id").eq("ativo", true).order("ordem")
    const catalogo = (videos ?? [])
      .map((v: any) => `- [${v.chave}] "${v.titulo}"${v.descricao ? ` — ${v.descricao}` : ""}`)
      .join("\n") || "(nenhum video cadastrado ainda)"

    const hoje = hojeBRT()
    const diaSemana = new Date(`${hoje}T12:00:00-03:00`)
      .toLocaleDateString("pt-BR", { weekday: "long", timeZone: "America/Sao_Paulo" })

    // O prompt vai em DOIS pedaços de propósito. O primeiro (manual, regras,
    // catálogo de vídeos — uns 3.500 tokens) é IDÊNTICO em toda pergunta de
    // toda loja, então vai marcado pra cache: paga-se 10% dele em vez de 100%.
    // A data fica no segundo pedaço porque muda todo dia — se ela estivesse
    // junto do manual, invalidaria o cache inteiro toda madrugada.
    // Detalhe que faz a conta fechar: as DUAS chamadas de uma mesma pergunta
    // acontecem com segundos de diferença, então a segunda sempre lê do cache.
    const systemEstavel = `Voce e o assistente do FWC Inter dentro do sistema da loja. Fala com o \
DONO da loja: alguem que entende do negocio e nada de tecnologia.

VOCE FAZ DUAS COISAS
1. Responde perguntas sobre os NUMEROS da loja usando as ferramentas de consulta.
2. Ensina onde fica cada coisa no sistema, passo a passo, usando o manual abaixo.

REGRAS DOS NUMEROS
- NUNCA invente ou estime um numero. Todo valor que voce disser tem que ter vindo \
de uma ferramenta nesta conversa. Se nao tem ferramenta que responda, diga que \
essa informacao voce ainda nao consegue puxar e indique a tela onde ela aparece.
- Faturamento e o que foi vendido. Lucro so existe em dia FECHADO no Financeiro > \
Despesas & Lucro. Se o dono pedir lucro de um dia nao fechado, diga isso com \
clareza, entregue o faturamento do dia e explique como fechar.
- Valores em reais no formato brasileiro: R$ 1.234,56.
- Pode chamar mais de uma ferramenta quando a pergunta pedir (ex.: comparar duas semanas).

DIAGNOSTICO E ANALISES
- Quando o dono pedir diagnostico, 'o que melhorar', analise do cardapio, do financeiro ou da entrega, chame as \nferramentas analisar_cardapio, analisar_financeiro, ver_entrega e situacao_agora (pode ser todas de uma vez) e \nresponda com 3 a 5 PRIORIDADES, da que mais move dinheiro pra menos. Cada uma: o numero que prova o problema, \no que fazer, e quanto isso pode render ou poupar SO se der pra calcular com os numeros que voce tem. Sem rodeio, \nsem elogio vazio. Se faltar dado (ex.: produto sem custo, dias sem fechar), diga que isso e a prioridade 1, porque \nsem isso nao ha como medir lucro.
- Nesses casos pode passar de 5 frases (ate umas 14 linhas).
- Voce NUNCA executa mudanca. Quando existir a ferramenta propor_acao, ela so PREPARA e o dono confirma com SIM. \nNunca diga que ja mudou algo.

COMO RESPONDER
- Portugues do Brasil, direto, curto. Ate 5 frases, ou uma lista curta quando \
forem varios numeros ou um passo a passo.
- Nada de jargao tecnico: sem "tabela", "banco de dados", "endpoint", "API".
- Quando ensinar onde clicar, use o nome exato do menu e do botao do manual. \
Nunca invente tela ou botao que nao esta no manual.
- Se existir video que ajude, cite a chave entre colchetes no fim, assim: [chave]. \
No maximo 2, e so chaves da lista. Nao escreva link nenhum.
- Se a pergunta nao for sobre a loja nem sobre o sistema, diga que voce so ajuda \
com isso.

MANUAL DO SISTEMA
${MANUAL}

VIDEOS DISPONIVEIS (so estes existem)
${catalogo}`

    const systemDoDia = `HOJE E ${hoje} (${diaSemana}), horario de Brasilia. \
"Ontem" e ${somaDias(hoje, -1)}. Este mes comecou em ${hoje.slice(0, 8)}01. \
Converta o que o dono falar ("hoje", "essa semana", "mes passado", "sabado") \
para datas AAAA-MM-DD antes de consultar.${canal === "whatsapp" ? `
CANAL: WHATSAPP, no grupo da loja. Responda curto, como mensagem de zap: sem tabela, sem titulo, \
negrito so com *asteriscos*. Nao cite videos. Se o dono quiser dar ENTRADA de estoque, diga que e so \
escrever ou falar o que comprou (ou mandar a foto/PDF da nota) aqui no grupo, que o robo lanca.` : ""}`

    const system = [
      { type: "text", text: systemEstavel, cache_control: { type: "ephemeral" } },
      { type: "text", text: systemDoDia },
    ]

    const mensagens: any[] = [...historico, { role: "user", content: pergunta }]
    let resposta: any = null
    const gasto = { entrada: 0, cacheGravar: 0, cacheLer: 0, saida: 0 }
    const consultasFeitas: string[] = []

    for (let volta = 0; volta < MAX_VOLTAS; volta++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODELO,
          // Teto alto de proposito: o raciocinio do modelo conta aqui dentro, e
          // um teto curto corta a resposta no meio da frase. Quem manda no
          // tamanho da resposta e a instrucao "ate 5 frases" la em cima — isto
          // aqui e so a trava de seguranca.
          max_tokens: 8000,
          // Esforco baixo: a tarefa e escolher a consulta certa e ler o resultado.
          // Alto so deixaria o dono esperando na frente do cliente e sairia caro.
          output_config: { effort: "low" },
          system,
          tools: canal === "whatsapp" && typeof body?.grupo_jid === "string" ? [...TOOLS, TOOL_PROPOR_ACAO] : TOOLS,
          messages: mensagens,
        }),
      })
      if (!r.ok) {
        console.error("[assistente-loja] anthropic", r.status, await r.text())
        return json({ erro: "A IA esta indisponivel agora. Tente de novo em instantes." }, 502)
      }
      resposta = await r.json()
      const u = resposta?.usage ?? {}
      gasto.entrada     += Number(u.input_tokens || 0)
      gasto.cacheGravar += Number(u.cache_creation_input_tokens || 0)
      gasto.cacheLer    += Number(u.cache_read_input_tokens || 0)
      gasto.saida       += Number(u.output_tokens || 0)

      if (resposta?.stop_reason === "refusal") {
        return json({ resposta: "Nao consigo ajudar com isso. Me pergunte algo sobre a sua loja ou sobre o sistema.", videos: [] })
      }
      if (resposta?.stop_reason !== "tool_use") break

      const chamadas = (resposta.content ?? []).filter((b: any) => b?.type === "tool_use")
      for (const c of chamadas) if (!consultasFeitas.includes(c.name)) consultasFeitas.push(c.name)
      const resultados = await Promise.all(chamadas.map(async (c: any) => {
        try {
          const dados = c.name === "propor_acao" && canal === "whatsapp" && typeof body?.grupo_jid === "string"
            ? await proporAcao(sb, admin, perfil.empresa_id, body.grupo_jid, c.input ?? {})
            : await rodarTool(sb, perfil.empresa_id, c.name, c.input ?? {})
          return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(dados) }
        } catch (e) {
          console.error("[assistente-loja] tool", c.name, e)
          return {
            type: "tool_result", tool_use_id: c.id, is_error: true,
            content: "Nao consegui consultar isso agora.",
          }
        }
      }))
      mensagens.push({ role: "assistant", content: resposta.content })
      mensagens.push({ role: "user", content: resultados })
    }

    let texto = (resposta?.content ?? [])
      .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim()

    // O link do video nunca vem da IA: ela cita a chave e o servidor troca pelo
    // video real do banco. Assim nao tem como aparecer video inventado.
    const validas = new Set((videos ?? []).map((v: any) => v.chave))
    const citadas: string[] = []
    texto = texto.replace(/\[([a-z0-9-]+)\]/gi, (todo: string, chave: string) => {
      const k = chave.toLowerCase()
      if (!validas.has(k)) return todo
      if (!citadas.includes(k)) citadas.push(k)
      return ""
    }).replace(/[ \t]+\n/g, "\n").trim()

    const sugeridos = citadas.slice(0, 2)
      .map(k => (videos ?? []).find((v: any) => v.chave === k)).filter(Boolean)

    if (!texto) texto = "Nao consegui montar a resposta agora. Tente perguntar de outro jeito."

    // Grava a conversa. As perguntas dos lojistas sao o melhor mapa de onde o
    // sistema confunde — e o custo por pergunta so vira decisao com historico.
    // Se a gravacao falhar, o dono NAO pode perder a resposta por causa disso:
    // por isso o erro so vai pro log.
    const custo =
      (gasto.entrada     * PRECO.entrada +
       gasto.cacheGravar * PRECO.cacheGravar +
       gasto.cacheLer    * PRECO.cacheLer +
       gasto.saida       * PRECO.saida) / 1_000_000

    // Quanto ESTA pergunta custa pra loja: o custo real em dolar, convertido,
    // mais a margem. A franquia do mes paga primeiro; o que passar dela sai do
    // saldo comprado.
    const custoBrl = Math.round(custo * carteira.cotacao * carteira.margem * 10000) / 10000
    const daFranquia = Math.min(custoBrl, carteira.franquiaRestante)
    const doSaldo = Math.max(0, custoBrl - daFranquia)
    if (doSaldo > 0) {
      // Arredonda o debito PRA CIMA: centavo perdido em toda pergunta vira
      // prejuizo silencioso no fim do mes.
      const centavos = Math.ceil(doSaldo * 100)
      const { error: debErro } = await admin.rpc("ia_mover_saldo", {
        p_empresa_id: perfil.empresa_id,
        p_centavos: -centavos,
        p_tipo: "debito",
        p_descricao: `Pergunta ao assistente: ${pergunta.slice(0, 60)}`,
      })
      if (debErro) console.error("[assistente-loja] debito", debErro.message)
    }

    try {
      const { error: insErro } = await admin.from("assistente_conversas").insert({
        empresa_id: perfil.empresa_id,
        user_id: user.id,
        pergunta,
        resposta: texto,
        consultas: consultasFeitas,
        videos: sugeridos.map((v: any) => ({ chave: v.chave, titulo: v.titulo, youtube_id: v.youtube_id })),
        tokens_in: gasto.entrada + gasto.cacheGravar,
        tokens_cache: gasto.cacheLer,
        tokens_out: gasto.saida,
        custo_usd: Number(custo.toFixed(6)),
        custo_brl: custoBrl,
        pago_com_saldo: Number(doSaldo.toFixed(4)),
        modelo: MODELO,
        canal: canal === "whatsapp" ? "whatsapp_pergunta" : "portal",
      })
      if (insErro) console.error("[assistente-loja] historico", insErro.message)
    } catch (e) {
      console.error("[assistente-loja] historico", e)
    }

    // Devolve a carteira JÁ com esta pergunta descontada, pro medidor da tela
    // andar na hora — sem precisar de uma segunda consulta.
    const depois = {
      ...carteira,
      gastoMes: carteira.gastoMes + custoBrl,
      franquiaRestante: carteira.franquiaRestante - daFranquia,
      saldo: Math.max(0, carteira.saldo - doSaldo),
    }
    return json({
      resposta: texto,
      custo_brl: custoBrl,
      videos: sugeridos,
      carteira: resumoCarteira({ ...depois, disponivel: depois.franquiaRestante + depois.saldo }),
    })
  } catch (e) {
    console.error("[assistente-loja]", e)
    return json({ erro: "Deu erro aqui. Tente de novo em instantes." }, 500)
  }
})
