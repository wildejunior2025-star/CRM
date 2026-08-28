import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { blocosDeOpcoes } from '../lib/complementos'
import { criarBuscadorDescricao } from '../lib/descricaoSabor'
import { useConfirmar } from '../hooks/useConfirmar'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './CategoriasComplemento.css'

// Normaliza pra busca: tira acento e deixa minúsculo ("frango" acha "Frangão").
const norm = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

// Painel pra vincular VÁRIOS produtos de uma vez à categoria: abre uma listinha
// com busca e caixinhas de seleção; marca quantos quiser e adiciona todos juntos.
function ProdutoMultiAdd({ produtos, disabled, onConfirm }) {
  const [aberto, setAberto] = useState(false)
  const [sel, setSel] = useState(() => new Set())
  const [q, setQ] = useState('')
  const filtrados = q ? produtos.filter(p => norm(p.nome).includes(norm(q))) : produtos

  function toggle(id) {
    setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function fechar() { setAberto(false); setSel(new Set()); setQ('') }
  function confirmar() {
    if (sel.size) onConfirm([...sel])
    fechar()
  }

  if (!aberto) {
    return (
      <button type="button" className="cc-input cc-add-select cc-add-btn" disabled={disabled} onClick={() => setAberto(true)}>
        + Adicionar a produtos…
      </button>
    )
  }
  const todosMarcados = filtrados.length > 0 && filtrados.every(p => sel.has(p.id))
  return (
    <div className="cc-multiadd">
      <div className="cc-multiadd-head">
        <input className="cc-input" autoFocus value={q} placeholder="Buscar produto…" onChange={e => setQ(e.target.value)} />
        <button type="button" className="cc-iconbtn" title="Fechar" onClick={fechar}>✕</button>
      </div>
      <div className="cc-multiadd-list">
        {filtrados.length === 0 && <p className="cc-empty">Nenhum produto encontrado.</p>}
        {filtrados.map(p => (
          <label key={p.id} className="cc-multiadd-item">
            <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
            <span>{p.nome}</span>
          </label>
        ))}
      </div>
      <div className="cc-multiadd-actions">
        <button type="button" className="btn btn-secondary btn-sm"
          onClick={() => setSel(todosMarcados ? new Set() : new Set(filtrados.map(p => p.id)))}>
          {todosMarcados ? 'Desmarcar todos' : 'Marcar todos'}
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!sel.size} onClick={confirmar}>
          Adicionar{sel.size ? ` ${sel.size}` : ''}
        </button>
      </div>
    </div>
  )
}

// Rótulo sugerido pra uma categoria do cardápio: a última palavra dela.
// "Pizzas Promoção" → "Promoção"; "Pizzas Tradicionais" → "Tradicionais".
// Vira o sufixo do sabor ("Mussarela (Promoção)") e o subtítulo na loja online.
function rotuloSugerido(categoria) {
  const partes = String(categoria || '').trim().split(/\s+/)
  return partes.length > 1 ? partes[partes.length - 1] : (partes[0] ?? '')
}

// Traz os sabores do próprio cardápio pra dentro da categoria de complemento.
// Sem isso, montar uma "Pizza 2 Sabores" seria digitar 30, 40 sabores na mão.
// Marca as categorias do cardápio (Pizzas Promoção, Tradicionais, Especiais…) e
// cada produto delas vira uma opção, já com o preço do cardápio.
function ImportarSabores({ produtos, disabled, onConfirm }) {
  const [aberto, setAberto] = useState(false)
  const [sel, setSel] = useState({})   // { categoria: rótulo }

  const categorias = useMemo(() => {
    const m = new Map()
    for (const p of produtos) {
      if (p.ativo === false) continue
      const c = (p.categoria || '').trim()
      if (!c) continue
      m.set(c, (m.get(c) ?? 0) + 1)
    }
    return [...m.entries()].map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => a.nome.localeCompare(b.nome))
  }, [produtos])

  function toggle(cat) {
    setSel(prev => {
      const n = { ...prev }
      if (cat.nome in n) delete n[cat.nome]
      else n[cat.nome] = rotuloSugerido(cat.nome)
      return n
    })
  }
  function fechar() { setAberto(false); setSel({}) }
  function confirmar() {
    const escolhas = Object.entries(sel).map(([categoria, rotulo]) => ({ categoria, rotulo: rotulo.trim() }))
    if (escolhas.length) onConfirm(escolhas)
    fechar()
  }

  if (!aberto) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 10, marginLeft: 8 }}
        disabled={disabled} onClick={() => setAberto(true)}
        title="Traz os produtos do cardápio como opções (ex.: os sabores de pizza)">
        ⬇ Trazer do cardápio
      </button>
    )
  }
  const qtdTotal = Object.keys(sel).reduce((s, c) => s + (categorias.find(x => x.nome === c)?.qtd ?? 0), 0)
  return (
    <div className="cc-multiadd" style={{ marginTop: 10 }}>
      <div className="cc-multiadd-head">
        <strong style={{ fontSize: 13 }}>Quais categorias do cardápio viram opções?</strong>
        <button type="button" className="cc-iconbtn" title="Fechar" onClick={fechar}>✕</button>
      </div>
      <p className="cc-empty" style={{ margin: '0 0 8px' }}>
        Cada produto vira uma opção com o preço do cardápio. O rótulo aparece entre parênteses no nome
        e separa os sabores em blocos na loja — deixe vazio pra não marcar de onde veio.
      </p>
      <div className="cc-multiadd-list">
        {categorias.length === 0 && <p className="cc-empty">Nenhuma categoria no cardápio ainda.</p>}
        {categorias.map(c => {
          const marcada = c.nome in sel
          return (
            <div key={c.nome} className="cc-multiadd-item" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={marcada} onChange={() => toggle(c)} />
              <span style={{ flex: 1 }}>{c.nome} <span className="cc-empty" style={{ fontSize: 11 }}>· {c.qtd}</span></span>
              {marcada && (
                <input className="cc-input" style={{ width: 130 }} value={sel[c.nome]}
                  placeholder="rótulo"
                  onChange={e => setSel(prev => ({ ...prev, [c.nome]: e.target.value }))} />
              )}
            </div>
          )
        })}
      </div>
      <div className="cc-multiadd-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!qtdTotal} onClick={confirmar}>
          Trazer {qtdTotal || ''} opç{qtdTotal === 1 ? 'ão' : 'ões'}
        </button>
      </div>
    </div>
  )
}

// Tela de CATEGORIAS DE COMPLEMENTO compartilhadas.
// Uma categoria (ex.: "Proteínas") é criada UMA vez, com suas opções, e pode ser
// casada em vários produtos (via a ponte produto_complemento_grupos). Pausar uma
// opção aqui pausa em todos os produtos que usam a categoria — fonte única.
export default function CategoriasComplemento() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null
  const [confirmar, avisoConfirmar] = useConfirmar()

  const [cats, setCats] = useState([])       // [{id, nome, min, max, disponivel, opcoes:[], links:[{id,produto_id,max_override}]}]
  const [produtos, setProdutos] = useState([]) // [{id, nome}]
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [novaCat, setNovaCat] = useState('')
  const [busy, setBusy] = useState(null)      // id em operação (desabilita botão)
  const [busca, setBusca] = useState('')      // pesquisa (categoria/opção, sem acento)
  // Sanfona: só UMA categoria aberta por vez. Com 3, 10 categorias de 40 sabores
  // cada, deixar tudo aberto vira uma página quilométrica — a loja abre só a que
  // vai mexer. null = todas fechadas.
  const [abertaId, setAbertaId] = useState(null)

  // Descrição que a opção HERDA do produto de mesmo nome quando o campo fica vazio.
  // Mostrada como placeholder pra loja entender por que o site tem texto e o campo não.
  const descricaoHerdada = useMemo(() => criarBuscadorDescricao(produtos), [produtos])

  const nomeProduto = useMemo(() => {
    const m = {}
    for (const p of produtos) m[p.id] = p.nome
    return m
  }, [produtos])

  const load = useCallback(async () => {
    if (!empresaId) return
    setLoading(true)
    const [gruposRes, prodRes, linkRes] = await Promise.all([
      supabase.from('complemento_grupos')
        .select('id, nome, min, max, ordem, disponivel, regra_preco, modo_quantidade, complemento_opcoes(id, nome, descricao, preco_adicional, ordem, disponivel)')
        .eq('empresa_id', empresaId).order('nome'),
      supabase.from('produtos').select('id, nome, categoria, descricao, preco_venda, ativo').eq('empresa_id', empresaId).is('arquivado_em', null).order('nome'),
      supabase.from('produto_complemento_grupos')
        .select('id, produto_id, grupo_id, max_override, produtos!inner(empresa_id)')
        .eq('produtos.empresa_id', empresaId),
    ])
    if (gruposRes.error) { setError(gruposRes.error.message); setLoading(false); return }
    const linksPorGrupo = {}
    for (const l of (linkRes.data ?? [])) (linksPorGrupo[l.grupo_id] ??= []).push(l)
    const lista = (gruposRes.data ?? []).map(g => ({
      id: g.id, nome: g.nome, min: g.min ?? 0, max: g.max ?? 1, disponivel: g.disponivel !== false,
      regra_preco: g.regra_preco ?? 'somar',
      modo_quantidade: g.modo_quantidade === true,
      opcoes: (g.complemento_opcoes ?? []).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)),
      links: (linksPorGrupo[g.id] ?? []),
    }))
    setCats(lista)
    setProdutos(prodRes.data ?? [])
    setLoading(false)
  }, [empresaId])

  useEffect(() => { load() }, [load])

  // ── Categoria ──────────────────────────────────────────────────────────────
  async function criarCategoria() {
    const nome = novaCat.trim()
    if (!nome) return
    setBusy('nova')
    const { data, error } = await supabase.from('complemento_grupos')
      .insert({ empresa_id: empresaId, produto_id: null, nome, min: 1, max: 1 })
      .select('id')
      .single()
    setBusy(null)
    if (error) { setError(error.message); return }
    setNovaCat('')
    // Categoria nova nasce aberta: é pra ela que a loja vai jogar as opções agora.
    if (data?.id) setAbertaId(data.id)
    load()
  }
  async function salvarCategoria(cat, patch) {
    setCats(prev => prev.map(c => c.id === cat.id ? { ...c, ...patch } : c))
    await supabase.from('complemento_grupos').update(patch).eq('id', cat.id)
  }
  async function pausarCategoria(cat) {
    const novo = !cat.disponivel
    setCats(prev => prev.map(c => c.id === cat.id ? { ...c, disponivel: novo } : c))
    await supabase.from('complemento_grupos').update({ disponivel: novo }).eq('id', cat.id)
  }
  // Copia a categoria com todas as opções (nome, preço, ordem e pausadas).
  // NÃO copia os produtos em que ela é usada: a cópia nasce solta, pra você
  // ajustar antes de pendurar. Se copiasse, o produto ficaria com dois grupos
  // iguais e o cliente teria que escolher duas vezes.
  async function duplicarCategoria(cat) {
    setBusy(cat.id)
    setError(null)
    const { data: nova, error: erroGrupo } = await supabase.from('complemento_grupos')
      .insert({
        empresa_id: empresaId,
        produto_id: null,
        nome: `${cat.nome} (cópia)`,
        min: cat.min,
        max: cat.max,
        disponivel: cat.disponivel,
        regra_preco: cat.regra_preco,
      })
      .select('id')
      .single()
    if (erroGrupo) { setBusy(null); setError(erroGrupo.message); return }

    if (cat.opcoes.length) {
      const { error: erroOpcoes } = await supabase.from('complemento_opcoes').insert(
        cat.opcoes.map(o => ({
          grupo_id: nova.id,
          nome: o.nome,
          preco_adicional: o.preco_adicional,
          ordem: o.ordem,
          disponivel: o.disponivel,
        }))
      )
      if (erroOpcoes) {
        // Não deixa grupo pela metade: desfaz a cópia e avisa.
        await supabase.from('complemento_grupos').delete().eq('id', nova.id)
        setBusy(null)
        setError(`Não consegui copiar as opções: ${erroOpcoes.message}`)
        return
      }
    }
    setBusy(null)
    setAbertaId(nova.id)   // a cópia já abre pra loja ajustar o que mudou
    load()
  }

  async function excluirCategoria(cat) {
    const usados = cat.links.length
    const ok = await confirmar({
      titulo: `Excluir a categoria “${cat.nome}”?`,
      texto: `Apaga a categoria e as ${cat.opcoes.length} opções dela de vez — não dá pra desfazer.`
        + (usados ? `\nEla está em ${usados} produto${usados === 1 ? '' : 's'} e vai sumir de todos.` : ''),
      aviso: 'Se você só quer que ela pare de aparecer pro cliente, use o botão Pausar — aí dá pra voltar depois.',
      textoOk: 'Sim, excluir',
    })
    if (!ok) return
    setBusy(cat.id)
    // apaga vínculos, opções e a categoria (opções caem por cascade, mas garantimos)
    await supabase.from('produto_complemento_grupos').delete().eq('grupo_id', cat.id)
    await supabase.from('complemento_grupos').delete().eq('id', cat.id)
    setBusy(null)
    load()
  }

  // ── Opções ───────────────────────────────────────────────────────────────
  async function addOpcao(cat) {
    const ordem = (cat.opcoes.reduce((m, o) => Math.max(m, o.ordem ?? 0), 0) + 1)
    setBusy(cat.id)
    const { error } = await supabase.from('complemento_opcoes')
      .insert({ grupo_id: cat.id, nome: 'Nova opção', preco_adicional: 0, ordem })
    setBusy(null)
    if (error) { setError(error.message); return }
    load()
  }
  // Cria uma opção por produto das categorias escolhidas do cardápio.
  // Preço = o do cardápio (a loja ajusta depois se quiser). Descrição fica vazia
  // de propósito: assim o texto continua vindo do produto e acompanha as edições
  // que a loja fizer no cardápio.
  async function importarSabores(cat, escolhas) {
    setBusy(cat.id)
    setError(null)
    const jaTem = new Set(cat.opcoes.map(o => norm(o.nome)))
    let ordem = cat.opcoes.reduce((m, o) => Math.max(m, o.ordem ?? 0), 0)
    const rows = []
    for (const { categoria, rotulo } of escolhas) {
      const daCategoria = produtos
        .filter(p => p.ativo !== false && (p.categoria || '').trim() === categoria)
        .sort((a, b) => a.nome.localeCompare(b.nome))
      for (const p of daCategoria) {
        const nome = rotulo ? `${p.nome} (${rotulo})` : p.nome
        if (jaTem.has(norm(nome))) continue // já está na lista: não duplica
        jaTem.add(norm(nome))
        rows.push({ grupo_id: cat.id, nome, preco_adicional: Number(p.preco_venda) || 0, ordem: ++ordem })
      }
    }
    if (!rows.length) {
      setBusy(null)
      setError('Esses produtos já estão na lista de opções.')
      return
    }
    const { error } = await supabase.from('complemento_opcoes').insert(rows)
    setBusy(null)
    if (error) { setError(error.message); return }
    load()
  }

  // Renomeia o bloco = troca o que está entre parênteses em TODAS as opções dele
  // ("Mussarela (Promoção)" → "Mussarela (Oferta)"). Vazio junta o bloco na lista
  // corrida, sem subtítulo na loja.
  async function renomearBloco(cat, bloco, valor) {
    const novo = String(valor || '').trim()
    if (novo === bloco.titulo) return
    setBusy(cat.id)
    setError(null)
    const { error } = await (async () => {
      for (const op of bloco.opcoes) {
        const nome = novo ? `${op.nomeCurto} (${novo})` : op.nomeCurto
        if (nome === op.nome) continue
        const r = await supabase.from('complemento_opcoes').update({ nome }).eq('id', op.id)
        if (r.error) return r
      }
      return {}
    })()
    setBusy(null)
    if (error) { setError(error.message); return }
    load()
  }

  // Sobe/desce um bloco inteiro na lista (ex.: pôr "Especiais" na frente de
  // "Promoção"). A ordem que o cliente vê é a coluna `ordem` de cada opção, então
  // mover o bloco é renumerar as opções na sequência nova — só as que mudaram
  // de lugar viram update.
  async function moverBloco(cat, blocos, idx, direcao) {
    const alvo = idx + direcao
    if (alvo < 0 || alvo >= blocos.length) return
    const nova = [...blocos]
    ;[nova[idx], nova[alvo]] = [nova[alvo], nova[idx]]

    let ordem = 0
    const mudou = []
    for (const b of nova) {
      for (const o of b.opcoes) {
        ordem++
        if ((o.ordem ?? 0) !== ordem) mudou.push({ id: o.id, ordem })
      }
    }
    if (!mudou.length) return

    setBusy(cat.id)
    setError(null)
    for (const u of mudou) {
      const r = await supabase.from('complemento_opcoes').update({ ordem: u.ordem }).eq('id', u.id)
      if (r.error) { setBusy(null); setError(r.error.message); return }
    }
    setBusy(null)
    load()
  }

  // Apaga o bloco inteiro de uma vez. Acontece de a loja trazer o cardápio duas
  // vezes com rótulos diferentes ("Especial" e "Especiais") e ficar com a lista
  // dobrada — sem isso seriam 10, 15 exclusões uma a uma, cada uma com aviso.
  async function excluirBloco(cat, bloco) {
    const ok = await confirmar({
      titulo: `Excluir o bloco “${bloco.titulo}” inteiro?`,
      texto: `Apaga de vez as ${bloco.opcoes.length} opções dele, e não dá pra desfazer:`,
      itens: bloco.opcoes.map(o => o.nomeCurto ?? o.nome),
      aviso: 'Os produtos do cardápio não são apagados — eles só somem daqui, da lista de escolha.',
      textoOk: `Excluir as ${bloco.opcoes.length}`,
    })
    if (!ok) return
    setBusy(cat.id)
    setError(null)
    const { error } = await supabase.from('complemento_opcoes')
      .delete().in('id', bloco.opcoes.map(o => o.id))
    setBusy(null)
    if (error) { setError(error.message); return }
    load()
  }

  async function salvarOpcao(cat, op, patch) {
    setCats(prev => prev.map(c => c.id !== cat.id ? c : {
      ...c, opcoes: c.opcoes.map(o => o.id === op.id ? { ...o, ...patch } : o),
    }))
    await supabase.from('complemento_opcoes').update(patch).eq('id', op.id)
  }
  async function pausarOpcao(cat, op) {
    const novo = op.disponivel === false // se pausada, reativa
    salvarOpcao(cat, op, { disponivel: novo })
  }
  async function removerOpcao(cat, op) {
    const ok = await confirmar({
      titulo: `Excluir “${op.nome}”?`,
      texto: 'Apaga a opção do sistema de vez — não dá pra desfazer.',
      aviso: 'Se você só quer que ela pare de aparecer pro cliente, use o botão Pausar (⏸) em vez do ✕ — aí dá pra voltar depois.',
      textoOk: 'Sim, excluir',
    })
    if (!ok) return
    setCats(prev => prev.map(c => c.id !== cat.id ? c : { ...c, opcoes: c.opcoes.filter(o => o.id !== op.id) }))
    await supabase.from('complemento_opcoes').delete().eq('id', op.id)
  }

  // ── Vínculos (quais produtos usam a categoria) ───────────────────────────
  // Vincula VÁRIOS produtos de uma vez (marca vários e adiciona todos juntos).
  async function vincularProdutos(cat, produtoIds) {
    const ids = (produtoIds ?? []).filter(Boolean)
    if (!ids.length) return
    setBusy(cat.id)
    const rows = ids.map(pid => ({ produto_id: pid, grupo_id: cat.id, ordem: 0 }))
    const { error } = await supabase.from('produto_complemento_grupos').insert(rows)
    setBusy(null)
    if (error) { setError(error.message); return }
    load()
  }
  async function desvincularProduto(cat, link) {
    setCats(prev => prev.map(c => c.id !== cat.id ? c : { ...c, links: c.links.filter(l => l.id !== link.id) }))
    await supabase.from('produto_complemento_grupos').delete().eq('id', link.id)
  }
  async function salvarMaxOverride(cat, link, valorRaw) {
    const valor = valorRaw === '' ? null : Math.max(1, Number(valorRaw) || 1)
    setCats(prev => prev.map(c => c.id !== cat.id ? c : {
      ...c, links: c.links.map(l => l.id === link.id ? { ...l, max_override: valor } : l),
    }))
    await supabase.from('produto_complemento_grupos').update({ max_override: valor }).eq('id', link.id)
  }

  if (loading) return (
    <div>
      <div className="page-header"><h1>Complementos</h1></div>
      <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '70%' }} /><div className="skeleton-row" style={{ width: '85%' }} /></div>
    </div>
  )

  // Filtro da lupa: acha por nome da categoria OU da opção (ignora acento).
  // Se casar o nome da categoria, mostra ela inteira; senão, mostra só as opções que casam.
  const nt = norm(busca)
  const catsFiltradas = !nt ? cats : cats.map(cat => {
    if (norm(cat.nome).includes(nt)) return cat
    const opcoes = cat.opcoes.filter(o => norm(o.nome).includes(nt))
    return opcoes.length ? { ...cat, opcoes } : null
  }).filter(Boolean)

  return (
    <div>
      {avisoConfirmar}
      <div className="page-header">
        <h1>Complementos</h1>
        <span className="badge badge-neutral">{cats.length} categoria{cats.length === 1 ? '' : 's'}</span>
      </div>
      <p className="cc-sub">
        Monte cada categoria (ex.: “Proteínas”, “Saladas”) <b>uma vez</b> e use em vários produtos.
        Pausar uma opção aqui pausa em <b>todos</b> os produtos que a usam.
      </p>

      {error && <p className="error-text">{error}</p>}

      {/* Criar nova categoria */}
      <div className="cc-create">
        <input
          className="cc-input"
          value={novaCat}
          placeholder="Nome da nova categoria (ex.: Proteínas)"
          onChange={e => setNovaCat(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') criarCategoria() }}
        />
        <button className="btn btn-primary" disabled={busy === 'nova' || !novaCat.trim()} onClick={criarCategoria}>
          + Criar categoria
        </button>
      </div>

      {/* Lupa de pesquisa (categoria ou opção) */}
      {cats.length > 0 && (
        <div className="cc-search">
          <span className="cc-search-icon">🔍</span>
          <input
            className="cc-input"
            value={busca}
            placeholder="Pesquisar categoria ou opção (ex.: frango)…"
            onChange={e => setBusca(e.target.value)}
          />
          {busca && (
            <button className="cc-search-clear" title="Limpar" onClick={() => setBusca('')}>✕</button>
          )}
        </div>
      )}

      {cats.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 22 }}>🧩</div>
          <strong>Nenhuma categoria ainda</strong>
          <p>Crie a primeira lá em cima (ex.: “Proteínas”, “Saladas”, “Adicionais”).</p>
        </div>
      )}

      {cats.length > 0 && catsFiltradas.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon" style={{ fontSize: 22 }}>🔍</div>
          <strong>Nada encontrado</strong>
          <p>Nenhuma categoria ou opção com “{busca}”.</p>
        </div>
      )}

      {catsFiltradas.map(cat => {
        const naoVinculados = produtos.filter(p => !cat.links.some(l => l.produto_id === p.id))
        // Pesquisa que sobrou UMA categoria já abre sozinha — a loja pesquisou
        // justamente pra chegar nela.
        const aberta = cat.id === abertaId || (!!nt && catsFiltradas.length === 1)
        const casouPeloNome = !nt || norm(cat.nome).includes(nt)

        if (!aberta) return (
          <div key={cat.id} className={`card cc-card cc-card-fechado${cat.disponivel ? '' : ' paused'}`}>
            <button type="button" className="cc-fechada" onClick={() => setAbertaId(cat.id)}>
              <span className="cc-chevron">▸</span>
              <span className="cc-fechada-nome">{cat.nome}</span>
              <span className={`badge ${cat.disponivel ? 'badge-success' : 'badge-danger'}`}>
                {cat.disponivel ? 'Ativa' : 'Pausada'}
              </span>
              <span className="cc-fechada-resumo">
                {casouPeloNome
                  ? `${cat.opcoes.length} opç${cat.opcoes.length === 1 ? 'ão' : 'ões'} · ${cat.links.length} produto${cat.links.length === 1 ? '' : 's'}`
                  : `${cat.opcoes.length} opç${cat.opcoes.length === 1 ? 'ão' : 'ões'} com “${busca}”`}
              </span>
              <span className="cc-fechada-abrir">Editar</span>
            </button>
          </div>
        )

        return (
          <div key={cat.id} className={`card cc-card${cat.disponivel ? '' : ' paused'}`}>
            {/* Cabeçalho da categoria */}
            <div className="cc-head">
              <button type="button" className="cc-chevron cc-chevron-btn" title="Fechar"
                onClick={() => setAbertaId(null)}>▾</button>
              <div className="cc-head-left">
                <input className="cc-name" defaultValue={cat.nome}
                  onBlur={e => { const v = e.target.value.trim(); if (v && v !== cat.nome) salvarCategoria(cat, { nome: v }) }} />
                <span className={`badge ${cat.disponivel ? 'badge-success' : 'badge-danger'}`}>
                  {cat.disponivel ? 'Ativa' : 'Pausada'}
                </span>
                {/* Com quantidade ligada o máximo perde o sentido (é justamente o
                    "sem limite") e o mínimo passa a valer pro TOTAL do grupo:
                    é o "a partir de 10 unidades" do atacado. */}
                <span className="cc-minmax" title={cat.modo_quantidade
                  ? 'Mínimo de unidades somando todas as opções (0 = sem mínimo)'
                  : 'Quantas opções diferentes o cliente escolhe'}>
                  {cat.modo_quantidade ? 'mín. unidades' : 'mín'}
                  <input className="cc-input" type="number" min="0" defaultValue={cat.min}
                    onBlur={e => salvarCategoria(cat, { min: Number(e.target.value) || 0 })} />
                  {!cat.modo_quantidade && <>
                    máx <input className="cc-input" type="number" min="1" defaultValue={cat.max}
                      onBlur={e => salvarCategoria(cat, { max: Number(e.target.value) || 1 })} />
                  </>}
                </span>
                {/* Atacado: o cliente diz QUANTO de cada sabor (500 de um, 100 de
                    outro), em vez de só marcar qual. Vale na Loja Online. */}
                <label className="cc-minmax" style={{ cursor: 'pointer', gap: 5 }}
                  title="O cliente escolhe a quantidade de cada opção, sem limite, e a quantidade do item vira a soma. Vale na Loja Online — balcão e mesa seguem marcando opção.">
                  <input
                    type="checkbox"
                    checked={!!cat.modo_quantidade}
                    onChange={e => salvarCategoria(cat, { modo_quantidade: e.target.checked })}
                  />
                  quantidade por opção
                </label>
                {/* Como cobrar: somar (adicional comum) ou pelo mais caro (pizza meio a meio) */}
                <span className="cc-minmax" title="Somar: cada opção soma no preço. Mais caro: vale só a opção mais cara (pizza meio a meio).">
                  cobrar
                  <select
                    className="cc-input"
                    style={{ width: 'auto', minWidth: 118 }}
                    value={cat.regra_preco}
                    onChange={e => salvarCategoria(cat, { regra_preco: e.target.value })}
                  >
                    <option value="somar">somando tudo</option>
                    <option value="maior">pelo mais caro</option>
                  </select>
                </span>
              </div>
              <div className="cc-head-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={busy === cat.id}
                  title="Cria uma cópia desta categoria com todas as opções (sem vincular a produtos)"
                  onClick={() => duplicarCategoria(cat)}
                >
                  {busy === cat.id ? '⏳ Copiando...' : '⧉ Duplicar'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => pausarCategoria(cat)}>
                  {cat.disponivel ? '⏸ Pausar' : '▶ Reativar'}
                </button>
                <button className="btn btn-danger btn-sm" disabled={busy === cat.id} onClick={() => excluirCategoria(cat)}>
                  🗑 Excluir
                </button>
              </div>
            </div>

            <div className="cc-body">
              {/* Opções */}
              <div>
                <p className="cc-section-title">Opções · {cat.opcoes.length}</p>
                {cat.opcoes.length === 0 && <p className="cc-empty">Nenhuma opção ainda.</p>}
                {(() => { const blocos = blocosDeOpcoes(cat.opcoes); return blocos.map((bloco, iBloco) => (
                <div key={bloco.titulo ?? 'unico'}>
                  {/* Bloco = o que está entre parênteses no fim do nome. Vira subtítulo
                      na loja, e renomear aqui renomeia todas as opções de uma vez. */}
                  {bloco.titulo && (
                    <div className="cc-bloco-head">
                      <span className="cc-bloco-label">Bloco</span>
                      <input className="cc-input" defaultValue={bloco.titulo} disabled={busy === cat.id}
                        title="Aparece como título deste trecho na loja online"
                        onBlur={e => renomearBloco(cat, bloco, e.target.value)} />
                      <span className="cc-empty" style={{ fontSize: 11 }}>· {bloco.opcoes.length}</span>
                      {/* Setas: mudam a ordem em que os blocos aparecem pro cliente. */}
                      <span className="cc-bloco-mover">
                        <button type="button" disabled={busy === cat.id || iBloco === 0}
                          title="Subir este bloco (aparece antes pro cliente)"
                          onClick={() => moverBloco(cat, blocos, iBloco, -1)}>↑</button>
                        <button type="button" disabled={busy === cat.id || iBloco === blocos.length - 1}
                          title="Descer este bloco (aparece depois pro cliente)"
                          onClick={() => moverBloco(cat, blocos, iBloco, 1)}>↓</button>
                      </span>
                      <button type="button" className="cc-bloco-del" disabled={busy === cat.id}
                        title={`Apagar o bloco "${bloco.titulo}" e as ${bloco.opcoes.length} opções dele`}
                        onClick={() => excluirBloco(cat, bloco)}>
                        🗑 Apagar bloco
                      </button>
                    </div>
                  )}
                  {bloco.opcoes.map(op => (
                  <div key={op.id} className={`cc-opt${op.disponivel === false ? ' paused' : ''}`}>
                    {/* key com o nome: sem isso o campo continuaria mostrando o nome
                        antigo depois de renomear o bloco (defaultValue só vale ao montar). */}
                    <input className="cc-input" key={op.nome} defaultValue={op.nome}
                      onBlur={e => { const v = e.target.value.trim(); if (v && v !== op.nome) salvarOpcao(cat, op, { nome: v }) }} />
                    <div className="cc-price-wrap">
                      <span className="cc-price-prefix">R$</span>
                      <input className="cc-input" type="number" step="0.01" min="0" defaultValue={op.preco_adicional}
                        onBlur={e => salvarOpcao(cat, op, { preco_adicional: Number(e.target.value) || 0 })} />
                    </div>
                    <button className="btn btn-secondary btn-sm" title={op.disponivel === false ? 'Reativar' : 'Pausar'} onClick={() => pausarOpcao(cat, op)}>
                      {op.disponivel === false ? '▶' : '⏸'}
                    </button>
                    <button className="cc-iconbtn" title="Remover" onClick={() => removerOpcao(cat, op)}>✕</button>
                    {/* Ingredientes do sabor — aparecem embaixo do nome na loja online.
                        Vazio não quer dizer sem texto: o placeholder mostra o que a loja
                        está herdando do produto de mesmo nome. */}
                    <input className={`cc-input cc-opt-desc${descricaoHerdada(op.nome) && !op.descricao ? ' herdado' : ''}`}
                      key={op.nome} defaultValue={op.descricao ?? ''}
                      title={descricaoHerdada(op.nome) && !op.descricao
                        ? 'Está pegando a descrição do produto de mesmo nome no cardápio. Escreva aqui só se quiser um texto diferente.'
                        : 'Aparece embaixo do nome do sabor na loja online'}
                      placeholder={descricaoHerdada(op.nome)
                        ? `Vem do cardápio: ${descricaoHerdada(op.nome)}`
                        : 'Ingredientes (ex.: Mussarela, calabresa, cebola, molho de tomate, orégano)'}
                      onBlur={e => {
                        const v = e.target.value.trim()
                        if (v !== (op.descricao ?? '')) salvarOpcao(cat, op, { descricao: v || null })
                      }} />
                  </div>
                  ))}
                </div>
                )) })()}
                <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} disabled={busy === cat.id} onClick={() => addOpcao(cat)}>
                  + Opção
                </button>
                <ImportarSabores
                  produtos={produtos}
                  disabled={busy === cat.id}
                  onConfirm={escolhas => importarSabores(cat, escolhas)}
                />
              </div>

              {/* Produtos que usam */}
              <div>
                <p className="cc-section-title">Usada em {cat.links.length} produto{cat.links.length === 1 ? '' : 's'}</p>
                {cat.links.length === 0 && <p className="cc-empty">Ainda não está em nenhum produto.</p>}
                {cat.links.map(link => (
                  <div key={link.id} className="cc-prod">
                    <span className="cc-prod-name">{nomeProduto[link.produto_id] ?? '—'}</span>
                    <span className="cc-prod-max">
                      máx
                      <input className="cc-input" type="number" min="1"
                        defaultValue={link.max_override ?? ''}
                        placeholder={String(cat.max)}
                        onBlur={e => salvarMaxOverride(cat, link, e.target.value)} />
                    </span>
                    <button className="cc-iconbtn" title="Tirar deste produto" onClick={() => desvincularProduto(cat, link)}>✕</button>
                  </div>
                ))}
                {naoVinculados.length > 0 && (
                  <ProdutoMultiAdd
                    produtos={naoVinculados}
                    disabled={busy === cat.id}
                    onConfirm={ids => vincularProdutos(cat, ids)}
                  />
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
