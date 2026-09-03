// ─────────────────────────────────────────────────────────────────────────────
// Resposta automática SEM IA (mig 0226/0227/0228)
//
// O robô de IA existe, mas nenhuma loja usa: gasta crédito por mensagem e cada
// coisa nova do sistema é mais uma coisa pra ensinar a ele — que ele erra.
// Este aqui não pensa, ele CONSULTA: cardápio, horário, endereço e taxa saem do
// banco, sempre certos, custo zero.
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

// Começo da resposta de cardápio. Serve pra reconhecer, no histórico, que a
// última coisa que o robô disse foi uma LISTA de produtos.
const RESPOSTA_TEM = "Tem sim! 🙌"

const semAcento = (s: string) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()

const dinheiro = (v: number) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`

// Palavras que não identificam produto nenhum. Entram aqui também as das
// perguntas de informação (horário, taxa, endereço): sem isso, "tem taxa de
// entrega?" ia procurar um produto chamado "taxa" — e tem loja com produto
// "Taxa de entrega" cadastrado, o que daria uma resposta ridícula.
const PALAVRAS_VAZIAS = new Set([
  "tem", "tens", "teria", "temos", "quanto", "quanta", "quantos", "custa", "custam",
  "valor", "preco", "vale", "sai", "por", "favor", "boa", "bom", "dia", "tarde",
  "noite", "oi", "ola", "vc", "voce", "vcs", "voces", "ai", "ta", "esta", "ainda",
  "quero", "queria", "gostaria", "pra", "para", "com", "sem", "que", "qual", "quais",
  "uma", "uns", "umas", "dos", "das", "nao", "sim", "voltou", "chegou", "hoje",
  "ver", "saber", "sobre", "mim", "me", "eu", "de", "do", "da", "os", "as", "um",
  "taxa", "frete", "entrega", "entregam", "entregar", "entregas", "delivery",
  "horario", "horarios", "hora", "horas", "abre", "abrir", "aberto", "abertos",
  "fecha", "fechar", "fechado", "fechados", "funciona", "funcionando", "atende",
  "endereco", "onde", "fica", "ficam", "local", "localizacao", "retirada",
  "retirar", "buscar", "atendente", "demora", "tempo",
  // Palavras do "só tem isso?" / "tem mais?". Sem elas o robô ia procurar um
  // produto chamado "isso" e, não achando, cairia de novo na MESMA busca de
  // antes — foi o que fez ele repetir a lista de sucos igualzinha.
  "isso", "isto", "esse", "esses", "essa", "essas", "outro", "outra", "outros",
  "outras", "mais", "somente", "apenas", "tudo", "opcao", "opcoes",
  "cardapio", "menu", "catalogo", "manda", "mandar", "envia", "enviar", "manda ai",
  "lista", "preco", "precos", "tabela",
])

function palavrasDeBusca(texto: string): string[] {
  return semAcento(texto)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(p => p.length >= 3 && !PALAVRAS_VAZIAS.has(p) && !/^\d+$/.test(p))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
}

// ── "Tem X?" respondido pelo cardápio ────────────────────────────────────────
type Produto = Record<string, unknown>

// Sem podar a lista: quem pergunta "tem suco?" quer ver TODOS os sucos. Cortar
// em três é o atendente que fala três sabores de polpa — o cliente vai embora
// achando que a loja só tem aqueles três.
const LIMITE_LISTA = 40

// O cliente pergunta pela prateleira que ele conhece; a loja cadastrou com
// outro nome. "Tem refrigerante?" numa loja cuja categoria é "bebidas" não
// achava nada — e o robô dizia que não sabia, com a Coca na geladeira.
//
// Só entra apelido ÓBVIO. Chute vira mentira, e mentira do robô a loja paga.
const SINONIMOS: Record<string, string[]> = {
  // Sem "bebida" aqui de propósito: a categoria "bebidas" tem água, café e
  // nescau, e quem pediu refrigerante ia receber a lista inteira da geladeira.
  refrigerante: ["refrigerante", "coca", "guarana", "fanta", "pepsi", "sprite"],
  refri: ["refrigerante", "coca", "guarana", "fanta", "pepsi", "sprite"],
  bebida: ["bebida", "suco", "refrigerante", "coca", "agua"],
  bebidas: ["bebida", "suco", "refrigerante", "coca", "agua"],
  sorvete: ["sorvete", "picole", "sundae", "creme", "acai"],
  sobremesa: ["sobremesa", "doce", "pudim", "sorvete", "picole"],
  lanche: ["lanche", "sanduiche", "hamburguer", "misto", "bauru", "pao"],
  sanduiche: ["sanduiche", "lanche", "hamburguer", "misto", "bauru"],
  salgado: ["salgado", "coxinha", "pastel", "empada", "esfiha"],
  salgados: ["salgado", "coxinha", "pastel", "empada", "esfiha"],
  marmita: ["marmita", "quentinha", "almoco", "prato"],
  quentinha: ["quentinha", "marmita", "almoco", "prato"],
  almoco: ["almoco", "marmita", "quentinha", "prato"],
  janta: ["janta", "jantar", "lanche", "prato"],
  cafe: ["cafe", "tapioca", "cuscuz", "pao", "misto"],
  polpa: ["polpa", "fruta"],
}

async function umTermo(
  supabase: Sb, empresaId: string, termo: string, limite: number,
): Promise<Produto[]> {
  const { data, error } = await supabase.rpc("buscar_produto_nome", {
    p_empresa: empresaId, p_termo: termo, p_limite: limite,
  })
  if (error) console.error("[produto] rpc erro:", termo, JSON.stringify(error).slice(0, 200))
  const achados = Array.isArray(data) ? data : []
  console.log("[produto] termo", termo, "achou", achados.length)
  return achados
}

async function buscarProdutos(
  supabase: Sb, empresaId: string, texto: string, limite = LIMITE_LISTA,
): Promise<Produto[]> {
  try {
    const termos = palavrasDeBusca(texto)
    if (!termos.length) return []
    for (const termo of termos) {
      const achados = await umTermo(supabase, empresaId, termo, limite)
      if (achados.length) return achados
    }
    // Nada pelo que ele escreveu: tenta os apelidos. Aqui os resultados SOMAM —
    // "refrigerante" é a Coca mais o Guaraná mais a Fanta, não um deles só.
    for (const termo of termos) {
      const apelidos = SINONIMOS[termo]
      if (!apelidos) continue
      const juntos = new Map<string, Produto>()
      for (const apelido of apelidos) {
        for (const p of await umTermo(supabase, empresaId, apelido, limite)) {
          juntos.set(String(p.id ?? p.nome), p)
          if (juntos.size >= limite) break
        }
        if (juntos.size >= limite) break
      }
      if (juntos.size) return [...juntos.values()]
    }
    return []
  } catch (e) {
    console.error("[produto] busca falhou:", e)
    return []
  }
}

function listaDeProdutos(achados: Produto[]): string {
  return achados.map(p => {
    const preco = Number(p.preco ?? 0)
    // Produto no peso/sob consulta entra sem preço: "R$ 0,00" faz o cliente
    // achar que é de graça.
    return preco > 0 ? `${p.nome} — ${dinheiro(preco)}` : String(p.nome)
  }).join(NL)
}

async function respostaDeProduto(
  supabase: Sb, empresaId: string, texto: string, link: string | null,
): Promise<string | null> {
  const achados = await buscarProdutos(supabase, empresaId, texto)
  if (!achados.length) return null
  const lista = listaDeProdutos(achados)
  return link
    ? `Tem sim! 🙌${NL}${lista}${NL}${NL}Peça aqui que já cai direto pra gente separar:${NL}${link}`
    : `Tem sim! 🙌${NL}${lista}`
}

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
        : `Hoje a gente atende ${quando}.`
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

  // Taxa que muda conforme o endereço: falar um valor aqui seria chute. O link
  // calcula certinho quando ele põe a rua — aqui o link É a resposta, então ele
  // vai mesmo que já tenha ido antes.
  if (porBairro.length || porKm.length) {
    return `A taxa depende do seu endereço.${tempo}${NL}Põe o endereço aqui que ele já mostra o valor certinho:${NL}${link}`
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
async function chamadoAberto(supabase: Sb, empresaId: string, phone: string) {
  const { data } = await supabase.from("whatsapp_chamados")
    .select("id").eq("empresa_id", empresaId).is("atendido_em", null)
    .like("phone", `%${chave8(phone)}`).limit(1).maybeSingle()
  return data ?? null
}

async function abrirChamado(supabase: Sb, empresaId: string, phone: string, motivo: string) {
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
    const linkRecente = recentes.some((m: Record<string, unknown>) =>
      String(m.content ?? "").includes("lojaonline.fwcinter.com"))
    const perguntouDoAtendente = String(recentes[0]?.content ?? "").includes(MARCA_ATENDENTE)

    const t = semAcento(mensagem).trim()

    // 1) "Não precisa" fecha o assunto na hora. O "sim" fica pro fim: se a
    //    mensagem seguinte for uma pergunta que o robô SABE responder, ele
    //    responde — "manda o cardapio" virava "já chamei alguém", que é o robô
    //    ignorando o cliente com educação.
    if (perguntouDoAtendente && /^(nao|nn|deixa|obrigad|valeu|blz|beleza|tudo bem)/.test(t)) {
      return await responder(`Beleza! 👍 Qualquer coisa é só chamar.${linkRecente ? "" : `${NL}${link}`}`)
    }

    // 2) "Só tem isso?" / "tem mais?" — é a MESMA pergunta de novo, e responder
    //    a mesma lista é o robô parecendo quebrado. Aqui ele volta na pergunta
    //    anterior do cliente, procura fundo e mostra só o que ainda não mostrou.
    const ultimaLista = recentes.find((m: Record<string, unknown>) =>
      String(m.content ?? "").startsWith(RESPOSTA_TEM))?.content as string | undefined
    const pedeMais = /\b(so|somente|apenas)\b.*\b(isso|isto|esse|esses|essa|essas)\b|tem mais|tem outr|mais algum|mais opc|nada mais|so tem esse/.test(t)
    if (ultimaLista && pedeMais) {
      const { data: falas } = await supabase.from("whatsapp_conversas")
        .select("content, created_at").eq("empresa_id", empresaId)
        .like("phone", `%${chave8(phone)}`).eq("role", "user")
        .gte("created_at", umaHora).order("created_at", { ascending: false }).limit(4)
      // [0] é a mensagem de agora (o webhook grava antes de chamar o robô).
      const anterior = (Array.isArray(falas) ? falas : [])
        .map((f: Record<string, unknown>) => String(f.content ?? ""))
        .find(c => semAcento(c).trim() !== t)
      const jaMostrados = new Set(
        ultimaLista.split(NL).slice(1)
          .map(l => semAcento(l.split("—")[0]).trim()).filter(Boolean),
      )
      const achados = anterior ? await buscarProdutos(supabase, empresaId, anterior) : []
      const novos = achados.filter(p => !jaMostrados.has(semAcento(String(p.nome ?? "")).trim()))
      if (novos.length) {
        return await responder(`Tem mais sim! 🙌${NL}${listaDeProdutos(novos)}`)
      }
      // Nada além do que já foi dito. Não inventa sabor: assume e oferece gente.
      return await responder(
        `Do que tá no cardápio hoje é isso mesmo. 😉 Quer que eu ${MARCA_ATENDENTE} pra confirmar?`,
      )
    }

    // 3) "Tem X?" — o cardápio responde.
    const doProduto = await respostaDeProduto(supabase, empresaId, mensagem, linkRecente ? null : link)
    // Mesma resposta duas vezes seguidas soa a robô travado. Se a lista é a que
    // ele já mandou, ele para de repetir e chama gente.
    if (doProduto && recentes.some((m: Record<string, unknown>) => m.content === doProduto)) {
      return await responder(
        `Do que tá no cardápio hoje é isso mesmo. 😉 Quer que eu ${MARCA_ATENDENTE} pra te ajudar?`,
      )
    }
    if (doProduto) return await responder(doProduto)

    // 4) Cardápio, horário, taxa de entrega, endereço.
    const daInfo = respostaDeInfo(mensagem, empresa, link)
    if (daInfo) return await responder(daInfo)

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
      const proprio = String(cfg.resposta_link_texto ?? "").trim()
      // CURTA de propósito: ninguém lê parágrafo de robô. Duas linhas e o link —
      // o preview do WhatsApp já mostra o nome e a foto da loja de graça.
      return await responder(proprio ? `${proprio}${NL}${link}` : `Oi! 👋 Peça aqui, é rapidinho:${NL}${link}`)
    }

    // 7) Já mandou o link e não soube responder. Não inventa: oferece gente.
    return await responder(`Essa eu não sei te responder. 😅 Quer que eu ${MARCA_ATENDENTE} pra te ajudar?`)
  } catch (e) {
    console.error("[link] falhou:", e)
    return false
  }
}
