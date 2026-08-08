import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import LancarNotaIA from '../components/LancarNotaIA'
import { useAuth } from '../hooks/useAuth'
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
const custoItem = (it) => emBase(it.quantidade, it.unidade) * Number(it.custo_unit || 0)

// Calcula tudo de uma ficha: custo total, custo por porção e margem.
// precoVenda vem do que estiver vinculado (produto do catálogo OU complemento).
function calcularFicha(ficha, itens, precoVenda = 0) {
  const custoTotal = (itens || []).reduce((s, it) => s + custoItem(it), 0)
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

const emptyMateria = { nome: '', unidade: 'kg', custo: '', ativo: true, quantidade: '' }
const linhaVazia = () => ({ materia_prima_id: '', nome: '', quantidade: '', unidade: 'g', custo_unit: 0 })
const emptyFicha = {
  nome: '', produto_id: '', complemento_opcao_id: '', rendimento: '', unid_rendimento: 'g',
  peso_porcao: '', unid_porcao: 'g', observacoes: '', itens: [linhaVazia()],
}

// Campo de busca pra vincular (produto OU complemento). Digita e filtra;
// ignora acento (feijao acha Feijão). Valor: "prod:<id>" | "comp:<id>" | "".
function VinculoCombobox({ produtos, complementos, value, onChange }) {
  const opcoes = useMemo(() => {
    const arr = []
    for (const p of produtos) arr.push({ key: 'prod:' + p.id, label: p.nome, tipo: 'Produto', norm: normTxt(p.nome) })
    for (const c of complementos) {
      const label = `${c.grupo ? c.grupo + ' · ' : ''}${c.nome}${c.preco > 0 ? ` (${brl(c.preco)})` : ''}`
      arr.push({ key: 'comp:' + c.id, label, tipo: 'Complemento', norm: normTxt(`${c.grupo} ${c.nome}`) })
    }
    return arr
  }, [produtos, complementos])
  const selecionado = opcoes.find(o => o.key === value) || null
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const wrapRef = useRef(null)

  useEffect(() => { setText(selecionado ? selecionado.label : '') }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    function onDoc(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const q = normTxt(text)
  const exata = selecionado && normTxt(selecionado.label) === q
  const filtradas = (q && !exata) ? opcoes.filter(o => o.norm.includes(q)) : opcoes

  function escolher(o) { onChange(o ? o.key : ''); setText(o ? o.label : ''); setOpen(false) }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input type="text" value={text} autoComplete="off" placeholder="Digite pra buscar (ex.: feijao) ou escolha…"
        onChange={e => { setText(e.target.value); setOpen(true) }}
        onFocus={e => { e.target.select(); setOpen(true) }}
        style={{ paddingRight: 28 }} />
      <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)', fontSize: 11 }}>▼</span>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
          maxHeight: 280, overflowY: 'auto', background: 'var(--card-bg, var(--surface, var(--bg)))',
          border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 28px rgba(0,0,0,.22)', padding: 4,
        }}>
          <div onMouseDown={() => escolher(null)} style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
            — não vincular —
          </div>
          {filtradas.length === 0 && <div style={{ padding: '8px 10px', fontSize: 13, color: 'var(--text-muted)' }}>Nada encontrado.</div>}
          {filtradas.map(o => (
            <div key={o.key} onMouseDown={() => escolher(o)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13.5, background: o.key === value ? 'var(--primary-bg, rgba(124,58,237,.12))' : 'transparent' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover, rgba(0,0,0,.05))'}
              onMouseLeave={e => e.currentTarget.style.background = o.key === value ? 'var(--primary-bg, rgba(124,58,237,.12))' : 'transparent'}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 20, padding: '1px 7px' }}>{o.tipo}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const stepBtn = { width: 28, height: 28, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 16, lineHeight: 1, flexShrink: 0 }

export default function FichaTecnica() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null

  // Aba fica no LINK (?aba=materias) pra sobreviver a refresh / sair e voltar.
  const [searchParams, setSearchParams] = useSearchParams()
  const aba = searchParams.get('aba') === 'materias' ? 'materias' : 'fichas'
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
  const [showMov, setShowMov] = useState(false)
  const [movMateria, setMovMateria] = useState(null)
  const [movTipo, setMovTipo] = useState('entrada') // 'entrada' | 'saida' | 'ajuste'
  const [movQtd, setMovQtd] = useState('')
  const [savingMov, setSavingMov] = useState(false)
  const saldoDe = (id) => Number(saldoMat[id] ?? 0)

  // Carrinho rápido (mesma tela pra dar BAIXA ou ENTRADA em vários insumos de uma vez).
  const [showBaixa, setShowBaixa] = useState(false)
  const [cartTipo, setCartTipo] = useState('saida') // 'saida' (baixa) | 'entrada'
  const [baixaBusca, setBaixaBusca] = useState('')
  const [baixaCart, setBaixaCart] = useState([]) // [{ id, nome, unidade, qtd }]
  const [salvandoBaixa, setSalvandoBaixa] = useState(false)

  const [showFicha, setShowFicha] = useState(false)
  const [fichaForm, setFichaForm] = useState(emptyFicha)
  const [fichaEdit, setFichaEdit] = useState(null)
  const [salvando, setSalvando] = useState(false)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setLoading(true)
    setError(null)
    try {
      const [mp, fi, it, pr, cp, sm] = await Promise.all([
        supabase.from('materias_primas').select('*').eq('empresa_id', empresaId).order('nome'),
        supabase.from('fichas_tecnicas').select('*, produtos(id, nome, preco_venda), complemento_opcoes(id, nome, preco_adicional)').eq('empresa_id', empresaId).order('nome'),
        supabase.from('ficha_itens').select('*').eq('empresa_id', empresaId),
        supabase.from('produtos').select('id, nome, preco_venda').eq('empresa_id', empresaId).eq('ativo', true).order('nome'),
        supabase.from('complemento_opcoes').select('id, nome, preco_adicional, complemento_grupos!inner(nome, empresa_id)').eq('complemento_grupos.empresa_id', empresaId).order('nome'),
        supabase.from('materia_prima_saldo').select('materia_prima_id, quantidade_atual'),
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

  // ── Matérias-primas ──────────────────────────────────────────────
  // Avisa (em vermelho) se já existe uma matéria-prima com esse nome — ignorando
  // acento e maiúscula, então "Creme de Leite" acha "creme de leite".
  const materiaRepetida = useMemo(() => {
    const q = normTxt(materiaForm.nome)
    if (!q) return null
    return materias.find(m => normTxt(m.nome) === q && m.id !== materiaEdit?.id) || null
  }, [materiaForm.nome, materias, materiaEdit])

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
    const payload = {
      empresa_id: empresaId,
      nome: materiaForm.nome.trim(),
      unidade: materiaForm.unidade,
      custo: Number(String(materiaForm.custo).replace(',', '.')) || 0,
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
        // Quantidade inicial informada no cadastro → já lança uma entrada de estoque.
        const qtdIni = Number(String(materiaForm.quantidade ?? '').replace(',', '.'))
        if (data?.id && Number.isFinite(qtdIni) && qtdIni > 0) {
          await supabase.from('materia_prima_movimentos').insert({ empresa_id: empresaId, materia_prima_id: data.id, tipo: 'entrada', quantidade: qtdIni })
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
  function abrirMov(m) { setMovMateria(m); setMovTipo('entrada'); setMovQtd(''); setShowMov(true) }
  async function salvarMov(e) {
    e.preventDefault()
    const m = movMateria
    const qtd = Number(String(movQtd).replace(',', '.'))
    if (!Number.isFinite(qtd) || qtd < 0) { alert('Digite uma quantidade válida.'); return }
    let quantidade = qtd
    if (movTipo === 'ajuste') {
      // "Acertar": o valor digitado é o total contado; gravamos só a diferença.
      quantidade = qtd - saldoDe(m.id)
    } else if (qtd <= 0) {
      alert('Digite uma quantidade maior que zero.'); return
    }
    setSavingMov(true)
    const { error } = await supabase.from('materia_prima_movimentos').insert({
      empresa_id: empresaId, materia_prima_id: m.id, tipo: movTipo, quantidade,
    })
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
  function abrirCarrinho(tipo) { setCartTipo(tipo); setBaixaBusca(''); setBaixaCart([]); setShowBaixa(true) }
  function addBaixa(m) {
    setBaixaCart(prev => {
      const i = prev.findIndex(x => x.id === m.id)
      if (i >= 0) { const c = prev.slice(); c[i] = { ...c[i], qtd: Math.round((c[i].qtd + 1) * 1000) / 1000 }; return c }
      return [...prev, { id: m.id, nome: m.nome, unidade: m.unidade, qtd: 1 }]
    })
  }
  function mudarBaixaQtd(id, delta) {
    setBaixaCart(prev => prev.flatMap(x => {
      if (x.id !== id) return [x]
      const q = Math.round((x.qtd + delta) * 1000) / 1000
      return q <= 0 ? [] : [{ ...x, qtd: q }]
    }))
  }
  function setBaixaQtd(id, val) {
    const q = Number(String(val).replace(',', '.'))
    setBaixaCart(prev => prev.map(x => x.id === id ? { ...x, qtd: Number.isFinite(q) ? q : x.qtd } : x))
  }
  function removerBaixa(id) { setBaixaCart(prev => prev.filter(x => x.id !== id)) }
  const baixaFiltradas = useMemo(() => {
    const q = normTxt(baixaBusca)
    const ativas = materias.filter(m => m.ativo)
    return q ? ativas.filter(m => normTxt(m.nome).includes(q)) : ativas
  }, [materias, baixaBusca])
  async function confirmarBaixa() {
    const linhas = baixaCart.filter(x => x.qtd > 0).map(x => ({
      empresa_id: empresaId, materia_prima_id: x.id, tipo: cartTipo, quantidade: x.qtd,
    }))
    if (!linhas.length) return
    setSalvandoBaixa(true)
    const { error } = await supabase.from('materia_prima_movimentos').insert(linhas)
    setSalvandoBaixa(false)
    if (error) { alert('Erro ao lançar: ' + error.message); return }
    setShowBaixa(false); carregar()
  }

  // ── Fichas técnicas ──────────────────────────────────────────────
  function abrirNovaFicha() {
    setFichaEdit(null); setFichaForm(emptyFicha); setShowFicha(true)
  }
  function abrirEditarFicha(f) {
    setFichaEdit(f)
    const itens = (itensPorFicha[f.id] || []).map(it => ({
      materia_prima_id: it.materia_prima_id || '',
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
  function escolherMateria(idx, materiaId) {
    const mp = materias.find(m => m.id === materiaId)
    if (!mp) { setLinha(idx, { materia_prima_id: '', custo_unit: 0 }); return }
    setLinha(idx, {
      materia_prima_id: mp.id,
      nome: mp.nome,
      unidade: mp.unidade,          // começa na mesma unidade da MP (pode trocar)
      custo_unit: custoBase(mp),    // custo por unidade base (snapshot)
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
        .filter(it => it.materia_prima_id && Number(String(it.quantidade).replace(',', '.')) > 0)
        .map(it => ({
          empresa_id: empresaId,
          ficha_id: fichaId,
          materia_prima_id: it.materia_prima_id,
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
    }, itens, preco)
  }, [fichaForm, produtos, complementos])

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
              const c = calcularFicha(f, itensPorFicha[f.id] || [], vinc?.preco || 0)
              const negativo = c.temVenda && c.lucro < 0
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
                <input inputMode="decimal" placeholder="Ex.: 5,00" value={materiaForm.custo}
                  onChange={e => setMateriaForm(f => ({ ...f, custo: e.target.value }))} />
              </div>
              {!materiaEdit && (
                <div className="form-field full">
                  <label>Quantidade em estoque agora ({materiaForm.unidade}) — opcional</label>
                  <input inputMode="decimal" placeholder={`Ex.: 10 (em ${materiaForm.unidade})`} value={materiaForm.quantidade}
                    onChange={e => setMateriaForm(f => ({ ...f, quantidade: e.target.value }))} />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Já entra com esse estoque (você não precisa ir em Movimentar depois).</span>
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
              <input autoFocus inputMode="decimal" placeholder={`Ex.: 5 (em ${movMateria.unidade})`} value={movQtd}
                onChange={e => setMovQtd(e.target.value)} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, display: 'block' }}>
                {movTipo === 'entrada' && 'Entra no estoque (compra de insumo).'}
                {movTipo === 'saida' && 'Sai do estoque (usou na produção / perdeu).'}
                {movTipo === 'ajuste' && 'Acerta o saldo pro que você contou (grava só a diferença).'}
              </span>
            </div>

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
            <h2>{cartTipo === 'entrada' ? '⬆️ Dar entrada rápida (insumos que chegaram)' : '⬇️ Dar baixa rápida (insumos usados)'}</h2>
            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
              Toque no insumo pra adicionar, ajuste a quantidade e {cartTipo === 'entrada' ? 'dê entrada' : 'dê baixa'} em todos de uma vez.
            </p>
            <input autoFocus placeholder="Buscar insumo (ex.: feijao)..." value={baixaBusca}
              onChange={e => setBaixaBusca(e.target.value)}
              style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />

            <div style={{ display: 'flex', gap: 14, flex: 1, minHeight: 0, flexWrap: 'wrap' }}>
              {/* Lista de insumos (toca pra adicionar) */}
              <div style={{ flex: '1 1 240px', minWidth: 0, maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {baixaFiltradas.length === 0 ? (
                  <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>Nenhum insumo. Cadastre em "+ Nova matéria-prima".</div>
                ) : baixaFiltradas.map(m => (
                  <button key={m.id} type="button" onClick={() => addBaixa(m)}
                    style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontSize: 14 }}>
                    <span>{m.nome}</span>
                    <span style={{ color: saldoDe(m.id) <= 0 ? 'var(--danger)' : 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>tem {fmtQtd(saldoDe(m.id), m.unidade)}</span>
                  </button>
                ))}
              </div>

              {/* Carrinho de baixa */}
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{cartTipo === 'entrada' ? 'Vai dar entrada' : 'Vai dar baixa'}</div>
                {baixaCart.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Toque num insumo à esquerda.</div>
                ) : baixaCart.map(x => (
                  <div key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.nome}</div>
                    <button type="button" onClick={() => mudarBaixaQtd(x.id, -1)} style={stepBtn}>−</button>
                    <input inputMode="decimal" value={x.qtd} onChange={e => setBaixaQtd(x.id, e.target.value)}
                      style={{ width: 50, textAlign: 'center', padding: '5px 4px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 24 }}>{x.unidade}</span>
                    <button type="button" onClick={() => mudarBaixaQtd(x.id, +1)} style={stepBtn}>+</button>
                    <button type="button" onClick={() => removerBaixa(x.id)} className="btn btn-danger btn-sm" style={{ padding: '4px 8px' }}>✕</button>
                  </div>
                ))}
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
                <VinculoCombobox produtos={produtos} complementos={complementos} value={vinculoValor} onChange={escolherVinculo} />
              </div>
            </div>

            {/* Ingredientes */}
            <div style={{ margin: '18px 0 6px', fontWeight: 700 }}>Matérias-primas usadas</div>
            {materias.length === 0 && (
              <div className="badge badge-warning" style={{ display: 'block', padding: 10, marginBottom: 8 }}>
                Cadastre matérias-primas primeiro (aba "Matérias-primas").
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {fichaForm.itens.map((it, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 70px 90px 34px', gap: 6, alignItems: 'center' }}>
                  <select value={it.materia_prima_id} onChange={e => escolherMateria(idx, e.target.value)}
                    style={{ padding: '9px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }}>
                    <option value="">— escolher —</option>
                    {materias.filter(m => m.ativo).map(m => <option key={m.id} value={m.id}>{m.nome}</option>)}
                  </select>
                  <input inputMode="decimal" placeholder="Qtd" value={it.quantidade}
                    onChange={e => setLinha(idx, { quantidade: e.target.value })}
                    style={{ padding: '9px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }} />
                  <select value={it.unidade} onChange={e => setLinha(idx, { unidade: e.target.value })}
                    style={{ padding: '9px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' }}>
                    {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <div style={{ fontSize: 13, fontWeight: 600, textAlign: 'right', color: 'var(--text-muted)' }}>
                    {brl(custoItem({ ...it, quantidade: Number(String(it.quantidade).replace(',', '.')) || 0 }))}
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
