import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabaseClient'
import BuscaSelect from '../components/BuscaSelect'
import LancarNotaIA from '../components/LancarNotaIA'
import { useAuth } from '../hooks/useAuth'
import { semanaDe, rotuloSemana, offsetDaSemana } from '../lib/semana'
import '../components/Page.css'

// Normaliza pra busca: tira acento e deixa minúsculo. Assim "feijao" acha "Feijão".
const normTxt = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

// ── Unidades e conversão ──────────────────────────────────────────────
// Tudo é convertido pra uma "unidade base" (grama / ml / unidade) pra poder
// somar e dividir sem erro. Peso e volume usam o mesmo fator (x1000), então
// kg↔g e L↔ml funcionam igual. O importante é a loja não misturar peso com
// volume na MESMA matéria-prima (ex.: cadastrar farinha em kg e usar em ml).
const UNIDADES = ['kg', 'g', 'L', 'ml', 'un']
const FATOR = { kg: 1000, g: 1, L: 1000, ml: 1, un: 1 }
const emBase = (qtd, unidade) => Number(qtd || 0) * (FATOR[unidade] || 1)
// Custo por 1 unidade base (grama/ml/un) de uma matéria-prima.
const custoBase = (mp) => Number(mp?.custo || 0) / (FATOR[mp?.unidade] || 1)

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// ── Trio da compra: quantidade × preço por unidade = total pago ──
// Os campos guardam TEXTO, não número. Guardar número quebrava a digitação de
// "5,66": ao teclar a vírgula o valor virava 5 e a vírgula sumia.
const numOuNulo = (s) => {
  const v = Number(String(s ?? '').replace(',', '.'))
  return Number.isFinite(v) && v > 0 ? v : null
}
const txtNum = (v, casas) => String(Math.round(v * 10 ** casas) / 10 ** casas).replace('.', ',')
// Sabendo dois dos três, o terceiro sai sozinho. Recalcula sempre o campo que
// foi mexido HÁ MAIS TEMPO — assim o número que a pessoa acabou de digitar
// nunca é reescrito na cara dela. Digitou "paguei 17" com o preço do quilo
// cadastrado? Ele responde quantos quilos vieram.
const ORDEM_PADRAO = ['unit', 'qtd', 'total']
function recalcTrio(linha, campoEditado) {
  const ordem = [campoEditado, ...(linha.ordem || ORDEM_PADRAO).filter(c => c !== campoEditado)]
  const alvo = ordem[2]
  const q = numOuNulo(linha.qtdTxt)
  const u = numOuNulo(linha.unitTxt)
  const t = numOuNulo(linha.totalTxt)
  const out = { ...linha, ordem }
  if (alvo === 'total' && q && u) out.totalTxt = txtNum(q * u, 2)
  if (alvo === 'unit' && q && t) out.unitTxt = txtNum(t / q, 2)
  if (alvo === 'qtd' && u && t) out.qtdTxt = txtNum(t / u, 3)
  return out
}
// Valores muito pequenos (custo por grama) — mostra mais casas pra não virar R$0,00.
const brl4 = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
// Mostra a quantidade de um jeito amigável: 2000 g vira "2 kg", 1500 ml vira "1,5 L".
const fmtQtd = (qtd, unid) => {
  const n = Number(qtd || 0)
  if (unid === 'g' && n >= 1000) return (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + ' kg'
  if (unid === 'ml' && n >= 1000) return (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + ' L'
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + ' ' + unid
}

// Custo de uma linha de ingrediente (quantidade usada × custo por unidade base).
// A linha pode ser um insumo comprado (custo_unit gravado) ou uma SUB-RECEITA —
// nesse caso o custo vem da ficha de baixo, calculada na hora, pra receita de
// cima acompanhar quando o preço da farinha muda lá embaixo.
const custoItem = (it, custoDeFicha) => {
  const unit = (it.ficha_ref_id && custoDeFicha) ? custoDeFicha(it.ficha_ref_id) : Number(it.custo_unit || 0)
  return emBase(it.quantidade, it.unidade) * unit
}

// Calcula tudo de uma ficha: custo total, custo por porção e margem.
// precoVenda vem do que estiver vinculado (produto do catálogo OU complemento).
function calcularFicha(ficha, itens, precoVenda = 0, custoDeFicha = null) {
  const custoTotal = (itens || []).reduce((s, it) => s + custoItem(it, custoDeFicha), 0)
  const rendBase = emBase(ficha.rendimento, ficha.unid_rendimento)
  const custoPorBase = rendBase > 0 ? custoTotal / rendBase : 0
  const porcaoBase = emBase(ficha.peso_porcao, ficha.unid_porcao)
  const custoPorcao = custoPorBase * porcaoBase
  const preco = Number(precoVenda || 0)
  const temVenda = preco > 0
  const lucro = temVenda ? preco - custoPorcao : 0
  const margemPct = temVenda ? (lucro / preco) * 100 : 0
  return { custoTotal, custoPorBase, custoPorcao, precoVenda: preco, temVenda, lucro, margemPct }
}

// Descobre o vínculo de uma ficha (produto ou complemento) já com nome e preço.
function vinculoDe(f) {
  if (f.produtos) return { tipo: 'produto', nome: f.produtos.nome, preco: Number(f.produtos.preco_venda || 0) }
  if (f.complemento_opcoes) return { tipo: 'complemento', nome: f.complemento_opcoes.nome, preco: Number(f.complemento_opcoes.preco_adicional || 0) }
  return null
}

// Uma ficha usa outra? (em qualquer nível). Serve pra não deixar a Massa entrar
// na Coxinha e a Coxinha entrar na Massa — o custo ficaria rodando em círculo.
function fichaUsa(id, alvo, itensPorFicha, vistos = new Set()) {
  if (id === alvo) return true
  if (vistos.has(id)) return false
  vistos.add(id)
  return (itensPorFicha[id] || []).some(it => it.ficha_ref_id && fichaUsa(it.ficha_ref_id, alvo, itensPorFicha, vistos))
}

const emptyMateria = { nome: '', unidade: 'kg', custo: '', ativo: true, quantidade: '', pago: '' }
const linhaVazia = () => ({ materia_prima_id: '', ficha_ref_id: '', nome: '', quantidade: '', unidade: 'g', custo_unit: 0 })
const emptyFicha = {
  nome: '', produto_id: '', complemento_opcao_id: '', rendimento: '', unid_rendimento: 'g',
  peso_porcao: '', unid_porcao: 'g', observacoes: '', itens: [linhaVazia()],
}

const stepBtn = { width: 28, height: 28, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 16, lineHeight: 1, flexShrink: 0 }

export default function FichaTecnica() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null

  // Aba fica no LINK (?aba=materias) pra sobreviver a refresh / sair e voltar.
  const [searchParams, setSearchParams] = useSearchParams()
  const abaUrl = searchParams.get('aba')
  const aba = abaUrl === 'materias' || abaUrl === 'compras' ? abaUrl : 'fichas'
  const setAba = (v) => setSearchParams(
    (p) => { const n = new URLSearchParams(p); n.set('aba', v); return n },
    { replace: true },
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [materias, setMaterias] = useState([])
  const [fichas, setFichas] = useState([])
  const [itensPorFicha, setItensPorFicha] = useState({}) // ficha_id -> [itens]
  const [produtos, setProdutos] = useState([])
  const [complementos, setComplementos] = useState([]) // opções de complemento (com grupo)

  // modais
  const [showMateria, setShowMateria] = useState(false)
  const [materiaForm, setMateriaForm] = useState(emptyMateria)
  const [materiaEdit, setMateriaEdit] = useState(null)
  const [salvandoMateria, setSalvandoMateria] = useState(false)
  const [buscaMateria, setBuscaMateria] = useState('')

  // Estoque das matérias-primas
  const [saldoMat, setSaldoMat] = useState({})   // materia_prima_id -> quantidade_atual
  const [saldoProd, setSaldoProd] = useState({}) // produto_id -> quantidade_atual
  const [showMov, setShowMov] = useState(false)
  const [movMateria, setMovMateria] = useState(null)
  const [movTipo, setMovTipo] = useState('entrada') // 'entrada' | 'saida' | 'ajuste'
  // Quantidade, preço por unidade e total pago da compra. Preencheu dois, o
  // terceiro sai sozinho. O valor fica na linha do movimento, que ninguém
  // reescreve depois — é isso que dá o histórico "no dia 17/08 gastei tanto".
  const [movTrio, setMovTrio] = useState({ qtdTxt: '', unitTxt: '', totalTxt: '', ordem: ORDEM_PADRAO })
  const [movAtualizaCusto, setMovAtualizaCusto] = useState(true)
  const [savingMov, setSavingMov] = useState(false)
  const saldoDe = (id) => Number(saldoMat[id] ?? 0)

  // Carrinho rápido (mesma tela pra dar BAIXA ou ENTRADA em vários insumos de uma vez).
  const [showBaixa, setShowBaixa] = useState(false)
  const [cartTipo, setCartTipo] = useState('saida') // 'saida' (baixa) | 'entrada'
  const [baixaBusca, setBaixaBusca] = useState('')
  const [baixaCart, setBaixaCart] = useState([]) // [{ id, nome, unidade, qtd, pago }]
  const [cartAtualizaCusto, setCartAtualizaCusto] = useState(true)
  const [salvandoBaixa, setSalvandoBaixa] = useState(false)

  // ── Aba COMPRAS: o histórico do que ENTROU (insumo e produto de revenda) ──
  // O saldo só diz quanto tem hoje; aqui fica o "de onde veio" — dia, item,
  // quantidade e quanto foi pago, que agora vive na própria linha do movimento.
  const hojeYMD = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const [compraDe, setCompraDe] = useState(hojeYMD)
  const [compraAte, setCompraAte] = useState(hojeYMD)
  const [compras, setCompras] = useState([])
  const [loadingCompras, setLoadingCompras] = useState(false)
  // Dia aberto na lista. Nasce tudo recolhido: num dia de feira dá 20+ linhas e
  // quem só quer saber o total do dia não precisa rolar tudo isso.
  const [diaAberto, setDiaAberto] = useState(null)

  const [showFicha, setShowFicha] = useState(false)
  const [fichaForm, setFichaForm] = useState(emptyFicha)
  const [fichaEdit, setFichaEdit] = useState(null)
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setLoading(true)
    setError(null)
    try {
      const [mp, fi, it, pr, cp, sm, sp] = await Promise.all([
        supabase.from('materias_primas').select('*').eq('empresa_id', empresaId).order('nome'),
        supabase.from('fichas_tecnicas').select('*, produtos(id, nome, preco_venda), complemento_opcoes(id, nome, preco_adicional)').eq('empresa_id', empresaId).order('nome'),
        supabase.from('ficha_itens').select('*').eq('empresa_id', empresaId),
        fetchAll(() => supabase.from('produtos').select('id, nome, preco_venda, preco_custo, controla_estoque').eq('empresa_id', empresaId).eq('ativo', true).order('nome').order('id')),
        supabase.from('complemento_opcoes').select('id, nome, preco_adicional, complemento_grupos!inner(nome, empresa_id)').eq('complemento_grupos.empresa_id', empresaId).order('nome'),
        supabase.from('materia_prima_saldo').select('materia_prima_id, quantidade_atual'),
        // Saldo dos produtos de revenda: o carrinho de entrada aceita os dois.
        supabase.from('estoque_saldo').select('produto_id, quantidade_atual'),
      ])
      if (mp.error) throw mp.error
      if (fi.error) throw fi.error
      if (it.error) throw it.error
      if (pr.error) throw pr.error
      if (cp.error) throw cp.error
      setMaterias(mp.data || [])
      setFichas(fi.data || [])
      setProdutos(pr.data || [])
      setComplementos((cp.data || []).map(c => ({ id: c.id, nome: c.nome, preco: Number(c.preco_adicional || 0), grupo: c.complemento_grupos?.nome || '' })))
      setSaldoMat(Object.fromEntries((sm.data || []).map(r => [r.materia_prima_id, Number(r.quantidade_atual || 0)])))
      setSaldoProd(Object.fromEntries((sp.data || []).map(r => [r.produto_id, Number(r.quantidade_atual || 0)])))
      const grupos = {}
      for (const linha of (it.data || [])) {
        (grupos[linha.ficha_id] = grupos[linha.ficha_id] || []).push(linha)
      }
      setItensPorFicha(grupos)
    } catch (e) {
      setError(e.message || 'Erro ao carregar')
    } finally {
      setLoading(false)
    }
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  // Busca as entradas do período nas DUAS tabelas (insumo e produto) e junta
  // numa lista só, da mais nova pra mais velha.
  const carregarCompras = useCallback(async () => {
    if (!empresaId) return
    setLoadingCompras(true)
    const ini = new Date(`${compraDe}T00:00:00`)
    const fim = new Date(`${compraAte}T00:00:00`)
    fim.setDate(fim.getDate() + 1)   // o "até" entra inteiro
    const [mp, pr] = await Promise.all([
      supabase.from('materia_prima_movimentos')
        .select('id, created_at, quantidade, custo_unit, valor_total, observacao, materias_primas(nome, unidade)')
        .eq('empresa_id', empresaId).eq('tipo', 'entrada')
        .gte('created_at', ini.toISOString()).lt('created_at', fim.toISOString())
        .order('created_at', { ascending: false }),
      supabase.from('estoque_movimentos')
        .select('id, created_at, quantidade, custo_unit, valor_total, observacao, motivo, produtos(nome)')
        .eq('empresa_id', empresaId).eq('tipo', 'entrada')
        .gte('created_at', ini.toISOString()).lt('created_at', fim.toISOString())
        .order('created_at', { ascending: false }),
    ])
    const lista = [
      ...(mp.data || []).map(r => ({
        id: 'mp:' + r.id, quando: r.created_at, origem: 'insumo',
        nome: r.materias_primas?.nome || '(insumo apagado)', unidade: r.materias_primas?.unidade || '',
        quantidade: Number(r.quantidade || 0), custo_unit: r.custo_unit, valor_total: r.valor_total,
        observacao: r.observacao, motivo: null,
      })),
      ...(pr.data || []).map(r => ({
        id: 'pr:' + r.id, quando: r.created_at, origem: 'produto',
        nome: r.produtos?.nome || '(produto apagado)', unidade: 'un',
        quantidade: Number(r.quantidade || 0), custo_unit: r.custo_unit, valor_total: r.valor_total,
        observacao: r.observacao, motivo: r.motivo,
      })),
    ].sort((a, b) => (a.quando < b.quando ? 1 : -1))
    setCompras(lista)
    setLoadingCompras(false)
  }, [empresaId, compraDe, compraAte])

  useEffect(() => { if (aba === 'compras') carregarCompras() }, [aba, carregarCompras])

  // Agrupa por dia e soma o que foi pago (linha sem valor entra como zero no total,
  // mas a tela avisa que ela existe pra ninguém achar que gastou menos).
  const comprasPorDia = useMemo(() => {
    const dias = new Map()
    for (const c of compras) {
      const chave = new Date(c.quando).toLocaleDateString('pt-BR')
      if (!dias.has(chave)) dias.set(chave, { dia: chave, itens: [], total: 0, semValor: 0 })
      const g = dias.get(chave)
      g.itens.push(c)
      if (c.valor_total != null) g.total += Number(c.valor_total)
      else g.semValor++
    }
    return [...dias.values()]
  }, [compras])
  const totalPeriodo = useMemo(
    () => compras.reduce((s, c) => s + Number(c.valor_total || 0), 0),
    [compras],
  )
  const semValorPeriodo = useMemo(() => compras.filter(c => c.valor_total == null).length, [compras])

  // Apagar uma entrada lançada errado. O saldo é a soma dos movimentos, então
  // tirar a linha já devolve o estoque pro que era antes — não precisa de acerto.
  const [apagando, setApagando] = useState(null)
  async function apagarEntrada(c) {
    const quanto = c.valor_total != null ? ` (${brl(c.valor_total)})` : ''
    if (!confirm(
      `Apagar esta entrada?\n\n${c.nome} · ${fmtQtd(c.quantidade, c.unidade)}${quanto}\n` +
      `Lançada em ${new Date(c.quando).toLocaleString('pt-BR')}.\n\n` +
      `O estoque volta ao que era antes desse lançamento.`
    )) return
    const [tipo, id] = c.id.split(':')
    setApagando(c.id)
    const tabela = tipo === 'mp' ? 'materia_prima_movimentos' : 'estoque_movimentos'
    const { error } = await supabase.from(tabela).delete().eq('id', id)
    setApagando(null)
    if (error) { alert('Não deu pra apagar: ' + error.message); return }
    carregarCompras()
    carregar()   // o saldo da lista de insumos muda junto
  }

  // Semana a semana, como no histórico de despesas e no caixa: as setas andam
  // e o período segue junto. Quem escolhe data na mão sai do modo semana — aí
  // o rótulo some, senão diria "esta semana" mostrando outro intervalo.
  function irParaSemana(offset) {
    const { inicio, fim } = semanaDe(offset)
    setCompraDe(inicio)
    setCompraAte(fim)
  }
  // Só é "semana cheia" quando as duas pontas batem com segunda e domingo.
  const semanaAtualSel = (() => {
    const off = offsetDaSemana(compraDe)
    const s = semanaDe(off)
    return (s.inicio === compraDe && s.fim === compraAte) ? off : null
  })()

  // Atalhos de período (o dono não quer digitar data).
  function periodoRapido(qual) {
    const d = new Date()
    const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
    if (qual === 'hoje') { setCompraDe(ymd(d)); setCompraAte(ymd(d)); return }
    if (qual === '7') { const a = new Date(d); a.setDate(a.getDate() - 6); setCompraDe(ymd(a)); setCompraAte(ymd(d)); return }
    if (qual === 'mes') { setCompraDe(ymd(new Date(d.getFullYear(), d.getMonth(), 1))); setCompraAte(ymd(d)) }
  }

  // ── Matérias-primas ──────────────────────────────────────────────
  // Avisa (em vermelho) se já existe uma matéria-prima com esse nome — ignorando
  // acento e maiúscula, então "Creme de Leite" acha "creme de leite".
  const materiaRepetida = useMemo(() => {
    const q = normTxt(materiaForm.nome)
    if (!q) return null
    return materias.find(m => normTxt(m.nome) === q && m.id !== materiaEdit?.id) || null
  }, [materiaForm.nome, materias, materiaEdit])

  // Preço por unidade da compra que está sendo cadastrada (pagou ÷ quantidade).
  const materiaUnit = useMemo(() => {
    const qtd = Number(String(materiaForm.quantidade ?? '').replace(',', '.'))
    const pago = Number(String(materiaForm.pago ?? '').replace(',', '.'))
    if (!(qtd > 0) || !(pago > 0)) return null
    return pago / qtd
  }, [materiaForm.quantidade, materiaForm.pago])

  // Busca da lista: sem acento e sem maiúscula, então "feijao" acha "Feijão".
  const materiasFiltradas = useMemo(() => {
    const q = normTxt(buscaMateria)
    return q ? materias.filter(m => normTxt(m.nome).includes(q)) : materias
  }, [materias, buscaMateria])

  function abrirNovaMateria(nome) {
    // Chamada direta no onClick manda o evento do clique — só aceita texto mesmo.
    const inicial = typeof nome === 'string' ? nome.trim() : ''
    setMateriaEdit(null)
    setMateriaForm(inicial ? { ...emptyMateria, nome: inicial } : emptyMateria)
    setShowMateria(true)
  }
  function abrirEditarMateria(m) {
    setMateriaEdit(m)
    setMateriaForm({ nome: m.nome, unidade: m.unidade, custo: String(m.custo ?? ''), ativo: m.ativo })
    setShowMateria(true)
  }
  async function salvarMateria(e) {
    e.preventDefault()
    if (salvandoMateria) return   // trava o clique repetido no Salvar (era o que criava cópias)
    if (!materiaForm.nome.trim()) return
    if (materiaRepetida && !confirm(`Já existe "${materiaRepetida.nome}" na sua lista.\n\nCadastrar mesmo assim (vai ficar repetido)?`)) return
    // Se ele disse quanto pagou pela quantidade que está entrando, esse é o custo
    // por unidade — não precisa digitar o preço duas vezes.
    const custoDigitado = Number(String(materiaForm.custo).replace(',', '.')) || 0
    const payload = {
      empresa_id: empresaId,
      nome: materiaForm.nome.trim(),
      unidade: materiaForm.unidade,
      custo: custoDigitado > 0 ? custoDigitado : (materiaUnit ?? 0),
      ativo: !!materiaForm.ativo,
    }
    setSalvandoMateria(true)
    try {
      if (materiaEdit) {
        const { error } = await supabase.from('materias_primas').update(payload).eq('id', materiaEdit.id)
        if (error) { alert('Erro ao salvar: ' + error.message); return }
      } else {
        const { data, error } = await supabase.from('materias_primas').insert(payload).select('id').single()
        if (error) { alert('Erro ao salvar: ' + error.message); return }
        // Cadastrou já com a quantidade → a compra de hoje entra junto, no mesmo
        // clique. É o que evita cadastrar agora e ter que dar entrada depois.
        const qtdIni = Number(String(materiaForm.quantidade ?? '').replace(',', '.'))
        if (data?.id && Number.isFinite(qtdIni) && qtdIni > 0) {
          const unit = materiaUnit ?? (payload.custo > 0 ? payload.custo : null)
          await supabase.from('materia_prima_movimentos').insert({
            empresa_id: empresaId, materia_prima_id: data.id, tipo: 'entrada', quantidade: qtdIni,
            custo_unit: unit, valor_total: unit ? unit * qtdIni : null,
            observacao: 'Compra lançada no cadastro do insumo',
          })
        }
      }
      setShowMateria(false)
      carregar()
    } finally {
      setSalvandoMateria(false)
    }
  }
  async function excluirMateria(m) {
    if (!confirm(`Excluir a matéria-prima "${m.nome}"?`)) return
    const { error } = await supabase.from('materias_primas').delete().eq('id', m.id)
    if (error) { alert('Erro ao excluir: ' + error.message); return }
    carregar()
  }

  // ── Estoque da matéria-prima (comprei / usei / acertar) ──
  function abrirMov(m) {
    setMovMateria(m)
    setMovTipo('entrada')
    const custo = Number(m.custo || 0)
    setMovTrio({ qtdTxt: '', unitTxt: custo > 0 ? txtNum(custo, 2) : '', totalTxt: '', ordem: ORDEM_PADRAO })
    setMovAtualizaCusto(true)
    setShowMov(true)
  }
  function setMovCampo(campo, val) {
    const chave = campo === 'qtd' ? 'qtdTxt' : campo === 'unit' ? 'unitTxt' : 'totalTxt'
    setMovTrio(t => recalcTrio({ ...t, [chave]: val }, campo))
  }
  const movUnit = numOuNulo(movTrio.unitTxt)
  async function salvarMov(e) {
    e.preventDefault()
    const m = movMateria
    const qtd = Number(String(movTrio.qtdTxt).replace(',', '.'))
    if (!Number.isFinite(qtd) || qtd < 0) { alert('Digite uma quantidade válida.'); return }
    let quantidade = qtd
    if (movTipo === 'ajuste') {
      // "Acertar": o valor digitado é o total contado; gravamos só a diferença.
      quantidade = qtd - saldoDe(m.id)
    } else if (qtd <= 0) {
      alert('Digite uma quantidade maior que zero.'); return
    }
    const pagoBruto = numOuNulo(movTrio.totalTxt) ?? (movUnit && qtd > 0 ? movUnit * qtd : null)
    const pago = pagoBruto ?? 0
    const temPago = movTipo === 'entrada' && pago > 0
    setSavingMov(true)
    const { error } = await supabase.from('materia_prima_movimentos').insert({
      empresa_id: empresaId, materia_prima_id: m.id, tipo: movTipo, quantidade,
      custo_unit: temPago ? movUnit : null,
      valor_total: temPago ? pago : null,
    })
    // O custo do cadastro é o que a ficha técnica usa pra calcular o prato. Se o
    // preço mudou na compra, ele tem que acompanhar — mas só se o dono deixar.
    if (!error && temPago && movAtualizaCusto && movUnit > 0) {
      await supabase.from('materias_primas').update({ custo: movUnit }).eq('id', m.id)
    }
    setSavingMov(false)
    if (error) { alert('Erro ao movimentar: ' + error.message); return }
    setShowMov(false); carregar()
  }
  // Total de dinheiro parado em matéria-prima (saldo × custo).
  const totalMaterias = useMemo(
    () => materias.reduce((s, m) => s + Number(saldoMat[m.id] ?? 0) * Number(m.custo || 0), 0),
    [materias, saldoMat],
  )

  // ── Carrinho rápido (baixa ou entrada de insumos) ──
  function abrirCarrinho(tipo) { setCartTipo(tipo); setBaixaBusca(''); setBaixaCart([]); setCartAtualizaCusto(true); setShowBaixa(true) }
  // A lista do carrinho de ENTRADA mistura insumo e produto de revenda: quem
  // chega da compra tem tudo no mesmo saco. Cada opção carrega de onde veio, e na
  // hora de salvar cada uma vai pro estoque certo. Na BAIXA só entra insumo — dar
  // baixa de produto é venda/quebra, isso é da tela de Estoque.
  const opcoesCarrinho = useMemo(() => {
    const ins = materias.filter(m => m.ativo).map(m => ({
      key: 'mat:' + m.id, id: m.id, origem: 'mat', nome: m.nome,
      unidade: m.unidade, custo: Number(m.custo || 0), saldo: Number(saldoMat[m.id] ?? 0),
    }))
    if (cartTipo !== 'entrada') return ins
    const prods = produtos.filter(p => p.controla_estoque !== false).map(p => ({
      key: 'prod:' + p.id, id: p.id, origem: 'prod', nome: p.nome,
      unidade: 'un', custo: Number(p.preco_custo || 0), saldo: Number(saldoProd[p.id] ?? 0),
    }))
    return [...ins, ...prods].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
  }, [materias, produtos, saldoMat, saldoProd, cartTipo])

  function addBaixa(m) {
    setBaixaCart(prev => {
      const i = prev.findIndex(x => x.key === m.key)
      if (i >= 0) {
        const c = prev.slice()
        c[i] = recalcTrio({ ...c[i], qtdTxt: txtNum((numOuNulo(c[i].qtdTxt) ?? 0) + 1, 3) }, 'qtd')
        return c
      }
      // Preço do cadastro já entra preenchido: com ele, digitar só o total pago
      // resolve a quantidade sozinha. O total nasce VAZIO de propósito — se
      // viesse preenchido, ele contaria como "campo recente" e o primeiro valor
      // digitado recalcularia a coisa errada.
      const unitTxt = m.custo > 0 ? txtNum(m.custo, 2) : ''
      return [...prev, {
        key: m.key, id: m.id, origem: m.origem, nome: m.nome, unidade: m.unidade,
        qtdTxt: '1', unitTxt, totalTxt: '', ordem: ORDEM_PADRAO,
      }]
    })
  }
  // Um único caminho pros três campos: escreve o texto e deixa o trio se ajustar.
  function setBaixaCampo(key, campo, val) {
    const chave = campo === 'qtd' ? 'qtdTxt' : campo === 'unit' ? 'unitTxt' : 'totalTxt'
    setBaixaCart(prev => prev.map(x => x.key === key ? recalcTrio({ ...x, [chave]: val }, campo) : x))
  }
  function mudarBaixaQtd(key, delta) {
    setBaixaCart(prev => prev.flatMap(x => {
      if (x.key !== key) return [x]
      const q = Math.round(((numOuNulo(x.qtdTxt) ?? 0) + delta) * 1000) / 1000
      return q <= 0 ? [] : [recalcTrio({ ...x, qtdTxt: txtNum(q, 3) }, 'qtd')]
    }))
  }
  function removerBaixa(key) { setBaixaCart(prev => prev.filter(x => x.key !== key)) }

  // Cadastrar um INSUMO novo sem sair do carrinho. Chegou da feira com uma coisa
  // que não estava na lista? Cadastra e já cai no carrinho, no mesmo lugar.
  // Produto de revenda não dá: precisa de preço de venda e categoria (Catálogo).
  const [novoUnid, setNovoUnid] = useState('kg')
  const [criandoNoCarrinho, setCriandoNoCarrinho] = useState(false)
  async function cadastrarNoCarrinho() {
    const nome = baixaBusca.trim()
    if (!nome) return
    const ja = opcoesCarrinho.find(o => normTxt(o.nome) === normTxt(nome))
    if (ja) { addBaixa(ja); setBaixaBusca(''); return }   // já existia: só joga no carrinho
    setCriandoNoCarrinho(true)
    const { data, error } = await supabase.from('materias_primas')
      .insert({ empresa_id: empresaId, nome, unidade: novoUnid, custo: 0, ativo: true })
      .select('*').single()
    setCriandoNoCarrinho(false)
    if (error) { alert('Não deu pra cadastrar: ' + error.message); return }
    setMaterias(prev => [...prev, data].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')))
    addBaixa({ key: 'mat:' + data.id, id: data.id, origem: 'mat', nome: data.nome, unidade: data.unidade, custo: 0 })
    setBaixaBusca('')
  }
  const baixaFiltradas = useMemo(() => {
    const q = normTxt(baixaBusca)
    return q ? opcoesCarrinho.filter(o => normTxt(o.nome).includes(q)) : opcoesCarrinho
  }, [opcoesCarrinho, baixaBusca])
  // Números de verdade a partir do texto de cada linha (o preço só vale na entrada).
  const cartComPreco = useMemo(() => baixaCart.map(x => {
    const qtd = numOuNulo(x.qtdTxt)
    const unit = cartTipo === 'entrada' ? numOuNulo(x.unitTxt) : null
    const total = cartTipo === 'entrada' ? numOuNulo(x.totalTxt) : null
    return { ...x, qtd: qtd ?? 0, unit, pagoNum: total ?? (qtd && unit ? qtd * unit : null) }
  }), [baixaCart, cartTipo])
  const cartTotal = useMemo(
    () => cartComPreco.reduce((s, x) => s + (x.pagoNum ?? 0), 0),
    [cartComPreco],
  )


  async function confirmarBaixa() {
    const itens = cartComPreco.filter(x => x.qtd > 0)
    if (!itens.length) return
    // Mesmo carrinho, dois destinos: insumo vai pro estoque de matéria-prima,
    // produto de revenda vai pro estoque do catálogo (que é o que baixa na venda).
    const linhasMat = itens.filter(x => x.origem === 'mat').map(x => ({
      empresa_id: empresaId, materia_prima_id: x.id, tipo: cartTipo, quantidade: x.qtd,
      custo_unit: x.unit, valor_total: x.pagoNum,
    }))
    const linhasProd = itens.filter(x => x.origem === 'prod').map(x => ({
      empresa_id: empresaId, produto_id: x.id, tipo: cartTipo, quantidade: x.qtd,
      motivo: 'compra', custo_unit: x.unit, valor_total: x.pagoNum,
    }))
    setSalvandoBaixa(true)
    let erro = null
    if (linhasMat.length) {
      const { error } = await supabase.from('materia_prima_movimentos').insert(linhasMat)
      erro = erro || error
    }
    if (!erro && linhasProd.length) {
      const { error } = await supabase.from('estoque_movimentos').insert(linhasProd)
      erro = erro || error
    }
    if (!erro && cartTipo === 'entrada' && cartAtualizaCusto) {
      for (const x of itens) {
        if (!(x.unit > 0)) continue
        if (x.origem === 'prod') await supabase.from('produtos').update({ preco_custo: x.unit }).eq('id', x.id)
        else await supabase.from('materias_primas').update({ custo: x.unit }).eq('id', x.id)
      }
    }
    setSalvandoBaixa(false)
    if (erro) { alert('Erro ao lançar: ' + erro.message); return }
    setShowBaixa(false); carregar()
  }

  // ── Fichas técnicas ──────────────────────────────────────────────
  // Quanto custa 1 unidade base (g / ml / un) do que a ficha PRODUZ. É por aqui
  // que uma receita entra dentro da outra: a Coxinha pega o custo da Massa aqui.
  // Calcula na hora (não usa o custo gravado) pra receita de cima acompanhar
  // quando o insumo lá de baixo muda de preço.
  const custoDeFicha = useMemo(() => {
    const memo = new Map()
    function calc(fichaId, caminho = []) {
      if (caminho.includes(fichaId)) return 0        // rede de segurança contra círculo
      if (memo.has(fichaId)) return memo.get(fichaId)
      const f = fichas.find(x => x.id === fichaId)
      if (!f) return 0
      const abaixo = (id) => calc(id, [...caminho, fichaId])
      const total = (itensPorFicha[fichaId] || []).reduce((s, it) => s + custoItem(it, abaixo), 0)
      const rend = emBase(f.rendimento, f.unid_rendimento)
      const valor = rend > 0 ? total / rend : 0
      memo.set(fichaId, valor)
      return valor
    }
    return calc
  }, [fichas, itensPorFicha])

  // O que pode entrar numa linha da receita: insumo comprado OU outra ficha.
  // Fica de fora a própria ficha e quem já usa ela (senão o custo roda em círculo).
  const opcoesIngrediente = useMemo(() => {
    const arr = materias.filter(m => m.ativo).map(m => ({
      key: 'mp:' + m.id, label: m.nome, sub: `${brl(m.custo)} / ${m.unidade}`, tag: 'Insumo',
    }))
    for (const f of fichas) {
      if (fichaEdit && fichaUsa(f.id, fichaEdit.id, itensPorFicha)) continue
      const porUnid = custoDeFicha(f.id) * (FATOR[f.unid_rendimento] || 1)
      arr.push({
        key: 'fi:' + f.id, label: f.nome, tag: 'Receita',
        sub: Number(f.rendimento) > 0 ? `${brl(porUnid)} / ${f.unid_rendimento}` : 'falta o rendimento',
      })
    }
    return arr
  }, [materias, fichas, itensPorFicha, fichaEdit, custoDeFicha])

  // Vincular a ficha a um produto do catálogo ou a um complemento (pra ver margem).
  const opcoesVinculo = useMemo(() => {
    const arr = produtos.map(p => ({ key: 'prod:' + p.id, label: p.nome, tag: 'Produto' }))
    for (const c of complementos) {
      arr.push({
        key: 'comp:' + c.id, tag: 'Complemento',
        label: `${c.grupo ? c.grupo + ' · ' : ''}${c.nome}${c.preco > 0 ? ` (${brl(c.preco)})` : ''}`,
      })
    }
    return arr
  }, [produtos, complementos])

  function abrirNovaFicha() {
    setFichaEdit(null); setFichaForm(emptyFicha); setShowFicha(true)
  }
  function abrirEditarFicha(f) {
    setFichaEdit(f)
    const itens = (itensPorFicha[f.id] || []).map(it => ({
      materia_prima_id: it.materia_prima_id || '',
      ficha_ref_id: it.ficha_ref_id || '',
      nome: it.nome,
      quantidade: String(it.quantidade ?? ''),
      unidade: it.unidade || 'g',
      custo_unit: Number(it.custo_unit || 0),
    }))
    setFichaForm({
      nome: f.nome,
      produto_id: f.produto_id || '',
      complemento_opcao_id: f.complemento_opcao_id || '',
      rendimento: String(f.rendimento ?? ''),
      unid_rendimento: f.unid_rendimento || 'g',
      peso_porcao: String(f.peso_porcao ?? ''),
      unid_porcao: f.unid_porcao || 'g',
      observacoes: f.observacoes || '',
      itens: itens.length ? itens : [linhaVazia()],
    })
    setShowFicha(true)
  }

  // Ajusta uma linha de ingrediente do form. Ao escolher a matéria-prima,
  // já puxa a unidade e o custo (snapshot) dela.
  function setLinha(idx, patch) {
    setFichaForm(f => {
      const itens = f.itens.map((it, i) => (i === idx ? { ...it, ...patch } : it))
      return { ...f, itens }
    })
  }
  // A linha aceita insumo ("mp:<id>") ou outra ficha como ingrediente ("fi:<id>").
  function escolherIngrediente(idx, key) {
    if (!key) { setLinha(idx, { materia_prima_id: '', ficha_ref_id: '', nome: '', custo_unit: 0 }); return }
    if (key.startsWith('mp:')) {
      const mp = materias.find(m => m.id === key.slice(3))
      if (!mp) return
      setLinha(idx, {
        materia_prima_id: mp.id,
        ficha_ref_id: '',
        nome: mp.nome,
        unidade: mp.unidade,          // começa na mesma unidade da MP (pode trocar)
        custo_unit: custoBase(mp),    // custo por unidade base (snapshot)
      })
      return
    }
    const f = fichas.find(x => x.id === key.slice(3))
    if (!f) return
    setLinha(idx, {
      materia_prima_id: '',
      ficha_ref_id: f.id,
      nome: f.nome,
      unidade: f.unid_rendimento,     // a sub-receita entra na unidade que ela rende
      custo_unit: custoDeFicha(f.id),
    })
  }
  function addLinha() { setFichaForm(f => ({ ...f, itens: [...f.itens, linhaVazia()] })) }
  function removerLinha(idx) {
    setFichaForm(f => ({ ...f, itens: f.itens.length > 1 ? f.itens.filter((_, i) => i !== idx) : f.itens }))
  }
  // Vínculo: o dropdown manda "prod:<id>" ou "comp:<id>" (ou vazio). Só um vale por vez.
  function escolherVinculo(valor) {
    if (valor.startsWith('prod:')) setFichaForm(f => ({ ...f, produto_id: valor.slice(5), complemento_opcao_id: '' }))
    else if (valor.startsWith('comp:')) setFichaForm(f => ({ ...f, complemento_opcao_id: valor.slice(5), produto_id: '' }))
    else setFichaForm(f => ({ ...f, produto_id: '', complemento_opcao_id: '' }))
  }
  const vinculoValor = fichaForm.produto_id ? 'prod:' + fichaForm.produto_id
    : fichaForm.complemento_opcao_id ? 'comp:' + fichaForm.complemento_opcao_id : ''

  async function salvarFicha(e) {
    e.preventDefault()
    if (!fichaForm.nome.trim()) { alert('Dê um nome pra ficha (ex.: Coxinha).'); return }
    setSalvando(true)
    try {
      const dados = {
        empresa_id: empresaId,
        nome: fichaForm.nome.trim(),
        produto_id: fichaForm.produto_id || null,
        complemento_opcao_id: fichaForm.complemento_opcao_id || null,
        rendimento: Number(String(fichaForm.rendimento).replace(',', '.')) || 0,
        unid_rendimento: fichaForm.unid_rendimento,
        peso_porcao: Number(String(fichaForm.peso_porcao).replace(',', '.')) || 0,
        unid_porcao: fichaForm.unid_porcao,
        observacoes: fichaForm.observacoes.trim() || null,
      }
      let fichaId = fichaEdit?.id
      if (fichaEdit) {
        const { error } = await supabase.from('fichas_tecnicas').update(dados).eq('id', fichaEdit.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('fichas_tecnicas').insert(dados).select('id').single()
        if (error) throw error
        fichaId = data.id
      }
      // Regrava os itens: apaga os antigos e insere os atuais (simples e seguro).
      await supabase.from('ficha_itens').delete().eq('ficha_id', fichaId)
      const linhas = fichaForm.itens
        .filter(it => (it.materia_prima_id || it.ficha_ref_id) && Number(String(it.quantidade).replace(',', '.')) > 0)
        .map(it => ({
          empresa_id: empresaId,
          ficha_id: fichaId,
          materia_prima_id: it.materia_prima_id || null,
          ficha_ref_id: it.ficha_ref_id || null,
          nome: it.nome,
          quantidade: Number(String(it.quantidade).replace(',', '.')) || 0,
          unidade: it.unidade,
          custo_unit: Number(it.custo_unit || 0),
        }))
      if (linhas.length) {
        const { error } = await supabase.from('ficha_itens').insert(linhas)
        if (error) throw error
      }
      setShowFicha(false)
      carregar()
    } catch (err) {
      alert('Erro ao salvar a ficha: ' + (err.message || err))
    } finally {
      setSalvando(false)
    }
  }
  async function excluirFicha(f) {
    // Ficha que é ingrediente de outra não pode sumir: a receita de cima ficaria
    // com um buraco no custo, sem ninguém perceber.
    const usadaPor = fichas.filter(x => (itensPorFicha[x.id] || []).some(it => it.ficha_ref_id === f.id))
    if (usadaPor.length) {
      alert(`Não dá pra excluir "${f.nome}": ela é ingrediente de ${usadaPor.map(x => `"${x.nome}"`).join(', ')}.\n\nTire ela dessa(s) receita(s) primeiro.`)
      return
    }
    if (!confirm(`Excluir a ficha "${f.nome}"?`)) return
    const { error } = await supabase.from('fichas_tecnicas').delete().eq('id', f.id)
    if (error) { alert('Erro ao excluir: ' + error.message); return }
    carregar()
  }

  // Prévia ao vivo dentro do modal de ficha.
  const previa = useMemo(() => {
    const itens = fichaForm.itens.map(it => ({ ...it, quantidade: Number(String(it.quantidade).replace(',', '.')) || 0 }))
    const prod = produtos.find(p => p.id === fichaForm.produto_id)
    const comp = complementos.find(c => c.id === fichaForm.complemento_opcao_id)
    const preco = prod ? Number(prod.preco_venda || 0) : comp ? comp.preco : 0
    return calcularFicha({
      rendimento: Number(String(fichaForm.rendimento).replace(',', '.')) || 0,
      unid_rendimento: fichaForm.unid_rendimento,
      peso_porcao: Number(String(fichaForm.peso_porcao).replace(',', '.')) || 0,
      unid_porcao: fichaForm.unid_porcao,
    }, itens, preco, custoDeFicha)
  }, [fichaForm, produtos, complementos, custoDeFicha])

  if (!empresaId) {
    return <div className="card">Selecione uma loja pra usar a Ficha Técnica.</div>
  }

  return (
    <div>
      <div className="page-header">
        <h1>🧮 Ficha Técnica</h1>
        {aba === 'fichas'
          ? <button className="btn btn-primary" onClick={abrirNovaFicha}>+ Nova ficha</button>
          : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <LancarNotaIA empresaId={empresaId} onDone={carregar} />
              <button className="btn btn-secondary" onClick={() => abrirCarrinho('entrada')} title="Dar entrada rápida no que comprou/chegou">⬆️ Dar entrada</button>
              <button className="btn btn-secondary" onClick={() => abrirCarrinho('saida')} title="Dar baixa rápida no que foi usado hoje">⬇️ Dar baixa</button>
              <button className="btn btn-primary" onClick={abrirNovaMateria}>+ Nova matéria-prima</button>
            </div>}
      </div>

      {/* Abas internas */}
      <div className="toolbar" style={{ gap: 4 }}>
        <button
          className={'btn ' + (aba === 'fichas' ? 'btn-primary' : 'btn-secondary')}
          onClick={() => setAba('fichas')}
        >Fichas técnicas</button>
        <button
          className={'btn ' + (aba === 'materias' ? 'btn-primary' : 'btn-secondary')}
          onClick={() => setAba('materias')}
        >Matérias-primas</button>
        <button
          className={'btn ' + (aba === 'compras' ? 'btn-primary' : 'btn-secondary')}
          onClick={() => setAba('compras')}
          title="O histórico do que entrou: dia, item, quantidade e quanto foi pago"
        >📥 Compras</button>
      </div>

      {error && <div className="card error-text" style={{ marginBottom: 16 }}>{error}</div>}
      {loading && <div className="card">Carregando…</div>}

      {/* ─────────────── ABA: FICHAS ─────────────── */}
      {!loading && aba === 'fichas' && (
        fichas.length === 0 ? (
          <div className="card empty-state">
            <strong>Nenhuma ficha técnica ainda</strong>
            <p>Crie a receita de um produto (ex.: Coxinha) pra saber o custo real de cada porção.</p>
            <button className="btn btn-primary" onClick={abrirNovaFicha} style={{ marginTop: 8 }}>+ Nova ficha</button>
          </div>
        ) : (
          <div className="dashboard-grid">
            {fichas.map(f => {
              const vinc = vinculoDe(f)
              const c = calcularFicha(f, itensPorFicha[f.id] || [], vinc?.preco || 0, custoDeFicha)
              const negativo = c.temVenda && c.lucro < 0
              // Receitas que entram nesta (ex.: a Coxinha leva a Massa).
              const subReceitas = (itensPorFicha[f.id] || []).filter(it => it.ficha_ref_id)
              return (
                <div className="card" key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{f.nome}</div>
                      {vinc
                        ? <span className="badge badge-primary" style={{ marginTop: 4 }}>
                            {vinc.tipo === 'complemento' ? '➕' : '🔗'} {vinc.nome}
                            {vinc.tipo === 'complemento' ? ' (complemento)' : ''}
                          </span>
                        : <span className="badge badge-neutral" style={{ marginTop: 4 }}>sem vínculo</span>}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 4 }}>
                    <div>
                      <div className="label" style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>RENDEU PRONTO</div>
                      <div style={{ fontWeight: 700 }}>{fmtQtd(f.rendimento, f.unid_rendimento)}</div>
                    </div>
                    <div>
                      <div className="label" style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>CUSTO P/ FAZER</div>
                      <div style={{ fontWeight: 700 }}>{brl(c.custoTotal)}</div>
                    </div>
                    <div>
                      <div className="label" style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                        CUSTO POR PORÇÃO ({fmtQtd(f.peso_porcao, f.unid_porcao)})
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--primary)' }}>{brl(c.custoPorcao)}</div>
                    </div>
                  </div>

                  {subReceitas.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      🧩 Leva a receita de {subReceitas.map(it => `${it.nome} (${fmtQtd(it.quantidade, it.unidade)})`).join(', ')}
                    </div>
                  )}

                  {c.temVenda && (
                    <div style={{
                      marginTop: 4, padding: '8px 10px', borderRadius: 8,
                      background: negativo ? 'var(--danger-bg)' : 'var(--success-bg)',
                      color: negativo ? 'var(--danger)' : 'var(--success)',
                      fontSize: 13, fontWeight: 600,
                    }}>
                      Vende {brl(c.precoVenda)} · {negativo ? 'Prejuízo' : 'Lucro'} {brl(c.lucro)} ({c.margemPct.toFixed(0)}%)
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => abrirEditarFicha(f)}>Editar</button>
                    <button className="btn btn-danger btn-sm" onClick={() => excluirFicha(f)}>Excluir</button>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}

      {/* ─────────────── ABA: MATÉRIAS-PRIMAS ─────────────── */}
      {!loading && aba === 'materias' && (
        materias.length === 0 ? (
          <div className="card empty-state">
            <strong>Nenhuma matéria-prima cadastrada</strong>
            <p>Cadastre os insumos (farinha, frango, margarina…) com o custo. Eles NÃO aparecem no catálogo.</p>
            <button className="btn btn-primary" onClick={abrirNovaMateria} style={{ marginTop: 8 }}>+ Nova matéria-prima</button>
          </div>
        ) : (
          <>
          {/* Total de dinheiro parado em matéria-prima */}
          <div className="card" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', border: '2px solid var(--primary)', background: 'var(--primary-bg, rgba(124,58,237,.08))' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1 }}>💰 Total parado em matérias-primas</span>
            <strong style={{ fontSize: 24, color: 'var(--primary)' }}>{brl(totalMaterias)}</strong>
          </div>
          {/* Busca: pra saber se o insumo já está cadastrado antes de criar de novo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 260px', minWidth: 0 }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: .6 }}>🔎</span>
              <input
                value={buscaMateria}
                onChange={e => setBuscaMateria(e.target.value)}
                placeholder="Procurar matéria-prima (ex.: feijão, óleo, frango)"
                style={{ width: '100%', padding: '10px 34px 10px 32px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-input, transparent)', color: 'var(--text)', fontSize: 14 }}
              />
              {buscaMateria && (
                <button type="button" onClick={() => setBuscaMateria('')} title="Limpar"
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 4 }}>×</button>
              )}
            </div>
            <span style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {buscaMateria
                ? `${materiasFiltradas.length} de ${materias.length}`
                : `${materias.length} cadastrada${materias.length === 1 ? '' : 's'}`}
            </span>
          </div>

          {materiasFiltradas.length === 0 ? (
            <div className="card empty-state">
              <strong>Não achei "{buscaMateria}"</strong>
              <p>Essa matéria-prima ainda não está cadastrada.</p>
              <button className="btn btn-primary" style={{ marginTop: 8 }}
                onClick={() => abrirNovaMateria(buscaMateria)}>+ Cadastrar "{buscaMateria.trim()}"</button>
            </div>
          ) : (
          <div className="data-table">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th>Matéria-prima</th>
                  <th>Custo</th>
                  <th>Estoque atual</th>
                  <th>Valor em estoque</th>
                  <th style={{ width: 220 }}></th>
                </tr>
              </thead>
              <tbody>
                {materiasFiltradas.map(m => {
                  const saldo = saldoDe(m.id)
                  const valor = saldo * Number(m.custo || 0)
                  return (
                  <tr key={m.id}>
                    <td>
                      {m.nome}
                      {!m.ativo && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>inativa</span>}
                    </td>
                    <td>{brl(m.custo)} <span style={{ color: 'var(--text-muted)' }}>/ {m.unidade}</span></td>
                    <td style={{ fontWeight: 700, color: saldo < 0 ? 'var(--danger)' : 'var(--text)' }}>{fmtQtd(saldo, m.unidade)}</td>
                    <td style={{ fontWeight: 700 }}>{brl(valor)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn btn-primary btn-sm" onClick={() => abrirMov(m)}>Movimentar</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => abrirEditarMateria(m)}>Editar</button>
                        <button className="btn btn-danger btn-sm" onClick={() => excluirMateria(m)}>Excluir</button>
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )}
          </>
        )
      )}

      {/* ─────────────── ABA: COMPRAS (o que entrou) ─────────────── */}
      {aba === 'compras' && (
        <>
          <div className="card" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>De</label>
              <input type="date" value={compraDe} max={compraAte} onChange={e => setCompraDe(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Até</label>
              <input type="date" value={compraAte} min={compraDe} onChange={e => setCompraAte(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => periodoRapido('hoje')}>Hoje</button>
              <button className="btn btn-secondary btn-sm" onClick={() => periodoRapido('7')}>Últimos 7 dias</button>
              <button className="btn btn-secondary btn-sm" onClick={() => periodoRapido('mes')}>Este mês</button>
            </div>

            {/* Uma semana por vez. As setas andam; a da direita para na semana
                atual, que é até onde existe compra pra ver. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <button type="button" className="btn btn-secondary btn-sm" title="Semana anterior"
                onClick={() => irParaSemana((semanaAtualSel ?? 0) - 1)}>←</button>
              <span style={{ fontSize: 13, fontWeight: 700, minWidth: 175, textAlign: 'center' }}>
                {semanaAtualSel !== null ? rotuloSemana(semanaAtualSel) : 'Período escolhido'}
              </span>
              <button type="button" className="btn btn-secondary btn-sm"
                disabled={semanaAtualSel !== null && semanaAtualSel >= 0}
                title={semanaAtualSel !== null && semanaAtualSel >= 0 ? 'Você já está na semana atual' : 'Semana seguinte'}
                onClick={() => irParaSemana(Math.min(0, (semanaAtualSel ?? -1) + 1))}>→</button>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', border: '2px solid var(--primary)', background: 'var(--primary-bg, rgba(124,58,237,.08))' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1 }}>
              🧾 Gasto em compras no período
            </span>
            <strong style={{ fontSize: 24, color: 'var(--primary)' }}>{brl(totalPeriodo)}</strong>
          </div>

          {semValorPeriodo > 0 && (
            <div className="card" style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-muted)' }}>
              ⚠️ {semValorPeriodo} entrada{semValorPeriodo === 1 ? '' : 's'} sem valor informado — {semValorPeriodo === 1 ? 'ela não entra' : 'elas não entram'} nesse total.
              Na hora de dar entrada, preencha "quanto pagou" pro número ficar completo.
            </div>
          )}

          {loadingCompras ? (
            <div className="card">Carregando…</div>
          ) : comprasPorDia.length === 0 ? (
            <div className="card empty-state">
              <strong>Nenhuma entrada nesse período</strong>
              <p>Aqui aparece tudo que entrou no estoque — insumo e produto de revenda — com a data e o valor pago.</p>
            </div>
          ) : comprasPorDia.map(g => {
            const aberto = diaAberto === g.dia
            return (
            <div className="card" key={g.dia} style={{ marginBottom: 12 }}>
              <div
                onClick={() => setDiaAberto(aberto ? null : g.dia)}
                title={aberto ? 'Fechar' : 'Toque pra ver o que entrou nesse dia'}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', cursor: 'pointer',
                  marginBottom: aberto ? 8 : 0, paddingBottom: aberto ? 8 : 0, borderBottom: aberto ? '1px solid var(--border)' : 'none' }}
              >
                <strong style={{ fontSize: 15 }}>
                  <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>{aberto ? '▲' : '▼'}</span>
                  📅 {g.dia}
                  <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 13 }}> · {g.itens.length} entrada{g.itens.length === 1 ? '' : 's'}</span>
                </strong>
                <strong style={{ fontSize: 16 }}>
                  {brl(g.total)}
                  {g.semValor > 0 && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted)' }}> (+{g.semValor} sem valor)</span>}
                </strong>
              </div>
              <div style={{ display: aberto ? 'grid' : 'none', gap: 6 }}>
                {g.itens.map(c => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 14 }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12.5, width: 44 }}>
                      {new Date(c.quando).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className={'badge ' + (c.origem === 'insumo' ? 'badge-primary' : 'badge-neutral')}>
                      {c.origem === 'insumo' ? 'Insumo' : 'Produto'}
                    </span>
                    <span style={{ flex: '1 1 140px', minWidth: 0, fontWeight: 600 }}>{c.nome}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtQtd(c.quantidade, c.unidade)}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                      {c.custo_unit != null ? `${brl(c.custo_unit)}/${c.unidade}` : ''}
                    </span>
                    <strong style={{ marginLeft: 'auto' }}>
                      {c.valor_total != null
                        ? brl(c.valor_total)
                        : <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12.5 }}>sem valor</span>}
                    </strong>
                    <button type="button" onClick={() => apagarEntrada(c)} disabled={apagando === c.id}
                      title="Apagar esta entrada (lancei errado)"
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 15, padding: '2px 4px', lineHeight: 1 }}>
                      {apagando === c.id ? '…' : '🗑'}
                    </button>
                    {c.observacao && (
                      <span style={{ flexBasis: '100%', fontSize: 12, color: 'var(--text-muted)', paddingLeft: 52 }}>{c.observacao}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            )
          })}
        </>
      )}

      {/* ─────────────── MODAL: MATÉRIA-PRIMA ─────────────── */}
      {showMateria && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowMateria(false) }}>
          <form className="modal" onSubmit={salvarMateria}>
            <h2>{materiaEdit ? 'Editar matéria-prima' : 'Nova matéria-prima'}</h2>
            <div className="form-grid">
              <div className="form-field full">
                <label>Nome</label>
                <input autoFocus placeholder="Ex.: Farinha de trigo" value={materiaForm.nome}
                  onChange={e => setMateriaForm(f => ({ ...f, nome: e.target.value }))}
                  style={materiaRepetida ? { borderColor: 'var(--danger, #dc2626)' } : undefined} />
                {materiaRepetida && (
                  <div style={{
                    marginTop: 6, padding: '8px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    background: 'var(--danger-bg, rgba(220,38,38,.1))', color: 'var(--danger, #dc2626)',
                    border: '1px solid var(--danger, #dc2626)',
                  }}>
                    ⚠️ Você já tem "{materiaRepetida.nome}" cadastrada
                    {materiaRepetida.ativo ? '' : ' (está pausada)'} — {brl(materiaRepetida.custo)} / {materiaRepetida.unidade}.
                    <div style={{ fontWeight: 400, marginTop: 2 }}>
                      Não cadastre de novo: feche aqui e clique em <strong>Editar</strong> nela, senão o estoque fica dividido em duas.
                    </div>
                  </div>
                )}
              </div>
              <div className="form-field">
                <label>Unidade de compra</label>
                <select value={materiaForm.unidade} onChange={e => setMateriaForm(f => ({ ...f, unidade: e.target.value }))}>
                  {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label>Custo por {materiaForm.unidade} (R$)</label>
                <input inputMode="decimal" placeholder={materiaUnit != null ? brl(materiaUnit) : 'Ex.: 5,00'} value={materiaForm.custo}
                  onChange={e => setMateriaForm(f => ({ ...f, custo: e.target.value }))} />
                {materiaUnit != null && !materiaForm.custo && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Vai entrar com {brl(materiaUnit)}, tirado da compra abaixo.</span>
                )}
              </div>
              {/* Cadastrar e dar entrada no mesmo clique: quem acabou de chegar da
                  feira com um item novo não quer fazer as duas coisas separadas. */}
              {!materiaEdit && (
                <div className="form-field full">
                  <div style={{ border: '1.5px dashed var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 2 }}>🛒 Já comprei — lançar a entrada de hoje</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                      Preencha e o insumo já nasce com esse estoque e essa compra no dia de hoje. Deixe vazio se é só cadastro.
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 130px' }}>
                        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>Quantidade ({materiaForm.unidade})</label>
                        <input inputMode="decimal" placeholder={`Ex.: 10`} value={materiaForm.quantidade}
                          onChange={e => setMateriaForm(f => ({ ...f, quantidade: e.target.value }))}
                          style={{ width: '100%' }} />
                      </div>
                      <div style={{ flex: '1 1 130px' }}>
                        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>Quanto pagou (R$)</label>
                        <input inputMode="decimal" placeholder="Ex.: 50,00" value={materiaForm.pago}
                          onChange={e => setMateriaForm(f => ({ ...f, pago: e.target.value }))}
                          style={{ width: '100%' }} />
                      </div>
                    </div>
                    {materiaUnit != null && (
                      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
                        Sai a <strong style={{ color: 'var(--text)' }}>{brl(materiaUnit)}</strong> por {materiaForm.unidade} — vira o custo do cadastro e aparece na aba Compras de hoje.
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="form-field full">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={materiaForm.ativo}
                    onChange={e => setMateriaForm(f => ({ ...f, ativo: e.target.checked }))} />
                  Ativa (aparece na lista pra montar fichas)
                </label>
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowMateria(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={salvandoMateria}>{salvandoMateria ? 'Salvando…' : 'Salvar'}</button>
            </div>
          </form>
        </div>
      )}

      {/* ─────────────── MODAL: MOVIMENTAR ESTOQUE DA MATÉRIA-PRIMA ─────────────── */}
      {showMov && movMateria && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowMov(false) }}>
          <form className="modal" onSubmit={salvarMov}>
            <h2>Estoque · {movMateria.nome}</h2>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
              Saldo atual: <strong>{fmtQtd(saldoDe(movMateria.id), movMateria.unidade)}</strong> · valor {brl(saldoDe(movMateria.id) * Number(movMateria.custo || 0))}
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {[['entrada', '⬆️ Comprei'], ['saida', '⬇️ Usei'], ['ajuste', '✏️ Acertar']].map(([id, lb]) => (
                <button key={id} type="button" onClick={() => setMovTipo(id)}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                    border: `1.5px solid ${movTipo === id ? 'var(--primary)' : 'var(--border)'}`,
                    background: movTipo === id ? 'rgba(124,58,237,.1)' : 'transparent', color: 'var(--text)' }}>
                  {lb}
                </button>
              ))}
            </div>

            <div className="form-field full">
              <label>{movTipo === 'ajuste' ? `Quantidade contada agora (${movMateria.unidade})` : `Quantidade (${movMateria.unidade})`}</label>
              <input autoFocus inputMode="decimal" placeholder={`Ex.: 5,66 (em ${movMateria.unidade})`} value={movTrio.qtdTxt}
                onChange={e => setMovCampo('qtd', e.target.value)} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, display: 'block' }}>
                {movTipo === 'entrada' && 'Entra no estoque (compra de insumo).'}
                {movTipo === 'saida' && 'Sai do estoque (usou na produção / perdeu).'}
                {movTipo === 'ajuste' && 'Acerta o saldo pro que você contou (grava só a diferença).'}
              </span>
            </div>

            {/* Preço pago: fica gravado NESTA compra, então dá pra ver depois
                quanto se gastou no dia e como o preço do insumo foi mudando.
                Dois campos preenchidos resolvem o terceiro — inclusive a
                quantidade, pra quem só sabe o total que pagou. */}
            {movTipo === 'entrada' && (
              <div className="form-field full" style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 130px' }}>
                    <label>Preço por {movMateria.unidade} (R$)</label>
                    <input inputMode="decimal" placeholder="Ex.: 2,99" value={movTrio.unitTxt}
                      onChange={e => setMovCampo('unit', e.target.value)} style={{ width: '100%' }} />
                  </div>
                  <div style={{ flex: '1 1 130px' }}>
                    <label>Paguei no total (R$)</label>
                    <input inputMode="decimal" placeholder="Ex.: 17,00" value={movTrio.totalTxt}
                      onChange={e => setMovCampo('total', e.target.value)} style={{ width: '100%' }} />
                  </div>
                </div>
                {movUnit != null ? (
                  <span style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6, display: 'block' }}>
                    Sai a <strong style={{ color: 'var(--text)' }}>{brl(movUnit)}</strong> por {movMateria.unidade}
                    {Number(movMateria.custo) > 0 && Math.abs(movUnit - Number(movMateria.custo)) > 0.004 && (
                      <> · antes estava {brl(movMateria.custo)}{' '}
                        <strong style={{ color: movUnit > Number(movMateria.custo) ? 'var(--danger, #dc2626)' : 'var(--success, #16a34a)' }}>
                          ({movUnit > Number(movMateria.custo) ? '▲ subiu' : '▼ baixou'})
                        </strong>
                      </>
                    )}
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, display: 'block' }}>
                    Preencha dois dos três (quantidade, preço, total) que o outro sai sozinho.
                    Deixe tudo vazio se não souber — a entrada é gravada do mesmo jeito, só sem o valor.
                  </span>
                )}
                {movUnit != null && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8, fontSize: 13 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={movAtualizaCusto}
                      onChange={e => setMovAtualizaCusto(e.target.checked)} />
                    Atualizar o custo do cadastro pra {brl(movUnit)} (a ficha técnica passa a usar esse)
                  </label>
                )}
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowMov(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={savingMov}>{savingMov ? 'Salvando…' : 'Confirmar'}</button>
            </div>
          </form>
        </div>
      )}

      {/* ─────────────── MODAL: BAIXA RÁPIDA (carrinho) ─────────────── */}
      {showBaixa && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowBaixa(false) }}>
          <div className="modal modal-lg" style={{ maxWidth: 660, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            <h2>{cartTipo === 'entrada' ? '⬆️ Dar entrada rápida (o que chegou)' : '⬇️ Dar baixa rápida (insumos usados)'}</h2>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
              {cartTipo === 'entrada'
                ? 'Insumo e produto de revenda na mesma lista — toque pra adicionar e lance tudo de uma vez. Cada um vai pro estoque certo.'
                : 'Toque no insumo pra adicionar, ajuste a quantidade e dê baixa em todos de uma vez.'}
            </p>
            <input autoFocus placeholder={cartTipo === 'entrada' ? 'Buscar (ex.: feijao, coca, agua)...' : 'Buscar insumo (ex.: feijao)...'} value={baixaBusca}
              onChange={e => setBaixaBusca(e.target.value)}
              style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />

            <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0, flexWrap: 'wrap' }}>
              {/* Lista de insumos (toca pra adicionar) */}
              <div style={{ flex: '1 1 240px', minWidth: 0, maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {/* Chegou uma coisa que não está cadastrada: cadastra e joga no
                    carrinho aqui mesmo, sem fechar a tela e começar de novo. */}
                {cartTipo === 'entrada' && baixaBusca.trim() && !opcoesCarrinho.some(o => normTxt(o.nome) === normTxt(baixaBusca)) && (
                  <div style={{ padding: 10, borderBottom: '1px solid var(--border)', background: 'var(--surface-hover, rgba(124,58,237,.06))' }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 6 }}>Não achou? Cadastre como <strong>insumo</strong> (produto novo é no Catálogo):</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13.5 }}>{baixaBusca.trim()}</strong>
                      <select value={novoUnid} onChange={e => setNovoUnid(e.target.value)}
                        style={{ padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13 }}>
                        {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                      <button type="button" className="btn btn-primary btn-sm" disabled={criandoNoCarrinho}
                        onClick={cadastrarNoCarrinho}>
                        {criandoNoCarrinho ? 'Criando…' : '+ Cadastrar e adicionar'}
                      </button>
                    </div>
                  </div>
                )}
                {baixaFiltradas.length === 0 && !baixaBusca.trim() ? (
                  <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>Nada cadastrado ainda. Crie em "+ Nova matéria-prima".</div>
                ) : baixaFiltradas.map(o => (
                  <button key={o.key} type="button" onClick={() => addBaixa(o)}
                    style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontSize: 14 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      {/* A etiqueta evita o erro de lançar a água no lugar errado. */}
                      <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 5px', borderRadius: 5, whiteSpace: 'nowrap',
                        background: o.origem === 'prod' ? 'rgba(37,99,235,.14)' : 'rgba(22,163,74,.14)',
                        color: o.origem === 'prod' ? '#2563eb' : '#15803d' }}>
                        {o.origem === 'prod' ? 'PRODUTO' : 'INSUMO'}
                      </span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.nome}</span>
                    </span>
                    <span style={{ color: o.saldo <= 0 ? 'var(--danger)' : 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>tem {fmtQtd(o.saldo, o.unidade)}</span>
                  </button>
                ))}
              </div>

              {/* Carrinho de baixa */}
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{cartTipo === 'entrada' ? 'Vai dar entrada' : 'Vai dar baixa'}</div>
                {baixaCart.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Toque num item à esquerda.</div>
                ) : cartComPreco.map(x => (
                  <div key={x.key} style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {x.origem === 'prod' && <span title="Produto de revenda" style={{ color: '#2563eb', fontWeight: 800, fontSize: 11 }}>▪ </span>}
                        {x.nome}
                      </div>
                      <button type="button" onClick={() => mudarBaixaQtd(x.key, -1)} style={stepBtn}>−</button>
                      <input inputMode="decimal" value={x.qtdTxt} onChange={e => setBaixaCampo(x.key, 'qtd', e.target.value)}
                        style={{ width: 60, textAlign: 'center', padding: '5px 4px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 24 }}>{x.unidade}</span>
                      <button type="button" onClick={() => mudarBaixaQtd(x.key, +1)} style={stepBtn}>+</button>
                      <button type="button" onClick={() => removerBaixa(x.key)} className="btn btn-danger btn-sm" style={{ padding: '4px 8px' }}>✕</button>
                    </div>
                    {/* Só na entrada: preço por unidade e total pago. Preencheu dois,
                        o terceiro sai sozinho — inclusive a quantidade. */}
                    {cartTipo === 'entrada' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, paddingLeft: 2, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>R$/{x.unidade}</span>
                        <input inputMode="decimal" placeholder="preço" value={x.unitTxt ?? ''}
                          onChange={e => setBaixaCampo(x.id, 'unit', e.target.value)}
                          style={{ width: 66, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13 }} />
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>paguei R$</span>
                        <input inputMode="decimal" placeholder="total" value={x.totalTxt ?? ''}
                          onChange={e => setBaixaCampo(x.id, 'total', e.target.value)}
                          style={{ width: 72, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13 }} />
                      </div>
                    )}
                  </div>
                ))}
                {cartTipo === 'entrada' && cartTotal > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 800, fontSize: 15 }}>
                    <span>Total da compra</span><span style={{ color: 'var(--primary)' }}>{brl(cartTotal)}</span>
                  </div>
                )}
                {cartTipo === 'entrada' && cartTotal > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8, fontSize: 12.5, color: 'var(--text-muted)' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={cartAtualizaCusto}
                      onChange={e => setCartAtualizaCusto(e.target.checked)} />
                    Atualizar o custo dos insumos com o preço que paguei agora
                  </label>
                )}
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowBaixa(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={confirmarBaixa} disabled={salvandoBaixa || baixaCart.length === 0}>
                {salvandoBaixa ? 'Salvando…' : `${cartTipo === 'entrada' ? 'Dar entrada' : 'Dar baixa'} (${baixaCart.length})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────── MODAL: FICHA TÉCNICA ─────────────── */}
      {showFicha && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowFicha(false) }}>
          <form className="modal modal-lg" onSubmit={salvarFicha}>
            <h2>{fichaEdit ? 'Editar ficha técnica' : 'Nova ficha técnica'}</h2>

            <div className="form-grid">
              <div className="form-field">
                <label>Nome da ficha</label>
                <input autoFocus placeholder="Ex.: Coxinha" value={fichaForm.nome}
                  onChange={e => setFichaForm(f => ({ ...f, nome: e.target.value }))} />
              </div>
              <div className="form-field">
                <label>Vincular a (opcional)</label>
                <BuscaSelect opcoes={opcoesVinculo} value={vinculoValor} onChange={escolherVinculo}
                  placeholder="Digite pra buscar (ex.: coxinha)…" vazioLabel="— não vincular —" />
              </div>
            </div>

            {/* Ingredientes */}
            <div style={{ margin: '18px 0 2px', fontWeight: 700 }}>O que leva</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
              Digite o nome que a lista já filtra. Pode ser um insumo (farinha) ou
              outra ficha pronta (ex.: a massa que você já cadastrou).
            </div>
            {materias.length === 0 && (
              <div className="badge badge-warning" style={{ display: 'block', padding: 10, marginBottom: 8 }}>
                Cadastre matérias-primas primeiro (aba "Matérias-primas").
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {fichaForm.itens.map((it, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px 34px', gap: 6, alignItems: 'center' }}>
                  <BuscaSelect
                    opcoes={opcoesIngrediente}
                    value={it.ficha_ref_id ? 'fi:' + it.ficha_ref_id : it.materia_prima_id ? 'mp:' + it.materia_prima_id : ''}
                    onChange={key => escolherIngrediente(idx, key)}
                    placeholder="Digite o nome (ex.: feijao)…"
                    vazioLabel="— tirar —"
                    semResultado="Não achei esse insumo nem receita." />
                  <input inputMode="decimal" placeholder="Qtd" value={it.quantidade}
                    onChange={e => setLinha(idx, { quantidade: e.target.value })}
                    style={{ padding: '9px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }} />
                  <select value={it.unidade} onChange={e => setLinha(idx, { unidade: e.target.value })}
                    style={{ padding: '9px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }}>
                    {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <div style={{ fontSize: 13, fontWeight: 600, textAlign: 'right', color: 'var(--text-muted)' }}>
                    {brl(custoItem({ ...it, quantidade: Number(String(it.quantidade).replace(',', '.')) || 0 }, custoDeFicha))}
                  </div>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => removerLinha(idx)} title="Remover"
                    style={{ padding: '6px 8px' }}>✕</button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={addLinha} style={{ marginTop: 8 }}>+ Adicionar matéria-prima</button>

            {/* Rendimento e porção */}
            <div className="form-grid" style={{ marginTop: 18 }}>
              <div className="form-field">
                <label>Rendeu quanto pronto?</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input inputMode="decimal" placeholder="Ex.: 5000" value={fichaForm.rendimento}
                    onChange={e => setFichaForm(f => ({ ...f, rendimento: e.target.value }))} style={{ flex: 1 }} />
                  <select value={fichaForm.unid_rendimento} onChange={e => setFichaForm(f => ({ ...f, unid_rendimento: e.target.value }))} style={{ width: 80 }}>
                    {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-field">
                <label>Peso/tamanho de cada porção</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input inputMode="decimal" placeholder="Ex.: 100" value={fichaForm.peso_porcao}
                    onChange={e => setFichaForm(f => ({ ...f, peso_porcao: e.target.value }))} style={{ flex: 1 }} />
                  <select value={fichaForm.unid_porcao} onChange={e => setFichaForm(f => ({ ...f, unid_porcao: e.target.value }))} style={{ width: 80 }}>
                    {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-field full">
                <label>Observações (opcional)</label>
                <input placeholder="Ex.: modo de preparo, rendimento aproximado…" value={fichaForm.observacoes}
                  onChange={e => setFichaForm(f => ({ ...f, observacoes: e.target.value }))} />
              </div>
            </div>

            {/* Prévia do cálculo */}
            <div className="card" style={{ marginTop: 16, background: 'var(--bg)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>CUSTO TOTAL PRA FAZER</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{brl(previa.custoTotal)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 700 }}>CUSTO POR PORÇÃO</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--primary)' }}>{brl(previa.custoPorcao)}</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                Rendeu {fmtQtd(fichaForm.rendimento, fichaForm.unid_rendimento)} → porção de {fmtQtd(fichaForm.peso_porcao, fichaForm.unid_porcao)} · custo por {fichaForm.unid_rendimento}: {brl4(previa.custoPorBase)}
              </div>
              {previa.temVenda && (
                <div style={{
                  marginTop: 10, padding: '8px 10px', borderRadius: 8, fontWeight: 700,
                  background: previa.lucro < 0 ? 'var(--danger-bg)' : 'var(--success-bg)',
                  color: previa.lucro < 0 ? 'var(--danger)' : 'var(--success)',
                }}>
                  Vende {brl(previa.precoVenda)} · {previa.lucro < 0 ? 'Prejuízo' : 'Lucro'} {brl(previa.lucro)} · margem {previa.margemPct.toFixed(0)}%
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowFicha(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar ficha'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
