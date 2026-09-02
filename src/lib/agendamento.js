// Pedido agendado: quais dias e horas o cliente pode escolher.
//
// A regra de quando a loja abre já existe (lib/feriados: grade da semana,
// feriado e exceção marcada na mão). Aqui isso vira lista de horários clicáveis:
// só dentro dos períodos que a loja abre, respeitando a antecedência mínima e
// sem oferecer horário que já passou.
//
// Tudo no fuso da loja (America/Fortaleza, o mesmo do resto do sistema). O
// celular do cliente pode estar em qualquer fuso — por isso a hora escolhida
// vira ISO com o -03:00 escrito na mão, e não `new Date(...)` do aparelho dele.
import { comoFicaNoDia, hojeBR } from './feriados'

const FUSO = 'America/Fortaleza'
const p2 = (n) => String(n).padStart(2, '0')

export const PASSO_MIN = 30   // de meia em meia hora

const paraMin = (hm) => {
  const [h, m] = String(hm ?? '').slice(0, 5).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const paraHM = (min) => `${p2(Math.floor(min / 60) % 24)}:${p2(min % 60)}`

// Agora na loja, em minutos do dia (e a data de hoje na loja).
function agoraNaLoja() {
  const hm = new Date().toLocaleTimeString('en-GB', {
    hour12: false, timeZone: FUSO, hour: '2-digit', minute: '2-digit',
  })
  return { ymd: hojeBR(), min: paraMin(hm) }
}

// Soma dias numa data YYYY-MM-DD sem passar por fuso nenhum.
function somaDias(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`
}

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

export function rotuloDoDia(ymd, hoje = hojeBR()) {
  if (ymd === hoje) return 'Hoje'
  if (ymd === somaDias(hoje, 1)) return 'Amanhã'
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return `${DIAS_SEMANA[dt.getDay()]} ${p2(d)}/${p2(m)}`
}

/**
 * Dias com horários livres pra agendar.
 *
 * @param dias        até quantos dias à frente (0 = só hoje)
 * @param antecedencia minutos mínimos entre agora e o horário escolhido
 * @returns [{ ymd, rotulo, horarios: ['11:00', '11:30', ...] }] — dias sem
 *          horário sobrando não entram na lista.
 */
export function diasParaAgendar({
  grade, excecoes = {}, fechaFeriado = false,
  dias = 2, antecedencia = 60, passo = PASSO_MIN,
} = {}) {
  const { ymd: hoje, min: agora } = agoraNaLoja()
  const saida = []

  for (let i = 0; i <= Math.max(0, dias); i++) {
    const ymd = somaDias(hoje, i)
    const dia = comoFicaNoDia(ymd, { grade, excecoes, fechaFeriado })
    if (!dia.aberto) continue

    // Loja sem grade cadastrada não tem período nenhum: oferece o comercial
    // (8h às 22h) em vez de não oferecer nada — é melhor um palpite razoável
    // que o cliente pode conferir do que a tela dizer "não dá pra agendar".
    const periodos = dia.periodos.length ? dia.periodos : [{ i: '08:00', f: '22:00' }]

    const horarios = []
    for (const p of periodos) {
      if (!p?.i || !p?.f) continue
      const ini = paraMin(p.i)
      // Período que vira a madrugada (18:00–02:00) fecha no fim do dia: o resto
      // pertence ao dia seguinte, e é lá que ele vai aparecer.
      const fim = paraMin(p.f) > ini ? paraMin(p.f) : 24 * 60
      // Primeiro múltiplo do passo dentro do período.
      let t = Math.ceil(ini / passo) * passo
      for (; t < fim; t += passo) {
        // Só hoje tem "já passou": nos outros dias o dia inteiro serve.
        if (i === 0 && t < agora + antecedencia) continue
        horarios.push(paraHM(t))
      }
    }
    if (horarios.length) {
      saida.push({ ymd, rotulo: rotuloDoDia(ymd, hoje), horarios: [...new Set(horarios)].sort() })
    }
  }
  return saida
}

// 'YYYY-MM-DD' + 'HH:MM' → ISO com o fuso da loja escrito na mão.
export const paraISO = (ymd, hm) => `${ymd}T${String(hm).slice(0, 5)}:00-03:00`

// Como a hora agendada aparece pro cliente e pra loja: "hoje às 11:30".
export function rotuloAgendado(iso, { comData = false } = {}) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
  const hm = d.toLocaleTimeString('pt-BR', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit',
  })
  const dia = rotuloDoDia(ymd)
  if (!comData && (dia === 'Hoje' || dia === 'Amanhã')) return `${dia.toLowerCase()} às ${hm}`
  return `${dia} às ${hm}`
}

// Ainda falta tempo pra hora combinada? É o que segura o pedido na aba
// Agendados — e o que impede a cozinha de imprimir o almoço às 8 da manhã.
export function aguardandoHora(iso, liberaMin = 45) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return t - Date.now() > Math.max(0, liberaMin) * 60 * 1000
}
