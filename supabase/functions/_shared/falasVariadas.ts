// AS FALAS DO ROBÔ VARIAM (19/11/2026)
//
// POR QUE EXISTE
// A CDBom levou 24h de restrição da Meta por "mensagens automáticas ou em
// massa". Um dos carimbos mais fáceis de reconhecer é a repetição literal: a
// mesma frase, com os mesmos emojis, saindo pra dezenas de números. Em 3 dias
// o robô dela mandou 79 vezes a MESMA mensagem de catálogo, 47 vezes o mesmo
// "Essa eu não sei te responder", 33 vezes o mesmo aviso de áudio — byte a
// byte igual.
//
// Gente não fala assim. Então o robô passa a ter 3 ou 4 jeitos de dizer cada
// coisa e sorteia um. Muda o texto, nunca muda o conteúdo: todas as versões
// dizem exatamente a mesma coisa, com o mesmo link e a mesma informação.
//
// NÃO É DRIBLE DE DETECÇÃO, é parar de parecer o que a gente não é: cada uma
// dessas mensagens é resposta a um cliente que escreveu primeiro.

const NL = String.fromCharCode(10)

/** Sorteia uma das versões. Sorteio em vez de rodízio: rodízio também vira padrão. */
export function umaDas(versoes: string[]): string {
  if (!versoes.length) return ""
  return versoes[Math.floor(Math.random() * versoes.length)]
}

/**
 * A loja pode escrever VÁRIAS versões do próprio texto, separadas por uma
 * linha só com `---`. Quem escreveu uma só continua com a dela, intacta: o
 * sistema não reescreve o texto de ninguém.
 */
export function versoesDoModelo(modelo: string): string[] {
  const texto = String(modelo ?? "")
  if (!texto.trim()) return []
  const partes = texto.split(new RegExp(`${NL}\\s*---+\\s*${NL}`))
    .map(p => p.trim()).filter(Boolean)
  return partes.length ? partes : [texto.trim()]
}

// ── Primeira fala: o cardápio ───────────────────────────────────────────────
// {nome}, {link} e {horario} são trocados depois, em montarPrimeiraFala.
export const PRIMEIRA_FALA = [
  [
    "Oi {nome}! 👋",
    "Para entrega ou retirada, é só acessar nossa loja online 👇",
    "{link}",
    "",
    "Estamos à disposição!",
  ].join(NL),
  [
    "Olá {nome}, tudo bem? 😊",
    "Nosso cardápio completo, com os preços de hoje, está aqui:",
    "{link}",
    "",
    "É só montar o pedido por aí que a gente já recebe.",
  ].join(NL),
  [
    "Oi {nome}, que bom te ver por aqui!",
    "Dá uma olhada no que temos hoje e peça por este link 👇",
    "{link}",
    "",
    "Qualquer dúvida é só chamar. 🙂",
  ].join(NL),
  [
    "Olá {nome}! 🙌",
    "Pra pedir é por aqui, com entrega ou retirada:",
    "{link}",
    "",
    "Se precisar de alguma coisa, é só falar.",
  ].join(NL),
]

// ── "Não sei responder isso" ────────────────────────────────────────────────
export const NAO_SEI = (marca: string) => [
  `Essa eu não sei te responder por aqui. 😅 Quer que eu ${marca} pra te ajudar?`,
  `Opa, essa fugiu de mim. 🤔 Posso ${marca} pra te explicar melhor?`,
  `Aí já não sei te dizer direito. Quer que eu ${marca}?`,
  `Essa aí é melhor com alguém da loja mesmo. 😊 Quer que eu ${marca}?`,
]

// ── "Já chamei alguém" ──────────────────────────────────────────────────────
export const CHAMEI_ALGUEM = [
  "Já chamei alguém aqui da loja pra falar com você. 🙌 Só um instante!",
  "Pronto, avisei a equipe — já já alguém te responde por aqui. 🙂",
  "Chamei a loja pra te atender. É rapidinho!",
  "Já passei pra alguém da loja. Só um minutinho que te respondem. 👍",
]

// ── "Não ouço áudio" ────────────────────────────────────────────────────────
export const SEM_AUDIO = [
  `Oi! 😊 Por aqui eu ainda não consigo ouvir áudio.${NL}Me escreve rapidinho o que você precisa?`,
  `Opa! Áudio eu ainda não consigo escutar. 🙈${NL}Pode mandar por escrito pra mim?`,
  `Oi! Esse áudio eu não consigo abrir por aqui.${NL}Se puder digitar, eu já te ajudo. 🙂`,
  `Olá! Ainda não escuto áudio, viu. 😅${NL}Me manda por escrito que eu resolvo.`,
]
