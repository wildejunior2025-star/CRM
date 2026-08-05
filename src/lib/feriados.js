// Feriados e datas especiais da loja.
//
// A grade semanal (empresas.horarios_funcionamento) responde "toda terça a loja
// abre?". Aqui entra a resposta pra UMA data: 25/12 a loja abre? E naquele feriado
// que a loja resolveu abrir assim mesmo?
//
// Ordem de quem manda (mig 0142):
//   1. dias_excecao  — o dono marcou essa data na mão (fecha OU abre)
//   2. feriado nacional, se a loja marcou "fecha em feriado"
//   3. a grade da semana
//
// A lista de feriados é calculada aqui e não no banco: assim vale pra qualquer ano
// sem ninguém precisar cadastrar nada em janeiro.

const p2 = (n) => String(n).padStart(2, '0')
export const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const somaDias = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher) — é dele que saem Carnaval,
// Sexta-feira Santa e Corpus Christi, que mudam de data todo ano.
function domingoDePascoa(ano) {
  const a = ano % 19
  const b = Math.floor(ano / 100)
  const c = ano % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mes = Math.floor((h + l - 7 * m + 114) / 31)
  const dia = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(ano, mes - 1, dia)
}

// Feriados NACIONAIS do ano. `facultativo` marca os que por lei são ponto
// facultativo (Carnaval e Corpus Christi): comércio costuma escolher, então eles
// aparecem na lista mas o dono decide.
export function feriadosNacionais(ano) {
  const pascoa = domingoDePascoa(ano)
  const lista = [
    { data: `${ano}-01-01`, nome: 'Confraternização Universal' },
    { data: ymd(somaDias(pascoa, -48)), nome: 'Carnaval (segunda)', facultativo: true },
    { data: ymd(somaDias(pascoa, -47)), nome: 'Carnaval (terça)', facultativo: true },
    { data: ymd(somaDias(pascoa, -46)), nome: 'Quarta-feira de Cinzas (até 12h)', facultativo: true },
    { data: ymd(somaDias(pascoa, -2)), nome: 'Sexta-feira Santa' },
    { data: `${ano}-04-21`, nome: 'Tiradentes' },
    { data: `${ano}-05-01`, nome: 'Dia do Trabalho' },
    { data: ymd(somaDias(pascoa, 60)), nome: 'Corpus Christi', facultativo: true },
    { data: `${ano}-09-07`, nome: 'Independência do Brasil' },
    { data: `${ano}-10-12`, nome: 'Nossa Senhora Aparecida' },
    { data: `${ano}-11-02`, nome: 'Finados' },
    { data: `${ano}-11-15`, nome: 'Proclamação da República' },
    { data: `${ano}-11-20`, nome: 'Consciência Negra' },
    { data: `${ano}-12-25`, nome: 'Natal' },
  ]
  return lista.sort((a, b) => a.data.localeCompare(b.data))
}

// Mapa { 'YYYY-MM-DD': nome } dos feriados do ano daquela data.
const cacheFeriados = new Map()
export function feriadosDoAno(ano) {
  if (!cacheFeriados.has(ano)) {
    cacheFeriados.set(ano, Object.fromEntries(feriadosNacionais(ano).map(f => [f.data, f.nome])))
  }
  return cacheFeriados.get(ano)
}

export const gradeValida = (grade) => Array.isArray(grade) && grade.length === 7

// Como a loja fica NUMA data. Devolve { aberto, periodos, motivo }.
//   grade      — empresas.horarios_funcionamento
//   excecoes   — { 'YYYY-MM-DD': { aberto, periodos, motivo } } (tabela dias_excecao)
//   fechaFeriado — empresas.feriados_fecha
function diaDaSemanaDe(dataYMD) {
  const [y, m, d] = dataYMD.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}
export function comoFicaNoDia(dataYMD, { grade, excecoes = {}, fechaFeriado = false } = {}) {
  const daGrade = gradeValida(grade) ? grade[diaDaSemanaDe(dataYMD)] : null
  const periodosGrade = Array.isArray(daGrade?.periodos) ? daGrade.periodos : []

  // 1) Marcação na mão vence tudo — inclusive abrir num feriado que a loja fecha.
  const exc = excecoes[dataYMD]
  if (exc) {
    if (!exc.aberto) return { aberto: false, periodos: [], motivo: exc.motivo || 'Fechado nesse dia' }
    const periodos = (Array.isArray(exc.periodos) && exc.periodos.length) ? exc.periodos
      : (periodosGrade.length ? periodosGrade : [{ i: '00:00', f: '23:59' }])
    return { aberto: true, periodos, motivo: exc.motivo || 'Aberto nesse dia' }
  }

  // 2) Feriado nacional, pra quem marcou que fecha em feriado.
  if (fechaFeriado) {
    const nome = feriadosDoAno(Number(dataYMD.slice(0, 4)))[dataYMD]
    if (nome) return { aberto: false, periodos: [], motivo: nome }
  }

  // 3) A grade da semana. Sem grade cadastrada, não restringe nada (é o que o
  //    sistema fazia antes de existir grade — não dá pra fechar a loja de ninguém).
  if (!gradeValida(grade)) return { aberto: true, periodos: [], motivo: '' }
  return { aberto: !!daGrade?.aberto, periodos: periodosGrade, motivo: '' }
}

// Hoje no fuso da loja (o sistema inteiro usa America/Fortaleza).
export const hojeBR = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()) // 'YYYY-MM-DD'

// Está aberto AGORA?
export function abertaAgora({ grade, excecoes, fechaFeriado } = {}) {
  const agora = new Date()
  const dia = comoFicaNoDia(hojeBR(), { grade, excecoes, fechaFeriado })
  if (!dia.aberto) return false
  if (!dia.periodos.length) return true   // sem grade cadastrada = sem restrição
  const hm = agora.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' })
  const toMin = (t) => { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  const now = toMin(hm)
  return dia.periodos.some(p => {
    if (!p?.i || !p?.f) return false
    const a = toMin(p.i), b = toMin(p.f)
    return a <= b ? (now >= a && now < b) : (now >= a || now < b)  // vira a madrugada
  })
}

// Quantos dias a loja abre no mês da data informada — o divisor do rateio de custo
// fixo em Despesas & Lucro. Conta dia a dia, então já desconta feriado e folga.
export function diasAbertosNoMes(dataYMD, { grade, excecoes, fechaFeriado } = {}) {
  if (!gradeValida(grade) || !grade.some(d => d?.aberto)) return null
  const [y, m] = dataYMD.split('-').map(Number)
  const ultimo = new Date(y, m, 0).getDate()
  let n = 0
  for (let d = 1; d <= ultimo; d++) {
    if (comoFicaNoDia(`${y}-${p2(m)}-${p2(d)}`, { grade, excecoes, fechaFeriado }).aberto) n++
  }
  return n || null
}

// Carrega as exceções da loja no formato que as funções acima esperam.
export async function carregarExcecoes(supabase, empresaId, { de, ate } = {}) {
  if (!empresaId) return {}
  let q = supabase.from('dias_excecao').select('data, aberto, periodos, motivo').eq('empresa_id', empresaId)
  if (de) q = q.gte('data', de)
  if (ate) q = q.lte('data', ate)
  const { data } = await q
  return Object.fromEntries((data ?? []).map(r => [r.data, r]))
}
