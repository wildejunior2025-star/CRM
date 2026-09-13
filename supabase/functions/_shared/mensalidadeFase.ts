// Mesma conta de src/lib/mensalidade.js — aqui pro envio do WhatsApp.
// O dia do vencimento não conta; contam os N dias seguintes em que a loja
// abre; no dia de funcionamento seguinte a loja trava.
import { comoFicaNoDia } from "./respostaSemIA.ts"

export function somaDiasYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function diaDoBloqueio(
  vencimento: string,
  carenciaDias: number,
  empresa: Record<string, unknown>,
  excecoes: Record<string, Record<string, unknown>>,
): string {
  let dia = vencimento
  let contados = 0
  for (let i = 0; i < 120; i++) {
    dia = somaDiasYmd(dia, 1)
    if (!comoFicaNoDia(dia, empresa, excecoes).aberto) continue
    if (contados < carenciaDias) { contados++; continue }
    return dia
  }
  return dia
}
