import { useCallback, useEffect, useRef, useState } from 'react'
import React from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { useConfirmar } from '../hooks/useConfirmar'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const PAGE_SIZE = 50

// Normaliza pra busca: tira acento, deixa minúsculo e sem espaços nas pontas.
// Assim "feijao" acha "Feijão" e "macarrao" acha "Macarrão".
const norm = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

// eslint-disable-next-line no-unused-vars
const EMBALAGENS = ['unidade', 'lata', 'garrafa', 'caixa', 'fardo']

// Celular? Só nele faz sentido o botão "Tirar foto" (no PC o `capture` é
// ignorado e abriria o mesmo seletor de arquivo, confundindo o dono).
const EH_CELULAR = typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
   (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)))   // iPad novo se diz Mac

// Foto de câmera de celular vem com 4-8 MB. Encolhe pra no máximo 1200px e
// JPEG 82% antes de subir: a vitrine mostra a foto pequena mesmo, e o upload
// no 4G da loja deixa de demorar/estourar.
async function comprimirImagem(file, maxLado = 1200, qualidade = 0.82) {
  if (!file.type?.startsWith('image/') || file.type === 'image/gif') return file
  try {
    const bitmap = await createImageBitmap(file)
    const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height))
    // Já é pequena e leve: sobe do jeito que veio.
    if (escala === 1 && file.size < 900 * 1024) { bitmap.close?.(); return file }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * escala)
    canvas.height = Math.round(bitmap.height * escala)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', qualidade))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], 'foto.jpg', { type: 'image/jpeg' })
  } catch {
    return file   // navegador antigo: sobe original, melhor do que travar o cadastro
  }
}

// Preço do app FWC: escondido enquanto o app não está no ar. O valor continua
// gravado em produtos.preco_app — é só voltar pra true quando o app publicar.
const MOSTRAR_PRECO_APP = false

const emptyForm = {
  nome: '',
  categoria: '',
  embalagem: 'caixa',
  unidades_por_caixa: 1,
  controla_casco: false,
  controla_estoque: true,
  preco_custo: 0,
  custo_modo: 'fixo',      // 'fixo' = R$ por unidade | 'pct' = % do valor vendido
  custo_pct_venda: '',
  preco_venda: 0,
  preco_promocional: '',
  preco_app: 0,
  faixas_preco: [],
  estoque_minimo: 0,
  ativo: true,
  foto_url: '',
  descricao: '',
}

const CATALOGO_BASE = 'https://lojaonline.fwcinter.com'

// Campo de categoria com busca (dropdown próprio, estilizado — no lugar do <datalist> feio do navegador).
function CategoriaCombobox({ categorias, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(value || '')
  const wrapRef = useRef(null)

  // Sincroniza o texto quando o valor muda de fora (abrir modal, editar produto, resetar form).
  useEffect(() => { setText(value || '') }, [value])

  useEffect(() => {
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const q = norm(text)
  const exata = categorias.some((c) => norm(c.nome) === q)
  // Filtra enquanto digita; se o texto bate exatamente numa categoria, mostra todas (pra poder trocar).
  const filtradas = (q && !exata) ? categorias.filter((c) => norm(c.nome).includes(q)) : categorias

  function escolher(nome) {
    setText(nome)
    onChange({ target: { name: 'categoria', value: nome } })
    setOpen(false)
  }

  function digitar(e) {
    setText(e.target.value)
    onChange(e)              // mantém form.categoria em sincronia (texto livre, igual antes)
    setOpen(true)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        type="text"
        name="categoria"
        value={text}
        required
        autoComplete="off"
        placeholder="Digite pra buscar ou escolha..."
        onChange={digitar}
        onFocus={(e) => { e.target.select(); setOpen(true) }}
        style={{ paddingRight: 30 }}
      />
      <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)', fontSize: 11 }}>▼</span>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
          maxHeight: 240, overflowY: 'auto',
          background: 'var(--card-bg, var(--bg))', border: '1px solid var(--border)',
          borderRadius: 8, boxShadow: '0 10px 28px rgba(0,0,0,.22)', padding: 4,
        }}>
          {filtradas.length === 0 ? (
            <div style={{ padding: '9px 10px', color: 'var(--text-muted)', fontSize: 14 }}>Nenhuma categoria encontrada.</div>
          ) : filtradas.map((c) => {
            const sel = c.nome === value
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => escolher(c.nome)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '9px 10px', border: 'none', borderRadius: 6, cursor: 'pointer',
                  background: sel ? 'var(--primary-ring)' : 'transparent',
                  color: 'var(--text)', fontSize: 14.5, fontWeight: sel ? 700 : 500,
                }}
                onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'color-mix(in srgb, var(--bg), var(--border) 60%)' }}
                onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent' }}
              >
                {c.nome}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function Produtos() {
  const { profile, empresa } = useAuth()
  const [confirmar, avisoConfirmar] = useConfirmar()
  const [copiadoLink, setCopiadoLink] = useState(false)

  const slug = empresa?.slug ?? null
  const linkCardapio = slug ? `${CATALOGO_BASE}/${slug}` : null
  // Loja que desligou o estoque (botão em Estoque) não precisa ver "Estoque
  // mín. 0" em 99 produtos, nem embalagem/un. por caixa — tudo isso é de
  // distribuidora. Casco idem: só aparece pra quem marcou em algum produto.
  const usaEstoque = empresa?.estoque_ativo ?? true

  function copiarLink() {
    if (!linkCardapio) return
    navigator.clipboard.writeText(linkCardapio)
    setCopiadoLink(true)
    setTimeout(() => setCopiadoLink(false), 2000)
  }
  const fileInputRef = useRef(null)
  const camInputRef = useRef(null)     // input separado com `capture` — abre a câmera direto no celular
  // Renumeração da ordem das categorias só pode acontecer uma vez por sessão
  // (se o update falhar, não pode ficar tentando em loop).
  const renumerouRef = useRef(false)

  const [produtos, setProdutos] = useState([])
  const [categorias, setCategorias] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [categoriaFiltro, setCategoriaFiltro] = useState('')
  // Arquivados: item que já foi vendido não pode ser apagado (o histórico da venda
  // depende dele), então ele sai da lista por aqui. O ref evita recriar o
  // loadProdutos e disparar o useEffect de carga inicial a cada clique.
  const [page, setPage] = useState(0)
  const [total, setTotal] = useState(0)
  const debounceRef = useRef(null)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [uploadingFoto, setUploadingFoto] = useState(false)
  const [duplicandoId, setDuplicandoId] = useState(null)        // produto sendo duplicado (spinner no botão)

  // Quantidade em estoque direto no cadastro do produto. Antes só dava pra
  // lançar na tela Estoque: cadastrava o item e tinha que ir lá só pra dizer
  // quantos tem. Aqui o dono já digita a contagem e a gente grava a
  // movimentação (entrada na criação, ajuste na edição) depois de salvar.
  const [estoqueQtd, setEstoqueQtd] = useState('')          // o que o dono digitou (vazio = não mexer)
  const [estoqueSaldo, setEstoqueSaldo] = useState(0)       // saldo atual do produto (0 em produto novo)
  const [carregandoSaldo, setCarregandoSaldo] = useState(false)

  // Complementos / opções do produto (ex.: monte sua quentinha)
  const [grupos, setGrupos] = useState([])
  // Novo modelo: o produto só ESCOLHE categorias já criadas (as opções vivem na
  // tela "Complementos"). Aqui guardamos os vínculos deste produto + o catálogo
  // de categorias da empresa pro seletor.
  const [vinculos, setVinculos] = useState([])         // [{linkId, grupo_id, nome, max_grupo, max_override}]
  const [vincOriginais, setVincOriginais] = useState([]) // snapshot pra saber o que mudou no salvar
  const [catsEmpresa, setCatsEmpresa] = useState([])   // [{id, nome, max}]

  // Rascunho automático: guarda o produto que está sendo editado. Se sair da
  // página / o app recarregar, ao voltar reabre com tudo preenchido (não perde
  // o trabalho). Limpa ao salvar ou cancelar.
  const draftKey = empresa?.id ? `produtos-draft-${empresa.id}` : null
  const limparRascunho = () => { try { if (draftKey) localStorage.removeItem(draftKey) } catch { /* ok */ } }
  const fecharModal = () => { limparRascunho(); setShowModal(false) }
  useEffect(() => {
    if (!showModal || !draftKey) return
    try { localStorage.setItem(draftKey, JSON.stringify({ editingId, form, vinculos })) } catch { /* quota */ }
  }, [showModal, editingId, form, vinculos, draftKey])
  const rascunhoRestaurado = useRef(false)
  useEffect(() => {
    if (rascunhoRestaurado.current || !draftKey) return
    rascunhoRestaurado.current = true
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || 'null')
      if (d && d.form) {
        setEditingId(d.editingId ?? null)
        setForm(d.form)
        setVinculos(Array.isArray(d.vinculos) ? d.vinculos : [])
        setEstoqueQtd(''); setEstoqueSaldo(0)
        if (d.editingId) loadSaldoProduto(d.editingId)
        loadCategoriasEmpresa()
        setShowModal(true)
      }
    } catch { /* rascunho inválido */ }
  }, [draftKey])

  // Complementos na LISTA (accordion pausável estilo iFood, direto na tabela)
  const [compProd, setCompProd] = useState({})            // produtoId -> [grupos]
  const [compAberto, setCompAberto] = useState(() => new Set())
  const [pausandoComp, setPausandoComp] = useState(null)

  function toggleAbrirComp(produtoId) {
    setCompAberto(prev => {
      const n = new Set(prev)
      n.has(produtoId) ? n.delete(produtoId) : n.add(produtoId)
      return n
    })
  }
  async function togglePausarGrupoLista(produtoId, grupo) {
    const novo = grupo.disponivel === false
    setPausandoComp(grupo.id)
    const patch = (val) => setCompProd(prev => ({
      ...prev, [produtoId]: (prev[produtoId] ?? []).map(g => g.id === grupo.id ? { ...g, disponivel: val } : g),
    }))
    patch(novo)
    const { error } = await supabase.from('complemento_grupos').update({ disponivel: novo }).eq('id', grupo.id)
    setPausandoComp(null)
    if (error) patch(grupo.disponivel)
  }
  async function togglePausarOpcaoLista(produtoId, grupoId, op) {
    const novo = op.disponivel === false
    setPausandoComp(op.id)
    const patch = (val) => setCompProd(prev => ({
      ...prev, [produtoId]: (prev[produtoId] ?? []).map(g => g.id !== grupoId ? g : {
        ...g, opcoes: g.opcoes.map(o => o.id === op.id ? { ...o, disponivel: val } : o),
      }),
    }))
    patch(novo)
    const { error } = await supabase.from('complemento_opcoes').update({ disponivel: novo }).eq('id', op.id)
    setPausandoComp(null)
    if (error) patch(op.disponivel)
  }

  // Catálogo de categorias da empresa (pro seletor "adicionar categoria")
  async function loadCategoriasEmpresa() {
    const { data } = await supabase
      .from('complemento_grupos')
      .select('id, nome, max')
      .eq('empresa_id', profile.empresa_id)
      .order('nome')
    setCatsEmpresa(data ?? [])
  }

  // Vínculos deste produto (quais categorias ele usa + máx. próprio)
  async function loadComplementos(produtoId) {
    const { data } = await supabase
      .from('produto_complemento_grupos')
      .select('id, grupo_id, max_override, ordem, complemento_grupos(nome, max)')
      .eq('produto_id', produtoId)
      .order('ordem')
    const vs = (data ?? []).map(v => ({
      linkId: v.id, grupo_id: v.grupo_id, nome: v.complemento_grupos?.nome ?? '',
      max_grupo: v.complemento_grupos?.max ?? 1, max_override: v.max_override ?? null,
    }))
    setVinculos(vs)
    setVincOriginais(vs)
  }

  function updGrupo(gi, patch) {
    setGrupos(prev => prev.map((g, i) => (i === gi ? { ...g, ...patch } : g)))
  }

  // Sobe/desce um grupo de complemento na ordem que aparece pro cliente.
  // A ordem é salva (campo `ordem`) quando o produto é salvo.
  function moverVinculo(i, dir) {
    setVinculos(prev => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const arr = [...prev]
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      return arr
    })
  }
  function updOpcao(gi, oi, patch) {
    setGrupos(prev => prev.map((g, i) =>
      i === gi ? { ...g, opcoes: g.opcoes.map((o, j) => (j === oi ? { ...o, ...patch } : o)) } : g))
  }

  const [showCategModal, setShowCategModal] = useState(false)
  // Exclusão de categoria que ainda tem produtos: { id, nome, qtd, destino }
  const [catExcluir, setCatExcluir] = useState(null)
  const [excluindoCat, setExcluindoCat] = useState(false)
  const [dragIdx, setDragIdx] = useState(null)
  const [novaCategoria, setNovaCategoria] = useState('')
  const [savingCateg, setSavingCateg] = useState(false)
  const [categError, setCategError] = useState(null)
  const [duplicandoCatId, setDuplicandoCatId] = useState(null)  // categoria sendo duplicada
  const [editandoCatId, setEditandoCatId] = useState(null)      // categoria em edição de nome
  const [editandoCatNome, setEditandoCatNome] = useState('')
  const [salvandoRenome, setSalvandoRenome] = useState(false)

  const [embalagens, setEmbalagens] = useState([])
  const [showEmbalagensModal, setShowEmbalagensModal] = useState(false)
  const [novaEmbalagem, setNovaEmbalagem] = useState('')
  const [savingEmb, setSavingEmb] = useState(false)
  const [embError, setEmbError] = useState(null)

  async function loadCategorias() {
    const { data } = await supabase
      .from('categorias')
      .select('id, nome, ordem, hora_inicio, hora_fim, setor, isento_taxa')
      .order('ordem', { ascending: true })
      .order('nome', { ascending: true })
    const lista = data ?? []
    setCategorias(lista)
    // Conserta lista antiga com ordem 0 ou empatada (categoria criada antes do
    // fix). Renumera 1..n mantendo a ordem que já está aparecendo na tela.
    const ordens = lista.map(c => c.ordem ?? 0)
    const empatadaOuZerada = ordens.some(o => o < 1) || new Set(ordens).size !== ordens.length
    if (lista.length && empatadaOuZerada && !renumerouRef.current) {
      renumerouRef.current = true
      await persistOrdem(lista)
    }
    return lista
  }

  // Salva o horário de disponibilidade da categoria (hora_inicio/hora_fim).
  // Vazio => null (sempre disponível). Otimista + persiste.
  async function salvarHorarioCategoria(id, campo, valor) {
    const v = valor ? valor : null
    setCategorias(cs => cs.map(c => (c.id === id ? { ...c, [campo]: v } : c)))
    await supabase.from('categorias').update({ [campo]: v }).eq('id', id)
  }

  // Marca a categoria como COZINHA ou SALÃO (mig 0184). Quem lê isso é a
  // impressão da comanda de mesa: a térmica da cozinha só imprime os itens de
  // categoria 'cozinha', a da frente imprime o resto. A regra é salão sai tudo
  // menos o que é da cozinha, por isso o padrão é salão.
  async function salvarSetorCategoria(id, setor) {
    setCategorias(cs => cs.map(c => (c.id === id ? { ...c, setor } : c)))
    await supabase.from('categorias').update({ setor }).eq('id', id)
  }

  // Tira (ou devolve) a categoria da base da taxa de serviço (mig 0192). O item
  // continua na conta e no faturamento; só não entra na conta dos 10%. Nasceu do
  // couvert artístico: é o cachê do músico, não serviço de mesa.
  async function salvarIsentoTaxa(id, isento) {
    setCategorias(cs => cs.map(c => (c.id === id ? { ...c, isento_taxa: isento } : c)))
    await supabase.from('categorias').update({ isento_taxa: isento }).eq('id', id)
  }

  // Persiste a ordem 1..n de uma nova lista de categorias (otimista)
  async function persistOrdem(novaLista) {
    setCategorias(novaLista.map((c, i) => ({ ...c, ordem: i + 1 })))
    await Promise.all(novaLista.map((c, i) =>
      supabase.from('categorias').update({ ordem: i + 1 }).eq('id', c.id)))
    loadCategorias()
  }

  // Setas (reserva / celular)
  function moverCategoria(index, dir) {
    const outro = index + dir
    if (outro < 0 || outro >= categorias.length) return
    const arr = [...categorias]
    ;[arr[index], arr[outro]] = [arr[outro], arr[index]]
    persistOrdem(arr)
  }

  // Arrastar e soltar
  function onSoltarCategoria(dropIdx) {
    const from = dragIdx
    setDragIdx(null)
    if (from == null || from === dropIdx) return
    const arr = [...categorias]
    const [movida] = arr.splice(from, 1)
    arr.splice(dropIdx, 0, movida)
    persistOrdem(arr)
  }

  async function loadEmbalagens() {
    const { data } = await supabase
      .from('embalagens')
      .select('id, nome')
      .order('nome', { ascending: true })
    setEmbalagens(data ?? [])
  }

  const loadProdutos = useCallback(async (busca = '', categ = '') => {
    setLoading(true)
    setError(null)
    // Carrega tudo (até 1000) e a paginação é feita no cliente, seguindo a ORDEM
    // das categorias (Quentinhas, Janta, Lanches, Tapioca...). Assim a busca do
    // banco (alfabética) não separa mais uma categoria entre páginas diferentes.
    const termo = busca.trim()
    const nt = norm(termo)
    // Busca por COMPLEMENTO ignorando acento: filtra o conjunto (pequeno) de
    // categorias/opções da empresa no cliente e mapeia pros produtos via a ponte.
    let idsPorComp = []
    if (nt) {
      const { data: cats } = await supabase
        .from('complemento_grupos')
        .select('id, nome, complemento_opcoes(nome)')
        .eq('empresa_id', profile.empresa_id)
      const gruposMatch = (cats ?? [])
        .filter(g => norm(g.nome).includes(nt) || (g.complemento_opcoes ?? []).some(o => norm(o.nome).includes(nt)))
        .map(g => g.id)
      if (gruposMatch.length) {
        const { data: vinc } = await supabase
          .from('produto_complemento_grupos')
          .select('produto_id')
          .in('grupo_id', gruposMatch)
        idsPorComp = [...new Set((vinc ?? []).map(v => v.produto_id).filter(Boolean))]
      }
    }
    // Carrega os produtos (categoria filtra no banco) e o termo filtra no cliente
    // (nome sem acento OU casou por complemento).
    // fetchAll pagina: loja de deposito passa de 4 mil produtos e o corte em 1000
    // fazia o dono achar que a planilha nao tinha subido inteira.
    const montaQuery = () => {
      let q = supabase
        .from('produtos')
        .select('*')
        .order('nome', { ascending: true })
        .order('id')
      if (categ) q = q.eq('categoria', categ)
      return q
    }
    let { data, error } = await fetchAll(montaQuery)
    if (!error && nt) {
      const idset = new Set(idsPorComp)
      data = (data ?? []).filter(p => norm(p.nome).includes(nt) || idset.has(p.id))
    }
    const count = (data ?? []).length
    if (error) setError(error.message)
    else {
      setProdutos(data ?? [])
      setTotal(count ?? 0)
      // Complementos dos produtos exibidos (accordion pausável na própria lista)
      const ids = (data ?? []).map(p => p.id)
      if (ids.length) {
        const { data: gs } = await supabase
          .from('produto_complemento_grupos')
          .select('produto_id, ordem, min_override, max_override, complemento_grupos(id, nome, min, max, disponivel, complemento_opcoes(id, nome, preco_adicional, disponivel, ordem))')
          .in('produto_id', ids)
          .order('ordem')
        const map = {}
        for (const v of (gs ?? [])) {
          const g = v.complemento_grupos
          if (!g) continue
          const opcoes = (g.complemento_opcoes ?? []).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
          ;(map[v.produto_id] ??= []).push({
            id: g.id, nome: g.nome, min: v.min_override ?? g.min ?? 0, max: v.max_override ?? g.max ?? 1, ordem: v.ordem ?? 0,
            disponivel: g.disponivel !== false, opcoes,
          })
        }
        for (const pid in map) map[pid].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
        setCompProd(map)
        // Achou pelo complemento? abre o accordion desses produtos pra já ver/pausar o complemento.
        if (idsPorComp.length) {
          const shown = new Set(ids)
          setCompAberto(new Set(idsPorComp.filter(id => shown.has(id))))
        }
      } else setCompProd({})
    }
    setLoading(false)
  }, [])

  // Pausar/ativar disponibilidade do produto (1 clique na lista). Não é estoque —
  // é só ligar/desligar o item pra vender (loja online, bot, balcão).
  async function togglePausar(p) {
    const novo = !p.ativo
    setProdutos(prev => prev.map(x => x.id === p.id ? { ...x, ativo: novo } : x))
    const { error } = await supabase.from('produtos').update({ ativo: novo }).eq('id', p.id)
    if (error) {
      setProdutos(prev => prev.map(x => x.id === p.id ? { ...x, ativo: !novo } : x))
      setError(error.message)
    }
  }

  function handleSearch(val) {
    setSearch(val)
    setPage(0)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => loadProdutos(val, categoriaFiltro), 400)
  }

  function handleCategoria(val) {
    setCategoriaFiltro(val)
    setPage(0)
    loadProdutos(search, val)
  }

  function irParaPagina(pg) {
    // Paginação no cliente: só troca a página, sem recarregar do banco.
    setPage(pg)
  }

  useEffect(() => {
    loadProdutos('', '')
    loadCategorias()
    loadEmbalagens()
  }, [loadProdutos])

  async function handleSaveCategoria(e) {
    e.preventDefault()
    const nome = novaCategoria.trim()
    if (!nome) return
    if (!profile?.empresa_id) { setCategError('Empresa não identificada.'); return }
    setSavingCateg(true)
    setCategError(null)
    const { error } = await supabase.rpc('add_categoria', { p_nome: nome })
    setSavingCateg(false)
    if (error) { setCategError(error.message); return }
    setNovaCategoria('')
    // A RPC cria a categoria com ordem 0: sem isso ela pularia pro topo do
    // cardápio e empataria com as outras recém-criadas. Entra no fim da fila.
    const lista = await loadCategorias()
    const nova = lista.find(c => c.nome === nome)
    if (nova) await persistOrdem([...lista.filter(c => c.id !== nova.id), nova])
  }

  function iniciarRenomear(c) {
    setCategError(null)
    setEditandoCatId(c.id)
    setEditandoCatNome(c.nome)
  }
  function cancelarRenomear() {
    setEditandoCatId(null)
    setEditandoCatNome('')
  }
  // Renomeia a categoria e arrasta os produtos junto (RPC atômica no banco).
  async function salvarRenomear(c) {
    const nome = editandoCatNome.trim()
    if (!nome || nome === c.nome) { cancelarRenomear(); return }
    setSalvandoRenome(true)
    setCategError(null)
    const { error } = await supabase.rpc('renomear_categoria', { p_id: c.id, p_nome: nome })
    setSalvandoRenome(false)
    if (error) { setCategError(error.message); return }
    cancelarRenomear()
    await loadCategorias()
    await loadProdutos(search, categoriaFiltro)
    // Se o filtro estava nessa categoria, acompanha o nome novo.
    if (categoriaFiltro === c.nome) setCategoriaFiltro(nome)
  }

  async function handleDeleteCategoria(id, nome) {
    // Categoria com produtos dentro precisa de destino. Sem perguntar, os
    // produtos ficavam com o nome de uma categoria que não existe mais: somem do
    // filtro e da lista de envio pro iFood, e o lojista não tem como saber.
    const { count } = await supabase.from('produtos')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', profile.empresa_id).eq('categoria', nome)

    if (count > 0) { setCatExcluir({ id, nome, qtd: count, destino: '' }); return }

    const ok = await confirmar({
      titulo: `Excluir a categoria “${nome}”?`,
      texto: 'A categoria some da lista — não dá pra desfazer.',
      aviso: 'Ela está vazia, então nenhum produto é afetado.',
      textoOk: 'Sim, excluir',
    })
    if (!ok) return
    const { error } = await supabase.from('categorias').delete().eq('id', id)
    if (error) { setCategError(error.message); return }
    loadCategorias()
  }

  // Move os produtos pra outra categoria (ou apaga junto) e só então tira a
  // categoria da lista.
  async function confirmarExclusaoCategoria(apagarProdutos) {
    const { id, nome, destino, qtd } = catExcluir
    if (!apagarProdutos && !destino) { setCategError('Escolha pra onde vão os produtos.'); return }

    if (apagarProdutos) {
      const ok = await confirmar({
        titulo: `Excluir “${nome}” e os ${qtd} produtos dela?`,
        texto: 'Os produtos somem do cardápio de vez, aqui e no iFood se estiverem publicados lá. Não dá pra desfazer.',
        aviso: 'As vendas antigas continuam certinhas — cada venda guarda o nome e o preço do que foi vendido.',
        textoOk: `Sim, excluir a categoria e ${qtd} produto(s)`,
      })
      if (!ok) return
    }

    setExcluindoCat(true); setCategError(null)
    const r = apagarProdutos
      ? await supabase.from('produtos').delete().eq('empresa_id', profile.empresa_id).eq('categoria', nome)
      : await supabase.from('produtos').update({ categoria: destino }).eq('empresa_id', profile.empresa_id).eq('categoria', nome)

    if (r.error) { setExcluindoCat(false); setCategError(r.error.message); return }

    const { error } = await supabase.from('categorias').delete().eq('id', id)
    setExcluindoCat(false)
    if (error) { setCategError(error.message); return }
    setCatExcluir(null)
    await loadCategorias()
    await loadProdutos(search, categoriaFiltro)
  }

  async function handleAddEmbalagem(e) {
    e.preventDefault()
    const nome = novaEmbalagem.trim()
    if (!nome) return
    setSavingEmb(true)
    setEmbError(null)
    const { error } = await supabase.rpc('add_embalagem', { p_nome: nome })
    setSavingEmb(false)
    if (error) { setEmbError(error.message); return }
    setNovaEmbalagem('')
    loadEmbalagens()
  }

  async function handleDeleteEmbalagem(id, nome) {
    const ok = await confirmar({
      titulo: `Excluir a embalagem “${nome}”?`,
      texto: 'Ela some da lista de escolha — não dá pra desfazer.',
      textoOk: 'Sim, excluir',
    })
    if (!ok) return
    const { error } = await supabase.from('embalagens').delete().eq('id', id)
    if (error) { setEmbError(error.message); return }
    loadEmbalagens()
  }

  function openNew() {
    setEditingId(null)
    setVinculos([]); setVincOriginais([])
    setEstoqueQtd(''); setEstoqueSaldo(0)
    loadCategoriasEmpresa()
    setForm({ ...emptyForm, categoria: categorias[0]?.nome ?? '' })
    setShowModal(true)
  }

  function openEdit(produto) {
    setEditingId(produto.id)
    setVinculos([]); setVincOriginais([])
    setEstoqueQtd(''); setEstoqueSaldo(0)
    loadCategoriasEmpresa()
    loadComplementos(produto.id)
    loadSaldoProduto(produto.id)
    setForm({
      nome: produto.nome ?? '',
      categoria: produto.categoria ?? categorias[0]?.nome ?? '',
      embalagem: produto.embalagem ?? 'caixa',
      unidades_por_caixa: produto.unidades_por_caixa ?? 1,
      controla_casco: produto.controla_casco ?? false,
      controla_estoque: produto.controla_estoque ?? true,
      preco_custo: produto.preco_custo ?? 0,
      custo_modo: produto.custo_pct_venda != null ? 'pct' : 'fixo',
      custo_pct_venda: produto.custo_pct_venda ?? '',
      preco_venda: produto.preco_venda ?? 0,
      preco_promocional: produto.preco_promocional ?? '',
      preco_app: produto.preco_app ?? 0,
      faixas_preco: produto.faixas_preco ?? [],
      estoque_minimo: produto.estoque_minimo ?? 0,
      ativo: produto.ativo ?? true,
      foto_url: produto.foto_url ?? '',
      descricao: produto.descricao ?? '',
    })
    setShowModal(true)
  }

  // Saldo atual do produto (mesma view que a tela Estoque usa) pra mostrar
  // "tem X hoje" e calcular a diferença quando o dono digitar a contagem nova.
  async function loadSaldoProduto(produtoId) {
    if (!usaEstoque || !produtoId) return
    setCarregandoSaldo(true)
    const { data } = await supabase
      .from('estoque_saldo')
      .select('quantidade_atual')
      .eq('produto_id', produtoId)
      .maybeSingle()
    setEstoqueSaldo(Number(data?.quantidade_atual ?? 0))
    setCarregandoSaldo(false)
  }

  // Grava a movimentação do que foi digitado no cadastro. É CONTAGEM, não soma:
  // guardamos só a diferença pro saldo atual (igual o "ajuste" da tela Estoque),
  // senão quem edita o produto de novo dobraria o estoque.
  async function gravarMovimentoEstoque(produtoId, novoEditando) {
    if (!usaEstoque || !form.controla_estoque) return null
    if (estoqueQtd === '' || estoqueQtd == null) return null
    const contado = Number(estoqueQtd)
    if (!Number.isFinite(contado) || contado < 0) return null
    const atual = novoEditando ? estoqueSaldo : 0
    const diferenca = contado - atual
    if (diferenca === 0) return null
    // Estoque inicial do cadastro: o custo digitado ali vale como preço de compra,
    // pro histórico de compras não nascer sem valor.
    const custoCad = Number(String(form.preco_custo ?? '').replace(',', '.'))
    const unit = !novoEditando && Number.isFinite(custoCad) && custoCad > 0 ? custoCad : null
    const { error } = await supabase.from('estoque_movimentos').insert({
      produto_id: produtoId,
      tipo: diferenca > 0 ? 'entrada' : 'saida',
      quantidade: Math.abs(diferenca),
      motivo: novoEditando ? 'ajuste_inventario' : 'compra',
      observacao: novoEditando
        ? `Ajuste pelo cadastro do produto: contado ${contado}`
        : `Estoque inicial no cadastro: ${contado}`,
      custo_unit: unit,
      valor_total: unit ? unit * Math.abs(diferenca) : null,
    })
    return error?.message ?? null
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target
    setForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }))
  }

  async function handleFotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!profile?.empresa_id) { setError('Empresa não identificada para upload.'); return }

    setUploadingFoto(true)
    setError(null)

    const arquivo = await comprimirImagem(file)
    // Nome vindo da câmera/galeria pode ter acento e espaço — o storage recusa.
    const nomeSeguro = (arquivo.name || 'foto.jpg')
      .normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^\w.-]+/g, '_')
    const path = `${profile.empresa_id}/${Date.now()}_${nomeSeguro}`
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('produto-fotos')
      .upload(path, arquivo, { upsert: true })

    setUploadingFoto(false)

    if (uploadError) { setError(`Erro no upload: ${uploadError.message}`); return }

    const { data: urlData } = supabase.storage
      .from('produto-fotos')
      .getPublicUrl(uploadData.path)

    setForm(prev => ({ ...prev, foto_url: urlData.publicUrl }))
    // Zera o input: sem isso, escolher/tirar a mesma foto de novo não dispara o onChange.
    e.target.value = ''
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const payload = {
      ...form,
      unidades_por_caixa: Number(form.unidades_por_caixa) || 1,
      // Só um dos dois vale: no modo % o custo em R$ vai a zero pra não somar duas vezes.
      preco_custo: form.custo_modo === 'pct' ? 0 : (Number(form.preco_custo) || 0),
      custo_pct_venda: form.custo_modo === 'pct' && form.custo_pct_venda !== ''
        ? Math.max(0, Math.min(100, Number(form.custo_pct_venda) || 0))
        : null,
      preco_venda: Number(form.preco_venda) || 0,
      // Vazio, zero ou maior/igual ao preço = SEM promoção. Guardar um valor que
      // não é menor riscaria o preço e mostraria outro igual do lado (e o banco
      // recusa, mig 0202).
      preco_promocional: (Number(form.preco_promocional) > 0
        && Number(form.preco_promocional) < (Number(form.preco_venda) || 0))
        ? Number(form.preco_promocional) : null,
      preco_app: Number(form.preco_app) || 0,
      estoque_minimo: Number(form.estoque_minimo) || 0,
      faixas_preco: form.faixas_preco ?? [],
    }
    // `custo_modo` é só da tela (escolhe R$ ou %) — não existe coluna pra ele.
    delete payload.custo_modo

    const { data: saved, error } = editingId
      ? await supabase.from('produtos').update(payload).eq('id', editingId).select('id').single()
      : await supabase.from('produtos').insert(payload).select('id').single()

    if (error) {
      setSaving(false)
      setError(error.message)
      return
    }

    // Reconcilia só os VÍNCULOS com categorias (as opções vivem na tela Complementos).
    // Nunca apagamos/recriamos a categoria aqui — ela é compartilhada entre produtos.
    const produtoId = saved.id
    try {
      const removidos = vincOriginais.filter(o => o.linkId && !vinculos.some(a => a.grupo_id === o.grupo_id))
      for (const r of removidos) await supabase.from('produto_complemento_grupos').delete().eq('id', r.linkId)
      for (const [i, a] of vinculos.entries()) {
        const ov = a.max_override == null || a.max_override === '' ? null : Math.max(1, Number(a.max_override) || 1)
        if (a.linkId) {
          await supabase.from('produto_complemento_grupos').update({ max_override: ov, ordem: i }).eq('id', a.linkId)
        } else {
          await supabase.from('produto_complemento_grupos').insert({ produto_id: produtoId, grupo_id: a.grupo_id, max_override: ov, ordem: i })
        }
      }
    } catch (err) {
      setSaving(false)
      setError('Produto salvo, mas houve erro nos complementos: ' + (err?.message ?? err))
      return
    }

    // Estoque digitado no próprio cadastro (entrada no produto novo, ajuste na edição).
    const erroEstoque = await gravarMovimentoEstoque(produtoId, Boolean(editingId))
    if (erroEstoque) {
      setSaving(false)
      setError('Produto salvo, mas o estoque não foi lançado: ' + erroEstoque)
      return
    }

    setSaving(false)
    fecharModal()
    loadProdutos(search, categoriaFiltro)
  }

  async function handleDelete(p) {
    const ok = await confirmar({
      titulo: `Excluir “${p.nome}”?`,
      texto: 'Apaga o item do cardápio de vez, aqui e no iFood se ele estiver publicado lá. Não dá pra desfazer — pra ter de volta, tem que cadastrar de novo.',
      itens: [`${p.nome}${p.preco_venda ? ` · R$ ${Number(p.preco_venda).toFixed(2)}` : ''}`],
      aviso: 'As vendas antigas continuam certinhas: cada venda guarda o nome e o preço do que foi vendido. Se é só uma pausa (acabou o ingrediente), use o botão Pausar.',
      textoOk: 'Sim, excluir',
    })
    if (!ok) return
    const { error } = await supabase.from('produtos').delete().eq('id', p.id)
    if (!error) { loadProdutos(search, categoriaFiltro); return }

    // Antes da migração 0210 o item já vendido não podia ser apagado, porque a
    // venda dependia do produto pro nome. Hoje a venda guarda o nome, então isso
    // não deveria mais acontecer — se acontecer, é outra coisa, e o erro é dito.
    setError(error.message)
  }

  // Arquivar saiu de cena: excluir apaga de vez e as vendas antigas continuam
  // legíveis sozinhas, porque cada venda guarda o nome e o preço do que vendeu
  // (migração 0210). Sem nada que arquive, a tela "Ver arquivados" só ocupava
  // espaço — e ela estava vazia em todas as lojas. A coluna arquivado_em segue
  // no banco por compatibilidade, sem ninguém escrevendo nela.

  // Cria uma cópia de um produto (com todos os campos + os vínculos de complementos).
  // Se `novaCategoria` vier, a cópia vai pra essa categoria mantendo o nome (usado ao
  // duplicar categoria inteira). Senão, mantém a categoria e acrescenta "(cópia)" no nome.
  // Lança erro pra quem chamou tratar (não mexe em estado de UI aqui).
  async function duplicarProdutoCore(p, novaCategoria = null) {
    // Descarta id/created_at pra o banco gerar novos; o resto (inclusive empresa_id) copia igual.
    // eslint-disable-next-line no-unused-vars
    const { id, created_at, ...rest } = p
    // A cópia nunca nasce arquivada, mesmo se a origem estiver.
    const novo = { ...rest, arquivado_em: null }
    if (novaCategoria != null) novo.categoria = novaCategoria
    else novo.nome = `${p.nome} (cópia)`

    const { data: saved, error } = await supabase
      .from('produtos').insert(novo).select('id').single()
    if (error) throw error

    // Copia os vínculos de complementos (as opções são compartilhadas — só religamos os grupos).
    const { data: links } = await supabase
      .from('produto_complemento_grupos')
      .select('grupo_id, max_override, min_override, ordem')
      .eq('produto_id', p.id)
    if (links?.length) {
      const { error: le } = await supabase
        .from('produto_complemento_grupos')
        .insert(links.map(l => ({ ...l, produto_id: saved.id })))
      if (le) throw le
    }
    return saved.id
  }

  async function handleDuplicarProduto(p) {
    setDuplicandoId(p.id)
    setError(null)
    try {
      await duplicarProdutoCore(p)
      await loadProdutos(search, categoriaFiltro)
    } catch (err) {
      setError('Erro ao duplicar: ' + (err?.message ?? err))
    } finally {
      setDuplicandoId(null)
    }
  }

  // Duplica a categoria inteira: cria "<nome> (cópia)" e replica todos os produtos dela.
  async function handleDuplicarCategoria(c) {
    const { data: prods, error: e0 } = await supabase
      .from('produtos').select('*').eq('categoria', c.nome).is('arquivado_em', null)
    if (e0) { setCategError(e0.message); return }
    const n = prods?.length ?? 0
    const novoNome = `${c.nome} (cópia)`
    const ok = await confirmar({
      titulo: `Duplicar a categoria “${c.nome}”?`,
      texto: `Cria a categoria “${novoNome}” com uma cópia de cada um dos ${n} produto${n === 1 ? '' : 's'} dela.`,
      textoOk: 'Duplicar',
      perigo: false,
      icone: '⧉',
    })
    if (!ok) return

    setDuplicandoCatId(c.id)
    setCategError(null)
    try {
      const { error: e1 } = await supabase.rpc('add_categoria', { p_nome: novoNome })
      if (e1) throw e1
      // Um a um pra também copiar os complementos de cada produto.
      for (const p of (prods ?? [])) await duplicarProdutoCore(p, novoNome)
      await loadCategorias()
      await loadProdutos(search, categoriaFiltro)
    } catch (err) {
      setCategError('Erro ao duplicar categoria: ' + (err?.message ?? err))
    } finally {
      setDuplicandoCatId(null)
    }
  }

  // Sobe/desce o produto DENTRO da categoria dele. Grava a categoria inteira
  // numerada 1..n em vez de so os dois que trocaram: se metade estivesse com
  // ordem e metade com null, a lista pularia de lugar a cada mexida.
  const [reordenando, setReordenando] = useState(null)
  async function moverProduto(prod, dir) {
    const daCategoria = [...produtos]
      .filter(x => (x.categoria ?? '') === (prod.categoria ?? ''))
      .sort((a, b) => {
        const pa = a.ordem ?? Number.MAX_SAFE_INTEGER
        const pb = b.ordem ?? Number.MAX_SAFE_INTEGER
        if (pa !== pb) return pa - pb
        return (a.nome ?? '').localeCompare(b.nome ?? '')
      })
    const i = daCategoria.findIndex(x => x.id === prod.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= daCategoria.length) return
    ;[daCategoria[i], daCategoria[j]] = [daCategoria[j], daCategoria[i]]

    const novaOrdem = new Map(daCategoria.map((x, k) => [x.id, k + 1]))
    setProdutos(prev => prev.map(x => novaOrdem.has(x.id) ? { ...x, ordem: novaOrdem.get(x.id) } : x))
    setReordenando(prod.id)
    await Promise.all(daCategoria.map((x, k) =>
      supabase.from('produtos').update({ ordem: k + 1 }).eq('id', x.id)))
    setReordenando(null)
  }

  // Ordena os produtos exibidos seguindo a ordem personalizada das categorias.
  // O desempate é SEMPRE pelo nome da categoria antes do nome do produto: duas
  // categorias com a mesma `ordem` iam se misturar item a item e a lista repetia
  // o cabeçalho de cada uma (PICOLES / DOCES / PICOLES / DOCES...).
  const catOrdem = Object.fromEntries(categorias.map(c => [c.nome, c.ordem ?? 999]))
  const produtosOrdenados = [...produtos].sort((a, b) => {
    const oa = catOrdem[a.categoria] ?? 999
    const ob = catOrdem[b.categoria] ?? 999
    if (oa !== ob) return oa - ob
    const porCategoria = (a.categoria ?? '').localeCompare(b.categoria ?? '')
    if (porCategoria !== 0) return porCategoria
    // Ordem manual dentro da categoria (mig 0201). Quem nunca foi ordenado
    // (null) cai no fim, em ordem alfabetica — ninguem precisa arrastar as 78
    // linhas pra comecar a usar.
    const pa = a.ordem ?? Number.MAX_SAFE_INTEGER
    const pb = b.ordem ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return (a.nome ?? '').localeCompare(b.nome ?? '')
  })
  // Paginação client-side sobre a lista JÁ ordenada pelas categorias
  const produtosPagina = produtosOrdenados.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const totalPaginas = Math.ceil(produtosOrdenados.length / PAGE_SIZE)
  const usaCasco = produtos.some((p) => p.controla_casco)
  // Nome, Categoria, Custo, Venda, Disponível e ações são fixas.
  const totalColunas = 6 + (MOSTRAR_PRECO_APP ? 1 : 0) + (usaEstoque ? 3 : 0) + (usaCasco ? 1 : 0)

  return (
    <div>
      {avisoConfirmar}
      <div className="page-header">
        <h1>Produtos</h1>
        <div className="prod-header-acoes">
          <button className="btn btn-secondary" onClick={() => { setCategError(null); setShowCategModal(true) }}>
            ☰ Categorias
          </button>
          <button className="btn btn-secondary" onClick={() => { setEmbError(null); setShowEmbalagensModal(true) }}>
            + Nova embalagem
          </button>
          <button className="btn btn-primary" onClick={openNew}>
            + Novo produto
          </button>
        </div>
      </div>

      {/* Banner link do cardápio */}
      {linkCardapio && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          background: 'var(--surface-hover)',
          border: '1px solid var(--border, #e5e7eb)',
          borderRadius: '10px', padding: '12px 16px', marginBottom: '1rem',
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
            🛒 Link do seu cardápio:
          </span>
          <span style={{
            fontSize: 13, color: 'var(--text-muted, #6b7280)',
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {linkCardapio}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
            <button className="btn btn-secondary btn-sm" onClick={copiarLink}>
              {copiadoLink ? '✓ Copiado!' : 'Copiar'}
            </button>
            <a href={linkCardapio} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
              Abrir
            </a>
          </div>
        </div>
      )}

      <div className="toolbar">
        <input
          placeholder="Buscar por nome..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
        />
        <select
          value={categoriaFiltro}
          onChange={(e) => handleCategoria(e.target.value)}
        >
          <option value="">Todas as categorias</option>
          {categorias.map((c) => (
            <option key={c.id} value={c.nome}>
              {c.nome}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* tabela-produtos: no celular esconde as colunas de detalhe (col-extra) e
          deixa os botões só com o ícone — o nome do produto é o que importa lá. */}
      <div className="data-table tabela-produtos">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : produtos.length === 0 ? (
          <div className="empty-state">Nenhum produto encontrado.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th className="col-extra">Categoria</th>
                {usaEstoque && <th className="col-extra">Embalagem</th>}
                {usaEstoque && <th className="col-extra">Un./caixa</th>}
                {usaCasco && <th className="col-extra">Casco</th>}
                <th className="col-extra">Custo</th>
                <th>Venda</th>
                {MOSTRAR_PRECO_APP && <th className="col-extra">Venda App</th>}
                {usaEstoque && <th className="col-extra">Estoque mín.</th>}
                <th>Disponível</th>
                <th className="prod-acoes-th"></th>
              </tr>
            </thead>
            <tbody>
              {produtosPagina.map((p, idx) => {
                const catAnterior = idx === 0 ? null : produtosPagina[idx - 1].categoria
                const mudouCategoria = p.categoria !== catAnterior
                return (
                  <React.Fragment key={p.id}>
                    {mudouCategoria && (
                      <tr>
                        <td colSpan={totalColunas} style={{
                          padding: '10px 12px 6px',
                          fontWeight: 700,
                          fontSize: 12,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          color: 'var(--primary)',
                          background: 'var(--primary-bg)',
                          borderTop: idx !== 0 ? '2px solid var(--border)' : 'none',
                        }}>
                          {p.categoria || 'Sem categoria'}
                        </td>
                      </tr>
                    )}
                    <tr>
                  <td>
                    <div className="prod-nome">
                      {/* Sobe/desce dentro da categoria. Fica escondido enquanto
                          uma busca ou filtro esta ativo: a lista ali nao e a
                          categoria inteira, e trocar posicao no que esta
                          filtrado bagunçaria o que nao aparece. */}
                      {!search && (
                        <div className="prod-ordem">
                          <button
                            type="button" title="Subir na categoria"
                            disabled={reordenando === p.id}
                            onClick={() => moverProduto(p, -1)}
                          >↑</button>
                          <button
                            type="button" title="Descer na categoria"
                            disabled={reordenando === p.id}
                            onClick={() => moverProduto(p, 1)}
                          >↓</button>
                        </div>
                      )}
                      {p.foto_url ? (
                        <img className="prod-foto" src={p.foto_url} alt={p.nome} />
                      ) : (
                        <div className="prod-foto prod-foto-vazia">📷</div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
                        <span>{p.nome}</span>
                        {(compProd[p.id]?.length > 0) && (
                          <button
                            type="button"
                            onClick={() => toggleAbrirComp(p.id)}
                            title="Ver e pausar os complementos"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                              padding: '3px 10px', borderRadius: 20, fontWeight: 700, fontSize: 12,
                              border: `1.5px solid ${compAberto.has(p.id) ? '#2563eb' : 'var(--border)'}`,
                              background: compAberto.has(p.id) ? 'rgba(37,99,235,.12)' : 'transparent',
                              color: compAberto.has(p.id) ? '#2563eb' : 'var(--text-muted)',
                            }}
                          >
                            Complementos
                            <span style={{ fontWeight: 800, background: 'rgba(148,163,184,.25)', borderRadius: 20, padding: '0 6px' }}>{compProd[p.id].length}</span>
                            <span style={{ transform: compAberto.has(p.id) ? 'rotate(180deg)' : 'none', transition: 'transform .15s', fontSize: 10 }}>▼</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="col-extra">{p.categoria}</td>
                  {usaEstoque && <td className="col-extra">{p.embalagem}</td>}
                  {usaEstoque && <td className="col-extra">{p.unidades_por_caixa}</td>}
                  {usaCasco && <td className="col-extra">{p.controla_casco ? 'Sim' : 'Não'}</td>}
                  <td className="col-extra">
                    {p.custo_pct_venda != null
                      ? <span title="Custo estimado como % do valor vendido">{Number(p.custo_pct_venda)}% do vendido</span>
                      : `R$ ${Number(p.preco_custo).toFixed(2)}`}
                  </td>
                  <td>
                    {p.preco_promocional > 0 && p.preco_promocional < p.preco_venda ? (
                      <>
                        <s style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          R$ {Number(p.preco_venda).toFixed(2)}
                        </s>{' '}
                        <strong style={{ color: '#22c55e' }}>
                          R$ {Number(p.preco_promocional).toFixed(2)}
                        </strong>
                      </>
                    ) : `R$ ${Number(p.preco_venda).toFixed(2)}`}
                  </td>
                  {MOSTRAR_PRECO_APP && <td className="col-extra">R$ {Number(p.preco_app || 0).toFixed(2)}</td>}
                  {usaEstoque && <td className="col-extra">{p.estoque_minimo}</td>}
                  <td>
                    <button
                      type="button"
                      onClick={() => togglePausar(p)}
                      title={p.ativo ? 'Pausar — deixa indisponível pra vender' : 'Ativar — volta a aparecer pra vender'}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                        padding: '5px 12px', borderRadius: 20, fontWeight: 700, fontSize: 13,
                        border: `1.5px solid ${p.ativo ? '#16a34a' : '#eab308'}`,
                        background: p.ativo ? 'rgba(22,163,74,.12)' : 'rgba(234,179,8,.16)',
                        color: p.ativo ? '#16a34a' : '#a16207',
                      }}
                    >
                      {p.ativo ? '⏸' : '▶'}<span className="btn-label">{p.ativo ? ' Pausar' : ' Ativar'}</span>
                    </button>
                  </td>
                  <td className="prod-acoes-cell">
                    <div className="prod-acoes">
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => openEdit(p)}
                            title="Editar"
                          >
                            ✏️<span className="btn-label"> Editar</span>
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleDuplicarProduto(p)}
                            disabled={duplicandoId === p.id}
                            title="Criar uma cópia deste item"
                          >
                            {duplicandoId === p.id ? '...' : <>⧉<span className="btn-label"> Duplicar</span></>}
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDelete(p)}
                            title="Excluir"
                          >
                            🗑<span className="btn-label"> Excluir</span>
                          </button>
                    </div>
                  </td>
                </tr>
                {/* Complementos aninhados (grupos + opções) — estilo iFood */}
                {compAberto.has(p.id) && (compProd[p.id]?.length > 0) && (
                  <tr>
                    <td colSpan={11} style={{ padding: 0, background: 'var(--bg-hover)' }}>
                      <div className="prod-comp-lista" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {(() => {
                          // Ao buscar, mostra só as opções que casam com o termo (sem acento).
                          // Se o termo casa o NOME da categoria, mostra a categoria inteira.
                          const nt = norm(search.trim())
                          let gruposMostrar = compProd[p.id]
                          if (nt) {
                            const filtrados = compProd[p.id].map(g => {
                              const matched = g.opcoes.filter(o => norm(o.nome).includes(nt))
                              if (matched.length) return { ...g, opcoes: matched }
                              if (norm(g.nome).includes(nt)) return g
                              return null
                            }).filter(Boolean)
                            if (filtrados.length) gruposMostrar = filtrados
                          }
                          return gruposMostrar.map(g => {
                          const gPausado = g.disponivel === false
                          const qtd = g.max > 1 ? `escolha até ${g.max}` : (g.min > 0 ? 'obrigatório' : 'opcional')
                          return (
                            <div key={g.id} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface)', opacity: gPausado ? 0.6 : 1 }}>
                              {/* Cabeçalho do grupo (subcategoria) */}
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px', background: 'var(--bg)' }}>
                                <div>
                                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>
                                    {g.nome}
                                    {gPausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                                  </div>
                                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{qtd} · {g.opcoes.length} {g.opcoes.length === 1 ? 'opção' : 'opções'}</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => togglePausarGrupoLista(p.id, g)}
                                  disabled={pausandoComp === g.id}
                                  style={{
                                    flexShrink: 0, padding: '6px 14px', borderRadius: 20, cursor: 'pointer',
                                    fontWeight: 700, fontSize: 13, border: '1.5px solid',
                                    borderColor: gPausado ? '#16a34a' : '#dc2626',
                                    background: gPausado ? 'rgba(22,163,74,.12)' : 'rgba(239,68,68,.12)',
                                    color: gPausado ? '#16a34a' : '#dc2626',
                                  }}
                                >
                                  {pausandoComp === g.id ? '...' : gPausado ? '▶ Ativar grupo' : '⏸ Pausar grupo'}
                                </button>
                              </div>
                              {/* Opções do grupo */}
                              {g.opcoes.map(op => {
                                const oPausado = op.disponivel === false
                                const oMatch = norm(search).length >= 2 && norm(op.nome).includes(norm(search))
                                return (
                                  <div key={op.id} style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                                    padding: '7px 12px', borderTop: '1px solid var(--border)', opacity: oPausado ? 0.55 : 1,
                                    background: oMatch ? 'rgba(239,68,68,.10)' : 'transparent',
                                  }}>
                                    <div style={{ fontSize: 13, color: oMatch ? '#dc2626' : 'var(--text)', fontWeight: oMatch ? 800 : 400 }}>
                                      {op.nome}
                                      {Number(op.preco_adicional) > 0 && <span style={{ color: 'var(--text-muted)' }}> · +R$ {Number(op.preco_adicional).toFixed(2)}</span>}
                                      {oPausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => togglePausarOpcaoLista(p.id, g.id, op)}
                                      disabled={pausandoComp === op.id}
                                      style={{
                                        flexShrink: 0, padding: '5px 14px', borderRadius: 20, cursor: 'pointer',
                                        fontWeight: 700, fontSize: 13, border: '1.5px solid',
                                        borderColor: oPausado ? '#16a34a' : '#dc2626',
                                        background: oPausado ? 'rgba(22,163,74,.12)' : 'rgba(239,68,68,.12)',
                                        color: oPausado ? '#16a34a' : '#dc2626',
                                      }}
                                    >
                                      {pausandoComp === op.id ? '...' : oPausado ? '▶ Ativar' : '⏸ Pausar'}
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          )
                          })
                        })()}
                      </div>
                    </td>
                  </tr>
                )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {totalPaginas > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '16px 0' }}>
          <button className="btn btn-secondary btn-sm" disabled={page === 0} onClick={() => irParaPagina(page - 1)}>
            ← Anterior
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, produtosOrdenados.length)} de {produtosOrdenados.length} produtos
          </span>
          <button className="btn btn-secondary btn-sm" disabled={page + 1 >= totalPaginas} onClick={() => irParaPagina(page + 1)}>
            Próximo →
          </button>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay">
          <div className="modal modal-wide prod-form" onClick={(e) => e.stopPropagation()}>
            <div className="pf-topo">
              <h2>{editingId ? 'Editar produto' : 'Novo produto'}</h2>
              <button
                type="button"
                className="pf-fechar"
                onClick={fecharModal}
                aria-label="Fechar"
              >✕</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <div className="pf-secao"><span>Produto</span></div>
                <div className="form-field full">
                  <label>Nome</label>
                  <input
                    name="nome"
                    value={form.nome}
                    onChange={handleChange}
                    placeholder="Ex: Café com leite"
                    required
                  />
                </div>

                <div className="form-field full">
                  <label>Descrição (aparece no portal do cliente)</label>
                  <textarea
                    name="descricao"
                    value={form.descricao}
                    onChange={handleChange}
                    rows={2}
                    placeholder="Ex: Cerveja gelada, 350ml, sabor original..."
                    style={{ resize: 'vertical', minHeight: 56 }}
                  />
                </div>

                <div className="form-field full">
                  <label>Foto do produto</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleFotoChange}
                  />
                  {/* No celular a câmera precisa de um input PRÓPRIO com `capture`:
                      o mesmo input não consegue ser "galeria" e "câmera" ao mesmo tempo. */}
                  {EH_CELULAR && (
                    <input
                      ref={camInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      style={{ display: 'none' }}
                      onChange={handleFotoChange}
                    />
                  )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingFoto}
                    >
                      {uploadingFoto ? 'Enviando...' : (EH_CELULAR ? '🖼 Escolher da galeria' : 'Escolher foto')}
                    </button>
                    {EH_CELULAR && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => camInputRef.current?.click()}
                        disabled={uploadingFoto}
                      >
                        {uploadingFoto ? 'Enviando...' : '📷 Tirar foto agora'}
                      </button>
                    )}
                  </div>
                  {form.foto_url && (
                    <img
                      src={form.foto_url}
                      alt="Foto do produto"
                      className="prod-form-foto"
                      style={{ marginTop: 8 }}
                    />
                  )}
                </div>

                <div className="form-field">
                  <label>Categoria</label>
                  <CategoriaCombobox categorias={categorias} value={form.categoria} onChange={handleChange} />
                </div>

                {/* Embalagem escondida por enquanto (sem utilidade ainda) */}
                {false && (
                <div className="form-field">
                  <label>Embalagem</label>
                  <select
                    name="embalagem"
                    value={form.embalagem}
                    onChange={handleChange}
                  >
                    <option value="">Selecione...</option>
                    {embalagens.map((e) => (
                      <option key={e.id} value={e.nome}>
                        {e.nome}
                      </option>
                    ))}
                  </select>
                </div>
                )}

                {/* Unidades por caixa só faz sentido quando controla estoque (ex.: caixa de bebida) */}
                {usaEstoque && form.controla_estoque && (
                <div className="form-field">
                  <label>Unidades por caixa</label>
                  <input
                    type="number"
                    min="1"
                    name="unidades_por_caixa"
                    value={form.unidades_por_caixa}
                    onChange={handleChange}
                  />
                </div>
                )}

                {/* Controla vasilhame escondido por enquanto (sem uso neste contexto) */}
                {false && (
                <div className="form-field">
                  <label>
                    <input
                      type="checkbox"
                      name="controla_casco"
                      checked={form.controla_casco}
                      onChange={handleChange}
                    />{' '}
                    Controla vasilhame (casco)
                  </label>
                </div>
                )}

                {/* A loja desligou o estoque inteiro: escolher produto por
                    produto não faz mais sentido. */}
                {usaEstoque && (
                <div className="form-field">
                  <label>
                    <input
                      type="checkbox"
                      name="controla_estoque"
                      checked={form.controla_estoque}
                      onChange={handleChange}
                    />{' '}
                    Controla estoque{' '}
                    <span style={{ color: 'var(--text-muted, #888)', fontWeight: 400, fontSize: 13 }}>
                      (desmarque p/ self service / prato feito na hora)
                    </span>
                  </label>
                </div>
                )}

                {/* Custo em R$ ou em % do que for cobrado. O % existe pro prato sem
                    preço fixo (comida no peso): a atendente digita o valor na mesa,
                    então o custo só pode ser uma fatia desse valor. */}
                <div className="pf-secao"><span>Preços</span></div>
                <div className="form-field">
                  <label>Preço de custo</label>
                  <div className="pf-toggle">
                    {[['fixo', 'R$ por unidade'], ['pct', '% do valor vendido']].map(([id, lbl]) => (
                      <button key={id} type="button"
                        className={(form.custo_modo || 'fixo') === id ? 'ativo' : ''}
                        onClick={() => setForm(f => ({
                          ...f,
                          custo_modo: id,
                          // Trocar de modo zera o outro campo — senão o produto ficaria
                          // com custo em R$ E em %, e ninguém sabe qual vale.
                          preco_custo: id === 'pct' ? 0 : f.preco_custo,
                          custo_pct_venda: id === 'fixo' ? '' : (f.custo_pct_venda || ''),
                        }))}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {(form.custo_modo || 'fixo') === 'pct' ? (
                    <>
                      <input
                        type="number"
                        step="1"
                        min="0"
                        max="100"
                        name="custo_pct_venda"
                        value={form.custo_pct_venda}
                        onChange={handleChange}
                        placeholder="40"
                      />
                      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 0', lineHeight: 1.45 }}>
                        Pra comida no peso e prato sem preço fixo. Ex.: <strong>40</strong> = de cada
                        R$ 100 vendidos deste item, R$ 40 entram como custo no Lucro do dia.
                      </p>
                    </>
                  ) : (
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      name="preco_custo"
                      value={form.preco_custo}
                      onChange={handleChange}
                    />
                  )}
                </div>

                <div className="form-field">
                  <label>Preço Público (R$) <span style={{fontWeight:400, fontSize:'0.8em', color:'var(--text-muted)'}}>WhatsApp / link</span></label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="preco_venda"
                    value={form.preco_venda}
                    onChange={handleChange}
                  />
                </div>

                <div className="form-field">
                  <label style={{ color: '#22c55e' }}>
                    Preço promocional (R$){' '}
                    <span style={{ fontWeight: 400, fontSize: '0.8em', color: 'var(--text-muted)' }}>
                      opcional — risca o de cima
                    </span>
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="preco_promocional"
                    value={form.preco_promocional}
                    placeholder="sem promoção"
                    onChange={handleChange}
                  />
                  {Number(form.preco_promocional) > 0
                    && Number(form.preco_promocional) >= (Number(form.preco_venda) || 0) && (
                    <span style={{ fontSize: 11.5, color: '#f87171' }}>
                      Tem que ser MENOR que o preço público, senão não é promoção.
                    </span>
                  )}
                  {Number(form.preco_promocional) > 0
                    && Number(form.preco_promocional) < (Number(form.preco_venda) || 0) && (
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      O cliente vê <s>R$ {Number(form.preco_venda).toFixed(2)}</s>{' '}
                      <strong style={{ color: '#22c55e' }}>R$ {Number(form.preco_promocional).toFixed(2)}</strong>
                    </span>
                  )}
                </div>

                {MOSTRAR_PRECO_APP && (
                <div className="form-field">
                  <label>Preço App (R$) <span style={{fontWeight:400, fontSize:'0.8em', color:'var(--text-muted)'}}>FWC Inter app</span></label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="preco_app"
                    value={form.preco_app}
                    onChange={handleChange}
                  />
                </div>
                )}

                <div className="form-field full">
                  <label>
                    Preços por quantidade{' '}
                    <span style={{ fontWeight: 400, fontSize: '0.85em', color: 'var(--text-muted)' }}>
                      (opcional)
                    </span>
                  </label>

                  {form.faixas_preco.length > 0 && (
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
                      gap: '6px 8px',
                      marginBottom: 8,
                      alignItems: 'center',
                    }}>
                      <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Qtd mínima</span>
                      <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>Preço (R$)</span>
                      <span />
                      {form.faixas_preco.map((f, i) => (
                        <React.Fragment key={i}>
                          <input
                            type="number"
                            min="2"
                            value={f.qtd_min}
                            onChange={e => {
                              const arr = [...form.faixas_preco]
                              arr[i] = { ...arr[i], qtd_min: Number(e.target.value) }
                              setForm(prev => ({ ...prev, faixas_preco: arr }))
                            }}
                            placeholder="Ex: 10"
                          />
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={f.preco}
                            onChange={e => {
                              const arr = [...form.faixas_preco]
                              arr[i] = { ...arr[i], preco: Number(e.target.value) }
                              setForm(prev => ({ ...prev, faixas_preco: arr }))
                            }}
                            placeholder="Ex: 8.50"
                          />
                          <button
                            type="button"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--danger, #e55)',
                              cursor: 'pointer',
                              fontSize: '1.1em',
                              padding: '2px 6px',
                              lineHeight: 1,
                            }}
                            onClick={() => {
                              const arr = form.faixas_preco.filter((_, idx) => idx !== i)
                              setForm(prev => ({ ...prev, faixas_preco: arr }))
                            }}
                            title="Remover faixa"
                          >
                            ✕
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setForm(prev => ({
                      ...prev,
                      faixas_preco: [...prev.faixas_preco, { qtd_min: '', preco: '' }],
                    }))}
                  >
                    + Adicionar faixa de preço
                  </button>
                </div>

                {/* Quantidade em estoque direto aqui: cadastrou o item, já diz quantos
                    tem — sem precisar abrir a tela Estoque só pra isso. */}
                {usaEstoque && form.controla_estoque && <div className="pf-secao"><span>Estoque</span></div>}
                {usaEstoque && form.controla_estoque && (
                <div className="form-field">
                  <label>
                    {editingId ? 'Quantidade em estoque (contagem)' : 'Quantidade em estoque'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={estoqueQtd}
                    onChange={(e) => setEstoqueQtd(e.target.value)}
                    placeholder={editingId
                      ? (carregandoSaldo ? 'carregando saldo...' : `tem ${estoqueSaldo} hoje — deixe vazio pra não mexer`)
                      : 'ex.: 20 (deixe vazio se não quiser lançar agora)'}
                  />
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    {editingId
                      ? <>Digite <b>quanto tem na prateleira agora</b>. A gente lança só a diferença pro saldo atual ({carregandoSaldo ? '...' : estoqueSaldo}) como ajuste de inventário.</>
                      : <>Entra como <b>entrada de estoque</b> assim que salvar. Depois é só usar a tela Estoque pra novas compras.</>}
                  </p>
                  {estoqueQtd !== '' && Number(estoqueQtd) !== (editingId ? estoqueSaldo : 0) && Number.isFinite(Number(estoqueQtd)) && (
                    <p style={{ fontSize: 12.5, margin: '4px 0 0', fontWeight: 700,
                      color: Number(estoqueQtd) > (editingId ? estoqueSaldo : 0) ? '#16a34a' : '#e11d48' }}>
                      {Number(estoqueQtd) > (editingId ? estoqueSaldo : 0) ? '↑ entrada de ' : '↓ saída de '}
                      {Math.abs(Number(estoqueQtd) - (editingId ? estoqueSaldo : 0))}
                    </p>
                  )}
                </div>
                )}

                {/* Estoque mínimo só quando controla estoque */}
                {usaEstoque && form.controla_estoque && (
                <div className="form-field">
                  <label>Estoque mínimo</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="estoque_minimo"
                    value={form.estoque_minimo}
                    onChange={handleChange}
                  />
                </div>
                )}

                <div className="pf-secao"><span>Venda</span></div>
                <div className="form-field">
                  <label style={{ display: 'block', marginBottom: 6 }}>Disponibilidade</label>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, ativo: !f.ativo }))}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                      padding: '9px 16px', borderRadius: 10, fontWeight: 700, fontSize: 14,
                      border: `1.5px solid ${form.ativo ? '#16a34a' : '#eab308'}`,
                      background: form.ativo ? 'rgba(22,163,74,.12)' : 'rgba(234,179,8,.16)',
                      color: form.ativo ? '#16a34a' : '#a16207',
                    }}
                  >
                    {form.ativo ? '⏸ Pausar item' : '▶ Ativar item'}
                  </button>
                  <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                    {form.ativo
                      ? 'Item aparecendo pra vender. Pause quando faltar / ficar indisponível.'
                      : 'Item pausado — não aparece pra vender. Dê play pra voltar.'}
                    {' '}(Isto não é estoque — estoque é o "Controla estoque" acima.)
                  </p>
                </div>

                {/* Complementos: escolher categorias já criadas (as opções vivem na tela Complementos) */}
                <div className="form-field full" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span>
                      Complementos{' '}
                      <span style={{ fontWeight: 400, fontSize: '0.8em', color: 'var(--text-muted)' }}>
                        (escolha categorias já criadas — ex.: Proteínas, Saladas)
                      </span>
                    </span>
                  </label>

                  {vinculos.length === 0 && (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '6px 0 0' }}>
                      Nenhuma categoria neste produto. Use o seletor abaixo pra adicionar. As opções de
                      cada categoria são criadas/editadas no menu <b>Complementos</b>.
                    </p>
                  )}

                  {vinculos.map((v, i) => (
                    <div key={v.grupo_id} className="pf-vinculo" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px auto', gap: 8, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', marginTop: 8, background: 'var(--surface-hover)' }}>
                      <span style={{ fontWeight: 600 }}>{v.nome}</span>
                      <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        máx.:
                        <input type="number" min="1" style={{ width: 60 }}
                          value={v.max_override ?? ''}
                          placeholder={String(v.max_grupo)}
                          onChange={e => { const val = e.target.value; setVinculos(prev => prev.map((x, j) => j === i ? { ...x, max_override: val === '' ? null : (Number(val) || 1) } : x)) }} />
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <button type="button" className="btn btn-secondary btn-sm" title="Subir" disabled={i === 0}
                          onClick={() => moverVinculo(i, -1)}>↑</button>
                        <button type="button" className="btn btn-secondary btn-sm" title="Descer" disabled={i === vinculos.length - 1}
                          onClick={() => moverVinculo(i, 1)}>↓</button>
                        <button type="button" className="btn btn-danger btn-sm"
                          onClick={() => setVinculos(prev => prev.filter((_, j) => j !== i))}>
                          Tirar
                        </button>
                      </div>
                    </div>
                  ))}
                  {vinculos.length > 1 && (
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                      Use <b>↑ ↓</b> pra mudar a ordem que os grupos aparecem pro cliente (ex.: sabores em cima, bordas embaixo). Salve pra valer.
                    </p>
                  )}

                  {catsEmpresa.filter(c => !vinculos.some(v => v.grupo_id === c.id)).length > 0 && (
                    <select value="" style={{ marginTop: 10, maxWidth: 340 }}
                      onChange={e => {
                        const gid = e.target.value; if (!gid) return
                        const c = catsEmpresa.find(x => x.id === gid)
                        setVinculos(prev => [...prev, { linkId: null, grupo_id: gid, nome: c?.nome ?? '', max_grupo: c?.max ?? 1, max_override: null }])
                        e.target.value = ''
                      }}>
                      <option value="">+ Adicionar categoria…</option>
                      {catsEmpresa.filter(c => !vinculos.some(v => v.grupo_id === c.id)).map(c => (
                        <option key={c.id} value={c.id}>{c.nome}</option>
                      ))}
                    </select>
                  )}
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                    Pra criar uma categoria nova ou editar/pausar as opções, vá no menu <b>Complementos</b>.
                    O “máx.” aqui é só deste produto (ex.: Proteínas 1 na P e 2 na M/G).
                  </p>
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="modal-actions pf-acoes">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={fecharModal}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Categoria com produtos dentro: escolher o destino antes de excluir */}
      {catExcluir && (
        <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !excluindoCat) setCatExcluir(null) }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Excluir a categoria “{catExcluir.nome}”</h2>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Ela tem <strong>{catExcluir.qtd} produto(s)</strong> dentro. Pra onde eles vão?
            </p>

            <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Mover os produtos para</label>
            <select
              value={catExcluir.destino}
              onChange={e => setCatExcluir(c => ({ ...c, destino: e.target.value }))}
              style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px solid var(--border)',
                       background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14 }}
            >
              <option value=''>Escolha uma categoria…</option>
              {categorias.filter(c => c.nome !== catExcluir.nome).map(c => (
                <option key={c.id} value={c.nome}>{c.nome}</option>
              ))}
            </select>

            {categError && (
              <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10, marginBottom: 0 }}>{categError}</p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" disabled={excluindoCat} onClick={() => { setCategError(null); setCatExcluir(null) }}>
                Cancelar
              </button>
              <button className="btn btn-danger" disabled={excluindoCat} onClick={() => confirmarExclusaoCategoria(true)}
                title="Apaga a categoria e os produtos dela">
                🗑 Excluir tudo
              </button>
              <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={excluindoCat}
                onClick={() => confirmarExclusaoCategoria(false)}>
                {excluindoCat ? 'Movendo…' : 'Mover e excluir a categoria'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCategModal && (
        <div className="modal-overlay" onClick={() => setShowCategModal(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>Categorias</h2>

            <form onSubmit={handleSaveCategoria} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                placeholder="Nome da nova categoria"
                value={novaCategoria}
                onChange={(e) => setNovaCategoria(e.target.value)}
                style={{ flex: 1 }}
                required
              />
              <button type="submit" className="btn btn-primary" disabled={savingCateg}>
                {savingCateg ? 'Salvando...' : 'Adicionar'}
              </button>
            </form>

            {categError && <p className="error-text">{categError}</p>}

            <div className="cat-ajuda">
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              🕒 Defina o horário que cada categoria fica disponível para venda. Deixe <strong>em branco</strong> = sempre disponível.
              Ex.: Quentinhas <strong>10:00 às 14:00</strong>, Janta <strong>17:00 às 22:00</strong>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              🖨️ <strong>Onde imprime</strong> — <strong>🍳 Cozinha</strong>: sai na térmica da cozinha (o que é preparado
              lá dentro: quentinhas, espetinhos, porções). <strong>🧾 Salão</strong>: sai na impressora da frente, junto
              com a conta. <strong>🚫 Não imprime</strong>: não sai papel nenhum — pro que o próprio garçom pega e dá baixa
              no celular (bebida na geladeira, por exemplo). O item entra na conta do mesmo jeito.
              Quem tem <strong>uma impressora só</strong> pode deixar tudo no Salão: ela imprime tudo, menos o que estiver
              como Não imprime.
            </p>

            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              💸 <strong>Sem taxa</strong> — marque as categorias que <strong>não entram na taxa de serviço</strong> da mesa
              (couvert artístico, ingresso, reserva). O item continua na conta e no faturamento normalmente; só fica de fora
              do cálculo da taxa — e sai na comanda com <strong>(isento de taxa)</strong> do lado, pro cliente ver.
            </p>
            </div>

            <div className="data-table tabela-categorias">
              {categorias.length === 0 ? (
                <div className="empty-state">Nenhuma categoria cadastrada.</div>
              ) : (
                <table>
                  <tbody>
                    {categorias.map((c, i) => (
                      <tr
                        key={c.id}
                        draggable
                        onDragStart={() => setDragIdx(i)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => onSoltarCategoria(i)}
                        onDragEnd={() => setDragIdx(null)}
                        style={{
                          cursor: 'grab',
                          background: dragIdx === i ? 'var(--primary-bg)' : undefined,
                          borderTop: dragIdx != null && dragIdx !== i ? '2px dashed transparent' : undefined,
                        }}
                      >
                        <td style={{ width: 24, textAlign: 'center', color: 'var(--text-muted)', cursor: 'grab', userSelect: 'none' }} title="Arraste para reordenar">
                          ⠿
                        </td>
                        <td style={{ width: 74 }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            title="Subir"
                            disabled={i === 0}
                            onClick={() => moverCategoria(i, -1)}
                            style={{ padding: '2px 7px' }}
                          >
                            ↑
                          </button>{' '}
                          <button
                            className="btn btn-secondary btn-sm"
                            title="Descer"
                            disabled={i === categorias.length - 1}
                            onClick={() => moverCategoria(i, 1)}
                            style={{ padding: '2px 7px' }}
                          >
                            ↓
                          </button>
                        </td>
                        <td onDragStart={(e) => e.preventDefault()}>
                          {editandoCatId === c.id ? (
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <input
                                autoFocus
                                value={editandoCatNome}
                                onChange={(e) => setEditandoCatNome(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') salvarRenomear(c); else if (e.key === 'Escape') cancelarRenomear() }}
                                draggable={false}
                                style={{ flex: 1, minWidth: 120, padding: '5px 8px', borderRadius: 6, border: '1.5px solid var(--primary)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }}
                              />
                              <button className="btn btn-primary btn-sm" disabled={salvandoRenome} onClick={() => salvarRenomear(c)} style={{ padding: '4px 9px' }}>
                                {salvandoRenome ? '...' : 'Salvar'}
                              </button>
                              <button className="btn btn-secondary btn-sm" disabled={salvandoRenome} onClick={cancelarRenomear} style={{ padding: '4px 9px' }}>
                                Cancelar
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => iniciarRenomear(c)}
                              title="Renomear categoria"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', font: 'inherit', padding: 0, textAlign: 'left' }}
                            >
                              {c.nome}
                              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>✎</span>
                            </button>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }} onDragStart={(e) => e.preventDefault()}>
                          <select
                            value={['cozinha', 'nenhum'].includes(c.setor) ? c.setor : 'salao'}
                            onChange={(e) => salvarSetorCategoria(c.id, e.target.value)}
                            title="Em que impressora sai o pedido desta categoria"
                            className="cat-setor"
                          >
                            <option value="salao">🧾 Salão</option>
                            <option value="cozinha">🍳 Cozinha</option>
                            <option value="nenhum">🚫 Não imprime</option>
                          </select>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }} onDragStart={(e) => e.preventDefault()}>
                          <label
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 12.5 }}
                            title="Marcado: os itens desta categoria NÃO entram na conta da taxa de serviço (couvert, ingresso)"
                          >
                            <input
                              type="checkbox"
                              checked={!!c.isento_taxa}
                              onChange={(e) => salvarIsentoTaxa(c.id, e.target.checked)}
                              draggable={false}
                            />
                            <span style={{ color: c.isento_taxa ? 'var(--text)' : 'var(--text-muted)' }}>
                              Sem taxa
                            </span>
                          </label>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }} onDragStart={(e) => e.preventDefault()}>
                          <input
                            type="time"
                            value={(c.hora_inicio || '').slice(0, 5)}
                            onChange={(e) => salvarHorarioCategoria(c.id, 'hora_inicio', e.target.value)}
                            title="Disponível a partir de"
                            className="cat-hora"
                          />
                          <span style={{ margin: '0 5px', color: 'var(--text-muted)' }}>às</span>
                          <input
                            type="time"
                            value={(c.hora_fim || '').slice(0, 5)}
                            onChange={(e) => salvarHorarioCategoria(c.id, 'hora_fim', e.target.value)}
                            title="Disponível até"
                            className="cat-hora"
                          />
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleDuplicarCategoria(c)}
                            disabled={duplicandoCatId === c.id}
                            title="Criar uma cópia desta categoria com todos os produtos"
                          >
                            {duplicandoCatId === c.id ? '...' : '⧉ Duplicar'}
                          </button>{' '}
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDeleteCategoria(c.id, c.nome)}
                          >
                            Excluir
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowCategModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {showEmbalagensModal && (
        <div className="modal-overlay" onClick={() => setShowEmbalagensModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Embalagens</h2>

            <form onSubmit={handleAddEmbalagem} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                placeholder="Nome da nova embalagem"
                value={novaEmbalagem}
                onChange={(e) => setNovaEmbalagem(e.target.value)}
                style={{ flex: 1 }}
                required
              />
              <button type="submit" className="btn btn-primary" disabled={savingEmb}>
                {savingEmb ? 'Salvando...' : 'Adicionar'}
              </button>
            </form>

            {embError && <p className="error-text">{embError}</p>}

            <div className="data-table">
              {embalagens.length === 0 ? (
                <div className="empty-state">Nenhuma embalagem cadastrada.</div>
              ) : (
                <table>
                  <tbody>
                    {embalagens.map((e) => (
                      <tr key={e.id}>
                        <td>{e.nome}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDeleteEmbalagem(e.id, e.nome)}
                          >
                            Excluir
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowEmbalagensModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
