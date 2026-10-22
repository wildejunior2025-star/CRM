// Entende frases de CONTAS A PAGAR / A RECEBER escritas no WhatsApp, sem IA.
//   "paguei 80 de gás"              → pagou hoje
//   "a pagar luz 350 dia 28"        → conta com vencimento
//   "recebi 200 do João"            → recebeu hoje
//   "a receber joão 200 vence 30/10"
// Funções PURAS (sem banco, sem Deno): dá pra testar com Node (contasParse.test.mjs).
// Entrada: texto JÁ normalizado (sem acento, minúsculo). Saída: o que a frase quer, ou null se não for conta.

export type ComandoConta = {
  acao: "pagar" | "receber" | "paguei" | "recebi"          // pagar/receber = lançar com vencimento; paguei/recebi = já aconteceu
  valor: number
  descricao: string
  pessoa: string | null
  vencimento: string | null                                 // AAAA-MM-DD; null = não disse
  forma: string | null
  categoria: string | null
  recorrencia: "mensal" | "semanal" | "quinzenal" | "anual" | null
}

const pad = (n: number) => String(n).padStart(2, "0")
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const doYmd = (s: string) => { const [a, m, d] = s.split("-").map(Number); return new Date(Date.UTC(a, m - 1, d, 12)) }
export const somaDiasYmd = (s: string, n: number) => { const d = doYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d) }
const ultimoDia = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate()

const DIAS_SEMANA: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 }

// Lê uma data dentro do texto e devolve o texto SEM ela. `hoje` = AAAA-MM-DD (fuso de Brasília).
export function extrairData(texto: string, hoje: string): { data: string | null; resto: string } {
  let t = ` ${texto} `
  const marca = "(?:\\s+(?:vence|vencendo|vencimento|venc|para o dia|pro dia|no dia|ate o dia|ate|em|dia))?"
  const [ano, mes, dia] = hoje.split("-").map(Number)
  let m: RegExpMatchArray | null

  // dd/mm/aaaa ou dd/mm
  if ((m = t.match(new RegExp(`${marca}\\s+(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{2,4}))?(?=\\s)`)))) {
    const d = Number(m[1]), mo = Number(m[2])
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      let a = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : ano
      let iso = `${a}-${pad(mo)}-${pad(Math.min(d, ultimoDia(a, mo)))}`
      // "28/02" dito em março: se não disse o ano e já passou há mais de 2 meses, é do ano que vem.
      if (!m[3] && iso < somaDiasYmd(hoje, -60)) { a += 1; iso = `${a}-${pad(mo)}-${pad(Math.min(d, ultimoDia(a, mo)))}` }
      return { data: iso, resto: t.replace(m[0], " ").replace(/\s+/g, " ").trim() }
    }
  }
  if ((m = t.match(new RegExp(`\\s+depois de amanha(?=\\s)`)))) return { data: somaDiasYmd(hoje, 2), resto: t.replace(m[0], " ").replace(/\s+/g, " ").trim() }
  if ((m = t.match(new RegExp(`${marca}\\s+amanha(?=\\s)`)))) return { data: somaDiasYmd(hoje, 1), resto: t.replace(m[0], " ").replace(/\s+/g, " ").trim() }
  if ((m = t.match(new RegExp(`${marca}\\s+hoje(?=\\s)`)))) return { data: hoje, resto: t.replace(m[0], " ").replace(/\s+/g, " ").trim() }
  // "em 5 dias"
  if ((m = t.match(/\s+em\s+(\d{1,3})\s+dias?(?=\s)/))) return { data: somaDiasYmd(hoje, Number(m[1])), resto: t.replace(m[0], " ").replace(/\s+/g, " ").trim() }
  // dia da semana: próxima ocorrência (hoje não conta)
  if ((m = t.match(new RegExp(`${marca}\\s+(?:proxima\\s+|na\\s+|no\\s+)?(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:\\s*-?\\s*feira)?(?=\\s)`)))) {
    const alvo = DIAS_SEMANA[m[1]]
    const atual = doYmd(hoje).getUTCDay()
    const falta = ((alvo - atual + 7) % 7) || 7
    return { data: somaDiasYmd(hoje, falta), resto: t.replace(m[0], " ").replace(/\s+/g, " ").trim() }
  }
  // "dia 28" → próxima vez que o dia 28 acontece (este mês se ainda não passou)
  if ((m = t.match(/\s+(?:vence\s+|vencimento\s+|venc\s+|para o\s+|pro\s+|no\s+|ate o\s+)?dia\s+(\d{1,2})(?=\s)/))) {
    const d = Number(m[1])
    if (d >= 1 && d <= 31) {
      let a = ano, mo = mes
      let iso = `${a}-${pad(mo)}-${pad(Math.min(d, ultimoDia(a, mo)))}`
      if (iso < hoje) { mo += 1; if (mo > 12) { mo = 1; a += 1 }; iso = `${a}-${pad(mo)}-${pad(Math.min(d, ultimoDia(a, mo)))}` }
      return { data: iso, resto: t.replace(m[0], " ").replace(/\s+/g, " ").trim() }
    }
  }
  void dia
  return { data: null, resto: t.replace(/\s+/g, " ").trim() }
}

// Valor em reais. Aceita "80", "80,50", "1.200,50", "r$ 350", "350 reais". Pega o PRIMEIRO número que parece dinheiro.
export function extrairValor(texto: string): { valor: number | null; resto: string } {
  const re = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(?:reais|real|conto|contos|pila|pilas))?/
  const m = texto.match(re)
  if (!m) return { valor: null, resto: texto }
  let bruto = m[1]
  if (bruto.includes(",")) bruto = bruto.replace(/\./g, "").replace(",", ".")
  else if (/^\d{1,3}(\.\d{3})+$/.test(bruto)) bruto = bruto.replace(/\./g, "")
  const valor = Number(bruto)
  if (!Number.isFinite(valor) || valor <= 0) return { valor: null, resto: texto }
  return { valor, resto: texto.replace(m[0], " ").replace(/\s+/g, " ").trim() }
}

const FORMAS: Record<string, string> = { pix: "pix", dinheiro: "dinheiro", especie: "dinheiro", cartao: "credito", credito: "credito", debito: "debito", boleto: "boleto", transferencia: "transferencia", ted: "transferencia", cheque: "cheque" }
const CATEGORIAS: [RegExp, string][] = [
  [/\b(luz|energia|eletric\w*|neoenergia|enel|cosern)\b/, "Energia"],
  [/\b(agua|saneamento|caern|sabesp)\b/, "Água"],
  [/\bgas\b|botijao/, "Gás"],
  [/\b(internet|telefone|celular|fibra|vivo|claro|tim|oi)\b/, "Internet e telefone"],
  [/\b(aluguel|locacao)\b/, "Aluguel"],
  [/\b(salario|funcionario|ajudante|folha|13o|decimo|ferias|inss|fgts)\b/, "Salários e encargos"],
  [/\b(imposto|das|simples|iptu|taxa de licenca|alvara|darf)\b/, "Impostos e taxas"],
  [/\b(maquininha|stone|cielo|getnet|taxa do cartao|ifood taxa)\b/, "Maquininha e taxas"],
  [/\b(manutencao|conserto|reparo|mecanico|eletricista|encanador)\b/, "Manutenção"],
  [/\b(propaganda|anuncio|marketing|panfleto|trafego)\b/, "Marketing"],
  [/\b(emprestimo|financiamento|parcela do banco)\b/, "Empréstimos"],
  [/\b(fornecedor|mercadoria|compra de|distribuidora|atacado|carne|frango|bebida|verdura|hortifruti)\b/, "Fornecedores"],
]
export const categoriaDe = (t: string, tipo: "pagar" | "receber"): string | null => {
  if (tipo === "receber") {
    if (/\bifood\b/.test(t)) return "Repasse iFood"
    if (/\b(cartao|maquininha|stone|cielo)\b/.test(t)) return "Repasse cartão"
    return /\b(venda|vendi|prazo|fiado|marmita|encomenda|evento|buffet)\b/.test(t) ? "Venda a prazo" : null
  }
  for (const [re, nome] of CATEGORIAS) if (re.test(t)) return nome
  return null
}

const RUIDO = new Set(["de", "do", "da", "dos", "das", "o", "a", "os", "as", "um", "uma", "pra", "para", "pro", "no", "na", "em", "ao", "e", "conta", "contas", "lancar", "lanca", "registrar", "registra", "anota", "anotar", "reais", "real", "r$", "ja", "agora", "hoje", "vou", "tenho", "que", "foi", "via"])

function limparDescricao(t: string): string {
  const palavras = t.split(/\s+/).filter((w) => w && !RUIDO.has(w))
  return palavras.join(" ").trim()
}

const capitaliza = (s: string) => s.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase())

// O texto vem SEM acento (pra casar regra). Devolve o acento e a cara original das palavras que a pessoa escreveu: joao → João.
export function restaurarAcentos(trecho: string, original: string): string {
  const sem = (w: string) => w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  const mapa = new Map<string, string>()
  for (const w of original.split(/\s+/)) { const limpo = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""); if (limpo) mapa.set(sem(limpo), limpo) }
  return trecho.split(" ").map((w) => { const o = mapa.get(sem(w)); if (!o) return w; return w[0] === w[0]?.toUpperCase() && w[0] !== w[0]?.toLowerCase() ? o.charAt(0).toUpperCase() + o.slice(1) : o }).join(" ")
}

// "paguei 80 de gas" → descricao "gas". Reconhece pessoa ("para o ze", "do joao"), forma (pix/dinheiro…) e repetição ("todo mes").
export function lerComandoConta(textoNorm: string, hoje: string, textoOriginal?: string): ComandoConta | null {
  // vírgula entre números é decimal (350,50): só some a vírgula de pontuação.
  let t = textoNorm.replace(/[?!]+$/g, "").replace(/(?<!\d),|,(?!\d)|;/g, " ").replace(/\s+/g, " ").trim()
  if (t.length < 4 || t.length > 120) return null

  let acao: ComandoConta["acao"] | null = null
  let m: RegExpMatchArray | null
  let resto = ""

  if ((m = t.match(/^(?:vou\s+|tenho\s+que\s+|preciso\s+)?(?:lancar\s+|registrar\s+|anotar\s+)?(?:uma\s+)?(?:conta\s+)?a\s+pagar\s+(.+)$/)) ||
      (m = t.match(/^(?:vou\s+|tenho\s+que\s+|preciso\s+)(?:pagar)\s+(.+)$/)) ||
      (m = t.match(/^(?:conta\s+)?pagar\s+(.+)$/))) { acao = "pagar"; resto = m[1] }
  else if ((m = t.match(/^(?:vou\s+|tenho\s+)?(?:lancar\s+|registrar\s+|anotar\s+)?(?:uma\s+)?(?:conta\s+)?a\s+receber\s+(.+)$/)) ||
           (m = t.match(/^(?:vou\s+)?receber\s+(.+)$/))) { acao = "receber"; resto = m[1] }
  else if ((m = t.match(/^(?:ja\s+)?(?:paguei|pagamos|pago)\s+(.+)$/))) { acao = "paguei"; resto = m[1] }
  else if ((m = t.match(/^(?:ja\s+)?(?:recebi|recebemos)\s+(.+)$/))) { acao = "recebi"; resto = m[1] }
  else if ((m = t.match(/^(.+?)\s+(?:me\s+)?pagou\s+(.+)$/))) { acao = "recebi"; resto = `${m[2]} de ${m[1]}` }   // "joao pagou 200"
  else if ((m = t.match(/^(.+?)\s+vai\s+(?:me\s+)?pagar\s+(.+)$/))) { acao = "receber"; resto = `${m[2]} de ${m[1]}` } // "joao vai pagar 200 dia 30"
  if (!acao) return null

  const { data, resto: semData } = extrairData(resto, hoje)
  const { valor, resto: semValor } = extrairValor(semData)
  if (!valor) return null
  let r = semValor

  // repetição
  let recorrencia: ComandoConta["recorrencia"] = null
  if (/\b(todo mes|mensal|mensalmente|todo dia \d{1,2}|todos os meses)\b/.test(r)) recorrencia = "mensal"
  else if (/\b(toda semana|semanal)\b/.test(r)) recorrencia = "semanal"
  else if (/\b(a cada 15 dias|quinzenal)\b/.test(r)) recorrencia = "quinzenal"
  else if (/\b(todo ano|anual|anualmente)\b/.test(r)) recorrencia = "anual"
  r = r.replace(/\b(todo mes|mensalmente|mensal|todos os meses|toda semana|semanal|a cada 15 dias|quinzenal|todo ano|anualmente|anual)\b/g, " ")

  // forma de pagamento
  let forma: string | null = null
  for (const [k, v] of Object.entries(FORMAS)) {
    const re = new RegExp(`\\b(?:no|na|em|via|por)?\\s*${k}\\b`)
    if (re.test(r)) { forma = v; r = r.replace(re, " "); break }
  }

  // pessoa: "para o ze", "pro ze", "do joao", "da maria", "de joao"
  let pessoa: string | null = null
  const pe = r.match(/\b(?:para|pra|pro|ao|do|da|de)\s+(?:o\s+|a\s+)?([a-z][a-z ]{1,30})$/)
  if (pe) {
    const cand = limparDescricao(pe[1]).replace(/^(fornecedor|cliente|sr|sra|seu|dona)\s+/, "")
    // "80 de gas" não tem pessoa: o "de gas" é a descrição. Só vira pessoa em recebi/receber, ou com "para/pro/ao".
    const preposicao = pe[0].trim().split(" ")[0]
    const ehPessoa = acao === "recebi" || acao === "receber" ? true : ["para", "pra", "pro", "ao"].includes(preposicao)
    if (cand && ehPessoa) { pessoa = capitaliza(cand); r = r.replace(pe[0], " ") }
  }

  const descBruta = limparDescricao(r)
  const tipo = acao === "pagar" || acao === "paguei" ? "pagar" : "receber"
  let descricao = descBruta
  if (!descricao && pessoa) descricao = tipo === "receber" ? `Recebimento de ${pessoa}` : `Pagamento a ${pessoa}`
  if (!descricao) return null
  const categoria = categoriaDe(t, tipo)
  descricao = descricao.charAt(0).toUpperCase() + descricao.slice(1)        // só a primeira letra: "Conta de energia", "Recebimento de João"
  void data
  return { acao, valor, descricao: restaurarAcentos(descricao, textoOriginal ?? ""), pessoa: pessoa ? restaurarAcentos(pessoa, textoOriginal ?? "") : null, vencimento: data, forma, categoria, recorrencia }
}
