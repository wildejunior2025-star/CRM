import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import JSZip from "https://esm.sh/jszip@3.10.1"

// =====================================================================
// nfce-zip  —  ZIP com os XMLs das NFC-e de um mês (pro contador)
// ---------------------------------------------------------------------
// body: { mes: "2026-10" }   (mês de emissão, fuso de Brasília)
// A loja é a de quem está logado (RLS em nfce_notas). Inclui as notas
// autorizadas e canceladas (com o XML do cancelamento) + um LEIA-ME.txt.
// =====================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Expose-Headers": "X-Notas, X-Faltaram, Content-Disposition",
}

const FOCUS_HOST = { homologacao: "https://homologacao.focusnfe.com.br", producao: "https://api.focusnfe.com.br" }
const FOCUS_REVENDA = "https://api.focusnfe.com.br"

const authHeader = (t: string) => "Basic " + btoa(`${t}:`)
const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "")

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const erro = (msg: string, s = 400) =>
    new Response(JSON.stringify({ ok: false, error: msg }), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const mes = String(body?.mes ?? "")
  if (!/^\d{4}-\d{2}$/.test(mes)) return erro("informe o mês (AAAA-MM)")

  // Cliente com o JWT de quem chamou: o RLS deixa ver só as notas da própria loja.
  const sb = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  )

  // Janela do mês em Brasília (UTC-3, sem horário de verão).
  const [ano, m] = mes.split("-").map(Number)
  const ini = new Date(Date.UTC(ano, m - 1, 1, 3, 0, 0)).toISOString()
  const fim = new Date(Date.UTC(ano, m, 1, 3, 0, 0)).toISOString()

  const { data: notas, error } = await sb.from("nfce_notas")
    .select("id, empresa_id, status, ambiente, numero, serie, chave_acesso, xml_url, ref, created_at")
    .in("status", ["autorizada", "cancelada"])
    .gte("created_at", ini).lt("created_at", fim)
    .order("created_at", { ascending: true })
    .limit(5000)
  if (error) return erro(error.message, 500)
  if (!notas?.length) return erro("Nenhuma nota autorizada ou cancelada neste mês", 404)

  const empresaId = notas[0].empresa_id
  const { data: emp } = await sb.from("empresas").select("cnpj, nome").eq("id", empresaId).maybeSingle()
  const cnpj = soDigitos(emp?.cnpj)

  // Token de cada ambiente (a loja pode ter nota de teste e de produção)
  const principal = Deno.env.get("FOCUS_NFE_TOKEN_PRODUCAO") ?? ""
  const tokens: Record<string, string> = {}
  if (principal && cnpj) {
    const r = await fetch(`${FOCUS_REVENDA}/v2/empresas/${cnpj}`, { headers: { Authorization: authHeader(principal) } })
    const d = r.ok ? await r.json().catch(() => ({})) : {}
    if (d?.token_homologacao) tokens.homologacao = d.token_homologacao
    if (d?.token_producao) tokens.producao = d.token_producao
  }

  const abs = (host: string, p: string) => (p.startsWith("http") ? p : host + p)
  async function baixar(url: string, token?: string): Promise<string | null> {
    // os arquivos do Focus costumam ser abertos; se recusar, tenta com o token
    let r = await fetch(url)
    if ((r.status === 401 || r.status === 403) && token) r = await fetch(url, { headers: { Authorization: authHeader(token) } })
    return r.ok ? await r.text() : null
  }

  const zip = new JSZip()
  const faltou: string[] = []
  const linhas: string[] = []

  for (const n of notas) {
    const amb = n.ambiente === "producao" ? "producao" : "homologacao"
    const host = FOCUS_HOST[amb]
    const token = tokens[amb]
    const base = `${amb === "homologacao" ? "TESTE_" : ""}${String(n.numero ?? "s-n").padStart(6, "0")}_${n.chave_acesso ?? n.id}`

    let xml: string | null = null
    if (n.xml_url) xml = await baixar(abs(host, n.xml_url), token)
    if (xml) zip.file(`${n.status === "cancelada" ? "canceladas/" : "autorizadas/"}${base}.xml`, xml)
    else faltou.push(`nota ${n.numero ?? n.id}`)

    if (n.status === "cancelada" && token && n.ref) {
      const r = await fetch(`${host}/v2/nfce/${encodeURIComponent(n.ref)}`, { headers: { Authorization: authHeader(token) } })
      const d = r.ok ? await r.json().catch(() => ({})) : {}
      if (d?.caminho_xml_cancelamento) {
        const xc = await baixar(abs(host, d.caminho_xml_cancelamento), token)
        if (xc) zip.file(`canceladas/${base}_CANCELAMENTO.xml`, xc)
        else faltou.push(`cancelamento da nota ${n.numero ?? n.id}`)
      }
    }
    linhas.push(`${n.numero ?? "-"}\t${n.status}\t${amb}\t${n.chave_acesso ?? ""}`)
  }

  zip.file("LEIA-ME.txt", [
    `NFC-e de ${mes} — ${emp?.nome ?? ""} (CNPJ ${cnpj})`,
    `Notas no arquivo: ${notas.length}`,
    "Pastas: autorizadas/ e canceladas/ (canceladas trazem também o XML do cancelamento).",
    "Arquivos que começam com TESTE_ são notas de homologação e não têm valor fiscal.",
    faltou.length ? `\nNão consegui baixar o XML de: ${faltou.join(", ")}` : "",
    "\nnúmero\tstatus\tambiente\tchave",
    ...linhas,
  ].join("\n"))

  const bin = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  return new Response(bin, {
    headers: {
      ...cors,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="nfce-${mes}.zip"`,
      "X-Notas": String(notas.length),
      "X-Faltaram": String(faltou.length),
    },
  })
})
