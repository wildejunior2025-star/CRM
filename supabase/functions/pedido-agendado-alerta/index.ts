// Aviso pra LOJA quando entra um pedido agendado.
//
// O agendado nasce justamente quando a loja está fechada — gestor fechado,
// ninguém olhando o painel. Sem aviso, ela só descobre o pedido quando abrir
// (ou pior, quando o cliente chegar pra buscar). Com o aviso ela já compra o
// que falta e se organiza.
//
// POR QUE PELO NÚMERO DA FWC (Evolution), e não pelo WhatsApp da loja:
// este aviso é a PLATAFORMA falando com a loja — o mesmo caminho do alerta de
// estoque e do resumo diário (alertas-loja / resumo-diario). Pelo número da
// própria loja daria trabalho à toa: o dono nunca conversou com o próprio
// número, então não existe janela de 24h aberta e a Meta exigiria um template
// aprovado só pra isso — sem contar que seria tráfego a mais na WABA.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
// Instância do WhatsApp da plataforma (a mesma do alerta de estoque): vem do
// banco, não fixa no código.
const FALLBACK_INSTANCE = "crmadmin"

const brl = (v: unknown) => "R$ " + Number(v ?? 0).toFixed(2).replace(".", ",")
const qtd = (v: unknown) => {
  const n = Number(v ?? 1)
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",")
}

// "hoje às 14:30" / "amanhã às 09:00" / "qui 04/09 às 11:00", no fuso da loja.
function quandoTexto(iso: string, ate?: string | null): string {
  const d = new Date(iso)
  const fmt = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Fortaleza", ...o }).format(d)
  const dia = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d)
  const hoje = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date())
  const amanha = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Date.now() + 86400000))
  const hora = fmt({ hour: "2-digit", minute: "2-digit" })
  const horaFim = ate
    ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" }).format(new Date(ate))
    : null
  const janela = horaFim ? `das ${hora} às ${horaFim}` : `às ${hora}`
  if (dia === hoje) return `hoje ${janela}`
  if (dia === amanha) return `amanhã ${janela}`
  return `${fmt({ day: "2-digit", month: "2-digit" })} ${janela}`
}

// ── A loja está aberta AGORA? ────────────────────────────────
// Mesma regra da tela (src/lib/feriados.js), portada pra cá: exceção marcada na
// mão manda; depois feriado nacional, se a loja fecha em feriado; por último a
// grade da semana. O aviso só faz sentido com a loja FECHADA — aberta, tem
// gente no painel e a mensagem vira barulho.
function domingoDePascoa(ano: number): Date {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100
  const d = Math.floor(b / 4), e = b % 4
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mes = Math.floor((h + l - 7 * m + 114) / 31)
  const dia = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(ano, mes - 1, dia)
}

const p2 = (n: number) => String(n).padStart(2, "0")
const ymdDe = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const somaDias = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

function feriadosDoAno(ano: number): Set<string> {
  const pa = domingoDePascoa(ano)
  return new Set([
    `${ano}-01-01`, ymdDe(somaDias(pa, -48)), ymdDe(somaDias(pa, -47)), ymdDe(somaDias(pa, -46)),
    ymdDe(somaDias(pa, -2)), `${ano}-04-21`, `${ano}-05-01`, ymdDe(somaDias(pa, 60)),
    `${ano}-09-07`, `${ano}-10-12`, `${ano}-11-02`, `${ano}-11-15`, `${ano}-11-20`, `${ano}-12-25`,
  ])
}

const paraMin = (hm: string) => {
  const [h, m] = String(hm ?? "").slice(0, 5).split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

async function lojaFechadaAgora(sb: ReturnType<typeof createClient>, empresaId: string): Promise<boolean> {
  const { data: e } = await sb.from("empresas")
    .select("delivery_ativo, horarios_funcionamento, feriados_fecha").eq("id", empresaId).maybeSingle()
  if (!e) return false                       // sem config: não arrisca avisar à toa
  if (e.delivery_ativo === false) return true // pausa manual = fechada

  const hoje = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date())

  const { data: exc } = await sb.from("dias_excecao")
    .select("aberto, periodos").eq("empresa_id", empresaId).eq("data", hoje).maybeSingle()

  const grade = Array.isArray(e.horarios_funcionamento) && e.horarios_funcionamento.length === 7
    ? e.horarios_funcionamento as Array<{ aberto?: boolean; periodos?: Array<{ i?: string; f?: string }> }>
    : null

  let aberto: boolean
  let periodos: Array<{ i?: string; f?: string }>
  if (exc) {
    if (!exc.aberto) return true
    aberto = true
    periodos = Array.isArray(exc.periodos) && exc.periodos.length ? exc.periodos : []
  } else {
    const [y, m, d] = hoje.split("-").map(Number)
    const diaSemana = new Date(y, m - 1, d).getDay()
    if (e.feriados_fecha && feriadosDoAno(y).has(hoje)) return true
    if (!grade) return false                 // sem grade cadastrada = sem restrição
    aberto = !!grade[diaSemana]?.aberto
    periodos = Array.isArray(grade[diaSemana]?.periodos) ? grade[diaSemana].periodos! : []
  }

  if (!aberto) return true
  if (!periodos.length) return false         // aberto o dia inteiro

  const hm = new Date().toLocaleTimeString("en-GB", {
    hour12: false, timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit",
  })
  const agora = paraMin(hm)
  const dentro = periodos.some(pp => {
    if (!pp?.i || !pp?.f) return false
    const a = paraMin(pp.i), b = paraMin(pp.f)
    return a <= b ? (agora >= a && agora < b) : (agora >= a || agora < b)
  })
  return !dentro
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })

  try {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return json({ ok: false, erro: "Evolution nao configurada" }, 503)
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

    const { pedido_id } = await req.json()
    if (!pedido_id) return json({ ok: false, erro: "pedido_id obrigatorio" }, 400)

    const { data: p } = await sb
      .from("pedidos_delivery")
      .select("id, empresa_id, numero_pedido, cliente_nome, cliente_telefone, itens, total, tipo_entrega, forma_pagamento, agendado_para, agendado_ate, status, observacoes")
      .eq("id", pedido_id)
      .maybeSingle()

    if (!p) return json({ ok: true, ignorado: "pedido nao encontrado" })
    if (!p.agendado_para) return json({ ok: true, ignorado: "nao e agendado" })
    if (["cancelado", "aguardando_pagamento"].includes(String(p.status))) {
      return json({ ok: true, ignorado: "status " + p.status })
    }

    // Loja ABERTA no momento do pedido? Então tem gente no painel — o pedido
    // agendado aparece na aba Agendados e o WhatsApp seria só barulho.
    if (!(await lojaFechadaAgora(sb, p.empresa_id))) {
      console.log("[agendado] loja aberta, sem aviso:", p.id)
      return json({ ok: true, ignorado: "loja aberta" })
    }

    const { data: emp } = await sb
      .from("empresas").select("nome, telefone_contato").eq("id", p.empresa_id).maybeSingle()

    const fone = String(emp?.telefone_contato ?? "").replace(/\D/g, "")
    if (fone.length < 10) {
      console.log("[agendado] loja sem telefone_contato:", p.empresa_id)
      return json({ ok: true, ignorado: "loja sem telefone" })
    }
    const numero = fone.startsWith("55") ? fone : "55" + fone

    const itens = Array.isArray(p.itens) ? p.itens : []
    const linhas = itens.map((i: Record<string, unknown>) => {
      const q = qtd(i.quantidade ?? i.qtd ?? 1)
      const nome = String(i.nome ?? "item").trim()
      const comps = Array.isArray(i.complementos)
        ? (i.complementos as Record<string, unknown>[])
            .map(c => `${qtd(c.qtd ?? c.quantidade ?? 1)} ${String(c.nome ?? "").trim()}`)
            .filter(Boolean).join(", ")
        : ""
      return `• ${q}x ${nome}${comps ? `\n   ${comps}` : ""}`
    }).join("\n")

    const msg = [
      `🗓️ *${emp?.nome ?? "Sua loja"}* — pedido AGENDADO`,
      "",
      `*Para ${quandoTexto(p.agendado_para, p.agendado_ate)}*`,
      `Pedido #${p.numero_pedido ?? ""} · ${p.tipo_entrega === "retirada" ? "RETIRADA" : "ENTREGA"}`,
      `Cliente: ${p.cliente_nome ?? "—"}${p.cliente_telefone ? ` (${p.cliente_telefone})` : ""}`,
      "",
      linhas || "• (sem itens)",
      "",
      `Total: *${brl(p.total)}*`,
      p.observacoes ? `Obs: ${p.observacoes}` : null,
      "",
      // Ele já entra aceito de propósito: com a loja fechada não tem ninguém pra
      // clicar, e pedido esperando aceite morre sozinho no fim do prazo.
      "O pedido já está *aceito* e guardado no painel, na aba *Agendados*.",
      "Ele cai na cozinha sozinho perto da hora. Se não puder atender, cancele pelo painel e avise o cliente.",
      "",
      "_FWC Inter_",
    ].filter(l => l !== null).join("\n")

    const { data: cfg } = await sb.from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
    const instancia = (cfg?.valor ?? "").trim() || FALLBACK_INSTANCE

    const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ number: numero, text: msg }),
    })
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 250)
      console.error("[agendado] aviso NAO enviado", p.id, numero, txt)
      return json({ ok: false, erro: txt })
    }

    console.log("[agendado] aviso enviado", p.id, numero)
    return json({ ok: true })
  } catch (err) {
    console.error("[agendado] erro:", err)
    return json({ ok: false, erro: String(err) }, 500)
  }
})
