// Primeira fala do robô no WhatsApp — o texto que cada loja escreve.
//
// Gêmeo de `supabase/functions/_shared/respostaSemIA.ts` (TEXTO_PRIMEIRA_FALA_PADRAO
// e montarPrimeiraFala). Duas cópias porque a edge function roda no Deno e não
// enxerga o `src/`; quem mexer numa, mexe na outra — o que a loja vê na prévia
// tem que ser LETRA POR LETRA o que o cliente recebe.

export const TEXTO_PRIMEIRA_FALA_PADRAO = [
  'Oi {nome}! 👋',
  'Para entrega ou retirada, é só acessar nossa loja online 👇',
  '{link}',
  '',
  'Estamos à disposição!',
].join('\n')

/**
 * Monta a mensagem trocando {nome}, {link} e {horario}.
 *
 * Sem cadastro, o {nome} some junto com a vírgula que sobraria: "Oi , ! 👋" é
 * pior do que não chamar pelo nome. E se o texto não tiver {link}, o link entra
 * no fim — saudação sem link é o robô conversando por conversar.
 *
 * Dia sem faixa de horário: a linha do {horario} sai inteira, pra não sobrar
 * "Entregas ." pendurado no meio da mensagem.
 */
export function montarPrimeiraFala(modelo, nome, link, horario = '') {
  const texto = (String(modelo ?? '').trim() || TEXTO_PRIMEIRA_FALA_PADRAO)
  const comLink = texto.includes('{link}') ? texto : `${texto}\n{link}`
  const comHorario = horario
    ? comLink
    : comLink.split('\n').filter(l => !l.includes('{horario}')).join('\n')
  return comHorario
    .replace(/\{nome\}/g, nome ?? '')
    .replace(/\{link\}/g, link ?? '')
    .replace(/\{horario\}/g, horario ?? '')
    // O {horario} já chega com o "das" na frente. Quem escreveu "a partir das
    // {horario}" (o jeito natural de escrever) recebia "a partir das das 08:00".
    .replace(/\bdas\s+das\b/gi, 'das')
    .replace(/,[ ]*,/g, ',')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/[ ]+([!?.,:])/g, '$1')
    .replace(/,[ ]*([!?.])/g, '$1')
    .replace(/(^|\n)[ ,]+/g, '$1')
    .trim()
}

// "das 07:00 às 14:00" / "das 08:30 às 12:00 e das 14:00 às 18:00"
function textoDosPeriodos(periodos) {
  const partes = (periodos ?? [])
    .filter(p => p?.i && p?.f)
    .map(p => `das ${String(p.i).slice(0, 5)} às ${String(p.f).slice(0, 5)}`)
  if (!partes.length) return ''
  if (partes.length === 1) return partes[0]
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`
}

/**
 * A faixa de HOJE pela grade da semana (índice 0 = domingo, igual ao editor de
 * horários). Serve pra PRÉVIA da tela: o robô, na hora de mandar, ainda desconta
 * feriado e dia marcado na mão — coisa que só o servidor sabe.
 */
export function horarioDeHojeDaGrade(empresa) {
  const grade = Array.isArray(empresa?.horarios_funcionamento) ? empresa.horarios_funcionamento : null
  if (!grade || grade.length !== 7) return ''
  const hoje = grade[new Date().getDay()] ?? {}
  if (hoje.aberto === false) return ''
  return textoDosPeriodos(hoje.periodos)
}
