// Carteira da IA da loja: franquia do ciclo + saldo comprado.
//
// É a MESMA conta do assistente do Portal (assistente-loja) — o robô do WhatsApp
// que lança estoque e responde o dono gasta da mesma carteira. Preço de cada uso =
// custo real em dólar × cotação × margem (config_global.ia_cotacao_usd / ia_margem).
// Franquia paga primeiro; passou dela, sai de empresas.ia_saldo_centavos.
// Espelho da conta de assistente-loja/index.ts e src/lib/cicloIa.js — mexeu em um, mexa nos outros.

const OFFSET_BRT = 3
const diaBRT = (ts: string) => new Date(new Date(ts).getTime() - OFFSET_BRT * 3600_000).toISOString().slice(0, 10)
const hojeBRT = () => diaBRT(new Date().toISOString())
const iniISO = (dia: string) => new Date(`${dia}T00:00:00-03:00`).toISOString()

const diaDeRenovacao = (v: string | null | undefined) => {
  const d = Number(String(v ?? "").slice(8, 10))
  return d >= 1 && d <= 31 ? d : 1
}
const ultimoDia = (ano: number, mes: number) => new Date(Date.UTC(ano, mes, 0)).getUTCDate()
const diaNoMes = (ano: number, mes: number, dia: number) => Math.min(dia, ultimoDia(ano, mes))
const ymd = (a: number, m: number, d: number) => `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`

export function inicioDoCiclo(vencimento: string | null | undefined): string {
  const dia = diaDeRenovacao(vencimento)
  const [ano, mes, hojeDia] = hojeBRT().split("-").map(Number)
  if (hojeDia >= diaNoMes(ano, mes, dia)) return ymd(ano, mes, diaNoMes(ano, mes, dia))
  const mesAnt = mes === 1 ? 12 : mes - 1
  const anoAnt = mes === 1 ? ano - 1 : ano
  return ymd(anoAnt, mesAnt, diaNoMes(anoAnt, mesAnt, dia))
}

export type Carteira = {
  cotacao: number; margem: number; franquia: number; saldo: number
  gastoMes: number; franquiaRestante: number; disponivel: number
}

export async function verCarteira(admin: any, empresaId: string): Promise<Carteira> {
  const [cfg, emp] = await Promise.all([
    admin.from("config_global").select("chave, valor").in("chave", ["ia_cotacao_usd", "ia_margem"]),
    admin.from("empresas").select("ia_saldo_centavos, ia_franquia_centavos, vencimento").eq("id", empresaId).maybeSingle(),
  ])
  const mes = await admin.from("assistente_conversas").select("custo_brl")
    .eq("empresa_id", empresaId).gte("created_at", iniISO(inicioDoCiclo(emp.data?.vencimento)))
  const conf: Record<string, string> = {}
  for (const c of (cfg.data ?? [])) conf[c.chave] = c.valor
  // Configuração apagada tem que sair CARA, não de graça.
  const cotacao = Number(conf.ia_cotacao_usd) > 0 ? Number(conf.ia_cotacao_usd) : 5.5
  const margem = Number(conf.ia_margem) > 0 ? Number(conf.ia_margem) : 1.2
  const franquia = Number(emp.data?.ia_franquia_centavos ?? 500) / 100
  const saldo = Number(emp.data?.ia_saldo_centavos ?? 0) / 100
  const gastoMes = (mes.data ?? []).reduce((s: number, r: any) => s + Number(r.custo_brl || 0), 0)
  const franquiaRestante = Math.max(0, franquia - gastoMes)
  return { cotacao, margem, franquia, saldo, gastoMes, franquiaRestante, disponivel: franquiaRestante + saldo }
}

// Cobra um uso que JÁ aconteceu (custo em dólar) e grava no histórico do Super Admin.
export async function cobrar(
  admin: any, c: Carteira,
  o: { empresaId: string; userId: string; custoUsd: number; descricao: string; pergunta: string; resposta: string; modelo: string; canal: string; tokensIn?: number; tokensOut?: number },
): Promise<number> {
  const custoBrl = Math.round(o.custoUsd * c.cotacao * c.margem * 10000) / 10000
  const doSaldo = Math.max(0, custoBrl - Math.min(custoBrl, c.franquiaRestante))
  if (doSaldo > 0) {
    // Arredonda PRA CIMA: centavo perdido em todo uso vira prejuízo no fim do mês.
    const { error } = await admin.rpc("ia_mover_saldo", {
      p_empresa_id: o.empresaId, p_centavos: -Math.ceil(doSaldo * 100), p_tipo: "debito", p_descricao: o.descricao.slice(0, 120),
    })
    if (error) console.error("[carteiraIa] debito", error.message)
  }
  const { error: e2 } = await admin.from("assistente_conversas").insert({
    empresa_id: o.empresaId, user_id: o.userId, pergunta: o.pergunta.slice(0, 500), resposta: o.resposta.slice(0, 2000),
    tokens_in: o.tokensIn ?? 0, tokens_out: o.tokensOut ?? 0,
    custo_usd: Number(o.custoUsd.toFixed(6)), custo_brl: custoBrl, pago_com_saldo: Number(doSaldo.toFixed(4)),
    modelo: o.modelo, canal: o.canal,
  })
  if (e2) console.error("[carteiraIa] historico", e2.message)
  return custoBrl
}
