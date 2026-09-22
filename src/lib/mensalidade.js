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

  let diaBloqueio = diaDoBloqueio(venc, Number(situacao.carencia_dias ?? 2), loja)
  // Prazo combinado que vai além da carência: trava no primeiro dia de
  // funcionamento DEPOIS do prazo — e, como no bloqueio normal, só a partir da
  // abertura. Antes travava à meia-noite, no meio do expediente de quem vira
  // a madrugada (Saidera).
  if (situacao.prazo_ate && situacao.prazo_ate >= diaBloqueio) {
    diaBloqueio = diaDoBloqueio(situacao.prazo_ate, 0, loja)
  }
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

/** Soma meses sem estourar o mês (31/01 + 1 mês = 28/02, igual ao Postgres). */
export function somaMesesYmd(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const ultimo = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, ultimo))).toISOString().slice(0, 10)
}

/**
 * Os vencimentos que o plano atual gera, do 1º vencimento até `ate`.
 * Mesma conta de mensalidade_gerar() no banco (migs 0263/0272) — serve pra
 * apontar na tela a cobrança que sobrou de um plano anterior.
 */
export function vencimentosDoPlano(cfg, ate) {
  const venc = []
  if (!cfg?.ativa || !cfg.inicio || !(Number(cfg.valor) > 0)) return venc
  let dia = cfg.inicio
  if (cfg.periodicidade === 'quinzenal') {
    const d = Number(dia.slice(8, 10))
    const mes = dia.slice(0, 7)
    if (d > 15) dia = `${somaMesesYmd(`${mes}-01`, 1).slice(0, 7)}-01`
    else if (d !== 1) dia = `${mes}-15`
  }
  for (let n = 0; dia <= ate && n < 520; n++) {
    venc.push(dia)
    if (cfg.periodicidade === 'semanal') dia = somaDiasYmd(cfg.inicio, 7 * (n + 1))
    else if (cfg.periodicidade === 'quinzenal') {
      dia = dia.slice(8, 10) === '01' ? `${dia.slice(0, 7)}-15` : `${somaMesesYmd(`${dia.slice(0, 7)}-01`, 1).slice(0, 7)}-01`
    } else dia = somaMesesYmd(cfg.inicio, n + 1)
  }
  return venc
}

// "semana" | "quinzena" | "mês" — quinzenal vence dia 1 e dia 15 (mig 0272).
export const periodoTexto = (periodicidade) =>
  periodicidade === 'semanal' ? 'semana' : periodicidade === 'quinzenal' ? 'quinzena' : 'mês'

// Quanto a cobrança dá por semana, pra somar lojas com planos diferentes.
export const valorPorSemana = (cfg) => {
  const v = Number(cfg?.valor) || 0
  if (cfg?.periodicidade === 'semanal') return v
  if (cfg?.periodicidade === 'quinzenal') return v * 24 / 52
  return v * 12 / 52
}

export const dataCurtaBR = (ymd) => {
  const [y, m, d] = String(ymd ?? '').split('-')
  if (!d) return ymd ?? ''
  const semana = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][new Date(Number(y), Number(m) - 1, Number(d)).getDay()]
  return `${semana} ${d}/${m}`
}
