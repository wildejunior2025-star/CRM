// Utilidades da conciliação iFood (datas, números, chaves).

export const ymd = (d: Date) => d.toISOString().slice(0, 10)
export const addDias = (d: Date, n: number) => new Date(d.getTime() + n * 86400000)

export const numOuNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const dataValida = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null

// Segunda-feira da semana da data (em UTC — as datas do iFood vêm sem hora).
export function segunda(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dia = x.getUTCDay() // 0 = domingo
  return addDias(x, dia === 0 ? -6 : 1 - dia)
}

// Semanas de liquidação (seg-dom) que cobrem os últimos `dias`, da mais antiga
// pra mais nova. O guia do iFood manda consultar nesses limites: "não consulte
// intervalos de datas arbitrários; use limites de semana de liquidação".
export function semanasDeLiquidacao(dias: number, hoje = new Date()): { ini: string; fim: string }[] {
  const out: { ini: string; fim: string }[] = []
  for (let s = segunda(addDias(hoje, -dias)); s <= hoje; s = addDias(s, 7)) {
    out.push({ ini: ymd(s), fim: ymd(addDias(s, 6)) })
  }
  return out
}

// Competências válidas pro relatório mensal: só meses COMPLETOS (o atual ainda
// recebe lançamento) e no máximo 24 meses pra trás (o iFood arquiva o resto).
export function competenciaValida(comp: string, hoje = new Date()): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(comp ?? ""))
  if (!m) return "Competência inválida — use AAAA-MM."
  const ano = Number(m[1]), mes = Number(m[2])
  if (mes < 1 || mes > 12) return "Mês inválido."
  const idx = ano * 12 + (mes - 1)
  const atual = hoje.getUTCFullYear() * 12 + hoje.getUTCMonth()
  if (idx >= atual) return "O relatório só pode ser gerado para meses já encerrados."
  if (atual - idx > 24) return "O iFood só guarda relatórios dos últimos 24 meses."
  return null
}

export async function sha256(texto: string): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto))
  return Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

export const redondo = (n: number) => Math.round(n * 100) / 100

// Grava em lotes (o PostgREST não gosta de requisição gigante).
export async function gravarEmLotes(sb: any, tabela: string, linhas: any[], onConflict: string) {
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await sb.from(tabela).upsert(linhas.slice(i, i + 500), { onConflict })
    if (error) throw new Error(`gravar ${tabela}: ${error.message}`)
  }
}
