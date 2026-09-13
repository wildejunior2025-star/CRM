// API Reconciliation (arquivo mensal) e Reconciliation On-Demand (a loja pede
// o relatório de um mês e acompanha até ficar pronto).
//
//   GET  /financial/v3.0/merchants/{id}/reconciliation?competence=AAAA-MM
//        -> { downloadPath, createdAt }  (link S3 de um .csv.gz, vale 24h)
//   POST /financial/v3.0/merchants/{id}/reconciliation/on-demand  { competence }
//        -> 202 { requestId }   |  409 "There is already a recent and valid request Id: <id>"
//   GET  /financial/v3.0/merchants/{id}/reconciliation/on-demand/{requestId}
//        -> { id, status, errorMessage?, downloadPath? }
//
// O arquivo é a fonte oficial pra contabilidade. Ele fica guardado num bucket
// PRIVADO (pasta = empresa_id) e a loja baixa por link assinado.
import { chamarIfood, type CtxIfood, ErroIfood, mensagemDe } from "./fin_http.ts"
import { competenciaValida, numOuNull, redondo } from "./fin_util.ts"

const BUCKET = "ifood-conciliacao"

// ── CSV (separado por ";", com suporte a campo entre aspas) ─────────────────
export function lerCsv(texto: string): Record<string, string>[] {
  const linhas: string[][] = []
  let campo = "", linha: string[] = [], aspas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++ } else aspas = false
      } else campo += c
    } else if (c === '"') aspas = true
    else if (c === ";") { linha.push(campo); campo = "" }
    else if (c === "\n") { linha.push(campo); linhas.push(linha); linha = []; campo = "" }
    else if (c !== "\r") campo += c
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha) }
  const [cab, ...resto] = linhas.filter((l) => l.some((x) => x !== ""))
  if (!cab) return []
  return resto.map((l) => Object.fromEntries(cab.map((k, i) => [k.trim(), (l[i] ?? "").trim()])))
}

// ── Resumo pra loja: vendas, cancelamentos, taxas, subsídios, líquido e datas ──
export function resumirArquivo(linhas: Record<string, string>[]) {
  const v = (l: Record<string, string>) => numOuNull(l.valor) ?? 0
  const sim = (l: Record<string, string>) => (l.impacto_no_repasse ?? "").toUpperCase() === "SIM"

  let vendas = 0, cancelamentos = 0, comissoesTaxas = 0, subsidiosIfood = 0, promocoesLoja = 0
  let anuncios = 0, entregas = 0, mensalidade = 0, reembolsos = 0, recebidoNaLoja = 0
  let creditos = 0, debitos = 0, repasse = 0
  const pedidosCancelados = new Set<string>()
  const competenciasNoArquivo = new Set<string>()
  const lojasNoArquivo = new Set<string>()
  const porCategoria = new Map<string, { fato: string; tipo: string; descricao: string; impacto: string; qtd: number; valor: number }>()
  const titulos = new Map<string, { titulo: string; data_repasse: string | null; valor: number | null }>()

  for (const l of linhas) {
    const valor = v(l)
    const fato = l.fato_gerador ?? ""
    const tipo = l.tipo_lancamento ?? ""
    const desc = l.descricao_lancamento ?? ""
    const cancel = /cancel/i.test(fato) || (l.motivo_cancelamento ?? "") !== ""
    if (l.competencia) competenciasNoArquivo.add(l.competencia)
    if (l.loja_id) lojasNoArquivo.add(l.loja_id)

    if (sim(l)) { repasse += valor; if (valor >= 0) creditos += valor; else debitos += valor }

    if (cancel) {
      cancelamentos += valor
      if (l.pedido_associado_ifood) pedidosCancelados.add(l.pedido_associado_ifood)
    } else if (/entrada financeira/i.test(tipo)) {
      vendas += valor
      if (!sim(l)) recebidoNaLoja += valor
    } else if (/an[úu]ncio/i.test(desc)) anuncios += valor
    else if (/mensalidade/i.test(desc)) mensalidade += valor
    else if (/frete|entrega/i.test(fato) || /solicita[çc][ãa]o de entrega/i.test(desc)) entregas += valor
    else if (/subsid/i.test(tipo)) {
      if (/ifood/i.test(desc)) subsidiosIfood += valor
      else promocoesLoja += valor
    } else if (/reembolso/i.test(tipo)) reembolsos += valor
    else if (/cobran[çc]a|reten[çc][ãa]o/i.test(tipo)) comissoesTaxas += valor

    const chave = [fato, tipo, desc, l.impacto_no_repasse].join("|")
    const cat = porCategoria.get(chave) ?? { fato, tipo, descricao: desc, impacto: l.impacto_no_repasse ?? "", qtd: 0, valor: 0 }
    cat.qtd++; cat.valor += valor
    porCategoria.set(chave, cat)

    if (l.titulo && !titulos.has(l.titulo)) {
      titulos.set(l.titulo, {
        titulo: l.titulo,
        data_repasse: l.data_repasse_esperada || null,
        valor: numOuNull(l.valor_transacao),
      })
    }
  }

  return {
    linhas: linhas.length,
    competencias_arquivo: [...competenciasNoArquivo].sort(),
    lojas_arquivo: [...lojasNoArquivo].sort(),
    vendas: redondo(vendas),
    recebido_na_loja: redondo(recebidoNaLoja),
    cancelamentos: redondo(cancelamentos),
    pedidos_cancelados: pedidosCancelados.size,
    comissoes_taxas: redondo(comissoesTaxas),
    subsidios_ifood: redondo(subsidiosIfood),
    promocoes_loja: redondo(promocoesLoja),
    anuncios: redondo(anuncios),
    entregas: redondo(entregas),
    mensalidade: redondo(mensalidade),
    reembolsos: redondo(reembolsos),
    creditos: redondo(creditos),
    debitos: redondo(debitos),
    // "impacto_no_repasse = SIM" — o filtro que o guia exige.
    repasse_arquivo: redondo(repasse),
    titulos: [...titulos.values()].sort((a, b) => String(a.data_repasse).localeCompare(String(b.data_repasse))),
    categorias: [...porCategoria.values()]
      .map((c) => ({ ...c, valor: redondo(c.valor) }))
      .sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor)),
  }
}

// Baixa o .csv.gz do link, descompacta, guarda no bucket e devolve o resumo.
async function processarArquivo(ctx: CtxIfood, competencia: string, origem: string, downloadPath: string) {
  const r = await fetch(downloadPath)
  if (!r.ok || !r.body) throw new Error(`Não consegui baixar o arquivo do iFood (${r.status}).`)
  const gz = downloadPath.split("?")[0].endsWith(".gz")
  const texto = gz
    ? await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text()
    : await r.text()

  const linhas = lerCsv(texto)
  if (!linhas.length) throw new Error("O arquivo do iFood veio vazio.")
  if (!("valor" in linhas[0]) || !("impacto_no_repasse" in linhas[0])) {
    throw new Error("O arquivo do iFood veio num formato diferente do esperado (sem valor/impacto_no_repasse).")
  }

  // Integridade: o arquivo tem que ser DESTE mês e DESTA loja. Não descarta —
  // guarda e marca, pra tela avisar em vez de mostrar número de outro lugar como
  // se fosse daqui. (No ambiente de teste do iFood isso acontece sempre: o
  // exemplo fixo é de agosto/2025 e de uma loja fictícia.)
  const resumo = resumirArquivo(linhas)
  const alertas: string[] = []
  if (resumo.competencias_arquivo.length && !resumo.competencias_arquivo.includes(competencia)) {
    alertas.push(`O arquivo veio com lançamentos de ${resumo.competencias_arquivo.join(", ")}, não de ${competencia}.`)
  }
  if (resumo.lojas_arquivo.length && !resumo.lojas_arquivo.includes(ctx.cfg.merchant_id)) {
    alertas.push("O arquivo veio com lançamentos de outra loja do iFood, não desta.")
  }

  const caminho = `${ctx.cfg.empresa_id}/${ctx.cfg.merchant_id}/${competencia}-${origem}.csv`
  const { error } = await ctx.sb.storage.from(BUCKET)
    .upload(caminho, new Blob([texto], { type: "text/csv" }), { upsert: true, contentType: "text/csv" })
  if (error) throw new Error(`guardar arquivo: ${error.message}`)

  return { caminho, resumo: { ...resumo, alertas } }
}

async function gravarLinha(ctx: CtxIfood, competencia: string, origem: string, campos: Record<string, unknown>) {
  const { error } = await ctx.sb.from("ifood_conciliacao_mensal").upsert({
    empresa_id: ctx.cfg.empresa_id,
    merchant_id: ctx.cfg.merchant_id,
    competencia,
    origem,
    atualizado_em: new Date().toISOString(),
    ...campos,
  }, { onConflict: "empresa_id,merchant_id,competencia,origem" })
  if (error) throw new Error(`gravar relatório: ${error.message}`)
}

// ── Arquivo mensal (API Reconciliation) ─────────────────────────────────────
export async function baixarRelatorioMensal(ctx: CtxIfood, competencia: string) {
  const invalida = competenciaValida(competencia)
  if (invalida) return { status: "erro", erro: invalida }

  const r = await chamarIfood(ctx, "GET",
    `/financial/v3.0/merchants/${ctx.cfg.merchant_id}/reconciliation?competence=${competencia}`)
  const texto = await r.text()
  if (r.status === 403) throw new ErroIfood(403, texto, mensagemDe(403, texto))
  if (!r.ok) {
    const erro = mensagemDe(r.status, texto)
    await gravarLinha(ctx, competencia, "mensal", { status: "erro", erro })
    return { status: "erro", erro }
  }
  let j: any = null
  try { j = JSON.parse(texto) } catch { /* abaixo */ }
  if (!j?.downloadPath) {
    const erro = "O iFood ainda não tem o arquivo desse mês."
    await gravarLinha(ctx, competencia, "mensal", { status: "erro", erro })
    return { status: "erro", erro }
  }

  try {
    const { caminho, resumo } = await processarArquivo(ctx, competencia, "mensal", j.downloadPath)
    await gravarLinha(ctx, competencia, "mensal", {
      status: "pronto", erro: null, arquivo_path: caminho, linhas: resumo.linhas, resumo,
      gerado_em: j.createdAt ?? new Date().toISOString(),
    })
    return { status: "pronto", linhas: resumo.linhas }
  } catch (e) {
    const erro = String((e as Error)?.message ?? e)
    await gravarLinha(ctx, competencia, "mensal", { status: "erro", erro })
    return { status: "erro", erro }
  }
}

// ── Sob demanda: pedir ────────────────────────────────────────────────────────
export async function solicitarRelatorio(ctx: CtxIfood, competencia: string) {
  const invalida = competenciaValida(competencia)
  if (invalida) return { status: "erro", erro: invalida }

  const r = await chamarIfood(ctx, "POST",
    `/financial/v3.0/merchants/${ctx.cfg.merchant_id}/reconciliation/on-demand`, { competence: competencia })
  const texto = await r.text()
  if (r.status === 403) throw new ErroIfood(403, texto, mensagemDe(403, texto))

  let requestId: string | null = null
  if (r.status === 202 || r.ok) {
    try { requestId = JSON.parse(texto)?.requestId ?? null } catch { /* abaixo */ }
  } else if (r.status === 409) {
    // Já existe um pedido recente e válido: reaproveita o requestId (guia do iFood).
    requestId = /request Id:\s*([0-9a-f-]{36})/i.exec(texto)?.[1] ?? null
  }

  if (!requestId) {
    const erro = mensagemDe(r.status, texto)
    await gravarLinha(ctx, competencia, "sob_demanda", { status: "erro", erro, request_id: null })
    return { status: "erro", erro }
  }

  await gravarLinha(ctx, competencia, "sob_demanda", { status: "solicitado", erro: null, request_id: requestId })
  return { status: "solicitado", request_id: requestId, reaproveitado: r.status === 409 }
}

// ── Sob demanda: acompanhar ───────────────────────────────────────────────────
export async function consultarRelatorio(ctx: CtxIfood, competencia: string, requestId: string) {
  const r = await chamarIfood(ctx, "GET",
    `/financial/v3.0/merchants/${ctx.cfg.merchant_id}/reconciliation/on-demand/${requestId}`)
  const texto = await r.text()
  if (r.status === 403) throw new ErroIfood(403, texto, mensagemDe(403, texto))
  if (!r.ok) {
    const erro = mensagemDe(r.status, texto)
    await gravarLinha(ctx, competencia, "sob_demanda", { status: "erro", erro })
    return { status: "erro", erro }
  }

  let j: any = null
  try { j = JSON.parse(texto) } catch { /* abaixo */ }
  const st = String(j?.status ?? "").toLowerCase()

  if (j?.downloadPath) {
    try {
      const { caminho, resumo } = await processarArquivo(ctx, competencia, "sob_demanda", j.downloadPath)
      await gravarLinha(ctx, competencia, "sob_demanda", {
        status: "pronto", erro: null, arquivo_path: caminho, linhas: resumo.linhas, resumo,
        gerado_em: j.createdAt ?? j.completedAt ?? new Date().toISOString(),
      })
      return { status: "pronto", linhas: resumo.linhas }
    } catch (e) {
      const erro = String((e as Error)?.message ?? e)
      await gravarLinha(ctx, competencia, "sob_demanda", { status: "erro", erro })
      return { status: "erro", erro }
    }
  }

  if (/error|fail|erro/.test(st)) {
    const erro = j?.errorMessage
      ? (/no financial entries/i.test(j.errorMessage)
        ? "O iFood não tem lançamentos dessa loja nesse mês."
        : `O iFood não conseguiu gerar o arquivo: ${j.errorMessage}`)
      : "O iFood não conseguiu gerar o arquivo."
    await gravarLinha(ctx, competencia, "sob_demanda", { status: "erro", erro })
    return { status: "erro", erro }
  }

  await gravarLinha(ctx, competencia, "sob_demanda", { status: "processando", erro: null })
  return { status: "processando" }
}
