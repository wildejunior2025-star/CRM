// Quando começa e quando renova a franquia de IA de uma loja.
//
// NÃO é o dia 1 do mês. Cada loja tem o seu vencimento (empresas.vencimento):
// a CDBom vence dia 20, a Marajó dia 1. Contar pelo mês civil daria franquia
// nova no meio do ciclo de quem vence dia 20 — a loja usaria quase dois meses
// de IA pagando um.
//
// Loja em trial não tem vencimento ainda; para ela vale o dia 1, que é simples
// de explicar e não depende de uma data que ainda vai mudar.
//
// A mesma conta existe em supabase/functions/assistente-loja/index.ts, porque
// o servidor precisa dela pra decidir se bloqueia. Mexeu aqui, mexa lá.

const pad = (n) => String(n).padStart(2, '0')
const ultimoDiaDoMes = (ano, mes) => new Date(ano, mes, 0).getDate() // mes 1..12

// Dia do vencimento preso ao mês: quem vence dia 31 renova dia 30 em novembro.
const diaNoMes = (ano, mes, dia) => Math.min(dia, ultimoDiaDoMes(ano, mes))

/** Dia do mês em que a loja renova. Sem vencimento cadastrado, dia 1. */
export function diaDeRenovacao(empresa) {
  const v = empresa?.vencimento
  if (!v) return 1
  const dia = Number(String(v).slice(8, 10))
  return dia >= 1 && dia <= 31 ? dia : 1
}

/** Data (Date, meia-noite local) em que começou o ciclo que está correndo. */
export function inicioDoCiclo(empresa, hoje = new Date()) {
  const dia = diaDeRenovacao(empresa)
  const ano = hoje.getFullYear()
  const mes = hoje.getMonth() + 1
  // Já passou (ou é hoje) o dia de renovação deste mês? Então o ciclo começou
  // neste mês. Senão, começou no mês passado.
  if (hoje.getDate() >= diaNoMes(ano, mes, dia)) {
    return new Date(ano, mes - 1, diaNoMes(ano, mes, dia), 0, 0, 0, 0)
  }
  const mesAnt = mes === 1 ? 12 : mes - 1
  const anoAnt = mes === 1 ? ano - 1 : ano
  return new Date(anoAnt, mesAnt - 1, diaNoMes(anoAnt, mesAnt, dia), 0, 0, 0, 0)
}

/** Data em que a franquia renova (o próximo vencimento). */
export function proximaRenovacao(empresa, hoje = new Date()) {
  const ini = inicioDoCiclo(empresa, hoje)
  const dia = diaDeRenovacao(empresa)
  const ano = ini.getFullYear()
  const mes = ini.getMonth() + 2          // mês seguinte ao início do ciclo
  const anoFim = mes > 12 ? ano + 1 : ano
  const mesFim = mes > 12 ? 1 : mes
  return new Date(anoFim, mesFim - 1, diaNoMes(anoFim, mesFim, dia), 0, 0, 0, 0)
}

/** "20/09/2026" */
export const dataBR = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
