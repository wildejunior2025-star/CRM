import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import ClientePicker from '../components/ClientePicker'
import { rotuloComanda } from '../lib/comanda'
import { imprimirHtml, montarContaPresencialHtml, appFwcDisponivel } from '../utils/imprimirCupom'
import '../components/Page.css'

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
// "2026-09-02" vira "02/09". Sem new Date() no meio: a data do banco não tem
// hora, e o fuso do navegador jogaria ela um dia pra trás.
const dataCurta = (d) => {
  const [, m, dia] = String(d ?? '').split('-')
  return dia && m ? `${dia}/${m}` : String(d ?? '')
}
// "seg 02/09" — no extrato o dia da semana diz mais que a data: o garçom lembra
// do sábado cheio, não do dia 30. Data montada na mão pelo mesmo motivo do
// dataCurta: new Date() num "2026-09-02" joga pro dia anterior.
const DIAS_SEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const diaDaSemana = (d) => {
  const [a, m, dia] = String(d ?? '').split('-').map(Number)
  if (!a || !m || !dia) return dataCurta(d)
  return `${DIAS_SEM[new Date(a, m - 1, dia).getDay()]} ${String(dia).padStart(2, '0')}/${String(m).padStart(2, '0')}`
}
const FORMA_LABEL = { dinheiro: 'Dinheiro', pix: 'PIX', credito: 'Crédito', debito: 'Débito', cartao: 'Cartão', fiado: 'Fiado', dividido: 'Dividido', transferencia: 'Transferência' }

// O PIX que entrou pelo QR do Mercado Pago (mig 0193). Não é firula de tela: o
// dinheiro cai em lugar DIFERENTE do PIX na chave da loja — na conta do MP, com
// a comissão do split descontada. Quem confere o caixa com o extrato precisa
// enxergar essa separação, e ela já estava gravada, só não aparecia.
function cobrancasOnlinePagas(c) {
  return (c?.comanda_pix_cobrancas ?? []).filter(x => x?.status === 'pago')
}
function formaComOrigem(c) {
  const base = FORMA_LABEL[c?.forma_pagamento] ?? c?.forma_pagamento ?? '—'
  return cobrancasOnlinePagas(c).length > 0 ? `${base} online` : base
}
// Formas que dá pra escolher ao corrigir uma conta (o "dividido" não entra aqui).
const FORMAS_EDIT = [['dinheiro', 'Dinheiro'], ['pix', 'PIX'], ['credito', 'Crédito'], ['debito', 'Débito'], ['cartao', 'Cartão'], ['fiado', 'Fiado']]

function horaBR(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function PresencialHistorico() {
  const { profile, user, empresa } = useAuth()
  const empresaId = profile?.empresa_id
  // A MESMA tela serve o dono e o garçom. Pro garçom ela vira "Minhas mesas":
  // só as contas que ele atendeu, sem os controles de dono (corrigir forma de
  // pagamento, ligar cliente, mexer na comissão) e sem o ranking dos colegas —
  // quanto o outro vendeu não é assunto dele.
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'
  const meuId = user?.id

  const [comandas, setComandas] = useState([])
  const [garcons, setGarcons]   = useState({})  // { profile_id: nome }
  // { profile_id: perfil } — quem é ADM não divide o bolo (ver ehDaEquipe).
  const [perfis, setPerfis]     = useState({})
  const [entregas, setEntregas] = useState([])  // itens entregues hoje
  const [lancados, setLancados] = useState([])  // itens lançados hoje (mig 0187)
  const [fechadas, setFechadas] = useState([])  // contas fechadas hoje, por quem fechou
  const [pontosCfg, setPontosCfg] = useState({ lancar: 1, entregar: 1, fechar: 2 })
  const [rateioPct, setRateioPct] = useState(0)   // % da taxa que vira o bolo (mig 0188)
  const [taxaDoDia, setTaxaDoDia] = useState(0)   // taxa de serviço arrecadada hoje na LOJA
  // O que cada um tem a receber somando os dias, até o dono pagar (mig 0230).
  const [acumulado, setAcumulado] = useState([])
  // Dia a dia de um garçom (mig 0236): id de quem está aberto e as linhas.
  const [extratoAberto, setExtratoAberto] = useState(null)
  const [extrato, setExtrato] = useState([])
  // Dia a dia da taxa da LOJA (mig 0237) — o outro lado da mesma conta.
  const [taxaDiasAberto, setTaxaDiasAberto] = useState(false)
  const [taxaDias, setTaxaDias] = useState([])
  const [pagando, setPagando]     = useState(null)
  const [loading, setLoading]   = useState(true)
  const [aberta, setAberta]     = useState(null) // id da comanda expandida
  const [pickerComanda, setPickerComanda] = useState(null) // comanda em que se está ligando o cliente
  const [editandoForma, setEditandoForma] = useState(null) // id da comanda com o seletor de forma aberto
  const [salvandoForma, setSalvandoForma] = useState(false)

  // ── Segunda via de uma conta já fechada ──────────────────────────────────
  //
  // A conta sai UMA vez, no fechamento. Se a térmica tinha caído do Bluetooth
  // naquele instante, o papel não saía — e a mesa já estava liberada, fora do
  // Salão. Não havia segunda via em lugar nenhum: o jeito era refazer a conta
  // na mão. Aconteceu na Saidera em 27/08/2026.
  //
  // Aqui vale pra qualquer conta de qualquer dia da lista, porque o histórico
  // já traz os itens (comanda_itens) junto.
  const [imprimindo, setImprimindo] = useState(null) // id da comanda saindo
  const [impMsg, setImpMsg] = useState(null)         // { id, texto }

  async function imprimirSegundaVia(c) {
    setImprimindo(c.id)
    setImpMsg(null)
    const nomeLoja = empresa?.nome || ''
    const dados = {
      numeroMesa: c.numero_mesa,
      // Comanda de balcão sai como "COMANDA 07 · MARIA" no lugar de "MESA 7".
      rotulo: c.tipo === 'balcao' ? rotuloComanda(c) : null,
      itens: c.comanda_itens ?? [],
      subtotal: Number(c.subtotal || 0),
      taxa: Number(c.taxa_servico || 0),
      total: Number(c.total || 0),
      // A forma vem da comanda: é a que foi realmente cobrada (e pode ter sido
      // corrigida aqui mesmo, no "Trocar").
      formaPagamento: formaComOrigem(c),
      pagamentos: [],
      empresa: { nome: nomeLoja },
    }
    // Térmica pareada neste aparelho primeiro (é o caso do celular do balcão);
    // senão o app FWC do PC. O navegador é o ÚLTIMO recurso, não o segundo:
    // a segunda via da conta é papel de térmica, e cair na janela do Chrome
    // sem nem tentar conectar a Bluetooth era o que fazia a loja dizer que o
    // botão "não vai pra impressora" (Saidera, 06/09/2026).
    let via = false
    let bt = null
    try { bt = await import('../utils/imprimirBluetooth') } catch { /* sem Bluetooth neste aparelho */ }
    // 'filtrado' = a Bluetooth existe e está conectada, mas ESTE aparelho está
    // marcado como impressora da cozinha. Não adianta tentar por outro caminho
    // (sairia via dupla) — o que faltava era DIZER isso. Antes a tela avisava
    // "enviada pra impressora" e não saía papel nenhum.
    if (bt) { try { via = await bt.imprimirMesaSeConectada('conta', dados) } catch { via = false } }

    // App Impressora FWC (PC da loja). `soApp: true`: aqui ele não pode cair no
    // navegador sozinho — quem decide isso é o passo seguinte.
    if (!via) via = await imprimirHtml(montarContaPresencialHtml(dados), nomeLoja, { soApp: true, origem: 'mesa' })

    // Nem térmica pareada nem app: se ESTE aparelho tem Bluetooth, oferece
    // parear agora. O clique no botão é o gesto do usuário que o navegador
    // exige pra abrir a lista de impressoras — por isso dá pra fazer aqui e
    // não num aviso depois.
    // Se o app FWC ESTÁ aberto e mesmo assim recusou, o problema é a config
    // dele (este PC não está marcado pra imprimir conta de mesa) — oferecer
    // Bluetooth aqui só confundiria quem está no PC da loja.
    const temApp = via ? false : await appFwcDisponivel()
    let ofereceu = false
    if (!via && !temApp && bt && typeof navigator !== 'undefined' && navigator.bluetooth) {
      ofereceu = true
      const querConectar = window.confirm(
        'A térmica não está conectada neste aparelho.' + '\n\n'
        + 'Conectar agora pra sair na impressora? (Cancelar imprime pelo navegador.)'
      )
      if (querConectar) {
        try {
          await bt.conectarImpressoraCelular()
          via = await bt.imprimirMesaSeConectada('conta', dados)
        } catch { via = false }
      }
    }

    // Último recurso mesmo: janela de impressão do navegador.
    if (!via) via = await imprimirHtml(montarContaPresencialHtml(dados), nomeLoja, { soApp: false, origem: 'mesa' })

    const texto = via === 'filtrado'
      ? '⚠️ Este aparelho está marcado como impressora da COZINHA — conta sai na da frente.'
      : via === 'navegador'
        ? (temApp
          ? '⚠️ O app FWC está aberto mas recusou: confira em "O que este PC imprime" se Mesa/Salão está ligado. Abri pelo navegador.'
          : ofereceu
            ? '🖨️ Térmica não conectada — abri a impressão pelo navegador.'
            : '🖨️ Sem térmica neste aparelho (app FWC fechado?) — abri pelo navegador.')
        : via
          ? '🧾 Segunda via enviada pra impressora.'
          : '⚠️ Não achei impressora neste aparelho.'
    setImprimindo(null)
    setImpMsg({ id: c.id, texto })
    setTimeout(() => setImpMsg(null), 6000)
  }

  // Corrige a forma de pagamento de uma conta já fechada (lançou errado e fechou).
  async function trocarForma(comanda, forma) {
    if (forma === comanda.forma_pagamento) { setEditandoForma(null); return }
    setSalvandoForma(true)
    const { error } = await supabase.rpc('alterar_forma_pagamento_comanda', {
      p_comanda_id: comanda.id, p_forma: forma,
    })
    setSalvandoForma(false)
    setEditandoForma(null)
    if (error) { window.alert('Não deu pra trocar a forma: ' + error.message); return }
    setComandas(prev => prev.map(c => c.id === comanda.id ? { ...c, forma_pagamento: forma } : c))
  }

  // Liga (ou tira) um cliente a uma conta já fechada. Propaga pra venda no banco.
  async function ligarCliente(comanda, cliente) {
    const { error } = await supabase.rpc('vincular_cliente_comanda', {
      p_comanda_id: comanda.id, p_cliente_id: cliente?.id ?? null,
    })
    setPickerComanda(null)
    if (error) { window.alert('Erro ao ligar o cliente: ' + error.message); return }
    setComandas(prev => prev.map(c => c.id === comanda.id
      ? { ...c, cliente: cliente ? { id: cliente.id, nome: cliente.nome, telefone: cliente.telefone } : null }
      : c))
  }

  useEffect(() => {
    if (!empresaId) return
    const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0)
    // Antes eu filtrava no banco por `garcom_id` (quem ABRIU a mesa) e achei que
    // estava economizando dados. Estava, e estava errado: o ranking conta gesto
    // por gesto, então o garçom que entregou dez itens numa mesa que outro abriu
    // não via essa mesa em lugar nenhum — e a comissão dela sumia da vista dele.
    // Agora vem tudo e a tela separa o que é dele (participouDaConta).
    const qComandas = supabase.from('comandas')
      // As cobranças do Mercado Pago vêm junto: é o que separa o PIX ONLINE
      // (dinheiro na conta do MP, com a comissão do split) do PIX na chave da
      // loja. Os dois estavam escritos só "PIX" e caíam no mesmo balaio na hora
      // de conferir o caixa com o extrato.
      .select('*, comanda_itens(*), cliente:clientes(id, nome, telefone), comanda_pix_cobrancas(id, mp_payment_id, valor, status)')
      .eq('empresa_id', empresaId)
      .eq('status', 'fechada')

    Promise.all([
      qComandas.order('fechada_at', { ascending: false }).limit(100),
      supabase.from('profiles').select('id, nome, perfil').eq('empresa_id', empresaId),
      supabase.from('comanda_itens')
        .select('entregue_por, preco_unitario, quantidade')
        .eq('empresa_id', empresaId)
        .eq('status', 'entregue')
        .not('entregue_por', 'is', null)
        .gte('entregue_at', inicioHoje.toISOString()),
      supabase.from('empresas').select('rateio_taxa_pct, pontos_garcom').eq('id', empresaId).single(),
      // Quem LANÇOU cada item hoje (mig 0187)
      supabase.from('comanda_itens')
        .select('lancado_por, preco_unitario, quantidade')
        .eq('empresa_id', empresaId)
        .not('lancado_por', 'is', null)
        .gte('created_at', inicioHoje.toISOString()),
      // Quem FECHOU cada conta hoje (mig 0187)
      supabase.from('comandas')
        .select('fechada_por')
        .eq('empresa_id', empresaId)
        .not('fechada_por', 'is', null)
        .gte('fechada_por_em', inicioHoje.toISOString()),
      // Taxa arrecadada hoje na LOJA INTEIRA — é ela que forma o bolo. Consulta
      // à parte de propósito: a lista de contas é limitada a 100 e filtrada por
      // garçom, então somar a taxa a partir dela daria um bolo menor que o real.
      supabase.from('comandas')
        .select('taxa_servico')
        .eq('empresa_id', empresaId)
        .eq('status', 'fechada')
        .gte('fechada_at', inicioHoje.toISOString()),
    ]).then(([cs, gs, es, emp, ls, fs, tx]) => {
      const todas = cs.data ?? []
      // Conta em que ELE encostou: abriu, lançou, entregou ou fechou.
      const participouDaConta = (c) => c.garcom_id === meuId
        || c.fechada_por === meuId
        || (c.comanda_itens ?? []).some(i => i.entregue_por === meuId || i.lancado_por === meuId)
      setComandas(ehAdmin ? todas : todas.filter(participouDaConta))
      setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
      setPerfis(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.perfil])))
      setEntregas(es.data ?? [])
      setLancados(ls.data ?? [])
      setFechadas(fs.data ?? [])
      setRateioPct(Number(emp.data?.rateio_taxa_pct ?? 0))
      setTaxaDoDia((tx.data ?? []).reduce((acc, c) => acc + Number(c.taxa_servico || 0), 0))
      const pc = emp.data?.pontos_garcom
      if (pc) setPontosCfg({ lancar: Number(pc.lancar ?? 1), entregar: Number(pc.entregar ?? 1), fechar: Number(pc.fechar ?? 2) })
      setLoading(false)
    })
    carregarAcumulado()
  }, [empresaId, ehAdmin, meuId]) // eslint-disable-line react-hooks/exhaustive-deps

  // O acumulado é conta de vários dias, cada um com o bolo dele — quem faz é o
  // banco (mig 0230), não a tela. O garçom só enxerga a linha dele: a RLS de
  // profiles não é o assunto aqui, mas o ranking de dinheiro do colega é dele.
  async function carregarAcumulado() {
    const { data, error } = await supabase.rpc('acumulado_garcons')
    if (error) return
    const lista = (data ?? []).filter(a => ehAdmin || a.garcom_id === meuId)
    setAcumulado(lista)
  }

  /**
   * Abre (ou fecha) o dia a dia de um garçom.
   *
   * O acumulado é um número só, e número só o garçom tem que aceitar de olhos
   * fechados. Aqui ele vê cada dia com o bolo daquele dia — e a soma das linhas
   * bate com o total de cima, que é o ponto: dá pra conferir a semana antes de
   * receber. A conta é do banco (mig 0236), a mesma do acumulado.
   */
  async function abrirExtrato(garcomId) {
    if (extratoAberto === garcomId) { setExtratoAberto(null); return }
    setExtratoAberto(garcomId)
    setExtrato('carregando')
    const { data, error } = await supabase.rpc('extrato_garcom', { p_garcom: garcomId })
    setExtrato(error ? [] : (data ?? []))
  }

  // Marca que o dono acertou com o garçom: daqui pra frente a conta dele
  // recomeça no dia seguinte. Não mexe no caixa — quem paga é o dono, no
  // dinheiro dele, e lançar isso como despesa é outra decisão.
  async function pagarGarcom(a) {
    const ok = window.confirm(
      `Confirmar que você pagou ${fmt(a.valor)} pra ${a.nome}?\n\n`
      + `São ${a.pontos} pontos, de ${dataCurta(a.desde)} até hoje.\n\n`
      + 'A conta dele volta pro zero a partir de amanhã. Isto não mexe no caixa.')
    if (!ok) return
    setPagando(a.garcom_id)
    const { error } = await supabase.from('garcom_acertos').insert({
      empresa_id: empresaId,
      garcom_id: a.garcom_id,
      ate_dia: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' }),
      valor: Number(a.valor) || 0,
      pontos: Number(a.pontos) || 0,
      pago_por: meuId,
    })
    setPagando(null)
    if (error) { window.alert('Não consegui registrar o pagamento: ' + error.message); return }
    await carregarAcumulado()
  }

  /**
   * O dia a dia da taxa da loja. Mesmo motivo do extrato do garçom: o card de
   * cima mostra hoje, e hoje some à meia-noite. O dono precisa do histórico pra
   * saber quanto entrou de taxa na semana e quanto dela saiu da mão dele.
   */
  async function abrirTaxaDias() {
    if (taxaDiasAberto) { setTaxaDiasAberto(false); return }
    setTaxaDiasAberto(true)
    setTaxaDias('carregando')
    const { data, error } = await supabase.rpc('taxa_servico_dias', { p_dias: 30 })
    setTaxaDias(error ? [] : (data ?? []))
  }

  async function salvarPontos(campo, valor) {
    const n = Math.max(0, Math.min(99, Number(valor) || 0))
    const novo = { ...pontosCfg, [campo]: n }
    setPontosCfg(novo)
    await supabase.from('empresas').update({ pontos_garcom: novo }).eq('id', empresaId)
  }

  async function salvarRateio(v) {
    const n = Math.max(0, Math.min(100, Number(v) || 0))
    setRateioPct(n)
    await supabase.from('empresas').update({ rateio_taxa_pct: n }).eq('id', empresaId)
  }

  // Ranking do dia por PONTOS (mig 0187).
  //
  // Antes contava só entrega. O ranking por "dono da mesa" (quem abriu) foi
  // descartado de propósito: ele obriga o garçom a carregar aquela mesa até o
  // fim pra levar o crédito, e cria o "não mexe na minha mesa" que trava o
  // salão. Contando gesto por gesto, qualquer um atende qualquer mesa.
  const rankingTodos = useMemo(() => {
    const map = {}
    const linha = (k) => (map[k] ??= { id: k, lancou: 0, entregou: 0, fechou: 0, valor: 0 })
    for (const it of lancados) linha(it.lancado_por).lancou += it.quantidade
    for (const it of entregas) {
      const l = linha(it.entregue_por)
      l.entregou += it.quantidade
      l.valor += Number(it.preco_unitario) * it.quantidade   // base da comissão em R$
    }
    for (const c of fechadas) linha(c.fechada_por).fechou += 1
    return Object.values(map).map(r => ({
      ...r,
      pontos: r.lancou * pontosCfg.lancar + r.entregou * pontosCfg.entregar + r.fechou * pontosCfg.fechar,
    })).sort((a, b) => b.pontos - a.pontos)
  }, [lancados, entregas, fechadas, pontosCfg])

  // O bolo do dia e quanto vale cada ponto. O total de pontos é o de TODOS os
  // garçons, inclusive quando a tela mostra só um: o ponto do garçom vale menos
  // no dia em que a equipe inteira trabalhou mais, e é isso que segura o bolo.
  const bolo = taxaDoDia * (Number(rateioPct) || 0) / 100
  // O ADM não divide o bolo (decisão do Wilde, 02/09/2026). Na Saidera é a conta
  // da loja que fecha quase toda conta — o garçom faz a pré-conta e ela recebe —
  // então ela levava os 2 pontos do "fechar" em cima de cada mesa e ficava com a
  // maior pontuação do dia: 44% do bolo dos garçons ia pra ela. Ela continua no
  // ranking (é bom ver o movimento), só não entra na divisão.
  const ehDaEquipe = (id) => {
    const p = perfis[id]
    return p !== 'admin' && p !== 'super_admin'
  }
  const pontosDaLoja = rankingTodos.reduce((s, r) => s + (ehDaEquipe(r.id) ? r.pontos : 0), 0)
  const valorPorPonto = pontosDaLoja > 0 ? bolo / pontosDaLoja : 0
  const ganhoDe = (r) => (ehDaEquipe(r.id) ? r.pontos * valorPorPonto : 0)

  const ranking = useMemo(
    () => (ehAdmin ? rankingTodos : rankingTodos.filter(r => r.id === meuId)),
    [rankingTodos, ehAdmin, meuId])

  // Resumo de hoje
  const resumoHoje = useMemo(() => {
    const hoje = new Date().toDateString()
    const doDia = comandas.filter(c => c.fechada_at && new Date(c.fechada_at).toDateString() === hoje)
    return {
      qtd: doDia.length,
      total: doDia.reduce((s, c) => s + Number(c.total || 0), 0),
    }
  }, [comandas])

  // Pontos que ELE fez nesta mesa. Não dá pra mostrar R$ por mesa: o bolo é
  // do DIA e o valor do ponto só existe depois que o dia fecha — quanto mais a
  // equipe trabalhar, menos vale o ponto. Mostrar um R$ por mesa seria um
  // número que muda sozinho até o fim do expediente.
  const pontosNaConta = (c) => {
    const itens = c.comanda_itens ?? []
    const meu = (id) => ehAdmin || id === meuId
    let p = 0
    for (const i of itens) {
      if (i.lancado_por && meu(i.lancado_por)) p += i.quantidade * pontosCfg.lancar
      if (i.entregue_por && meu(i.entregue_por)) p += i.quantidade * pontosCfg.entregar
    }
    if (c.fechada_por && meu(c.fechada_por)) p += pontosCfg.fechar
    return p
  }

  // O que ele leva hoje: os pontos dele vezes o valor do ponto.
  const meuGanhoHoje = rankingTodos
    .filter(r => r.id === meuId)
    .reduce((s, r) => s + ganhoDe(r), 0)

  if (loading) return <div className="page"><p>Carregando...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to={ehAdmin ? '/pedidos-delivery' : '/presencial/salao'} style={{ color: 'var(--primary)' }}>
              {ehAdmin ? '← Vendas' : '← Salão'}
            </Link>
          </p>
          <h1>{ehAdmin ? 'Vendas salão' : 'Minhas mesas'}</h1>
          <p className="page-subtitle">
            {ehAdmin ? 'Contas fechadas do salão.' : 'As mesas que você atendeu e já foram fechadas.'}
          </p>
        </div>
      </div>

      {/* Resumo de hoje — dois blocos de largura igual, pra caber lado a lado
          na tela do celular em vez de um empurrar o outro pra baixo. */}
      <div style={{ marginBottom: 12, display: 'flex', gap: 10 }}>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.3 }}>
            {ehAdmin ? 'Contas fechadas hoje' : 'Mesas fechadas hoje'}
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, marginTop: 2 }}>{resumoHoje.qtd}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          {/* Pro dono, o que entrou. Pro garçom, o que É DELE — mostrar o total
              das mesas pra ele daria a impressão errada de que aquele dinheiro
              é o ganho dele. */}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.3 }}>
            {ehAdmin ? 'Recebido hoje (com a taxa)' : 'Você ganhou hoje'}
          </div>
          <div style={{ fontSize: 21, fontWeight: 800, marginTop: 2, color: 'var(--success)', overflowWrap: 'anywhere' }}>
            {fmt(ehAdmin ? resumoHoje.total : meuGanhoHoje)}
          </div>
        </div>
      </div>

      {/* A taxa de serviço tinha um lugar só: escondida dentro da frase do bolo,
          e só quando o rateio estava ligado. É o número que o dono precisa pra
          saber quanto entrou de taxa e quanto dela sai da mão dele. */}
      {ehAdmin && taxaDoDia > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Taxa de serviço arrecadada hoje</span>
            <strong style={{ fontSize: 22 }}>{fmt(taxaDoDia)}</strong>
          </div>
          {Number(rateioPct) > 0 ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Vai pros garçons ({rateioPct}%)</span>
                <strong style={{ color: 'var(--success)', whiteSpace: 'nowrap' }}>{fmt(bolo)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Fica com a loja</span>
                <strong style={{ whiteSpace: 'nowrap' }}>{fmt(taxaDoDia - bolo)}</strong>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              Tudo fica com a loja. Pra repassar uma parte pros garçons, defina a fatia
              logo abaixo, em <strong>Quanto vale cada gesto</strong>.
            </div>
          )}

          {/* O outro lado da conta do garçom. Ele vê o dia a dia do que tem a
              receber; o dono precisa ver o dia a dia do que a loja arrecadou —
              senão o número da véspera some à meia-noite e não volta. */}
          <button type="button" onClick={abrirTaxaDias}
            style={{
              marginTop: 10, padding: 0, border: 'none', background: 'none', cursor: 'pointer',
              color: 'var(--primary)', fontSize: 12.5, fontWeight: 700,
            }}>
            {taxaDiasAberto ? '▲ esconder os outros dias' : '▼ ver os outros dias'}
          </button>

          {taxaDiasAberto && (
            <div style={{
              marginTop: 8, padding: '10px 12px', borderRadius: 10,
              background: 'var(--surface-hover)', border: '1px solid var(--border)',
            }}>
              {taxaDias === 'carregando' ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Somando os dias…</div>
              ) : !taxaDias?.length ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nenhuma taxa arrecadada nos últimos 30 dias.</div>
              ) : (
                <>
                  <div style={{ display: 'flex', fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: .4, paddingBottom: 6 }}>
                    <span style={{ flex: 1 }}>Dia</span>
                    <span style={{ width: 78, textAlign: 'right' }}>Taxa</span>
                    <span style={{ width: 78, textAlign: 'right' }}>Garçons</span>
                    <span style={{ width: 78, textAlign: 'right' }}>Loja</span>
                  </div>
                  {taxaDias.map(d => (
                    <div key={d.dia} style={{
                      display: 'flex', alignItems: 'baseline', padding: '7px 0',
                      borderTop: '1px dashed var(--border)', fontSize: 12.5,
                    }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <strong>{diaDaSemana(d.dia)}</strong>
                        <span style={{ color: 'var(--text-muted)' }}> · {d.contas} conta(s)</span>
                      </span>
                      <span style={{ width: 78, textAlign: 'right' }}>{fmt(d.taxa)}</span>
                      <span style={{ width: 78, textAlign: 'right', color: 'var(--success)' }}>{fmt(d.garcons)}</span>
                      <span style={{ width: 78, textAlign: 'right', fontWeight: 700 }}>{fmt(d.loja)}</span>
                    </div>
                  ))}
                  <div style={{
                    display: 'flex', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
                    fontSize: 12.5, fontWeight: 800,
                  }}>
                    <span style={{ flex: 1 }}>Total dos {taxaDias.length} dia(s)</span>
                    <span style={{ width: 78, textAlign: 'right' }}>{fmt(taxaDias.reduce((s, d) => s + Number(d.taxa || 0), 0))}</span>
                    <span style={{ width: 78, textAlign: 'right', color: 'var(--success)' }}>{fmt(taxaDias.reduce((s, d) => s + Number(d.garcons || 0), 0))}</span>
                    <span style={{ width: 78, textAlign: 'right' }}>{fmt(taxaDias.reduce((s, d) => s + Number(d.loja || 0), 0))}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.45 }}>
                    Últimos 30 dias, contando só os dias que tiveram taxa. A coluna
                    <strong> Garçons</strong> é o bolo daquele dia — o mesmo que aparece no
                    dia a dia de cada um.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pontos do dia (mig 0187).
          Era uma tabela de 5 colunas — no celular virava um amontoado de números
          espremidos. Agora o garçom vê um cartão com o número dele grande e três
          blocos, e o dono vê uma lista de linhas, sem tabela. */}
      {ranking.length > 0 && (() => {
        const temBolo = bolo > 0 && pontosDaLoja > 0

        const bloco = (n, lbl, icone) => (
          <div key={lbl} style={{
            flex: 1, minWidth: 0, textAlign: 'center', padding: '10px 4px',
            borderRadius: 10, background: 'var(--surface-hover)', border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.1 }}>{n}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap' }}>{icone} {lbl}</div>
          </div>
        )

        return (
          <div style={{ marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* ── Garçom: o número dele, grande ── */}
            {!ehAdmin && ranking.map(r => (
              <div key={r.id} className="card" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Seus pontos hoje</div>
                <div style={{ fontSize: 46, fontWeight: 900, lineHeight: 1.05, color: 'var(--primary)' }}>{r.pontos}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  {bloco(r.lancou, 'lançou', '✍️')}
                  {bloco(r.entregou, 'entregou', '🍽️')}
                  {bloco(r.fechou, 'fechou', '🧾')}
                </div>
                {temBolo && (
                  <div style={{
                    marginTop: 12, padding: '10px 12px', borderRadius: 10, display: 'flex',
                    alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    background: 'rgba(16,185,129,.10)', border: '1px solid rgba(16,185,129,.35)',
                  }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'left' }}>
                      {r.pontos} pontos × {fmt(valorPorPonto)} por ponto
                    </span>
                    <strong style={{ fontSize: 19, color: 'var(--success)', whiteSpace: 'nowrap' }}>{fmt(ganhoDe(r))}</strong>
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                  Lançar item vale {pontosCfg.lancar}, entregar vale {pontosCfg.entregar} e fechar conta
                  vale {pontosCfg.fechar}.
                  {temBolo && (
                    <> A loja separa {rateioPct}% da taxa de serviço do dia ({fmt(bolo)} até agora) e divide
                    entre todos pelos pontos. Hoje a equipe fez {pontosDaLoja} pontos, então cada ponto
                    está valendo {fmt(valorPorPonto)} — esse valor muda até o fim do expediente.</>
                  )}
                </div>
              </div>
            ))}

            {/* ── Dono: lista, uma linha por garçom ── */}
            {ehAdmin && (
              <div className="card">
                <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>🏆 Pontos por garçom (hoje)</div>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.45 }}>
                  Conta gesto por gesto, não mesa por mesa — assim qualquer um atende qualquer mesa
                  sem perder o crédito do que fez.
                </p>

                {ranking.map((r, i) => (
                  <div key={r.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                  }}>
                    <span style={{ fontSize: 17, width: 26, textAlign: 'center', flexShrink: 0 }}>
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}º`}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {garcons[r.id] ?? 'Garçom'}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                        ✍️ {r.lancou} · 🍽️ {r.entregou} · 🧾 {r.fechou}
                        {temBolo && (ehDaEquipe(r.id)
                          ? <> · <span style={{ color: 'var(--success)', fontWeight: 700 }}>{fmt(ganhoDe(r))}</span></>
                          : <> · <span style={{ fontWeight: 700 }}>não divide (loja)</span></>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1 }}>{r.pontos}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>pontos</div>
                    </div>
                  </div>
                ))}

                {temBolo ? (
                  <div style={{ paddingTop: 10, marginTop: 4, borderTop: '1px dashed var(--border)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 800, fontSize: 13.5 }}>
                      <span>Bolo do dia ({rateioPct}% de {fmt(taxaDoDia)} de taxa)</span>
                      <span style={{ color: 'var(--success)', whiteSpace: 'nowrap' }}>{fmt(bolo)}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                      {pontosDaLoja} pontos da equipe · cada ponto vale {fmt(valorPorPonto)}
                      {' '}(ponto de ADM não conta aqui)
                    </div>
                  </div>
                ) : Number(rateioPct) > 0 && (
                  <div style={{ paddingTop: 10, marginTop: 4, borderTop: '1px dashed var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                    Ainda não há taxa arrecadada hoje — o bolo aparece quando a primeira conta fechar.
                  </div>
                )}
              </div>
            )}

            {/* ── A receber: acumula até o dono pagar (mig 0230) ──
                O ranking de cima é do DIA e zera de madrugada. Este não zera:
                soma dia a dia desde o último acerto de cada um, porque o dono
                não paga toda noite. */}
            {acumulado.length > 0 && (
              <div className="card">
                <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>💰 A receber (acumulado)</div>
                <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.45 }}>
                  Vai somando todo dia e só zera quando você paga. Cada dia entra com o bolo daquele
                  dia — dia parado rende pouco, dia cheio rende mais.
                </p>
                {acumulado.map(a => (
                  <Fragment key={a.garcom_id}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
                      borderTop: '1px solid var(--border)',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{a.nome}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                          {a.pontos} pontos · {a.dias} dia(s) · desde {dataCurta(a.desde)}
                        </div>
                        {/* Um número só é o que o garçom tem que aceitar de olhos
                            fechados. Aqui ele abre e confere dia por dia — é o
                            que a semana de pagamento pede. */}
                        <button type="button" onClick={() => abrirExtrato(a.garcom_id)}
                          style={{
                            marginTop: 6, padding: 0, border: 'none', background: 'none', cursor: 'pointer',
                            color: 'var(--primary)', fontSize: 12, fontWeight: 700,
                          }}>
                          {extratoAberto === a.garcom_id ? '▲ esconder o dia a dia' : '▼ ver dia a dia'}
                        </button>
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: 'var(--success)', whiteSpace: 'nowrap' }}>
                        {fmt(a.valor)}
                      </div>
                      {ehAdmin && (
                        <button type="button" disabled={pagando === a.garcom_id || Number(a.valor) <= 0}
                          onClick={() => pagarGarcom(a)}
                          style={{
                            flexShrink: 0, padding: '8px 12px', borderRadius: 9, fontWeight: 800, fontSize: 12.5,
                            cursor: Number(a.valor) > 0 ? 'pointer' : 'default',
                            opacity: Number(a.valor) > 0 ? 1 : .4,
                            border: '1.5px solid var(--success)', background: 'transparent', color: 'var(--success)',
                          }}>
                          {pagando === a.garcom_id ? '...' : '✅ Paguei'}
                        </button>
                      )}
                    </div>

                    {extratoAberto === a.garcom_id && (
                      <div style={{
                        margin: '0 0 10px', padding: '10px 12px', borderRadius: 10,
                        background: 'var(--surface-hover)', border: '1px solid var(--border)',
                      }}>
                        {extrato === 'carregando' ? (
                          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Somando os dias…</div>
                        ) : !extrato?.length ? (
                          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nenhum dia ainda neste período.</div>
                        ) : (
                          <>
                            {extrato.map(d => (
                              <div key={d.dia} style={{
                                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                                gap: 8, padding: '7px 0', borderTop: '1px dashed var(--border)',
                              }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700 }}>{diaDaSemana(d.dia)}</div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    {d.pontos} de {Number(d.pts_equipe)} pontos da equipe · bolo {fmt(d.bolo_dia)}
                                  </div>
                                </div>
                                <strong style={{ fontSize: 14.5, color: 'var(--success)', whiteSpace: 'nowrap' }}>
                                  {fmt(d.valor)}
                                </strong>
                              </div>
                            ))}
                            <div style={{
                              display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8, paddingTop: 8,
                              borderTop: '1px solid var(--border)', fontSize: 13, fontWeight: 800,
                            }}>
                              <span>Soma dos {extrato.length} dia(s)</span>
                              <span>{fmt(extrato.reduce((s, d) => s + Number(d.valor || 0), 0))}</span>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </Fragment>
                ))}
                {ehAdmin && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.45 }}>
                    O "Paguei" só marca aqui que você acertou com ele — não mexe no caixa. A partir do
                    dia seguinte a conta dele recomeça do zero.
                  </div>
                )}
              </div>
            )}

            {/* ── Dono: quanto vale cada gesto ── */}
            {ehAdmin && (
              <div className="card">
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Quanto vale cada gesto</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[['lancar', '✍️ Lançar item'], ['entregar', '🍽️ Entregar item'], ['fechar', '🧾 Fechar conta']].map(([k, lbl]) => (
                    <label key={k} style={{
                      flex: '1 1 140px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8, padding: '9px 11px', borderRadius: 10,
                      background: 'var(--surface-hover)', border: '1px solid var(--border)',
                      fontSize: 12.5, color: 'var(--text-muted)',
                    }}>
                      <span style={{ whiteSpace: 'nowrap' }}>{lbl}</span>
                      <input type="number" min="0" max="99" step="1" value={pontosCfg[k]}
                        onChange={e => setPontosCfg(p => ({ ...p, [k]: e.target.value }))}
                        onBlur={e => salvarPontos(k, e.target.value)}
                        style={{ width: 48, padding: '5px 6px', borderRadius: 7, textAlign: 'center', fontWeight: 800,
                          border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                    </label>
                  ))}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12, fontSize: 12.5, color: 'var(--text-muted)' }}>
                  Quanto da <strong style={{ color: 'var(--text)' }}>taxa de serviço</strong> vai pros garçons (0 = não usa)
                  <input type="number" min="0" max="100" step="1" value={rateioPct}
                    onChange={e => setRateioPct(e.target.value)} onBlur={e => salvarRateio(e.target.value)}
                    style={{ width: 64, padding: '5px 8px', borderRadius: 8, textAlign: 'center', fontWeight: 800, flexShrink: 0,
                      border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }} />
                </label>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                  É uma fatia do que a loja JÁ arrecadou de taxa — o bolo nunca estoura. Se a equipe
                  trabalhar mais, o ponto vale menos e a loja paga o mesmo; em dia fraco, paga menos.
                  {Number(rateioPct) > 0 && (
                    <> Hoje a loja arrecadou {fmt(taxaDoDia)} de taxa, então {rateioPct}% dá
                    <strong style={{ color: 'var(--success)' }}> {fmt(bolo)}</strong> pra dividir.</>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {comandas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          {ehAdmin ? 'Nenhuma conta fechada ainda. Feche uma conta no Salão que ela aparece aqui. 🧾' : 'Você ainda não teve mesa fechada. Assim que fechar, ela aparece aqui. 🧾'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {comandas.map(c => {
            const expandida = aberta === c.id
            return (
              <div key={c.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <button type="button" onClick={() => setAberta(expandida ? null : c.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {c.numero_mesa ? rotuloComanda(c) : 'Balcão'}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {horaBR(c.fechada_at)} · {FORMA_LABEL[c.forma_pagamento] ?? c.forma_pagamento ?? '—'}
                      {cobrancasOnlinePagas(c).length > 0 && (
                        <span title="Recebido pelo QR do Mercado Pago"
                          style={{ marginLeft: 5, padding: '1px 6px', borderRadius: 20, fontSize: 10,
                            fontWeight: 800, background: 'rgba(34,197,94,.16)', color: '#22c55e',
                            border: '1px solid rgba(34,197,94,.45)' }}>
                          online
                        </span>
                      )}
                      {' · '}{(c.comanda_itens ?? []).length} {(c.comanda_itens ?? []).length === 1 ? 'item' : 'itens'}
                    </div>
                    {/* Quanto ele ganhou nesta mesa. É a pergunta que o garçom
                        faz olhando o histórico — o total do dia não responde
                        "e nessa mesa aqui, quanto eu tirei?". */}
                    {pontosNaConta(c) > 0 && (
                      <div style={{ fontSize: 12.5, color: 'var(--primary)', fontWeight: 700, marginTop: 1 }}>
                        ✨ {ehAdmin ? 'pontos nesta mesa' : 'seus pontos aqui'}: {pontosNaConta(c)}
                      </div>
                    )}
                    {(c.garcom_id || c.fechada_por) && (
                      <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600 }}>
                        {c.garcom_id && garcons[c.garcom_id] && <>👤 abriu: {garcons[c.garcom_id]}</>}
                        {c.garcom_id && garcons[c.garcom_id] && c.fechada_por && garcons[c.fechada_por] && ' · '}
                        {c.fechada_por && garcons[c.fechada_por] && <>🧾 fechou: {garcons[c.fechada_por]}</>}
                      </div>
                    )}
                    {c.cliente && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>
                        🧑 Cliente: {c.cliente.nome}{c.cliente.telefone ? ` · ${c.cliente.telefone}` : ''}
                      </div>
                    )}
                  </div>
                  <strong style={{ fontSize: 16 }}>{fmt(c.total)}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{expandida ? '▲' : '▼'}</span>
                </button>

                {expandida && (
                  <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border)' }}>
                    {(c.comanda_itens ?? []).map(it => (
                      <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                        <div>
                          <div style={{ fontSize: 13.5 }}>{it.quantidade}× {it.nome}</div>
                          {it.observacao && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>📝 {it.observacao}</div>}
                          {/* A trilha de quem fez o quê. Estava só no banco: quando o
                              cliente contestava um item na hora de pagar, a resposta
                              existia mas ninguém conseguia olhar. Agora está na linha
                              do próprio item — que é onde a pergunta nasce. */}
                          {(it.lancado_por || it.entregue_por) && (
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                              {it.lancado_por && <>✍️ lançou: {garcons[it.lancado_por] ?? '—'}</>}
                              {it.lancado_por && it.entregue_por && ' · '}
                              {it.entregue_por && <>🍽️ entregou: {garcons[it.entregue_por] ?? '—'}</>}
                            </div>
                          )}
                        </div>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(it.preco_unitario * it.quantidade)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, paddingTop: 8, color: 'var(--text-muted)' }}>
                      <span>Subtotal</span><span>{fmt(c.subtotal)}</span>
                    </div>
                    {Number(c.taxa_servico) > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)' }}>
                        <span>Taxa de serviço</span><span>{fmt(c.taxa_servico)}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 800, paddingTop: 6 }}>
                      <span>Total</span><span>{fmt(c.total)}</span>
                    </div>

                    {/* Forma de pagamento — mostra e deixa corrigir se lançou errado */}
                    <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-hover)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13.5 }}>
                          💳 Pagamento: <strong>{formaComOrigem(c)}</strong>
                        </span>
                        {ehAdmin && editandoForma !== c.id && cobrancasOnlinePagas(c).length === 0 && (
                          <button type="button" onClick={() => setEditandoForma(c.id)}
                            style={{ padding: '5px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)',
                              background: 'transparent', color: 'var(--primary)', fontSize: 12.5, fontWeight: 700 }}>
                            Trocar
                          </button>
                        )}
                      </div>

                      {/* O número do pagamento no Mercado Pago. É por ele que a
                          loja acha essa venda no extrato do MP quando o valor
                          bate em duas contas do mesmo dia — e é o que prova de
                          onde veio o dinheiro. Trocar a forma some quando é
                          online: não é lançamento à mão, tem comprovante. */}
                      {cobrancasOnlinePagas(c).map(cb => (
                        <div key={cb.id} style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                          🟢 Recebido no Mercado Pago · {fmt(cb.valor)} · pagamento <code>{cb.mp_payment_id}</code>
                        </div>
                      ))}

                      {editandoForma === c.id && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Escolha a forma correta:</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {FORMAS_EDIT.map(([id, lbl]) => (
                              <button key={id} type="button" disabled={salvandoForma} onClick={() => trocarForma(c, id)}
                                style={{ padding: '7px 12px', borderRadius: 8, cursor: salvandoForma ? 'wait' : 'pointer', fontWeight: 700, fontSize: 13,
                                  border: `1.5px solid ${c.forma_pagamento === id ? 'var(--primary)' : 'var(--border)'}`,
                                  background: c.forma_pagamento === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                                {lbl}
                              </button>
                            ))}
                            <button type="button" onClick={() => setEditandoForma(null)}
                              style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)' }}>
                              Cancelar
                            </button>
                          </div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                            Fiado precisa de um cliente ligado à conta (é dívida, não entra no caixa).
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Segunda via: NÃO é só do dono. Quem fica sem o papel é
                        quem fechou a conta — em geral o garçom, com a térmica
                        dele caindo do Bluetooth na hora errada. */}
                    <button type="button" onClick={() => imprimirSegundaVia(c)} disabled={imprimindo === c.id}
                      style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10,
                        cursor: imprimindo === c.id ? 'wait' : 'pointer',
                        border: '1px solid var(--border)', background: 'transparent',
                        color: 'var(--text)', fontSize: 13.5, fontWeight: 700 }}>
                      {imprimindo === c.id ? 'Enviando…' : '🖨️ Imprimir segunda via'}
                    </button>
                    {impMsg?.id === c.id && (
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>{impMsg.texto}</div>
                    )}

                    {/* Ligar/trocar o cliente deste pedido já fechado — mexe em fiado
                        e no cadastro, então é coisa de dono. */}
                    {ehAdmin && (
                    <button type="button" onClick={() => setPickerComanda(c)}
                      style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
                        border: `1.5px ${c.cliente ? 'solid var(--border)' : 'dashed var(--primary)'}`,
                        background: c.cliente ? 'transparent' : 'rgba(124,58,237,.06)',
                        color: c.cliente ? 'var(--text)' : 'var(--primary)', fontSize: 13.5, fontWeight: 700 }}>
                      {c.cliente ? `🧑 ${c.cliente.nome} · trocar cliente` : '➕ Ligar cliente a este pedido'}
                    </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {pickerComanda && (
        <ClientePicker
          empresaId={empresaId}
          titulo={pickerComanda.numero_mesa ? `Cliente da ${rotuloComanda(pickerComanda, { comNome: false })}` : 'Cliente do pedido'}
          permitirTirar={!!pickerComanda.cliente}
          onPick={(cli) => ligarCliente(pickerComanda, cli)}
          onFechar={() => setPickerComanda(null)}
        />
      )}
    </div>
  )
}
