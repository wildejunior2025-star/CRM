import { Fragment, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
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

// Como cada forma aparece na lista de sangrias/suprimentos.
const rotuloForma = (f) => (f === 'pix' ? '📱 PIX' : f === 'cartao' ? '💳 Cartão' : '💵 Dinheiro')

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
  const { user, profile } = useAuth()
  const isAdmin = profile?.perfil === 'admin'

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [caixaAtual, setCaixaAtual] = useState(null)
  const [resumo, setResumo] = useState(null)
  const [movimentos, setMovimentos] = useState([])
  const [historico, setHistorico] = useState([])
  // Resumo de cada caixa da semana (null = ainda somando). É o que alimenta o
  // total da semana embaixo da tabela.
  const [resumosSemana, setResumosSemana] = useState(null)
  const [semanaOffset, setSemanaOffset] = useState(0)   // 0 = esta semana
  const [carregandoHist, setCarregandoHist] = useState(false)
  const [usuarios, setUsuarios] = useState([])

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
  const cartaoLiquidoDe = (r) => (
    liquido(r?.recebimentos_credito, taxas.credito) +
    liquido(r?.recebimentos_debito, taxas.debito) +
    liquido(r?.recebimentos_cartao_generico, taxas.cartao)
  )

  // Histórico expandível: mostra o detalhamento por forma de pagamento de um caixa fechado.
  const [histVersao, setHistVersao] = useState(0)         // sobe quando abre/fecha caixa → recarrega a semana
  const [histAberto, setHistAberto] = useState(null)      // id do caixa expandido
  const [histResumo, setHistResumo] = useState({})        // { [caixaId]: resumo | 'loading' }
  // Sangrias/suprimentos de um caixa JÁ FECHADO. O total some no resumo, mas o
  // motivo de cada saída continua salvo — aqui ele volta pra tela.
  const [histMovs, setHistMovs] = useState({})            // { [caixaId]: movimentos[] }
  async function toggleHist(c) {
    const abrir = histAberto !== c.id
    setHistAberto(abrir ? c.id : null)
    if (abrir && !histResumo[c.id]) {
      setHistResumo(m => ({ ...m, [c.id]: 'loading' }))
      const [resumoRes, movsRes] = await Promise.all([
        supabase.from('caixa_resumo').select('*').eq('caixa_id', c.id).maybeSingle(),
        supabase.from('caixa_movimentos').select('*').eq('caixa_id', c.id).order('created_at', { ascending: false }),
      ])
      setHistMovs(m => ({ ...m, [c.id]: movsRes.data ?? [] }))
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

    // Caixa aberto é SEMPRE o do usuário logado — inclusive pro admin. Antes o admin
    // via o caixa aberto por qualquer um da loja, e aí esta tela dizia "aberto"
    // enquanto o Salão dizia "abra o caixa" (a venda usa current_caixa_id(), que é o
    // caixa de quem está logado). O histórico abaixo continua mostrando todos pro admin.
    const caixaAtivaQuery = supabase
      .from('caixas').select('*')
      .eq('aberto_por', user.id).eq('status', 'aberto').limit(1)

    // O histórico não vem mais aqui: ele tem carregamento próprio, por semana
    // (ver carregarHistorico), pra andar entre as semanas sem recarregar a tela
    // inteira e pra não puxar caixa que ninguém vai olhar.
    const [caixaRes, usuariosRes, empresaRes] = await Promise.all([
      caixaAtivaQuery,
      isAdmin ? supabase.from('profiles').select('id, nome, email') : Promise.resolve({ data: [] }),
      profile?.empresa_id
        ? supabase.from('empresas').select('taxa_cartao_pct, taxa_credito_pct, taxa_debito_pct, caixa_abre_com_fechamento').eq('id', profile.empresa_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    setRegraFechamento(!!empresaRes.data?.caixa_abre_com_fechamento)
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

    setCaixaAtual(caixaRes.data?.[0] ?? null)
    setUsuarios(usuariosRes.data ?? [])

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

  // Histórico: uma semana por vez. Roda ao abrir a tela, ao trocar de semana e
  // depois de abrir/fechar um caixa (loadAll mexe no histVersao).
  useEffect(() => {
    if (!user?.id) return
    let vivo = true
    async function carregarHistorico() {
      setCarregandoHist(true)
      const { inicio, fim } = semanaDe(semanaOffset)
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
  }, [user?.id, semanaOffset, histVersao])

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
    const { error: rpcError } = await supabase.rpc('registrar_movimento_caixa', {
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
    loadAll()
  }

  // Abre o fechamento com os três campos JÁ PREENCHIDOS com o esperado. Na
  // maioria dos dias bate, e o vendedor só confirma em vez de digitar três
  // valores no fim do expediente. Quando não bate, ele apaga e põe o certo — os
  // campos abrem selecionados (onFocus), então é um toque e digitar por cima.
  function openFechamento() {
    // Sem o resumo carregado o esperado é zero — melhor abrir vazio do que
    // sugerir R$ 0,00 e alguém confirmar sem olhar.
    setValorFechamento(resumo ? valorEsperadoDinheiro.toFixed(2) : '')
    setValorFechamentoPix(resumo ? valorEsperadoPix.toFixed(2) : '')
    setValorFechamentoCartao(resumo ? valorEsperadoCartao.toFixed(2) : '')
    setObsFechamento('')
    setFormError(null)
    setShowFechamento(true)
  }

  async function handleFechar(e) {
    e.preventDefault()
    setFormError(null)

    const valor = Number(valorFechamento)
    if (!(valor >= 0)) {
      setFormError('Informe um valor de fechamento válido.')
      return
    }

    setSaving(true)
    const { error: rpcError } = await supabase.rpc('fechar_caixa', {
      p_caixa_id: caixaAtual.id,
      p_valor_fechamento: valor,
      p_observacoes: obsFechamento || null,
      p_valor_fechamento_pix: valorFechamentoPix === '' ? null : Number(valorFechamentoPix),
      p_valor_fechamento_cartao: valorFechamentoCartao === '' ? null : Number(valorFechamentoCartao),
    })
    setSaving(false)

    if (rpcError) {
      setFormError(rpcError.message)
      return
    }

    setShowFechamento(false)
    loadAll()
  }

  // Só o que é EM DINHEIRO mexe no caixa físico. Sangria/suprimento por PIX não entra
  // aqui (fica registrado, mas não altera o dinheiro esperado na gaveta).
  const valorEsperadoDinheiro = resumo
    ? Number(caixaAtual.valor_abertura) +
      Number(resumo.recebimentos_dinheiro) +
      Number(resumo.total_suprimentos_dinheiro ?? resumo.total_suprimentos) -
      Number(resumo.total_sangrias_dinheiro ?? resumo.total_sangrias)
    : 0

  const diferencaFechamento =
    showFechamento && valorFechamento !== ''
      ? Number(valorFechamento) - valorEsperadoDinheiro
      : null

  // PIX é igual dinheiro: esperado em PIX = saldo que já estava na conta na abertura
  // + recebido em PIX + suprimentos − sangrias (por PIX).
  const valorEsperadoPix = resumo
    ? Number(caixaAtual.valor_abertura_pix || 0) +
      Number(resumo.recebimentos_pix || 0) +
      Number(resumo.total_suprimentos_pix || 0) -
      Number(resumo.total_sangrias_pix || 0)
    : 0
  const diferencaFechamentoPix =
    showFechamento && valorFechamentoPix !== ''
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
  const totalCartaoSistema = resumo ? Number(resumo.recebimentos_cartao || 0) : 0
  const valorEsperadoCartao = resumo
    ? Number(caixaAtual.valor_abertura_cartao || 0) +
      cartaoLiquidoDe(resumo) +
      Number(resumo.total_suprimentos_cartao || 0) -
      Number(resumo.total_sangrias_cartao || 0)
    : 0
  const diferencaFechamentoCartao =
    showFechamento && valorFechamentoCartao !== ''
      ? Number(valorFechamentoCartao) - valorEsperadoCartao
      : null

  // O que sobra de TODO o cartão depois das taxas (cada forma com a taxa dela).
  const totalCartaoLiquido = resumo ? cartaoLiquidoDe(resumo) : 0

  // Faturamento total do caixa: soma de TODAS as formas (dinheiro + pix + cartão + transferência + fiado).
  const faturamentoTotal = resumo
    ? Number(resumo.recebimentos_dinheiro || 0) +
      Number(resumo.recebimentos_pix || 0) +
      Number(resumo.recebimentos_cartao || 0) +
      Number(resumo.recebimentos_transferencia || 0) +
      // Crédito da loja (mig 0179): a venda foi CHEIA, então ele faz parte do
      // faturamento. Não entra em nenhum "esperado" porque não é dinheiro que
      // caiu em lugar nenhum — o custo dele aparece no Despesas & Lucro.
      Number(resumo.recebimentos_cashback || 0) +
      Number(resumo.vendas_fiado || 0)
    : 0

  // ── Total da semana ────────────────────────────────────────────────────────
  // A mesma conta do faturamento de um caixa, somando os caixas todos da semana
  // que está na tela. É a pergunta da segunda de manhã ("quanto entrou na
  // semana, e em quê?") que a tabela não respondia: ela mostra abertura e
  // fechamento, que é quanto tinha na gaveta — não quanto a loja vendeu.
  const totaisSemana = (() => {
    const rs = resumosSemana ?? []
    const soma = (campo) => rs.reduce((t, r) => t + Number(r?.[campo] || 0), 0)
    const dinheiro = soma('recebimentos_dinheiro')
    const pix = soma('recebimentos_pix')
    const cartao = soma('recebimentos_cartao')
    const transferencia = soma('recebimentos_transferencia')
    const fiado = soma('vendas_fiado')
    const cashback = soma('recebimentos_cashback')
    return {
      dinheiro, pix, cartao, transferencia, fiado, cashback,
      credito: soma('recebimentos_credito'),
      debito: soma('recebimentos_debito'),
      fiadoRecebido: soma('recebimentos_fiado'),
      sangrias: soma('total_sangrias'),
      suprimentos: soma('total_suprimentos'),
      cartaoLiquido: rs.reduce((t, r) => t + cartaoLiquidoDe(r), 0),
      total: dinheiro + pix + cartao + transferencia + cashback + fiado,
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
        <div className="card empty-state">Você não tem nenhum caixa aberto no momento.</div>
      ) : (
        <>
          <div className="card caixa-info-card" style={{ marginBottom: 20 }}>
            <div>
              <div className="label">Caixa aberto em</div>
              <div className="value-sm">{new Date(caixaAtual.aberto_em).toLocaleString('pt-BR')}</div>
            </div>
            <div>
              <div className="label">💵 Dinheiro inicial</div>
              <div className="value-sm">R$ {Number(caixaAtual.valor_abertura).toFixed(2)}</div>
            </div>
            <div>
              <div className="label">📱 PIX inicial</div>
              <div className="value-sm">R$ {Number(caixaAtual.valor_abertura_pix || 0).toFixed(2)}</div>
            </div>
            {caixaAtual.observacoes_abertura && (
              <div>
                <div className="label">Observações</div>
                <div className="value-sm">{caixaAtual.observacoes_abertura}</div>
              </div>
            )}
          </div>

          <div className="caixa-actions" style={{ marginBottom: 20 }}>
            <button className="btn btn-secondary" onClick={() => openMovimento('sangria')}>
              - Registrar sangria
            </button>
            <button className="btn btn-secondary" onClick={() => openMovimento('suprimento')}>
              + Registrar suprimento
            </button>
            <button className="btn btn-danger" onClick={openFechamento}>
              Fechar caixa
            </button>
          </div>

          {resumo && (
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
              <div className="card dashboard-card">
                <div className="label">Vendas fiado</div>
                <div className="value">R$ {Number(resumo.vendas_fiado).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Recebimentos em dinheiro</div>
                <div className="value">R$ {Number(resumo.recebimentos_dinheiro).toFixed(2)}</div>
              </div>
              <div className="card dashboard-card">
                <div className="label">Recebimentos Pix</div>
                <div className="value">R$ {Number(resumo.recebimentos_pix).toFixed(2)}</div>
              </div>

              {/* Cashback (mig 0179): a venda entrou cheia, mas este pedaço NÃO
                  é dinheiro em lugar nenhum — é desconto que a loja deu. Fica
                  fora de todo "esperado" e some quando é zero, pra não poluir a
                  tela de quem não usa o programa. */}
              {Number(resumo.recebimentos_cashback || 0) > 0 && (
                <div className="card dashboard-card" style={{ borderLeft: '3px solid #16a34a' }}>
                  <div className="label">🎟️ Cashback usado</div>
                  <div className="value">R$ {Number(resumo.recebimentos_cashback).toFixed(2)}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                    Crédito que os clientes gastaram. Está no faturamento, mas
                    <strong> não entra em nenhum esperado</strong> — vira despesa
                    no Despesas &amp; Lucro.
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
                ['Recebimentos crédito', resumo.recebimentos_credito, taxas.credito, true],
                ['Recebimentos débito', resumo.recebimentos_debito, taxas.debito, true],
                ['Recebimentos cartão', resumo.recebimentos_cartao_generico, taxas.cartao, false],
              ].filter(([, bruto, , sempre]) => sempre || Number(bruto || 0) > 0).map(([titulo, bruto, pct]) => (
                <div className="card dashboard-card" key={titulo}>
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
              {Number(resumo.recebimentos_cartao || 0) > 0 && totalCartaoLiquido !== Number(resumo.recebimentos_cartao) && (
                <div className="card dashboard-card" style={{ borderLeft: '3px solid var(--primary)' }}>
                  <div className="label">💳 Total no cartão</div>
                  <div className="value">R$ {Number(resumo.recebimentos_cartao).toFixed(2)}</div>
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
                <div className="card dashboard-card" style={{ borderLeft: '3px solid #d97706' }}>
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

      <h2 className="caixa-table-title">Histórico de caixas</h2>

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
                  ? Number(c.valor_abertura || 0) + Number(r.recebimentos_dinheiro || 0) + Number(r.total_suprimentos_dinheiro ?? r.total_suprimentos ?? 0) - Number(r.total_sangrias_dinheiro ?? r.total_sangrias ?? 0)
                  : 0
                const espPix = r && r !== 'loading'
                  ? Number(c.valor_abertura_pix || 0) + Number(r.recebimentos_pix || 0) + Number(r.total_suprimentos_pix || 0) - Number(r.total_sangrias_pix || 0)
                  : 0
                const fatTot = r && r !== 'loading'
                  ? Number(r.recebimentos_dinheiro || 0) + Number(r.recebimentos_pix || 0) + Number(r.recebimentos_cartao || 0) + Number(r.recebimentos_transferencia || 0) + Number(r.vendas_fiado || 0)
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
                                ['💵 Recebido em dinheiro', r.recebimentos_dinheiro],
                                ['📱 Recebido em PIX', r.recebimentos_pix],
                                ['💳 Recebido em cartão', r.recebimentos_cartao],
                                (Number(r.recebimentos_credito) > 0 ? ['↳ crédito', r.recebimentos_credito] : null),
                                (Number(r.recebimentos_debito) > 0 ? ['↳ débito', r.recebimentos_debito] : null),
                                // O que sobra do cartão depois da maquineta (com as taxas de hoje).
                                (Number(r.recebimentos_cartao) > 0 && (taxas.credito > 0 || taxas.debito > 0 || taxas.cartao > 0)
                                  ? ['↳ cai na conta (já com as taxas)',
                                     liquido(r.recebimentos_credito, taxas.credito) + liquido(r.recebimentos_debito, taxas.debito) + liquido(r.recebimentos_cartao_generico, taxas.cartao)]
                                  : null),
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
                            {difPix !== null && (
                              <div style={{ marginTop: 4, fontSize: 13.5, fontWeight: 700 }}>
                                📱 PIX conferido: R$ {Number(c.valor_fechamento_pix).toFixed(2)} ·{' '}
                                <span style={{ color: Math.abs(difPix) < 0.005 ? 'var(--success, #16a34a)' : (difPix > 0 ? 'var(--primary)' : 'var(--danger, #ef4444)') }}>
                                  Diferença: R$ {difPix.toFixed(2)}{Math.abs(difPix) < 0.005 ? ' (confere)' : difPix > 0 ? ' (sobra)' : ' (falta)'}
                                </span>
                              </div>
                            )}

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

      {/* Total da semana — embaixo da tabela, que é onde a pergunta aparece.
          A tabela conta quanto tinha na gaveta em cada dia; isto conta quanto a
          loja VENDEU na semana, e em qual forma. */}
      {historico.length > 0 && (
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
                  ['🔁 Transferência', totaisSemana.transferencia, totaisSemana.transferencia > 0],
                  ['🧾 Vendas no fiado', totaisSemana.fiado, totaisSemana.fiado > 0],
                  ['🎟️ Cashback usado', totaisSemana.cashback, totaisSemana.cashback > 0],
                ].filter(([, , mostrar]) => mostrar).map(([rot, valor]) => (
                  <div className="caixa-semana-card" key={rot}>
                    <div className="caixa-semana-card-rot">{rot}</div>
                    <div className="caixa-semana-card-valor">R$ {Number(valor).toFixed(2)}</div>
                  </div>
                ))}
              </div>

              {/* O que NÃO soma no total: explica o número, não o forma. */}
              <div className="caixa-semana-notas">
                <span>{historico.length} {historico.length === 1 ? 'caixa' : 'caixas'} nesta semana</span>
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
                          <div style={{ fontSize: 20, fontWeight: 800 }}>R$ {Number(ultimoFech.valor_dinheiro || 0).toFixed(2)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>📱 PIX</div>
                          <div style={{ fontSize: 20, fontWeight: 800 }}>R$ {Number(ultimoFech.valor_pix || 0).toFixed(2)}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>💳 Cartão</div>
                          <div style={{ fontSize: 20, fontWeight: 800 }}>R$ {Number(ultimoFech.valor_cartao || 0).toFixed(2)}</div>
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

      {showFechamento && (
        <div className="modal-overlay" onClick={() => setShowFechamento(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Fechar caixa</h2>
            <p className="caixa-esperado">
              Faturamento total: <strong style={{ color: 'var(--primary)' }}>R$ {faturamentoTotal.toFixed(2)}</strong><br />
              Esperado em dinheiro: <strong>R$ {valorEsperadoDinheiro.toFixed(2)}</strong><br />
              Esperado em PIX: <strong>R$ {valorEsperadoPix.toFixed(2)}</strong>
            </p>
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
                    Já veio com o esperado. <strong>Conte a gaveta</strong> — se der outro valor, apague e ponha o que contou.
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
                    placeholder={`Esperado: ${valorEsperadoPix.toFixed(2)}`}
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
                    placeholder={`Esperado: ${valorEsperadoCartao.toFixed(2)}`}
                  />
                  {/* A conta mostra o que CAIU (líquido). Deixar aqui o valor
                      cheio da venda fazia o esperado não fechar com a conta de
                      cima — a taxa sumia no meio sem explicação. */}
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                    Abriu com R$ {Number(caixaAtual.valor_abertura_cartao || 0).toFixed(2)} · caiu na conta R$ {totalCartaoLiquido.toFixed(2)}
                    {totalCartaoSistema - totalCartaoLiquido > 0.005
                      && ` (venda R$ ${totalCartaoSistema.toFixed(2)} − maquineta R$ ${(totalCartaoSistema - totalCartaoLiquido).toFixed(2)})`}
                    {Number(resumo?.total_sangrias_cartao || 0) > 0 && ` · sangrou R$ ${Number(resumo.total_sangrias_cartao).toFixed(2)}`}
                  </span>
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
    </div>
  )
}
