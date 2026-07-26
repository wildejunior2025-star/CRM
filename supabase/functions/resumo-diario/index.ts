import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" }
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
// A instância do WhatsApp da plataforma vem do banco (config_global
// .admin_sender_instance), que é onde o Super Admin salva ao parear o QR.
// Estava fixo em "crmadmin" e a instância real se chama "CRM": a Evolution
// respondia 404 e NENHUM resumo saía — sem ninguém perceber, porque a função
// retornava ok:true com enviadas:0.
const FALLBACK_INSTANCE = "crmadmin"
const OFFSET = 3            // BRT = UTC-3
const fmt = (v: number) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })
const validPed = (s: string) => !["cancelado", "aguardando_pagamento"].includes(s)

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } })
  try {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return json({ ok: false, error: "Evolution API não configurada" }, 503)
    const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

    let empresaId: string | null = null
    // telefone: destino alternativo (teste) — manda o resumo da loja pra outro
    // número sem mexer no telefone_contato cadastrado.
    let telefoneTeste: string | null = null
    // data: "AAAA-MM-DD" pra reenviar o resumo de um dia passado.
    let dataAlvo: string | null = null
    // forcar: manda mesmo sem venda nenhuma (botão "Receber agora" da Dashboard,
    // pra quem clicou não ficar achando que quebrou).
    let forcar = false
    try {
      const body = await req.json()
      empresaId = body?.empresa_id ?? null
      telefoneTeste = body?.telefone ?? null
      dataAlvo = body?.data ?? null
      forcar = body?.forcar === true
    } catch { empresaId = null }

    const { data: cfg } = await sb.from("config_global").select("valor").eq("chave", "admin_sender_instance").maybeSingle()
    const INSTANCE = (cfg?.valor ?? "").trim() || FALLBACK_INSTANCE

    // Janela do dia e do mês em horário de Brasília
    const nowUtc = new Date()
    const brt = new Date(nowUtc.getTime() - OFFSET * 3600 * 1000)
    const alvo = (dataAlvo ?? "").match(/^\d{4}-\d{2}-\d{2}$/) ? dataAlvo!.split("-").map(Number) : null
    const hoje = !alvo
    const y = alvo ? alvo[0] : brt.getUTCFullYear()
    const mo = alvo ? alvo[1] - 1 : brt.getUTCMonth()
    const d = alvo ? alvo[2] : brt.getUTCDate()
    const dayStart = new Date(Date.UTC(y, mo, d) + OFFSET * 3600 * 1000).toISOString()
    // Fim do dia: sem ele, um resumo de ontem pegaria as vendas de hoje junto.
    const dayEnd = new Date(Date.UTC(y, mo, d + 1) + OFFSET * 3600 * 1000).toISOString()
    const monthStart = new Date(Date.UTC(y, mo, 1) + OFFSET * 3600 * 1000).toISOString()
    const dataBR = `${String(d).padStart(2, "0")}/${String(mo + 1).padStart(2, "0")}`

    let q = sb.from("empresas").select("id, nome, telefone_contato, meta_faturamento_mensal, status")
      .in("status", ["ativo", "trial", "atrasado"])
    if (empresaId) q = q.eq("id", empresaId)
    const { data: empresas } = await q

    let enviadas = 0, falhas = 0, puladas = 0, erro: string | null = null
    for (const emp of (empresas ?? [])) {
      const fone = ((telefoneTeste && empresaId) ? telefoneTeste : (emp.telefone_contato ?? "")).replace(/\D/g, "")
      if (fone.length < 10) continue
      try {
        const [vMesRes, pMesRes, prodRes] = await Promise.all([
          sb.from("vendas").select("id, total, observacoes, created_at").eq("empresa_id", emp.id).neq("status", "cancelado").gte("created_at", monthStart).lt("created_at", dayEnd),
          sb.from("pedidos_delivery").select("total, origem, status, itens, created_at").eq("empresa_id", emp.id).gte("created_at", monthStart).lt("created_at", dayEnd),
          sb.from("produtos").select("id, nome").eq("empresa_id", emp.id),
        ])
        const vMes = vMesRes.data ?? [], pMes = pMesRes.data ?? []
        const nomes: Record<string, string> = {}; for (const p of (prodRes.data ?? [])) nomes[p.id] = p.nome

        let fat = 0, fatMes = 0, n = 0
        // O iFood PRECISA ser um canal próprio. Antes ele caía no "else" e era
        // somado ao Balcão: num dia real da Zebu o resumo disse "Canal campeão:
        // Balcão R$ 1.013,55" quando o balcão tinha vendido R$ 152 e o iFood
        // R$ 861. O dono lia o resumo e tirava a conclusão errada.
        const canal: Record<string, number> = {
          "📱 App": 0, "💬 WhatsApp/Loja": 0, "🍔 iFood": 0, "🍽️ Presencial": 0, "🛒 Balcão": 0,
        }
        const vendaIdsHoje: string[] = []
        for (const v of vMes) {
          const val = Number(v.total); fatMes += val
          if (v.created_at >= dayStart) {
            fat += val; n++; vendaIdsHoje.push(v.id)
            if ((v.observacoes || "").startsWith("Presencial")) canal["🍽️ Presencial"] += val
            else canal["🛒 Balcão"] += val
          }
        }
        for (const p of pMes) {
          if (!validPed(p.status)) continue
          const val = Number(p.total); fatMes += val
          if (p.created_at >= dayStart) {
            fat += val; n++
            if (p.origem === "app") canal["📱 App"] += val
            else if (p.origem === "whatsapp" || p.origem === "cardapio") canal["💬 WhatsApp/Loja"] += val
            else if (p.origem === "ifood") canal["🍔 iFood"] += val
            else canal["🛒 Balcão"] += val
          }
        }

        // top produto de hoje (venda_itens + itens do delivery)
        const agg: Record<string, number> = {}
        if (vendaIdsHoje.length) {
          const { data: itens } = await sb.from("venda_itens").select("produto_id, subtotal").in("venda_id", vendaIdsHoje)
          for (const it of (itens ?? [])) { const nm = nomes[it.produto_id] ?? "Produto"; agg[nm] = (agg[nm] || 0) + Number(it.subtotal) }
        }
        for (const p of pMes) {
          if (!validPed(p.status) || p.created_at < dayStart) continue
          for (const it of (Array.isArray(p.itens) ? p.itens : [])) {
            const nm = it.nome ?? "Item"; agg[nm] = (agg[nm] || 0) + Number(it.subtotal ?? (it.preco_unitario || 0) * (it.quantidade || 1))
          }
        }
        const top = Object.entries(agg).sort((a, b) => b[1] - a[1])[0]
        const canaisAtivos = Object.entries(canal).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
        const ticket = n > 0 ? fat / n : 0
        const meta = Number(emp.meta_faturamento_mensal ?? 0)
        const metaPct = meta > 0 ? Math.min(100, Math.round((fatMes / meta) * 100)) : null

        // Dia sem venda nenhuma (loja fechada, folga): não enche o WhatsApp do
        // dono com "nenhuma venda hoje". Só manda se ele pediu na mão.
        if (n === 0 && !forcar) { puladas++; continue }

        let msg = `🏪 *${emp.nome}* — Resumo ${hoje ? "de hoje" : "do dia"} (${dataBR})\n\n`
        if (n === 0) {
          msg += `Nenhuma venda registrada ${hoje ? "hoje ainda" : "nesse dia"}. 💤\n`
        } else {
          msg += `💰 Faturamento: *${fmt(fat)}*\n`
          msg += `🧾 ${n} ${n === 1 ? "venda" : "vendas"} · 🎟️ Ticket ${fmt(ticket)}\n`
          if (top) msg += `🏆 Mais vendido: ${top[0]}\n`
          // Quebra por canal em vez de só o campeão: com um canal só, o dono não
          // tem como saber de onde veio o resto do faturamento.
          if (canaisAtivos.length) {
            msg += `\n📊 Por canal:\n`
            for (const [nome, val] of canaisAtivos) msg += `   ${nome}: ${fmt(val)}\n`
          }
        }
        if (metaPct != null) msg += `🎯 Meta do mês: ${metaPct}% (${fmt(fatMes)} de ${fmt(meta)})\n`
        msg += `\n_FWC Inter_`

        const num = fone.startsWith("55") ? fone : "55" + fone
        const r = await fetch(`${EVOLUTION_API_URL}/message/sendText/${INSTANCE}`, {
          method: "POST", headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: num, text: msg }),
        })
        if (r.ok) enviadas++
        else {
          falhas++
          const txt = await r.text()
          erro = erro ?? `WhatsApp recusou (${r.status}): ${txt.slice(0, 200)}`
          console.error("envio falhou", emp.nome, txt)
        }
      } catch (e) { falhas++; erro = erro ?? String(e); console.error("erro empresa", emp.id, String(e)) }
    }
    return json({ ok: true, enviadas, puladas, falhas, erro, instancia: INSTANCE })
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})
