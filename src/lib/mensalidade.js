// Em que fase a mensalidade da loja está HOJE.
//
// Regra combinada com o Wilde (13/09/2026):
//   - no dia do vencimento: só um aviso pro administrador
//   - o dia do vencimento não conta; contam os N dias seguintes EM QUE A LOJA
//     ABRE (padrão 2) — folga, feriado e dia fechado na mão não entram
//   - no dia de funcionamento seguinte, a partir do horário de abertura: pop-up
//     fixo pro administrador e funcionário sem acesso, até pagar
//   Ex.: Saidera abre de quarta em diante e vence na segunda → carência quarta
//   e quinta → trava na abertura de sexta.
//
// Mesma conta em supabase/functions/_shared/mensalidadeFase.ts (WhatsApp).
import { comoFicaNoDia } from './feriados'

export function somaDiasYmd(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Primeiro dia em que a loja trava por aquela cobrança. */
export function diaDoBloqueio(vencimento, carenciaDias, loja) {
  let dia = vencimento
  let contados = 0
  for (let i = 0; i < 120; i++) {
    dia = somaDiasYmd(dia, 1)
    if (!comoFicaNoDia(dia, loja).aberto) continue
    if (contados < carenciaDias) { contados++; continue }
    return dia
  }
  return dia
}

/** Hora (HH:MM) em que a loja abre nesse dia, ou null se não tem horário. */
export function aberturaDoDia(ymd, loja) {
  const dia = comoFicaNoDia(ymd, loja)
  const inicios = (dia.periodos ?? []).map(p => p?.i).filter(Boolean).sort()
  return inicios[0] ?? null
}

/**
 * @param situacao  retorno de mensalidade_situacao()
 * @param loja      { grade, excecoes, fechaFeriado } (mesmo formato de feriados.js)
 * @param agora     Date (pra teste)
 * @returns {{ fase: 'sem_cobranca'|'em_dia'|'vence_hoje'|'carencia'|'prazo'|'liberado'|'bloqueio',
 *             vencimento?: string, diaBloqueio?: string, travaAgora: boolean }}
 */
export function faseDaMensalidade(situacao, loja, agora = new Date()) {
  if (!situacao?.ativa) return { fase: 'sem_cobranca', travaAgora: false }
  const hoje = situacao.hoje
  const venc = situacao.mais_antiga_vencida
  if (!venc) return { fase: 'em_dia', travaAgora: false }

  const diaBloqueio = diaDoBloqueio(venc, Number(situacao.carencia_dias ?? 2), loja)
  const base = { vencimento: venc, diaBloqueio }

  if (situacao.liberado_ate && new Date(situacao.liberado_ate) > agora) return { ...base, fase: 'liberado', travaAgora: false }
  if (situacao.prazo_ate && hoje <= situacao.prazo_ate) return { ...base, fase: 'prazo', travaAgora: false }
  if (hoje === venc) return { ...base, fase: 'vence_hoje', travaAgora: false }
  if (hoje < diaBloqueio) return { ...base, fase: 'carencia', travaAgora: false }

  // Chegou o dia: trava a partir do horário de abertura, nunca no meio do
  // expediente de ontem (bar que vira a madrugada ainda está no dia anterior).
  if (hoje > diaBloqueio) return { ...base, fase: 'bloqueio', travaAgora: true }
  const abre = aberturaDoDia(hoje, loja)
  const hm = agora.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' })
  return { ...base, fase: 'bloqueio', travaAgora: !abre || hm >= abre }
}

/** Quantos dias de funcionamento faltam até travar (contando hoje, se abre). */
export function diasAteTravar(hoje, diaBloqueio, loja) {
  let n = 0
  let dia = hoje
  for (let i = 0; i < 60 && dia < diaBloqueio; i++) {
    if (comoFicaNoDia(dia, loja).aberto) n++
    dia = somaDiasYmd(dia, 1)
  }
  return n
}

export const dataCurtaBR = (ymd) => {
  const [y, m, d] = String(ymd ?? '').split('-')
  if (!d) return ymd ?? ''
  const semana = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(Number(y), Number(m) - 1, Number(d)).getDay()]
  return `${semana} ${d}/${m}`
}
