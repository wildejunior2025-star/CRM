import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { iniciarTags, adicionarAoCarrinho, verProduto } from '../lib/tracking'
import AvisoCookies from '../components/AvisoCookies'
import { adicionalComplementos, blocosDeOpcoes, cobraPeloMaior, rotuloPrecoOpcao } from '../lib/complementos'
import { semAcento } from '../lib/texto'
import { precoPorQuantidade, faixaAplicada, menorFaixa, precoRiscado } from '../lib/precoQuantidade'
import { criarBuscadorDescricao, comDescricaoNasOpcoes } from '../lib/descricaoSabor'
import { abertaAgora, comoFicaNoDia, carregarExcecoes, hojeBR } from '../lib/feriados'
import { capturarIndicacao } from '../lib/indicacao'
import './DeliveryLoja.css'

// A regra de "a loja está aberta agora?" mora em src/lib/feriados.js — grade da
// semana + feriado + folga marcada, a MESMA conta que o gestor e o Despesas & Lucro.

function IconArrowLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

function IconPlus({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function IconMinus({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  )
}

function IconCart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  )
}

function IconImage() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function IconX() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function fmt(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Leitura que NAO pode sair pela metade. O cardapio e montado com varias
// consultas; se a dos complementos falhar e a tela seguir assim mesmo, TODO
// produto vira "produto sem complemento": o cliente poe a quentinha na sacola
// sem escolher feijao nem proteina, paga o preco base e a cozinha recebe um
// pedido em branco. Entao aqui e tudo ou nada — tenta de novo e, se nao vier,
// quem chama derruba a tela com aviso em vez de servir cardapio quebrado.
async function lerOuFalhar(fn, tentativas = 3) {
  let ultimoErro = null
  for (let i = 0; i < tentativas; i++) {
    const { data, error } = await fn()
    if (!error) return data ?? []
    ultimoErro = error
    await new Promise(r => setTimeout(r, 400 * (i + 1)))
  }
  throw ultimoErro ?? new Error('falha ao carregar o cardapio')
}

export default function DeliveryLoja() {
  const { id, slug } = useParams()
  const navigate = useNavigate()

  const [loja, setLoja] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [excecoes, setExcecoes] = useState({})  // feriados/folgas da loja (mig 0142)
  const [catOrdem, setCatOrdem] = useState({}) // { nomeCategoria: ordem }
  const [catHorario, setCatHorario] = useState({}) // { nomeCategoria: { inicio, fim } }
  const [loading, setLoading] = useState(true)
  const [catAtiva, setCatAtiva] = useState(null)
  const catRefs = useRef({})
  const navRef = useRef(null)
  const [carrinho, setCarrinho] = useState({})
  // Carrinho é chaveado pelo id REAL da loja (uuid) — bate com a limpeza do checkout.
  const cartKey = loja?.id ? `sacola_${loja.id}` : null
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [optProduto, setOptProduto] = useState(null) // produto aberto no modal de complementos
  // Cardapio que nao carregou inteiro NAO vira loja aberta pela metade (ver lerOuFalhar)
  const [erroCardapio, setErroCardapio] = useState(false)
  const [tentativa, setTentativa] = useState(0)
  const drawerRef = useRef(null)
  const [filtroEstoqueBaixo, setFiltroEstoqueBaixo] = useState(false)
  const [busca, setBusca] = useState('')
  // Tema do cardápio (claro/escuro) — escolha do cliente, lembrada no navegador.
  // Claro é o padrão; quem quiser escuro clica na 🌙.
  const [tema, setTema] = useState(() => {
    try { return localStorage.getItem('dloja-tema') || 'claro' } catch { return 'claro' }
  })
  useEffect(() => { try { localStorage.setItem('dloja-tema', tema) } catch { /* ignora */ } }, [tema])

  // Chegou por `?ind=`? Guarda quem indicou (mig 0176). Roda na abertura porque
  // o cliente quase nunca compra na mesma visita: ele olha o cardápio, sai, e
  // volta depois direto — sem o parâmetro na URL.
  useEffect(() => { capturarIndicacao() }, [])

  // Sincroniza carrinho com localStorage (chave = id real da loja)
  useEffect(() => {
    if (!cartKey) return
    try {
      if (Object.keys(carrinho).length === 0) {
        localStorage.removeItem(cartKey)
      } else {
        localStorage.setItem(cartKey, JSON.stringify(carrinho))
      }
    } catch { /* localStorage indisponível */ }
  }, [carrinho, cartKey])

  // ── Rascunho da montagem ("monte sua quentinha" pela metade) ──────────────
  // A sacola já sobrevive a um recarregamento (fica no localStorage), mas o
  // produto que estava sendo MONTADO não: as escolhas moram só no modal. Quem
  // estava na metade da quentinha perdia tudo e recomeçava do zero.
  //
  // Aqui a montagem em andamento também fica guardada, e ao voltar o modal
  // reabre no mesmo produto com o que já tinha sido marcado.
  const draftKey = loja?.id ? `montagem_${loja.id}` : null
  const [rascunho, setRascunho] = useState(null)
  const rascunhoLido = useRef(false)

  const limparRascunho = useCallback(() => {
    setRascunho(null)
    try { if (draftKey) localStorage.removeItem(draftKey) } catch { /* ignora */ }
  }, [draftKey])

  useEffect(() => {
    if (rascunhoLido.current || !draftKey || produtos.length === 0) return
    rascunhoLido.current = true
    let salvo = null
    try { salvo = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { salvo = null }
    if (!salvo?.produtoId) return
    // Rascunho velho é lixo: quem volta horas depois quer começar limpo.
    if (Date.now() - (salvo.ts ?? 0) > 30 * 60 * 1000) {
      try { localStorage.removeItem(draftKey) } catch { /* ignora */ }
      return
    }
    const prod = produtos.find(p => String(p.id) === String(salvo.produtoId))
    if (!prod?.complementos?.length) return
    setRascunho({ produtoId: prod.id, sel: salvo.sel ?? {} })
    setOptProduto(prod)
  }, [produtos, draftKey])

  // ── Não recarregue por cima do pedido do cliente ──────────────────────────
  // O app se atualiza sozinho (main.jsx) e atualizar RECARREGA a página. No
  // gestor isso é um piscar; aqui é o cliente perdendo a sacola no meio da
  // escolha — e cliente que perde o pedido não refaz, desiste.
  //
  // Enquanto tem item na sacola ou o "monte seu produto" está aberto, a tela se
  // declara ocupada e a versão nova espera (entra sozinha depois, quando a
  // pessoa fechar tudo ou sair).
  useEffect(() => {
    window.__fwcOcupado = Object.keys(carrinho).length > 0 || optProduto != null || drawerOpen
    return () => { window.__fwcOcupado = false }
  }, [carrinho, optProduto, drawerOpen])

  // Após produtos carregarem, filtra itens do carrinho restaurado:
  // remove produtos que não existem mais e atualiza preços
  useEffect(() => {
    if (produtos.length === 0) return
    setCarrinho(prev => {
      const atualizado = {}
      for (const [key, item] of Object.entries(prev)) {
        const produtoAtual = produtos.find(p => String(p.id) === String(item.id ?? key))
        if (!produtoAtual) continue
        // Item obrigatório que entrou na sacola SEM escolha nenhuma não existe
        // de verdade — é sobra de um carregamento em que os complementos não
        // vieram. Deixar passar manda pra cozinha uma quentinha sem feijão nem
        // proteína, e ainda pelo preço base. Some da sacola.
        const exigeEscolha = (produtoAtual.complementos ?? []).some(g => Number(g.min ?? 0) > 0)
        if (exigeEscolha && !item.complementos?.length) continue
        // Combos (com complementos) mantêm o preço já calculado (base + adicionais)
        atualizado[key] = item.complementos?.length
          ? { key, ...item }
          : { key, ...item, id: produtoAtual.id, preco: Number(produtoAtual.preco) }
      }
      return atualizado
    })
  }, [produtos])

  useEffect(() => {
    async function load() {
      setErroCardapio(false)
      // Resolve a loja por slug (lojaonline.fwcinter.com/slug) ou por id (link antigo /loja/:id)
      let lojaQuery = supabase.from('empresas').select('*').eq('aceita_delivery', true)
      lojaQuery = slug ? lojaQuery.eq('slug', slug) : lojaQuery.eq('id', id)
      const { data: lojaData } = await lojaQuery.maybeSingle()

      if (!lojaData) { setLoja(null); setLoading(false); return }

      const produtosData = await lerOuFalhar(() => supabase.from('produtos')
        .select('id, nome, descricao, preco:preco_venda, preco_promocional, faixas_preco, foto_url, categoria, ordem, disponivel_delivery, estoque_minimo')
        .eq('empresa_id', lojaData.id)
        .eq('ativo', true)
        .eq('disponivel_delivery', true)
        .order('categoria')
        // Ordem manual do dono dentro da categoria (mig 0201). nullsFirst:false
        // deixa quem nunca foi ordenado no fim, em ordem alfabetica.
        .order('ordem', { nullsFirst: false })
        .order('nome'))

      // Complementos (ex.: "monte sua quentinha") — grupos + opções por produto
      let produtosFinal = produtosData ?? []
      const ids = produtosFinal.map(p => p.id)
      if (ids.length) {
        // Sabor de pizza também é produto: puxa a descrição dele pra mostrar no que vai na pizza.
        // Pega TODOS os ativos (tem sabor que só existe dentro da pizza, sem aparecer no cardápio).
        const { data: descData } = await supabase.from('produtos')
          .select('nome, categoria, descricao')
          .eq('empresa_id', lojaData.id)
          .eq('ativo', true)
        const descricaoDaOpcao = criarBuscadorDescricao(descData)
        // Lê pela ponte produto↔grupo: uma mesma categoria pode estar em vários produtos.
        const vinc = await lerOuFalhar(() => supabase
          .from('produto_complemento_grupos')
          .select('produto_id, ordem, min_override, max_override, complemento_grupos(id, nome, min, max, disponivel, regra_preco, modo_quantidade, complemento_opcoes(id, nome, descricao, preco_adicional, ordem, disponivel))')
          .in('produto_id', ids))
        // Opção "opt-out" (Sem X / Não Quero): serve pra recusar a categoria.
        const soSemOpcao = nome => /^\s*sem\s|n[ãa]o\s*quero/i.test(String(nome || ''))
        const porProduto = {}
        for (const v of (vinc ?? [])) {
          const g = v.complemento_grupos
          if (!g || g.disponivel === false) continue // grupo pausado some da loja
          const opcoes = comDescricaoNasOpcoes(
            (g.complemento_opcoes ?? [])
              .filter(o => o.disponivel !== false)
              .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)),
            descricaoDaOpcao,
          )
          // Categoria que sobrou só com "Sem/Não Quero" (nenhuma opção real) não aparece.
          if (!opcoes.some(o => !soSemOpcao(o.nome))) continue
          ;(porProduto[v.produto_id] ??= []).push({
            id: g.id, nome: g.nome, min: v.min_override ?? g.min ?? 0, max: v.max_override ?? g.max ?? 1,
            regra_preco: g.regra_preco ?? 'somar', ordem: v.ordem ?? 0, opcoes,
            // Atacado (mig 0200): cliente diz QUANTO de cada opcao. O max_override
            // nao vale aqui — o sentido do modo e justamente nao ter teto.
            modo_quantidade: g.modo_quantidade === true,
          })
        }
        produtosFinal = produtosFinal.map(p => ({
          ...p,
          complementos: (porProduto[p.id] ?? []).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0)),
        }))
      }

      // Ordem personalizada + horário de disponibilidade das categorias
      const { data: catData } = await supabase
        .from('categorias')
        .select('nome, ordem, hora_inicio, hora_fim')
        .eq('empresa_id', lojaData.id)
      const ordemMap = {}
      const horarioMap = {}
      for (const c of (catData ?? [])) {
        ordemMap[c.nome] = c.ordem ?? 999
        if (c.hora_inicio && c.hora_fim) horarioMap[c.nome] = { inicio: c.hora_inicio, fim: c.hora_fim }
      }

      // Restaura carrinho salvo desta loja (chave = id real)
      let savedCart = {}
      try { savedCart = JSON.parse(localStorage.getItem(`sacola_${lojaData.id}`) || '{}') } catch { savedCart = {} }

      // Tags de anúncio da loja (Google Ads / Pixel da Meta). Loja sem ID
      // configurado não carrega script de terceiro nenhum.
      iniciarTags(lojaData)

      // Feriados/folgas da loja (mig 0142): sem isso a loja aparece aberta num
      // feriado em que ninguém vai atender e o cliente monta a sacola à toa.
      setExcecoes(await carregarExcecoes(supabase, lojaData.id))

      setLoja(lojaData)
      setProdutos(produtosFinal)
      setCatOrdem(ordemMap)
      setCatHorario(horarioMap)
      setCarrinho(savedCart)
      setLoading(false)
    }
    load().catch(() => {
      // Cardapio incompleto e pior que cardapio nenhum: melhor pedir pra
      // tentar de novo do que deixar montar uma sacola errada.
      setErroCardapio(true)
      setLoading(false)
    })
  }, [id, slug, tentativa])

  useEffect(() => {
    if (!drawerOpen) return
    function onKey(e) {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // Produto simples (sem complementos) — chave = id do produto
  function addOne(prod) {
    const key = String(prod.id)
    adicionarAoCarrinho(prod, prod.preco)
    setCarrinho(prev => {
      const qtd = (prev[key]?.quantidade ?? 0) + 1
      return {
        ...prev,
        [key]: {
          key, id: prod.id, nome: prod.nome, foto_url: prod.foto_url, quantidade: qtd,
          // Guarda base e faixas pra o +/- do carrinho poder recalcular: passar
          // de 9 pra 10 tem que trocar o preco sozinho, senão o "a partir de 10"
          // vira promessa que a loja não cumpre.
          precoBase: Number(prod.preco), faixas_preco: prod.faixas_preco ?? [],
          preco_promocional: prod.preco_promocional ?? null,
          preco: precoPorQuantidade(prod.preco, prod.faixas_preco, qtd, prod.preco_promocional),
        },
      }
    })
  }

  // Abrir a tela de complementos conta como "viu o produto" no funil da Meta
  function abrirProduto(prod) {
    verProduto(prod)
    setOptProduto(prod)
  }

  // Produto com complementos — chave = id + opções escolhidas (combos distintos = linhas distintas)
  function addCombo(prod, selecoes, precoUnit, qtdItem = 1) {
    // A chave leva a QUANTIDADE junto: sem isso "500 uva" e "100 uva" cairiam na
    // mesma linha do carrinho e uma apagaria a outra.
    const key = selecoes.length
      ? `${prod.id}::${selecoes.map(s => `${s.opcaoId}x${s.qtd ?? 1}`).sort().join('-')}`
      : String(prod.id)
    adicionarAoCarrinho(prod, precoUnit)
    setCarrinho(prev => ({
      ...prev,
      [key]: {
        key, id: prod.id, nome: prod.nome, preco: precoUnit, foto_url: prod.foto_url,
        complementos: selecoes.map(s => ({
          grupo: s.grupo, nome: s.nome, preco: s.preco, qtd: s.qtd ?? 1, absoluto: !!s.absoluto,
        })),
        // Combo já sai com o preço fechado da montagem (o unitário veio da faixa
        // certa lá dentro), então o +/- do carrinho repete a montagem inteira.
        quantidade: (prev[key]?.quantidade ?? 0) + (Number(qtdItem) || 1),
      },
    }))
    setOptProduto(null)
  }

  // Item montado no atacado (o cliente disse 500 de um sabor e 100 de outro) não
  // aceita +/- solto: viraria 601 unidades com 600 distribuídas nos sabores, e a
  // comanda sairia mentindo. Pra mudar, ele remove e monta de novo.
  function qtdTravada(item) {
    return (item?.complementos ?? []).some(c => c?.absoluto)
  }

  // Repassa a quantidade nova pelo preço de atacado: sair de 9 pra 10 tem que
  // baixar o valor sozinho.
  function comPrecoDaFaixa(item, qtd) {
    if (item.precoBase == null) return { ...item, quantidade: qtd }
    return {
      ...item, quantidade: qtd,
      preco: precoPorQuantidade(item.precoBase, item.faixas_preco, qtd, item.preco_promocional),
    }
  }

  function incKey(key) {
    setCarrinho(prev => {
      const item = prev[key]
      if (!item || qtdTravada(item)) return prev
      return { ...prev, [key]: comPrecoDaFaixa(item, item.quantidade + 1) }
    })
  }

  function removeOne(key) {
    setCarrinho(prev => {
      const item = prev[key]
      if (!item) return prev
      const next = { ...prev }
      if (qtdTravada(item)) { delete next[key]; return next }   // só sai inteiro
      if (item.quantidade <= 1) delete next[key]
      else next[key] = comPrecoDaFaixa(item, item.quantidade - 1)
      return next
    })
  }

  function removeItem(key) {
    setCarrinho(prev => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  // Quantidade total de um produto somando todos os combos dele
  function qtdProduto(prodId) {
    return Object.values(carrinho)
      .filter(i => String(i.id) === String(prodId))
      .reduce((s, i) => s + i.quantidade, 0)
  }

  const itens = Object.values(carrinho)
  const totalItens = itens.reduce((s, i) => s + i.quantidade, 0)
  const subtotal = itens.reduce((s, i) => s + i.quantidade * Number(i.preco), 0)
  const taxaEntrega = loja ? Number(loja.taxa_entrega ?? 0) : 0
  // Loja que cobra por bairro ou por km só sabe a taxa depois do endereço (isso
  // é feito no checkout). Aqui no carrinho a taxa fixa dessas lojas é 0 — e
  // mostrar "Grátis" fazia o cliente achar que a entrega não custava nada.
  const taxaPorEndereco =
    (Array.isArray(loja?.taxas_entrega_km) && loja.taxas_entrega_km.length > 0) ||
    (Array.isArray(loja?.taxas_entrega_bairro) && loja.taxas_entrega_bairro.length > 0)
  const taxaIndefinida = taxaPorEndereco && taxaEntrega === 0
  const total = subtotal + taxaEntrega

  const produtosFiltrados = filtroEstoqueBaixo
    ? produtos.filter(p => p.estoque != null && p.estoque_minimo != null && p.estoque <= p.estoque_minimo)
    : produtos

  // Categoria dentro do horário de venda? (sem horário = sempre). Usa horário de Brasília
  // (America/Fortaleza) pra não depender do fuso do aparelho do cliente. Trata janela
  // que vira a noite (fim < inicio, ex.: 22:00-02:00).
  const catDisponivelAgora = (nome) => {
    const h = catHorario[nome]
    if (!h) return true
    const agora = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' })
    const toMin = (t) => { const [hh, mm] = String(t).slice(0, 5).split(':').map(Number); return hh * 60 + mm }
    const n = toMin(agora), a = toMin(h.inicio), b = toMin(h.fim)
    return a <= b ? (n >= a && n < b) : (n >= a || n < b)
  }

  const categorias = [...new Set(produtosFiltrados.map(p => p.categoria).filter(Boolean))]
    .filter(cat => catDisponivelAgora(cat))
    .sort((a, b) => {
      const oa = catOrdem[a] ?? 999
      const ob = catOrdem[b] ?? 999
      if (oa !== ob) return oa - ob
      return a.localeCompare(b)
    })
  const semCategoria = produtosFiltrados.filter(p => !p.categoria)
  const todasCats = semCategoria.length > 0 ? [...categorias, '__sem__'] : categorias

  // Busca por nome do produto (filtra tudo, ignorando a divisão por categoria).
  // Sem acento dos dois lados: ninguém digita "Camarão" no celular, digita
  // "camarao" — e antes disso não achava nada e o cliente ia embora.
  const buscaTrim = semAcento(busca)
  const resultadosBusca = buscaTrim
    ? produtosFiltrados.filter(p =>
        (!p.categoria || catDisponivelAgora(p.categoria)) &&
        (semAcento(p.nome).includes(buscaTrim) ||
         semAcento(p.descricao).includes(buscaTrim)))
    : null

  // Loja aberta = pausa manual ligada (delivery_ativo) E dentro da grade semanal de horário.
  const lojaAberta = !!loja?.delivery_ativo && abertaAgora({
    grade: loja?.horarios_funcionamento, excecoes, fechaFeriado: !!loja?.feriados_fecha,
  })
  // Por que fechou (feriado, folga) — vira o texto do aviso pro cliente.
  const motivoFechada = comoFicaNoDia(hojeBR(), {
    grade: loja?.horarios_funcionamento, excecoes, fechaFeriado: !!loja?.feriados_fecha,
  }).motivo

  // Define categoria ativa inicial
  useEffect(() => {
    if (todasCats.length > 0 && !catAtiva) setCatAtiva(todasCats[0])
  }, [todasCats.join(',')])

  // Reset categoria ativa quando filtro muda
  useEffect(() => {
    if (todasCats.length > 0) setCatAtiva(todasCats[0])
  }, [filtroEstoqueBaixo])

  // IntersectionObserver: atualiza categoria ativa ao scrollar
  useEffect(() => {
    if (todasCats.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) setCatAtiva(entry.target.dataset.cat)
        })
      },
      { rootMargin: '-100px 0px -55% 0px', threshold: 0 }
    )
    todasCats.forEach(cat => {
      const el = catRefs.current[cat]
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [todasCats.join(',')])

  function scrollToCategoria(cat) {
    const el = catRefs.current[cat]
    if (el) {
      const offset = 130
      const top = el.getBoundingClientRect().top + window.scrollY - offset
      window.scrollTo({ top, behavior: 'smooth' })
    }
    setCatAtiva(cat)
    // Scroll do nav para manter botão ativo visível
    if (navRef.current) {
      const btn = navRef.current.querySelector(`[data-nav="${cat}"]`)
      btn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }

  function handleFinalizar() {
    setDrawerOpen(false)
    navigate('/checkout', {
      state: {
        empresaId: loja.id,
        empresaNome: loja.nome,
        itens: itens.map(i => ({
          id: i.id,
          key: i.key,
          nome: i.nome,
          quantidade: i.quantidade,
          preco: Number(i.preco),
          complementos: i.complementos ?? [],
        })),
        subtotal,
        taxaEntrega,
      },
    })
  }

  if (loading) {
    return (
      <div className="dloja-loading">
        <div className="dloja-spinner" />
        <p>Carregando cardápio...</p>
      </div>
    )
  }

  if (erroCardapio) {
    return (
      <div className="dloja-loading">
        <p style={{ color: '#94a3b8', textAlign: 'center', maxWidth: 320 }}>
          Não deu pra carregar o cardápio inteiro. Confira a internet e tente de novo.
        </p>
        <button className="dloja-back-btn" onClick={() => { setLoading(true); setTentativa(t => t + 1) }}>
          Tentar de novo
        </button>
      </div>
    )
  }

  if (!loja) {
    return (
      <div className="dloja-loading">
        <p style={{ color: '#94a3b8' }}>Loja não encontrada.</p>
        <button className="dloja-back-btn" onClick={() => navigate('/lojas')}>
          <IconArrowLeft /> Voltar
        </button>
      </div>
    )
  }

  return (
    <div className="dloja-root" data-tema={tema}>
      <header className="dloja-header">
        {/* Banner da loja — sem imagem de capa vira uma barra simples (--vazio),
            e o logo/nome descem pra baixo dela em vez de sobrepor. */}
        <div
          className={`dloja-banner${loja.banner_url ? '' : ' dloja-banner--vazio'}`}
          style={loja.banner_url ? { backgroundImage: `url(${loja.banner_url})` } : undefined}
        >
          <button className="dloja-banner-btn dloja-banner-back" onClick={() => navigate(-1)} aria-label="Voltar">
            <IconArrowLeft />
          </button>
          {/* Alterna claro/escuro. Fica ao lado do carrinho (desloca com .com-cart). */}
          <button
            className={`dloja-banner-btn dloja-banner-tema${totalItens > 0 ? ' com-cart' : ''}`}
            onClick={() => setTema(t => (t === 'escuro' ? 'claro' : 'escuro'))}
            aria-label="Alternar tema claro ou escuro"
            title={tema === 'escuro' ? 'Mudar para claro' : 'Mudar para escuro'}
          >
            {tema === 'escuro' ? '☀️' : '🌙'}
          </button>
          {totalItens > 0 && (
            <button className="dloja-banner-btn dloja-banner-cart" onClick={() => setDrawerOpen(true)} aria-label="Abrir carrinho">
              <IconCart />
              <span className="dloja-cart-count">{totalItens}</span>
            </button>
          )}
        </div>

        {/* Logo + nome da loja */}
        <div className="dloja-store-head">
          <div className="dloja-store-logo">
            {loja.logo_url
              ? <img src={loja.logo_url} alt={loja.nome} />
              : <span>{(loja.nome ?? 'F').trim().charAt(0).toUpperCase()}</span>}
          </div>
          <div className="dloja-store-info">
            <span className="dloja-store-nome">{loja.nome}</span>
            <span className={`dloja-status-badge ${lojaAberta ? 'dloja-status--open' : 'dloja-status--closed'}`}>
              {lojaAberta ? 'Aberto' : 'Fechado'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/meus-pedidos?loja=${loja.id}`)}
            className="dloja-orders-btn"
            style={{
              marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6,
              borderRadius: 10, padding: '8px 12px', cursor: 'pointer',
              fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
            }}
          >
            🧾 Meus pedidos
          </button>
        </div>
      </header>

      {/* ── Busca flutuante (fixa no topo ao rolar) ── */}
      <div className="dloja-searchbar" style={{
        position: 'sticky', top: 0, zIndex: 30,
        padding: '10px 12px', borderBottom: '1px solid var(--dl-border)',
      }}>
        <div style={{ position: 'relative', maxWidth: 720, margin: '0 auto' }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--dl-text-muted)', pointerEvents: 'none' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </span>
          <input
            type="search"
            value={busca}
            onChange={e => setBusca(e.target.value)}
            placeholder="Buscar produto..."
            className="dloja-search-input"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '11px 38px', borderRadius: 12,
              color: 'var(--dl-text)', fontSize: 15, outline: 'none',
            }}
          />
          {busca && (
            <button type="button" onClick={() => setBusca('')} aria-label="Limpar busca"
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--dl-text-muted)', cursor: 'pointer', padding: 4, display: 'flex' }}>
              <IconX />
            </button>
          )}
        </div>
      </div>

      {/* ── Barra de categorias (some durante a busca) ── */}
      {!buscaTrim && (
      <nav className="dloja-cat-nav" ref={navRef} aria-label="Categorias">
        <div className="dloja-cat-nav-inner">
          {categorias.map(cat => (
            <button
              key={cat}
              data-nav={cat}
              className={`dloja-cat-nav-btn${catAtiva === cat ? ' ativo' : ''}`}
              onClick={() => scrollToCategoria(cat)}
            >
              {cat}
            </button>
          ))}
          {semCategoria.length > 0 && (
            <button
              data-nav="__sem__"
              className={`dloja-cat-nav-btn${catAtiva === '__sem__' ? ' ativo' : ''}`}
              onClick={() => scrollToCategoria('__sem__')}
            >
              Outros
            </button>
          )}
        </div>
      </nav>
      )}

      {!lojaAberta && (
        <div className="dloja-closed-banner">
          <strong>Loja fechada{motivoFechada ? ` · ${motivoFechada}` : ' no momento'}</strong> — você pode ver o cardápio, mas não é possível fazer pedidos.
        </div>
      )}

      <main className="dloja-main">
        {resultadosBusca ? (
          resultadosBusca.length === 0 ? (
            <div className="dloja-empty">
              <IconImage />
              <p>Nenhum produto encontrado para “{busca.trim()}”.</p>
            </div>
          ) : (
            <section className="dloja-section">
              <h2 className="dloja-cat-title">Resultados ({resultadosBusca.length})</h2>
              <div className="dloja-produtos">
                {resultadosBusca.map(p => (
                  <ProdutoCard
                    key={p.id}
                    produto={p}
                    quantidade={qtdProduto(p.id)}
                    lojaAberta={lojaAberta}
                    onAdd={() => (p.complementos?.length ? abrirProduto(p) : addOne(p))}
                    onRemove={() => removeOne(String(p.id))}
                  />
                ))}
              </div>
            </section>
          )
        ) : categorias.length === 0 && semCategoria.length === 0 ? (
          <div className="dloja-empty">
            <IconImage />
            <p>{filtroEstoqueBaixo ? 'Nenhum produto com estoque baixo.' : 'Nenhum produto disponível para delivery.'}</p>
            {filtroEstoqueBaixo && (
              <button className="dloja-cat-nav-btn" style={{ marginTop: 12 }} onClick={() => setFiltroEstoqueBaixo(false)}>
                Ver todos
              </button>
            )}
          </div>
        ) : (
          <>
            {categorias.map(cat => (
              <section key={cat} className="dloja-section" ref={el => { catRefs.current[cat] = el }} data-cat={cat}>
                <h2 className="dloja-cat-title">{cat}</h2>
                <div className="dloja-produtos">
                  {produtosFiltrados.filter(p => p.categoria === cat).map(p => (
                    <ProdutoCard
                      key={p.id}
                      produto={p}
                      quantidade={qtdProduto(p.id)}
                      lojaAberta={lojaAberta}
                      onAdd={() => (p.complementos?.length ? abrirProduto(p) : addOne(p))}
                      onRemove={() => removeOne(String(p.id))}
                    />
                  ))}
                </div>
              </section>
            ))}

            {semCategoria.length > 0 && (
              <section className="dloja-section" ref={el => { catRefs.current['__sem__'] = el }} data-cat="__sem__">
                <h2 className="dloja-cat-title">Outros</h2>
                <div className="dloja-produtos">
                  {semCategoria.map(p => (
                    <ProdutoCard
                      key={p.id}
                      produto={p}
                      quantidade={qtdProduto(p.id)}
                      lojaAberta={lojaAberta}
                      onAdd={() => (p.complementos?.length ? abrirProduto(p) : addOne(p))}
                      onRemove={() => removeOne(String(p.id))}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {totalItens > 0 && !drawerOpen && (
        <button className="dloja-cart-bar" onClick={() => setDrawerOpen(true)}>
          <span className="dloja-cart-bar-badge">{totalItens} {totalItens === 1 ? 'item' : 'itens'}</span>
          <span>Ver carrinho</span>
          <span className="dloja-cart-bar-total">R$ {fmt(subtotal)}</span>
        </button>
      )}

      {drawerOpen && (
        <div className="dloja-overlay" onClick={() => setDrawerOpen(false)}>
          <aside
            ref={drawerRef}
            className="dloja-drawer"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Carrinho"
          >
            <div className="dloja-drawer-header">
              <h2 className="dloja-drawer-title">Carrinho</h2>
              <button className="dloja-drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Fechar">
                <IconX />
              </button>
            </div>

            <div className="dloja-drawer-body">
              {itens.map(item => (
                <div key={item.key} className="dloja-drawer-item">
                  <div className="dloja-drawer-item-info">
                    <span className="dloja-drawer-item-nome">{item.nome}</span>
                    {item.complementos?.length > 0 && (
                      <span style={{ fontSize: 12, color: 'var(--dl-text-muted)', lineHeight: 1.4, display: 'block', marginTop: 2 }}>
                        {item.complementos.map(c => `${Number(c.qtd ?? 1)}× ${c.nome}`).join(', ')}
                      </span>
                    )}
                    <span className="dloja-drawer-item-preco">R$ {fmt(item.preco)} cada</span>
                  </div>
                  <div className="dloja-drawer-item-ctrl">
                    <div className="dloja-qty">
                      <button className="dloja-qty-btn" onClick={() => removeOne(item.key)} aria-label={qtdTravada(item) ? "Remover do carrinho" : "Remover um"}>
                        <IconMinus />
                      </button>
                      <span className="dloja-qty-val">{item.quantidade}</span>
                      {/* Montagem de atacado não soma de um em um: a quantidade
                          vem da soma dos sabores e tem que continuar batendo. */}
                      <button
                        className="dloja-qty-btn"
                        onClick={() => incKey(item.key)}
                        disabled={qtdTravada(item)}
                        style={qtdTravada(item) ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}
                        aria-label="Adicionar um"
                      >
                        <IconPlus />
                      </button>
                    </div>
                    <span className="dloja-drawer-item-sub">R$ {fmt(item.quantidade * Number(item.preco))}</span>
                    <button className="dloja-drawer-item-del" onClick={() => removeItem(item.key)} aria-label={`Remover ${item.nome}`}>
                      <IconTrash />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="dloja-drawer-footer">
              <div className="dloja-drawer-linha">
                <span>Subtotal</span>
                <span>R$ {fmt(subtotal)}</span>
              </div>
              <div className="dloja-drawer-linha">
                <span>Taxa de entrega</span>
                <span style={taxaIndefinida ? { color: 'var(--dl-text-muted)' } : undefined}>
                  {taxaIndefinida ? 'A calcular' : taxaEntrega === 0 ? 'Grátis' : `R$ ${fmt(taxaEntrega)}`}
                </span>
              </div>
              <div className="dloja-drawer-linha dloja-drawer-total">
                <span>Total</span>
                <strong>R$ {fmt(total)}{taxaIndefinida ? ' + entrega' : ''}</strong>
              </div>
              <button
                className="dloja-btn-finalizar"
                onClick={handleFinalizar}
                disabled={!lojaAberta}
              >
                {lojaAberta ? 'Finalizar pedido' : 'Loja fechada'}
              </button>
            </div>
          </aside>
        </div>
      )}

      {optProduto && (
        <OptionsModal
          key={optProduto.id}
          produto={optProduto}
          draftKey={draftKey}
          rascunho={rascunho?.produtoId === optProduto.id ? rascunho.sel : null}
          onClose={() => { limparRascunho(); setOptProduto(null) }}
          onConfirm={(selecoes, precoUnit, qtdItem) => { limparRascunho(); addCombo(optProduto, selecoes, precoUnit, qtdItem) }}
        />
      )}

      <AvisoCookies loja={loja} />
    </div>
  )
}

function ProdutoCard({ produto, quantidade, lojaAberta, onAdd, onRemove }) {
  const temComplementos = produto.complementos?.length > 0
  // Preço "a partir de" = base + as opções obrigatórias mais baratas (o `min` de
  // cada grupo). Sem isso, um produto "monte" com base 0 (ex: pizza 2 sabores)
  // mostraria "a partir de R$ 0,00".
  const minExtra = (produto.complementos ?? []).reduce((s, g) => {
    const n = g.min ?? 0
    if (n <= 0) return s
    const precos = (g.opcoes ?? []).map(o => Number(o.preco_adicional || 0)).sort((a, b) => a - b)
    // Grupo que cobra pelo mais caro: pegar n opções baratas custa o preço de UMA.
    if (cobraPeloMaior(g)) return s + (precos[0] ?? 0)
    return s + precos.slice(0, n).reduce((a, b) => a + b, 0)
  }, 0)
  const precoBase = Number(produto.preco) + minExtra
  const faixa1 = menorFaixa(produto.faixas_preco)
  // Promocao (mig 0202): o que vende nao e o "R$ 15,00", e o R$ 18,00 riscado
  // do lado. Sem o de antes, o cliente nao sabe que esta levando mais barato.
  const riscado = precoRiscado(produto.preco, produto.preco_promocional)
  const precoMostrado = riscado ? Number(produto.preco_promocional) + minExtra : precoBase
  return (
    <div className="dloja-prod-card">
      <div className="dloja-prod-foto">
        {produto.foto_url
          ? <img src={produto.foto_url} alt={produto.nome} className="dloja-prod-img" />
          : (
            <div className="dloja-prod-placeholder">
              <IconImage />
            </div>
          )
        }
      </div>
      <div className="dloja-prod-info">
        <p className="dloja-prod-nome">{produto.nome}</p>
        {produto.descricao && (
          <p className="dloja-prod-desc">{produto.descricao}</p>
        )}
        <p className="dloja-prod-preco">
          {temComplementos && <span style={{ fontSize: 11, color: 'var(--dl-text-muted)', fontWeight: 500 }}>a partir de </span>}
          {riscado && (
            <span style={{
              textDecoration: 'line-through', color: 'var(--dl-text-muted)',
              fontWeight: 500, fontSize: '0.82em', marginRight: 6,
            }}>
              R$ {fmt(riscado + minExtra)}
            </span>
          )}
          <span style={riscado ? { color: '#22c55e' } : undefined}>R$ {fmt(precoMostrado)}</span>
        </p>
        {/* Chamada do atacado no card: o desconto só vende se o cliente souber
            que ele existe antes de abrir o produto. */}
        {faixa1 && (
          <p style={{ fontSize: 11.5, color: '#22c55e', fontWeight: 700, margin: '2px 0 0' }}>
            {faixa1.qtd_min}+ por R$ {fmt(faixa1.preco)} cada
          </p>
        )}
      </div>
      <div className="dloja-prod-acao">
        {temComplementos ? (
          // Produtos com opções: sempre abre o modal pra escolher (montar)
          <button
            className="dloja-btn-add"
            onClick={onAdd}
            disabled={!lojaAberta}
            aria-label={`Montar ${produto.nome}`}
            style={quantidade > 0 ? { position: 'relative' } : undefined}
          >
            <IconPlus size={14} />
            {quantidade > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, padding: '0 4px',
                borderRadius: 9, background: '#22c55e', color: '#04120a', fontSize: 11, fontWeight: 800,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{quantidade}</span>
            )}
          </button>
        ) : quantidade === 0 ? (
          <button
            className="dloja-btn-add"
            onClick={onAdd}
            disabled={!lojaAberta}
            aria-label={`Adicionar ${produto.nome}`}
          >
            <IconPlus size={14} />
          </button>
        ) : (
          <div className="dloja-qty dloja-qty--card">
            <button className="dloja-qty-btn" onClick={onRemove} aria-label="Remover um">
              <IconMinus size={14} />
            </button>
            <span className="dloja-qty-val">{quantidade}</span>
            <button className="dloja-qty-btn dloja-qty-btn--primary" onClick={onAdd} disabled={!lojaAberta} aria-label="Adicionar um">
              <IconPlus size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Modal "monte seu produto" (complementos: proteínas, saladas, etc.) ──
// Quais opções do grupo estão escolhidas, como [idDaOpcao, quantidade].
function escolhidasDe(sel, grupoId) {
  return Object.entries(sel?.[grupoId] ?? {}).filter(([, q]) => Number(q) > 0)
}
// Quantas opções DIFERENTES (é o que "escolha 2 sabores" conta).
function nEscolhidas(sel, grupoId) {
  return escolhidasDe(sel, grupoId).length
}
// Quantas UNIDADES somando tudo (é o que o atacado conta: 500 + 100 = 600).
function somaQtd(sel, grupoId) {
  return escolhidasDe(sel, grupoId).reduce((t, [, q]) => t + (Number(q) || 0), 0)
}

function OptionsModal({ produto, draftKey, rascunho, onClose, onConfirm }) {
  const grupos = produto.complementos ?? []
  // seleção: { [grupoId]: { [opcaoId]: quantidade } } — começa do rascunho, se
  // voltou de um recarregamento no meio da montagem.
  //
  // Era um Set de ids. Virou mapa por causa do atacado (mig 0200), onde o
  // cliente não marca o sabor, ele diz QUANTO quer de cada um. Grupo normal
  // grava quantidade 1, então a regra de "escolha 2" segue contando opções.
  const [sel, setSel] = useState(() => {
    const init = {}
    for (const g of grupos) {
      const bruto = rascunho?.[g.id]
      // Rascunho salvo antes dessa mudança é uma lista de ids: converte pra
      // quantidade 1 em vez de perder a montagem pela metade.
      init[g.id] = Array.isArray(bruto)
        ? Object.fromEntries(bruto.filter(Boolean).map(id => [id, 1]))
        : { ...(bruto ?? {}) }
    }
    return init
  })

  // Guarda a montagem a cada escolha. É o que faz a quentinha pela metade
  // voltar inteira se a página recarregar (atualização do app, aba descartada
  // pelo celular, toque sem querer no voltar).
  useEffect(() => {
    if (!draftKey) return
    try {
      const plano = {}
      let temAlgo = false
      for (const gid of Object.keys(sel)) {
        const escolhas = Object.fromEntries(escolhidasDe(sel, gid))
        plano[gid] = escolhas
        if (Object.keys(escolhas).length > 0) temAlgo = true
      }
      if (temAlgo) {
        localStorage.setItem(draftKey, JSON.stringify({ produtoId: produto.id, sel: plano, ts: Date.now() }))
      } else {
        localStorage.removeItem(draftKey)
      }
    } catch { /* localStorage indisponível */ }
  }, [sel, draftKey, produto.id])

  // Refs pra rolar sozinho de um grupo pro outro (ver `avancar` abaixo).
  const corpoRef = useRef(null)
  const gruposRef = useRef({})
  const [destaque, setDestaque] = useState(null)

  // Fechou um grupo (escolheu o tanto que podia)? Leva o cliente pro próximo
  // que ainda aceita escolha. Nasceu da pizzaria: o cliente marcava o sabor,
  // não descia mais e a BORDA passava batida — vendia pouca borda porque
  // ninguém via que existia.
  function avancar(grupoFeito, selAtual) {
    const i = grupos.findIndex(g => g.id === grupoFeito.id)
    const proximo = grupos.slice(i + 1).find(g =>
      !g.modo_quantidade && nEscolhidas(selAtual, g.id) < (g.max ?? 1))
    if (!proximo) return
    setDestaque(proximo.id)
    requestAnimationFrame(() => {
      const corpo = corpoRef.current
      const alvo = gruposRef.current[proximo.id]
      if (!corpo || !alvo) return
      const topo = corpo.scrollTop + (alvo.getBoundingClientRect().top - corpo.getBoundingClientRect().top) - 10
      corpo.scrollTo({ top: topo, behavior: 'smooth' })
    })
  }

  // O destaque é só o piscar do grupo pro qual pulamos — apaga sozinho.
  useEffect(() => {
    if (!destaque) return
    const t = setTimeout(() => setDestaque(null), 1600)
    return () => clearTimeout(t)
  }, [destaque])

  function toggle(grupo, opcao) {
    const atual = { ...(sel[grupo.id] ?? {}) }
    const marcando = !(Number(atual[opcao.id]) > 0)
    if (!marcando) {
      delete atual[opcao.id]
    } else {
      if (grupo.max === 1) for (const k of Object.keys(atual)) delete atual[k]  // rádio
      if (Object.keys(atual).length >= grupo.max) return   // limite atingido (checkbox)
      atual[opcao.id] = 1
    }
    const novo = { ...sel, [grupo.id]: atual }
    setSel(novo)
    if (marcando && Object.keys(atual).length >= (grupo.max ?? 1)) avancar(grupo, novo)
  }

  // Atacado: grava a quantidade daquela opção. Zero apaga a linha (fica igual a
  // não ter escolhido). Sem teto — quem compra 500 picolés tem que conseguir.
  function setQtd(grupo, opcao, valor) {
    const n = Math.max(0, Math.floor(Number(valor) || 0))
    setSel(prev => {
      const atual = { ...(prev[grupo.id] ?? {}) }
      if (n > 0) atual[opcao.id] = n
      else delete atual[opcao.id]
      return { ...prev, [grupo.id]: atual }
    })
  }

  const selecoes = grupos.flatMap(g =>
    escolhidasDe(sel, g.id).map(([oid, q]) => {
      const o = g.opcoes.find(x => String(x.id) === String(oid))
      return {
        grupoId: g.id, grupo: g.nome, opcaoId: oid, nome: o?.nome ?? '',
        preco: Number(o?.preco_adicional ?? 0),
        qtd: Number(q) || 1,
        // Marca pra comanda/cupom não multiplicar de novo pela quantidade do
        // item: aqui os sabores DIVIDEM o total, não multiplicam (itensPedido.js).
        absoluto: !!g.modo_quantidade,
      }
    })
  )

  // Quantas unidades esse item leva. No atacado é a soma dos sabores (500 + 100
  // = 600) — e é essa quantidade que dá baixa certa no estoque.
  const grupoQtd = grupos.find(g => g.modo_quantidade)
  const qtdItem = grupoQtd ? somaQtd(sel, grupoQtd.id) : 1

  // Preco de atacado entra sozinho quando a quantidade alcanca a faixa.
  const precoBase = precoPorQuantidade(produto.preco, produto.faixas_preco, qtdItem, produto.preco_promocional)
  const faixa = faixaAplicada(produto.faixas_preco, qtdItem)
  const riscado = precoRiscado(produto.preco, produto.preco_promocional)
  const adicional = adicionalComplementos(grupos, selecoes)
  // Opção que custa a mais entra rateada no total, pra o item ter UM preço
  // unitário e o subtotal (qtd × unitário) continuar batendo.
  const precoUnit = qtdItem > 0 ? precoBase + adicional / qtdItem : precoBase + adicional
  const totalItem = precoUnit * (qtdItem || 1)

  const faltando = grupos.filter(g => g.modo_quantidade
    ? somaQtd(sel, g.id) < (g.min ?? 0)
    : nEscolhidas(sel, g.id) < (g.min ?? 0))
  const podeAdd = faltando.length === 0 && qtdItem > 0

  return (
    <div className="dloja-overlay" onClick={onClose}>
      <aside className="dloja-drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Montar ${produto.nome}`}>
        <div className="dloja-drawer-header">
          <h2 className="dloja-drawer-title">{produto.nome}</h2>
          <button className="dloja-drawer-close" onClick={onClose} aria-label="Fechar"><IconX /></button>
        </div>

        <div className="dloja-drawer-body">
          {/* pre-wrap: a descricao e o unico lugar onde a loja avisa coisa do
              tipo "nao aceitamos balde de retorno sujo". Sem isso as linhas do
              aviso viravam um paragrafo unico e ninguem lia. */}
          {produto.descricao && (
            <p style={{ fontSize: 13, color: 'var(--dl-text-muted)', margin: '0 0 12px', whiteSpace: 'pre-wrap' }}>{produto.descricao}</p>
          )}
          {riscado && (
            <p style={{ fontSize: 13.5, margin: '0 0 12px', fontWeight: 700 }}>
              <span style={{ textDecoration: 'line-through', color: 'var(--dl-text-muted)', fontWeight: 500 }}>
                R$ {fmt(riscado)}
              </span>
              <span style={{ color: '#22c55e', marginLeft: 8 }}>
                R$ {fmt(Number(produto.preco_promocional))} · promoção
              </span>
            </p>
          )}
          {grupos.map(grupo => {
            const qtdSel = nEscolhidas(sel, grupo.id)
            const totalGrupo = somaQtd(sel, grupo.id)
            const obrig = (grupo.min ?? 0) > 0
            const incompleto = grupo.modo_quantidade
              ? totalGrupo < (grupo.min ?? 0)
              : qtdSel < (grupo.min ?? 0)
            const pulouPraCa = destaque === grupo.id
            return (
              <div key={grupo.id} ref={el => { gruposRef.current[grupo.id] = el }} style={{
                marginBottom: 18, borderRadius: 12, transition: 'box-shadow .3s, background .3s',
                boxShadow: pulouPraCa ? '0 0 0 2px #22c55e' : 'none',
                background: pulouPraCa ? 'rgba(34,197,94,.07)' : 'transparent',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--dl-text)' }}>{grupo.nome}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                    background: incompleto ? 'rgba(239,68,68,.15)' : 'var(--dl-surface-2)',
                    color: incompleto ? '#f87171' : 'var(--dl-text-muted)',
                  }}>
                    {grupo.modo_quantidade
                      ? (totalGrupo > 0
                          ? `${totalGrupo} ${totalGrupo === 1 ? 'unidade' : 'unidades'}`
                          : (obrig ? `Mínimo ${grupo.min}` : 'Escolha a quantidade'))
                      : grupo.min > 0 && grupo.min === grupo.max
                        ? `Escolha ${grupo.max}`
                        : `${obrig ? 'Obrigatório' : 'Opcional'}${grupo.max > 1 ? ` · até ${grupo.max}` : ''}`}
                  </span>
                </div>
                {cobraPeloMaior(grupo) && (
                  <p style={{ fontSize: 12, color: 'var(--dl-text-muted)', margin: '-2px 0 8px' }}>
                    Você paga pelo sabor mais caro que escolher.
                  </p>
                )}
                {blocosDeOpcoes(grupo.opcoes).map(bloco => (
                <div key={bloco.titulo ?? 'unico'} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: bloco.titulo ? 12 : 0 }}>
                  {bloco.titulo && <p className="dloja-opt-bloco-titulo">{bloco.titulo}</p>}
                  {bloco.opcoes.map(opcao => {
                    const qtdOpcao = Number(sel[grupo.id]?.[opcao.id]) || 0
                    const marcado = qtdOpcao > 0
                    const bloqueado = !marcado && grupo.max > 1 && qtdSel >= grupo.max

                    // Atacado: linha com − / número / +. O número é um campo de
                    // verdade porque ninguém clica 500 vezes no + — desiste antes.
                    if (grupo.modo_quantidade) return (
                      <div
                        key={opcao.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                          padding: '8px 12px', borderRadius: 10,
                          border: `1.5px solid ${marcado ? '#22c55e' : 'var(--dl-border)'}`,
                          background: marcado ? 'rgba(34,197,94,.12)' : 'var(--dl-surface)',
                          color: 'var(--dl-text)',
                        }}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 14 }}>{opcao.nomeCurto ?? opcao.nome}</span>
                          {opcao.descricao && (
                            <span style={{ display: 'block', fontSize: 12, lineHeight: 1.35, color: 'var(--dl-text-muted)', marginTop: 2 }}>
                              {opcao.descricao}
                            </span>
                          )}
                        </span>
                        <div className="dloja-qty" style={{ flexShrink: 0 }}>
                          <button
                            type="button" className="dloja-qty-btn" aria-label={`Menos ${opcao.nome}`}
                            disabled={qtdOpcao <= 0}
                            onClick={() => setQtd(grupo, opcao, qtdOpcao - 1)}
                          >
                            <IconMinus />
                          </button>
                          <input
                            type="number" min="0" inputMode="numeric"
                            aria-label={`Quantidade de ${opcao.nome}`}
                            value={qtdOpcao === 0 ? '' : qtdOpcao}
                            placeholder="0"
                            onChange={e => setQtd(grupo, opcao, e.target.value)}
                            onFocus={e => e.target.select()}
                            style={{
                              width: 62, textAlign: 'center', fontSize: 14, fontWeight: 700,
                              padding: '4px 2px', borderRadius: 8, border: '1px solid var(--dl-border)',
                              background: 'var(--dl-surface)', color: 'var(--dl-text)',
                            }}
                          />
                          <button
                            type="button" className="dloja-qty-btn" aria-label={`Mais ${opcao.nome}`}
                            onClick={() => setQtd(grupo, opcao, qtdOpcao + 1)}
                          >
                            <IconPlus />
                          </button>
                        </div>
                      </div>
                    )

                    return (
                      <button
                        key={opcao.id}
                        type="button"
                        onClick={() => toggle(grupo, opcao)}
                        disabled={bloqueado}
                        style={{
                          display: 'flex', alignItems: opcao.descricao ? 'flex-start' : 'center', gap: 10, width: '100%', textAlign: 'left',
                          padding: '10px 12px', borderRadius: 10, cursor: bloqueado ? 'not-allowed' : 'pointer',
                          border: `1.5px solid ${marcado ? '#22c55e' : 'var(--dl-border)'}`,
                          background: marcado ? 'rgba(34,197,94,.12)' : 'var(--dl-surface)',
                          color: 'var(--dl-text)', opacity: bloqueado ? 0.4 : 1,
                        }}
                      >
                        <span style={{
                          width: 20, height: 20, flexShrink: 0, borderRadius: grupo.max === 1 ? '50%' : 6,
                          marginTop: opcao.descricao ? 1 : 0,
                          border: `2px solid ${marcado ? '#22c55e' : 'var(--dl-text-dim)'}`,
                          background: marcado ? '#22c55e' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#04120a',
                        }}>
                          {marcado && <IconCheckSmall />}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 14 }}>{opcao.nomeCurto ?? opcao.nome}</span>
                          {opcao.descricao && (
                            <span style={{ display: 'block', fontSize: 12, lineHeight: 1.35, color: 'var(--dl-text-muted)', marginTop: 2 }}>
                              {opcao.descricao}
                            </span>
                          )}
                        </span>
                        {rotuloPrecoOpcao(grupo, opcao.preco_adicional, fmt) && (
                          <span style={{ fontSize: 13, color: '#22c55e', fontWeight: 700, flexShrink: 0, marginTop: opcao.descricao ? 1 : 0 }}>
                            {rotuloPrecoOpcao(grupo, opcao.preco_adicional, fmt)}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                ))}
              </div>
            )
          })}
        </div>

        <div className="dloja-drawer-footer">
          {/* No atacado o cliente precisa ver a conta antes de somar: quantas
              unidades deu, quanto está saindo cada uma e por que baixou. */}
          {grupoQtd && qtdItem > 0 && (
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 10, marginBottom: 8, fontSize: 13, color: 'var(--dl-text-muted)',
            }}>
              <span>
                <strong style={{ color: 'var(--dl-text)' }}>{qtdItem}</strong>{' '}
                {qtdItem === 1 ? 'unidade' : 'unidades'}
              </span>
              <span style={{ textAlign: 'right' }}>
                R$ {fmt(precoUnit)} cada
                {faixa && (
                  <span style={{ display: 'block', fontSize: 11.5, color: '#22c55e', fontWeight: 700 }}>
                    preço a partir de {faixa.qtd_min} unidades
                  </span>
                )}
              </span>
            </div>
          )}
          <button className="dloja-btn-finalizar" onClick={() => onConfirm(selecoes, precoUnit, qtdItem)} disabled={!podeAdd}>
            {podeAdd
              ? `Adicionar · R$ ${fmt(totalItem)}`
              : faltando.length
                ? `Escolha: ${faltando.map(g => g.nome).join(', ')}`
                : 'Escolha a quantidade'}
          </button>
        </div>
      </aside>
    </div>
  )
}

function IconCheckSmall() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
