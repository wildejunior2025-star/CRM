import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// =====================================================================
// nfe-por-chave  —  busca o XML de uma NF-e RECEBIDA pela chave de 44 dígitos (Focus NFe)
// ---------------------------------------------------------------------
// Usada pela tela "Lançar compra": o dono bipa/digita a chave do DANFE e a tela
// preenche fornecedor, itens e parcelas a partir do XML.
//
// Entrada: { empresa_id, chave, acao?: "buscar" | "ciencia" }
// Saída (sempre HTTP 200 quando a pergunta foi respondida):
//   { ok: true, xml }                          -> XML completo da nota
//   { ok: false, motivo, mensagem? }           -> motivo:
//        chave_invalida | sem_fiscal | focus_desligado | nao_chegou
//        precisa_ciencia | aguardando | xml_indisponivel | focus_erro | outra_loja
//
// SÓ LEITURA, com UMA exceção explícita: acao "ciencia" registra a "Ciência da Operação"
// da nota na Receita, em nome da loja. É um ato fiscal, então só roda quando o dono
// clica nesse botão — nunca sozinho.
//
// O recurso "NFe recebidas" precisa estar LIGADO na empresa dentro da Focus
// (habilita_manifestacao). Desligado, a função responde focus_desligado e a tela
// cai pra leitura por foto.
//
// Secrets: FOCUS_NFE_TOKEN_PRODUCAO (conta principal da FWC)
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}
const HOST = "https://api.focusnfe.com.br"
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })
const auth = (t: string) => "Basic " + btoa(`${t}:`)
const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "")

// Dígito verificador da chave (módulo 11, pesos 2..9 da direita pra esquerda).
function chaveValida(c: string): boolean {
  if (!/^\d{44}$/.test(c)) return false
  let soma = 0
  let peso = 2
  for (let i = 42; i >= 0; i--) {
    soma += Number(c[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const r = soma % 11
  const dv = r === 0 || r === 1 ? 0 : 11 - r
  return dv === Number(c[43])
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const chave = soDigitos(body?.chave)
    const empresaId = String(body?.empresa_id ?? "")
    const acao = body?.acao === "ciencia" ? "ciencia" : "buscar"
    if (!chaveValida(chave)) return json({ ok: false, motivo: "chave_invalida", mensagem: "Essa chave não está certa. Confira os 44 números." })
    if (!empresaId) return json({ ok: false, motivo: "sem_fiscal", mensagem: "Loja não informada." }, 400)

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)

    // Quem pergunta tem que ser administrador DESTA loja (ou o super admin).
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "")
    const { data: u } = await sb.auth.getUser(jwt)
    if (!u?.user) return json({ ok: false, motivo: "sem_login" }, 401)
    const { data: prof } = await sb.from("profiles").select("empresa_id, perfil").eq("id", u.user.id).maybeSingle()
    const permitido = prof?.perfil === "super_admin" || (prof?.empresa_id === empresaId && prof?.perfil === "admin")
    if (!permitido) return json({ ok: false, motivo: "sem_permissao" }, 403)

    const principal = Deno.env.get("FOCUS_NFE_TOKEN_PRODUCAO")
    if (!principal) return json({ ok: false, motivo: "focus_desligado", mensagem: "A Focus não está configurada." })

    const { data: emp } = await sb.from("empresas").select("cnpj").eq("id", empresaId).maybeSingle()
    const cnpj = soDigitos(emp?.cnpj)
    const { data: fis } = await sb.from("empresa_fiscal").select("emissor_empresa_id").eq("empresa_id", empresaId).maybeSingle()
    let idFocus: string | null = fis?.emissor_empresa_id ? String(fis.emissor_empresa_id) : null
    if (!idFocus && cnpj) {
      // A loja se acha na Focus pelo ID interno, nunca pelo CNPJ (mesma regra da emissão de NFC-e).
      const lista = await fetch(`${HOST}/v2/empresas`, { headers: { Authorization: auth(principal) } })
      const d = await lista.json().catch(() => null)
      const todas = Array.isArray(d) ? d : (d?.empresas ?? [])
      const achou = todas.find((e: any) => soDigitos(e?.cnpj) === cnpj)
      if (achou?.id) idFocus = String(achou.id)
    }
    if (!idFocus) return json({ ok: false, motivo: "sem_fiscal", mensagem: "Esta loja ainda não está cadastrada na Focus." })

    const re = await fetch(`${HOST}/v2/empresas/${idFocus}`, { headers: { Authorization: auth(principal) } })
    const empFocus: any = await re.json().catch(() => ({}))
    if (!re.ok) return json({ ok: false, motivo: "focus_erro", mensagem: "A Focus não respondeu sobre a loja." })
    if (!empFocus?.habilita_manifestacao) return json({ ok: false, motivo: "focus_desligado" })
    const token: string | undefined = empFocus?.token_producao
    if (!token) return json({ ok: false, motivo: "focus_erro", mensagem: "Sem token da loja na Focus." })
    const H = { Authorization: auth(token) }

    const rn = await fetch(`${HOST}/v2/nfes_recebidas/${chave}`, { headers: H })
    if (rn.status === 404) return json({ ok: false, motivo: "nao_chegou" })
    if (!rn.ok) return json({ ok: false, motivo: "focus_erro", mensagem: (await rn.text()).slice(0, 200) })
    const nfe: any = await rn.json().catch(() => ({}))

    // Só nota feita PRA ESTA LOJA. (A Focus já filtra por CNPJ, mas a conferência é barata.)
    const dest = soDigitos(nfe?.cnpj_destinatario ?? nfe?.documento_destinatario)
    if (dest && cnpj && dest !== cnpj) return json({ ok: false, motivo: "outra_loja" })

    const completa = nfe?.nfe_completa === true || nfe?.nfe_completa === "true"
    if (!completa) {
      if (acao === "ciencia") {
        const m = await fetch(`${HOST}/v2/nfes_recebidas/${chave}/manifesto`, {
          method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ tipo: "ciencia" }),
        })
        if (!m.ok) return json({ ok: false, motivo: "focus_erro", mensagem: (await m.text()).slice(0, 200) })
        return json({ ok: false, motivo: "aguardando" })
      }
      return json({ ok: false, motivo: "precisa_ciencia", resumo: { emitente: nfe?.nome_emitente ?? null, valor: nfe?.valor_total ?? null } })
    }

    const caminho: string | undefined = nfe?.caminho_xml_nota_fiscal
    const urlXml = caminho ? (caminho.startsWith("http") ? caminho : `${HOST}${caminho}`) : `${HOST}/v2/nfes_recebidas/${chave}.xml`
    const rx = await fetch(urlXml, { headers: H })
    const xml = rx.ok ? await rx.text() : ""
    if (!xml.includes("<infNFe")) return json({ ok: false, motivo: "xml_indisponivel" })
    return json({ ok: true, xml })
  } catch (e) {
    console.error("nfe-por-chave:", e)
    return json({ ok: false, motivo: "focus_erro", mensagem: String((e as Error)?.message ?? e).slice(0, 200) }, 500)
  }
})
