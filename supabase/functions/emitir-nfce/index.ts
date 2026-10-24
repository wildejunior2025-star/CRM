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

// Cadastro de lojas (API de revenda): só existe no host de PRODUÇÃO e usa o
// token principal da conta FWC. Vale pros dois ambientes da loja.
const FOCUS_REVENDA = "https://api.focusnfe.com.br"

function tokenPrincipal(): string | null {
  return Deno.env.get("FOCUS_NFE_TOKEN_PRODUCAO") ?? null
}

// A LOJA SE ACHA PELO ID, NUNCA PELO CNPJ (24/10/2026)
//
// `/v2/empresas/{cnpj}` responde 404 "Empresa não encontrada" mesmo com a loja
// cadastrada e com os dois tokens prontos — aquela API só aceita o id interno.
// Era isso que fazia a Agv registrar com sucesso e, logo depois, falhar ao
// emitir pedindo pra "registrar de novo". O id vem da listagem e fica guardado
// (mig 0384); da segunda vez em diante é uma chamada direta.
async function idNoEmissor(sb: any, empresaId: string, cnpj: string, principal: string): Promise<string | null> {
  const { data: fis } = await sb.from("empresa_fiscal").select("emissor_empresa_id").eq("empresa_id", empresaId).maybeSingle()
  if (fis?.emissor_empresa_id) return String(fis.emissor_empresa_id)

  const r = await fetch(`${FOCUS_REVENDA}/v2/empresas`, { headers: { "Authorization": authHeader(principal) } })
  if (!r.ok) return null
  const d = await r.json().catch(() => null)
  const todas = Array.isArray(d) ? d : (d?.empresas ?? [])
  const achou = todas.find((e: any) => soDigitos(e?.cnpj) === cnpj)
  if (!achou?.id) return null
  await sb.from("empresa_fiscal").update({ emissor_empresa_id: String(achou.id) }).eq("empresa_id", empresaId)
  return String(achou.id)
}

// Emissão/consulta usa o token da PRÓPRIA loja (o Focus devolve um de
// homologação e um de produção). Buscamos na hora, sem guardar no banco: token
// é credencial, e credencial guardada é credencial vazada um dia.
async function tokenDaLoja(sb: any, empresaId: string, cnpj: string, ambiente: string): Promise<string | null> {
  const principal = tokenPrincipal()
  if (!principal) return null
  const id = await idNoEmissor(sb, empresaId, cnpj, principal)
  if (!id) return null
  const r = await fetch(`${FOCUS_REVENDA}/v2/empresas/${id}`, { headers: { "Authorization": authHeader(principal) } })
  if (!r.ok) return null
  const d = await r.json().catch(() => ({}))
  return (ambiente === "producao" ? d?.token_producao : d?.token_homologacao) ?? null
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
    if (acao === "diagnostico")       return json(await diagnostico(sb, body?.empresa_id))
    if (acao === "registrar_empresa") return json(await registrarEmpresa(sb, body?.empresa_id, body?.senha_certificado, body?.dry_run === true))
    if (acao === "emitir")            return json(await emitir(sb, body?.pedido_id, body?.cpf))
    if (acao === "consultar")         return json(await consultar(sb, body?.nota_id, body?.ref))
    if (acao === "cancelar")          return json(await cancelar(sb, req, body?.nota_id, body?.justificativa))
    return json({ ok: false, error: `ação desconhecida: ${acao}` }, 400)
  } catch (e) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500)
  }
})

// DIAGNOSTICO — o que o emissor sabe desta loja.
//
// Existe porque "não consegui o token desta loja" não diz NADA: pode ser a
// loja não cadastrada lá, o CNPJ consultado de um jeito que a API não aceita,
// ou o cadastro ainda em análise. Devolve o que a API respondeu SEM jamais
// devolver token — só se existe ou não.
async function diagnostico(sb: any, empresaId: string) {
  const { data: emp } = await sb.from("empresas").select("cnpj, nome").eq("id", empresaId).single()
  const cnpj = soDigitos(emp?.cnpj)
  const principal = tokenPrincipal()
  if (!principal) return { ok: false, error: "sem token principal do Focus na plataforma" }

  const porCnpj = await fetch(`${FOCUS_REVENDA}/v2/empresas/${cnpj}`, { headers: { "Authorization": authHeader(principal) } })
  const txtCnpj = await porCnpj.text()
  let achadaNaLista: any = null
  const lista = await fetch(`${FOCUS_REVENDA}/v2/empresas`, { headers: { "Authorization": authHeader(principal) } })
  const txtLista = await lista.text()
  try {
    const arr = JSON.parse(txtLista)
    const todas = Array.isArray(arr) ? arr : (arr?.empresas ?? [])
    const achou = todas.find((e: any) => soDigitos(e?.cnpj) === cnpj)
    if (achou) {
      achadaNaLista = {
        id: achou.id, nome: achou.nome, cnpj: achou.cnpj,
        habilita_nfce: achou.habilita_nfce,
        tem_token_homologacao: !!achou.token_homologacao,
        tem_token_producao: !!achou.token_producao,
      }
    } else {
      achadaNaLista = { nao_esta_na_lista: true, quantas_empresas: todas.length }
    }
  } catch { achadaNaLista = { lista_nao_e_json: txtLista.slice(0, 200) } }

  // O que o emissor guardou de CSC. Nunca devolve o codigo em si — so se ele
  // existe e qual o id, que e o bastante pra saber se o QR vai sair completo.
  let csc: any = null
  if (achadaNaLista?.id) {
    const r2 = await fetch(`${FOCUS_REVENDA}/v2/empresas/${achadaNaLista.id}`, { headers: { "Authorization": authHeader(principal) } })
    const d2 = await r2.json().catch(() => ({}))
    csc = {
      status: r2.status,
      tem_csc_homologacao: !!d2?.csc_nfce_homologacao,
      id_token_homologacao: d2?.id_token_nfce_homologacao ?? null,
      tem_csc_producao: !!d2?.csc_nfce_producao,
      id_token_producao: d2?.id_token_nfce_producao ?? null,
      habilita_nfce: d2?.habilita_nfce,
      chaves: Object.keys(d2 ?? {}).filter((k) => /csc|token|nfce/i.test(k)),
    }
  }

  return {
    ok: true, cnpj, loja: emp?.nome,
    consulta_por_cnpj: { status: porCnpj.status, corpo: txtCnpj.slice(0, 400) },
    na_lista: achadaNaLista,
    csc_no_emissor: csc,
  }
}

// ─────────────────────────────────────────────────────────────────────
// REGISTRAR EMPRESA — sobe o A1 + CSC pro Focus (loja pronta pra emitir)
// ─────────────────────────────────────────────────────────────────────
async function registrarEmpresa(sb: any, empresaId: string, senhaCert: string, dryRun = false) {
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
  const token = tokenPrincipal()
  if (!token) return { ok: false, error: "Token principal do Focus não configurado na plataforma" }

  // Lê o .pfx do bucket privado e converte pra base64
  const dl = await sb.storage.from("certificados-fiscais").download(fis.certificado_ref)
  if (dl.error || !dl.data) return { ok: false, error: `não consegui ler o certificado: ${dl.error?.message ?? "arquivo ausente"}` }
  const certB64 = toBase64(await dl.data.arrayBuffer())

  // O CSC E POR AMBIENTE, E OS DOIS VAO JUNTOS (24/10/2026)
  //
  // A SEFAZ emite um codigo pra homologacao e outro pra producao — na Agv os
  // quatro existem lado a lado no portal. Antes a tabela guardava um so, e o
  // cadastro levava so o do ambiente atual. As duas coisas somadas davam a
  // mesma estreia ruim: virar a chave pra producao com o campo de la vazio, e
  // a nota sair sem assinatura no QR ou ser rejeitada.
  //
  // Agora o cadastro leva os dois de uma vez. `fis.csc` fica como reserva, pras
  // lojas cadastradas antes das colunas por ambiente (mig 0383).
  const cscHomolog = fis.csc_homologacao || (ambiente !== "producao" ? fis.csc : null)
  const cscIdHomolog = fis.csc_id_homologacao || (ambiente !== "producao" ? fis.csc_id : null)
  const cscProd = fis.csc_producao || (ambiente === "producao" ? fis.csc : null)
  const cscIdProd = fis.csc_id_producao || (ambiente === "producao" ? fis.csc_id : null)

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
    csc_nfce_homologacao: cscHomolog || undefined,
    id_token_nfce_homologacao: cscIdHomolog || undefined,
    csc_nfce_producao: cscProd || undefined,
    id_token_nfce_producao: cscIdProd || undefined,
  }

  const base = `${FOCUS_REVENDA}/v2/empresas`
  const dry = dryRun ? "?dry_run=1" : ""
  // Tenta criar; se já existe (CNPJ duplicado), atualiza via PUT.
  let res = await fetch(base + dry, {
    method: "POST",
    headers: { "Authorization": authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  let txt = await res.text()

  if (!res.ok) {
    // Já cadastrada -> atualiza. O PUT também é por ID, não por CNPJ: com o
    // CNPJ ele dá 404 e a loja ficaria com o cadastro velho pra sempre, sem
    // ninguém notar (o POST já tinha falhado por duplicidade).
    if (res.status === 422 || /existe|cadastrad/i.test(txt)) {
      const id = await idNoEmissor(sb, empresaId, cnpj, token)
      if (id) {
        res = await fetch(`${base}/${id}${dry}`, {
          method: "PUT",
          headers: { "Authorization": authHeader(token), "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        txt = await res.text()
      }
    }
  }

  if (!res.ok) {
    await sb.from("empresa_fiscal").update({ ultimo_erro_fiscal: txt.slice(0, 500), focus_registrada: false }).eq("empresa_id", empresaId)
    return { ok: false, error: `Focus ${res.status}: ${txt.slice(0, 400)}` }
  }

  // Guarda o id que o emissor devolveu: é a chave de tudo depois daqui.
  const idDevolvido = (() => { try { return JSON.parse(txt)?.id } catch { return null } })()

  await sb.from("empresa_fiscal").update({
    focus_registrada: true,
    focus_registrada_em: new Date().toISOString(),
    ultimo_erro_fiscal: null,
    ...(idDevolvido ? { emissor_empresa_id: String(idDevolvido) } : {}),
  }).eq("empresa_id", empresaId)

  return { ok: true, mensagem: "Loja registrada no emissor. Já pode emitir NFC-e." }
}

// ─────────────────────────────────────────────────────────────────────
// EMITIR — monta a NFC-e do pedido e manda pro Focus (síncrono)
// ─────────────────────────────────────────────────────────────────────
const PAGAMENTO_FOCUS: Record<string, string> = {
  dinheiro: "01", credito: "03", debito: "04", cartao: "03",
  // Pra SEFAZ os dois PIX são a mesma coisa (17 = pagamento instantâneo):
  // muda só QUANDO o cliente paga, não o meio.
  pix: "17", pix_entrega: "17", online: "17", vale: "10", outro: "99",
  // Cartões de benefício (mig 0388): 11 = vale-refeição. Restaurante recebe pelo
  // lado refeição; se algum dia a loja vender mercado, o certo passa a ser 10.
  pluxee: "11", alelo: "11", vr: "11", ticket: "11",
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
  const token = await tokenDaLoja(sb, ped.empresa_id, cnpj, ambiente)
  if (!token) return { ok: false, error: `Não consegui o token do Focus desta loja (${ambiente}). Registre a loja de novo em Minha Loja → Nota Fiscal` }

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
  // Pagamento em duas formas (mig 0274): cada parte sai como uma forma na nota.
  const partesPag: { forma: string; valor: number }[] =
    Array.isArray(ped.pagamentos) && ped.pagamentos.length > 1
      ? ped.pagamentos.map((x: { forma: string; valor: number }) => ({ forma: String(x.forma ?? "outro").toLowerCase(), valor: Number(x.valor) || 0 }))
      : [{ forma: String(ped.forma_pagamento ?? "outro").toLowerCase(), valor: total }]
  const formasNota = partesPag.map(x => ({
    forma_pagamento: PAGAMENTO_FOCUS[x.forma] ?? "99",
    valor_pagamento: Number(x.valor.toFixed(2)),
  }))

  const ref = `nfce-${pedidoId}`
  const nfce: Record<string, unknown> = {
    cnpj_emitente: cnpj,
    data_emissao: new Date().toISOString(),
    natureza_operacao: "VENDA AO CONSUMIDOR",
    presenca_comprador: "1",
    modalidade_frete: "9",
    local_destino: "1",
    items,
    formas_pagamento: formasNota,
  }
  // NOME DE CLIENTE SO EXISTE SE TIVER CPF (24/10/2026)
  //
  // Na NFC-e o bloco do destinatario comeca obrigatoriamente por CNPJ, CPF ou
  // idEstrangeiro; o nome vem DEPOIS. Mandando so o nome, a SEFAZ rejeita no
  // proprio leiaute: "Element 'xNome': This element is not expected".
  //
  // E o nosso caso comum: quase todo pedido tem nome do cliente e NENHUM CPF,
  // porque ninguem pede CPF na nota pra comprar quentinha. Entao, sem CPF, o
  // pedido sai como consumidor nao identificado — que e o certo pra NFC-e.
  const cpfLimpo = soDigitos(cpf)
  if (cpfLimpo.length === 11) {
    nfce.cpf_destinatario = cpfLimpo
    if (ped.cliente_nome && ped.cliente_nome !== "Cliente iFood") nfce.nome_destinatario = ped.cliente_nome
  }

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
  const { data: empNota } = await sb.from("empresas").select("cnpj").eq("id", nota?.empresa_id).maybeSingle()
  const token = await tokenDaLoja(sb, nota?.empresa_id, soDigitos(empNota?.cnpj), ambiente)
  if (!token) return { ok: false, error: `Não consegui o token do Focus desta loja (${ambiente})` }

  const res = await fetch(`${FOCUS_HOST[ambiente]}/v2/nfce/${encodeURIComponent(ref)}`, {
    headers: { "Authorization": authHeader(token) },
  })
  const data = await res.json().catch(() => ({}))
  const patch = mapearRetornoFocus(data, ambiente)
  if (nota?.id) await sb.from("nfce_notas").update(patch).eq("id", nota.id)
  return { ok: patch.status === "autorizada", status: patch.status, retorno: data }
}

// ─────────────────────────────────────────────────────────────────────
// CANCELAR — a SEFAZ aceita por um prazo curto (em geral 30 min na NFC-e;
// depois disso o cancelamento é por evento e pode ser recusado).
// A nota só cancela se for da loja de quem está logado.
// ─────────────────────────────────────────────────────────────────────
async function cancelar(sb: any, req: Request, notaId?: string, justificativa?: string) {
  if (!notaId) return { ok: false, error: "nota_id obrigatório" }
  const just = String(justificativa ?? "").trim()
  if (just.length < 15) return { ok: false, error: "Escreva o motivo do cancelamento (mínimo 15 letras)" }

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
  const { data: u } = await sb.auth.getUser(jwt)
  if (!u?.user) return { ok: false, error: "sessão inválida" }
  const { data: prof } = await sb.from("profiles").select("empresa_id, perfil").eq("id", u.user.id).maybeSingle()

  const { data: nota } = await sb.from("nfce_notas").select("*").eq("id", notaId).maybeSingle()
  if (!nota) return { ok: false, error: "nota não encontrada" }
  if (prof?.perfil !== "super_admin" && prof?.empresa_id !== nota.empresa_id) return { ok: false, error: "sem permissão" }
  if (nota.status !== "autorizada") return { ok: false, error: "só dá pra cancelar nota autorizada" }

  const { data: emp } = await sb.from("empresas").select("cnpj").eq("id", nota.empresa_id).maybeSingle()
  const ambiente = nota.ambiente === "producao" ? "producao" : "homologacao"
  const token = await tokenDaLoja(sb, nota.empresa_id, soDigitos(emp?.cnpj), ambiente)
  if (!token) return { ok: false, error: "Não consegui o token do Focus desta loja" }

  const res = await fetch(`${FOCUS_HOST[ambiente]}/v2/nfce/${encodeURIComponent(nota.ref)}`, {
    method: "DELETE",
    headers: { "Authorization": authHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ justificativa: just }),
  })
  const data = await res.json().catch(() => ({}))
  const okFocus = res.ok && /cancel/i.test(String(data?.status ?? ""))
  if (!okFocus) {
    return { ok: false, error: data?.mensagem_sefaz ?? data?.mensagem ?? `Focus ${res.status}` }
  }
  await sb.from("nfce_notas").update({ status: "cancelada", motivo_rejeicao: `Cancelada: ${just}` }).eq("id", notaId)
  return { ok: true, mensagem: "Nota cancelada na SEFAZ." }
}

// Traduz o retorno do Focus pro nosso registro nfce_notas
function mapearRetornoFocus(data: any, ambiente: string): Record<string, unknown> {
  const host = FOCUS_HOST[ambiente as "homologacao" | "producao"]
  const st = String(data?.status ?? "").toLowerCase()
  let status = "processando"
  if (st === "autorizado") status = "autorizada"
  else if (st.includes("erro") || st === "rejeitado" || st === "denegado") status = "rejeitada"
  else if (st === "cancelado") status = "cancelada"
  // RESPOSTA SEM STATUS E ERRO, NAO ESPERA (24/10/2026)
  // Quando o emissor recusa a nota ele devolve {codigo, mensagem} e NENHUM
  // status. Caindo no padrao, a nota ficava "processando" pra sempre e a
  // consulta seguinte dizia "nota nao encontrada" — ninguem descobria o motivo
  // real, que estava escrito ali na primeira resposta.
  else if (!st && (data?.codigo || data?.mensagem || data?.erros)) status = "rejeitada"

  const patch: Record<string, unknown> = { status }
  if (data?.chave_nfe) patch.chave_acesso = data.chave_nfe
  if (data?.numero) patch.numero = Number(soDigitos(data.numero)) || null
  if (data?.serie) patch.serie = Number(soDigitos(data.serie)) || null
  if (data?.qrcode_url) patch.qrcode_url = data.qrcode_url
  if (data?.caminho_danfe) patch.danfe_url = data.caminho_danfe.startsWith("http") ? data.caminho_danfe : host + data.caminho_danfe
  if (data?.caminho_xml_nota_fiscal) patch.xml_url = data.caminho_xml_nota_fiscal.startsWith("http") ? data.caminho_xml_nota_fiscal : host + data.caminho_xml_nota_fiscal
  if (status === "rejeitada") {
    patch.motivo_rejeicao = data?.mensagem_sefaz ?? data?.mensagem ?? data?.erros?.[0]?.mensagem
      ?? (data?.codigo ? String(data.codigo) : null)
      ?? JSON.stringify(data ?? {}).slice(0, 300)
  }
  return patch
}
