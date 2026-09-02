// Pedido agendado: quais dias e faixas o cliente pode escolher.
//
// A loja cadastra as JANELAS dela ("08:00 às 18:00, até 10 pedidos" — mig 0225)
// e a regra de quando ela abre já existe (lib/feriados: grade da semana,
// feriado e exceção marcada na mão). Aqui as duas coisas viram a lista de
// opções clicáveis: só nos dias em que abre, respeitando a antecedência mínima
// e sem oferecer janela que já passou ou que bateu o limite.
//
// Tudo no fuso da loja (America/Fortaleza, o mesmo do resto do sistema). O
// celular do cliente pode estar em qualquer fuso — por isso a hora escolhida
// vira ISO com o -03:00 escrito na mão, e não `new Date(...)` do aparelho dele.
import { comoFicaNoDia, hojeBR } from './feriados'

const FUSO = 'America/Fortaleza'
const p2 = (n) => String(n).padStart(2, '0')

const paraMin = (hm) => {
  const [h, m] = String(hm ?? '').slice(0, 5).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

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
 * Dias com FAIXAS livres pra agendar (mig 0225).
 *
 * A loja cadastra as janelas dela ("08:00 às 18:00, até 10 pedidos"); aqui elas
 * viram opção clicável nos próximos dias em que a loja abre. Faixa que já
 * acabou, que não cabe na antecedência mínima ou que bateu o limite não entra.
 *
 * @param faixas  [{ i, f, limite }] — empresas.agendamento_faixas
 * @param vagas   { 'YYYY-MM-DD': { 'HH:MM': { usados, limite } } } — o que a
 *                RPC agendamento_vagas devolveu. Dia sem resposta ainda conta
 *                como livre: melhor oferecer e o servidor recusar do que
 *                esconder tudo enquanto a consulta não volta.
 * @returns [{ ymd, rotulo, faixas: [{ i, f, rotulo, cheia }] }]
 */
export function diasParaAgendar({
  grade, excecoes = {}, fechaFeriado = false,
  dias = 2, antecedencia = 60, faixas = [], vagas = {},
} = {}) {
  const { ymd: hoje, min: agora } = agoraNaLoja()
  const limpas = (Array.isArray(faixas) ? faixas : [])
    .filter(f => f?.i && f?.f)
    .sort((a, b) => paraMin(a.i) - paraMin(b.i))
  if (!limpas.length) return []

  const saida = []
  for (let i = 0; i <= Math.max(0, dias); i++) {
    const ymd = somaDias(hoje, i)
    if (!comoFicaNoDia(ymd, { grade, excecoes, fechaFeriado }).aberto) continue

    const doDia = []
    for (const f of limpas) {
      const ini = paraMin(f.i)
      const fim = paraMin(f.f) > ini ? paraMin(f.f) : 24 * 60
      // Hoje: a janela precisa ter sobra depois da antecedência mínima. Faixa
      // que termina antes disso não serve mais.
      if (i === 0 && fim <= agora + antecedencia) continue
      const v = vagas?.[ymd]?.[f.i]
      const limite = Number(v?.limite ?? f.limite ?? 0)
      const usados = Number(v?.usados ?? 0)
      doDia.push({
        i: f.i, f: f.f,
        rotulo: `${f.i} às ${f.f}`,
        cheia: limite > 0 && usados >= limite,
      })
    }
    // Dia inteiro esgotado ainda aparece: o cliente precisa entender que tem
    // horário, e que ele acabou — some da lista parece que a loja não agenda.
    if (doDia.length) saida.push({ ymd, rotulo: rotuloDoDia(ymd, hoje), faixas: doDia })
  }
  return saida
}

// 'YYYY-MM-DD' + 'HH:MM' → ISO com o fuso da loja escrito na mão.
export const paraISO = (ymd, hm) => `${ymd}T${String(hm).slice(0, 5)}:00-03:00`

// Como a janela agendada aparece pro cliente e pra loja: "hoje das 14:00 às
// 14:30". Sem o fim (pedido antigo, de antes das faixas) volta ao "às 14:30".
export function rotuloAgendado(iso, { comData = false, ate = null } = {}) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
  const hm = d.toLocaleTimeString('pt-BR', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit',
  })
  const fim = ate ? new Date(ate) : null
  const hmFim = fim && !Number.isNaN(fim.getTime())
    ? fim.toLocaleTimeString('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' })
    : null
  const quando = hmFim ? `das ${hm} às ${hmFim}` : `às ${hm}`
  const dia = rotuloDoDia(ymd)
  if (!comData && (dia === 'Hoje' || dia === 'Amanhã')) return `${dia.toLowerCase()} ${quando}`
  return `${dia} ${quando}`
}

// Ainda falta tempo pra hora combinada? É o que segura o pedido na aba
// Agendados — e o que impede a cozinha de imprimir o almoço às 8 da manhã.
export function aguardandoHora(iso, liberaMin = 45) {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return t - Date.now() > Math.max(0, liberaMin) * 60 * 1000
}
