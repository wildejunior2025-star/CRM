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
 * Monta a mensagem trocando {nome} e {link}.
 *
 * Sem cadastro, o {nome} some junto com a vírgula que sobraria: "Oi , ! 👋" é
 * pior do que não chamar pelo nome. E se o texto não tiver {link}, o link entra
 * no fim — saudação sem link é o robô conversando por conversar.
 */
export function montarPrimeiraFala(modelo, nome, link) {
  const texto = (String(modelo ?? '').trim() || TEXTO_PRIMEIRA_FALA_PADRAO)
  const comLink = texto.includes('{link}') ? texto : `${texto}\n{link}`
  return comLink
    .replace(/\{nome\}/g, nome ?? '')
    .replace(/\{link\}/g, link ?? '')
    .replace(/,[ ]*,/g, ',')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/[ ]+([!?.,:])/g, '$1')
    .replace(/,[ ]*([!?.])/g, '$1')
    .replace(/(^|\n)[ ,]+/g, '$1')
    .trim()
}
