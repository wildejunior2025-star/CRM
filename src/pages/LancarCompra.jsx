import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { acharPorCodigo, combinaCodigo, ouvirBipada } from '../lib/codigoBarras'
import { CATEGORIAS_COMPRA, CATEGORIAS_PAGAR, chaveDoItem } from '../lib/categoriasFinanceiro'
import { recadoDeErro } from '../lib/erroRede'
import '../components/Page.css'

// LANÇAR COMPRA — a nota de hoje, digitada UMA vez, caindo em três cantos.
//
// POR QUE EXISTE (26/10/2026, pedido do AGV Grill: controle total de despesa e lucro):
// a mesma compra era digitada em três telas — Entrada de estoque (produtos), Estoque de
// matéria-prima e Contas a pagar. Aqui é uma nota só: cada linha vai pro estoque certo pela
// etiqueta do item (Produto ou Matéria-prima) e o total vira UMA conta a pagar (ou já paga),
// quebrada por categoria. Tudo grava numa transação só (RPC lancar_compra, mig 0402), e o
// DESFAZER leva os três embora juntos.
//
// MANUAL DE PROPÓSITO: a IA depois só preenche estas mesmas linhas — a tela é o contrato.
//
// CATEGORIA: automática por item (o que a loja já corrigiu > palpite pelo nome) e sempre
// trocável. Trocar numa linha ensina a loja (categoria_item_aprendida, a mesma tabela do robô).
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100
const hojeISO = () => new Date().toLocaleDateString('sv-SE')
const maisDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE') }
const ddmm = (iso) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : '')
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const FORMAS = [['pix', 'PIX'], ['dinheiro', 'Dinheiro'], ['transferencia', 'Transferência'], ['boleto', 'Boleto'],
  ['debito', 'Débito'], ['credito', 'Crédito'], ['cheque', 'Cheque'], ['outro', 'Outro']]
const UNIDADES = ['kg', 'g', 'L', 'ml', 'un']

// Palpite quando a loja ainda não ensinou nada: pelo nome do item, e pela categoria de venda
// do produto quando ela já é uma categoria de compra. Errar aqui custa um clique no select.
const PALPITES = [
  ['Bebidas', /\b(coca|refri|guarana|fanta|sprite|pepsi|suco|agua|cerveja|skol|brahma|heineken|antarctica|budweiser|vinho|vodka|whisky|energetico|cha gelado|h2o)\b/],
  ['Carnes e frios', /\b(carne|frango|boi|porco|bacon|linguica|calabresa|peixe|camarao|presunto|mortadela|salsicha|hamburguer|costela|picanha|file|coxa|asa|sol|charque|bife)\b/],
  ['Laticínios e ovos', /\b(queijo|leite|ovo|ovos|manteiga|requeijao|creme de leite|iogurte|mussarela|coalho|nata|cheddar|catupiry)\b/],
  ['Hortifruti', /\b(tomate|cebola|alface|batata|banana|laranja|limao|cenoura|pimentao|alho|coentro|cheiro verde|macaxeira|mandioca|abacaxi|melancia|fruta|verdura|legume|salada|repolho)\b/],
  ['Padaria e confeitaria', /\b(pao|paes|bolo|massa|farinha de trigo|fermento|confeitaria|biscoito|bisnaga)\b/],
  ['Congelados', /\b(congelad|sorvete|polpa|acai|pizza congelada|nuggets)\b/],
  ['Descartáveis e embalagens', /\b(copo|prato descart|embalagem|marmita|marmitex|sacola|guardanapo|canudo|talher|papel aluminio|filme|isopor|quentinha)\b/],
  ['Limpeza e higiene', /\b(detergente|sabao|desinfetante|alvejante|sanitaria|esponja|papel toalha|papel higienico|limpeza|cloro|luva)\b/],
  ['Gás', /\b(gas|botijao)\b/],
]
function palpiteDaCategoria(nome, categoriaVenda) {
  const alvo = norm(categoriaVenda)
  const igual = CATEGORIAS_COMPRA.find(c => norm(c) === alvo)
  if (igual) return igual
  const n = norm(nome)
  for (const [cat, re] of PALPITES) if (re.test(n)) return cat
  return 'Mercearia'
}

export default function LancarCompra({ empresaId }) {
  const [produtos, setProdutos] = useState([])
  const [materias, setMaterias] = useState([])
  const [catalogoCats, setCatalogoCats] = useState([])   // categorias de VENDA da loja (Picolé, Refeições…)
  const [aprendidas, setAprendidas] = useState({})      // { termo: categoria }
  const [fornecedores, setFornecedores] = useState([])
  const [historico, setHistorico] = useState([])
  const [carregando, setCarregando] = useState(true)

  const [fornecedor, setFornecedor] = useState('')
  const [fornAberto, setFornAberto] = useState(false)
  const [data, setData] = useState(hojeISO())
  const [pagoAgora, setPagoAgora] = useState(true)
  const [forma, setForma] = useState('pix')
  const [vencimento, setVencimento] = useState(maisDias(hojeISO(), 7))
  const [vencMexido, setVencMexido] = useState(false)
  const [linhas, setLinhas] = useState([])
  const [totalNota, setTotalNota] = useState('')
  const [catConta, setCatConta] = useState('')          // '' = automática
  const [busca, setBusca] = useState('')
  const [novo, setNovo] = useState(null)                // { nome, tipo, unidade } = cadastro rápido aberto
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const [ok, setOk] = useState(null)

  const buscaRef = useRef(null)
  const qtdRefs = useRef({})
  const [foco, setFoco] = useState(null)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setCarregando(true)
    try {
      const [pr, mp, ap, fo, hi, ct] = await Promise.all([
        fetchAll(() => supabase.from('produtos')
          .select('id, nome, preco_custo, categoria, codigo_barras, controla_estoque')
          .eq('empresa_id', empresaId).eq('ativo', true).is('arquivado_em', null).order('nome').order('id')),
        fetchAll(() => supabase.from('materias_primas')
          .select('id, nome, unidade, custo').eq('empresa_id', empresaId).eq('ativo', true).order('nome').order('id')),
        supabase.from('categoria_item_aprendida').select('termo, categoria').eq('empresa_id', empresaId).limit(2000),
        supabase.from('fornecedores').select('id, nome').eq('empresa_id', empresaId).eq('ativo', true).order('nome').limit(1000),
        supabase.from('compras_lancadas')
          .select('id, fornecedor, data, total, pago, status, itens, created_at')
          .eq('empresa_id', empresaId).order('created_at', { ascending: false }).limit(15),
        supabase.from('categorias').select('nome, ordem').eq('empresa_id', empresaId).order('ordem'),
      ])
      if (pr.error) throw pr.error
      if (mp.error) throw mp.error
      setProdutos(pr.data || [])
      // Categorias do catálogo: as cadastradas + as que os produtos usam (sem repetir "Self service"/"self service").
      const vistas = new Map()
      for (const n of [...(ct.data || []).map(x => x.nome), ...(pr.data || []).map(x => x.categoria)]) {
        const t = String(n ?? '').trim()
        if (t && norm(t) !== 'outros' && !vistas.has(norm(t))) vistas.set(norm(t), t)
      }
      setCatalogoCats([...vistas.values()])
      setMaterias(mp.data || [])
      const m = {}
      for (const l of (ap.data || [])) m[l.termo] = l.categoria
      setAprendidas(m)
      setFornecedores(fo.data || [])
      setHistorico(hi.data || [])
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar a tela de compras'))
    } finally {
      setCarregando(false)
    }
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  // Foca a quantidade da linha recém-posta (o dedo já está no teclado).
  useEffect(() => {
    if (!foco) return
    const el = qtdRefs.current[foco]
    if (el) { el.focus(); el.select?.() }
    setFoco(null)
  }, [foco, linhas])

  const poeItem = useCallback((item) => {
    setOk(null)
    const key = `${item.tipo}:${item.id}`
    setLinhas(prev => {
      if (prev.some(l => l.key === key)) return prev
      const custo = item.custo ? String(item.custo).replace('.', ',') : ''
      return [...prev, {
        key, tipo: item.tipo, id: item.id, nome: item.nome, unidade: item.unidade || 'un',
        estoque: item.tipo === 'materia' ? true : item.controla_estoque !== false,
        qtd: item.qtd && num(item.qtd) > 0 ? String(item.qtd).replace('.', ',') : '1', custo, total: null,
        // Produto de revenda: manda a categoria do catálogo (Picolé, Sucos…). Matéria-prima não tem
        // categoria de venda, então fica com o palpite entre os tipos de gasto.
        cat: aprendidas[chaveDoItem(item.nome)]
          || (item.tipo === 'produto' && item.categoria && norm(item.categoria) !== 'outros' ? item.categoria : palpiteDaCategoria(item.nome, item.categoria)),
      }]
    })
    setFoco(key)
    setBusca('')
  }, [aprendidas])

  // Leitor de código de barras (USB é teclado) funciona aqui também, igual à Entrada de estoque.
  useEffect(() => {
    if (!produtos.length) return
    return ouvirBipada((codigo) => {
      const p = acharPorCodigo(produtos, codigo)
      if (p) poeItem({ tipo: 'produto', id: p.id, nome: p.nome, custo: p.preco_custo, categoria: p.categoria, controla_estoque: p.controla_estoque })
      else setErro(`Código ${codigo} não está em nenhum produto.`)
    })
  }, [produtos, poeItem])

  const achados = useMemo(() => {
    const t = norm(busca).trim()
    if (!t) return []
    const p = produtos.filter(x => norm(x.nome).includes(t) || combinaCodigo(x, busca))
      .map(x => ({ tipo: 'produto', id: x.id, nome: x.nome, custo: x.preco_custo, categoria: x.categoria, controla_estoque: x.controla_estoque }))
    const m = materias.filter(x => norm(x.nome).includes(t))
      .map(x => ({ tipo: 'materia', id: x.id, nome: x.nome, custo: x.custo, unidade: x.unidade }))
    return [...m, ...p].slice(0, 10)
  }, [busca, produtos, materias])

  function teclaBusca(e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const por = acharPorCodigo(produtos, busca)
    if (por) return poeItem({ tipo: 'produto', id: por.id, nome: por.nome, custo: por.preco_custo, categoria: por.categoria, controla_estoque: por.controla_estoque })
    if (achados.length === 1) poeItem(achados[0])
  }

  // ── linhas ──────────────────────────────────────────────────────────────
  const valorLinha = (l) => (l.total !== null ? num(l.total) : r2(num(l.qtd) * num(l.custo)))

  function mudar(key, campo, valor) {
    setLinhas(prev => prev.map(l => {
      if (l.key !== key) return l
      const n = { ...l, [campo]: valor }
      // O valor da linha é o que o papel diz. Se foi digitado o total, ele manda e o unitário
      // se acerta; se foi digitado o unitário, o total volta a ser conta.
      if (campo === 'custo') n.total = null
      if (campo === 'total') n.custo = num(valor) > 0 && num(l.qtd) > 0 ? String(Math.round(num(valor) / num(l.qtd) * 10000) / 10000).replace('.', ',') : ''
      if (campo === 'qtd' && l.total !== null && num(valor) > 0) n.custo = String(Math.round(num(l.total) / num(valor) * 10000) / 10000).replace('.', ',')
      return n
    }))
  }
  const tirar = (key) => setLinhas(prev => prev.filter(l => l.key !== key))

  async function trocaCategoria(l, cat) {
    mudar(l.key, 'cat', cat)
    const termo = chaveDoItem(l.nome)
    if (!termo) return
    setAprendidas(a => ({ ...a, [termo]: cat }))
    await supabase.from('categoria_item_aprendida').upsert({
      empresa_id: empresaId, termo, categoria: cat, exemplo: l.nome, atualizado_em: new Date().toISOString(),
    }, { onConflict: 'empresa_id,termo' })
  }

  // ── cadastro rápido ─────────────────────────────────────────────────────
  async function criarItem() {
    if (!novo) return
    setErro(null)
    const nome = novo.nome.trim()
    if (!nome) return
    try {
      if (novo.tipo === 'materia') {
        const { data: d, error } = await supabase.from('materias_primas')
          .insert({ empresa_id: empresaId, nome, unidade: novo.unidade, custo: num(novo.custo), estoque_minimo: num(novo.minimo) })
          .select('id, nome, unidade, custo').single()
        if (error) throw error
        setMaterias(m => [...m, d])
        poeItem({ tipo: 'materia', id: d.id, nome: d.nome, custo: d.custo, unidade: d.unidade, qtd: novo.qtd })
      } else {
        // Nasce ESCONDIDO de todos os canais de venda: está sem preço, e produto com preço zero
        // não pode aparecer na Loja Online. O preço de venda se define depois em Produtos.
        const { data: d, error } = await supabase.from('produtos')
          .insert({
            empresa_id: empresaId, nome, preco_custo: num(novo.custo), preco_venda: 0, controla_estoque: true,
            categoria: novo.categoria || 'outros', estoque_minimo: num(novo.minimo),
            disponivel_delivery: false, vende_salao: false, vende_mesa: false, vende_online: false, vende_app: false,
          }).select('id, nome, preco_custo, categoria, codigo_barras, controla_estoque').single()
        if (error) throw error
        setProdutos(p => [...p, d])
        poeItem({ tipo: 'produto', id: d.id, nome: d.nome, custo: d.preco_custo, categoria: d.categoria, controla_estoque: true, qtd: novo.qtd })
      }
      setNovo(null)
    } catch (e) {
      setErro(recadoDeErro(e, 'cadastrar o item'))
    }
  }

  // ── totais e rateio ─────────────────────────────────────────────────────
  const soma = r2(linhas.reduce((s, l) => s + valorLinha(l), 0))
  const total = totalNota.trim() === '' ? soma : r2(num(totalNota))
  const diferenca = r2(total - soma)

  // A conta é UMA, e o detalhe vive no rateio: quanto foi pra cada categoria. A diferença entre
  // a nota e a soma dos itens é frete (se sobra) ou desconto (se falta) — nunca some nem inventa.
  const rateio = useMemo(() => {
    if (total <= 0) return []
    if (catConta) return [{ categoria: catConta, valor: total }]
    const mapa = new Map()
    for (const l of linhas) mapa.set(l.cat, r2((mapa.get(l.cat) || 0) + valorLinha(l)))
    let lista = [...mapa.entries()].map(([categoria, valor]) => ({ categoria, valor })).filter(x => x.valor > 0)
    if (!lista.length) return [{ categoria: 'Fornecedores', valor: total }]
    lista.sort((a, b) => b.valor - a.valor)
    if (diferenca > 0) lista.push({ categoria: 'Frete', valor: diferenca })
    if (diferenca < 0) {
      let falta = -diferenca       // desconto: abate do maior primeiro
      for (const x of lista) { const t = Math.min(x.valor, falta); x.valor = r2(x.valor - t); falta = r2(falta - t); if (falta <= 0) break }
      lista = lista.filter(x => x.valor > 0)
    }
    const fecha = r2(total - lista.reduce((s, x) => s + x.valor, 0))   // sobra de arredondamento vai no maior
    if (fecha !== 0 && lista.length) lista[0].valor = r2(lista[0].valor + fecha)
    return lista
  }, [linhas, total, diferenca, catConta])

  const categoriaDaConta = catConta || rateio[0]?.categoria || 'Fornecedores'
  const nProdutos = linhas.filter(l => l.tipo === 'produto').length
  const nMaterias = linhas.filter(l => l.tipo === 'materia').length
  const semQtd = linhas.some(l => num(l.qtd) <= 0)
  const semPreco = linhas.some(l => valorLinha(l) <= 0)
  const podeLancar = !salvando && linhas.length > 0 && fornecedor.trim() && total > 0 && !semQtd

  // ── fornecedor: lista da loja + cadastro na hora ──────────────────────────
  const fornExato = useMemo(() => {
    const t = norm(fornecedor).trim()
    return t ? fornecedores.find(f => norm(f.nome).trim() === t) || null : null
  }, [fornecedor, fornecedores])
  const fornSugestoes = useMemo(() => {
    const t = norm(fornecedor).trim()
    return (t ? fornecedores.filter(f => norm(f.nome).includes(t)) : fornecedores).slice(0, 8)
  }, [fornecedor, fornecedores])

  async function cadastrarFornecedor(nomeBruto) {
    const nome = nomeBruto.trim().replace(/\s+/g, ' ')
    if (!nome) return null
    const { data: d, error } = await supabase.from('fornecedores')
      .insert({ empresa_id: empresaId, nome }).select('id, nome').single()
    if (error) {
      if (error.code === '23505') {            // já existia com outra caixa/espaço: usa o que existe
        const { data: ja } = await supabase.from('fornecedores').select('id, nome').eq('empresa_id', empresaId).ilike('nome', nome).maybeSingle()
        if (ja) return ja
      }
      throw error
    }
    setFornecedores(f => [...f, d].sort((a, b) => a.nome.localeCompare(b.nome)))
    return d
  }
  async function escolheNovoFornecedor() {
    setErro(null)
    try {
      const d = await cadastrarFornecedor(fornecedor)
      if (d) setFornecedor(d.nome)
      setFornAberto(false)
    } catch (e) { setErro(recadoDeErro(e, 'cadastrar o fornecedor')) }
  }

  function aoMudarData(v) {
    setData(v)
    if (!vencMexido) setVencimento(maisDias(v || hojeISO(), 7))
  }

  async function lancar() {
    if (!podeLancar) return
    setSalvando(true)
    setErro(null)
    setOk(null)
    try {
      // Digitou um nome e não clicou em "cadastrar"? Cadastra agora — a compra não pode criar fornecedor fantasma.
      let nomeForn = fornecedor.trim()
      if (!fornExato) { const d = await cadastrarFornecedor(nomeForn); if (d) nomeForn = d.nome }
      const { error } = await supabase.rpc('lancar_compra', {
        p: {
          fornecedor: nomeForn, data, vencimento, pago: pagoAgora, forma: pagoAgora ? forma : null,
          categoria: categoriaDaConta, total, rateio,
          itens: linhas.map(l => ({
            tipo: l.tipo, id: l.id, nome: l.nome, quantidade: num(l.qtd), estoque: l.estoque,
            custo_unit: num(l.custo) > 0 ? num(l.custo) : (valorLinha(l) > 0 && num(l.qtd) > 0 ? valorLinha(l) / num(l.qtd) : null),
            categoria: l.cat,
          })),
        },
      })
      if (error) throw error
      setOk({ fornecedor: fornecedor.trim(), total, pago: pagoAgora, vencimento, nProdutos, nMaterias })
      setLinhas([]); setTotalNota(''); setCatConta(''); setFornecedor('')
      await carregar()
      buscaRef.current?.focus()
    } catch (e) {
      setErro(recadoDeErro(e, 'lançar a compra'))
    } finally {
      setSalvando(false)
    }
  }

  async function desfazer(c) {
    if (!confirm(`Desfazer a compra de ${brl(c.total)} (${c.fornecedor})?\n\nTira a entrada do estoque, o custo volta ao que era e a conta some do Contas a pagar.`)) return
    setErro(null)
    const { error } = await supabase.rpc('desfazer_compra', { p_id: c.id })
    if (error) { setErro(recadoDeErro(error, 'desfazer a compra')); return }
    carregar()
  }

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  const inp = { fontSize: 14, padding: '8px 10px' }
  const lbl = { fontSize: 12, fontWeight: 700, display: 'block', marginBottom: 4, color: 'var(--text-muted)' }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Lançar compra</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Digite a nota uma vez só. Cada item vai pro estoque certo e o total vira a conta a pagar.
        </div>
      </div>

      {erro && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{erro}</div>}
      {ok && (
        <div className="card" style={{ borderColor: '#22c55e' }}>
          ✅ Compra lançada — <strong>{ok.fornecedor}</strong>, {brl(ok.total)}.{' '}
          {ok.nProdutos > 0 && <>{ok.nProdutos} {ok.nProdutos === 1 ? 'produto entrou' : 'produtos entraram'} no estoque. </>}
          {ok.nMaterias > 0 && <>{ok.nMaterias} {ok.nMaterias === 1 ? 'matéria-prima entrou' : 'matérias-primas entraram'} no estoque. </>}
          {ok.pago ? 'Conta registrada como paga.' : `Conta a pagar, vence ${ddmm(ok.vencimento)}.`}
        </div>
      )}

      {/* 1. a nota */}
      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          <div style={{ position: 'relative' }}>
            <label style={lbl}>Fornecedor</label>
            <input value={fornecedor} onChange={e => { setFornecedor(e.target.value); setFornAberto(true) }}
              onFocus={() => setFornAberto(true)} onBlur={() => setTimeout(() => setFornAberto(false), 150)}
              placeholder="De quem comprou" autoComplete="off" style={{ ...inp, width: '100%' }} />
            {fornExato && <div style={{ fontSize: 11.5, marginTop: 3, color: '#15803d' }}>✓ fornecedor cadastrado</div>}
            {fornAberto && !fornExato && (fornSugestoes.length > 0 || fornecedor.trim()) && (
              <div style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', marginTop: 2, background: 'var(--card, #fff)',
                border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,.12)', padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {fornSugestoes.map(f => (
                  <button key={f.id} type="button" className="btn btn-secondary"
                    onMouseDown={e => { e.preventDefault(); setFornecedor(f.nome); setFornAberto(false) }}
                    style={{ textAlign: 'left', padding: '9px 10px', fontSize: 13.5 }}>{f.nome}</button>
                ))}
                {fornecedor.trim() && (
                  <button type="button" className="btn btn-secondary"
                    onMouseDown={e => { e.preventDefault(); escolheNovoFornecedor() }}
                    style={{ textAlign: 'left', padding: '9px 10px', fontSize: 13.5, borderStyle: 'dashed' }}>
                    ➕ Cadastrar “{fornecedor.trim()}” como fornecedor novo
                  </button>
                )}
              </div>
            )}
          </div>
          <div>
            <label style={lbl}>Data da compra</label>
            <input type="date" value={data} max={hojeISO()} onChange={e => aoMudarData(e.target.value)} style={{ ...inp, width: '100%' }} />
          </div>
          <div>
            <label style={lbl}>Pagamento</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {[[true, 'Pago agora'], [false, 'A prazo']].map(([v, t]) => (
                <button key={t} type="button" onClick={() => setPagoAgora(v)}
                  style={{ flex: 1, padding: '8px 6px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                    background: pagoAgora === v ? 'var(--primary)' : 'transparent', color: pagoAgora === v ? '#fff' : 'var(--text)' }}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            {pagoAgora ? (
              <>
                <label style={lbl}>Forma</label>
                <select value={forma} onChange={e => setForma(e.target.value)} style={{ ...inp, width: '100%' }}>
                  {FORMAS.map(([id, t]) => <option key={id} value={id}>{t}</option>)}
                </select>
              </>
            ) : (
              <>
                <label style={lbl}>Vence em</label>
                <input type="date" value={vencimento} onChange={e => { setVencimento(e.target.value); setVencMexido(true) }} style={{ ...inp, width: '100%' }} />
              </>
            )}
          </div>
        </div>
      </div>

      {/* 2. os itens */}
      <div className="card">
        <label style={{ ...lbl, fontSize: 13, color: 'var(--text)' }}>Adicionar item (produto ou matéria-prima)</label>
        <input ref={buscaRef} value={busca} onChange={e => { setBusca(e.target.value); setNovo(null) }} onKeyDown={teclaBusca}
          disabled={carregando} placeholder="Digite o nome ou passe o leitor… (ex.: coca, carne de sol)"
          style={{ width: '100%', fontSize: 16, padding: '12px 14px' }} />

        {busca.trim() && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {achados.map(a => {
              const ja = linhas.some(l => l.key === `${a.tipo}:${a.id}`)
              return (
                <button key={`${a.tipo}:${a.id}`} type="button" className="btn btn-secondary" disabled={ja}
                  onClick={() => poeItem(a)}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left', padding: '10px 12px' }}>
                  <span>{a.nome}{ja ? ' — já está na nota' : ''}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: a.tipo === 'materia' ? '#fef3c7' : '#dbeafe', color: a.tipo === 'materia' ? '#92400e' : '#1e40af' }}>
                    {a.tipo === 'materia' ? `Matéria-prima · ${a.unidade}` : 'Produto'}
                  </span>
                </button>
              )
            })}
            {!novo && (
              <button type="button" className="btn btn-secondary"
                onClick={() => setNovo({ nome: busca.trim(), tipo: 'materia', unidade: 'kg', qtd: '', custo: '', minimo: '', categoria: '' })}
                style={{ textAlign: 'left', padding: '10px 12px', borderStyle: 'dashed' }}>
                ➕ Cadastrar “{busca.trim()}” como item novo
              </button>
            )}
            {novo && (
              <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} style={inp} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[['materia', 'Matéria-prima (insumo da receita)'], ['produto', 'Produto (revende pronto)']].map(([v, t]) => (
                    <button key={v} type="button" onClick={() => setNovo({ ...novo, tipo: v })}
                      style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                        background: novo.tipo === v ? 'var(--primary)' : 'transparent', color: novo.tipo === v ? '#fff' : 'var(--text)' }}>{t}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  {novo.tipo === 'materia' && (
                    <div>
                      <label style={lbl}>Compra por</label>
                      <select value={novo.unidade} onChange={e => setNovo({ ...novo, unidade: e.target.value })} style={inp}>
                        {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  )}
                  {novo.tipo === 'produto' && (
                    <div style={{ flex: '1 1 200px' }}>
                      <label style={lbl}>Categoria no catálogo</label>
                      <select value={novo.categoria} onChange={e => setNovo({ ...novo, categoria: e.target.value })} style={{ ...inp, width: '100%' }}>
                        <option value="">Sem categoria</option>
                        {catalogoCats.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  )}
                  <div>
                    <label style={lbl}>Quantidade que está entrando{novo.tipo === 'materia' ? ` (${novo.unidade})` : ''}</label>
                    <input inputMode="decimal" value={novo.qtd} placeholder="ex.: 2" onChange={e => setNovo({ ...novo, qtd: e.target.value })} style={{ ...inp, width: 150 }} />
                  </div>
                  <div>
                    <label style={lbl}>Valor pago por {novo.tipo === 'materia' ? novo.unidade : 'unidade'} (R$)</label>
                    <input inputMode="decimal" value={novo.custo} placeholder="0,00" onChange={e => setNovo({ ...novo, custo: e.target.value })} style={{ ...inp, width: 130 }} />
                  </div>
                  <div>
                    <label style={lbl}>Avisar quando baixar de</label>
                    <input inputMode="decimal" value={novo.minimo} placeholder="opcional" onChange={e => setNovo({ ...novo, minimo: e.target.value })} style={{ ...inp, width: 130 }} />
                  </div>
                </div>
                {novo.tipo === 'produto' && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    O produto nasce escondido das vendas (sem preço de venda). Defina o preço em Produtos quando quiser vender.
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={criarItem}>Cadastrar e usar</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNovo(null)}>Cancelar</button>
                </div>
              </div>
            )}
          </div>
        )}

        {linhas.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {linhas.map(l => (
              <div key={l.key} style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <strong style={{ fontSize: 14.5 }}>{l.nome}</strong>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: l.tipo === 'materia' ? '#fef3c7' : '#dbeafe', color: l.tipo === 'materia' ? '#92400e' : '#1e40af' }}>
                    {l.tipo === 'materia' ? '→ Estoque de matéria-prima' : l.estoque ? '→ Estoque de produtos' : '→ Só na conta (produto sem controle de estoque)'}
                  </span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => tirar(l.key)}
                    style={{ marginLeft: 'auto' }} aria-label={`Tirar ${l.nome}`}>✕</button>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <label style={lbl}>Quantidade{l.tipo === 'materia' ? ` (${l.unidade})` : ''}</label>
                    <input ref={el => { qtdRefs.current[l.key] = el }} inputMode="decimal" value={l.qtd}
                      onChange={e => mudar(l.key, 'qtd', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') buscaRef.current?.focus() }}
                      style={{ ...inp, width: 90, textAlign: 'center' }} />
                  </div>
                  <div>
                    <label style={lbl}>Valor de 1 unidade (R$)</label>
                    <input inputMode="decimal" value={l.custo} placeholder="0,00" onChange={e => mudar(l.key, 'custo', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') buscaRef.current?.focus() }}
                      style={{ ...inp, width: 110 }} />
                  </div>
                  <div>
                    <label style={lbl}>Total desta linha (qtd × valor)</label>
                    <input inputMode="decimal" placeholder="0,00"
                      value={l.total !== null ? l.total : (valorLinha(l) ? String(valorLinha(l)).replace('.', ',') : '')}
                      onChange={e => mudar(l.key, 'total', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') buscaRef.current?.focus() }}
                      style={{ ...inp, width: 110, fontWeight: 700 }} />
                  </div>
                  <div style={{ flex: '1 1 190px', minWidth: 170 }}>
                    <label style={lbl}>{l.tipo === 'produto' ? 'Categoria (do catálogo ou do gasto)' : 'Categoria do gasto'}</label>
                    <select value={l.cat} onChange={e => trocaCategoria(l, e.target.value)} style={{ ...inp, width: '100%' }}>
                      {l.tipo === 'produto' && catalogoCats.length > 0 && (
                        <optgroup label="Categorias do seu catálogo">
                          {[...new Set([...catalogoCats, ...(catalogoCats.includes(l.cat) || CATEGORIAS_PAGAR.includes(l.cat) ? [] : [l.cat])])].map(c => <option key={'c' + c} value={c}>{c}</option>)}
                        </optgroup>
                      )}
                      <optgroup label="Tipos de gasto">
                        {[...new Set([...CATEGORIAS_PAGAR, ...(l.tipo !== 'produto' && !CATEGORIAS_PAGAR.includes(l.cat) ? [l.cat] : [])])].map(c => <option key={'g' + c} value={c}>{c}</option>)}
                      </optgroup>
                    </select>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!linhas.length && !busca.trim() && !carregando && (
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-muted)' }}>
            Comece digitando o primeiro item da nota.
          </div>
        )}
      </div>

      {/* 3. fechamento */}
      {linhas.length > 0 && (
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'end' }}>
            <div>
              <label style={lbl}>Soma dos itens</label>
              <div style={{ fontSize: 20, fontWeight: 800 }}>{brl(soma)}</div>
            </div>
            <div>
              <label style={lbl}>Total da nota (se for diferente da soma)</label>
              <input inputMode="decimal" value={totalNota} placeholder={String(soma).replace('.', ',')}
                onChange={e => setTotalNota(e.target.value)} style={{ ...inp, width: '100%' }} />
              {diferenca !== 0 && total > 0 && (
                <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-muted)' }}>
                  {diferenca > 0 ? `+ ${brl(diferenca)} de frete/ajuste` : `− ${brl(-diferenca)} de desconto`}
                </div>
              )}
            </div>
            <div>
              <label style={lbl}>Categoria da conta</label>
              <select value={catConta} onChange={e => setCatConta(e.target.value)} style={{ ...inp, width: '100%' }}>
                <option value="">Automática (pelos itens)</option>
                {CATEGORIAS_PAGAR.map(c => <option key={c} value={c}>Tudo em {c}</option>)}
              </select>
            </div>
          </div>

          {rateio.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Em que o dinheiro foi</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {rateio.map(r => (
                  <span key={r.categoria} style={{ fontSize: 12.5, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border)' }}>
                    {r.categoria}: <strong>{brl(r.valor)}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 16, padding: 12, borderRadius: 10, background: 'var(--bg, #f8fafc)', border: '1px solid var(--border)', fontSize: 13, lineHeight: 1.6 }}>
            <strong>Ao lançar:</strong>
            <div>📦 Estoque de produtos: {nProdutos ? `${nProdutos} ${nProdutos === 1 ? 'item' : 'itens'}` : 'nada'}</div>
            <div>🥩 Estoque de matéria-prima: {nMaterias ? `${nMaterias} ${nMaterias === 1 ? 'item' : 'itens'}` : 'nada'}</div>
            <div>💸 Conta: {brl(total)} a <strong>{fornecedor.trim() || '—'}</strong> — {pagoAgora ? `paga hoje (${(FORMAS.find(([i]) => i === forma) || [0, forma])[1]})` : `a pagar, vence ${ddmm(vencimento)}`}</div>
          </div>

          {semPreco && !semQtd && (
            <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 10 }}>
              ⚠️ Tem item sem valor. Ele entra no estoque, mas o custo do cadastro não é atualizado.
            </div>
          )}
          {semQtd && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>Tem item com quantidade zerada — ajuste ou tire da nota.</div>}
          {!fornecedor.trim() && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>Falta dizer o fornecedor.</div>}
          {fornecedor.trim() && !semQtd && total <= 0 && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>Falta o valor da compra.</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn btn-primary" onClick={lancar} disabled={!podeLancar} style={{ padding: '12px 22px', fontSize: 15 }}>
              {salvando ? 'Lançando…' : `Lançar compra de ${brl(total)}`}
            </button>
          </div>
        </div>
      )}

      {/* 4. o que já foi lançado */}
      {historico.length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 8 }}>Últimas compras lançadas</div>
          {historico.map(c => {
            const desfeita = c.status === 'desfeita'
            return (
              <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap', opacity: desfeita ? 0.5 : 1 }}>
                <div style={{ flex: '1 1 200px', minWidth: 0, textDecoration: desfeita ? 'line-through' : 'none' }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{c.fornecedor}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {ddmm(c.data)} · {(c.itens || []).length} {(c.itens || []).length === 1 ? 'item' : 'itens'} · {c.pago ? 'paga' : 'a prazo'}
                  </div>
                </div>
                <strong style={{ fontSize: 14 }}>{brl(c.total)}</strong>
                {desfeita
                  ? <span style={{ fontSize: 12 }}>desfeita</span>
                  : <button type="button" className="btn btn-secondary btn-sm" onClick={() => desfazer(c)}>↩ Desfazer</button>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
