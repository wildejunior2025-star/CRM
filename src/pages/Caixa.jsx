import { Fragment, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { FORMAS_VALE } from '../lib/constants'
import '../components/Page.css'
import './Caixa.css'

const STATUS_BADGE = {
  aberto: 'badge-success',
  fechado: 'badge-neutral',
}

// ── Semana do histórico ────────────────────────────────────────────────
// O histórico trazia os 20 últimos caixas de uma vez: uma parede de linhas
// que ninguém lê, e quase sempre a pessoa quer ver só a semana. Agora vem
// uma semana por vez (segunda a domingo) e as setas andam pra trás.
// offset 0 = esta semana, -1 = a passada, e assim por diante.
function semanaDe(offset) {
  const inicio = new Date()
  inicio.setHours(0, 0, 0, 0)
  const diaDaSemana = (inicio.getDay() + 6) % 7   // getDay(): 0=domingo; aqui 0=segunda
  inicio.setDate(inicio.getDate() - diaDaSemana + offset * 7)
  const fim = new Date(inicio)
  fim.setDate(inicio.getDate() + 7)
  return { inicio, fim }
}

const ddmm = (d) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })

// ── MODO "UM DIA POR VEZ" (mig 0336) ───────────────────────────────────────
// O fuso e fixo em America/Fortaleza, o MESMO que a funcao do banco usa pra
// decidir a que dia pertence cada venda. Se a tela usasse o fuso do navegador
// e o banco outro, a venda das 23h cairia num dia na lista e noutro no total.
const FUSO = 'America/Fortaleza'
const ymdLocal = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: FUSO })
// Meio-dia de proposito: somar dias a partir da meia-noite escorrega quando o
// horario de verao volta.
const addDia = (ymd, n) => {
  const d = new Date(ymd + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('sv-SE')
}
const ddmmDeYMD = (ymd) => ymd.split('-').reverse().slice(0, 2).join('/')
// Comeco e fim do dia em ISO, pra filtrar `created_at` (que e timestamptz).
const limitesDoDia = (ymd) => {
  const ini = new Date(ymd + 'T00:00:00-03:00')
  const fim = new Date(ini.getTime() + 24 * 3600 * 1000)
  return [ini.toISOString(), fim.toISOString()]
}

// Como cada forma aparece na lista de sangrias/suprimentos.
const rotuloForma = (f) => (f === 'pix' ? '📱 PIX' : f === 'cartao' ? '💳 Cartão' : '💵 Dinheiro')

// A forma de um PAGAMENTO tem mais casos que a de uma sangria: crédito e débito
// entram separados (o caixa soma cada um), e ainda tem transferência e cashback.
const FORMAS_PAG = [
  { id: 'dinheiro',      rotulo: '💵 Dinheiro',      casa: f => f === 'dinheiro' || !f },
  { id: 'pix',           rotulo: '📱 PIX',           casa: f => f === 'pix' },
  { id: 'cartao',        rotulo: '💳 Cartão',        casa: f => f === 'credito' || f === 'debito' || f === 'cartao' },
  { id: 'transferencia', rotulo: '🏦 Transferência', casa: f => f === 'transferencia' },
  { id: 'cashback',      rotulo: '🎁 Cashback',      casa: f => f === 'cashback' },
  // Cartões de benefício (mig 0388): linha própria, fora do cartão e da taxa dele.
  { id: 'vale',          rotulo: '🍽️ Vale',          casa: f => ['pluxee', 'alelo', 'vr', 'ticket'].includes(f) },
]
const rotuloPagamento = (f) => {
  if (f === 'credito') return '💳 Crédito'
  if (f === 'debito') return '💳 Débito'
  if (f === 'pluxee') return '🍽️ Pluxee'
  if (f === 'alelo') return '🍽️ Alelo'
  if (f === 'vr') return '🍽️ VR'
  if (f === 'ticket') return '🍽️ Ticket'
  return FORMAS_PAG.find(x => x.casa(f))?.rotulo ?? f
}

function rotuloSemana(offset) {
  const { inicio, fim } = semanaDe(offset)
  const ultimo = new Date(fim)
  ultimo.setDate(ultimo.getDate() - 1)
  const faixa = `${ddmm(inicio)} a ${ddmm(ultimo)}`
  if (offset === 0) return `Esta semana · ${faixa}`
  if (offset === -1) return `Semana passada · ${faixa}`
  return faixa
}

export default function Caixa() {
  const { user, profile, empresa } = useAuth()
  const isAdmin = profile?.perfil === 'admin'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [caixaAtual, setCaixaAtual] = useState(null)
  const [caixasAbertos, setCaixasAbertos] = useState([])  // pra avisar quando ficou mais de um
  const [resumo, setResumo] = useState(null)
  const [movimentos, setMovimentos] = useState([])
  const [historico, setHistorico] = useState([])
  // Resumo de cada caixa da semana (null = ainda somando). É o que alimenta o
  // total da semana embaixo da tabela.
  // Modo "um dia por vez": a loja escolhe em Minha Loja. Desligado = o caixa
  // abre e fecha na mao, como sempre.
  const [porDia, setPorDia] = useState(false)
  const [dia, setDia] = useState(ymdLocal)
  const [diaRow, setDiaRow] = useState(null)        // fechamento deste dia
  const [diaVersao, setDiaVersao] = useState(0)     // sobe pra recarregar
  const [diasSemana, setDiasSemana] = useState(null) // historico no modo-dia

  const [resumosSemana, setResumosSemana] = useState(null)
  const [semanaOffset, setSemanaOffset] = useState(0)   // 0 = esta semana
  const [carregandoHist, setCarregandoHist] = useState(false)
  const [usuarios, setUsuarios] = useState([])

  // ── CAIXA CEGO (mig 0430) ──
  // Loja com a chave ligada: o VENDEDOR abre e lança os valores, mas não vê quanto
  // tem no caixa, e só fecha se o contado bater (quem confere é o banco, em
  // fechar_caixa). Não bateu: anota o que faltou ou pede ao dono pra liberar.
  // O admin vê e fecha tudo como sempre.
  const [caixaCego, setCaixaCego] = useState(false)
  const cego = caixaCego && !isAdmin
  const [naoBateu, setNaoBateu] = useState(null)     // formas que não bateram: ['dinheiro', ...]
  const [liberando, setLiberando] = useState(false)
  // Código de 4 dígitos que o dono recebe no WhatsApp quando o caixa não bate e
  // passa pro vendedor. Evita o dono ter que entrar no sistema e redigitar tudo.
  const [codigoLib, setCodigoLib] = useState('')
  const [codigoErro, setCodigoErro] = useState('')
  const [fechouOk, setFechouOk] = useState(false)

  // Regra "abre com o que fechou" (por loja). Quando está ligada, a abertura não
  // é digitada: vem do último caixa fechado. O banco trava do mesmo jeito — isto
  // aqui é só pra tela não pedir um número que seria ignorado.
  const [regraFechamento, setRegraFechamento] = useState(false)
  const [ultimoFech, setUltimoFech] = useState(null) // { fechado_em, valor_dinheiro, valor_pix }
  const aberturaTravada = regraFechamento && !!ultimoFech

  const [showAbertura, setShowAbertura] = useState(false)
  const [valorAbertura, setValorAbertura] = useState('')
  const [valorAberturaPix, setValorAberturaPix] = useState('')
  const [valorAberturaCartao, setValorAberturaCartao] = useState('')
  const [obsAbertura, setObsAbertura] = useState('')

  const [showMovimento, setShowMovimento] = useState(null) // 'sangria' | 'suprimento' | null
  const [valorMovimento, setValorMovimento] = useState('')
  const [obsMovimento, setObsMovimento] = useState('')
  const [formaMovimento, setFormaMovimento] = useState('dinheiro') // 'dinheiro' | 'pix'

  const [showFechamento, setShowFechamento] = useState(false)
  const [valorFechamento, setValorFechamento] = useState('')
  const [valorFechamentoPix, setValorFechamentoPix] = useState('')
  // Total que a maquineta fechou no dia. Ela liquida na hora, então dá pra bater
  // o papel dela com o que foi lançado — é o que pega a venda esquecida.
  const [valorFechamentoCartao, setValorFechamentoCartao] = useState('')
  const [obsFechamento, setObsFechamento] = useState('')
  // Vales (Pluxee, Alelo, VR, Ticket): cada bandeira tem a PRÓPRIA maquineta, então
  // a conferência é uma por bandeira — esperado (do sistema) x contado (o que a
  // maquineta dela fechou). { pluxee: 120.5, ... } e { pluxee: '120.50', ... }.
  const [valesEsperados, setValesEsperados] = useState({})
  const [valesContados, setValesContados] = useState({})

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)

  const [editandoMovId, setEditandoMovId] = useState(null) // movimento com seletor de forma aberto
  const [salvandoMovForma, setSalvandoMovForma] = useState(false)
  const [excluindoMovId, setExcluindoMovId] = useState(null)

  // ── Taxa da maquineta ──
  // O cartão não cai inteiro na conta: a maquineta come uma % — e ela é
  // DIFERENTE no crédito e no débito. A loja põe cada taxa em Minha Loja →
  // Pagamento; aqui o Caixa só mostra quanto sobra de cada uma.
  const [taxas, setTaxas] = useState({ credito: 0, debito: 0, cartao: 0 })
  const liquido = (bruto, pct) => Number(bruto || 0) * (1 - Number(pct || 0) / 100)
  // O que de fato CAI NA CONTA da maquineta, somando cada forma com a taxa
  // dela. É esse número que o esperado em cartão persegue: o extrato da conta
  // nunca mostra o valor cheio da venda, e é com o extrato que a loja confere.
  // Loja sem taxa cadastrada: líquido = bruto, nada muda.
  //
  // ── DELIVERY E BALCAO DENTRO DO CAIXA (mig 0334) ──
  // O resumo chega com o salao (`recebimentos_*`, que vem do fechamento de
  // conta da mesa) e o delivery/balcao (`delivery_*`, que vem dos pedidos)
  // SEPARADOS. Quem confere a gaveta quer UM numero por forma, entao e aqui
  // que os dois viram um. Antes o delivery simplesmente nao existia nesta
  // tela: a loja vendia 300 reais no cardapio e o caixa fechava zerado.
  const dinheiroDe   = (r) => Number(r?.recebimentos_dinheiro || 0) + Number(r?.delivery_dinheiro || 0)
  const pixDe        = (r) => Number(r?.recebimentos_pix || 0) + Number(r?.delivery_pix || 0)
  const cartaoDe     = (r) => Number(r?.recebimentos_cartao || 0) + Number(r?.delivery_cartao || 0)
  // Pluxee, Alelo, VR e Ticket (mig 0388): mesa/balcão + delivery. Fora do cartão de propósito.
  const valeDe       = (r) => Number(r?.recebimentos_vale || 0) + Number(r?.delivery_vale || 0)
  const creditoDe    = (r) => Number(r?.recebimentos_credito || 0) + Number(r?.delivery_credito || 0)
  const debitoDe     = (r) => Number(r?.recebimentos_debito || 0) + Number(r?.delivery_debito || 0)
  const cartaoGenDe  = (r) => Number(r?.recebimentos_cartao_generico || 0) + Number(r?.delivery_cartao_generico || 0)
  // DINHEIRO QUE NUNCA PASSOU PELA LOJA: pedido pago dentro do app do iFood e
  // PIX pago no nosso checkout (cai no Mercado Pago). E faturamento, mas nao
  // entra em esperado NENHUM — nem gaveta, nem PIX da loja, nem maquineta.
  // Jogar isso no esperado faria o dono caçar todo dia uma falta que nao
  // existe. Ja o iFood cobrado na entrega pelo motoboy DA LOJA e dinheiro de
  // verdade, e esse entra como dinheiro/cartao normal.
  const foraDaLojaDe = (r) => Number(r?.delivery_ifood || 0) + Number(r?.delivery_online || 0)

  // ── DE ONDE VEIO ESTE VALOR ──────────────────────────────────────────────
  // Todo card de dinheiro abre uma lista do que o formou. O total sozinho nao
  // resolve a pergunta que o dono faz quando a gaveta nao bate: "esses R$ 240
  // em dinheiro vieram de onde?". Agora ele clica e ve mesa por mesa, pedido
  // por pedido.
  //
  // O salao sai de `pagamentos` (a observacao ja guarda "Presencial · Comanda
  // 45 · Garcom: pedro") e o delivery sai da view `caixa_delivery_partes`, que
  // e a MESMA que soma o card — por isso a lista sempre fecha com o total.
  const [detalhe, setDetalhe] = useState(null)       // {titulo, formas, baldes, tipo}
  const [detalheLinhas, setDetalheLinhas] = useState(null)  // null | 'carregando' | linhas[]

  const ORIGEM_ROTULO = {
    ifood: '🛵 iFood', balcao: '🏪 Balcão', cardapio: '🛒 Loja online',
    whatsapp: '💬 WhatsApp', app: '📱 App',
  }

  async function abrirDetalhe(cfg) {
    setDetalhe(cfg)
    setDetalheLinhas('carregando')
    const id = caixaAtual?.id
    if (!id && !porDia) { setDetalheLinhas([]); return }
    const [iniDia, fimDia] = limitesDoDia(dia)
    // No modo-dia nao se filtra por caixa: o recorte e a DATA, que e o mesmo
    // recorte que o card usou pra somar.
    const porCaixaOuDia = (q) => (porDia
      ? q.gte('created_at', iniDia).lt('created_at', fimDia)
      : q.eq('caixa_id', id))

    const linhas = []

    // ── Salão (e recebimento de fiado antigo, que tambem cai em `pagamentos`)
    if (cfg.formas?.length) {
      let q = porCaixaOuDia(supabase.from('pagamentos')
        .select('id, valor, forma_pagamento, observacao, created_at'))
        .in('forma_pagamento', cfg.formas)
      if (cfg.soFiadoAntigo) q = q.eq('observacao', 'Recebimento de fiado')
      const { data } = await q
      for (const pg of (data ?? [])) {
        const obs = pg.observacao ?? ''
        const fiadoAntigo = obs === 'Recebimento de fiado'
        // "Presencial · Comanda 45 · Garçom: pedro" -> "Comanda 45" + "Garçom: pedro"
        const pedacos = obs.split('·').map(t => t.trim()).filter(Boolean)
        const mesa = pedacos.find(t => /^(Comanda|Mesa)/i.test(t))
        linhas.push({
          id: 'pg-' + pg.id,
          quando: pg.created_at,
          valor: Number(pg.valor || 0),
          titulo: fiadoAntigo ? '🤝 Fiado antigo recebido' : (mesa ? '🍽️ ' + mesa : '🧾 Venda no balcão'),
          sub: fiadoAntigo ? 'dívida de outro dia — não é venda de hoje'
             : pedacos.filter(t => t !== mesa && t !== 'Presencial').join(' · '),
          forma: pg.forma_pagamento,
        })
      }
    }

    // ── Delivery e balcão (a view ja separou iFood pago no app, PIX do MP etc.)
    if (cfg.baldes?.length) {
      const qd = supabase.from('caixa_delivery_partes')
        .select('pedido_id, bucket, valor, numero_pedido, origem, cliente_nome, created_at, forma_pagamento')
      const { data } = await (porDia ? qd.eq('dia', dia) : qd.eq('caixa_id', id))
        .in('bucket', cfg.baldes)
      for (const d of (data ?? [])) {
        linhas.push({
          id: 'pd-' + d.pedido_id + '-' + d.bucket,
          quando: d.created_at,
          valor: Number(d.valor || 0),
          titulo: (ORIGEM_ROTULO[d.origem] ?? '🛒 Pedido') + ' #' + (d.numero_pedido ?? '—'),
          sub: d.cliente_nome || '',
          forma: d.forma_pagamento,
        })
      }
    }

    // ── Vendas no fiado: a divida que NASCEU neste caixa
    if (cfg.tipo === 'fiado') {
      const { data } = await porCaixaOuDia(supabase.from('vendas')
        .select('id, total, observacoes, created_at, cliente_id'))
        .eq('forma_pagamento', 'fiado').neq('status', 'cancelado')
      const ids = [...new Set((data ?? []).map(v => v.cliente_id).filter(Boolean))]
      let nomes = {}
      if (ids.length) {
        const { data: cli } = await supabase.from('clientes').select('id, nome').in('id', ids)
        nomes = Object.fromEntries((cli ?? []).map(c => [c.id, c.nome]))
      }
      for (const v of (data ?? [])) {
        const obs = v.observacoes ?? ''
        const mesa = obs.split('·').map(t => t.trim()).find(t => /^(Comanda|Mesa)/i.test(t))
        linhas.push({
          id: 'vd-' + v.id,
          quando: v.created_at,
          valor: Number(v.total || 0),
          titulo: '🧾 ' + (nomes[v.cliente_id] || 'Cliente sem cadastro'),
          sub: mesa || obs,
          forma: 'fiado',
        })
      }
    }

    linhas.sort((a, b) => new Date(b.quando) - new Date(a.quando))
    setDetalheLinhas(linhas)
  }

  // Props que transformam um card em botao. O `style` extra entra junto porque
  // varios cards ja tem borda colorida propria.
  const cardClicavel = (cfg, styleExtra = {}) => ({
    onClick: () => abrirDetalhe(cfg),
    role: 'button',
    tabIndex: 0,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirDetalhe(cfg) } },
    title: 'Ver de onde veio este valor',
    style: { cursor: 'pointer', ...styleExtra },
  })

  // A linha de baixo do valor: quanto daquele total e da mesa e quanto e do
  // delivery/balcao. Sem isso o dono ve um numero maior do que esperava e nao
  // tem onde procurar. Some quando nao houve delivery, pra nao poluir a loja
  // que so vende no salao.
  const linhaOrigem = (salao, delivery) => (
    Number(delivery || 0) > 0 ? (
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
        salão R$ {Number(salao || 0).toFixed(2)} · delivery/balcão R$ {Number(delivery).toFixed(2)}
      </div>
    ) : null
  )

  const cartaoLiquidoDe = (r) => (
    liquido(creditoDe(r), taxas.credito) +
    liquido(debitoDe(r), taxas.debito) +
    liquido(cartaoGenDe(r), taxas.cartao)
  )

  // Histórico expandível: mostra o detalhamento por forma de pagamento de um caixa fechado.
  const [histVersao, setHistVersao] = useState(0)         // sobe quando abre/fecha caixa → recarrega a semana
  const [histAberto, setHistAberto] = useState(null)      // id do caixa expandido
  const [histResumo, setHistResumo] = useState({})        // { [caixaId]: resumo | 'loading' }
  // Sangrias/suprimentos de um caixa JÁ FECHADO. O total some no resumo, mas o
  // motivo de cada saída continua salvo — aqui ele volta pra tela.
  const [histMovs, setHistMovs] = useState({})            // { [caixaId]: movimentos[] }
  // O que ENTROU no caixa, um por um. O resumo só dava o total por forma; pra
  // conferir com o extrato do Mercado Pago (ou com a maquineta) é preciso ver
  // lançamento por lançamento — e era isso que obrigava a abrir o banco.
  const [histPagos, setHistPagos] = useState({})          // { [caixaId]: pagamentos[] }
  const [filtroForma, setFiltroForma] = useState('todos')
  async function toggleHist(c) {
    const abrir = histAberto !== c.id
    setHistAberto(abrir ? c.id : null)
    setFiltroForma('todos')
    if (abrir && !histResumo[c.id]) {
      setHistResumo(m => ({ ...m, [c.id]: 'loading' }))
      const [resumoRes, movsRes, pagosRes] = await Promise.all([
        supabase.from('caixa_resumo').select('*').eq('caixa_id', c.id).maybeSingle(),
        supabase.from('caixa_movimentos').select('*').eq('caixa_id', c.id).order('created_at', { ascending: false }),
        supabase.from('pagamentos')
          .select('id, valor, forma_pagamento, observacao, created_at, clientes(nome)')
          .eq('caixa_id', c.id)
          .order('created_at', { ascending: false }),
      ])
      setHistMovs(m => ({ ...m, [c.id]: movsRes.data ?? [] }))
      setHistPagos(m => ({ ...m, [c.id]: pagosRes.data ?? [] }))
      setHistResumo(m => ({ ...m, [c.id]: resumoRes.data || {} }))
    }
  }

  // Corrige a forma (dinheiro/pix) de uma sangria/suprimento já registrado.
  async function trocarFormaMovimento(m, forma) {
    if (forma === (m.forma ?? 'dinheiro')) { setEditandoMovId(null); return }
    setSalvandoMovForma(true)
    const { error: rpcError } = await supabase.rpc('alterar_forma_movimento_caixa', {
      p_id: m.id, p_forma: forma,
    })
    setSalvandoMovForma(false)
    setEditandoMovId(null)
    if (rpcError) { window.alert('Não deu pra trocar a forma: ' + rpcError.message); return }
    loadAll()
  }

  // Apaga uma sangria/suprimento lançado errado. Só aparece no caixa ABERTO —
  // depois de fechado o banco recusa, porque o fechamento é a foto do dia.
  // Antes disso o jeito de consertar era lançar um suprimento do mesmo valor:
  // o total voltava ao certo, mas o extrato ficava com duas linhas inventadas.
  async function excluirMovimento(m) {
    const oque = m.tipo === 'sangria' ? 'sangria' : 'suprimento'
    const ok = window.confirm(
      `Apagar esta ${oque} de R$ ${Number(m.valor).toFixed(2)}?`
      + (m.observacao ? `\n\n"${m.observacao}"` : '')
      + '\n\nDepois que o caixa fechar não dá mais.'
    )
    if (!ok) return
    setExcluindoMovId(m.id)
    const { error: rpcError } = await supabase.rpc('excluir_movimento_caixa', { p_id: m.id })
    setExcluindoMovId(null)
    if (rpcError) { window.alert('Não deu pra apagar: ' + rpcError.message); return }
    loadAll()
  }

  async function loadAll() {
    setLoading(true)
    setError(null)

    // O CAIXA É DA LOJA (mig 0287).
    //
    // Era um por login: na Branka a mesma pessoa tem dois acessos e as vendas do
    // dia caíam metade num caixa, metade no outro — o caixa mostrava R$ 331 de
    // fiado enquanto o Fiado da loja somava R$ 411 (30/09). Agora a tela mostra
    // o caixa aberto DA LOJA (o mais recente), que é o mesmo que a venda usa.
    //
    // Traz os abertos (não só 1) pra poder avisar quando ficou mais de um aberto
    // do jeito antigo — é o que mistura dia com dia.
    const caixaAtivaQuery = supabase
      .from('caixas').select('*')
      .eq('status', 'aberto').order('aberto_em', { ascending: false })

    // O histórico não vem mais aqui: ele tem carregamento próprio, por semana
    // (ver carregarHistorico), pra andar entre as semanas sem recarregar a tela
    // inteira e pra não puxar caixa que ninguém vai olhar.
    const [caixaRes, usuariosRes, empresaRes] = await Promise.all([
      caixaAtivaQuery,
      isAdmin ? supabase.from('profiles').select('id, nome, email') : Promise.resolve({ data: [] }),
      profile?.empresa_id
        ? supabase.from('empresas').select('taxa_cartao_pct, taxa_credito_pct, taxa_debito_pct, caixa_abre_com_fechamento, caixa_por_dia, caixa_cego').eq('id', profile.empresa_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    setRegraFechamento(!!empresaRes.data?.caixa_abre_com_fechamento)
    setCaixaCego(!!empresaRes.data?.caixa_cego)
    // RPC (e não select) porque pela RLS o vendedor não enxerga o caixa que
    // outra pessoa fechou — e é justamente esse valor que ele precisa ver.
    const { data: fech } = await supabase.rpc('ultimo_fechamento_caixa')
    setUltimoFech(Array.isArray(fech) ? (fech[0] ?? null) : (fech ?? null))
    setTaxas({
      credito: Number(empresaRes.data?.taxa_credito_pct ?? 0),
      debito: Number(empresaRes.data?.taxa_debito_pct ?? 0),
      cartao: Number(empresaRes.data?.taxa_cartao_pct ?? 0),
    })

    const firstError = caixaRes.error || usuariosRes.error
    if (firstError) setError(firstError.message)

    setUsuarios(usuariosRes.data ?? [])

    // MODO DIA: quem monta a tela e o efeito do dia (logo abaixo), nao este.
    // Sair aqui evita que o caixa aberto sobrescreva o dia escolhido — eram as
    // duas coisas disputando o mesmo `caixaAtual`.
    const ehPorDia = !!empresaRes.data?.caixa_por_dia
    setPorDia(ehPorDia)
    if (ehPorDia) {
      setCaixasAbertos([])
      setDiaVersao(v => v + 1)
      setLoading(false)
      return
    }

    setCaixaAtual(caixaRes.data?.[0] ?? null)
    setCaixasAbertos(caixaRes.data ?? [])

    if (caixaRes.data?.[0]) {
      const [resumoRes, movimentosRes] = await Promise.all([
        supabase.from('caixa_resumo').select('*').eq('caixa_id', caixaRes.data[0].id).maybeSingle(),
        supabase
          .from('caixa_movimentos')
          .select('*')
          .eq('caixa_id', caixaRes.data[0].id)
          .order('created_at', { ascending: false }),
      ])
      setResumo(resumoRes.data ?? null)
      setMovimentos(movimentosRes.data ?? [])
    } else {
      setResumo(null)
      setMovimentos([])
    }

    setHistVersao(v => v + 1)   // abrir/fechar caixa muda a lista da semana
    setLoading(false)
  }

  useEffect(() => {
    if (user?.id) loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // ── Carrega UM dia ────────────────────────────────────────────────────────
  // Os numeros vem da funcao `caixa_resumo_do_dia`, que devolve exatamente as
  // mesmas colunas do `caixa_resumo`. Por isso os cards, o esperado e o pop-up
  // de "de onde veio" funcionam nos dois modos sem saber em qual estao.
  useEffect(() => {
    if (!porDia || !user?.id || !profile?.empresa_id) return
    let vivo = true
    ;(async () => {
      setLoading(true)
      const ontem = addDia(dia, -1)
      const [ini, fim] = limitesDoDia(dia)
      const [resDia, resFech, resMovs] = await Promise.all([
        supabase.rpc('caixa_resumo_do_dia', { p_data: dia }),
        supabase.from('caixa_dia').select('*').in('data', [dia, ontem]),
        supabase.from('caixa_movimentos').select('*')
          .gte('created_at', ini).lt('created_at', fim)
          .order('created_at', { ascending: false }),
      ])
      if (!vivo) return

      const linhaHoje  = (resFech.data ?? []).find(d => d.data === dia) ?? null
      const linhaOntem = (resFech.data ?? []).find(d => d.data === ontem) ?? null
      setDiaRow(linhaHoje)

      // De onde sai a abertura do dia (decisao do dono, 17/10): cada loja
      // escolhe. Com a regra ligada o dia herda o que foi CONTADO ontem — a
      // gaveta nao foi esvaziada, o troco continua la. Sem a regra, comeca em
      // zero (ou no que alguem digitou pra este dia).
      const herda = regraFechamento && linhaOntem?.contado_dinheiro != null
      const abertura = herda
        ? {
            dinheiro: Number(linhaOntem.contado_dinheiro || 0),
            pix:      Number(linhaOntem.contado_pix || 0),
            cartao:   Number(linhaOntem.contado_cartao || 0),
          }
        : {
            dinheiro: Number(linhaHoje?.abertura_dinheiro || 0),
            pix:      Number(linhaHoje?.abertura_pix || 0),
            cartao:   Number(linhaHoje?.abertura_cartao || 0),
          }

      // `caixaAtual` de mentirinha: o resto da tela ja sabe fazer a conta a
      // partir dele, entao o modo-dia entra sem reescrever nada disso.
      setCaixaAtual({
        id: null, porDia: true, aberto_em: dia + 'T00:00:00',
        valor_abertura: abertura.dinheiro,
        valor_abertura_pix: abertura.pix,
        valor_abertura_cartao: abertura.cartao,
      })
      setResumo(Array.isArray(resDia.data) ? (resDia.data[0] ?? null) : (resDia.data ?? null))
      setMovimentos(resMovs.data ?? [])
      setError(resDia.error?.message ?? null)
      setLoading(false)
    })()
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [porDia, dia, diaVersao, regraFechamento, user?.id, profile?.empresa_id])

  // Histórico: uma semana por vez. Roda ao abrir a tela, ao trocar de semana e
  // depois de abrir/fechar um caixa (loadAll mexe no histVersao).
  useEffect(() => {
    if (!user?.id) return
    let vivo = true
    async function carregarHistorico() {
      setCarregandoHist(true)
      const { inicio, fim } = semanaDe(semanaOffset)

      // MODO DIA: a semana e uma lista de DIAS. Em vez de uma linha por caixa
      // aberto (que no modo-dia nem existe), uma linha por dia com o resumo
      // dele — e e dai que a pessoa volta pra conferir um dia atrasado.
      if (porDia) {
        const iniY = inicio.toLocaleDateString('sv-SE')
        const fimY = addDia(fim.toLocaleDateString('sv-SE'), -1)
        const { data: fechs } = await supabase.from('caixa_dia').select('*')
          .gte('data', iniY).lte('data', fimY)
        if (!vivo) return
        const porData = Object.fromEntries((fechs ?? []).map(d => [d.data, d]))
        // Um resumo por dia. Sao no maximo 7 chamadas e so quando a pessoa
        // troca de semana — nao vale a complexidade de uma funcao em lote.
        const dias = []
        for (let d = iniY; d <= fimY && d <= ymdLocal(); d = addDia(d, 1)) {
          const { data: r } = await supabase.rpc('caixa_resumo_do_dia', { p_data: d })
          if (!vivo) return
          dias.push({ data: d, resumo: Array.isArray(r) ? (r[0] ?? null) : r, fech: porData[d] ?? null })
        }
        setDiasSemana(dias.reverse())
        setCarregandoHist(false)
        return
      }

      const { data, error: err } = await supabase
        .from('caixas').select('*')
        .gte('aberto_em', inicio.toISOString())
        .lt('aberto_em', fim.toISOString())
        .order('aberto_em', { ascending: false })
      if (!vivo) return
      if (err) setError(err.message)
      const caixasDaSemana = data ?? []
      setHistorico(caixasDaSemana)
      setHistAberto(null)          // a linha aberta era de outra semana

      // Os resumos de TODOS os caixas da semana numa consulta só. A tabela
      // mostra caixa por caixa; quem quer saber quanto entrou na semana tinha
      // que abrir os cinco e somar de cabeça.
      setResumosSemana(null)
      const ids = caixasDaSemana.map(c => c.id)
      if (ids.length) {
        const { data: rs } = await supabase.from('caixa_resumo').select('*').in('caixa_id', ids)
        if (!vivo) return
        setResumosSemana(rs ?? [])
      } else {
        setResumosSemana([])
      }
      setCarregandoHist(false)
    }
    carregarHistorico()
    return () => { vivo = false }
  }, [user?.id, semanaOffset, histVersao, porDia, diaVersao])

  function nomeUsuario(id) {
    const u = usuarios.find((x) => x.id === id)
    return u?.nome || u?.email || '-'
  }

  function openAbertura() {
    // Com a regra ligada os campos já vêm preenchidos com o fechamento anterior
    // (e nem aparecem pra digitar).
    setValorAbertura(aberturaTravada ? String(ultimoFech.valor_dinheiro ?? 0) : '')
    setValorAberturaPix(aberturaTravada ? String(ultimoFech.valor_pix ?? 0) : '')
    setValorAberturaCartao(aberturaTravada ? String(ultimoFech.valor_cartao ?? 0) : '')
    setValorAberturaCartao(aberturaTravada ? String(ultimoFech.valor_cartao ?? 0) : '')
    setObsAbertura('')
    setFormError(null)
    setShowAbertura(true)
  }

  async function handleAbrir(e) {
    e.preventDefault()
    setFormError(null)

    const valor = Number(valorAbertura)
    if (!(valor >= 0)) {
      setFormError('Informe um valor de abertura válido.')
      return
    }

    const valorPix = valorAberturaPix === '' ? 0 : Number(valorAberturaPix)
    if (!(valorPix >= 0)) {
      setFormError('Informe um valor de abertura em PIX válido.')
      return
    }

    setSaving(true)
    const { error: rpcError } = await supabase.rpc('abrir_caixa', {
      p_valor_abertura: valor,
      p_observacoes: obsAbertura || null,
      p_valor_abertura_pix: valorPix,
      p_valor_abertura_cartao: valorAberturaCartao === '' ? 0 : Number(valorAberturaCartao),
    })
    setSaving(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    setShowAbertura(false)
    loadAll()
  }

  function openMovimento(tipo) {
    setValorMovimento('')
    setObsMovimento('')
    setFormaMovimento('dinheiro')
    setFormError(null)
    setShowMovimento(tipo)
  }

  async function handleMovimento(e) {
    e.preventDefault()
    setFormError(null)

    const valor = Number(valorMovimento)
    if (!(valor > 0)) {
      setFormError('Informe um valor válido.')
      return
    }

    setSaving(true)
    // No modo-dia nao existe um caixa aberto pra amarrar: o movimento se
    // amarra na loja e na data (ver `registrar_movimento_dia`, mig 0336).
    const { error: rpcError } = porDia
      ? await supabase.rpc('registrar_movimento_dia', {
          p_tipo: showMovimento,
          p_valor: valor,
          p_observacao: obsMovimento || null,
          p_forma: formaMovimento,
        })
      : await supabase.rpc('registrar_movimento_caixa', {
          p_caixa_id: caixaAtual.id,
          p_tipo: showMovimento,
          p_valor: valor,
          p_observacao: obsMovimento || null,
          p_forma: formaMovimento,
        })
    setSaving(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    setShowMovimento(null)
    if (porDia) setDiaVersao(v => v + 1); else loadAll()
  }

  // Quanto cada bandeira de vale recebeu neste caixa (ou neste dia): salão/balcão
  // vêm de `pagamentos`; delivery vem da view, que sabe a forma de CADA parte
  // (num pagamento dividido ela está dentro da parte, não no pedido).
  async function carregarValesPorBandeira() {
    const marcas = FORMAS_VALE.map(v => v.value)
    const soma = Object.fromEntries(marcas.map(m => [m, 0]))
    const idCaixa = caixaAtual?.id
    if (!porDia && !idCaixa) return soma
    const [iniDia, fimDia] = limitesDoDia(dia)
    const pg = supabase.from('pagamentos').select('valor, forma_pagamento').in('forma_pagamento', marcas)
    const dl = supabase.from('caixa_delivery_partes').select('valor, forma').eq('bucket', 'vale')
    const [a, b] = await Promise.all([
      porDia ? pg.gte('created_at', iniDia).lt('created_at', fimDia) : pg.eq('caixa_id', idCaixa),
      porDia ? dl.eq('dia', dia) : dl.eq('caixa_id', idCaixa),
    ])
    for (const p of (a.data ?? [])) if (soma[p.forma_pagamento] != null) soma[p.forma_pagamento] += Number(p.valor || 0)
    for (const d of (b.data ?? [])) if (soma[d.forma] != null) soma[d.forma] += Number(d.valor || 0)
    for (const m of marcas) soma[m] = Math.round(soma[m] * 100) / 100
    return soma
  }

  // O que fica gravado: por bandeira, o contado e o esperado congelado. Bandeira
  // sem movimento e sem nada digitado nem entra.
  function montarValesConferidos() {
    const o = {}
    for (const v of FORMAS_VALE) {
      const esp = Number(valesEsperados[v.value] || 0)
      const raw = valesContados[v.value]
      const tem = raw !== '' && raw != null
      if (!tem && esp === 0) continue
      o[v.value] = { contado: tem ? Number(raw) : null, esperado: esp }
    }
    return Object.keys(o).length ? o : null
  }

  // Abre o fechamento com os três campos JÁ PREENCHIDOS com o esperado. Na
  // maioria dos dias bate, e o vendedor só confirma em vez de digitar três
  // valores no fim do expediente. Quando não bate, ele apaga e põe o certo — os
  // campos abrem selecionados (onFocus), então é um toque e digitar por cima.
  function openFechamento() {
    // Sem o resumo carregado o esperado é zero — melhor abrir vazio do que
    // sugerir R$ 0,00 e alguém confirmar sem olhar.
    // Caixa cego: tudo vazio. Preencher com o esperado entregaria o número que o
    // vendedor não pode ver — ele tem que CONTAR.
    setValorFechamento(resumo && !cego ? valorEsperadoDinheiro.toFixed(2) : '')
    setValorFechamentoPix(resumo && !cego ? valorEsperadoPix.toFixed(2) : '')
    setValorFechamentoCartao(resumo && !cego ? valorEsperadoCartao.toFixed(2) : '')
    setObsFechamento('')
    setFormError(null)
    setNaoBateu(null)
    setValesEsperados({}); setValesContados({})
    setShowFechamento(true)
    if (cego) return
    carregarValesPorBandeira().then(v => {
      setValesEsperados(v)
      setValesContados(Object.fromEntries(Object.entries(v).map(([k, n]) => [k, n > 0 ? n.toFixed(2) : ''])))
    }).catch(() => { /* sem a conferência dos vales o resto do fechamento segue valendo */ })
  }

  // Tira o retrato congelado e o dia volta a ser calculado ao vivo. Venda
  // nenhuma e tocada: o fechamento do dia so guarda o que foi CONTADO.
  async function reabrirDia() {
    if (!diaRow?.id) return
    if (!confirm(`Reabrir o dia ${ddmmDeYMD(dia)}?

O que foi contado nesse dia é apagado e os valores voltam a ser calculados ao vivo. Nenhuma venda é alterada.`)) return
    setSaving(true)
    const { error: err } = await supabase.from('caixa_dia').update({
      contado_dinheiro: null, contado_pix: null, contado_cartao: null,
      esperado_dinheiro: null, esperado_pix: null, esperado_cartao: null, conferido_vales: null,
      fechado_em: null, fechado_por: null,
    }).eq('id', diaRow.id)
    setSaving(false)
    if (err) { setError(err.message); return }
    setDiaVersao(v => v + 1)
  }

  async function handleFechar(e) {
    e.preventDefault()
    setFormError(null)

    const valor = Number(valorFechamento)
    if (!(valor >= 0)) {
      setFormError('Informe um valor de fechamento válido.')
      return
    }

    // ── FECHAR O DIA ──
    // Grava o que foi CONTADO e congela o que o sistema esperava AGORA. O
    // esperado precisa ficar congelado: sem isso, um pedido cancelado semana
    // que vem mudaria a diferenca de um dia que ja foi conferido e assinado.
    if (porDia) {
      setSaving(true)
      const { error: errDia } = await supabase.from('caixa_dia').upsert({
        empresa_id: profile.empresa_id,
        data: dia,
        abertura_dinheiro: Number(caixaAtual?.valor_abertura || 0),
        abertura_pix: Number(caixaAtual?.valor_abertura_pix || 0),
        abertura_cartao: Number(caixaAtual?.valor_abertura_cartao || 0),
        contado_dinheiro: valor,
        contado_pix: valorFechamentoPix === '' ? null : Number(valorFechamentoPix),
        contado_cartao: valorFechamentoCartao === '' ? null : Number(valorFechamentoCartao),
        esperado_dinheiro: valorEsperadoDinheiro,
        esperado_pix: valorEsperadoPix,
        esperado_cartao: valorEsperadoCartao,
        conferido_vales: montarValesConferidos(),
        observacoes: obsFechamento || null,
        fechado_em: new Date().toISOString(),
        fechado_por: user?.id ?? null,
      }, { onConflict: 'empresa_id,data' })
      setSaving(false)
      if (errDia) { setFormError(errDia.message); return }
      setShowFechamento(false)
      setDiaVersao(v => v + 1)
      return
    }

    setSaving(true)
    const { error: rpcError } = await supabase.rpc('fechar_caixa', {
      p_caixa_id: caixaAtual.id,
      p_valor_fechamento: valor,
      p_observacoes: obsFechamento || null,
      p_valor_fechamento_pix: valorFechamentoPix === '' ? null : Number(valorFechamentoPix),
      p_valor_fechamento_cartao: valorFechamentoCartao === '' ? null : Number(valorFechamentoCartao),
      p_conferido_vales: montarValesConferidos(),
    })
    setSaving(false)

    if (rpcError) {
      // O banco recusou porque o contado não bateu (só acontece pro vendedor em
      // loja de caixa cego). Ele diz QUAIS formas, nunca quanto.
      if (rpcError.message?.startsWith('CAIXA_NAO_BATEU')) {
        setNaoBateu(rpcError.message.split(':')[1]?.split(',').filter(Boolean) ?? [])
        // Avisa o dono no WhatsApp (forma, contado, esperado e diferença) e abre o
        // pedido de liberação na tela dele. Se falhar, o vendedor ainda vê o aviso.
        const { error: avisoErr } = await supabase.rpc('registrar_nao_bateu', {
          p_caixa_id: caixaAtual.id,
          p_dinheiro: valor,
          p_pix: valorFechamentoPix === '' ? 0 : Number(valorFechamentoPix),
          p_cartao: valorFechamentoCartao === '' ? 0 : Number(valorFechamentoCartao),
        })
        if (!avisoErr) setCaixaAtual(c => ({ ...c, liberacao_pedida_em: c.liberacao_pedida_em ?? new Date().toISOString() }))
        return
      }
      setFormError(rpcError.message)
      return
    }

    setShowFechamento(false)
    loadAll()
  }

  // O vendedor digita o código que o dono mandou. Libera e fecha na mesma ação:
  // pra ele é um passo só, que é o ponto de existir o código.
  async function fecharComCodigo() {
    if (!caixaAtual?.id) return
    const cod = codigoLib.replace(/\D/g, '')
    if (cod.length !== 4) { setCodigoErro('Digite os 4 números.'); return }
    setCodigoErro('')
    setLiberando(true)

    const { error: errLib } = await supabase.rpc('liberar_fechamento_por_codigo', {
      p_caixa_id: caixaAtual.id,
      p_codigo: cod,
    })
    if (errLib) {
      setLiberando(false)
      // O banco não diz quantas tentativas sobraram, de propósito.
      setCodigoErro(
        errLib.message?.includes('CODIGO_EXPIRADO')
          ? 'Esse código venceu. Tente fechar de novo que o dono recebe um novo.'
          : 'Código errado. Confira com o dono.',
      )
      return
    }

    const { error: errFechar } = await supabase.rpc('fechar_caixa', {
      p_caixa_id: caixaAtual.id,
      p_valor_fechamento: Number(valorFechamento),
      p_observacoes: obsFechamento || null,
      p_valor_fechamento_pix: valorFechamentoPix === '' ? null : Number(valorFechamentoPix),
      p_valor_fechamento_cartao: valorFechamentoCartao === '' ? null : Number(valorFechamentoCartao),
      p_conferido_vales: montarValesConferidos(),
    })
    setLiberando(false)
    if (errFechar) { setCodigoErro(errFechar.message); return }

    // Nada de valor pro vendedor: ele continua sem saber quanto faltou ou
    // sobrou. A diferença sai na mensagem de fechamento, que vai pro dono.
    setCodigoLib('')
    setNaoBateu(null)
    setShowFechamento(false)
    setFechouOk(true)
    setTimeout(() => setFechouOk(false), 4000)
    loadAll()
  }

  async function liberarFechamento() {
    if (!caixaAtual?.id) return
    setLiberando(true)
    const { error: rpcError } = await supabase.rpc('liberar_fechamento_caixa', { p_caixa_id: caixaAtual.id })
    setLiberando(false)
    if (rpcError) { setError(rpcError.message); return }
    setCaixaAtual(c => ({ ...c, liberado_em: new Date().toISOString() }))
  }

  // Quem pediu espera o dono, e o dono espera o pedido: sem tempo real aqui,
  // olha o caixa de tempos em tempos (é uma linha só, só em loja de caixa cego).
  useEffect(() => {
    const id = caixaAtual?.id
    if (!caixaCego || !id || caixaAtual.liberado_em) return
    if (!(isAdmin || caixaAtual.liberacao_pedida_em)) return
    const t = setInterval(async () => {
      const { data } = await supabase.from('caixas')
        .select('liberacao_pedida_em, liberacao_pedida_por, liberado_em').eq('id', id).maybeSingle()
      if (data) setCaixaAtual(c => (c && c.id === id ? { ...c, ...data } : c))
    }, 15000)
    return () => clearInterval(t)
  }, [caixaCego, caixaAtual?.id, caixaAtual?.liberado_em, caixaAtual?.liberacao_pedida_em, isAdmin])

  // Só o que é EM DINHEIRO mexe no caixa físico. Sangria/suprimento por PIX não entra
  // aqui (fica registrado, mas não altera o dinheiro esperado na gaveta).
  const valorEsperadoDinheiro = resumo
    ? Number(caixaAtual.valor_abertura) +
      dinheiroDe(resumo) +
      Number(resumo.total_suprimentos_dinheiro ?? resumo.total_suprimentos) -
      Number(resumo.total_sangrias_dinheiro ?? resumo.total_sangrias)
    : 0

  const diferencaFechamento =
    showFechamento && !cego && valorFechamento !== ''
      ? Number(valorFechamento) - valorEsperadoDinheiro
      : null

  // PIX é igual dinheiro: esperado em PIX = saldo que já estava na conta na abertura
  // + recebido em PIX + suprimentos − sangrias (por PIX).
  const valorEsperadoPix = resumo
    ? Number(caixaAtual.valor_abertura_pix || 0) +
      pixDe(resumo) +
      Number(resumo.total_suprimentos_pix || 0) -
      Number(resumo.total_sangrias_pix || 0)
    : 0
  const diferencaFechamentoPix =
    showFechamento && !cego && valorFechamentoPix !== ''
      ? Number(valorFechamentoPix) - valorEsperadoPix
      : null

  // Cartão agora funciona igual PIX (mig 0173): o dinheiro cai na hora na conta
  // da maquineta, fica lá de um dia pro outro e a loja tira dali pra pagar
  // compra. Então tem saldo de abertura, desconta sangria e tem esperado.
  // Não entra no esperado da GAVETA — cartão nenhum fica em dinheiro vivo.
  //
  // O esperado vai LÍQUIDO (já com a taxa da maquineta descontada): a conta
  // recebe o valor da venda menos a taxa, e é o saldo da conta que a loja
  // confere no fechamento. Com o bruto, faltava a taxa todo dia — e como o
  // saldo passa de um dia pro outro e a sangria em cartão sai do dinheiro de
  // verdade, a diferença ia se acumulando.
  const totalCartaoSistema = resumo ? cartaoDe(resumo) : 0
  const valorEsperadoCartao = resumo
    ? Number(caixaAtual.valor_abertura_cartao || 0) +
      cartaoLiquidoDe(resumo) +
      Number(resumo.total_suprimentos_cartao || 0) -
      Number(resumo.total_sangrias_cartao || 0)
    : 0
  const diferencaFechamentoCartao =
    showFechamento && !cego && valorFechamentoCartao !== ''
      ? Number(valorFechamentoCartao) - valorEsperadoCartao
      : null

  // O que sobra de TODO o cartão depois das taxas (cada forma com a taxa dela).
  const totalCartaoLiquido = resumo ? cartaoLiquidoDe(resumo) : 0

  // Faturamento total do caixa: soma de TODAS as formas (dinheiro + pix + cartão + transferência + fiado).
  const faturamentoDe = (r) => (r
    ? dinheiroDe(r) +
      pixDe(r) +
      cartaoDe(r) +
      valeDe(r) +
      Number(r.recebimentos_transferencia || 0) +
      // iFood pago no app + PIX pago no Mercado Pago: a loja vendeu, mas o
      // dinheiro esta la fora. Entra no faturamento e em nenhum esperado.
      foraDaLojaDe(r) +
      Number(r.delivery_outros || 0) +
      // Crédito da loja (mig 0179): a venda foi CHEIA, então ele faz parte do
      // faturamento. Não entra em nenhum "esperado" porque não é dinheiro que
      // caiu em lugar nenhum — o custo dele aparece no Despesas & Lucro.
      Number(r.recebimentos_cashback || 0) +
      Number(r.vendas_fiado || 0)
    : 0)

  const faturamentoTotal = faturamentoDe(resumo)

  // ── Total da semana ────────────────────────────────────────────────────────
  // A mesma conta do faturamento de um caixa, somando os caixas todos da semana
  // que está na tela. É a pergunta da segunda de manhã ("quanto entrou na
  // semana, e em quê?") que a tabela não respondia: ela mostra abertura e
  // fechamento, que é quanto tinha na gaveta — não quanto a loja vendeu.
  const totaisSemana = (() => {
    // No modo-dia a semana e a lista de dias, nao a de caixas. Lendo a fonte
    // errada o rodape dizia R$ 58,19 enquanto a tabela logo acima somava
    // R$ 627,09 — dois numeros da mesma semana na mesma tela.
    const rs = porDia
      ? (diasSemana ?? []).map(d => d.resumo).filter(Boolean)
      : (resumosSemana ?? [])
    const soma = (campo) => rs.reduce((t, r) => t + Number(r?.[campo] || 0), 0)
    // `somaCom` passa pelos helpers que juntam salao + delivery, pra semana dar
    // exatamente a soma dos caixas que estao logo abaixo na tabela.
    const somaCom = (fn) => rs.reduce((t, r) => t + fn(r), 0)
    const dinheiro = somaCom(dinheiroDe)
    const pix = somaCom(pixDe)
    const cartao = somaCom(cartaoDe)
    const vale = somaCom(valeDe)
    const transferencia = soma('recebimentos_transferencia')
    const fiado = soma('vendas_fiado')
    const cashback = soma('recebimentos_cashback')
    const ifood = soma('delivery_ifood')
    const online = soma('delivery_online')
    const outros = soma('delivery_outros')
    return {
      dinheiro, pix, cartao, vale, transferencia, fiado, cashback, ifood, online, outros,
      credito: somaCom(creditoDe),
      debito: somaCom(debitoDe),
      fiadoRecebido: soma('recebimentos_fiado'),
      sangrias: soma('total_sangrias'),
      suprimentos: soma('total_suprimentos'),
      cartaoLiquido: rs.reduce((t, r) => t + cartaoLiquidoDe(r), 0),
      total: dinheiro + pix + cartao + vale + transferencia + cashback + fiado + ifood + online + outros,
    }
  })()

  return (
    <div>
      <div className="page-header">
        <h1>Caixa</h1>
        {!loading && !caixaAtual && (
          <button className="btn btn-primary" onClick={openAbertura}>
            + Abrir caixa
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <div className="empty-state">Carregando...</div>
      ) : !caixaAtual ? (
        <div className="card empty-state">A loja não tem nenhum caixa aberto no momento.</div>
      ) : (
        <>
          {/* Sobrou caixa aberto do jeito antigo (um por login): as vendas vão
              todas pro mais novo, e o atrasado fica preso com o movimento do dia
              em que foi aberto. Avisa pra fechar. */}
          {caixasAbertos.length > 1 && (
            <div className="card" style={{ marginBottom: 12, border: '1.5px solid #f59e0b', background: 'rgba(245,158,11,.10)' }}>
              <div style={{ fontWeight: 800, color: '#d97706', marginBottom: 4 }}>
                ⚠️ {caixasAbertos.length} caixas abertos ao mesmo tempo
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                As vendas entram no mais novo. Os outros ficaram abertos de antes e seguram o movimento
                do dia em que foram abertos — feche-os pelo histórico abaixo:
                {' '}
                {caixasAbertos.slice(1).map(c => (
                  <b key={c.id}>{new Date(c.aberto_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{' '}</b>
                ))}
              </div>
            </div>
          )}
          {/* MODO DIA: as setas andam de dia em dia e nunca passam de hoje —
              conferir um dia que ainda nao aconteceu nao quer dizer nada. */}
          {porDia && (
            <div className="card" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setDia(addDia(dia, -1))} title="Dia anterior"
                className="btn btn-secondary" style={{ padding: '6px 12px' }}>◀</button>
              <input type="date" value={dia} max={ymdLocal()}
                onChange={e => { if (e.target.value && e.target.value <= ymdLocal()) setDia(e.target.value) }}
                style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)', fontWeight: 700 }} />
              <button type="button" onClick={() => setDia(addDia(dia, 1))} disabled={dia >= ymdLocal()}
                title="Próximo dia" className="btn btn-secondary"
                style={{ padding: '6px 12px', opacity: dia >= ymdLocal() ? .4 : 1 }}>▶</button>
              {dia !== ymdLocal() && (
                <button type="button" className="btn btn-secondary" style={{ padding: '6px 12px' }}
                  onClick={() => setDia(ymdLocal())}>Hoje</button>
              )}
              {dia !== addDia(ymdLocal(), -1) && (
                <button type="button" className="btn btn-secondary" style={{ padding: '6px 12px' }}
                  onClick={() => setDia(addDia(ymdLocal(), -1))}>Ontem</button>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 12.5, fontWeight: 700,
                color: diaRow?.fechado_em ? 'var(--success, #16a34a)' : 'var(--text-muted)' }}>
                {diaRow?.fechado_em
                  ? '✓ Dia ' + ddmmDeYMD(dia) + ' já conferido'
                  : 'Dia ' + ddmmDeYMD(dia) + ' em aberto'}
              </span>
            </div>
          )}

          <div className="card caixa-info-card" style={{ marginBottom: 20 }}>
            <div>
              <div className="label">{porDia ? 'Dia' : 'Caixa aberto em'}</div>
              <div className="value-sm">
                {porDia
                  ? new Date(dia + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })
                  : new Date(caixaAtual.aberto_em).toLocaleString('pt-BR')}
              </div>
            </div>
            {!cego && (
              <>
                <div>
                  <div className="label">💵 Dinheiro inicial</div>
                  <div className="value-sm">R$ {Number(caixaAtual.valor_abertura).toFixed(2)}</div>
                </div>
                <div>
                  <div className="label">📱 PIX inicial</div>
                  <div className="value-sm">R$ {Number(caixaAtual.valor_abertura_pix || 0).toFixed(2)}</div>
                </div>
              </>
            )}
            {caixaAtual.observacoes_abertura && (
              <div>
                <div className="label">Observações</div>
                <div className="value-sm">{caixaAtual.observacoes_abertura}</div>
              </div>
            )}
          </div>

          {/* DONO: o vendedor não conseguiu fechar porque o caixa não bateu e pediu
              liberação. Liberar deixa ele fechar mesmo assim; a diferença fica
              guardada no caixa. */}
          {caixaCego && isAdmin && caixaAtual?.id && caixaAtual.liberacao_pedida_em && !caixaAtual.liberado_em && (
            <div className="card" style={{ marginBottom: 12, border: '1.5px solid #f59e0b', background: 'rgba(245,158,11,.10)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontWeight: 800, color: '#d97706', marginBottom: 2 }}>
                  🔔 {nomeUsuario(caixaAtual.liberacao_pedida_por)} pediu liberação pra fechar o caixa
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  O que ele contou não bateu com o sistema. Confira os valores abaixo; se estiver tudo certo,
                  libere e ele fecha. Você também pode fechar o caixa direto, pelo seu login.
                </div>
              </div>
              <button type="button" className="btn btn-primary" disabled={liberando} onClick={liberarFechamento}>
                {liberando ? 'Liberando...' : 'Liberar fechamento'}
              </button>
            </div>
          )}
          {caixaCego && isAdmin && caixaAtual?.liberado_em && (
            <div style={{ marginBottom: 12, fontSize: 12.5, color: 'var(--text-muted)' }}>
              ✅ Fechamento liberado — o vendedor já pode fechar este caixa.
            </div>
          )}
          {/* VENDEDOR: em que pé está o pedido. */}
          {cego && caixaAtual?.id && caixaAtual.liberacao_pedida_em && (
            <div className="card" style={{ marginBottom: 12, border: `1.5px solid ${caixaAtual.liberado_em ? '#16a34a' : '#f59e0b'}`,
              background: caixaAtual.liberado_em ? 'rgba(22,163,74,.08)' : 'rgba(245,158,11,.10)' }}>
              <div style={{ fontWeight: 800 }}>
                {caixaAtual.liberado_em
                  ? '✅ O dono liberou. Pode fechar o caixa.'
                  : '⏳ Aguardando o dono liberar o fechamento…'}
              </div>
            </div>
          )}

          <div className="caixa-actions" style={{ marginBottom: 20 }}>
            <button className="btn btn-secondary" onClick={() => openMovimento('sangria')}>
              - Registrar sangria
            </button>
            <button className="btn btn-secondary" onClick={() => openMovimento('suprimento')}>
              + Registrar suprimento
            </button>
            {porDia && diaRow?.fechado_em ? (
              /* Dia ja conferido: reabrir e voltar a calcular ao vivo. Nao
                 apaga venda nenhuma — so tira o retrato congelado. */
              <button className="btn btn-secondary" disabled={saving} onClick={reabrirDia}>
                Reabrir o dia {ddmmDeYMD(dia)}
              </button>
            ) : (
              <button className="btn btn-danger" onClick={openFechamento}>
                {porDia ? 'Fechar o dia ' + ddmmDeYMD(dia) : 'Fechar caixa'}
              </button>
            )}
          </div>

          {resumo && !cego && (
            <>
            {/* Faturamento total — soma de TODAS as formas, em destaque (cor diferente). */}
            <div className="card" style={{ marginBottom: 14, border: '2px solid var(--primary)', background: 'var(--primary-bg, rgba(124,58,237,.08))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1 }}>💰 Faturamento total (todas as formas)</div>
              <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--primary)' }}>R$ {faturamentoTotal.toFixed(2)}</div>
            </div>
            <div className="dashboard-grid" style={{ marginBottom: 24 }}>
              {/* Fora daqui de propósito (a view caixa_resumo continua calculando tudo):
                  "Vendas à vista" repetia "Recebimentos em dinheiro" pro lojista, e
                  boleto/transferência não existem na operação — é tudo PIX. */}
              <div className="card dashboard-card" {...cardClicavel({ titulo: 'Vendas no fiado', tipo: 'fiado' })}>
                <div className="label">Vendas fiado</div>
                <div className="value">R$ {Number(resumo.vendas_fiado).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card" {...cardClicavel({ titulo: 'Recebimentos em dinheiro', formas: ['dinheiro'], baldes: ['dinheiro'] })}>
                <div className="label">Recebimentos em dinheiro</div>
                <div className="value">R$ {dinheiroDe(resumo).toFixed(2)}</div>
                {linhaOrigem(resumo.recebimentos_dinheiro, resumo.delivery_dinheiro)}
              </div>
              <div className="card dashboard-card" {...cardClicavel({ titulo: 'Recebimentos em PIX', formas: ['pix'], baldes: ['pix'] })}>
                <div className="label">Recebimentos Pix</div>
                <div className="value">R$ {pixDe(resumo).toFixed(2)}</div>
                {linhaOrigem(resumo.recebimentos_pix, resumo.delivery_pix)}
              </div>

              {/* ── O QUE A LOJA VENDEU MAS NÃO RECEBEU NA MÃO ──
                  Pedido pago dentro do app do iFood e PIX pago no nosso
                  checkout (cai no Mercado Pago). É venda, está no faturamento,
                  e de propósito NÃO está em nenhum "esperado": esse dinheiro
                  cai na conta do iFood / do MP e chega depois, no repasse.
                  Se entrasse na gaveta, o caixa ia fechar faltando todo dia. */}
              {Number(resumo.delivery_ifood || 0) > 0 && (
                <div className="card dashboard-card" {...cardClicavel({ titulo: 'iFood — pago no app', baldes: ['ifood'] }, { borderLeft: '3px solid #ea1d2c' })}>
                  <div className="label">🛵 iFood (pago no app)</div>
                  <div className="value">R$ {Number(resumo.delivery_ifood).toFixed(2)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                    O cliente pagou no iFood. <strong>Não entra na gaveta</strong> —
                    vem no repasse. O iFood cobrado na entrega está no dinheiro/cartão acima.
                  </div>
                </div>
              )}
              {Number(resumo.delivery_online || 0) > 0 && (
                <div className="card dashboard-card" {...cardClicavel({ titulo: 'Pago online (Mercado Pago)', baldes: ['online'] }, { borderLeft: '3px solid #2563eb' })}>
                  <div className="label">🌐 Pago online (Mercado Pago)</div>
                  <div className="value">R$ {Number(resumo.delivery_online).toFixed(2)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                    PIX do cardápio, já confirmado. Caiu na conta do Mercado Pago,
                    então <strong>não entra na gaveta nem no PIX da loja</strong>.
                  </div>
                </div>
              )}
              {/* Forma que o sistema não soube classificar. Aparece em vez de
                  virar dinheiro no esperado — melhor o dono ver R$ 0,00 de
                  diferença e uma linha estranha do que caçar uma falta. */}
              {Number(resumo.delivery_outros || 0) > 0 && (
                <div className="card dashboard-card" {...cardClicavel({ titulo: 'Forma não reconhecida', baldes: ['outros'] }, { borderLeft: '3px solid #d97706' })}>
                  <div className="label">⚠️ Forma não reconhecida</div>
                  <div className="value">R$ {Number(resumo.delivery_outros).toFixed(2)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                    Venda de delivery numa forma que o caixa não sabe onde pôr.
                    Está no faturamento e fora dos esperados. Avise o suporte.
                  </div>
                </div>
              )}

              {/* Cashback (mig 0179): a venda entrou cheia, mas este pedaço NÃO
                  é dinheiro em lugar nenhum — é desconto que a loja deu. Fica
                  fora de todo "esperado" e some quando é zero, pra não poluir a
                  tela de quem não usa o programa. */}
              {Number(resumo.recebimentos_cashback || 0) > 0 && (
                <div className="card dashboard-card" {...cardClicavel({ titulo: 'Cashback usado', formas: ['cashback'] }, { borderLeft: '3px solid #16a34a' })}>
                  <div className="label">🎟️ Cashback usado</div>
                  <div className="value">R$ {Number(resumo.recebimentos_cashback).toFixed(2)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                    Crédito que os clientes gastaram. Está no faturamento, mas
                    <strong> não entra em nenhum esperado</strong> — vira despesa
                    no Despesas &amp; Lucro.
                  </div>
                </div>
              )}
              {/* Vales (mig 0388): Pluxee, Alelo, VR e Ticket. Linha própria — não é
                  dinheiro de gaveta nem entra no cartão (a taxa deles é outra). Some
                  quando é zero, pra não poluir a tela de quem não aceita. */}
              {valeDe(resumo) > 0 && (
                <div className="card dashboard-card" {...cardClicavel({ titulo: 'Vales (Pluxee, Alelo, VR, Ticket)', formas: ['pluxee', 'alelo', 'vr', 'ticket'], baldes: ['vale'] }, { borderLeft: '3px solid #0f766e' })}>
                  <div className="label">🍽️ Vales (Pluxee, Alelo, VR, Ticket)</div>
                  <div className="value">R$ {valeDe(resumo).toFixed(2)}</div>
                  {linhaOrigem(resumo.recebimentos_vale, resumo.delivery_vale)}
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                    Já está no faturamento. Cai na conta da operadora do vale, não na gaveta.
                  </div>
                </div>
              )}
              {/* Cartão aberto por forma: crédito e débito têm taxa diferente,
                  então cada um mostra o que sobra depois da maquineta.
                  Crédito e débito aparecem SEMPRE, zerados inclusive — igual a
                  dinheiro e PIX. Antes eles só surgiam depois da primeira venda
                  na forma, e numa loja nova parecia que o sistema não tinha
                  cartão. O "cartão" genérico segue escondido no zero: é forma
                  antiga, quem usa crédito/débito nunca vai ver essa linha. */}
              {[
                ['Recebimentos crédito', creditoDe(resumo), taxas.credito, true, 'credito'],
                ['Recebimentos débito', debitoDe(resumo), taxas.debito, true, 'debito'],
                ['Recebimentos cartão', cartaoGenDe(resumo), taxas.cartao, false, 'cartao'],
              ].filter(([, bruto, , sempre]) => sempre || Number(bruto || 0) > 0).map(([titulo, bruto, pct, , forma]) => (
                <div className="card dashboard-card" key={titulo}
                  {...cardClicavel({ titulo, formas: [forma], baldes: [forma] })}>
                  <div className="label">{titulo}</div>
                  <div className="value">R$ {Number(bruto).toFixed(2)}</div>
                  {pct > 0 ? (
                    <div style={{ marginTop: 6, lineHeight: 1.5 }}>
                      <div style={{ fontSize: 12, color: '#d97706' }}>
                        − maquineta {String(pct).replace('.', ',')}% = R$ {(Number(bruto) * pct / 100).toFixed(2)}
                      </div>
                      <div style={{ fontSize: 14.5, fontWeight: 800 }}>
                        Cai na conta: R$ {liquido(bruto, pct).toFixed(2)}
                      </div>
                    </div>
                  ) : isAdmin ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                      Ponha a taxa da maquineta em <strong>Minha Loja → Pagamento</strong> pra ver quanto cai na conta.
                    </div>
                  ) : null}
                </div>
              ))}

              {/* Quando as três formas de cartão aparecem juntas, o total ajuda a
                  conferir com o extrato da maquineta de uma vez. */}
              {cartaoDe(resumo) > 0 && totalCartaoLiquido !== cartaoDe(resumo) && (
                <div className="card dashboard-card"
                  {...cardClicavel({ titulo: 'Total no cartão', formas: ['credito', 'debito', 'cartao'], baldes: ['credito', 'debito', 'cartao'] }, { borderLeft: '3px solid var(--primary)' })}>
                  <div className="label">💳 Total no cartão</div>
                  <div className="value">R$ {cartaoDe(resumo).toFixed(2)}</div>
                  {linhaOrigem(resumo.recebimentos_cartao, resumo.delivery_cartao)}
                  <div style={{ fontSize: 14.5, fontWeight: 800, marginTop: 6 }}>
                    Cai na conta: R$ {totalCartaoLiquido.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>crédito + débito + cartão, já com as taxas</div>
                </div>
              )}
              {/* Quanto do que entrou é freguês pagando o que já devia. Esse dinheiro
                  está DENTRO dos recebimentos acima, mas NÃO é venda de hoje — a venda
                  dele foi contada no dia em que o cliente comeu. Sem essa linha, o dono
                  compara "entrou" com "vendi", não bate, e não sabe por quê. */}
              {Number(resumo.recebimentos_fiado) > 0 && (
                <div className="card dashboard-card"
                  {...cardClicavel({ titulo: 'Fiado antigo recebido', formas: ['dinheiro', 'pix', 'cartao', 'credito', 'debito', 'transferencia'], soFiadoAntigo: true }, { borderLeft: '3px solid #d97706' })}>
                  <div className="label">Fiado antigo recebido</div>
                  <div className="value" style={{ color: '#d97706' }}>R$ {Number(resumo.recebimentos_fiado).toFixed(2)}</div>
                  {/* Em que forma foi pago: o que veio em dinheiro está na gaveta,
                      o resto não. Sem isso a conferência da gaveta não fecha. */}
                  <div style={{ fontSize: 12, color: 'var(--text)', marginTop: 3, lineHeight: 1.45 }}>
                    {[
                      ['💵 dinheiro', resumo.recebimentos_fiado_dinheiro],
                      ['📱 pix', resumo.recebimentos_fiado_pix],
                      ['💳 cartão', resumo.recebimentos_fiado_cartao],
                      ['🔁 transf.', resumo.recebimentos_fiado_transferencia],
                    ].filter(([, v]) => Number(v) > 0)
                      .map(([lb, v]) => `${lb} R$ ${Number(v).toFixed(2)}`)
                      .join(' · ')}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.35 }}>
                    já está somado nos recebimentos acima · não é venda de hoje
                  </div>
                </div>
              )}
              <div className="card dashboard-card">
                <div className="label">Sangrias</div>
                <div className="value">R$ {Number(resumo.total_sangrias).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Suprimentos</div>
                <div className="value">R$ {Number(resumo.total_suprimentos).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Esperado em dinheiro</div>
                <div className="value">R$ {valorEsperadoDinheiro.toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Esperado em PIX</div>
                <div className="value">R$ {valorEsperadoPix.toFixed(2)}</div>
              </div>
            </div>
            </>
          )}

          <h2 className="caixa-table-title">Sangrias e suprimentos</h2>
          <div className="data-table" style={{ marginBottom: 24 }}>
            {movimentos.length === 0 ? (
              <div className="empty-state">Nenhum movimento registrado.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Tipo</th>
                    <th>Forma</th>
                    <th className="caixa-amount-col">Valor</th>
                    <th>Observação</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {movimentos.map((m) => (
                    <tr key={m.id}>
                      <td>{new Date(m.created_at).toLocaleString('pt-BR')}</td>
                      <td>
                        <span
                          className={`badge ${m.tipo === 'sangria' ? 'badge-danger' : 'badge-success'}`}
                        >
                          {m.tipo === 'sangria' ? 'Sangria' : 'Suprimento'}
                        </span>
                      </td>
                      <td>
                        {editandoMovId === m.id ? (
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            {[['dinheiro', '💵 Dinheiro'], ['pix', '📱 PIX'], ['cartao', '💳 Cartão']].map(([id, lbl]) => (
                              <button key={id} type="button" disabled={salvandoMovForma}
                                onClick={() => trocarFormaMovimento(m, id)}
                                style={{ padding: '4px 9px', borderRadius: 7, cursor: salvandoMovForma ? 'wait' : 'pointer', fontWeight: 700, fontSize: 12.5,
                                  border: `1.5px solid ${(m.forma ?? 'dinheiro') === id ? 'var(--primary)' : 'var(--border)'}`,
                                  background: (m.forma ?? 'dinheiro') === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                                {lbl}
                              </button>
                            ))}
                            <button type="button" onClick={() => setEditandoMovId(null)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}>✕</button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setEditandoMovId(m.id)} title="Trocar a forma"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: '1px dashed var(--border)',
                              borderRadius: 7, padding: '3px 8px', cursor: 'pointer', color: 'var(--text)', font: 'inherit' }}>
                            {rotuloForma(m.forma)}
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>✎</span>
                          </button>
                        )}
                      </td>
                      <td className="caixa-amount-col">R$ {Number(m.valor).toFixed(2)}</td>
                      <td>{m.observacao ?? '-'}</td>
                      <td style={{ textAlign: 'right', width: 1, whiteSpace: 'nowrap' }}>
                        <button
                          type="button"
                          onClick={() => excluirMovimento(m)}
                          disabled={excluindoMovId === m.id}
                          title="Apagar (só enquanto o caixa está aberto)"
                          style={{
                            background: 'none', border: '1px solid var(--border)', borderRadius: 7,
                            padding: '3px 9px', cursor: excluindoMovId === m.id ? 'wait' : 'pointer',
                            color: 'var(--danger, #ef4444)', fontSize: 13, lineHeight: 1.4,
                          }}
                        >
                          {excluindoMovId === m.id ? '...' : '🗑'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Caixa cego: o histórico e o total da semana são só valores de caixa — o
          vendedor não os vê. */}
      {!cego && (<>
      <h2 className="caixa-table-title">{porDia ? 'Histórico de dias' : 'Histórico de caixas'}</h2>

      {/* Uma semana por vez. As setas andam; "Hoje" volta pra semana atual e
          some quando você já está nela. */}
      <div className="caixa-hist-nav">
        <button type="button" className="caixa-hist-seta"
          onClick={() => setSemanaOffset(o => o - 1)}
          title="Semana anterior">←</button>

        <span className="caixa-hist-semana">
          {rotuloSemana(semanaOffset)}
          {carregandoHist && <span className="caixa-hist-carregando"> · carregando...</span>}
        </span>

        <button type="button" className="caixa-hist-seta"
          onClick={() => setSemanaOffset(o => o + 1)}
          disabled={semanaOffset >= 0}
          title={semanaOffset >= 0 ? 'Você já está na semana atual' : 'Semana seguinte'}>→</button>

        {semanaOffset !== 0 && (
          <button type="button" className="caixa-hist-hoje" onClick={() => setSemanaOffset(0)}>
            Voltar pra esta semana
          </button>
        )}
      </div>

      {/* MODO DIA: uma linha por dia da semana. E daqui que a pessoa volta
          num dia atrasado pra conferir — clicar na linha leva pro dia. */}
      {porDia ? (
        <div className="data-table caixa-hist">
          {!diasSemana?.length ? (
            <div className="empty-state">
              {carregandoHist ? 'Carregando...' : 'Nenhum dia nesta semana ainda.'}
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Dia</th>
                  <th className="caixa-amount-col">Faturamento</th>
                  <th className="caixa-amount-col">Contado em dinheiro</th>
                  <th className="caixa-amount-col">Diferença</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {diasSemana.map(({ data, resumo: r, fech }) => {
                  const fat = faturamentoDe(r)
                  // A diferenca sai do ESPERADO CONGELADO, nao de um recalculo:
                  // e esse o numero que a pessoa viu e aceitou naquele dia.
                  const dif = (fech?.contado_dinheiro != null && fech?.esperado_dinheiro != null)
                    ? Number(fech.contado_dinheiro) - Number(fech.esperado_dinheiro)
                    : null
                  return (
                    <tr key={data} onClick={() => setDia(data)} style={{ cursor: 'pointer' }}
                      title="Abrir este dia">
                      <td data-label="Dia">
                        <strong>{ddmmDeYMD(data)}</strong>{' '}
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                          {new Date(data + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short' })}
                        </span>
                      </td>
                      <td data-label="Faturamento" className="caixa-amount-col">R$ {fat.toFixed(2)}</td>
                      <td data-label="Contado em dinheiro" className="caixa-amount-col">
                        {fech?.contado_dinheiro != null ? 'R$ ' + Number(fech.contado_dinheiro).toFixed(2) : '-'}
                      </td>
                      <td data-label="Diferença" className="caixa-amount-col">
                        {dif === null ? '-' : (
                          <span style={{ fontWeight: 700, color: Math.abs(dif) < 0.005
                            ? 'var(--success, #16a34a)' : (dif > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                            R$ {dif.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td data-label="Situação">
                        <span className={`badge ${fech?.fechado_em ? 'badge-success' : 'badge-neutral'}`}>
                          {fech?.fechado_em ? 'Conferido' : 'Em aberto'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : (
      <div className="data-table caixa-hist">
        {historico.length === 0 ? (
          <div className="empty-state">
            {carregandoHist ? 'Carregando...' : 'Nenhum caixa nesta semana.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                {isAdmin && <th>Usuário</th>}
                <th>Abertura</th>
                <th>Fechamento</th>
                <th className="caixa-amount-col">Valor abertura</th>
                <th className="caixa-amount-col">Valor fechamento</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {historico.map((c) => {
                const aberto = histAberto === c.id
                const r = histResumo[c.id]
                const nCols = isAdmin ? 6 : 5
                const espDin = r && r !== 'loading'
                  ? Number(c.valor_abertura || 0) + dinheiroDe(r) + Number(r.total_suprimentos_dinheiro ?? r.total_suprimentos ?? 0) - Number(r.total_sangrias_dinheiro ?? r.total_sangrias ?? 0)
                  : 0
                const espPix = r && r !== 'loading'
                  ? Number(c.valor_abertura_pix || 0) + pixDe(r) + Number(r.total_suprimentos_pix || 0) - Number(r.total_sangrias_pix || 0)
                  : 0
                const fatTot = r && r !== 'loading'
                  ? dinheiroDe(r) + pixDe(r) + cartaoDe(r) + valeDe(r) + Number(r.recebimentos_transferencia || 0) + Number(r.vendas_fiado || 0) + foraDaLojaDe(r) + Number(r.delivery_outros || 0)
                  : 0
                const dif = (r && r !== 'loading' && c.valor_fechamento_informado != null) ? Number(c.valor_fechamento_informado) - espDin : null
                const difPix = (r && r !== 'loading' && c.valor_fechamento_pix != null) ? Number(c.valor_fechamento_pix) - espPix : null
                // Esperado em cartão = o que abriu + o que CAIU NA CONTA (já sem
                // a taxa da maquineta) + suprimentos − sangrias. Mesma conta do
                // caixa aberto (valorEsperadoCartao).
                const espCartao = (r && r !== 'loading')
                  ? Number(c.valor_abertura_cartao || 0) + cartaoLiquidoDe(r) +
                    Number(r.total_suprimentos_cartao || 0) - Number(r.total_sangrias_cartao || 0)
                  : 0
                const difCartao = (r && r !== 'loading' && c.valor_fechamento_cartao != null) ? Number(c.valor_fechamento_cartao) - espCartao : null
                return (
                <Fragment key={c.id}>
                  <tr onClick={() => toggleHist(c)} style={{ cursor: 'pointer' }} title="Toque para ver o detalhamento por forma de pagamento">
                    {isAdmin && <td data-label="Usuário">{nomeUsuario(c.aberto_por)}</td>}
                    <td data-label="Abertura">{new Date(c.aberto_em).toLocaleString('pt-BR')}</td>
                    <td data-label="Fechamento">{c.fechado_em ? new Date(c.fechado_em).toLocaleString('pt-BR') : '-'}</td>
                    <td data-label="Valor abertura" className="caixa-amount-col">R$ {Number(c.valor_abertura).toFixed(2)}</td>
                    <td data-label="Valor fechamento" className="caixa-amount-col">
                      {c.valor_fechamento_informado != null
                        ? `R$ ${Number(c.valor_fechamento_informado).toFixed(2)}`
                        : '-'}
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${STATUS_BADGE[c.status] ?? 'badge-neutral'}`}>
                        {c.status === 'aberto' ? 'Aberto' : 'Fechado'}
                      </span>
                      <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 12 }}>{aberto ? '▲' : '▼'}</span>
                    </td>
                  </tr>
                  {aberto && (
                    <tr>
                      <td colSpan={nCols} className="caixa-hist-detalhe" style={{ background: 'var(--surface-hover)', padding: '12px 16px' }}>
                        {(!r || r === 'loading') ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Carregando detalhamento…</span>
                        ) : (
                          <>
                            {/* Faturamento total — todas as formas, em destaque */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '10px 12px', borderRadius: 10, border: '2px solid var(--primary)', background: 'var(--primary-bg, rgba(124,58,237,.08))' }}>
                              <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1 }}>💰 Faturamento total (todas as formas)</span>
                              <strong style={{ fontSize: 20, color: 'var(--primary)' }}>R$ {fatTot.toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                              {[
                                (Number(c.valor_abertura_pix) > 0 ? ['📱 PIX inicial (abertura)', c.valor_abertura_pix] : null),
                                ['💵 Recebido em dinheiro', dinheiroDe(r)],
                                ['📱 Recebido em PIX', pixDe(r)],
                                ['💳 Recebido em cartão', cartaoDe(r)],
                                (creditoDe(r) > 0 ? ['↳ crédito', creditoDe(r)] : null),
                                (debitoDe(r) > 0 ? ['↳ débito', debitoDe(r)] : null),
                                (valeDe(r) > 0 ? ['🍽️ Recebido em vales', valeDe(r)] : null),
                                // O que sobra do cartão depois da maquineta (com as taxas de hoje).
                                (cartaoDe(r) > 0 && (taxas.credito > 0 || taxas.debito > 0 || taxas.cartao > 0)
                                  ? ['↳ cai na conta (já com as taxas)', cartaoLiquidoDe(r)]
                                  : null),
                                // Fora da loja: vendeu, mas o dinheiro ficou no
                                // iFood / no Mercado Pago. Não entra em esperado.
                                (Number(r.delivery_ifood) > 0 ? ['🛵 iFood (pago no app)', r.delivery_ifood] : null),
                                (Number(r.delivery_online) > 0 ? ['🌐 Pago online (Mercado Pago)', r.delivery_online] : null),
                                (Number(r.delivery_outros) > 0 ? ['⚠️ Forma não reconhecida', r.delivery_outros] : null),
                                (Number(r.recebimentos_transferencia) > 0 ? ['🔁 Transferência', r.recebimentos_transferencia] : null),
                                ['🧾 Vendas no fiado', r.vendas_fiado],
                                // Dívida velha que entrou neste caixa: está DENTRO dos
                                // recebidos acima e não é venda deste dia.
                                (Number(r.recebimentos_fiado) > 0 ? ['🤝 Fiado antigo recebido', r.recebimentos_fiado] : null),
                                (Number(r.recebimentos_fiado_dinheiro) > 0 ? ['↳ fiado em dinheiro', r.recebimentos_fiado_dinheiro] : null),
                                (Number(r.recebimentos_fiado_pix) > 0 ? ['↳ fiado em PIX', r.recebimentos_fiado_pix] : null),
                                (Number(r.recebimentos_fiado_cartao) > 0 ? ['↳ fiado em cartão', r.recebimentos_fiado_cartao] : null),
                                ['➖ Sangrias', r.total_sangrias],
                                ['➕ Suprimentos', r.total_suprimentos],
                                ['🪙 Esperado em dinheiro', espDin],
                                ['🪙 Esperado em PIX', espPix],
                              ].filter(Boolean).map(([lb, v]) => (
                                <div key={lb} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 11px' }}>
                                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{lb}</div>
                                  <div style={{ fontSize: 16, fontWeight: 800 }}>R$ {Number(v || 0).toFixed(2)}</div>
                                </div>
                              ))}
                            </div>
                            {(Number(r.total_sangrias_pix) > 0 || Number(r.total_suprimentos_pix) > 0) && (
                              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                                {Number(r.total_sangrias_pix) > 0 && <>Sangrias por PIX: R$ {Number(r.total_sangrias_pix).toFixed(2)} (não abatem do dinheiro). </>}
                                {Number(r.total_suprimentos_pix) > 0 && <>Suprimentos por PIX: R$ {Number(r.total_suprimentos_pix).toFixed(2)}.</>}
                              </div>
                            )}
                            {dif !== null && (
                              <div style={{ marginTop: 10, fontSize: 13.5, fontWeight: 700 }}>
                                💵 Dinheiro contado: R$ {Number(c.valor_fechamento_informado).toFixed(2)} ·{' '}
                                <span style={{ color: Math.abs(dif) < 0.005 ? 'var(--success, #16a34a)' : (dif > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                                  Diferença: R$ {dif.toFixed(2)}{Math.abs(dif) < 0.005 ? ' (confere)' : dif > 0 ? ' (sobra)' : ' (falta)'}
                                </span>
                              </div>
                            )}
                            {difCartao !== null && (
                              <div style={{ marginTop: 4, fontSize: 13.5, fontWeight: 700 }}>
                                💳 Conta da maquineta: R$ {Number(c.valor_fechamento_cartao).toFixed(2)} · esperado R$ {espCartao.toFixed(2)} ·{' '}
                                <span style={{ color: Math.abs(difCartao) < 0.005 ? 'var(--success, #16a34a)' : (difCartao > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                                  Diferença: R$ {difCartao.toFixed(2)}{Math.abs(difCartao) < 0.005 ? ' (confere)' : difCartao > 0 ? ' (venda não lançada)' : ' (lançada a mais)'}
                                </span>
                              </div>
                            )}
                            {c.conferido_vales && Object.entries(c.conferido_vales).filter(([, x]) => x && x.contado != null).map(([marca, x]) => {
                              const dv = Number(x.contado) - Number(x.esperado || 0)
                              const nome = FORMAS_VALE.find(f => f.value === marca)?.label ?? marca
                              return (
                                <div key={marca} style={{ marginTop: 4, fontSize: 13.5, fontWeight: 700 }}>
                                  🍽️ {nome} na maquineta: R$ {Number(x.contado).toFixed(2)} · esperado R$ {Number(x.esperado || 0).toFixed(2)} ·{' '}
                                  <span style={{ color: Math.abs(dv) < 0.005 ? 'var(--success, #16a34a)' : (dv > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                                    Diferença: R$ {dv.toFixed(2)}{Math.abs(dv) < 0.005 ? ' (confere)' : dv > 0 ? ' (sobra)' : ' (falta)'}
                                  </span>
                                </div>
                              )
                            })}
                            {difPix !== null && (
                              <div style={{ marginTop: 4, fontSize: 13.5, fontWeight: 700 }}>
                                📱 PIX conferido: R$ {Number(c.valor_fechamento_pix).toFixed(2)} ·{' '}
                                <span style={{ color: Math.abs(difPix) < 0.005 ? 'var(--success, #16a34a)' : (difPix > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                                  Diferença: R$ {difPix.toFixed(2)}{Math.abs(difPix) < 0.005 ? ' (confere)' : difPix > 0 ? ' (sobra)' : ' (falta)'}
                                </span>
                              </div>
                            )}

                            {/* O QUE ENTROU, lançamento por lançamento, com filtro por
                                forma. Antes só existia o total por forma no resumo —
                                e conferir o PIX do dia com o extrato do Mercado Pago,
                                ou o cartão com a maquineta, era impossível pela tela. */}
                            {(() => {
                              const todos = histPagos[c.id] ?? []
                              const grupos = FORMAS_PAG.filter(g => todos.some(p => g.casa(p.forma_pagamento)))
                              const lista = filtroForma === 'todos'
                                ? todos
                                : todos.filter(p => FORMAS_PAG.find(g => g.id === filtroForma)?.casa(p.forma_pagamento))
                              const soma = lista.reduce((s, p) => s + Number(p.valor || 0), 0)
                              return (
                                <div style={{ marginTop: 14 }}>
                                  <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                                    O que entrou neste caixa
                                  </div>
                                  {todos.length === 0 ? (
                                    <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum recebimento neste caixa.</div>
                                  ) : (
                                    <>
                                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                                        {[{ id: 'todos', rotulo: 'Todos' }, ...grupos].map(g => (
                                          <button key={g.id} type="button" onClick={() => setFiltroForma(g.id)}
                                            style={{
                                              padding: '5px 11px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                                              border: '1px solid ' + (filtroForma === g.id ? 'var(--primary)' : 'var(--border)'),
                                              background: filtroForma === g.id ? 'var(--primary)' : 'transparent',
                                              color: filtroForma === g.id ? '#fff' : 'var(--text)',
                                            }}>
                                            {g.rotulo}
                                          </button>
                                        ))}
                                      </div>

                                      {/* O total do filtro é o número que se compara com o
                                          extrato — sem ele o filtro só serviria pra olhar. */}
                                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline',
                                        padding: '6px 0 8px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                                        <span style={{ color: 'var(--text-muted)' }}>
                                          {lista.length} lançamento{lista.length === 1 ? '' : 's'}
                                        </span>
                                        <strong style={{ fontSize: 15 }}>R$ {soma.toFixed(2)}</strong>
                                      </div>

                                      <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                                        {lista.map(p => (
                                          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, padding: '3px 0' }}>
                                            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                                              {new Date(p.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                              {' · '}{rotuloPagamento(p.forma_pagamento)}
                                              {p.clientes?.nome ? ` · ${p.clientes.nome}` : ''}
                                              {p.observacao ? ` · ${p.observacao}` : ''}
                                            </span>
                                            <strong style={{ whiteSpace: 'nowrap' }}>R$ {Number(p.valor).toFixed(2)}</strong>
                                          </div>
                                        ))}
                                      </div>
                                    </>
                                  )}
                                </div>
                              )
                            })()}

                            {/* Cada sangria/suprimento com o MOTIVO — é aqui que se
                                descobre pra onde foi o dinheiro depois do caixa fechado. */}
                            <div style={{ marginTop: 14 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                                Sangrias e suprimentos deste caixa
                              </div>
                              {(histMovs[c.id] ?? []).length === 0 ? (
                                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum movimento registrado.</div>
                              ) : (
                                <div style={{ display: 'grid', gap: 8 }}>
                                  {(histMovs[c.id] ?? []).map((m) => (
                                    <div key={m.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 11px' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span className={`badge ${m.tipo === 'sangria' ? 'badge-danger' : 'badge-success'}`}>
                                          {m.tipo === 'sangria' ? 'Sangria' : 'Suprimento'}
                                        </span>
                                        <strong style={{ fontSize: 15 }}>R$ {Number(m.valor).toFixed(2)}</strong>
                                        <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                          {rotuloForma(m.forma)}
                                        </span>
                                        <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                          {new Date(m.created_at).toLocaleString('pt-BR')}
                                        </span>
                                        {isAdmin && (
                                          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                            por {nomeUsuario(m.created_by)}
                                          </span>
                                        )}
                                      </div>
                                      <div style={{ fontSize: 13.5, marginTop: 4 }}>
                                        <span style={{ color: 'var(--text-muted)' }}>Motivo: </span>
                                        {m.observacao ? m.observacao : <span style={{ color: 'var(--text-muted)' }}>não informado</span>}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      )}

      {/* Total da semana — embaixo da tabela, que é onde a pergunta aparece.
          A tabela conta quanto tinha na gaveta em cada dia; isto conta quanto a
          loja VENDEU na semana, e em qual forma. */}
      {(porDia ? (diasSemana?.length ?? 0) > 0 : historico.length > 0) && (
        <div className="caixa-semana">
          <div className="caixa-semana-cab">
            <span className="caixa-semana-rot">💰 Total da semana · {rotuloSemana(semanaOffset)}</span>
            <strong className="caixa-semana-valor">
              {resumosSemana === null ? '…' : `R$ ${totaisSemana.total.toFixed(2)}`}
            </strong>
          </div>

          {resumosSemana === null ? (
            <div className="caixa-semana-carregando">Somando os caixas da semana…</div>
          ) : (
            <>
              <div className="caixa-semana-grid">
                {[
                  ['💵 Dinheiro', totaisSemana.dinheiro, true],
                  ['📱 PIX', totaisSemana.pix, true],
                  ['💳 Cartão', totaisSemana.cartao, true],
                  ['↳ crédito', totaisSemana.credito, totaisSemana.credito > 0],
                  ['↳ débito', totaisSemana.debito, totaisSemana.debito > 0],
                  ['🍽️ Vales (Pluxee/Alelo/VR/Ticket)', totaisSemana.vale, totaisSemana.vale > 0],
                  ['🔁 Transferência', totaisSemana.transferencia, totaisSemana.transferencia > 0],
                  ['🧾 Vendas no fiado', totaisSemana.fiado, totaisSemana.fiado > 0],
                  ['🎟️ Cashback usado', totaisSemana.cashback, totaisSemana.cashback > 0],
                  ['🛵 iFood (pago no app)', totaisSemana.ifood, totaisSemana.ifood > 0],
                  ['🌐 Pago online', totaisSemana.online, totaisSemana.online > 0],
                ].filter(([, , mostrar]) => mostrar).map(([rot, valor]) => (
                  <div className="caixa-semana-card" key={rot}>
                    <div className="caixa-semana-card-rot">{rot}</div>
                    <div className="caixa-semana-card-valor">R$ {Number(valor).toFixed(2)}</div>
                  </div>
                ))}
              </div>

              {/* O que NÃO soma no total: explica o número, não o forma. */}
              <div className="caixa-semana-notas">
                <span>{porDia
                  ? `${diasSemana?.length ?? 0} ${(diasSemana?.length ?? 0) === 1 ? 'dia' : 'dias'} nesta semana`
                  : `${historico.length} ${historico.length === 1 ? 'caixa' : 'caixas'} nesta semana`}</span>
                {totaisSemana.cartao > 0 && totaisSemana.cartaoLiquido !== totaisSemana.cartao && (
                  <span>💳 cai na conta (já com as taxas): <strong>R$ {totaisSemana.cartaoLiquido.toFixed(2)}</strong></span>
                )}
                {totaisSemana.fiadoRecebido > 0 && (
                  <span>🤝 fiado antigo recebido: <strong>R$ {totaisSemana.fiadoRecebido.toFixed(2)}</strong> (já está nas formas acima)</span>
                )}
                {(totaisSemana.sangrias > 0 || totaisSemana.suprimentos > 0) && (
                  <span>
                    ➖ sangrias: <strong>R$ {totaisSemana.sangrias.toFixed(2)}</strong>
                    {' · '}➕ suprimentos: <strong>R$ {totaisSemana.suprimentos.toFixed(2)}</strong>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
      </>)}

      {showAbertura && (
        <div className="modal-overlay" onClick={() => setShowAbertura(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Abrir caixa</h2>
            <form onSubmit={handleAbrir}>
              <div className="form-grid">
                {aberturaTravada ? (
                  /* Loja com a regra ligada: nada de digitar. Mostra o que fechou
                     e abre com isso — se o valor de verdade não bater, o certo é
                     sangria/suprimento, não mexer na abertura. */
                  <div className="form-field full">
                    <div style={{ padding: '12px 14px', borderRadius: 10, border: '2px solid var(--primary)', background: 'var(--primary-bg, rgba(124,58,237,.08))' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                        Abre com o que fechou
                      </div>
                      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>💵 Dinheiro</div>
                          <div style={{ fontSize: 20, fontWeight: 800 }}>{cego ? '•••' : 'R$ ' + Number(ultimoFech.valor_dinheiro || 0).toFixed(2)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>📱 PIX</div>
                          <div style={{ fontSize: 20, fontWeight: 800 }}>{cego ? '•••' : 'R$ ' + Number(ultimoFech.valor_pix || 0).toFixed(2)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>💳 Cartão</div>
                          <div style={{ fontSize: 20, fontWeight: 800 }}>{cego ? '•••' : 'R$ ' + Number(ultimoFech.valor_cartao || 0).toFixed(2)}</div>
                        </div>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
                        Foi o fechamento de {new Date(ultimoFech.fechado_em).toLocaleString('pt-BR')}.
                        Se faltar ou sobrar dinheiro de verdade, abra assim mesmo e registre uma
                        <strong> sangria</strong> ou <strong>suprimento</strong> — assim fica a explicação do que aconteceu.
                      </div>
                    </div>
                  </div>
                ) : (
                <>
                <div className="form-field full">
                  <label htmlFor="valor-abertura">💵 Dinheiro inicial no caixa (R$)</label>
                  <input
                    id="valor-abertura"
                    name="valor_abertura"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorAbertura}
                    onChange={(e) => setValorAbertura(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                {/* PIX começa igual ao dinheiro: se já tem saldo na conta do PIX ao abrir,
                    ele entra aqui — senão o conferido no fechamento aparece sobrando. */}
                <div className="form-field full">
                  <label htmlFor="valor-abertura-pix">📱 PIX inicial (R$) <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85em' }}>deixe vazio se começa do zero</span></label>
                  <input
                    id="valor-abertura-pix"
                    name="valor_abertura_pix"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorAberturaPix}
                    onChange={(e) => setValorAberturaPix(e.target.value)}
                    placeholder="0,00"
                  />
                </div>
                {/* Cartão também tem saldo: a maquineta liquida na hora e o que
                    não foi gasto fica lá pro dia seguinte. */}
                <div className="form-field full">
                  <label htmlFor="valor-abertura-cartao">💳 Saldo inicial na maquineta (R$) <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85em' }}>deixe vazio se começa do zero</span></label>
                  <input
                    id="valor-abertura-cartao"
                    name="valor_abertura_cartao"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorAberturaCartao}
                    onChange={(e) => setValorAberturaCartao(e.target.value)}
                    placeholder="0,00"
                  />
                </div>
                </>
                )}
                <div className="form-field full">
                  <label htmlFor="obs-abertura">Observações</label>
                  <textarea
                    id="obs-abertura"
                    name="observacoes"
                    rows={2}
                    value={obsAbertura}
                    onChange={(e) => setObsAbertura(e.target.value)}
                  />
                </div>
              </div>

              {formError && <p className="error-text">{formError}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowAbertura(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Abrindo...' : aberturaTravada ? 'Abrir com esses valores' : 'Abrir caixa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showMovimento && (
        <div className="modal-overlay" onClick={() => setShowMovimento(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{showMovimento === 'sangria' ? 'Registrar sangria' : 'Registrar suprimento'}</h2>
            <form onSubmit={handleMovimento}>
              <div className="form-grid">
                <div className="form-field full">
                  <label htmlFor="valor-movimento">Valor (R$)</label>
                  <input
                    id="valor-movimento"
                    name="valor"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={valorMovimento}
                    onChange={(e) => setValorMovimento(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div className="form-field full">
                  <label>{showMovimento === 'sangria' ? 'Saiu como' : 'Entrou como'}</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[['dinheiro', '💵 Dinheiro'], ['pix', '📱 PIX'], ['cartao', '💳 Cartão']].map(([id, lbl]) => (
                      <button key={id} type="button" onClick={() => setFormaMovimento(id)}
                        style={{ flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                          border: `1.5px solid ${formaMovimento === id ? 'var(--primary)' : 'var(--border)'}`,
                          background: formaMovimento === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                    {formaMovimento === 'pix'
                      ? 'Por PIX não mexe na gaveta — entra/sai do esperado em PIX.'
                      : formaMovimento === 'cartao'
                      ? 'Saiu da conta da maquineta — entra/sai do esperado em cartão, não da gaveta.'
                      : 'Em dinheiro entra/sai da gaveta e ajusta o esperado em dinheiro.'}
                  </span>
                </div>
                <div className="form-field full">
                  <label htmlFor="obs-movimento">Observação</label>
                  <textarea
                    id="obs-movimento"
                    name="observacao"
                    rows={2}
                    value={obsMovimento}
                    onChange={(e) => setObsMovimento(e.target.value)}
                  />
                </div>
              </div>

              {formError && <p className="error-text">{formError}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowMovimento(null)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando...' : 'Confirmar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* De onde veio o valor do card que foi clicado */}
      {detalhe && (
        <div className="modal-overlay" onClick={() => { setDetalhe(null); setDetalheLinhas(null) }}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: '94vw' }}>
            <h2 style={{ marginBottom: 4 }}>{detalhe.titulo}</h2>
            {detalheLinhas === 'carregando' ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Carregando…</p>
            ) : !detalheLinhas?.length ? (
              <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                Nada neste caixa ainda.
              </p>
            ) : (
              <>
                <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '0 0 10px' }}>
                  {detalheLinhas.length} lançamento{detalheLinhas.length !== 1 ? 's' : ''} neste caixa
                </p>
                <div style={{ maxHeight: '55vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {detalheLinhas.map(l => (
                    <div key={l.id} style={{
                      border: '1px solid var(--border)', borderRadius: 10, padding: '9px 11px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{l.titulo}</div>
                        {l.sub && (
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>{l.sub}</div>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                          {new Date(l.quando).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          {l.forma ? ' · ' + l.forma : ''}
                        </div>
                      </div>
                      <strong style={{ fontSize: 15, whiteSpace: 'nowrap' }}>R$ {l.valor.toFixed(2)}</strong>
                    </div>
                  ))}
                </div>
                {/* O total daqui tem que bater com o do card: os dois saem da
                    mesma view. Se um dia nao bater, e sinal de que alguma venda
                    caiu num balde que a lista nao pediu. */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)', fontWeight: 800,
                }}>
                  <span>Total</span>
                  <span>R$ {detalheLinhas.reduce((t, l) => t + l.valor, 0).toFixed(2)}</span>
                </div>
              </>
            )}
            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn-secondary"
                onClick={() => { setDetalhe(null); setDetalheLinhas(null) }}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      {showFechamento && (
        <div className="modal-overlay" onClick={() => setShowFechamento(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{porDia ? 'Fechar o dia ' + ddmmDeYMD(dia) : 'Fechar caixa'}</h2>
            {cego && (
              <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Conte o que tem e digite. <strong>Se não bater com o sistema, o caixa não fecha</strong> —
                aí anote o que faltou (venda, sangria ou suprimento) ou peça ao dono pra liberar.
                Se não tem PIX ou maquineta, ponha 0.
              </p>
            )}
            {!cego && <p className="caixa-esperado">
              Faturamento total: <strong style={{ color: 'var(--primary)' }}>R$ {faturamentoTotal.toFixed(2)}</strong><br />
              {/* Avisa ANTES de contar a gaveta por que o faturamento e maior
                  que o esperado: parte da venda caiu no iFood / no Mercado Pago. */}
              {foraDaLojaDe(resumo) > 0 && (
                <>Pago fora da loja (iFood/online): <strong>R$ {foraDaLojaDe(resumo).toFixed(2)}</strong> — não está nos esperados abaixo<br /></>
              )}
              Esperado em dinheiro: <strong>R$ {valorEsperadoDinheiro.toFixed(2)}</strong><br />
              Esperado em PIX: <strong>R$ {valorEsperadoPix.toFixed(2)}</strong>
              {valeDe(resumo) > 0 && (
                <><br />Recebido em vales: <strong>R$ {valeDe(resumo).toFixed(2)}</strong> — confira na maquineta de cada um, abaixo</>
              )}
            </p>}
            <form onSubmit={handleFechar}>
              <div className="form-grid">
                <div className="form-field full">
                  <label htmlFor="valor-fechamento">Valor contado em dinheiro (R$)</label>
                  <input
                    id="valor-fechamento"
                    name="valor_fechamento"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorFechamento}
                    onChange={(e) => setValorFechamento(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    required
                    autoFocus
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    {cego
                      ? <><strong>Conte a gaveta</strong> e digite o valor.</>
                      : <>Já veio com o esperado. <strong>Conte a gaveta</strong> — se der outro valor, apague e ponha o que contou.</>}
                  </span>
                </div>
                {diferencaFechamento !== null && !Number.isNaN(diferencaFechamento) && (
                  <div className="form-field full">
                    <span
                      className={`badge ${
                        Math.abs(diferencaFechamento) < 0.005
                          ? 'badge-success'
                          : diferencaFechamento > 0
                          ? 'badge-primary'
                          : 'badge-danger'
                      }`}
                    >
                      Diferença dinheiro: R$ {diferencaFechamento.toFixed(2)}
                      {diferencaFechamento > 0.005
                        ? ' (sobra)'
                        : diferencaFechamento < -0.005
                        ? ' (falta)'
                        : ' (confere)'}
                    </span>
                  </div>
                )}
                <div className="form-field full">
                  <label htmlFor="valor-fechamento-pix">Valor conferido em PIX (R$) <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85em' }}>opcional</span></label>
                  <input
                    id="valor-fechamento-pix"
                    name="valor_fechamento_pix"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorFechamentoPix}
                    onChange={(e) => setValorFechamentoPix(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    placeholder={cego ? '0.00' : `Esperado: ${valorEsperadoPix.toFixed(2)}`}
                  />
                </div>
                {diferencaFechamentoPix !== null && !Number.isNaN(diferencaFechamentoPix) && (
                  <div className="form-field full">
                    <span
                      className={`badge ${
                        Math.abs(diferencaFechamentoPix) < 0.005
                          ? 'badge-success'
                          : diferencaFechamentoPix > 0
                          ? 'badge-primary'
                          : 'badge-danger'
                      }`}
                    >
                      Diferença PIX: R$ {diferencaFechamentoPix.toFixed(2)}
                      {diferencaFechamentoPix > 0.005
                        ? ' (sobra)'
                        : diferencaFechamentoPix < -0.005
                        ? ' (falta)'
                        : ' (confere)'}
                    </span>
                  </div>
                )}
                {/* Cartão: o saldo que ficou na conta da maquineta, como o PIX.
                    Ele anda de um dia pro outro (abre com o que fechou) e desconta
                    a sangria que a loja tira dali pra pagar compra. */}
                <div className="form-field full">
                  <label htmlFor="valor-fechamento-cartao">💳 Saldo na conta da maquineta (R$) <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85em' }}>quanto ficou lá</span></label>
                  <input
                    id="valor-fechamento-cartao"
                    name="valor_fechamento_cartao"
                    type="number"
                    min="0"
                    step="0.01"
                    value={valorFechamentoCartao}
                    onChange={(e) => setValorFechamentoCartao(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    placeholder={cego ? '0.00' : `Esperado: ${valorEsperadoCartao.toFixed(2)}`}
                  />
                  {/* A conta mostra o que CAIU (líquido). Deixar aqui o valor
                      cheio da venda fazia o esperado não fechar com a conta de
                      cima — a taxa sumia no meio sem explicação. */}
                  {!cego && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Abriu com R$ {Number(caixaAtual.valor_abertura_cartao || 0).toFixed(2)} · caiu na conta R$ {totalCartaoLiquido.toFixed(2)}
                    {totalCartaoSistema - totalCartaoLiquido > 0.005
                      && ` (venda R$ ${totalCartaoSistema.toFixed(2)} − maquineta R$ ${(totalCartaoSistema - totalCartaoLiquido).toFixed(2)})`}
                    {Number(resumo?.total_sangrias_cartao || 0) > 0 && ` · sangrou R$ ${Number(resumo.total_sangrias_cartao).toFixed(2)}`}
                  </span>}
                </div>
                {diferencaFechamentoCartao !== null && !Number.isNaN(diferencaFechamentoCartao) && (
                  <div className="form-field full">
                    <span
                      className={`badge ${
                        Math.abs(diferencaFechamentoCartao) < 0.005
                          ? 'badge-success'
                          : diferencaFechamentoCartao > 0
                          ? 'badge-primary'
                          : 'badge-danger'
                      }`}
                    >
                      Diferença cartão: R$ {diferencaFechamentoCartao.toFixed(2)}
                      {diferencaFechamentoCartao > 0.005
                        ? ' (venda na maquineta que não foi lançada)'
                        : diferencaFechamentoCartao < -0.005
                        ? ' (lançado no sistema e não passou na maquineta)'
                        : ' (confere)'}
                    </span>
                    {Math.abs(diferencaFechamentoCartao) >= 0.005 && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                        No sistema: {Number(resumo?.recebimentos_credito || 0) > 0 && <>crédito R$ {Number(resumo.recebimentos_credito).toFixed(2)} · </>}
                        {Number(resumo?.recebimentos_debito || 0) > 0 && <>débito R$ {Number(resumo.recebimentos_debito).toFixed(2)} · </>}
                        total R$ {totalCartaoSistema.toFixed(2)}.
                      </div>
                    )}
                  </div>
                )}
                {/* VALES: uma conferência por bandeira, cada uma com a maquineta dela.
                    Aparece pra quem aceita o vale (ligado em Minha Loja → Pagamento) ou
                    que recebeu algum hoje — loja que não usa não vê nada disso. */}
                {!cego && (() => {
                  const ligadas = Array.isArray(empresa?.formas_pagamento) ? empresa.formas_pagamento : []
                  const marcas = FORMAS_VALE.filter(v => ligadas.includes(v.value) || Number(valesEsperados[v.value] || 0) > 0)
                  if (!marcas.length) return null
                  return (
                    <div className="form-field full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                      <label>🍽️ Vales — total que cada maquineta fechou <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.85em' }}>opcional</span></label>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 8 }}>
                        Cai na conta de cada operadora, não na gaveta. Compare com o fechamento da maquineta.
                      </span>
                      {marcas.map(v => {
                        const esp = Number(valesEsperados[v.value] || 0)
                        const raw = valesContados[v.value]
                        const dif = (raw === '' || raw == null || Number.isNaN(Number(raw))) ? null : Number(raw) - esp
                        return (
                          <div key={v.value} style={{ marginBottom: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ minWidth: 70, fontWeight: 700 }}>{v.label}</span>
                              <input
                                type="number" min="0" step="0.01" inputMode="decimal"
                                value={raw ?? ''}
                                onChange={(e) => setValesContados(p => ({ ...p, [v.value]: e.target.value }))}
                                onFocus={(e) => e.target.select()}
                                placeholder={`Esperado: ${esp.toFixed(2)}`}
                                style={{ flex: 1 }}
                              />
                            </div>
                            {dif !== null && (
                              <span
                                className={`badge ${Math.abs(dif) < 0.005 ? 'badge-success' : dif > 0 ? 'badge-primary' : 'badge-danger'}`}
                                style={{ marginTop: 4, display: 'inline-block' }}
                              >
                                Diferença {v.label}: R$ {dif.toFixed(2)}
                                {Math.abs(dif) < 0.005 ? ' (confere)' : dif > 0 ? ' (venda na maquineta não lançada)' : ' (lançado e não passou na maquineta)'}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
                <div className="form-field full">
                  <label htmlFor="obs-fechamento">Observações</label>
                  <textarea
                    id="obs-fechamento"
                    name="observacoes"
                    rows={2}
                    value={obsFechamento}
                    onChange={(e) => setObsFechamento(e.target.value)}
                  />
                </div>
              </div>

              {formError && <p className="error-text">{formError}</p>}

              {/* O banco recusou: não bateu. Diz qual forma, nunca quanto. */}
              {cego && naoBateu && (
                <div style={{ margin: '4px 0 12px', padding: '12px 14px', borderRadius: 10, border: '1.5px solid #ef4444', background: 'rgba(239,68,68,.08)' }}>
                  <div style={{ fontWeight: 800, color: '#dc2626', marginBottom: 4 }}>
                    ❌ O caixa não bateu{naoBateu.length > 0 && ': ' + naoBateu.map(f => ({ dinheiro: 'dinheiro', pix: 'PIX', cartao: 'maquineta' }[f] ?? f)).join(', ')}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Veja se falta anotar alguma venda, sangria ou suprimento, e conte de novo.
                    Se estiver tudo certo e mesmo assim não bate, <strong>o dono já foi avisado</strong> no
                    WhatsApp — ele fecha o caixa ou libera pra você.
                  </div>
                  {caixaAtual?.liberacao_pedida_em && (
                    <div style={{ marginTop: 8, fontWeight: 700, fontSize: 13 }}>
                      {caixaAtual.liberado_em ? '✅ O dono liberou — clique em Fechar caixa.' : '⏳ Aguardando o dono…'}
                    </div>
                  )}

                  {/* O dono pode resolver pelo WhatsApp: ele recebe um código de
                      4 dígitos junto do aviso e dita pro vendedor. */}
                  {!caixaAtual?.liberado_em && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed rgba(239,68,68,.35)' }}>
                      <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                        O dono te passou um <strong>código</strong>? Digite aqui:
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <input
                          id="codigo-liberacao"
                          type="text"
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={4}
                          value={codigoLib}
                          onChange={e => { setCodigoLib(e.target.value.replace(/\D/g, '')); setCodigoErro('') }}
                          placeholder="0000"
                          style={{
                            width: 110, padding: '10px 12px', borderRadius: 8,
                            border: '1.5px solid var(--border)', fontSize: 20, fontWeight: 800,
                            letterSpacing: 6, textAlign: 'center',
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={fecharComCodigo}
                          disabled={liberando || codigoLib.length !== 4}
                        >
                          {liberando ? 'Fechando...' : 'Fechar com o código'}
                        </button>
                      </div>
                      {codigoErro && (
                        <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 700, color: '#dc2626' }}>
                          {codigoErro}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowFechamento(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-danger" disabled={saving}>
                  {saving ? 'Fechando...' : 'Fechar caixa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Fechou com o código do dono. Só isso: sem valor, sem diferença — quem
          recebe a conta é o dono, na mensagem de fechamento que já existe. */}
      {fechouOk && (
        <div
          role="status"
          style={{
            position: 'fixed', left: '50%', transform: 'translateX(-50%)',
            bottom: `calc(24px + env(safe-area-inset-bottom, 0px))`, zIndex: 9999,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', borderRadius: 999,
            background: '#16a34a', color: '#fff', fontWeight: 700, fontSize: 14,
            boxShadow: '0 8px 24px rgba(0,0,0,.18)', maxWidth: 'calc(100vw - 32px)',
          }}
        >
          ✅ Seu caixa foi fechado com sucesso
        </div>
      )}
    </div>
  )
}
