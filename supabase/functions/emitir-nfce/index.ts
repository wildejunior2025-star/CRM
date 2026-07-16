import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// =====================================================================
// emitir-nfce  —  Emissão de NFC-e via Focus NFe
// ---------------------------------------------------------------------
// acao: "registrar_empresa" { empresa_id, senha_certificado }
//        Cadastra/atualiza a loja no Focus com o certificado A1 (.pfx do
//        bucket) + CSC. Depois disso a loja já pode emitir.
// acao: "emitir"  { pedido_id, cpf? }
//        Monta a NFC-e a partir do pedido e envia ao Focus (síncrono).
// acao: "consultar" { nota_id | ref }
//        Reconsulta o status de uma nota no Focus.
//
// Modelo SaaS: 1 conta Focus da FWC (token no secret) e cada loja é uma
// "empresa" (CNPJ) cadastrada lá. A loja só precisa subir o A1 dela.
// Secrets: FOCUS_NFE_TOKEN_HOMOLOGACAO / FOCUS_NFE_TOKEN_PRODUCAO
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const FOCUS_HOST = {
  homologacao: "https://homologacao.focusnfe.com.br",
  producao: "https://api.focusnfe.com.br",
}

function tokenDoAmbiente(ambiente: string): string | null {
  const key = ambiente === "producao" ? "FOCUS_NFE_TOKEN_PRODUCAO" : "FOCUS_NFE_TOKEN_HOMOLOGACAO"
  return Deno.env.get(key) ?? null
}

// Basic auth do Focus: token como usuário, senha vazia
function authHeader(token: string): string {
  return "Basic " + btoa(`${token}:`)
}

const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "")

// base64 de binário grande sem estourar a pilha
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  )

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const acao = body?.acao ?? ""

  try {
    if (acao === "registrar_empresa") return json(await registrarEmpresa(sb, body?.empresa_id, body?.senha_certificado))
    if (acao === "emitir")            return json(await emitir(sb, body?.pedido_id, body?.cpf))
    if (acao === "consultar")         return json(await consultar(sb, body?.nota_id, body?.ref))
    return json({ ok: false, error: `ação desconhecida: ${acao}` }, 400)
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// ─────────────────────────────────────────────────────────────────────
// REGISTRAR EMPRESA — sobe o A1 + CSC pro Focus (loja pronta pra emitir)
// ─────────────────────────────────────────────────────────────────────
async function registrarEmpresa(sb: any, empresaId: string, senhaCert: string) {
  if (!empresaId) return { ok: false, error: "empresa_id obrigatório" }
  if (!senhaCert) return { ok: false, error: "Informe a senha do certificado" }

  const { data: emp } = await sb.from("empresas").select("*").eq("id", empresaId).maybeSingle()
  if (!emp) return { ok: false, error: "empresa não encontrada" }
  const { data: fis } = await sb.from("empresa_fiscal").select("*").eq("empresa_id", empresaId).maybeSingle()
  if (!fis) return { ok: false, error: "Preencha os dados fiscais primeiro" }
  if (!fis.certificado_ref) return { ok: false, error: "Suba o certificado A1 primeiro" }

  const cnpj = soDigitos(emp.cnpj)
  if (cnpj.length !== 14) return { ok: false, error: "CNPJ da loja inválido (confira na aba Conta)" }

  const ambiente = fis.ambiente === "producao" ? "producao" : "homologacao"
  const token = tokenDoAmbiente(ambiente)
  if (!token) return { ok: false, error: `Token do Focus (${ambiente}) não configurado na plataforma` }

  // Lê o .pfx do bucket privado e converte pra base64
  const dl = await sb.storage.from("certificados-fiscais").download(fis.certificado_ref)
  if (dl.error || !dl.data) return { ok: false, error: `não consegui ler o certificado: ${dl.error?.message ?? "arquivo ausente"}` }
  const certB64 = toBase64(await dl.data.arrayBuffer())

  // CSC/token do ambiente escolhido
  const cscKey = ambiente === "producao" ? "csc_nfce_producao" : "csc_nfce_homologacao"
  const idTokenKey = ambiente === "producao" ? "id_token_nfce_producao" : "id_token_nfce_homologacao"

  const payload: Record<string, unknown> = {
    nome: emp.razao_social || emp.nome,
    nome_fantasia: emp.nome,
    cnpj,
    inscricao_estadual: soDigitos(fis.inscricao_estadual) || undefined,
    regime_tributario: fis.regime_tributario === "normal" ? 3 : 1, // 1=Simples, 3=Normal
    logradouro: emp.endereco || undefined,
    numero: emp.numero || undefined,
    bairro: emp.bairro || undefined,
    municipio: emp.cidade || undefined,
    uf: emp.estado || undefined,
    cep: soDigitos(emp.cep) || undefined,
    email: emp.email_contato || undefined,
    telefone: soDigitos(emp.telefone_contato) || undefined,
    habilita_nfce: true,
    arquivo_certificado_base64: certB64,
    senha_certificado: senhaCert,
    [cscKey]: fis.csc || undefined,
    [idTokenKey]: fis.csc_id || undefined,
  }

  const base = `${FOCUS_HOST[ambiente]}/v2/empresas`
  // Tenta criar; se já existe (CNPJ duplicado), atualiza via PUT.
  let res = await fetch(base, {
    method: "POST",
    headers: { "Authorization": authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  let txt = await res.text()

  if (!res.ok) {
    // Já cadastrada -> atualiza
    if (res.status === 422 || /existe|cadastrad/i.test(txt)) {
      res = await fetch(`${base}/${cnpj}`, {
        method: "PUT",
        headers: { "Authorization": authHeader(token), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      txt = await res.text()
    }
  }

  if (!res.ok) {
    await sb.from("empresa_fiscal").update({ ultimo_erro_fiscal: txt.slice(0, 500), focus_registrada: false }).eq("empresa_id", empresaId)
    return { ok: false, error: `Focus ${res.status}: ${txt.slice(0, 400)}` }
  }

  await sb.from("empresa_fiscal").update({
    focus_registrada: true,
    focus_registrada_em: new Date().toISOString(),
    ultimo_erro_fiscal: null,
  }).eq("empresa_id", empresaId)

  return { ok: true, mensagem: "Loja registrada no emissor. Já pode emitir NFC-e." }
}

// ─────────────────────────────────────────────────────────────────────
// EMITIR — monta a NFC-e do pedido e manda pro Focus (síncrono)
// ─────────────────────────────────────────────────────────────────────
const PAGAMENTO_FOCUS: Record<string, string> = {
  dinheiro: "01", credito: "03", debito: "04", cartao: "03",
  pix: "17", online: "17", vale: "10", outro: "99",
}

async function emitir(sb: any, pedidoId: string, cpf?: string) {
  if (!pedidoId) return { ok: false, error: "pedido_id obrigatório" }

  const { data: ped } = await sb.from("pedidos_delivery").select("*").eq("id", pedidoId).maybeSingle()
  if (!ped) return { ok: false, error: "pedido não encontrado" }

  // Já emitida e autorizada? devolve a existente (idempotência)
  const { data: jaTem } = await sb.from("nfce_notas")
    .select("*").eq("pedido_id", pedidoId).eq("status", "autorizada").maybeSingle()
  if (jaTem) return { ok: true, ja_emitida: true, nota: jaTem }

  const { data: emp } = await sb.from("empresas").select("cnpj").eq("id", ped.empresa_id).maybeSingle()
  const { data: fis } = await sb.from("empresa_fiscal").select("*").eq("empresa_id", ped.empresa_id).maybeSingle()
  if (!fis || !fis.ativo) return { ok: false, error: "Emissão de NFC-e não está habilitada nesta loja" }
  if (!fis.focus_registrada) return { ok: false, error: "Loja ainda não registrada no emissor (suba o A1 em Minha Loja → Nota Fiscal)" }

  const cnpj = soDigitos(emp?.cnpj)
  const ambiente = fis.ambiente === "producao" ? "producao" : "homologacao"
  const token = tokenDoAmbiente(ambiente)
  if (!token) return { ok: false, error: `Token do Focus (${ambiente}) não configurado na plataforma` }

  const ncm = fis.ncm_padrao || "21069090"
  const cfop = fis.cfop_padrao || "5102"
  const csosn = fis.csosn_padrao || "102"
  const origem = fis.origem_padrao || "0"

  const itensPed: any[] = Array.isArray(ped.itens) ? ped.itens : []
  if (!itensPed.length) return { ok: false, error: "pedido sem itens" }

  const items = itensPed.map((it, idx) => {
    const qtd = Number(it.quantidade ?? it.qtd ?? 1) || 1
    const unit = Number(it.preco_unitario ?? it.preco ?? 0) || 0
    const bruto = Number(it.subtotal ?? (unit * qtd)) || unit * qtd
    return {
      numero_item: String(idx + 1),
      codigo_produto: String(it.codigo ?? it.id ?? idx + 1),
      descricao: String(it.nome ?? it.descricao ?? "Item"),
      codigo_ncm: ncm,
      cfop,
      unidade_comercial: "UN",
      unidade_tributavel: "UN",
      quantidade_comercial: qtd,
      quantidade_tributavel: qtd,
      valor_unitario_comercial: unit,
      valor_unitario_tributavel: unit,
      valor_bruto: Number(bruto.toFixed(2)),
      icms_origem: origem,
      icms_situacao_tributaria: csosn,
    }
  })

  const total = Number(ped.total ?? ped.subtotal ?? 0) || items.reduce((s, i) => s + i.valor_bruto, 0)
  const formaPed = String(ped.forma_pagamento ?? "outro").toLowerCase()
  const formaFocus = PAGAMENTO_FOCUS[formaPed] ?? "99"

  const ref = `nfce-${pedidoId}`
  const nfce: Record<string, unknown> = {
    cnpj_emitente: cnpj,
    data_emissao: new Date().toISOString(),
    natureza_operacao: "VENDA AO CONSUMIDOR",
    presenca_comprador: "1",
    modalidade_frete: "9",
    local_destino: "1",
    items,
    formas_pagamento: [{ forma_pagamento: formaFocus, valor_pagamento: Number(total.toFixed(2)) }],
  }
  const cpfLimpo = soDigitos(cpf)
  if (cpfLimpo.length === 11) nfce.cpf_destinatario = cpfLimpo
  if (ped.cliente_nome && ped.cliente_nome !== "Cliente iFood") nfce.nome_destinatario = ped.cliente_nome

  // grava rascunho antes de enviar (rastro mesmo se cair)
  const { data: rascunho } = await sb.from("nfce_notas").insert({
    empresa_id: ped.empresa_id, pedido_id: pedidoId, status: "processando",
    ambiente, ref, valor_total: Number(total.toFixed(2)),
  }).select("id").maybeSingle()
  const notaId = rascunho?.id

  const res = await fetch(`${FOCUS_HOST[ambiente]}/v2/nfce?ref=${encodeURIComponent(ref)}`, {
    method: "POST",
    headers: { "Authorization": authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(nfce),
  })
  const data = await res.json().catch(() => ({}))
  const patch = mapearRetornoFocus(data, ambiente)

  if (notaId) await sb.from("nfce_notas").update(patch).eq("id", notaId)
  const { data: nota } = await sb.from("nfce_notas").select("*").eq("id", notaId).maybeSingle()

  const okStatus = patch.status === "autorizada"
  return { ok: okStatus, status: patch.status, nota, mensagem: patch.motivo_rejeicao ?? undefined }
}

// ─────────────────────────────────────────────────────────────────────
// CONSULTAR — reconsulta status no Focus (nota que ficou processando)
// ─────────────────────────────────────────────────────────────────────
async function consultar(sb: any, notaId?: string, refIn?: string) {
  let ref = refIn
  let nota: any = null
  if (notaId) {
    const r = await sb.from("nfce_notas").select("*").eq("id", notaId).maybeSingle()
    nota = r.data
    ref = nota?.ref
  }
  if (!ref) return { ok: false, error: "informe nota_id ou ref" }
  const ambiente = nota?.ambiente === "producao" ? "producao" : "homologacao"
  const token = tokenDoAmbiente(ambiente)
  if (!token) return { ok: false, error: `Token do Focus (${ambiente}) não configurado` }

  const res = await fetch(`${FOCUS_HOST[ambiente]}/v2/nfce/${encodeURIComponent(ref)}`, {
    headers: { "Authorization": authHeader(token) },
  })
  const data = await res.json().catch(() => ({}))
  const patch = mapearRetornoFocus(data, ambiente)
  if (nota?.id) await sb.from("nfce_notas").update(patch).eq("id", nota.id)
  return { ok: patch.status === "autorizada", status: patch.status, retorno: data }
}

// Traduz o retorno do Focus pro nosso registro nfce_notas
function mapearRetornoFocus(data: any, ambiente: string): Record<string, unknown> {
  const host = FOCUS_HOST[ambiente as "homologacao" | "producao"]
  const st = String(data?.status ?? "").toLowerCase()
  let status = "processando"
  if (st === "autorizado") status = "autorizada"
  else if (st.includes("erro") || st === "rejeitado" || st === "denegado") status = "rejeitada"
  else if (st === "cancelado") status = "cancelada"

  const patch: Record<string, unknown> = { status }
  if (data?.chave_nfe) patch.chave_acesso = data.chave_nfe
  if (data?.numero) patch.numero = Number(soDigitos(data.numero)) || null
  if (data?.serie) patch.serie = Number(soDigitos(data.serie)) || null
  if (data?.qrcode_url) patch.qrcode_url = data.qrcode_url
  if (data?.caminho_danfe) patch.danfe_url = data.caminho_danfe.startsWith("http") ? data.caminho_danfe : host + data.caminho_danfe
  if (data?.caminho_xml_nota_fiscal) patch.xml_url = data.caminho_xml_nota_fiscal.startsWith("http") ? data.caminho_xml_nota_fiscal : host + data.caminho_xml_nota_fiscal
  if (status === "rejeitada") patch.motivo_rejeicao = data?.mensagem_sefaz ?? data?.mensagem ?? data?.erros?.[0]?.mensagem ?? "rejeitada"
  return patch
}
