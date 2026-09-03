// ─────────────────────────────────────────────────────────────────────────────
// Resposta automática SEM IA (mig 0226/0227/0228)
//
// O robô de IA existe, mas nenhuma loja usa: gasta crédito por mensagem e cada
// coisa nova do sistema é mais uma coisa pra ensinar a ele — que ele erra.
// Este aqui não pensa, ele CONSULTA: horário, endereço e taxa saem do banco,
// sempre certos, custo zero.
//
// SOBRE PRODUTO ELE NÃO FALA. Já falou — listava nome e preço no chat — e era
// pior do que parecia: sai sem foto, o preço envelhece dentro da conversa, item
// pausado continua aparecendo e uma pergunta larga ("tem picolé?") vira uma
// parede de texto que ninguém lê. Pergunta de produto vira o link do cardápio,
// onde está tudo, certo e agora — e é lá que o pedido vira pedido.
//
// O que ele não sabe, ele não inventa: pergunta se pode chamar uma pessoa e
// abre um chamado no gestor (whatsapp_chamados). A partir daí ele fica quieto
// naquele número — quem responde é gente.
//
// Este arquivo é dos DOIS canos (Evolution e Meta Cloud). Eram duas cópias, e
// uma delas sempre ficava pra trás; a diferença entre os canos é só o `enviar`.
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any
type Sb = any
type Enviar = (texto: string) => Promise<unknown>
// Espelho da fala do robô na aba Mensagens do gestor. Cada cano tem o seu (a
// função é a mesma dos dois lados, mas mora dentro de cada webhook).
type Espelhar = (texto: string) => Promise<unknown>

const NL = String.fromCharCode(10)
const FUSO = "America/Fortaleza"
const HORAS_PAUSA_HUMANA = 12

// Frase-marca da pergunta do atendente. É por ela que a mensagem seguinte do
// cliente é lida como "sim, chama" ou "não precisa" — sem guardar estado.
const MARCA_ATENDENTE = "chame um atendente"

// Frase-marca do "peça pelo link". É por ela que o robô sabe que já ensinou o
// caminho — e que a segunda tentativa do cliente de pedir pelo WhatsApp não é
// desatenção: é ele dizendo que não quer o link. Aí vira gente.
const MARCA_PEDIDO = "adiciona na sacola"

const semAcento = (s: string) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()

const dinheiro = (v: number) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`

// ── Horário, endereço e taxa: as três perguntas que sobram ───────────────────
const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"]

function agoraNaLoja() {
  const agora = new Date()
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(agora)
  const hm = agora.toLocaleTimeString("en-GB", {
    hour12: false, timeZone: FUSO, hour: "2-digit", minute: "2-digit",
  })
  const [h, m] = hm.split(":").map(Number)
  const [y, mes, d] = ymd.split("-").map(Number)
  return { min: h * 60 + m, diaSemana: new Date(y, mes - 1, d).getDay() }
}

const paraMin = (hm: string) => {
  const [h, m] = String(hm ?? "").slice(0, 5).split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

// "das 07:00 às 14:00" / "das 08:30 às 12:00 e das 14:00 às 18:00"
function textoDosPeriodos(periodos: Array<Record<string, string>>): string {
  const partes = (periodos ?? [])
    .filter(p => p?.i && p?.f)
    .map(p => `das ${String(p.i).slice(0, 5)} às ${String(p.f).slice(0, 5)}`)
  if (!partes.length) return ""
  if (partes.length === 1) return partes[0]
  return `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`
}

function respostaDeHorario(empresa: Record<string, unknown>): string | null {
  const grade = Array.isArray(empresa.horarios_funcionamento)
    ? empresa.horarios_funcionamento as Array<Record<string, unknown>>
    : null
  const { min: agora, diaSemana } = agoraNaLoja()

  if (grade && grade.length === 7) {
    const hoje = grade[diaSemana] ?? {}
    const periodos = (hoje.periodos ?? []) as Array<Record<string, string>>
    if (hoje.aberto && periodos.length) {
      const abertoAgora = periodos.some(p => agora >= paraMin(p.i) && agora < paraMin(p.f))
      const quando = textoDosPeriodos(periodos)
      return abertoAgora
        ? `Tô aqui sim! 🙌 Hoje a gente atende ${quando}.`
        : `Hoje a gente atende ${quando}.`   // fora da faixa: quem avisa é avisoDeFechada
    }
    // Fechado hoje: dizer só "não abre" deixa o cliente sem saber quando volta.
    for (let i = 1; i <= 7; i++) {
      const idx = (diaSemana + i) % 7
      const dia = grade[idx] ?? {}
      const periodos2 = (dia.periodos ?? []) as Array<Record<string, string>>
      if (dia.aberto && periodos2.length) {
        const nome = i === 1 ? "Amanhã" : `${DIAS[idx].charAt(0).toUpperCase()}${DIAS[idx].slice(1)}`
        return `Hoje a gente não abre. ${nome} a gente atende ${textoDosPeriodos(periodos2)}.`
      }
    }
    if (hoje.aberto) return "Tô aqui sim! 🙌 Pode mandar seu pedido."
    return "Hoje a gente não abre."
  }

  const abre = String(empresa.horario_abertura ?? "").slice(0, 5)
  const fecha = String(empresa.horario_fechamento ?? "").slice(0, 5)
  if (abre && fecha) return `A gente atende das ${abre} às ${fecha}.`
  return null
}

// ── A loja está aberta agora? ────────────────────────────────────────────────
// Mesma regra da Loja Online: aberta = o interruptor "Loja fechada" desligado E
// dentro da grade da semana. Sem isso o robô convidava pra pedir às 3 da manhã
// e o pedido caía num painel que ninguém estava olhando.
//
// Feriado marcado na mão (dias_excecao) ainda não entra aqui — quando a loja
// fecha num feriado ela costuma usar o botão "Loja fechada", que este código
// respeita.
const MARCA_FECHADA = "a gente tá fechado"

export function lojaAbertaAgora(empresa: Record<string, unknown>): boolean {
  // O botão vermelho do gestor. Fechou na mão, está fechado — grade nenhuma
  // discute com isso.
  if (empresa.delivery_ativo === false) return false

  const grade = Array.isArray(empresa.horarios_funcionamento)
    ? empresa.horarios_funcionamento as Array<Record<string, unknown>>
    : null
  if (!grade || grade.length !== 7) return true    // sem grade: não sabe, não atrapalha

  const { min: agora, diaSemana } = agoraNaLoja()
  const hoje = grade[diaSemana] ?? {}
  if (!hoje.aberto) return false
  const periodos = (hoje.periodos ?? []) as Array<Record<string, string>>
  if (!periodos.length) return true                // dia aberto sem faixa = sem restrição
  return periodos.some(p => {
    const i = paraMin(p.i), f = paraMin(p.f)
    // Faixa que vira a madrugada (22:00 → 02:00) conta os dois pedaços.
    return i <= f ? (agora >= i && agora < f) : (agora >= i || agora < f)
  })
}

/**
 * "Agora a gente tá fechado. Abre hoje às 18:00." / "...Amanhã a gente atende
 * das 07:00 às 14:00."
 *
 * Dizer só "tá fechado" faz o cliente ir pedir em outro lugar. Ele precisa
 * saber QUANDO volta — e às 17h de um dia que fechou às 14h, "hoje a gente
 * atende das 07:00 às 14:00" é uma informação que não serve pra nada.
 */
export function avisoDeFechada(empresa: Record<string, unknown>): string {
  const fechado = `Agora ${MARCA_FECHADA}. 😴`
  const grade = Array.isArray(empresa.horarios_funcionamento)
    ? empresa.horarios_funcionamento as Array<Record<string, unknown>>
    : null
  if (!grade || grade.length !== 7) return fechado

  const { min: agora, diaSemana } = agoraNaLoja()
  const hoje = grade[diaSemana] ?? {}
  const periodosHoje = (hoje.aberto ? (hoje.periodos ?? []) : []) as Array<Record<string, string>>

  // Ainda abre hoje? (fechado no intervalo do almoço, ou antes de abrir)
  const proximo = periodosHoje
    .map(p => paraMin(p.i))
    .filter(i => i > agora)
    .sort((a, b) => a - b)[0]
  if (proximo != null) {
    const hm = `${String(Math.floor(proximo / 60)).padStart(2, "0")}:${String(proximo % 60).padStart(2, "0")}`
    return `${fechado} A gente abre hoje às ${hm}.`
  }

  // Já passou o horário de hoje (ou hoje nem abre): o próximo dia que abre.
  for (let i = 1; i <= 7; i++) {
    const idx = (diaSemana + i) % 7
    const dia = grade[idx] ?? {}
    const periodos = (dia.periodos ?? []) as Array<Record<string, string>>
    if (dia.aberto && periodos.length) {
      const nome = i === 1 ? "Amanhã" : `${DIAS[idx].charAt(0).toUpperCase()}${DIAS[idx].slice(1)}`
      return `${fechado} ${nome} a gente atende ${textoDosPeriodos(periodos)}.`
    }
  }
  return fechado
}

function respostaDeEndereco(empresa: Record<string, unknown>): string | null {
  const rua = String(empresa.endereco ?? "").trim()
  if (!rua) return null
  const numero = String(empresa.numero ?? "").trim()
  const bairro = String(empresa.bairro ?? "").trim()
  const cidade = String(empresa.cidade ?? "").trim()
  const linha = [numero ? `${rua}, ${numero}` : rua, bairro, cidade].filter(Boolean).join(" - ")
  const mapa = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(linha)}`
  return `A gente fica em ${linha}.${NL}${mapa}`
}

function respostaDeTaxa(empresa: Record<string, unknown>, link: string): string | null {
  if (empresa.aceita_entrega === false) {
    return "A gente não faz entrega, só retirada aqui na loja. 😉"
  }
  const porBairro = Array.isArray(empresa.taxas_entrega_bairro) ? empresa.taxas_entrega_bairro : []
  const porKm = Array.isArray(empresa.taxas_entrega_km) ? empresa.taxas_entrega_km : []
  const min = Number(empresa.tempo_entrega_min ?? 0)
  const max = Number(empresa.tempo_entrega_max ?? 0)
  const tempo = min && max ? ` Leva de ${min} a ${max} min.` : ""

  // Taxa que muda conforme o endereço: o robô PERGUNTA. "Depende do seu
  // endereço" é a resposta que não responde, e quem pergunta o frete está
  // decidindo se pede — mandar abrir link pra descobrir é onde a venda morre.
  if (porBairro.length || porKm.length) {
    return `Depende de onde você tá — me diz ${MARCA_ENDERECO} que eu já vejo o valor certinho. 🙌${tempo}`
  }
  const taxa = Number(empresa.taxa_entrega ?? 0)
  if (taxa > 0) return `A entrega é ${dinheiro(taxa)}.${tempo}`
  return `A entrega é grátis. 🙌${tempo}`
}

function respostaDeInfo(
  texto: string, empresa: Record<string, unknown>, link: string,
): string | null {
  const t = semAcento(texto)
  const tem = (...ps: string[]) => ps.some(p => t.includes(p))

  // "Manda o cardápio" é o pedido mais fácil da lista e o robô não tinha
  // resposta pra ele. O link É o cardápio — com preço certo e sempre atualizado.
  if (tem("cardapio", "cardapo", "menu", "catalogo", "lista de preco", "tabela de preco", "o que voces tem", "o que vcs tem"))
    return `Nosso cardápio tá aqui, com tudo e o preço certinho:${NL}${link}`

  if (tem("horari", "que horas", "quantas horas", "abre", "aberto", "fecha", "fechad", "funciona", "atende hoje", "ta ai", "tao ai"))
    return respostaDeHorario(empresa)

  if (tem("taxa", "frete", "entrega", "entregam", "entregar", "delivery", "leva quanto", "demora"))
    return respostaDeTaxa(empresa, link)

  if (tem("endereco", "onde fica", "onde voce", "onde eh", "onde e a", "localiza", "como chego", "fica onde", "retirar", "retirada", "buscar ai"))
    return respostaDeEndereco(empresa)

  return null
}

// ── Taxa de entrega pelo endereço do cliente ─────────────────────────────────
// "A taxa depende do seu endereço" é a resposta que não responde. Quem pergunta
// o frete está decidindo se pede — e mandar o cliente abrir um link pra
// descobrir é onde a venda morre. Então o robô faz o que o atendente faz:
// pergunta a rua e o bairro, e dá o valor.
//
// Mesma conta do checkout (DeliveryCheckout.jsx): bairro configurado manda; se
// não tiver, geocodifica o endereço e mede a distância até a loja.
const MARCA_ENDERECO = "sua rua e o bairro"

const ABREV_BAIRRO: Record<string, string> = {
  sra: "senhora", sr: "senhor", sto: "santo", sta: "santa",
  n: "nossa", na: "nossa", jd: "jardim", pq: "parque",
  vl: "vila", cj: "conjunto", res: "residencial", pres: "presidente",
}

function normBairro(v: string): string {
  return semAcento(v)
    .replace(/^bairro[ ]+/, "")
    .replace(/[.]/g, " ")
    .replace(/[ ]+/g, " ")
    .trim()
    .split(" ")
    .map(p => ABREV_BAIRRO[p] ?? p)
    .join(" ")
    .trim()
}

function acharBairroCfg(lista: unknown, bairroCliente: string): Record<string, unknown> | null {
  if (!Array.isArray(lista) || !bairroCliente) return null
  const n = normBairro(bairroCliente)
  if (!n) return null
  // O cliente escreve a frase inteira ("rua tal, no Potengi"), então o casamento
  // é por CONTER o nome do bairro — não por igualdade.
  return lista.find((b: Record<string, unknown>) => {
    const alvo = normBairro(String(b?.bairro ?? ""))
    return alvo.length >= 3 && n.includes(alvo)
  }) ?? null
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Devolve a faixa inteira: cada uma tem o tempo dela (a de 1 km leva 5 min, a
// de 10 km leva 50). Responder "de 30 a 60 min" pra quem mora na esquina é
// jogar fora uma informação que a loja já cadastrou.
function faixaDaDistancia(faixas: unknown, distKm: number): Record<string, unknown> | null {
  const arr = Array.isArray(faixas)
    ? [...faixas].sort((a, b) => Number(a.km) - Number(b.km))
    : []
  if (!arr.length) return null
  return arr.find(f => distKm <= Number(f.km)) ?? arr[arr.length - 1]
}

// Nominatim: de graça, 1 consulta por segundo, e some quando está apertado.
// Sem tempo limite a promessa fica pendurada e o cliente não recebe resposta
// nenhuma — pior que uma taxa que não saiu.
async function geocodar(consulta: string): Promise<{ lat: number; lng: number } | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 6000)
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(consulta)}&format=json&limit=1`
    const res = await fetch(url, { headers: { "User-Agent": "CRM-FWC/1.0" }, signal: ctrl.signal })
    if (!res.ok) return null
    const d = await res.json()
    if (!Array.isArray(d) || !d[0]) return null
    return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * Taxa pro endereço que o cliente acabou de escrever.
 *
 * `null` = não deu pra calcular. Nesse caso quem responde é o link, que tem
 * mapa e pino — chutar um valor aqui é a loja pagando a diferença ou o cliente
 * levando um susto na porta.
 */
export async function taxaDoEndereco(
  empresa: Record<string, unknown>, endereco: string,
): Promise<{ taxa: number; km: number | null; minutos: number | null; foraRaio: boolean } | null> {
  const cfgBairro = acharBairroCfg(empresa.taxas_entrega_bairro, endereco)
  if (cfgBairro) {
    if (cfgBairro.entrega === false) return null   // bairro que a loja não atende
    return { taxa: Number(cfgBairro.taxa) || 0, km: null, minutos: null, foraRaio: false }
  }

  const lat = Number(empresa.latitude)
  const lng = Number(empresa.longitude)
  const faixas = empresa.taxas_entrega_km
  if (!lat || !lng || !Array.isArray(faixas) || !faixas.length) return null

  const cidade = String(empresa.cidade ?? "").trim()
  const uf = String(empresa.estado ?? "").trim()
  const ponto = await geocodar([endereco, cidade, uf, "Brasil"].filter(Boolean).join(", "))
  if (!ponto) return null

  const km = haversineKm(ponto.lat, ponto.lng, lat, lng)
  const faixa = faixaDaDistancia(faixas, km)
  if (!faixa) return null
  const raio = Number(empresa.raio_entrega_km ?? 0)
  return {
    taxa: Number(faixa.taxa) || 0,
    km,
    minutos: Number(faixa.tempo) || null,
    foraRaio: !!raio && km > raio,
  }
}

// ── Pausa do robô ────────────────────────────────────────────────────────────
const soDigitos = (p: string) => String(p ?? "").replace(/\D/g, "")
const chave8 = (p: string) => soDigitos(p).slice(-8)

/**
 * Telefone do jeito que o checkout entende: sem o 55 do país e COM o 9 do
 * celular.
 *
 * Sem o 55 porque o checkout leria "55" como DDD. Com o 9 porque a Meta entrega
 * o número do Nordeste sem ele (5584 8180-774) e o cadastro guarda com — o link
 * abria com um telefone que não existe em lugar nenhum, o cliente não era
 * reconhecido e digitava nome e endereço tudo de novo.
 */
function telefoneParaLink(phone: string): string {
  const d = soDigitos(phone)
  const n = (d.startsWith("55") && d.length >= 12) ? d.slice(2) : d
  // DDD + 8 dígitos começando em 6-9 = celular que perdeu o 9 no caminho.
  // Fixo (começa em 2-5) não leva 9 nenhum.
  if (n.length === 10 && /^[6-9]/.test(n.slice(2))) return `${n.slice(0, 2)}9${n.slice(2)}`
  return n
}

/**
 * Robô está pausado nesse número? Pausa manual (expira_em NULL) vale pra
 * sempre; a automática (a loja assumiu a conversa) vale por algumas horas.
 */
export async function roboPausado(supabase: Sb, empresaId: string, phone: string): Promise<boolean> {
  const { data } = await supabase.from("whatsapp_bot_pausado")
    .select("phone, expira_em").eq("empresa_id", empresaId)
    .like("phone", `%${chave8(phone)}`).limit(5)
  const linhas = Array.isArray(data) ? data : []
  const agora = Date.now()
  return linhas.some((l: Record<string, unknown>) =>
    !l.expira_em || new Date(String(l.expira_em)).getTime() > agora)
}

/**
 * A loja respondeu esse número na mão (pelo celular dela ou pelo gestor).
 * O robô sai de cena por umas horas: dois falando na mesma conversa é o jeito
 * mais rápido de o lojista desligar isso pra sempre.
 *
 * Com PRAZO de propósito. Pausa eterna ia matando o robô número a número, sem
 * ninguém perceber — e daqui a um mês ele não responderia mais ninguém.
 */
export async function pausarPorAtendimentoHumano(supabase: Sb, empresaId: string, phone: string) {
  const expira = new Date(Date.now() + HORAS_PAUSA_HUMANA * 60 * 60 * 1000).toISOString()
  const { data: jaTem } = await supabase.from("whatsapp_bot_pausado")
    .select("phone, expira_em").eq("empresa_id", empresaId).eq("phone", phone).maybeSingle()
  // Pausa manual (permanente) não vira pausa de 12h — seria afrouxar o que a
  // loja apertou de propósito.
  if (jaTem && !jaTem.expira_em) return
  await supabase.from("whatsapp_bot_pausado").upsert({
    empresa_id: empresaId, phone, pausado_em: new Date().toISOString(),
    expira_em: expira, motivo: "loja assumiu a conversa",
  }, { onConflict: "empresa_id,phone" })
  console.log("[pausa] loja assumiu, robô calado por", HORAS_PAUSA_HUMANA, "h:", phone)
}

// ── Chamado de atendente ─────────────────────────────────────────────────────
export async function chamadoAberto(supabase: Sb, empresaId: string, phone: string) {
  const { data } = await supabase.from("whatsapp_chamados")
    .select("id").eq("empresa_id", empresaId).is("atendido_em", null)
    .like("phone", `%${chave8(phone)}`).limit(1).maybeSingle()
  return data ?? null
}

// Primeiro nome de quem está falando, se a loja já tiver esse cliente. Só o
// primeiro: "Oi, Wilde Junior da Silva! 👋" não é jeito de gente falar.
async function primeiroNomeDoCliente(supabase: Sb, empresaId: string, phone: string): Promise<string> {
  try {
    const { data } = await supabase.from("clientes")
      .select("nome").eq("empresa_id", empresaId)
      .ilike("telefone", `%${chave8(phone)}`).limit(1).maybeSingle()
    const nome = String(data?.nome ?? "").trim()
    return nome ? nome.split(/\s+/)[0] : ""
  } catch {
    return ""
  }
}

export async function abrirChamado(supabase: Sb, empresaId: string, phone: string, motivo: string) {
  if (await chamadoAberto(supabase, empresaId, phone)) return
  const { data: cli } = await supabase.from("clientes")
    .select("nome").eq("empresa_id", empresaId)
    .ilike("telefone", `%${chave8(phone)}`).limit(1).maybeSingle()
  const { error } = await supabase.from("whatsapp_chamados").insert({
    empresa_id: empresaId, phone, nome: cli?.nome ?? null, motivo: String(motivo ?? "").slice(0, 300),
  })
  if (error) console.error("[chamado] não abriu:", JSON.stringify(error).slice(0, 200))
  else console.log("[chamado] aberto para", phone)
}

// ── Primeira fala: o texto é da loja ─────────────────────────────────────────
// Cada loja fala do seu jeito. O padrão da casa é este; quem quiser muda no
// Portal (WhatsApp → Conexão / Config) sem mexer em código.
//
// {nome} = primeiro nome do cliente, quando ele já tem cadastro na loja. Sem
// cadastro o token some junto com a vírgula solta — "Oi , ! 👋" é pior que não
// chamar pelo nome.
// {link} = o link da loja com o telefone dele. Se o texto não tiver o token, o
// link entra no fim: loja nenhuma pode mandar uma saudação SEM o link.
export const TEXTO_PRIMEIRA_FALA_PADRAO = [
  "Oi {nome}! 👋",
  "Para entrega ou retirada, é só acessar nossa loja online 👇",
  "{link}",
  "",
  "Estamos à disposição!",
].join(String.fromCharCode(10))

export function montarPrimeiraFala(modelo: string, nome: string, link: string): string {
  const texto = (modelo?.trim() || TEXTO_PRIMEIRA_FALA_PADRAO)
  const comLink = texto.includes("{link}") ? texto : `${texto}${NL}{link}`
  return comLink
    .replace(/\{nome\}/g, nome)
    .replace(/\{link\}/g, link)
    // Faxina de quando o nome não veio: ", ," vira ",", "Oi !" vira "Oi!",
    // e vírgula sozinha no começo da linha some.
    .replace(/,[ ]*,/g, ",")
    .replace(/[ ]{2,}/g, " ")
    .replace(/[ ]+([!?.,:])/g, "$1")
    .replace(/,[ ]*([!?.])/g, "$1")
    .replace(new RegExp("(^|" + NL + ")[ ,]+", "g"), "$1")
    .trim()
}

// ── O robô ───────────────────────────────────────────────────────────────────
/**
 * Responde uma mensagem do cliente sem IA nenhuma.
 *
 * @returns true se respondeu alguma coisa.
 */
export async function responderSemIA({
  supabase, cfg, phone, mensagem, enviar, espelhar,
}: {
  supabase: Sb
  cfg: Record<string, unknown>
  phone: string
  mensagem: string
  enviar: Enviar
  espelhar?: Espelhar
}): Promise<boolean> {
  try {
    if (cfg.resposta_link_ativo !== true) return false
    const empresa = (cfg.empresas ?? {}) as Record<string, unknown>
    const empresaId = String(cfg.empresa_id ?? "")
    const slug = String(empresa.slug ?? "").trim()
    if (!slug || !empresaId) return false

    // Conversa que gente já assumiu: o robô não fala por cima.
    if (await roboPausado(supabase, empresaId, phone)) {
      console.log("[link] número pausado, robô calado:", phone)
      return false
    }
    // Chamado aberto = alguém da loja vai responder. O robô espera.
    if (await chamadoAberto(supabase, empresaId, phone)) {
      console.log("[link] chamado aberto, robô calado:", phone)
      return false
    }

    const link = `https://lojaonline.fwcinter.com/${slug}?t=${telefoneParaLink(phone)}`

    const responder = async (texto: string) => {
      await enviar(texto)
      await supabase.from("whatsapp_conversas").insert({
        empresa_id: empresaId, phone, role: "assistant", content: texto,
      })
      // A loja abre a conversa no gestor e vê as perguntas E as respostas. Sem
      // isto, ela via só o cliente falando sozinho e achava que ninguém tinha
      // respondido — e respondia tudo de novo.
      try { await espelhar?.(texto) } catch { /* espelho é bônus */ }
      return true
    }

    // As últimas falas do robô: é o que diz se o link já foi (não repete a cada
    // mensagem — link em toda linha vira paisagem) e se a última coisa que ele
    // disse foi a pergunta do atendente.
    const umaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data: ultimas } = await supabase.from("whatsapp_conversas")
      .select("content, created_at").eq("empresa_id", empresaId)
      .like("phone", `%${chave8(phone)}`).eq("role", "assistant")
      .gte("created_at", umaHora).order("created_at", { ascending: false }).limit(5)
    const recentes = Array.isArray(ultimas) ? ultimas : []
    const vezesQueMandouOLink = recentes.filter((m: Record<string, unknown>) =>
      String(m.content ?? "").includes("lojaonline.fwcinter.com")).length
    const linkRecente = vezesQueMandouOLink > 0
    const perguntouDoAtendente = String(recentes[0]?.content ?? "").includes(MARCA_ATENDENTE)

    const t = semAcento(mensagem).trim()

    // 0) LOJA FECHADA. Nada de convidar pra pedir com a porta fechada: o pedido
    //    cairia num painel que ninguém está olhando, e o cliente ficaria
    //    esperando. Ele avisa UMA vez e cala — repetir "tamos fechados" a cada
    //    mensagem é pior que não responder.
    if (!lojaAbertaAgora(empresa)) {
      const jaAvisou = recentes.some((m: Record<string, unknown>) =>
        String(m.content ?? "").includes(MARCA_FECHADA))
      const daInfoFechada = respostaDeInfo(mensagem, empresa, link)
      if (jaAvisou) {
        // Já sabe que está fechado. Ainda assim responde o que sabe (taxa,
        // endereço, horário) — a dúvida dele não fecha junto com a loja.
        return daInfoFechada ? await responder(daInfoFechada) : false
      }
      // O link vai de qualquer jeito: com a loja fechada ele não deixa comprar
      // (os botões ficam travados e o topo diz "Fechado"), então não gera pedido
      // que ninguém vai fazer. Mas deixa o cliente ver cardápio e preço agora,
      // que é o que ele veio saber — e voltar quando abrir.
      const agendavel = empresa.agendamento_ativo === true
      const extra = daInfoFechada
        ? `${NL}${NL}${daInfoFechada}`
        : agendavel
          ? `${NL}${NL}Se quiser, já deixa seu pedido agendado por aqui que a gente separa:${NL}${link}`
          : `${NL}${NL}Se quiser dar uma olhada no cardápio e nos preços, é aqui:${NL}${link}`
      return await responder(`${avisoDeFechada(empresa)}${extra}`)
    }

    // 1) "Não precisa" fecha o assunto na hora. O "sim" fica pro fim: se a
    //    mensagem seguinte for uma pergunta que o robô SABE responder, ele
    //    responde — "manda o cardapio" virava "já chamei alguém", que é o robô
    //    ignorando o cliente com educação.
    if (perguntouDoAtendente && /^(nao|nn|deixa|obrigad|valeu|blz|beleza|tudo bem)/.test(t)) {
      return await responder(`Beleza! 👍 Qualquer coisa é só chamar.${linkRecente ? "" : `${NL}${link}`}`)
    }

    // 2) Ele acabou de pedir a rua e o bairro: o que veio agora é o endereço.
    //    Aqui é o único lugar onde o robô calcula alguma coisa — e só entrega
    //    número quando a conta fecha.
    const perguntouEndereco = String(recentes[0]?.content ?? "").includes(MARCA_ENDERECO)
    if (perguntouEndereco && t.length >= 4) {
      const conta = await taxaDoEndereco(empresa, mensagem)
      if (conta?.foraRaio) {
        await abrirChamado(supabase, empresaId, phone, `fora do raio: ${mensagem}`)
        return await responder(
          `Esse endereço fica a ${conta.km?.toFixed(1)} km daqui, um pouco fora da nossa área. 😕${NL}` +
          "Já chamei alguém da loja pra ver se dá pra dar um jeito.",
        )
      }
      if (conta) {
        // O tempo da FAIXA, quando a loja cadastrou: quem mora na esquina não
        // merece ouvir "de 30 a 60 min".
        const min = Number(empresa.tempo_entrega_min ?? 0)
        const max = Number(empresa.tempo_entrega_max ?? 0)
        const tempo = conta.minutos
          ? ` Leva uns ${conta.minutos} min.`
          : (min && max ? ` Leva de ${min} a ${max} min.` : "")
        const dist = conta.km != null ? ` (${conta.km.toFixed(1)} km daqui)` : ""
        return await responder(
          `A entrega pra você fica ${dinheiro(conta.taxa)}${dist}.${tempo}${NL}${NL}` +
          `É só pedir aqui que a taxa já entra certinha:${NL}${link}`,
        )
      }
      // Não fechou a conta: quem responde é o link, que tem mapa e pino. Chutar
      // valor aqui é a loja pagando a diferença ou o cliente levando susto na
      // porta.
      return await responder(
        `Não consegui achar esse endereço aqui. 😕${NL}` +
        `Nesse link você marca no mapa e ele mostra a taxa exata:${NL}${link}`,
      )
    }

    // 3) Cardápio, horário, taxa de entrega, endereço — o que ele SABE.
    const daInfo = respostaDeInfo(mensagem, empresa, link)
    if (daInfo) return await responder(daInfo)

    // O cliente falando que não quer o link. Não é dúvida, é recado: ele quer
    // gente. Aqui não se pergunta "quer que eu chame?" — chama.
    if (/nao quero (o |esse )?link|nao vou (entrar|abrir)|so quero saber (por )?aqui|quero (saber|falar|pedir) (por )?aqui|aqui mesmo|nao consigo (abrir|entrar)|prefiro (por )?aqui/.test(t)) {
      await abrirChamado(supabase, empresaId, phone, mensagem)
      return await responder("Beleza! 🙌 Já chamei alguém da loja pra falar com você por aqui mesmo. Só um instante!")
    }

    // 4) "Quero uma M", "me vê 2 marmitas": o cliente está PEDINDO. Isso não é
    //    pergunta sem resposta — é o pedido nascendo, e o caminho da casa é o
    //    link: escolhe, joga na sacola, paga. Montar sacola no WhatsApp é o que
    //    faz o pedido sair errado e o atendente parar tudo pra digitar.
    const querPedir = /\b(quero|queria|vou querer|vou pedir|me ve|me ver|me manda|manda um|manda uma|anota|separa|pedir|pedido|fazer o pedido|fazer um pedido)\b/.test(t)
      && !/cade|ja saiu|nao chegou|onde ta|status/.test(t)
    if (querPedir) {
      // Insistiu depois de já ter ouvido o caminho: não é que ele não entendeu,
      // é que ele não quer o link. Aí a loja assume — brigar com o cliente pra
      // ele usar o site é perder a venda.
      const jaEnsinou = recentes.some((m: Record<string, unknown>) =>
        String(m.content ?? "").includes(MARCA_PEDIDO))
      if (jaEnsinou) {
        await abrirChamado(supabase, empresaId, phone, mensagem)
        return await responder("Já chamei alguém aqui da loja pra anotar com você. 🙌 Só um instante!")
      }
      return await responder(
        `Boa! 🙌 Por aqui o pedido é pelo link, é rapidinho:${NL}` +
        `é só escolher, ${MARCA_PEDIDO} e avançar pra forma de pagamento.${NL}${link}`,
      )
    }

    // 5) Ele tinha perguntado "quer que eu chame um atendente?" e o que veio
    //    não é pergunta que ele saiba responder ("sim", "quero", ou a mesma
    //    dúvida de novo). Aí vira gente: insistir com robô em quem já não foi
    //    entendido é o que faz o cliente desistir.
    if (perguntouDoAtendente) {
      await abrirChamado(supabase, empresaId, phone, mensagem)
      return await responder("Já chamei alguém aqui da loja pra falar com você. 🙌 Só um instante!")
    }

    // 6) Primeira fala da conversa: o link vai SEMPRE, seja um "oi" ou uma
    //    pergunta que a gente não entendeu. É a mensagem que faz o pedido sair
    //    do WhatsApp e cair no sistema.
    if (!linkRecente) {
      const modelo = String(cfg.resposta_link_texto ?? "")
      // Só vai no banco atrás do nome se o texto pedir — loja que tirou o
      // {nome} não paga por uma consulta que não vai usar.
      const querNome = (modelo.trim() || TEXTO_PRIMEIRA_FALA_PADRAO).includes("{nome}")
      const nome = querNome ? await primeiroNomeDoCliente(supabase, empresaId, phone) : ""
      return await responder(montarPrimeiraFala(modelo, nome, link))
    }

    // 7) Segunda vez que ele não entende: manda o link de novo, agora dizendo o
    //    que tem lá dentro. Pode ser que o cliente nem tenha aberto na primeira.
    if (vezesQueMandouOLink === 1) {
      return await responder(
        `Nossos produtos e as promoções tão todos aqui, dá uma conferida: 👇${NL}${link}`,
      )
    }

    // 8) Terceira. Já mandou o link duas vezes e ele continua perguntando por
    //    aqui — o cliente não quer o link, e insistir vira teimosia de robô.
    //    Oferece gente, que é o que ele está pedindo desde a segunda pergunta.
    return await responder(`Essa eu não sei te responder por aqui. 😅 Quer que eu ${MARCA_ATENDENTE} pra te ajudar?`)
  } catch (e) {
    console.error("[link] falhou:", e)
    return false
  }
}
