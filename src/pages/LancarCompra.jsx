import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
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
// etiqueta do item (Produto ou Matéria-prima) e o total vira a conta a pagar (ou já paga, ou
// parcelada), quebrada por categoria. Tudo grava numa transação só (RPC lancar_compra, mig
// 0402/0405/0406), e o DESFAZER leva tudo embora junto. CORRIGIR = desfaz e lança a nova na
// mesma transação (corrigir_compra): ou troca, ou nada muda.
//
// MANUAL DE PROPÓSITO: a IA depois só preenche estas mesmas linhas — a tela é o contrato.
//
// CATEGORIA: automática por item (o que a loja já corrigiu > palpite pelo nome) e sempre
// trocável. Trocar numa linha ensina a loja (categoria_item_aprendida, a mesma tabela do robô).
//
// RASCUNHO (27/10/2026): a nota em andamento fica salva no navegador. Perder 25 itens digitados
// num F5 faz a pessoa desistir da tela.
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}
const qtdTxt = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100
const hojeISO = () => new Date().toLocaleDateString('sv-SE')
const maisDias = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE') }
// Soma meses mantendo o dia (dia 31 em fevereiro cai no último dia do mês).
const somaMeses = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number)
  const alvo = new Date(y, m - 1 + n, 1, 12)
  const ult = new Date(alvo.getFullYear(), alvo.getMonth() + 1, 0).getDate()
  alvo.setDate(Math.min(d, ult))
  return alvo.toLocaleDateString('sv-SE')
}
const ddmm = (iso) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : '')
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// O nome da nota sem acento/pontuação, minúsculo e com espaços simples: a chave da ligação (igual à do robô).
const normApelido = (s) => norm(s).replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').trim()

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

// ── contas da linha (puras: a linha isolada e a tela usam as mesmas) ──────────
// Quantidade REAL em unidades (caixa × unidades por caixa). É ela que entra no estoque.
const qtdReal = (l) => (l.emb === 'cx' ? num(l.qtd) * Math.max(1, num(l.porCx)) : num(l.qtd))
const valorLinha = (l) => (l.total !== null ? num(l.total) : r2(num(l.qtd) * num(l.custo)))
const unitReal = (l) => { const q = qtdReal(l); return q > 0 ? valorLinha(l) / q : 0 }
// O custo que o cadastro vai ficar: MÉDIA PONDERADA entre o que já tem e o que está entrando (mig 0405) —
// a mesma conta do banco. Estoque zerado/negativo ou custo antigo zerado: vale o preço pago.
const custoMedio = (l) => {
  const q = qtdReal(l)
  const unit = unitReal(l)
  if (!(unit > 0)) return null
  const temBase = l.estoque && l.saldo > 0 && l.custoAtual > 0
  const novo = temBase ? (l.saldo * l.custoAtual + q * unit) / (l.saldo + q) : unit
  const esc = l.tipo === 'produto' ? 100 : 10000
  return { unit, novo: Math.round(novo * esc) / esc, temBase }
}
const inp = { fontSize: 14, padding: '8px 10px' }
const lbl = { fontSize: 12, fontWeight: 700, display: 'block', marginBottom: 4, color: 'var(--text-muted)' }
const tagTipo = (tipo) => ({ background: tipo === 'materia' ? '#fef3c7' : '#dbeafe', color: tipo === 'materia' ? '#92400e' : '#1e40af' })

// UMA linha da nota. Isolada e memorizada de propósito: com 30 itens, redesenhar a tela inteira a cada tecla
// custava ~0,5 s por tecla (cada linha tem um seletor com ~60 categorias). Agora só a linha mexida se redesenha.
const LinhaItem = memo(function LinhaItem({ l, ult, catalogoCats, onMudar, onTrocaEmb, onTirar, onDesligar, onTrocaCategoria, buscaRef, registraQtd }) {
  const cm = custoMedio(l)
  const un = l.tipo === 'materia' ? ` por ${l.unidade}` : ''
  const q = qtdReal(l)
  // Preço de referência: a última compra lançada; sem ela, o custo do cadastro.
  const ref = ult?.preco || l.custoAtual
  const pct = ref > 0 && cm ? ((cm.unit - ref) / ref) * 100 : 0
  const abaixoMin = l.estoque && l.minimo > 0 && q > 0 && l.saldo + q <= l.minimo
  const emCx = l.emb === 'cx'
  const enterVoltaPraBusca = (e) => { if (e.key === 'Enter') buscaRef.current?.focus() }
  const opcoesCatalogo = useMemo(
    () => [...new Set([...catalogoCats, ...(catalogoCats.includes(l.cat) || CATEGORIAS_PAGAR.includes(l.cat) ? [] : [l.cat])])],
    [catalogoCats, l.cat])
  const opcoesGasto = useMemo(
    () => [...new Set([...CATEGORIAS_PAGAR, ...(l.tipo !== 'produto' && !CATEGORIAS_PAGAR.includes(l.cat) ? [l.cat] : [])])],
    [l.tipo, l.cat])
  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <strong style={{ fontSize: 14.5 }}>{l.nome}</strong>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, ...tagTipo(l.tipo) }}>
          {l.tipo === 'materia' ? '→ Estoque de matéria-prima' : l.estoque ? '→ Estoque de produtos' : '→ Só na conta (produto sem controle de estoque)'}
        </span>
        {l.apelido && (
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            🔗 nota: “{l.apelido}”{' '}
            <button type="button" onClick={() => onDesligar(l)} style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', color: 'inherit', fontSize: 11.5, padding: 0 }}>desligar</button>
          </span>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onTirar(l.key)}
          style={{ marginLeft: 'auto' }} aria-label={`Tirar ${l.nome}`}>✕</button>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {l.tipo === 'produto' && (
          <div>
            <label style={lbl}>Veio em</label>
            <div style={{ display: 'flex', gap: 4 }}>
              {[['un', 'Unidade'], ['cx', 'Caixa']].map(([v, t]) => (
                <button key={v} type="button" onClick={() => onTrocaEmb(l, v)} aria-pressed={l.emb === v}
                  style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
                    background: l.emb === v ? 'var(--primary)' : 'transparent', color: l.emb === v ? '#fff' : 'var(--text)' }}>{t}</button>
              ))}
            </div>
          </div>
        )}
        {emCx && (
          <div>
            <label style={lbl}>Unidades por caixa</label>
            <input inputMode="numeric" value={l.porCx} onChange={e => onMudar(l.key, 'porCx', e.target.value)} style={{ ...inp, width: 90, textAlign: 'center' }} aria-label={`Unidades por caixa de ${l.nome}`} />
          </div>
        )}
        <div>
          <label style={lbl}>Quantidade{emCx ? ' (caixas)' : l.tipo === 'materia' ? ` (${l.unidade})` : ''}</label>
          <input ref={el => registraQtd(l.key, el)} inputMode="decimal" value={l.qtd}
            onChange={e => onMudar(l.key, 'qtd', e.target.value)} onKeyDown={enterVoltaPraBusca}
            aria-label={`Quantidade de ${l.nome}`} style={{ ...inp, width: 90, textAlign: 'center' }} />
        </div>
        <div>
          <label style={lbl}>{emCx ? 'Valor de 1 caixa (R$)' : 'Valor de 1 unidade (R$)'}</label>
          <input inputMode="decimal" value={l.custo} placeholder="0,00" onChange={e => onMudar(l.key, 'custo', e.target.value)} onKeyDown={enterVoltaPraBusca}
            aria-label={`Valor unitário de ${l.nome}`} style={{ ...inp, width: 110 }} />
        </div>
        <div>
          <label style={lbl}>Total desta linha (qtd × valor)</label>
          <input inputMode="decimal" placeholder="0,00"
            value={l.total !== null ? l.total : (valorLinha(l) ? String(valorLinha(l)).replace('.', ',') : '')}
            onChange={e => onMudar(l.key, 'total', e.target.value)} onKeyDown={enterVoltaPraBusca}
            aria-label={`Total da linha de ${l.nome}`} style={{ ...inp, width: 110, fontWeight: 700 }} />
        </div>
        <div style={{ flex: '1 1 190px', minWidth: 170 }}>
          <label style={lbl}>{l.tipo === 'produto' ? 'Categoria (do catálogo ou do gasto)' : 'Categoria do gasto'}</label>
          <select value={l.cat} onChange={e => onTrocaCategoria(l, e.target.value)} style={{ ...inp, width: '100%' }} aria-label={`Categoria de ${l.nome}`}>
            {l.tipo === 'produto' && catalogoCats.length > 0 && (
              <optgroup label="Categorias do seu catálogo">
                {opcoesCatalogo.map(c => <option key={'c' + c} value={c}>{c}</option>)}
              </optgroup>
            )}
            <optgroup label="Tipos de gasto">
              {opcoesGasto.map(c => <option key={'g' + c} value={c}>{c}</option>)}
            </optgroup>
          </select>
        </div>
      </div>

      {cm && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {emCx && <div>= <strong>{qtdTxt(q)} unidades</strong> a {brl(cm.unit)} cada</div>}
          <div>
            {cm.temBase
              ? <>Tem <strong>{qtdTxt(l.saldo)}</strong> a {brl(l.custoAtual)} → fica <strong>{qtdTxt(l.saldo + q)}</strong> ao <strong>custo médio de {brl(cm.novo)}</strong>{un}</>
              : <>{l.estoque ? 'Sem estoque (ou sem custo) antes: o ' : 'O '}custo passa a ser <strong>{brl(cm.novo)}</strong>{un}</>}
          </div>
          {ref > 0 && Math.abs(pct) >= 5 && (
            <div style={{ color: pct > 0 ? 'var(--danger)' : '#15803d', fontWeight: 700 }}>
              {pct > 0 ? '⚠️ Subiu' : '👍 Caiu'} {Math.abs(pct).toFixed(0)}% ({brl(ref)} → {brl(cm.unit)}) em relação {ult ? `à última compra${ult.fornecedor ? ` (${ult.fornecedor}, ${ddmm(ult.data)})` : ''}` : 'ao custo cadastrado'}.
            </div>
          )}
          {abaixoMin && (
            <div style={{ color: '#b45309', fontWeight: 700 }}>⚠️ Mesmo com essa compra, o estoque fica abaixo do mínimo ({qtdTxt(l.minimo)}).</div>
          )}
        </div>
      )}
    </div>
  )
})

const chaveRascunho = (empresaId) => `lc_rascunho_${empresaId}`
function lerRascunho(empresaId) {
  try {
    const r = JSON.parse(localStorage.getItem(chaveRascunho(empresaId)) || 'null')
    return r && Array.isArray(r.linhas) ? r : null
  } catch { return null }
}

export default function LancarCompra({ empresaId }) {
  const [, setParams] = useSearchParams()
  // O rascunho é lido UMA vez, na montagem; a partir daí o estado manda.
  const [rascunho] = useState(() => lerRascunho(empresaId))

  const [produtos, setProdutos] = useState([])
  const [materias, setMaterias] = useState([])
  const [catalogoCats, setCatalogoCats] = useState([])   // categorias de VENDA da loja (Picolé, Refeições…)
  const [aprendidas, setAprendidas] = useState({})      // { termo: categoria }
  const [fornecedores, setFornecedores] = useState([])
  const [compras, setCompras] = useState([])            // as últimas compras (histórico, preço anterior, itens do fornecedor, duplicada)
  const [carregando, setCarregando] = useState(true)

  const [fornecedor, setFornecedor] = useState(rascunho?.fornecedor ?? '')
  const [fornAberto, setFornAberto] = useState(false)
  const [numeroNota, setNumeroNota] = useState(rascunho?.numeroNota ?? '')
  const [observacao, setObservacao] = useState(rascunho?.observacao ?? '')
  const [data, setData] = useState(rascunho?.data ?? hojeISO())
  const [modoPag, setModoPag] = useState(rascunho?.modoPag ?? 'avista')   // 'avista' | 'prazo' | 'parcelado'
  const [forma, setForma] = useState(rascunho?.forma ?? 'pix')
  const [vencimento, setVencimento] = useState(rascunho?.vencimento ?? maisDias(hojeISO(), 7))
  const [vencMexido, setVencMexido] = useState(rascunho?.vencMexido ?? false)
  const [nParc, setNParc] = useState(rascunho?.nParc ?? 2)
  const [parcDatas, setParcDatas] = useState(rascunho?.parcDatas ?? {})  // datas das parcelas que a pessoa mexeu
  const [linhas, setLinhas] = useState(rascunho?.linhas ?? [])
  const [totalNota, setTotalNota] = useState(rascunho?.totalNota ?? '')
  const [catConta, setCatConta] = useState(rascunho?.catConta ?? '')     // '' = automática
  const [editandoId, setEditandoId] = useState(rascunho?.editandoId ?? null)   // compra sendo corrigida
  const [recuperado, setRecuperado] = useState(!!(rascunho && (rascunho.linhas.length || rascunho.fornecedor)))
  const [busca, setBusca] = useState('')
  const [sel, setSel] = useState(0)                      // resultado destacado da busca (setas + Enter)
  const [novo, setNovo] = useState(null)                // cadastro rápido de MATÉRIA-PRIMA aberto
  const [saldos, setSaldos] = useState(new Map())      // 'produto:id' / 'materia:id' → quantidade em estoque hoje
  const [apelidos, setApelidos] = useState([])          // ligações nome-da-nota → item
  const [ligando, setLigando] = useState(null)          // { texto, q } = escolhendo a que item ligar
  const [aberta, setAberta] = useState(null)            // compra aberta no histórico
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const [ok, setOk] = useState(null)

  const buscaRef = useRef(null)
  const qtdRefs = useRef({})
  const [foco, setFoco] = useState(null)
  const registraQtd = useCallback((key, el) => { qtdRefs.current[key] = el }, [])

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setCarregando(true)
    try {
      const [pr, mp, ap, fo, hi, ct, ape, sp, sm] = await Promise.all([
        fetchAll(() => supabase.from('produtos')
          .select('id, nome, preco_custo, categoria, codigo_barras, controla_estoque, unidades_por_caixa, estoque_minimo')
          .eq('empresa_id', empresaId).eq('ativo', true).is('arquivado_em', null).order('nome').order('id')),
        fetchAll(() => supabase.from('materias_primas')
          .select('id, nome, unidade, custo, estoque_minimo').eq('empresa_id', empresaId).eq('ativo', true).order('nome').order('id')),
        supabase.from('categoria_item_aprendida').select('termo, categoria').eq('empresa_id', empresaId).limit(2000),
        supabase.from('fornecedores').select('id, nome').eq('empresa_id', empresaId).eq('ativo', true).order('nome').limit(1000),
        supabase.from('compras_lancadas')
          .select('id, fornecedor, data, total, pago, status, itens, created_at, numero_nota, observacao')
          .eq('empresa_id', empresaId).order('created_at', { ascending: false }).limit(200),
        supabase.from('categorias').select('nome, ordem').eq('empresa_id', empresaId).order('ordem'),
        supabase.from('item_apelidos').select('apelido, apelido_norm, tipo, item_id').eq('empresa_id', empresaId).limit(5000),
        fetchAll(() => supabase.from('estoque_saldo').select('produto_id, quantidade_atual').order('produto_id')),
        fetchAll(() => supabase.from('materia_prima_saldo').select('materia_prima_id, quantidade_atual').order('materia_prima_id')),
      ])
      if (pr.error) throw pr.error
      if (mp.error) throw mp.error
      setProdutos(pr.data || [])
      setApelidos(ape.data || [])
      const sd = new Map()
      for (const x of (sp.error ? [] : sp.data || [])) sd.set(`produto:${x.produto_id}`, Number(x.quantidade_atual) || 0)
      for (const x of (sm.error ? [] : sm.data || [])) sd.set(`materia:${x.materia_prima_id}`, Number(x.quantidade_atual) || 0)
      setSaldos(sd)
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
      setCompras(hi.data || [])
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

  // ── a linha da nota ─────────────────────────────────────────────────────
  // `extra` deixa quem chama (itens do fornecedor, corrigir compra) já trazer qtd/embalagem/valor.
  const novaLinha = useCallback((item, extra = {}) => {
    const key = `${item.tipo}:${item.id}`
    const porCxOrig = item.tipo === 'produto' ? Math.max(1, Number(item.porCx) || 1) : 1
    const emb = extra.emb || 'un'
    const custoCad = Number(item.custo) || 0
    const custoPadrao = emb === 'cx' ? custoCad * (num(extra.porCx) || porCxOrig) : custoCad
    return {
      key, tipo: item.tipo, id: item.id, nome: item.nome, unidade: item.unidade || 'un',
      estoque: item.tipo === 'materia' ? true : item.controla_estoque !== false,
      emb, porCx: String(extra.porCx || porCxOrig), porCxOrig,
      qtd: extra.qtd && num(extra.qtd) > 0 ? String(extra.qtd).replace('.', ',') : '1',
      custo: extra.custo !== undefined ? String(extra.custo).replace('.', ',') : (custoPadrao ? String(r2(custoPadrao * 100) / 100).replace('.', ',') : ''),
      total: extra.total ?? null,
      apelido: item.via || item.apelido || null,      // o nome como veio na nota, se foi ligado
      saldo: extra.saldo ?? saldos.get(key) ?? 0, custoAtual: extra.custoAtual ?? custoCad, minimo: Number(item.minimo) || 0,
      // Produto de revenda: manda a categoria do catálogo (Picolé, Sucos…). Matéria-prima não tem
      // categoria de venda, então fica com o palpite entre os tipos de gasto.
      cat: extra.cat || aprendidas[chaveDoItem(item.nome)]
        || (item.tipo === 'produto' && item.categoria && norm(item.categoria) !== 'outros' ? item.categoria : palpiteDaCategoria(item.nome, item.categoria)),
    }
  }, [aprendidas, saldos])

  const poeItem = useCallback((item, extra) => {
    setOk(null)
    const key = `${item.tipo}:${item.id}`
    setLinhas(prev => (prev.some(l => l.key === key) ? prev : [...prev, novaLinha(item, extra)]))
    setFoco(key)
    setBusca('')
  }, [novaLinha])

  const doProduto = (x) => ({ tipo: 'produto', id: x.id, nome: x.nome, custo: x.preco_custo, categoria: x.categoria, controla_estoque: x.controla_estoque, porCx: x.unidades_por_caixa, minimo: x.estoque_minimo })
  const daMateria = (x) => ({ tipo: 'materia', id: x.id, nome: x.nome, custo: x.custo, unidade: x.unidade, minimo: x.estoque_minimo })

  // Leitor de código de barras (USB é teclado) funciona aqui também, igual à Entrada de estoque.
  useEffect(() => {
    if (!produtos.length) return
    return ouvirBipada((codigo) => {
      const p = acharPorCodigo(produtos, codigo)
      if (p) poeItem(doProduto(p))
      else setErro(`Código ${codigo} não está em nenhum produto.`)
    })
  }, [produtos, poeItem])

  const paraItem = useCallback((tipo, id) => {
    if (tipo === 'produto') { const x = produtos.find(q => q.id === id); return x && doProduto(x) }
    const x = materias.find(q => q.id === id)
    return x && daMateria(x)
  }, [produtos, materias])

  // Ligações que combinam com o que foi digitado vêm PRIMEIRO: se a loja já disse que
  // "coca cola lata zero" é a Coca zero lata, é ela que tem que aparecer no topo.
  const ligados = useMemo(() => {
    const t = normApelido(busca)
    if (!t) return []
    return apelidos.filter(a => a.apelido_norm.includes(t) || t.includes(a.apelido_norm))
      .map(a => { const it = paraItem(a.tipo, a.item_id); return it && { ...it, via: a.apelido, exato: a.apelido_norm === t } })
      .filter(Boolean)
  }, [busca, apelidos, paraItem])

  const procura = useCallback((texto) => {
    const t = norm(texto).trim()
    if (!t) return []
    // Quem COMEÇA com o que foi digitado vem primeiro; depois quem tem uma palavra começando assim; por último
    // quem só contém ("coca" achava "Chocolate com Paçoca" antes da Coca-Cola).
    const rank = (nome) => { const n = norm(nome); return n.startsWith(t) ? 0 : n.split(/\s+/).some(w => w.startsWith(t)) ? 1 : 2 }
    const p = produtos.filter(x => norm(x.nome).includes(t) || combinaCodigo(x, texto)).map(doProduto)
    const m = materias.filter(x => norm(x.nome).includes(t)).map(daMateria)
    return [...m, ...p].map((x, i) => ({ x, r: rank(x.nome), i })).sort((a, b) => a.r - b.r || a.i - b.i).map(o => o.x)
  }, [produtos, materias])

  const achados = useMemo(() => {
    const vistos = new Set(ligados.map(a => `${a.tipo}:${a.id}`))
    return [...ligados, ...procura(busca).filter(a => !vistos.has(`${a.tipo}:${a.id}`))].slice(0, 10)
  }, [busca, ligados, procura])

  const achadosLigar = useMemo(() => (ligando ? procura(ligando.q).slice(0, 8) : []), [ligando, procura])

  // Setas escolhem, Enter põe o destacado (começa no primeiro), Esc limpa. Dá pra lançar uma nota
  // inteira sem tirar a mão do teclado.
  function teclaBusca(e) {
    if (e.key === 'Escape') { setBusca(''); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, Math.max(0, achados.length - 1))); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); return }
    if (e.key !== 'Enter') return
    e.preventDefault()
    const por = acharPorCodigo(produtos, busca)
    if (por) return poeItem(doProduto(por))
    const alvo = achados[Math.min(sel, achados.length - 1)]
    if (alvo && !linhas.some(l => l.key === `${alvo.tipo}:${alvo.id}`)) poeItem(alvo)
  }

  // Liga o nome da nota ao item e já põe na nota. Fica guardado: na próxima vez, o nome já é conhecido.
  async function ligarA(item) {
    if (!ligando) return
    setErro(null)
    const texto = ligando.texto.trim()
    const chave = normApelido(texto)
    if (!chave) return
    const { error } = await supabase.from('item_apelidos').upsert(
      { empresa_id: empresaId, apelido: texto, apelido_norm: chave, tipo: item.tipo, item_id: item.id },
      { onConflict: 'empresa_id,apelido_norm' })
    if (error) { setErro(recadoDeErro(error, 'guardar a ligação')); return }
    setApelidos(a => [...a.filter(x => x.apelido_norm !== chave), { apelido: texto, apelido_norm: chave, tipo: item.tipo, item_id: item.id }])
    setLigando(null)
    poeItem({ ...item, apelido: texto })
  }

  async function desligar(l) {
    if (!l.apelido) return
    const chave = normApelido(l.apelido)
    const { error } = await supabase.from('item_apelidos').delete().eq('empresa_id', empresaId).eq('apelido_norm', chave)
    if (error) { setErro(recadoDeErro(error, 'desfazer a ligação')); return }
    setApelidos(a => a.filter(x => x.apelido_norm !== chave))
    mudar(l.key, 'apelido', null)
  }

  // Preço do mesmo item na ÚLTIMA compra lançada (ou o custo do cadastro, se nunca foi comprado por aqui).
  const ultimoPreco = useMemo(() => {
    const m = new Map()
    for (const c of compras) {
      if (c.status !== 'lancada') continue
      for (const it of (c.itens || [])) {
        const k = `${it.tipo}:${it.id}`
        if (!m.has(k) && Number(it.custo_unit) > 0) m.set(k, { preco: Number(it.custo_unit), data: c.data, fornecedor: c.fornecedor })
      }
    }
    return m
  }, [compras])

  // O que a loja já comprou de cada fornecedor (mais comprados primeiro), com a última quantidade e o último preço.
  const itensDoFornecedor = useMemo(() => {
    const t = norm(fornecedor).trim()
    if (!t) return []
    const m = new Map()
    for (const c of compras) {
      if (c.status !== 'lancada' || norm(c.fornecedor).trim() !== t) continue
      for (const it of (c.itens || [])) {
        const k = `${it.tipo}:${it.id}`
        if (!m.has(k)) m.set(k, { k, it, vezes: 0 })
        m.get(k).vezes += 1
      }
    }
    return [...m.values()].sort((a, b) => b.vezes - a.vezes).slice(0, 14)
  }, [compras, fornecedor])

  function mudar(key, campo, valor) {
    setLinhas(prev => prev.map(l => {
      if (l.key !== key) return l
      const n = { ...l, [campo]: valor }
      // O valor da linha é o que o papel diz. Se foi digitado o total, ele manda e o unitário
      // se acerta; se foi digitado o unitário, o total volta a ser conta.
      if (campo === 'custo') n.total = null
      if (campo === 'total') n.custo = num(valor) > 0 && num(l.qtd) > 0 ? String(Math.round(num(valor) / num(l.qtd) * 10000) / 10000).replace('.', ',') : ''
      if (campo === 'qtd' && l.total !== null && num(valor) > 0) n.custo = String(Math.round(num(l.total) / num(valor) * 10000) / 10000).replace('.', ',')
      if (campo === 'porCx' && l.emb === 'cx') n.total = l.total   // o total digitado continua valendo
      return n
    }))
  }
  // Trocar entre unidade e caixa muda o que cada campo significa: recomeça a linha em 1 e no custo do cadastro.
  function trocaEmb(l, emb) {
    if (l.emb === emb) return
    const por = Math.max(1, num(l.porCx))
    const c = emb === 'cx' ? l.custoAtual * por : l.custoAtual
    setLinhas(prev => prev.map(x => (x.key === l.key ? { ...x, emb, qtd: '1', total: null, custo: c ? String(r2(c * 100) / 100).replace('.', ',') : '' } : x)))
  }
  const tirar = (key) => setLinhas(prev => prev.filter(l => l.key !== key))

  // Versões ESTÁVEIS dos manipuladores: o React.memo da linha só funciona se a função não mudar a cada tecla.
  const fns = useRef({})
  useEffect(() => { fns.current = { mudar, trocaEmb, tirar, desligar, trocaCategoria } })
  const hMudar = useCallback((...a) => fns.current.mudar(...a), [])
  const hTrocaEmb = useCallback((...a) => fns.current.trocaEmb(...a), [])
  const hTirar = useCallback((...a) => fns.current.tirar(...a), [])
  const hDesligar = useCallback((...a) => fns.current.desligar(...a), [])
  const hTrocaCategoria = useCallback((...a) => fns.current.trocaCategoria(...a), [])

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
      const { data: d, error } = await supabase.from('materias_primas')
        .insert({ empresa_id: empresaId, nome, unidade: novo.unidade, custo: num(novo.custo), estoque_minimo: num(novo.minimo) })
        .select('id, nome, unidade, custo, estoque_minimo').single()
      if (error) throw error
      setMaterias(m => [...m, d])
      poeItem({ tipo: 'materia', id: d.id, nome: d.nome, custo: d.custo, unidade: d.unidade, minimo: d.estoque_minimo }, { qtd: novo.qtd })
      setNovo(null)
    } catch (e) {
      setErro(recadoDeErro(e, 'cadastrar o item'))
    }
  }

  // ── totais e rateio ─────────────────────────────────────────────────────
  const soma = r2(linhas.reduce((s, l) => s + valorLinha(l), 0))
  const total = totalNota.trim() === '' ? soma : r2(num(totalNota))
  const diferenca = r2(total - soma)

  // A conta é UMA (ou uma por parcela), e o detalhe vive no rateio: quanto foi pra cada categoria. A
  // diferença entre a nota e a soma dos itens é frete (se sobra) ou desconto (se falta) — nunca some nem inventa.
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

  // Parcelas: o total dividido igual (a última leva a sobra), vencendo de mês em mês a partir da primeira.
  const parcelas = useMemo(() => {
    if (modoPag !== 'parcelado' || total <= 0) return []
    const base = Math.floor((total / nParc) * 100) / 100
    return Array.from({ length: nParc }, (_, i) => ({
      vencimento: parcDatas[i] || somaMeses(vencimento, i),
      valor: i === nParc - 1 ? r2(total - base * (nParc - 1)) : base,
    }))
  }, [modoPag, total, nParc, vencimento, parcDatas])

  const categoriaDaConta = catConta || rateio[0]?.categoria || 'Fornecedores'
  const nProdutos = linhas.filter(l => l.tipo === 'produto').length
  const nMaterias = linhas.filter(l => l.tipo === 'materia').length
  const semQtd = linhas.some(l => qtdReal(l) <= 0)
  const semPreco = linhas.some(l => valorLinha(l) <= 0)
  const podeLancar = !salvando && linhas.length > 0 && fornecedor.trim() && total > 0 && !semQtd

  // ── avisos que evitam erro ──────────────────────────────────────────────
  // Mesma compra já lançada? (mesmo fornecedor e mesmo valor, até 3 dias de diferença)
  const duplicada = useMemo(() => {
    if (!fornecedor.trim() || total <= 0) return null
    const t = norm(fornecedor).trim()
    return compras.find(c => c.status === 'lancada' && c.id !== editandoId && norm(c.fornecedor).trim() === t
      && Math.abs(Number(c.total) - total) < 0.01 && Math.abs(new Date(c.data) - new Date(data)) <= 3 * 86400000) || null
  }, [compras, fornecedor, total, data, editandoId])
  const totalEstranho = totalNota.trim() !== '' && soma > 0 && Math.abs(diferenca) > Math.max(20, soma * 0.1)

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

  // ── rascunho: a nota em andamento sobrevive a F5, aba fechada e queda de internet ──
  useEffect(() => {
    if (!empresaId) return
    const temAlgo = linhas.length > 0 || fornecedor.trim() || numeroNota.trim() || observacao.trim()
    const t = setTimeout(() => {
      try {
        if (!temAlgo) localStorage.removeItem(chaveRascunho(empresaId))
        else localStorage.setItem(chaveRascunho(empresaId), JSON.stringify({
          fornecedor, numeroNota, observacao, data, modoPag, forma, vencimento, vencMexido, nParc, parcDatas,
          linhas, totalNota, catConta, editandoId, salvoEm: new Date().toISOString(),
        }))
      } catch { /* sem storage (janela anônima): segue sem rascunho */ }
    }, 400)
    return () => clearTimeout(t)
  }, [empresaId, fornecedor, numeroNota, observacao, data, modoPag, forma, vencimento, vencMexido, nParc, parcDatas, linhas, totalNota, catConta, editandoId])

  function limpar() {
    setLinhas([]); setTotalNota(''); setCatConta(''); setFornecedor(''); setNumeroNota(''); setObservacao('')
    // O pagamento volta pra "Pago agora": parcelar é a exceção, e uma compra parcelada sem querer é dinheiro errado.
    setModoPag('avista')
    setData(hojeISO()); setVencimento(maisDias(hojeISO(), 7)); setVencMexido(false); setNParc(2); setParcDatas({})
    setEditandoId(null); setRecuperado(false); setBusca(''); setNovo(null); setLigando(null)
    try { localStorage.removeItem(chaveRascunho(empresaId)) } catch { /* ignora */ }
  }

  // Monta o pacote que o banco recebe. Também serve pra mostrar o resumo depois de lançar.
  function pacote(nomeForn) {
    const itens = linhas.map(l => {
      const q = qtdReal(l)
      const un = unitReal(l)
      return {
        tipo: l.tipo, id: l.id, nome: l.nome, quantidade: q, estoque: l.estoque,
        custo_unit: un > 0 ? Math.round(un * 10000) / 10000 : null,
        categoria: l.cat, descricao_nota: l.apelido || null,
        // pra CORRIGIR depois: o que foi digitado, do jeito que foi digitado
        emb: l.emb, por_caixa: l.emb === 'cx' ? num(l.porCx) : null, qtd_digitada: num(l.qtd), linha_total: valorLinha(l),
      }
    })
    return {
      fornecedor: nomeForn, data, vencimento, pago: modoPag === 'avista', forma: modoPag === 'avista' ? forma : null,
      categoria: categoriaDaConta, total, rateio, itens, numero_nota: numeroNota.trim(), observacao: observacao.trim(),
      ...(modoPag === 'parcelado' ? { parcelas } : {}),
    }
  }

  async function lancar() {
    if (!podeLancar) return
    if (duplicada && !confirm(`Já existe uma compra de ${duplicada.fornecedor} de ${brl(duplicada.total)} em ${ddmm(duplicada.data)}.\n\nLançar mesmo assim?`)) return
    setSalvando(true)
    setErro(null)
    setOk(null)
    try {
      // Digitou um nome e não clicou em "cadastrar"? Cadastra agora — a compra não pode criar fornecedor fantasma.
      let nomeForn = fornecedor.trim()
      if (!fornExato) { const d = await cadastrarFornecedor(nomeForn); if (d) nomeForn = d.nome }
      const p = pacote(nomeForn)
      const resumoItens = linhas.map(l => {
        const cm = custoMedio(l)
        return { nome: l.nome, tipo: l.tipo, unidade: l.unidade, antes: l.saldo, depois: l.saldo + qtdReal(l), custo: cm?.novo ?? null, entrou: qtdReal(l), estoque: l.estoque }
      })
      const { error } = editandoId
        ? await supabase.rpc('corrigir_compra', { p_id: editandoId, p })
        : await supabase.rpc('lancar_compra', { p })
      if (error) throw error
      // Lembra quantas unidades tem a caixa daquele produto (só quando a pessoa informou outro número).
      for (const l of linhas) {
        if (l.tipo === 'produto' && l.emb === 'cx' && num(l.porCx) > 1 && num(l.porCx) !== l.porCxOrig) {
          await supabase.from('produtos').update({ unidades_por_caixa: Math.round(num(l.porCx)) }).eq('id', l.id)
        }
      }
      setOk({
        fornecedor: nomeForn, total, pago: modoPag === 'avista', vencimento, nParcelas: modoPag === 'parcelado' ? parcelas.length : 0,
        corrigida: !!editandoId, itens: resumoItens, dataCompra: data,
      })
      limpar()
      await carregar()
      buscaRef.current?.focus()
    } catch (e) {
      setErro(recadoDeErro(e, editandoId ? 'corrigir a compra' : 'lançar a compra'))
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

  // CORRIGIR: traz a compra de volta pra tela, do jeito que foi digitada. A compra antiga só some quando
  // a nova for lançada (corrigir_compra, numa transação). Desistiu? É só cancelar — nada mudou no banco.
  async function corrigir(c) {
    if (linhas.length && !confirm('Você tem uma compra em andamento na tela. Trocar por esta que vai ser corrigida?')) return
    setErro(null)
    const { data: reg, error } = await supabase.from('compras_lancadas').select('payload, itens, fornecedor, data, pago, total').eq('id', c.id).maybeSingle()
    if (error || !reg) { setErro(recadoDeErro(error, 'abrir a compra')); return }
    const pl = reg.payload || {}
    // Os itens do REGISTRO (não do pacote original) trazem o que o banco gravou: movimento, custo antes/depois.
    const itens = reg.itens || pl.itens || []
    const novas = []
    const perdidos = []
    for (const it of itens) {
      const base = paraItem(it.tipo, it.id)
      if (!base) { perdidos.push(it.nome); continue }
      const cx = it.emb === 'cx'
      const qtdDig = it.qtd_digitada ?? it.quantidade
      const lt = it.linha_total ?? (Number(it.quantidade) * Number(it.custo_unit || 0))
      const custoDig = qtdDig > 0 ? Math.round((lt / qtdDig) * 10000) / 10000 : 0
      // Se qtd × valor já dá o total, deixa a linha "solta" (mudar a quantidade muda o total). Só trava o total
      // digitado quando o arredondamento não fecha com a nota.
      const travado = Math.abs(r2(qtdDig * custoDig) - lt) > 0.005
      // A base de estoque/custo é a de ANTES desta compra: a correção desfaz a antiga primeiro.
      const atual = saldos.get(`${it.tipo}:${it.id}`) ?? 0
      const saldoBase = it.mov_id ? atual - Number(it.quantidade) : atual
      const custoHoje = Number(base.custo) || 0
      const custoBase = it.custo_antes != null && Number(it.custo_depois) === custoHoje ? Number(it.custo_antes) : custoHoje
      novas.push(novaLinha({ ...base, apelido: it.descricao_nota || null }, {
        emb: cx ? 'cx' : 'un', porCx: cx ? it.por_caixa : undefined, qtd: qtdDig, cat: it.categoria,
        custo: custoDig, total: travado && lt > 0 ? String(lt).replace('.', ',') : null,
        saldo: saldoBase, custoAtual: custoBase,
      }))
    }
    if (!novas.length) { setErro('Não consegui reabrir essa compra: os itens dela não existem mais no cadastro.'); return }
    const soma0 = r2(novas.reduce((s, l) => s + valorLinha(l), 0))
    setLinhas(novas)
    setFornecedor(reg.fornecedor)
    setNumeroNota(pl.numero_nota || c.numero_nota || '')
    setObservacao(pl.observacao || c.observacao || '')
    setData(reg.data)
    const parcelado = Array.isArray(pl.parcelas) && pl.parcelas.length > 1
    setModoPag(reg.pago ? 'avista' : parcelado ? 'parcelado' : 'prazo')
    setForma(pl.forma || 'pix')
    setVencimento(parcelado ? pl.parcelas[0].vencimento : (pl.vencimento || maisDias(reg.data, 7)))
    setVencMexido(true)
    if (parcelado) { setNParc(pl.parcelas.length); setParcDatas(Object.fromEntries(pl.parcelas.map((x, i) => [i, x.vencimento]))) }
    else { setNParc(2); setParcDatas({}) }
    setTotalNota(Math.abs(Number(reg.total) - soma0) > 0.005 ? String(reg.total).replace('.', ',') : '')
    const rat = Array.isArray(pl.rateio) ? pl.rateio : []
    setCatConta(rat.length === 1 && novas.some(l => l.cat !== rat[0].categoria) ? rat[0].categoria : '')
    setEditandoId(c.id)
    setRecuperado(false)
    setOk(null)
    if (perdidos.length) setErro(`Estes itens não existem mais no cadastro e ficaram de fora: ${perdidos.join(', ')}. Confira antes de lançar.`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  const hoje = hojeISO()
  const historico = compras.slice(0, 15)

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>Lançar compra</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Digite a nota uma vez só. Cada item vai pro estoque certo e o total vira a conta a pagar.
        </div>
      </div>

      {erro && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} role="alert">{erro}</div>}

      {ok && (
        <div className="card" style={{ borderColor: '#22c55e' }} role="status">
          <div>
            ✅ Compra {ok.corrigida ? 'corrigida' : 'lançada'} — <strong>{ok.fornecedor}</strong>, {brl(ok.total)}.{' '}
            {ok.pago ? 'Conta registrada como paga.' : ok.nParcelas > 1 ? `Conta a pagar em ${ok.nParcelas} parcelas.` : `Conta a pagar, vence ${ddmm(ok.vencimento)}.`}
          </div>
          <ul style={{ margin: '8px 0 0', padding: '0 0 0 18px', fontSize: 13, color: 'var(--text-muted)' }}>
            {ok.itens.map(i => (
              <li key={i.nome}>
                <strong style={{ color: 'var(--text)' }}>{i.nome}</strong>:{' '}
                {i.estoque ? <>estoque {qtdTxt(i.antes)} → <strong>{qtdTxt(i.depois)}</strong> {i.unidade}</> : 'só na conta'}
                {i.custo ? <> · custo {brl(i.custo)}</> : null}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setParams({ aba: 'lucro', sub: 'contas' })}>Ver em Contas a pagar</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setParams({ aba: 'lucro', sub: 'estoque' })}>Ver no histórico de estoque</button>
          </div>
        </div>
      )}

      {editandoId && (
        <div className="card" style={{ borderColor: '#d97706', background: 'var(--warning-bg, #fef3c7)' }}>
          ✏️ <strong>Corrigindo uma compra já lançada.</strong> Ao lançar, ela <strong>substitui</strong> a antiga (estoque, custo e conta, de uma vez).
          Se desistir, é só cancelar — nada mudou ainda.{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={limpar}>Cancelar correção</button>
        </div>
      )}
      {recuperado && !editandoId && (
        <div className="card" style={{ borderColor: '#2563eb' }}>
          📝 Recuperei a compra que você estava digitando{rascunho?.salvoEm ? ` (salva às ${new Date(rascunho.salvoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})` : ''}.{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={limpar}>Descartar e começar do zero</button>
        </div>
      )}

      {/* 1. a nota */}
      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          <div style={{ position: 'relative' }}>
            <label style={lbl} htmlFor="lc-forn">Fornecedor</label>
            <input id="lc-forn" value={fornecedor} onChange={e => { setFornecedor(e.target.value); setFornAberto(true) }}
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
            <label style={lbl} htmlFor="lc-nf">Nº da nota (NF)</label>
            <input id="lc-nf" value={numeroNota} onChange={e => setNumeroNota(e.target.value)} placeholder="opcional" style={{ ...inp, width: '100%' }} />
          </div>
          <div>
            <label style={lbl} htmlFor="lc-data">Data da compra</label>
            <input id="lc-data" type="date" value={data} max={hoje} onChange={e => aoMudarData(e.target.value)} style={{ ...inp, width: '100%' }} />
            {data < hoje && <div style={{ fontSize: 11.5, marginTop: 3, color: 'var(--text-muted)' }}>Entra no estoque como {ddmm(data)}.</div>}
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={lbl}>Pagamento</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['avista', 'Pago agora'], ['prazo', 'A prazo (1 vencimento)'], ['parcelado', 'Parcelado']].map(([v, t]) => (
              <button key={v} type="button" onClick={() => setModoPag(v)} aria-pressed={modoPag === v}
                style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  background: modoPag === v ? 'var(--primary)' : 'transparent', color: modoPag === v ? '#fff' : 'var(--text)' }}>
                {t}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, alignItems: 'flex-end' }}>
            {modoPag === 'avista' && (
              <div>
                <label style={lbl} htmlFor="lc-forma">Forma</label>
                <select id="lc-forma" value={forma} onChange={e => setForma(e.target.value)} style={{ ...inp, minWidth: 170 }}>
                  {FORMAS.map(([id, t]) => <option key={id} value={id}>{t}</option>)}
                </select>
              </div>
            )}
            {modoPag === 'prazo' && (
              <div>
                <label style={lbl} htmlFor="lc-venc">Vence em</label>
                <input id="lc-venc" type="date" value={vencimento} onChange={e => { setVencimento(e.target.value); setVencMexido(true) }} style={inp} />
              </div>
            )}
            {modoPag === 'parcelado' && (
              <>
                <div>
                  <label style={lbl} htmlFor="lc-np">Parcelas</label>
                  <select id="lc-np" value={nParc} onChange={e => { setNParc(Number(e.target.value)); setParcDatas({}) }} style={inp}>
                    {Array.from({ length: 11 }, (_, i) => i + 2).map(n => <option key={n} value={n}>{n}x</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl} htmlFor="lc-venc1">1ª parcela vence em</label>
                  <input id="lc-venc1" type="date" value={vencimento} onChange={e => { setVencimento(e.target.value); setVencMexido(true); setParcDatas({}) }} style={inp} />
                </div>
              </>
            )}
          </div>
          {modoPag === 'parcelado' && parcelas.length > 0 && (
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
              {parcelas.map((pc, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}>
                  <strong>{i + 1}/{parcelas.length}</strong>
                  <input type="date" value={pc.vencimento} aria-label={`Vencimento da parcela ${i + 1}`}
                    onChange={e => setParcDatas(d => ({ ...d, [i]: e.target.value }))} style={{ ...inp, padding: '4px 6px', fontSize: 13 }} />
                  <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{brl(pc.valor)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 2. os itens */}
      <div className="card">
        <label style={{ ...lbl, fontSize: 13, color: 'var(--text)' }} htmlFor="lc-busca">Adicionar item (produto ou matéria-prima)</label>
        <input id="lc-busca" ref={buscaRef} value={busca} onChange={e => { setBusca(e.target.value); setNovo(null); setLigando(null); setSel(0) }} onKeyDown={teclaBusca}
          disabled={carregando} placeholder="Digite o nome ou passe o leitor… (↑↓ escolhe, Enter adiciona)" autoComplete="off"
          style={{ width: '100%', fontSize: 16, padding: '12px 14px' }} />

        {!busca.trim() && itensDoFornecedor.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
              Você costuma comprar de {fornecedor.trim()} — toque pra adicionar:
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {itensDoFornecedor.map(({ k, it }) => {
                const ja = linhas.some(l => l.key === k)
                const base = paraItem(it.tipo, it.id)
                if (!base) return null
                return (
                  <button key={k} type="button" disabled={ja} className="btn btn-secondary btn-sm"
                    title={`Última vez: ${qtdTxt(it.quantidade)} a ${brl(it.custo_unit)}`}
                    onClick={() => {
                      const cx = it.emb === 'cx'
                      const qd = it.qtd_digitada ?? it.quantidade
                      const lt = it.linha_total
                      poeItem({ ...base, apelido: it.descricao_nota || null }, {
                        emb: cx ? 'cx' : 'un', porCx: cx ? it.por_caixa : undefined, qtd: qd, cat: it.categoria,
                        custo: cx && qd > 0 && lt ? Math.round((lt / qd) * 10000) / 10000 : (it.custo_unit ?? undefined),
                      })
                    }}
                    style={{ fontSize: 12.5, opacity: ja ? 0.5 : 1 }}>
                    {ja ? '✓ ' : '+ '}{it.nome}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {busca.trim() && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {achados.map((a, idx) => {
              const ja = linhas.some(l => l.key === `${a.tipo}:${a.id}`)
              const destaque = idx === Math.min(sel, achados.length - 1)
              return (
                <button key={`${a.tipo}:${a.id}`} type="button" className="btn btn-secondary" disabled={ja}
                  onClick={() => poeItem(a)} onMouseEnter={() => setSel(idx)} data-destaque={destaque ? 'sim' : undefined}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left', padding: '10px 12px',
                    outline: destaque ? '2px solid var(--primary)' : 'none', outlineOffset: -2 }}>
                  <span>{a.via && <span title="ligação salva">🔗 </span>}{a.nome}{a.via && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}> (na nota: “{a.via}”)</span>}{ja ? ' — já está na nota' : ''}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, ...tagTipo(a.tipo) }}>
                    {a.tipo === 'materia' ? `Matéria-prima · ${a.unidade}` : 'Produto'}
                  </span>
                </button>
              )
            })}
            {!novo && !ligando && (
              <>
                <button type="button" className="btn btn-secondary"
                  onClick={() => setLigando({ texto: busca.trim(), q: '' })}
                  style={{ textAlign: 'left', padding: '10px 12px', borderStyle: 'dashed' }}>
                  🔗 “{busca.trim()}” é um item que já existe com outro nome — ligar
                </button>
                <button type="button" className="btn btn-secondary"
                  onClick={() => setNovo({ nome: busca.trim(), unidade: 'kg', qtd: '', custo: '', minimo: '' })}
                  style={{ textAlign: 'left', padding: '10px 12px', borderStyle: 'dashed' }}>
                  ➕ Cadastrar “{busca.trim()}” como matéria-prima nova
                </button>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Produto novo se cadastra em Produtos. Aqui você só traz o que já está no cardápio.
                </div>
              </>
            )}

            {ligando && (
              <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 13.5 }}>
                  Na nota veio: <strong>“{ligando.texto}”</strong>. Qual item seu é esse?
                </div>
                <input autoFocus value={ligando.q} onChange={e => setLigando({ ...ligando, q: e.target.value })}
                  placeholder="Busque o item do cardápio ou do estoque (ex.: coca zero)" style={{ ...inp, width: '100%' }} />
                {achadosLigar.map(a => (
                  <button key={`${a.tipo}:${a.id}`} type="button" className="btn btn-secondary" onClick={() => ligarA(a)}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, textAlign: 'left', padding: '10px 12px' }}>
                    <span>{a.nome}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, ...tagTipo(a.tipo) }}>
                      {a.tipo === 'materia' ? `Matéria-prima · ${a.unidade}` : 'Produto'}
                    </span>
                  </button>
                ))}
                {ligando.q.trim() && !achadosLigar.length && (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nenhum item com esse nome. Tente outra palavra.</div>
                )}
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  A ligação fica salva: da próxima vez que esse nome aparecer, já vem o item certo.
                </div>
                <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => setLigando(null)}>Cancelar</button></div>
              </div>
            )}

            {novo && (
              <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} style={inp} aria-label="Nome da matéria-prima" />
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div>
                    <label style={lbl}>Compra por</label>
                    <select value={novo.unidade} onChange={e => setNovo({ ...novo, unidade: e.target.value })} style={inp}>
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Quantidade que está entrando ({novo.unidade})</label>
                    <input inputMode="decimal" value={novo.qtd} placeholder="ex.: 2" onChange={e => setNovo({ ...novo, qtd: e.target.value })} style={{ ...inp, width: 150 }} />
                  </div>
                  <div>
                    <label style={lbl}>Valor pago por {novo.unidade} (R$)</label>
                    <input inputMode="decimal" value={novo.custo} placeholder="0,00" onChange={e => setNovo({ ...novo, custo: e.target.value })} style={{ ...inp, width: 130 }} />
                  </div>
                  <div>
                    <label style={lbl}>Avisar quando baixar de</label>
                    <input inputMode="decimal" value={novo.minimo} placeholder="opcional" onChange={e => setNovo({ ...novo, minimo: e.target.value })} style={{ ...inp, width: 130 }} />
                  </div>
                </div>
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
              <LinhaItem key={l.key} l={l} ult={ultimoPreco.get(l.key)} catalogoCats={catalogoCats}
                onMudar={hMudar} onTrocaEmb={hTrocaEmb} onTirar={hTirar} onDesligar={hDesligar} onTrocaCategoria={hTrocaCategoria}
                buscaRef={buscaRef} registraQtd={registraQtd} />
            ))}
          </div>
        )}

        {!linhas.length && !busca.trim() && !carregando && itensDoFornecedor.length === 0 && (
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
              <label style={lbl} htmlFor="lc-total">Total da nota (se for diferente da soma)</label>
              <input id="lc-total" inputMode="decimal" value={totalNota} placeholder={String(soma).replace('.', ',')}
                onChange={e => setTotalNota(e.target.value)} style={{ ...inp, width: '100%' }} />
              {diferenca !== 0 && total > 0 && (
                <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-muted)' }}>
                  {diferenca > 0 ? `+ ${brl(diferenca)} de frete/ajuste` : `− ${brl(-diferenca)} de desconto`}
                </div>
              )}
            </div>
            <div>
              <label style={lbl} htmlFor="lc-catconta">Categoria da conta</label>
              <select id="lc-catconta" value={catConta} onChange={e => setCatConta(e.target.value)} style={{ ...inp, width: '100%' }}>
                <option value="">Automática (pelos itens)</option>
                {CATEGORIAS_PAGAR.map(c => <option key={c} value={c}>Tudo em {c}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={lbl} htmlFor="lc-obs">Observação (opcional)</label>
            <input id="lc-obs" value={observacao} onChange={e => setObservacao(e.target.value)} placeholder="Ex.: combinado desconto no próximo pedido" style={{ ...inp, width: '100%' }} />
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
            <div>💸 Conta: {brl(total)} a <strong>{fornecedor.trim() || '—'}</strong>{numeroNota.trim() ? ` (NF ${numeroNota.trim()})` : ''} — {
              modoPag === 'avista' ? `paga ${data === hoje ? 'hoje' : `em ${ddmm(data)}`} (${(FORMAS.find(([i]) => i === forma) || [0, forma])[1]})`
                : modoPag === 'parcelado' ? `${parcelas.length}x, a 1ª vence ${ddmm(parcelas[0]?.vencimento || vencimento)}`
                  : `a pagar, vence ${ddmm(vencimento)}`}</div>
          </div>

          {duplicada && (
            <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 10, fontWeight: 700 }}>
              ⚠️ Parece repetida: já existe uma compra de {duplicada.fornecedor} de {brl(duplicada.total)} em {ddmm(duplicada.data)}.
            </div>
          )}
          {totalEstranho && (
            <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 10, fontWeight: 700 }}>
              ⚠️ O total da nota ({brl(total)}) está bem diferente da soma dos itens ({brl(soma)}). Confira se faltou item ou se digitou errado.
            </div>
          )}
          {semPreco && !semQtd && (
            <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 10 }}>
              ⚠️ Tem item sem valor. Ele entra no estoque, mas o custo do cadastro não é atualizado.
            </div>
          )}
          {semQtd && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>Tem item com quantidade zerada — ajuste ou tire da nota.</div>}
          {!fornecedor.trim() && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>Falta dizer o fornecedor.</div>}
          {fornecedor.trim() && !semQtd && total <= 0 && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 10 }}>Falta o valor da compra.</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={() => { if (confirm('Limpar a nota e começar do zero?')) limpar() }}>Limpar</button>
            <button className="btn btn-primary" onClick={lancar} disabled={!podeLancar} style={{ padding: '12px 22px', fontSize: 15 }}>
              {salvando ? 'Lançando…' : `${editandoId ? 'Salvar correção de' : 'Lançar compra de'} ${brl(total)}`}
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
            const abre = aberta === c.id
            return (
              <div key={c.id} style={{ borderTop: '1px solid var(--border)', opacity: desfeita ? 0.5 : 1 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setAberta(abre ? null : c.id)} aria-expanded={abre}
                    style={{ flex: '1 1 200px', minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', textDecoration: desfeita ? 'line-through' : 'none' }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{abre ? '▾' : '▸'} {c.fornecedor}{c.numero_nota ? ` · NF ${c.numero_nota}` : ''}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {ddmm(c.data)} · {(c.itens || []).length} {(c.itens || []).length === 1 ? 'item' : 'itens'} · {c.pago ? 'paga' : 'a prazo'}
                    </div>
                  </button>
                  <strong style={{ fontSize: 14 }}>{brl(c.total)}</strong>
                  {desfeita
                    ? <span style={{ fontSize: 12 }}>desfeita</span>
                    : (
                      <>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => corrigir(c)}>✏️ Corrigir</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => desfazer(c)}>↩ Desfazer</button>
                      </>
                    )}
                </div>
                {abre && (
                  <div style={{ padding: '0 0 12px 18px', fontSize: 13 }}>
                    {c.observacao && <div style={{ color: 'var(--text-muted)', marginBottom: 6 }}>📝 {c.observacao}</div>}
                    {(c.itens || []).map((it, i) => (
                      <div key={`${it.id}${i}`} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '4px 0', borderBottom: '1px dashed var(--border)' }}>
                        <span style={{ flex: '1 1 180px' }}>{it.nome}</span>
                        <span>{it.emb === 'cx' ? `${qtdTxt(it.qtd_digitada)} cx (${qtdTxt(it.quantidade)} un)` : `${qtdTxt(it.quantidade)} ${it.tipo === 'materia' ? '' : 'un'}`}</span>
                        <span>pago {it.custo_unit ? brl(it.custo_unit) : '—'}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{it.custo_depois ? `custo ficou ${brl(it.custo_depois)}` : ''}{it.saldo_antes != null && it.mov_id ? ` · estoque ${qtdTxt(it.saldo_antes)} → ${qtdTxt(Number(it.saldo_antes) + Number(it.quantidade))}` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
