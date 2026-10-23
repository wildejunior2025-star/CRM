import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { recadoDeErro } from '../lib/erroRede'
import { useConfirmar } from '../hooks/useConfirmar'
import '../components/Page.css'
import './ContasPagarReceber.css'

// CONTAS A PAGAR E A RECEBER — o que a loja deve e o que tem pra receber, com vencimento.
//
// É CAIXA/compromisso, não lucro: o lucro segue pelo fechamento do dia em "Despesas & Lucro".
// Somar o aluguel aqui e lá contaria duas vezes — por isso a tela avisa isso no rodapé.
// O fiado de clientes continua na aba dele; aqui ele só aparece como lembrete em "A receber".
//
// Regras que moram no BANCO (mig 0365), não aqui: valor pago e status de cada conta são mantidos
// por gatilho a partir das baixas (permite pagar em partes), e a conta que se repete gera a
// próxima sozinha quando é quitada.

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
// Valor curto pro gráfico: 1,2 mil / 15 mil / 800.
const curto = (v) => {
  const n = Math.abs(Number(v || 0))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} mi`
  if (n >= 10_000) return `${Math.round(n / 1000)} mil`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace('.', ',')} mil`
  return String(Math.round(n))
}
// Aceita "12,50", "12.50" e "1.200,50": vírgula manda, ponto vira milhar.
const parseValor = (s) => {
  let x = String(s ?? '').trim().replace(/[^\d.,]/g, '')
  if (!x) return 0
  if (x.includes(',')) x = x.replace(/\./g, '').replace(',', '.')
  return Number(x) || 0
}
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const doYmd = (s) => { const [a, m, d] = String(s).split('-').map(Number); return new Date(a, m - 1, d, 12) }
const ddmm = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '')
const ddmmaa = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}` : '')
const somaDias = (s, n) => { const d = doYmd(s); d.setDate(d.getDate() + n); return ymd(d) }
const diasEntre = (a, b) => Math.round((doYmd(b) - doYmd(a)) / 86_400_000)   // b - a
// Soma meses preservando o DIA de referência (aluguel dia 31 em fevereiro cai no 28/29, e volta ao 31 em março).
function somaMeses(s, n, diaRef) {
  const d = doYmd(s)
  const dia = diaRef || d.getDate()
  const alvo = new Date(d.getFullYear(), d.getMonth() + n, 1, 12)
  const ultimo = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate()
  alvo.setDate(Math.min(dia, ultimo))
  return ymd(alvo)
}
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const nomeMes = (s) => { const m = MESES[Number(s.slice(5, 7)) - 1]; return `${m[0].toUpperCase()}${m.slice(1)} ${s.slice(0, 4)}` }

const CATEGORIAS = {
  pagar: ['Fornecedores', 'Aluguel', 'Energia', 'Água', 'Gás', 'Internet e telefone', 'Salários e encargos', 'Impostos e taxas',
    'Manutenção', 'Marketing', 'Maquininha e taxas', 'Empréstimos', 'Outros'],
  receber: ['Venda a prazo', 'Repasse iFood', 'Repasse cartão', 'Empréstimo a receber', 'Aluguel recebido', 'Outros'],
}
const FORMAS = [['pix', 'PIX'], ['dinheiro', 'Dinheiro'], ['transferencia', 'Transferência'], ['boleto', 'Boleto'],
  ['debito', 'Débito'], ['credito', 'Crédito'], ['cheque', 'Cheque'], ['outro', 'Outro']]
const REPETICOES = [['nenhuma', 'Não repete'], ['parcelado', 'Parcelar em vezes'], ['semanal', 'Toda semana'],
  ['quinzenal', 'A cada 15 dias'], ['mensal', 'Todo mês'], ['anual', 'Todo ano']]
const ROTULO_REP = { semanal: 'toda semana', quinzenal: 'a cada 15 dias', mensal: 'todo mês', anual: 'todo ano' }

// Situação de UMA conta em relação a hoje. Vencida não é status gravado: é "aberta com vencimento antes de hoje".
function situacaoDe(c, hoje) {
  if (c.status === 'paga') return 'paga'
  if (c.status === 'cancelada') return 'cancelada'
  if (c.vencimento < hoje) return 'vencida'
  if (c.vencimento === hoje) return 'hoje'
  return 'aberta'
}
const restanteDe = (c) => Math.max(0, Math.round((Number(c.valor) - Number(c.valor_pago || 0)) * 100) / 100)

function quandoTexto(c, hoje) {
  const sit = situacaoDe(c, hoje)
  if (sit === 'paga') return `${c.tipo === 'pagar' ? 'Paga' : 'Recebida'} em ${ddmmaa(c.pago_em || c.vencimento)}`
  const d = diasEntre(hoje, c.vencimento)
  if (sit === 'hoje') return 'Vence hoje'
  if (d === 1) return 'Vence amanhã'
  if (d > 1) return `Vence ${ddmm(c.vencimento)} · em ${d} dias`
  return `Venceu ${ddmm(c.vencimento)} · há ${Math.abs(d)} ${Math.abs(d) === 1 ? 'dia' : 'dias'}`
}

// Agrupa a lista por "quando": atrasadas, hoje, amanhã, esta semana e depois por mês.
function grupoDe(c, hoje) {
  const sit = situacaoDe(c, hoje)
  if (sit === 'paga' || sit === 'cancelada') return { chave: (c.pago_em || c.vencimento).slice(0, 7), ordem: 9, rotulo: nomeMes(c.pago_em || c.vencimento) }
  if (sit === 'vencida') return { chave: 'atrasadas', ordem: 0, rotulo: '⚠️ Atrasadas' }
  if (sit === 'hoje') return { chave: 'hoje', ordem: 1, rotulo: 'Hoje' }
  const d = diasEntre(hoje, c.vencimento)
  if (d === 1) return { chave: 'amanha', ordem: 2, rotulo: 'Amanhã' }
  if (d <= 7) return { chave: 'semana', ordem: 3, rotulo: 'Próximos 7 dias' }
  return { chave: c.vencimento.slice(0, 7), ordem: 4, rotulo: nomeMes(c.vencimento) }
}

const PERIODOS = [['30d', 'Próximos 30 dias'], ['mes', 'Este mês'], ['mes_passado', 'Mês passado'], ['90d', 'Próximos 90 dias'], ['tudo', 'Tudo']]
function intervaloDoPeriodo(periodo, hoje) {
  const primeiro = `${hoje.slice(0, 7)}-01`
  if (periodo === 'mes') return [primeiro, somaDias(somaMeses(primeiro, 1, 1), -1)]
  if (periodo === 'mes_passado') return [somaMeses(primeiro, -1, 1), somaDias(primeiro, -1)]
  if (periodo === '30d') return ['0000-01-01', somaDias(hoje, 30)]      // inclui atrasadas
  if (periodo === '90d') return ['0000-01-01', somaDias(hoje, 90)]
  return ['0000-01-01', '9999-12-31']
}

function lerEstado(chave, padrao) { try { return localStorage.getItem(chave) || padrao } catch { return padrao } }
function guardarEstado(chave, v) { try { localStorage.setItem(chave, v) } catch { /* sem storage: segue */ } }

export default function ContasPagarReceber({ empresaId, onAbrirFiado }) {
  const [confirmar, avisoConfirmar] = useConfirmar()
  const [contas, setContas] = useState([])
  const [fiado, setFiado] = useState({ total: 0, clientes: 0 })
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)       // { tipo: 'ok' | 'erro', texto }

  const [tipoFiltro, setTipoFiltro] = useState(() => lerEstado('cpr_tipo', 'todas'))
  const [situacaoFiltro, setSituacaoFiltro] = useState(() => lerEstado('cpr_sit', 'abertas'))
  const [periodo, setPeriodo] = useState(() => lerEstado('cpr_periodo', '30d'))
  const [categoriaFiltro, setCategoriaFiltro] = useState('')
  const [busca, setBusca] = useState('')

  const [form, setForm] = useState(null)         // null | { id?, ...campos }
  const [baixaDe, setBaixaDe] = useState(null)   // conta sendo paga/recebida
  const [historicoDe, setHistoricoDe] = useState(null)
  const [menuAberto, setMenuAberto] = useState(null)
  const [clientes, setClientes] = useState([])   // nomes dos clientes cadastrados (sugestão em "a receber")

  const hoje = ymd(new Date())

  const avisar = useCallback((tipo, texto) => {
    setAviso({ tipo, texto })
    setTimeout(() => setAviso((a) => (a && a.texto === texto ? null : a)), 5000)
  }, [])

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setErro(null)
    try {
      // Abertas: todas. Quitadas: só dos últimos 180 dias (o resto vira arquivo morto).
      const corte = somaDias(ymd(new Date()), -180)
      const dados = await fetchAll(() => supabase.from('contas_financeiras').select('*')
        .eq('empresa_id', empresaId)
        .or(`status.eq.aberta,vencimento.gte.${corte}`)
        .order('vencimento').order('created_at').order('id'))
      if (dados.error) throw dados.error
      setContas(dados.data || [])
      const f = await supabase.from('clientes_saldo_fiado').select('saldo_fiado')
      const devedores = (f.data || []).filter((x) => Number(x.saldo_fiado) > 0)
      setFiado({ total: devedores.reduce((s, x) => s + Number(x.saldo_fiado), 0), clientes: devedores.length })
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar as contas'))
    } finally {
      setCarregando(false)
    }
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])
  useEffect(() => {
    if (!form || clientes.length) return
    fetchAll(() => supabase.from('clientes').select('nome').order('nome').order('id'))
      .then((r) => setClientes([...new Set((r.data || []).map((c) => (c.nome || '').trim()).filter(Boolean))]))
      .catch(() => {})
  }, [!!form]) // eslint-disable-line react-hooks/exhaustive-deps
  // Fecha o menu "⋯" ao clicar fora.
  useEffect(() => {
    if (!menuAberto) return
    const fechar = () => setMenuAberto(null)
    document.addEventListener('click', fechar)
    return () => document.removeEventListener('click', fechar)
  }, [menuAberto])

  // ── Resumo (sempre sobre TODAS as contas abertas, sem depender dos filtros) ──
  const resumo = useMemo(() => {
    const abertas = contas.filter((c) => c.status === 'aberta')
    const soma = (lista) => lista.reduce((s, c) => s + restanteDe(c), 0)
    const pagar = abertas.filter((c) => c.tipo === 'pagar')
    const receber = abertas.filter((c) => c.tipo === 'receber')
    const vencPagar = pagar.filter((c) => c.vencimento < hoje)
    const vencReceber = receber.filter((c) => c.vencimento < hoje)
    const ate = (lista, dias) => lista.filter((c) => c.vencimento >= hoje && c.vencimento <= somaDias(hoje, dias))
    const ate30 = somaDias(hoje, 30)
    const entra30 = soma(receber.filter((c) => c.vencimento <= ate30))
    const sai30 = soma(pagar.filter((c) => c.vencimento <= ate30))
    return {
      vencPagarN: vencPagar.length, vencPagar: soma(vencPagar),
      vencReceberN: vencReceber.length, vencReceber: soma(vencReceber),
      pagar7: soma(ate(pagar, 7)), pagar7N: ate(pagar, 7).length,
      receber7: soma(ate(receber, 7)), receber7N: ate(receber, 7).length,
      entra30, sai30, saldo30: entra30 - sai30,
      totalPagar: soma(pagar), totalReceber: soma(receber),
    }
  }, [contas, hoje])

  // Barras: atrasadas + 4 janelas de 7 dias (hoje..+27) + o resto até +30.
  const barras = useMemo(() => {
    const abertas = contas.filter((c) => c.status === 'aberta')
    const faixas = [
      { rotulo: 'Atrasadas', curto: 'Atras.', ini: '0000-01-01', fim: somaDias(hoje, -1) },
      { rotulo: 'Esta semana', curto: 'Semana', ini: hoje, fim: somaDias(hoje, 6) },
      { rotulo: `${ddmm(somaDias(hoje, 7))}–${ddmm(somaDias(hoje, 13))}`, curto: ddmm(somaDias(hoje, 7)), ini: somaDias(hoje, 7), fim: somaDias(hoje, 13) },
      { rotulo: `${ddmm(somaDias(hoje, 14))}–${ddmm(somaDias(hoje, 20))}`, curto: ddmm(somaDias(hoje, 14)), ini: somaDias(hoje, 14), fim: somaDias(hoje, 20) },
      { rotulo: `${ddmm(somaDias(hoje, 21))}–${ddmm(somaDias(hoje, 30))}`, curto: ddmm(somaDias(hoje, 21)), ini: somaDias(hoje, 21), fim: somaDias(hoje, 30) },
    ]
    return faixas.map((f) => {
      const dentro = abertas.filter((c) => c.vencimento >= f.ini && c.vencimento <= f.fim)
      return {
        rotulo: f.rotulo,
        rotuloCurto: f.curto,
        pagar: dentro.filter((c) => c.tipo === 'pagar').reduce((s, c) => s + restanteDe(c), 0),
        receber: dentro.filter((c) => c.tipo === 'receber').reduce((s, c) => s + restanteDe(c), 0),
      }
    })
  }, [contas, hoje])

  // Sugestões de pessoa/categoria a partir do que a loja já usou.
  const sugestoes = useMemo(() => {
    const pessoas = { pagar: new Set(), receber: new Set() }
    const cats = { pagar: new Set(CATEGORIAS.pagar), receber: new Set(CATEGORIAS.receber) }
    for (const c of contas) {
      if (c.pessoa) pessoas[c.tipo].add(c.pessoa)
      if (c.categoria) cats[c.tipo].add(c.categoria)
    }
    return { pessoas, cats }
  }, [contas])

  // ── Lista filtrada ──
  const filtradas = useMemo(() => {
    const [ini, fim] = intervaloDoPeriodo(periodo, hoje)
    const q = busca.trim().toLowerCase()
    return contas.filter((c) => {
      if (tipoFiltro !== 'todas' && c.tipo !== tipoFiltro) return false
      const sit = situacaoDe(c, hoje)
      if (situacaoFiltro === 'abertas' && !['aberta', 'hoje', 'vencida'].includes(sit)) return false
      if (situacaoFiltro === 'vencidas' && sit !== 'vencida') return false
      if (situacaoFiltro === 'pagas' && sit !== 'paga') return false
      // Atrasada aparece sempre que o período termina no futuro: some só se o filtro for "pagas" ou mês fechado.
      const ref = sit === 'paga' ? (c.pago_em || c.vencimento) : c.vencimento
      if (situacaoFiltro !== 'vencidas' && (ref < ini || ref > fim)) return false
      if (categoriaFiltro && c.categoria !== categoriaFiltro) return false
      if (q && !`${c.descricao} ${c.pessoa || ''} ${c.categoria || ''} ${c.observacao || ''}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [contas, tipoFiltro, situacaoFiltro, periodo, categoriaFiltro, busca, hoje])

  // O que o filtro está deixando de fora, pra tela poder avisar em vez de
  // simplesmente não mostrar. `contas` já vem recortada pelo carregamento
  // (quitadas só dos últimos 180 dias), então isto é o escondido de verdade.
  const escondidas = contas.length - filtradas.length
  const temPagaEscondida = useMemo(() => {
    if (escondidas <= 0) return false
    const vistas = new Set(filtradas.map((c) => c.id))
    return contas.some((c) => !vistas.has(c.id) && situacaoDe(c, hoje) === 'paga')
  }, [contas, filtradas, escondidas, hoje])

  const grupos = useMemo(() => {
    const mapa = new Map()
    for (const c of filtradas) {
      const g = grupoDe(c, hoje)
      if (!mapa.has(g.chave)) mapa.set(g.chave, { ...g, itens: [] })
      mapa.get(g.chave).itens.push(c)
    }
    const lista = [...mapa.values()]
    const pagas = situacaoFiltro === 'pagas'
    lista.sort((a, b) => (a.ordem - b.ordem) || (pagas ? b.chave.localeCompare(a.chave) : a.chave.localeCompare(b.chave)))
    for (const g of lista) {
      g.itens.sort((a, b) => (pagas ? (b.pago_em || '').localeCompare(a.pago_em || '') : a.vencimento.localeCompare(b.vencimento)))
      g.pagar = g.itens.filter((c) => c.tipo === 'pagar').reduce((s, c) => s + restanteDe(c), 0)
      g.receber = g.itens.filter((c) => c.tipo === 'receber').reduce((s, c) => s + restanteDe(c), 0)
    }
    return lista
  }, [filtradas, hoje, situacaoFiltro])

  const categoriasDoFiltro = useMemo(() => {
    const set = new Set()
    for (const c of contas) if (c.categoria && (tipoFiltro === 'todas' || c.tipo === tipoFiltro)) set.add(c.categoria)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [contas, tipoFiltro])

  const mudarTipo = (v) => { setTipoFiltro(v); guardarEstado('cpr_tipo', v); setCategoriaFiltro('') }
  const mudarSituacao = (v) => { setSituacaoFiltro(v); guardarEstado('cpr_sit', v) }
  const mudarPeriodo = (v) => { setPeriodo(v); guardarEstado('cpr_periodo', v) }
  const irPara = (tipo, sit) => { mudarTipo(tipo); mudarSituacao(sit); mudarPeriodo('tudo') }

  // ── Ações ──
  async function excluir(c) {
    const ok = await confirmar({
      titulo: `Excluir “${c.descricao}”?`,
      texto: c.recorrencia !== 'nenhuma'
        ? 'Apaga só esta conta. As próximas da repetição continuam; se já foi paga, o pagamento some junto.'
        : 'Apaga a conta e os pagamentos dela. Não dá pra desfazer.',
      textoOk: 'Sim, excluir',
    })
    if (!ok) return
    const { error } = await supabase.from('contas_financeiras').delete().eq('id', c.id)
    if (error) { avisar('erro', recadoDeErro(error, 'excluir a conta')); return }
    avisar('ok', 'Conta excluída.')
    carregar()
  }

  function duplicar(c) {
    setForm({
      tipo: c.tipo, descricao: c.descricao, pessoa: c.pessoa || '', categoria: c.categoria || '',
      valor: String(c.valor).replace('.', ','), vencimento: somaMeses(c.vencimento, 1, c.dia_ref),
      repeticao: 'nenhuma', parcelas: '2', observacao: c.observacao || '', jaQuitada: false, forma: 'pix',
    })
  }

  function editar(c) {
    setForm({
      id: c.id, tipo: c.tipo, descricao: c.descricao, pessoa: c.pessoa || '', categoria: c.categoria || '',
      valor: String(c.valor).replace('.', ','), vencimento: c.vencimento, valorPago: Number(c.valor_pago || 0),
      repeticao: c.recorrencia, parcelas: '2', observacao: c.observacao || '', travadaRepeticao: !!c.parcelas,
    })
  }

  const nova = (tipo) => setForm({
    tipo, descricao: '', pessoa: '', categoria: '', valor: '', vencimento: hoje, repeticao: 'nenhuma', parcelas: '2',
    observacao: '', jaQuitada: false, forma: 'pix',
  })

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  const semNada = !carregando && !erro && contas.length === 0

  return (
    <div className="cpr">
      {avisoConfirmar}

      <div className="cpr-topo">
        <div>
          <h2 className="cpr-titulo">Contas a pagar e a receber</h2>
          <p className="cpr-sub">O que vence, o que já foi pago e o que ainda vai entrar — num lugar só.</p>
        </div>
        <div className="cpr-topo-acoes">
          <button type="button" className="btn cpr-btn-receber" onClick={() => nova('receber')}>＋ A receber</button>
          <button type="button" className="btn cpr-btn-pagar" onClick={() => nova('pagar')}>＋ A pagar</button>
        </div>
      </div>

      {aviso && <div className={`cpr-aviso cpr-aviso-${aviso.tipo}`} role="status">{aviso.texto}</div>}
      {erro && <div className="cpr-aviso cpr-aviso-erro" style={{ whiteSpace: 'pre-line' }}>{erro} <button type="button" className="btn btn-secondary btn-sm" onClick={carregar}>Tentar de novo</button></div>}

      {carregando ? (
        <div className="cpr-skel" aria-busy="true">
          <div className="skeleton" style={{ height: 96 }} /><div className="skeleton" style={{ height: 96 }} />
          <div className="skeleton" style={{ height: 96 }} /><div className="skeleton" style={{ height: 96 }} />
        </div>
      ) : (
        <>
          {/* ── Resumo ── */}
          <div className="cpr-cards">
            <button type="button" className={`cpr-card cpr-card-perigo ${resumo.vencPagarN ? '' : 'cpr-card-ok'}`} onClick={() => irPara('pagar', 'vencidas')}>
              <span className="cpr-card-rotulo">Vencidas a pagar</span>
              <span className="cpr-card-valor">{brl(resumo.vencPagar)}</span>
              <span className="cpr-card-nota">{resumo.vencPagarN ? `${resumo.vencPagarN} ${resumo.vencPagarN === 1 ? 'conta atrasada' : 'contas atrasadas'}` : 'Nenhuma atrasada 👏'}</span>
            </button>
            <button type="button" className="cpr-card" onClick={() => { mudarTipo('pagar'); mudarSituacao('abertas'); mudarPeriodo('30d') }}>
              <span className="cpr-card-rotulo">A pagar em 7 dias</span>
              <span className="cpr-card-valor cpr-neg">{brl(resumo.pagar7)}</span>
              <span className="cpr-card-nota">{resumo.pagar7N} {resumo.pagar7N === 1 ? 'conta' : 'contas'} · total em aberto {brl(resumo.totalPagar)}</span>
            </button>
            <button type="button" className="cpr-card" onClick={() => { mudarTipo('receber'); mudarSituacao('abertas'); mudarPeriodo('30d') }}>
              <span className="cpr-card-rotulo">A receber em 7 dias</span>
              <span className="cpr-card-valor cpr-pos">{brl(resumo.receber7)}</span>
              <span className="cpr-card-nota">{resumo.receber7N} {resumo.receber7N === 1 ? 'conta' : 'contas'}{resumo.vencReceberN ? ` · ${brl(resumo.vencReceber)} atrasado` : ''}</span>
            </button>
            <div className="cpr-card cpr-card-estatico">
              <span className="cpr-card-rotulo">Previsto em 30 dias</span>
              <span className={`cpr-card-valor ${resumo.saldo30 >= 0 ? 'cpr-pos' : 'cpr-neg'}`}>{resumo.saldo30 >= 0 ? '+' : '−'}{brl(Math.abs(resumo.saldo30))}</span>
              <span className="cpr-card-nota">entra {brl(resumo.entra30)} · sai {brl(resumo.sai30)}</span>
            </div>
          </div>

          {(fiado.total > 0) && (
            <div className="cpr-fiado">
              <span>🧾 <strong>Fiado de clientes:</strong> {brl(fiado.total)} em aberto ({fiado.clientes} {fiado.clientes === 1 ? 'cliente' : 'clientes'}) — não entra nas contas abaixo.</span>
              {onAbrirFiado && <button type="button" className="btn btn-secondary btn-sm" onClick={onAbrirFiado}>Abrir Fiado</button>}
            </div>
          )}

          {/* ── Gráfico: próximos 30 dias ── */}
          {!semNada && <Grafico barras={barras} />}

          {semNada ? (
            <div className="card cpr-vazio">
              <div className="cpr-vazio-icone">🗓️</div>
              <h3>Nenhuma conta ainda</h3>
              <p>Cadastre o que você tem pra pagar (luz, aluguel, fornecedor) e pra receber. Eu te mostro o que vence e o que está atrasado.</p>
              <div className="cpr-vazio-acoes">
                <button type="button" className="btn cpr-btn-pagar" onClick={() => nova('pagar')}>＋ Conta a pagar</button>
                <button type="button" className="btn cpr-btn-receber" onClick={() => nova('receber')}>＋ Conta a receber</button>
              </div>
              <p className="cpr-dica">💡 Pelo WhatsApp também: escreva <em>“paguei 80 de gás”</em> ou <em>“a receber João 200 dia 30”</em> no grupo do Assistente.</p>
            </div>
          ) : (
            <>
              {/* ── Filtros ── */}
              <div className="cpr-filtros">
                <div className="cpr-seg" role="tablist" aria-label="Tipo de conta">
                  {[['todas', 'Todas'], ['pagar', 'A pagar'], ['receber', 'A receber']].map(([id, lb]) => (
                    <button key={id} type="button" role="tab" aria-selected={tipoFiltro === id}
                      className={`cpr-seg-btn ${tipoFiltro === id ? 'ativo' : ''} ${id !== 'todas' ? `cpr-seg-${id}` : ''}`} onClick={() => mudarTipo(id)}>{lb}</button>
                  ))}
                </div>
                <div className="cpr-chips" role="group" aria-label="Situação">
                  {[['abertas', 'Em aberto'], ['vencidas', 'Vencidas'], ['pagas', 'Quitadas'], ['todas', 'Todas']].map(([id, lb]) => (
                    <button key={id} type="button" aria-pressed={situacaoFiltro === id}
                      className={`cpr-chip ${situacaoFiltro === id ? 'ativo' : ''}`} onClick={() => mudarSituacao(id)}>{lb}</button>
                  ))}
                </div>
                <div className="cpr-filtros-linha">
                  <input type="search" className="cpr-busca" placeholder="Buscar descrição, fornecedor, cliente…" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar" />
                  <select value={periodo} onChange={(e) => mudarPeriodo(e.target.value)} aria-label="Período">
                    {PERIODOS.map(([id, lb]) => <option key={id} value={id}>{lb}</option>)}
                  </select>
                  <select value={categoriaFiltro} onChange={(e) => setCategoriaFiltro(e.target.value)} aria-label="Categoria">
                    <option value="">Todas as categorias</option>
                    {categoriasDoFiltro.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              {/* QUANTAS O FILTRO ESTÁ ESCONDENDO (23/10/2026)
                  O Wilde registrou uma despesa pelo WhatsApp, abriu esta tela e
                  não achou — duas vezes no mesmo dia. Ela estava PAGA, e o
                  filtro nasce em "Em aberto". A tela promete no subtítulo "o que
                  já foi pago", mas abre escondendo justamente isso. Enquanto o
                  padrão continua "Em aberto" (é o que importa no dia a dia),
                  esta linha conta o que ficou de fora e abre num toque. */}
              {escondidas > 0 && (
                <div className="cpr-escondidas">
                  <span>
                    {escondidas === 1
                      ? '1 conta não aparece com esses filtros'
                      : `${escondidas} contas não aparecem com esses filtros`}
                    {temPagaEscondida ? ' (as já pagas ficam em “Quitadas”)' : ''}
                  </span>
                  <button type="button" className="btn btn-secondary btn-sm"
                    onClick={() => { mudarTipo('todas'); mudarSituacao('todas'); mudarPeriodo('tudo'); setBusca(''); setCategoriaFiltro('') }}>
                    Ver todas
                  </button>
                </div>
              )}

              {/* ── Lista ── */}
              {grupos.length === 0 ? (
                <div className="card cpr-vazio cpr-vazio-pequeno">
                  <div className="cpr-vazio-icone">🔎</div>
                  <p>Nenhuma conta com esses filtros.</p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => { mudarTipo('todas'); mudarSituacao('abertas'); mudarPeriodo('tudo'); setBusca(''); setCategoriaFiltro('') }}>Limpar filtros</button>
                </div>
              ) : grupos.map((g) => (
                <section key={g.chave} className="cpr-grupo">
                  <header className="cpr-grupo-topo">
                    <h3 className={g.chave === 'atrasadas' ? 'cpr-atrasada' : ''}>{g.rotulo} <span className="cpr-grupo-n">{g.itens.length}</span></h3>
                    <span className="cpr-grupo-soma">
                      {g.pagar > 0 && <span className="cpr-neg">− {brl(g.pagar)}</span>}
                      {g.receber > 0 && <span className="cpr-pos">+ {brl(g.receber)}</span>}
                    </span>
                  </header>
                  <ul className="cpr-lista">
                    {g.itens.map((c) => (
                      <LinhaConta key={c.id} c={c} hoje={hoje}
                        menuAberto={menuAberto === c.id}
                        onMenu={(e) => { e.stopPropagation(); setMenuAberto(menuAberto === c.id ? null : c.id) }}
                        onBaixa={() => setBaixaDe(c)} onEditar={() => editar(c)} onDuplicar={() => duplicar(c)}
                        onHistorico={() => setHistoricoDe(c)} onExcluir={() => excluir(c)} />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}

          <p className="cpr-rodape">
            ℹ️ Estas contas controlam <strong>o que vence e o que foi pago</strong> (caixa). O <strong>lucro</strong> continua pelo fechamento do dia em
            “Despesas &amp; Lucro” — por isso uma conta paga aqui não entra de novo no lucro.
          </p>
        </>
      )}

      {form && (
        <FormConta form={form} setForm={setForm} sugestoes={sugestoes} clientes={clientes} hoje={hoje}
          onFechar={() => setForm(null)}
          onSalvo={(texto) => { setForm(null); avisar('ok', texto); carregar() }}
          onErro={(e, oQue) => avisar('erro', recadoDeErro(e, oQue))}
          empresaId={empresaId} />
      )}
      {baixaDe && (
        <ModalBaixa conta={baixaDe} hoje={hoje} onFechar={() => setBaixaDe(null)}
          onSalvo={(texto) => { setBaixaDe(null); avisar('ok', texto); carregar() }}
          onErro={(e) => avisar('erro', recadoDeErro(e, 'registrar o pagamento'))} />
      )}
      {historicoDe && (
        <ModalHistorico conta={historicoDe} onFechar={() => setHistoricoDe(null)}
          onMudou={() => { carregar() }} avisar={avisar} confirmar={confirmar} />
      )}
    </div>
  )
}

// ───────────────────────── Linha da lista ─────────────────────────
function LinhaConta({ c, hoje, menuAberto, onMenu, onBaixa, onEditar, onDuplicar, onHistorico, onExcluir }) {
  const sit = situacaoDe(c, hoje)
  const restante = restanteDe(c)
  const parcial = c.status === 'aberta' && Number(c.valor_pago) > 0
  const pagar = c.tipo === 'pagar'
  return (
    <li className={`cpr-linha cpr-linha-${c.tipo} cpr-sit-${sit}`}>
      <span className="cpr-icone" aria-hidden="true">{pagar ? '↑' : '↓'}</span>
      <div className="cpr-linha-info">
        <div className="cpr-linha-titulo">
          <strong>{c.descricao}</strong>
          {c.categoria && <span className="cpr-tag">{c.categoria}</span>}
          {c.parcelas > 1 && <span className="cpr-tag cpr-tag-parcela">{c.parcela}/{c.parcelas}</span>}
          {c.recorrencia !== 'nenhuma' && <span className="cpr-tag cpr-tag-rep" title={`Se repete ${ROTULO_REP[c.recorrencia]}`}>↻ {ROTULO_REP[c.recorrencia]}</span>}
          {c.origem === 'whatsapp' && <span className="cpr-tag" title="Lançada pelo WhatsApp">💬</span>}
        </div>
        <div className="cpr-linha-sub">
          {c.pessoa && <span>{pagar ? 'Para' : 'De'} <strong>{c.pessoa}</strong> · </span>}
          <span className={`cpr-quando cpr-quando-${sit}`}>{quandoTexto(c, hoje)}</span>
          {c.observacao && <span className="cpr-obs" title={c.observacao}> · 📝 {c.observacao}</span>}
        </div>
      </div>
      <div className="cpr-linha-valor">
        <span className={`cpr-valor ${pagar ? 'cpr-neg' : 'cpr-pos'} ${sit === 'paga' ? 'cpr-riscado' : ''}`}>{brl(sit === 'paga' ? c.valor : restante)}</span>
        {parcial && <span className="cpr-parcial">pago {brl(c.valor_pago)} de {brl(c.valor)}</span>}
        {sit === 'paga' && <span className="badge badge-success">{pagar ? 'Paga' : 'Recebida'}</span>}
        {sit === 'vencida' && <span className="badge badge-danger">Vencida</span>}
        {sit === 'hoje' && <span className="badge badge-warning">Vence hoje</span>}
      </div>
      <div className="cpr-linha-acoes">
        {c.status === 'aberta' && (
          <button type="button" className={`btn btn-sm ${pagar ? 'cpr-btn-pagar' : 'cpr-btn-receber'}`} onClick={onBaixa}>
            {pagar ? 'Pagar' : 'Receber'}
          </button>
        )}
        <div className="cpr-menu-wrap">
          <button type="button" className="btn btn-secondary btn-sm cpr-menu-btn" aria-haspopup="menu" aria-expanded={menuAberto} aria-label={`Mais ações para ${c.descricao}`} onClick={onMenu}>⋯</button>
          {menuAberto && (
            <div className="cpr-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" onClick={onEditar}>✏️ Editar</button>
              <button type="button" role="menuitem" onClick={onDuplicar}>📄 Duplicar (mês seguinte)</button>
              <button type="button" role="menuitem" onClick={onHistorico}>🧾 {pagar ? 'Pagamentos' : 'Recebimentos'}</button>
              <button type="button" role="menuitem" className="cpr-menu-perigo" onClick={onExcluir}>🗑️ Excluir</button>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

// ───────────────────────── Gráfico (SVG) ─────────────────────────
function Grafico({ barras }) {
  // Largura lógica do desenho acompanha a tela: no celular o SVG não encolhe e o texto continua legível.
  const [estreito, setEstreito] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640)
  useEffect(() => {
    const f = () => setEstreito(window.innerWidth < 640)
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])
  const maximo = Math.max(1, ...barras.flatMap((b) => [b.pagar, b.receber]))
  const tudoZero = barras.every((b) => b.pagar === 0 && b.receber === 0)
  const L = estreito ? 340 : 960, A = estreito ? 200 : 210, topo = 24, base = A - 34, alturaUtil = base - topo
  const larguraGrupo = (L - 40) / barras.length
  const w = Math.min(estreito ? 22 : 44, larguraGrupo / 2.6)
  const y = (v) => base - (v / maximo) * alturaUtil
  return (
    <div className="card cpr-grafico">
      <div className="cpr-grafico-topo">
        <h3>Próximos 30 dias</h3>
        <span className="cpr-legenda"><i className="cpr-dot cpr-dot-receber" /> Entra <i className="cpr-dot cpr-dot-pagar" /> Sai</span>
      </div>
      {tudoZero ? (
        <p className="cpr-grafico-vazio">Nada em aberto pros próximos 30 dias.</p>
      ) : (
        <svg viewBox={`0 0 ${L} ${A}`} role="img" aria-label="Valores a receber e a pagar nos próximos 30 dias, por semana" className="cpr-svg">
          {[0.5, 1].map((f) => (
            <line key={f} x1="20" x2={L - 20} y1={base - alturaUtil * f} y2={base - alturaUtil * f} className="cpr-grade" />
          ))}
          <line x1="20" x2={L - 20} y1={base} y2={base} className="cpr-eixo" />
          {barras.map((b, i) => {
            const cx = 20 + larguraGrupo * i + larguraGrupo / 2
            return (
              <g key={b.rotulo}>
                <rect x={cx - w - 2} y={y(b.receber)} width={w} height={Math.max(0, base - y(b.receber))} rx="5" className="cpr-barra-receber">
                  <title>{`${b.rotulo}: entra ${brl(b.receber)}`}</title>
                </rect>
                <rect x={cx + 2} y={y(b.pagar)} width={w} height={Math.max(0, base - y(b.pagar))} rx="5" className="cpr-barra-pagar">
                  <title>{`${b.rotulo}: sai ${brl(b.pagar)}`}</title>
                </rect>
                {b.receber > 0 && <text x={cx - w / 2 - 2} y={y(b.receber) - 5} className="cpr-barra-valor" textAnchor="middle">{curto(b.receber)}</text>}
                {b.pagar > 0 && <text x={cx + w / 2 + 2} y={y(b.pagar) - 5} className="cpr-barra-valor" textAnchor="middle">{curto(b.pagar)}</text>}
                <text x={cx} y={A - 12} className={`cpr-eixo-rotulo ${i === 0 ? 'cpr-eixo-atrasadas' : ''}`} textAnchor="middle">{estreito ? b.rotuloCurto : b.rotulo}</text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

// Campo com lista bonita (no lugar do datalist do navegador): filtra enquanto digita
// e oferece "Criar ..." quando o texto digitado ainda não existe na lista.
function Combo({ id, valor, onChange, opcoes, placeholder, rotuloCriar, maxLength }) {
  const [aberto, setAberto] = useState(false)
  const [ativo, setAtivo] = useState(-1)
  const caixa = useRef(null)
  useEffect(() => {
    if (!aberto) return
    const fora = (e) => { if (caixa.current && !caixa.current.contains(e.target)) setAberto(false) }
    document.addEventListener('mousedown', fora)
    return () => document.removeEventListener('mousedown', fora)
  }, [aberto])
  const norm = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  const q = norm(valor)
  const filtradas = opcoes.filter((o) => !q || norm(o).includes(q)).slice(0, 40)
  const novo = valor.trim()
  const podeCriar = !!rotuloCriar && novo && !opcoes.some((o) => norm(o) === q)
  const itens = [...filtradas.map((o) => ({ v: o })), ...(podeCriar ? [{ v: novo, criar: true }] : [])]
  const escolher = (v) => { onChange(v); setAberto(false); setAtivo(-1) }
  const tecla = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAberto(true); setAtivo((a) => Math.min(a + 1, itens.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAtivo((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter' && aberto && ativo >= 0 && itens[ativo]) { e.preventDefault(); escolher(itens[ativo].v) }
    else if (e.key === 'Escape' && aberto) { e.stopPropagation(); setAberto(false) }
  }
  return (
    <div className="cpr-combo" ref={caixa}>
      <input id={id} autoComplete="off" placeholder={placeholder} value={valor} maxLength={maxLength}
        onChange={(e) => { onChange(e.target.value); setAberto(true); setAtivo(-1) }}
        onFocus={() => setAberto(true)} onKeyDown={tecla} />
      {aberto && itens.length > 0 && (
        <ul className="cpr-combo-lista" role="listbox">
          {itens.map((it, i) => (
            <li key={(it.criar ? '+' : '') + it.v} role="option" aria-selected={i === ativo}
              className={`${i === ativo ? 'ativo' : ''} ${it.criar ? 'criar' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); escolher(it.v) }}>
              {it.criar ? `＋ ${rotuloCriar} "${it.v}"` : it.v}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ───────────────────────── Modal: nova / editar conta ─────────────────────────
function FormConta({ form, setForm, sugestoes, clientes, hoje, onFechar, onSalvo, onErro, empresaId }) {
  const [salvando, setSalvando] = useState(false)
  const [erroCampo, setErroCampo] = useState(null)
  const editando = !!form.id
  const pagar = form.tipo === 'pagar'
  const set = (campo, v) => setForm((f) => ({ ...f, [campo]: v }))
  const valorNum = parseValor(form.valor)
  const parcelas = Math.max(2, Math.min(60, Number(form.parcelas) || 2))
  const parcelado = form.repeticao === 'parcelado'

  // Prévia do parcelamento: valor total dividido, a última parcela leva os centavos que sobram.
  const previa = useMemo(() => {
    if (!parcelado || !(valorNum > 0)) return null
    const base = Math.floor((valorNum / parcelas) * 100) / 100
    const ultima = Math.round((valorNum - base * (parcelas - 1)) * 100) / 100
    return { base, ultima }
  }, [parcelado, valorNum, parcelas])

  async function salvar(e) {
    e.preventDefault()
    if (salvando) return
    setErroCampo(null)
    if (!form.descricao.trim()) return setErroCampo('Diga o que é a conta (ex.: Conta de luz).')
    if (!(valorNum > 0)) return setErroCampo('Informe o valor.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.vencimento)) return setErroCampo('Informe a data de vencimento.')
    if (editando && valorNum < Number(form.valorPago || 0)) return setErroCampo(`Já foram ${pagar ? 'pagos' : 'recebidos'} ${brl(form.valorPago)}; o valor não pode ser menor que isso.`)
    setSalvando(true)
    try {
      const comum = {
        empresa_id: empresaId, tipo: form.tipo, descricao: form.descricao.trim(),
        pessoa: form.pessoa.trim() || null, categoria: form.categoria.trim() || null, observacao: form.observacao.trim() || null,
      }
      if (editando) {
        const { error } = await supabase.from('contas_financeiras').update({
          descricao: comum.descricao, pessoa: comum.pessoa, categoria: comum.categoria, observacao: comum.observacao,
          valor: valorNum, vencimento: form.vencimento,
          ...(form.travadaRepeticao ? {} : { recorrencia: ['semanal', 'quinzenal', 'mensal', 'anual'].includes(form.repeticao) ? form.repeticao : 'nenhuma' }),
        }).eq('id', form.id)
        if (error) throw error
        return onSalvo('Conta atualizada.')
      }
      let linhas
      if (parcelado) {
        const grupo = crypto.randomUUID()
        const diaRef = Number(form.vencimento.slice(8, 10))
        linhas = Array.from({ length: parcelas }, (_, i) => ({
          ...comum, valor: i === parcelas - 1 ? previa.ultima : previa.base,
          vencimento: somaMeses(form.vencimento, i, diaRef), grupo_id: grupo, parcela: i + 1, parcelas, dia_ref: diaRef,
        }))
      } else {
        linhas = [{ ...comum, valor: valorNum, vencimento: form.vencimento,
          recorrencia: ['semanal', 'quinzenal', 'mensal', 'anual'].includes(form.repeticao) ? form.repeticao : 'nenhuma' }]
      }
      const { data, error } = await supabase.from('contas_financeiras').insert(linhas).select('id, valor')
      if (error) throw error
      if (form.jaQuitada && data?.length) {
        // "Já foi paga/recebida": quita só a primeira (a de hoje); as demais parcelas seguem em aberto.
        const { error: e2 } = await supabase.from('contas_baixas').insert({ empresa_id: empresaId, conta_id: data[0].id, valor: data[0].valor, data: hoje, forma: form.forma })
        if (e2) throw e2
      }
      onSalvo(parcelado ? `${parcelas} parcelas criadas.` : form.jaQuitada ? `Conta registrada como ${pagar ? 'paga' : 'recebida'}.` : 'Conta criada.')
    } catch (e) {
      onErro(e, 'salvar a conta')
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !salvando) onFechar() }}>
      <form className="modal cpr-modal" onSubmit={salvar} role="dialog" aria-modal="true" aria-label={editando ? 'Editar conta' : 'Nova conta'}>
        <h2>{editando ? 'Editar conta' : 'Nova conta'}</h2>

        <div className="cpr-tipo-seg" role="group" aria-label="Tipo">
          <button type="button" className={`cpr-tipo-btn cpr-tipo-pagar ${pagar ? 'ativo' : ''}`} disabled={editando} onClick={() => set('tipo', 'pagar')}>↑ A pagar</button>
          <button type="button" className={`cpr-tipo-btn cpr-tipo-receber ${!pagar ? 'ativo' : ''}`} disabled={editando} onClick={() => set('tipo', 'receber')}>↓ A receber</button>
        </div>

        <div className="form-grid">
          <div className="form-field full">
            <label htmlFor="cpr-desc">Descrição</label>
            <input id="cpr-desc" autoFocus placeholder={pagar ? 'Ex.: Conta de luz de novembro' : 'Ex.: Venda a prazo — buffet do João'}
              value={form.descricao} onChange={(e) => set('descricao', e.target.value)} maxLength={120} />
          </div>
          <div className="form-field">
            <label htmlFor="cpr-pessoa">{pagar ? 'Fornecedor / pago a' : 'Cliente / quem vai pagar'}</label>
            <Combo id="cpr-pessoa" valor={form.pessoa} onChange={(v) => set('pessoa', v)} maxLength={80}
              placeholder={pagar ? 'Escolha ou digite o fornecedor' : 'Escolha um cliente ou digite'}
              rotuloCriar={pagar ? 'Novo fornecedor' : 'Usar'}
              opcoes={pagar ? [...sugestoes.pessoas.pagar].sort((a, b) => a.localeCompare(b, 'pt-BR'))
                : [...new Set([...sugestoes.pessoas.receber, ...clientes])].sort((a, b) => a.localeCompare(b, 'pt-BR'))} />
          </div>
          <div className="form-field">
            <label htmlFor="cpr-cat">Categoria</label>
            <Combo id="cpr-cat" valor={form.categoria} onChange={(v) => set('categoria', v)} maxLength={40}
              placeholder="Escolha ou crie uma categoria" rotuloCriar="Criar categoria"
              opcoes={[...sugestoes.cats[form.tipo]]} />
          </div>
          <div className="form-field">
            <label htmlFor="cpr-valor">{parcelado ? 'Valor total (R$)' : 'Valor (R$)'}</label>
            <input id="cpr-valor" inputMode="decimal" placeholder="0,00" value={form.valor} onChange={(e) => set('valor', e.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="cpr-venc">{parcelado ? 'Vencimento da 1ª parcela' : 'Vencimento'}</label>
            <input id="cpr-venc" type="date" value={form.vencimento} onChange={(e) => set('vencimento', e.target.value)} />
          </div>

          {!form.travadaRepeticao && (
            <div className="form-field">
              <label htmlFor="cpr-rep">Repetição</label>
              <select id="cpr-rep" value={form.repeticao} onChange={(e) => set('repeticao', e.target.value)}>
                {REPETICOES.filter(([id]) => !(editando && id === 'parcelado')).map(([id, lb]) => <option key={id} value={id}>{lb}</option>)}
              </select>
            </div>
          )}
          {parcelado && !editando && (
            <div className="form-field">
              <label htmlFor="cpr-parc">Quantas parcelas</label>
              <input id="cpr-parc" type="number" min="2" max="60" inputMode="numeric" value={form.parcelas} onChange={(e) => set('parcelas', e.target.value)} />
            </div>
          )}
          {previa && (
            <div className="cpr-previa cpr-full">
              {parcelas}× de <strong>{brl(previa.base)}</strong>{previa.ultima !== previa.base && <> (a última de {brl(previa.ultima)})</>}
              {' '}· todo dia {form.vencimento.slice(8, 10)}, de {ddmm(form.vencimento)} até {ddmm(somaMeses(form.vencimento, parcelas - 1, Number(form.vencimento.slice(8, 10))))}
            </div>
          )}
          {['semanal', 'quinzenal', 'mensal', 'anual'].includes(form.repeticao) && (
            <div className="cpr-previa cpr-full">↻ Quando você {pagar ? 'pagar' : 'receber'} esta, eu crio a próxima automaticamente ({ROTULO_REP[form.repeticao]}).</div>
          )}

          <div className="form-field full">
            <label htmlFor="cpr-obs">Observação</label>
            <textarea id="cpr-obs" rows={2} placeholder="Opcional (nº do boleto, combinado…)" value={form.observacao} onChange={(e) => set('observacao', e.target.value)} maxLength={300} />
          </div>

          {!editando && (
            <div className="cpr-ja cpr-full">
              <label className="cpr-check">
                <input type="checkbox" checked={!!form.jaQuitada} onChange={(e) => set('jaQuitada', e.target.checked)} />
                <span>Já foi {pagar ? 'paga' : 'recebida'} (registrar a baixa hoje)</span>
              </label>
              {form.jaQuitada && (
                <select aria-label="Forma" value={form.forma} onChange={(e) => set('forma', e.target.value)}>
                  {FORMAS.map(([id, lb]) => <option key={id} value={id}>{lb}</option>)}
                </select>
              )}
            </div>
          )}
        </div>

        {erroCampo && <p className="error-text" role="alert">{erroCampo}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onFechar} disabled={salvando}>Cancelar</button>
          <button type="submit" className={`btn ${pagar ? 'cpr-btn-pagar' : 'cpr-btn-receber'}`} disabled={salvando}>{salvando ? 'Salvando…' : editando ? 'Salvar' : 'Criar conta'}</button>
        </div>
      </form>
    </div>
  )
}

// ───────────────────────── Modal: dar baixa (pagar / receber) ─────────────────────────
function ModalBaixa({ conta, hoje, onFechar, onSalvo, onErro }) {
  const pagar = conta.tipo === 'pagar'
  const restante = restanteDe(conta)
  const [valor, setValor] = useState(restante.toFixed(2).replace('.', ','))
  const [data, setData] = useState(hoje)
  const [forma, setForma] = useState(conta.forma_pagamento || 'pix')
  const [obs, setObs] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erroCampo, setErroCampo] = useState(null)
  const v = parseValor(valor)
  const parcial = v > 0 && v < restante - 0.004

  async function confirmar(e) {
    e.preventDefault()
    if (salvando) return
    if (!(v > 0)) return setErroCampo('Informe o valor.')
    if (v > restante + 0.004) return setErroCampo(`O máximo é ${brl(restante)} (o que falta).`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return setErroCampo('Informe a data.')
    setSalvando(true)
    try {
      const { error } = await supabase.from('contas_baixas').insert({
        empresa_id: conta.empresa_id, conta_id: conta.id, valor: Math.min(v, restante), data, forma, observacao: obs.trim() || null,
      })
      if (error) throw error
      onSalvo(parcial ? `${pagar ? 'Pagamento' : 'Recebimento'} parcial registrado. Ainda falta ${brl(restante - v)}.`
        : `${pagar ? 'Conta paga' : 'Conta recebida'}.${conta.recorrencia !== 'nenhuma' ? ' A próxima já foi criada.' : ''}`)
    } catch (e2) {
      onErro(e2)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !salvando) onFechar() }}>
      <form className="modal cpr-modal cpr-modal-baixa" onSubmit={confirmar} role="dialog" aria-modal="true" aria-label={pagar ? 'Pagar conta' : 'Receber conta'}>
        <h2>{pagar ? 'Pagar conta' : 'Receber conta'}</h2>
        <div className={`cpr-resumo-baixa cpr-resumo-${conta.tipo}`}>
          <strong>{conta.descricao}</strong>
          <span>{conta.pessoa ? `${pagar ? 'Para' : 'De'} ${conta.pessoa} · ` : ''}vence {ddmmaa(conta.vencimento)}</span>
          <span className="cpr-resumo-valor">{brl(restante)}</span>
          {Number(conta.valor_pago) > 0 && <span className="cpr-parcial">já {pagar ? 'pago' : 'recebido'} {brl(conta.valor_pago)} de {brl(conta.valor)}</span>}
        </div>
        <div className="form-grid">
          <div className="form-field">
            <label htmlFor="cpr-bvalor">Valor {pagar ? 'pago' : 'recebido'} (R$)</label>
            <input id="cpr-bvalor" autoFocus inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="cpr-bdata">Data</label>
            <input id="cpr-bdata" type="date" value={data} max={hoje} onChange={(e) => setData(e.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="cpr-bforma">Forma</label>
            <select id="cpr-bforma" value={forma} onChange={(e) => setForma(e.target.value)}>
              {FORMAS.map(([id, lb]) => <option key={id} value={id}>{lb}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="cpr-bobs">Observação</label>
            <input id="cpr-bobs" placeholder="Opcional" value={obs} onChange={(e) => setObs(e.target.value)} maxLength={200} />
          </div>
        </div>
        {parcial && <p className="cpr-previa">Pagamento <strong>parcial</strong>: a conta continua em aberto com {brl(restante - v)}.</p>}
        {erroCampo && <p className="error-text" role="alert">{erroCampo}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onFechar} disabled={salvando}>Cancelar</button>
          <button type="submit" className={`btn ${pagar ? 'cpr-btn-pagar' : 'cpr-btn-receber'}`} disabled={salvando}>
            {salvando ? 'Salvando…' : pagar ? 'Confirmar pagamento' : 'Confirmar recebimento'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ───────────────────────── Modal: histórico de baixas ─────────────────────────
function ModalHistorico({ conta, onFechar, onMudou, avisar, confirmar }) {
  const [baixas, setBaixas] = useState(null)
  const pagar = conta.tipo === 'pagar'
  const carregar = useCallback(async () => {
    const { data, error } = await supabase.from('contas_baixas').select('*').eq('conta_id', conta.id).order('data', { ascending: false }).order('created_at', { ascending: false })
    if (error) { avisar('erro', recadoDeErro(error, 'carregar os pagamentos')); setBaixas([]); return }
    setBaixas(data || [])
  }, [conta.id, avisar])
  useEffect(() => { carregar() }, [carregar])

  async function estornar(b) {
    const ok = await confirmar({
      titulo: `Estornar ${brl(b.valor)}?`,
      texto: `Remove este ${pagar ? 'pagamento' : 'recebimento'} de ${ddmmaa(b.data)}. A conta volta a ter esse valor em aberto.`,
      textoOk: 'Sim, estornar',
    })
    if (!ok) return
    const { error } = await supabase.from('contas_baixas').delete().eq('id', b.id)
    if (error) { avisar('erro', recadoDeErro(error, 'estornar')); return }
    avisar('ok', 'Estornado.')
    await carregar()
    onMudou()
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar() }}>
      <div className="modal cpr-modal" role="dialog" aria-modal="true" aria-label="Histórico">
        <h2>{pagar ? 'Pagamentos' : 'Recebimentos'} — {conta.descricao}</h2>
        <p className="cpr-sub">Valor da conta {brl(conta.valor)} · {pagar ? 'pago' : 'recebido'} {brl(conta.valor_pago)} · falta {brl(restanteDe(conta))}</p>
        {baixas === null ? <div className="skeleton" style={{ height: 60 }} /> : baixas.length === 0 ? (
          <p className="cpr-grafico-vazio">Nenhum {pagar ? 'pagamento' : 'recebimento'} registrado ainda.</p>
        ) : (
          <ul className="cpr-baixas">
            {baixas.map((b) => (
              <li key={b.id}>
                <span><strong>{brl(b.valor)}</strong> · {ddmmaa(b.data)}{b.forma ? ` · ${(FORMAS.find(([id]) => id === b.forma) || [0, b.forma])[1]}` : ''}{b.origem === 'whatsapp' ? ' · 💬' : ''}
                  {b.observacao && <em> — {b.observacao}</em>}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => estornar(b)}>Estornar</button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions"><button type="button" className="btn btn-secondary" onClick={onFechar}>Fechar</button></div>
      </div>
    </div>
  )
}
