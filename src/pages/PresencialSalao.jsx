import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { imprimirHtml, montarContaPresencialHtml, appFwcDisponivel } from '../utils/imprimirCupom'
import '../components/Page.css'

const FORMAS = [
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'pix',      label: 'PIX' },
  { id: 'cartao',   label: 'Cartão' },
]

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

// Tira acento e deixa minúsculo: assim "agua" acha "Água", "cafe" acha "Café" etc.
const semAcento = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

export default function PresencialSalao() {
  const { profile, user } = useAuth()
  const empresaId = profile?.empresa_id
  // Só o ADM confere o pagamento e libera a mesa. Garçom fecha, mas não libera.
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'

  const [taxaPct, setTaxaPct] = useState(10)
  const [empresaNome, setEmpresaNome] = useState('')
  const [mesas, setMesas]     = useState([])
  const [comandas, setComandas] = useState([])
  const [produtos, setProdutos] = useState([])
  const [garcons, setGarcons] = useState({})   // { profile_id: nome }
  const [loading, setLoading] = useState(true)

  const [mesaSel, setMesaSel] = useState(null)   // mesa aberta no drawer
  const [busca, setBusca]     = useState('')
  const [categoriaSel, setCategoriaSel] = useState(null) // categoria aberta no menu de adicionar item
  const [fechando, setFechando] = useState(false) // modal de fechamento
  const [forma, setForma]     = useState('dinheiro')
  const [aplicarTaxa, setAplicarTaxa] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [obsEdit, setObsEdit] = useState({})  // observação em edição por item
  const [precoEdit, setPrecoEdit] = useState({})  // preço em edição por item (só admin)
  const [modoPag, setModoPag] = useState('unico')   // 'unico' | 'dividir'
  const [pagamentos, setPagamentos] = useState([])  // [{ forma, valor(string) }] no modo dividir
  // Rascunho: itens que o garçom monta mas que só vão pra cozinha (e pra impressora)
  // quando ele clica "Enviar" — assim o pedido inteiro sai numa impressão só.
  const [rascunho, setRascunho] = useState([]) // [{ produto_id, nome, preco_venda, quantidade }]
  const [enviando, setEnviando] = useState(false)
  const buscaRef = useRef(null) // pra focar de volta o campo de busca ao limpar (X)
  // "Inventar produto": criar item na hora (só nesta venda) ou salvar no catálogo.
  const [invAberto, setInvAberto] = useState(false)
  const [invNome, setInvNome] = useState('')
  const [invPreco, setInvPreco] = useState('')
  const [invCatalogo, setInvCatalogo] = useState(false)
  const [invCategoria, setInvCategoria] = useState('')
  const [invSalvando, setInvSalvando] = useState(false)
  const [ordemCat, setOrdemCat] = useState({}) // { nomeCategoria(minusculo): ordem } — mesma ordem do catálogo

  async function loadAll() {
    if (!empresaId) return
    const [emp, ms, cs, ps, gs, cat] = await Promise.all([
      supabase.from('empresas').select('taxa_servico_pct, nome').eq('id', empresaId).single(),
      supabase.from('mesas').select('*').eq('empresa_id', empresaId).eq('ativa', true).order('numero'),
      supabase.from('comandas').select('*, comanda_itens(*)').eq('empresa_id', empresaId).in('status', ['aberta', 'aguardando_conferencia']),
      supabase.from('estoque_catalogo').select('produto_id, nome, preco_venda, categoria').eq('empresa_id', empresaId).order('nome').limit(500),
      supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
      supabase.from('categorias').select('nome, ordem').eq('empresa_id', empresaId),
    ])
    if (emp.data) { setTaxaPct(Number(emp.data.taxa_servico_pct ?? 10)); setEmpresaNome(emp.data.nome || '') }
    setMesas(ms.data ?? [])
    setComandas(cs.data ?? [])
    setProdutos(ps.data ?? [])
    setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
    const om = {}
    for (const c of (cat.data ?? [])) if (c?.nome != null) om[String(c.nome).trim().toLowerCase()] = c.ordem == null ? 9999 : c.ordem
    setOrdemCat(om)
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: atualiza quando outro garçom mexe nas comandas
  useEffect(() => {
    if (!empresaId) return
    const ch = supabase.channel(`salao_${empresaId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comandas', filter: `empresa_id=eq.${empresaId}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_itens', filter: `empresa_id=eq.${empresaId}` }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mesas', filter: `empresa_id=eq.${empresaId}` }, loadAll)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  const comandaPorMesa = useMemo(() => {
    const map = {}
    for (const c of comandas) map[c.mesa_id] = c
    return map
  }, [comandas])

  function subtotalDe(comanda) {
    return (comanda?.comanda_itens ?? []).reduce((s, i) => s + Number(i.preco_unitario) * i.quantidade, 0)
  }

  function prontosDe(comanda) {
    return (comanda?.comanda_itens ?? []).filter(i => i.status === 'pronto').length
  }

  // Bip quando a cozinha marca um item como pronto (avisa o garçom)
  const prevProntos = useRef(0)
  function bip() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = 880
      gain.gain.setValueAtTime(0.001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
      osc.start(); osc.stop(ctx.currentTime + 0.36)
    } catch { /* áudio bloqueado pelo navegador — ignora */ }
  }
  useEffect(() => {
    const total = comandas.reduce((s, c) => s + prontosDe(c), 0)
    if (total > prevProntos.current) bip()
    prevProntos.current = total
  }, [comandas])

  const comandaSel = mesaSel ? comandaPorMesa[mesaSel.id] : null
  // Rascunho é por comanda e fica salvo no navegador (sobrevive a fechar sem querer).
  const rascunhoKey = comandaSel ? 'rasc_mesa_' + comandaSel.id : null
  useEffect(() => {
    if (!rascunhoKey) { setRascunho([]); return }
    try { setRascunho(JSON.parse(localStorage.getItem(rascunhoKey) || '[]')) } catch { setRascunho([]) }
  }, [rascunhoKey])
  useEffect(() => {
    if (!rascunhoKey) return
    try { localStorage.setItem(rascunhoKey, JSON.stringify(rascunho)) } catch { /* ignora */ }
  }, [rascunho, rascunhoKey])
  const subtotalRascunho = rascunho.reduce((s, r) => s + Number(r.preco_venda) * r.quantidade, 0)

  const subtotalSel = subtotalDe(comandaSel)
  const taxaSel = aplicarTaxa ? Math.round(subtotalSel * (taxaPct / 100) * 100) / 100 : 0
  const totalSel = subtotalSel + taxaSel

  // Divisão da conta
  const somaPag = pagamentos.reduce((s, p) => s + (Number(p.valor) || 0), 0)
  const restante = Math.round((totalSel - somaPag) * 100) / 100
  const podeReceber = modoPag === 'unico' || Math.abs(restante) < 0.05

  // ── Ações ────────────────────────────────────────────────────────────────
  async function abrirMesa(mesa) {
    const existente = comandaPorMesa[mesa.id]
    if (!existente) {
      await supabase.from('comandas').insert({
        empresa_id: empresaId, mesa_id: mesa.id, numero_mesa: mesa.numero, garcom_id: user?.id ?? null,
      })
      await supabase.from('mesas').update({ status: 'ocupada' }).eq('id', mesa.id)
      await loadAll()
    }
    setMesaSel(mesa)
    setBusca(''); setCategoriaSel(null); setFechando(false); setForma('dinheiro'); setAplicarTaxa(true)
  }

  // Fecha o drawer da mesa. Se a mesa foi só ABERTA e não tem NADA (nenhum item
  // lançado e nenhum rascunho), desocupa: apaga a comanda vazia e libera a mesa —
  // assim "olhar" a mesa não deixa ela ocupada com R$ 0,00.
  async function sairDaMesa() {
    const c = comandaSel
    if (c && c.status === 'aberta' && (c.comanda_itens ?? []).length === 0 && rascunho.length === 0) {
      await supabase.from('comandas').delete().eq('id', c.id)
      await supabase.from('mesas').update({ status: 'livre' }).eq('id', c.mesa_id)
      if (rascunhoKey) { try { localStorage.removeItem(rascunhoKey) } catch { /* ignora */ } }
      setMesaSel(null)
      await loadAll()
      return
    }
    setMesaSel(null)
  }

  // Adicionar item agora vai pro RASCUNHO (não vai pra cozinha ainda). Só quando o
  // garçom clica "Enviar para a cozinha" é que os itens são gravados e impressos.
  function addItem(produto) {
    if (!comandaSel) return
    if (comandaSel.status === 'aguardando_conferencia') { window.alert('Conta já fechada, aguardando o ADM liberar a mesa.'); return }
    setRascunho(prev => {
      const i = prev.findIndex(r => r.produto_id === produto.produto_id)
      if (i >= 0) {
        const c = prev.slice(); c[i] = { ...c[i], quantidade: c[i].quantidade + 1 }; return c
      }
      return [...prev, { produto_id: produto.produto_id, nome: produto.nome, preco_venda: Number(produto.preco_venda), quantidade: 1, observacao: '' }]
    })
  }
  function mudarQtdRascunho(produtoId, delta) {
    setRascunho(prev => prev.flatMap(r => {
      if (r.produto_id !== produtoId) return [r]
      const q = r.quantidade + delta
      return q <= 0 ? [] : [{ ...r, quantidade: q }]
    }))
  }
  // Observação do item AINDA no rascunho (antes de ir pra cozinha) — vai junto no envio.
  function mudarObsRascunho(produtoId, texto) {
    setRascunho(prev => prev.map(r => r.produto_id === produtoId ? { ...r, observacao: texto } : r))
  }

  // "Inventar produto": adiciona um item que não está no catálogo. Se o admin marcar
  // "adicionar ao catálogo", cria o produto de verdade (pra próximas vendas); senão o
  // item existe só nesta venda (produto_id "avulso:", que vira null no comanda_itens).
  async function adicionarInventado() {
    if (!comandaSel) return
    if (comandaSel.status === 'aguardando_conferencia') { window.alert('Conta já fechada, aguardando o ADM liberar a mesa.'); return }
    const nome = invNome.trim()
    const preco = Number(String(invPreco).replace(',', '.')) || 0
    if (!nome) { window.alert('Digite o nome do produto.'); return }
    if (preco <= 0) { window.alert('Digite um preço válido.'); return }

    let produtoId = 'avulso:' + Date.now() + '-' + Math.floor(Math.random() * 1000)
    if (invCatalogo && ehAdmin) {
      setInvSalvando(true)
      const { data, error } = await supabase.from('produtos')
        .insert({ empresa_id: empresaId, nome, preco_venda: preco, categoria: (invCategoria.trim() || 'outros'), controla_estoque: false })
        .select('id').single()
      setInvSalvando(false)
      if (error) { window.alert('Erro ao salvar no catálogo: ' + error.message); return }
      produtoId = data.id
      await loadAll()  // recarrega os produtos pra o novo aparecer na busca
    }
    setRascunho(prev => [...prev, { produto_id: produtoId, nome, preco_venda: preco, quantidade: 1, observacao: '' }])
    setInvNome(''); setInvPreco(''); setInvCatalogo(false); setInvCategoria(''); setInvAberto(false)
  }
  // Nome já existe no catálogo? (ignora acento/maiúsculas) — pra avisar sem bloquear.
  const invNomeExiste = invNome.trim() && produtos.some(p => semAcento(p.nome) === semAcento(invNome))
  // Envia o pedido montado pra cozinha: insere TODOS os itens de uma vez → sai numa
  // impressão só (o gestor e o app FWC juntam os inserts que chegam juntos).
  async function enviarCozinha() {
    if (!comandaSel || !rascunho.length || enviando) return
    setEnviando(true)
    const rows = rascunho.map(r => ({
      empresa_id: empresaId, comanda_id: comandaSel.id,
      produto_id: (r.produto_id && !String(r.produto_id).startsWith('avulso:')) ? r.produto_id : null,
      nome: r.nome,
      preco_unitario: Number(r.preco_venda), quantidade: r.quantidade,
      observacao: (r.observacao ?? '').trim() || null,
    }))
    const { error } = await supabase.from('comanda_itens').insert(rows)
    setEnviando(false)
    if (error) { window.alert('Erro ao enviar pra cozinha: ' + error.message); return }
    setRascunho([])
    if (rascunhoKey) { try { localStorage.removeItem(rascunhoKey) } catch { /* ignora */ } }
    await loadAll()
  }

  async function mudarQtd(item, delta) {
    if (comandaSel?.status === 'aguardando_conferencia') {
      window.alert('Conta já fechada, aguardando o ADM liberar a mesa. Não dá pra mexer nos itens.')
      return
    }
    const nova = item.quantidade + delta
    if (nova <= 0) await supabase.from('comanda_itens').delete().eq('id', item.id)
    else await supabase.from('comanda_itens').update({ quantidade: nova }).eq('id', item.id)
    await loadAll()
  }

  async function entregarItem(item) {
    // registra QUEM entregou (quem clicou) — atribuição por entrega
    await supabase.from('comanda_itens')
      .update({ status: 'entregue', entregue_por: user?.id ?? null, entregue_at: new Date().toISOString() })
      .eq('id', item.id)
    await loadAll()
  }

  // Edita o preço unitário de um item já lançado (só admin) — ex.: prato por peso.
  async function salvarPreco(item) {
    const texto = precoEdit[item.id]
    setPrecoEdit(prev => { const n = { ...prev }; delete n[item.id]; return n })
    if (texto === undefined) return
    const preco = Math.max(0, Math.round(Number(String(texto).replace(',', '.')) * 100) / 100)
    if (!Number.isFinite(preco) || preco === Number(item.preco_unitario)) return
    const { error } = await supabase.from('comanda_itens').update({ preco_unitario: preco }).eq('id', item.id)
    if (error) { window.alert('Erro ao salvar o preço: ' + error.message); return }
    await loadAll()
  }

  async function salvarObs(item) {
    const texto = obsEdit[item.id]
    if (texto === undefined) return                 // não estava editando
    const novo = texto.trim() || null
    if (novo === (item.observacao ?? null)) {        // não mudou
      setObsEdit(prev => { const n = { ...prev }; delete n[item.id]; return n })
      return
    }
    await supabase.from('comanda_itens').update({ observacao: novo }).eq('id', item.id)
    setObsEdit(prev => { const n = { ...prev }; delete n[item.id]; return n })
    await loadAll()
  }

  async function cancelarMesa() {
    if (!comandaSel) return
    if (!window.confirm('Cancelar esta mesa? Os itens lançados serão descartados.')) return
    await supabase.from('comandas').update({ status: 'cancelada' }).eq('id', comandaSel.id)
    await supabase.from('mesas').update({ status: 'livre' }).eq('id', mesaSel.id)
    setMesaSel(null)
    await loadAll()
  }

  function abrirFechamento() {
    setModoPag('unico')
    setForma('dinheiro')
    setPagamentos([])
    setFechando(true)
  }

  // Rachar igual entre n pessoas (ajusta a última linha p/ fechar o total)
  function dividirIgual(n) {
    const cada = Math.floor((totalSel / n) * 100) / 100
    const arr = Array.from({ length: n }, () => ({ forma: 'dinheiro', valor: cada.toFixed(2) }))
    const resto = Math.round((totalSel - cada * n) * 100) / 100
    if (arr.length) arr[arr.length - 1].valor = (cada + resto).toFixed(2)
    setPagamentos(arr)
  }
  function addPagamento() {
    const falta = Math.max(0, Math.round((totalSel - somaPag) * 100) / 100)
    setPagamentos(prev => [...prev, { forma: 'dinheiro', valor: falta > 0 ? falta.toFixed(2) : '' }])
  }
  function updatePagamento(i, campo, val) {
    setPagamentos(prev => prev.map((p, idx) => idx === i ? { ...p, [campo]: val } : p))
  }
  function removePagamento(i) {
    setPagamentos(prev => prev.filter((_, idx) => idx !== i))
  }

  function imprimirConta() {
    const pags = modoPag === 'dividir'
      ? pagamentos.map(p => ({ forma: p.forma, valor: Number(p.valor) || 0 })).filter(p => p.valor > 0)
      : []
    // soApp: a conta do salão só sai na térmica da loja (app FWC). Se quem fechou está
    // no CELULAR (sem app), NÃO imprime no navegador do aparelho — retorna sem imprimir.
    return imprimirHtml(montarContaPresencialHtml({
      numeroMesa: mesaSel?.numero,
      itens: comandaSel?.comanda_itens ?? [],
      subtotal: subtotalSel, taxa: taxaSel, total: totalSel,
      formaPagamento: modoPag === 'unico' ? forma : 'Dividido',
      pagamentos: pags,
      empresa: { nome: empresaNome },
    }), empresaNome, { soApp: true, origem: 'mesa' }) // app filtra por origem (PC não-mesa não imprime)
  }

  async function confirmarFechamento() {
    if (!comandaSel) return
    let lista
    if (modoPag === 'unico') {
      lista = [{ forma, valor: Math.round(totalSel * 100) / 100 }]
    } else {
      lista = pagamentos
        .map(p => ({ forma: p.forma, valor: Math.round((Number(p.valor) || 0) * 100) / 100 }))
        .filter(p => p.valor > 0)
      const soma = lista.reduce((s, p) => s + p.valor, 0)
      if (lista.length === 0) { window.alert('Adicione ao menos um pagamento.'); return }
      if (Math.abs(soma - totalSel) > 0.05) {
        window.alert(`A soma (R$ ${soma.toFixed(2)}) não bate com o total (R$ ${totalSel.toFixed(2)}).`)
        return
      }
    }
    setSalvando(true)
    // Só fecha DIRETO (gera a venda + libera a mesa + imprime) quem é ADM e está no
    // PC da loja (com o app FWC/térmica). ADM no CELULAR (sem impressora) NÃO fecha
    // direto — senão a conta não sairia em lugar nenhum. Vai pro gestor, igual garçom.
    const temImpressoraLocal = ehAdmin ? await appFwcDisponivel() : false
    if (ehAdmin && temImpressoraLocal) {
      // ADM no PC da loja: fecha de vez (gera a venda e libera a mesa) e imprime aqui.
      const { error } = await supabase.rpc('fechar_conta_presencial', {
        p_comanda_id: comandaSel.id,
        p_pagamentos: lista,
        p_aplicar_taxa: aplicarTaxa,
      })
      setSalvando(false)
      if (error) { window.alert('Erro ao fechar a conta: ' + error.message); return }
      try { imprimirConta() } catch { /* best-effort */ }
    } else {
      // Garçom, OU ADM no celular (sem impressora): NÃO libera a mesa. Marca
      // "aguardando_conferencia" e guarda o pagamento. Quem IMPRIME a conta é o
      // GESTOR da loja (detecta a mesa em "aguardando" e manda pra térmica/app FWC);
      // depois o ADM confere e libera a mesa lá no gestor.
      const { error } = await supabase.from('comandas').update({
        status: 'aguardando_conferencia',
        fechamento_pendente: { pagamentos: lista, aplicar_taxa: aplicarTaxa },
      }).eq('id', comandaSel.id)
      setSalvando(false)
      if (error) { window.alert('Erro ao enviar pro caixa: ' + error.message); return }
    }
    setFechando(false)
    setMesaSel(null)
    await loadAll()
  }

  // ADM confere o pagamento e libera a mesa de vez (a partir do que o garçom fechou).
  async function confirmarLiberarAdm() {
    if (!comandaSel) return
    // Conta sem itens (ex.: todos removidos): não gera venda R$ 0 — cancela e libera a mesa.
    if (subtotalSel <= 0) {
      setSalvando(true)
      await supabase.from('comandas').update({ status: 'cancelada' }).eq('id', comandaSel.id)
      await supabase.from('mesas').update({ status: 'livre' }).eq('id', mesaSel.id)
      setSalvando(false)
      setMesaSel(null)
      await loadAll()
      return
    }
    const pend = comandaSel.fechamento_pendente || {}
    const lista = Array.isArray(pend.pagamentos) && pend.pagamentos.length
      ? pend.pagamentos
      : [{ forma: 'dinheiro', valor: Math.round(totalSel * 100) / 100 }]
    const aplicar = pend.aplicar_taxa ?? true
    setSalvando(true)
    const { error } = await supabase.rpc('fechar_conta_presencial', {
      p_comanda_id: comandaSel.id,
      p_pagamentos: lista,
      p_aplicar_taxa: aplicar,
    })
    setSalvando(false)
    if (error) { window.alert('Erro ao liberar a mesa: ' + error.message); return }
    setMesaSel(null)
    await loadAll()
  }

  // Só produtos que TÊM categoria entram no menu (os "sem categoria" somem).
  const produtosComCategoria = produtos.filter(p => (p.categoria ?? '').trim() !== '')

  // Lista de categorias (distintas) na MESMA ordem do catálogo (categorias.ordem).
  // Categoria sem ordem definida vai pro fim; empate desempata por nome.
  const categorias = useMemo(() => {
    const set = new Set(produtosComCategoria.map(p => p.categoria.trim()))
    const ord = (n) => { const v = ordemCat[n.toLowerCase()]; return v == null ? 9999 : v }
    return [...set].sort((a, b) => (ord(a) - ord(b)) || a.localeCompare(b, 'pt-BR'))
  }, [produtos, ordemCat]) // eslint-disable-line react-hooks/exhaustive-deps

  // O que a lista mostra:
  //  - Digitou algo → busca em TODAS as categorias, ignorando acento.
  //  - Sem busca + categoria escolhida → produtos daquela categoria.
  //  - Sem busca + nenhuma categoria → mostra as categorias (não os produtos).
  const buscaNorm = semAcento(busca)
  const produtosFiltrados = buscaNorm
    ? produtosComCategoria.filter(p => semAcento(p.nome).includes(buscaNorm)).slice(0, 40)
    : categoriaSel
      ? produtosComCategoria.filter(p => p.categoria.trim() === categoriaSel)
      : []

  if (loading) return <div className="page"><p>Carregando salão...</p></div>

  const corStatus = (mesa) => {
    const c = comandaPorMesa[mesa.id]
    if (!c) return { bg: 'rgba(34,197,94,.12)', border: '#22c55e', label: 'Livre' }
    if (c.status === 'aguardando_conferencia') return { bg: 'rgba(59,130,246,.16)', border: '#3b82f6', label: 'Aguard. ADM' }
    return { bg: 'rgba(239,68,68,.12)', border: '#ef4444', label: 'Ocupada' }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Salão</h1>
          <p className="page-subtitle">Toque numa mesa para abrir/gerenciar a comanda.</p>
        </div>
      </div>

      {mesas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          Você ainda não cadastrou mesas. <Link to="/presencial/mesas" style={{ color: 'var(--primary)' }}>Cadastrar mesas →</Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 7 }}>
          {mesas.map(mesa => {
            const c = comandaPorMesa[mesa.id]
            const cor = corStatus(mesa)
            const sub = subtotalDe(c)
            const prontos = c ? prontosDe(c) : 0
            return (
              <div key={mesa.id} role="button" tabIndex={0} onClick={() => abrirMesa(mesa)}
                onKeyDown={ev => { if (ev.key === 'Enter') abrirMesa(mesa) }}
                style={{
                  borderRadius: 9, padding: '7px 8px', cursor: 'pointer', textAlign: 'left', position: 'relative',
                  border: `1.5px solid ${prontos > 0 ? '#22c55e' : cor.border}`,
                  background: prontos > 0 ? 'rgba(34,197,94,.14)' : cor.bg,
                  color: 'var(--text)',
                  boxShadow: prontos > 0 ? '0 0 0 2px rgba(34,197,94,.25)' : 'none',
                }}>
                {prontos > 0 && (
                  <span style={{
                    position: 'absolute', top: 4, right: 4, fontSize: 9, fontWeight: 800,
                    background: '#22c55e', color: '#fff', borderRadius: 999, padding: '1px 5px',
                  }}>🔔{prontos}</span>
                )}
                <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.1 }}>{mesa.is_balcao ? '🛎️ Balcão' : `Mesa ${mesa.numero}`}</div>
                <div style={{ fontSize: 9.5, marginTop: 2, color: cor.border, fontWeight: 700 }}>{cor.label}</div>
                {c && <div style={{ fontSize: 11.5, marginTop: 1, fontWeight: 800 }}>{fmt(sub)}</div>}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Drawer da comanda ── */}
      {mesaSel && comandaSel && (
        <div onClick={sairDaMesa}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 900, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 'min(460px, 100%)', height: '100%', background: 'var(--bg)', display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--border)' }}>
            {/* header */}
            <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{mesaSel.is_balcao ? '🛎️ Balcão' : `Mesa ${mesaSel.numero}`}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mesaSel.nome || `${mesaSel.capacidade} lugares`}</div>
                {comandaSel?.garcom_id && garcons[comandaSel.garcom_id] ? (
                  <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600, marginTop: 2 }}>
                    👤 Atendido por {garcons[comandaSel.garcom_id]}
                  </div>
                ) : comandaSel && !comandaSel.garcom_id ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginTop: 2 }}>
                    📱 Pedido pelo QR (autoatendimento)
                  </div>
                ) : null}
              </div>
              <button type="button" onClick={sairDaMesa} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
            </div>

            {/* corpo */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
              {/* itens lançados */}
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Comanda</div>
              {(comandaSel.comanda_itens ?? []).length === 0 ? (
                <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Nenhum item ainda. Adicione abaixo.</p>
              ) : (
                (comandaSel.comanda_itens ?? [])
                  .slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                  .map(item => (
                    <div key={item.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 15.5, fontWeight: 700 }}>{item.nome}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span>
                              {fmt(item.preco_unitario)} · {
                                item.status === 'pronto' ? '🔔 pronto'
                                : item.status === 'entregue'
                                  ? `🍽️ entregue${item.entregue_por && garcons[item.entregue_por] ? ' por ' + garcons[item.entregue_por].split(' ')[0] : ''}`
                                : '⏳ preparando'
                              }
                            </span>
                            {item.status === 'pronto' && (
                              <button type="button" onClick={() => entregarItem(item)}
                                style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                                  border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.15)', color: '#16a34a' }}>
                                Marcar entregue
                              </button>
                            )}
                          </div>
                        </div>
                        <button type="button" onClick={() => mudarQtd(item, -1)} style={qtdBtn}>−</button>
                        <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 700 }}>{item.quantidade}</span>
                        <button type="button" onClick={() => mudarQtd(item, +1)} style={qtdBtn}>+</button>
                        {precoEdit[item.id] !== undefined ? (
                          <input
                            autoFocus type="text" inputMode="decimal"
                            value={precoEdit[item.id]}
                            onChange={e => setPrecoEdit(prev => ({ ...prev, [item.id]: e.target.value }))}
                            onBlur={() => salvarPreco(item)}
                            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') setPrecoEdit(prev => { const n = { ...prev }; delete n[item.id]; return n }) }}
                            placeholder="0,00"
                            style={{ minWidth: 70, width: 70, padding: '4px 6px', fontSize: 13, borderRadius: 6, textAlign: 'right',
                              border: '1.5px solid var(--primary)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }}
                          />
                        ) : ehAdmin ? (
                          <button type="button" title="Editar preço deste item"
                            onClick={() => setPrecoEdit(prev => ({ ...prev, [item.id]: String(item.preco_unitario).replace('.', ',') }))}
                            style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
                              border: '1px dashed var(--border)', borderRadius: 6, padding: '3px 6px', background: 'transparent', color: 'var(--text)' }}>
                            {fmt(item.preco_unitario * item.quantidade)} ✎
                          </button>
                        ) : (
                          <span style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
                            {fmt(item.preco_unitario * item.quantidade)}
                          </span>
                        )}
                      </div>
                      <input
                        value={obsEdit[item.id] !== undefined ? obsEdit[item.id] : (item.observacao ?? '')}
                        onChange={e => setObsEdit(prev => ({ ...prev, [item.id]: e.target.value }))}
                        onBlur={() => salvarObs(item)}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                        placeholder="📝 Observação (ex: sem cebola, sem gelo, ponto da carne...)"
                        style={{
                          width: '100%', marginTop: 6, padding: '8px 10px', fontSize: 14.5, fontWeight: 600,
                          borderRadius: 8, border: '1px solid var(--border)',
                          background: 'var(--input-bg, var(--bg))', color: 'var(--text)',
                        }}
                      />
                    </div>
                  ))
              )}

              {/* A enviar (rascunho) — ainda não foi pra cozinha */}
              {rascunho.length > 0 && (
                <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: '1.5px dashed var(--primary)', background: 'rgba(124,58,237,.06)' }}>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8, color: 'var(--primary)' }}>
                    🧾 A enviar — ainda não foi pra cozinha
                  </div>
                  {rascunho.map(r => (
                    <div key={r.produto_id} style={{ padding: '5px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15.5, fontWeight: 700 }}>{r.nome}</div>
                          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{fmt(r.preco_venda)}</div>
                        </div>
                        <button type="button" onClick={() => mudarQtdRascunho(r.produto_id, -1)} style={qtdBtn}>−</button>
                        <span style={{ minWidth: 20, textAlign: 'center', fontWeight: 700 }}>{r.quantidade}</span>
                        <button type="button" onClick={() => mudarQtdRascunho(r.produto_id, +1)} style={qtdBtn}>+</button>
                        <span style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>{fmt(r.preco_venda * r.quantidade)}</span>
                      </div>
                      <input
                        value={r.observacao ?? ''}
                        onChange={e => mudarObsRascunho(r.produto_id, e.target.value)}
                        placeholder="📝 Observação (ex: sem cebola, ponto da carne...)"
                        style={{
                          width: '100%', marginTop: 6, padding: '8px 10px', fontSize: 14.5, fontWeight: 600, boxSizing: 'border-box',
                          borderRadius: 8, border: '1px solid var(--border)',
                          background: 'var(--input-bg, var(--bg))', color: 'var(--text)',
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* adicionar item */}
              <div style={{ fontSize: 15, fontWeight: 700, margin: '18px 0 8px' }}>Adicionar item</div>

              {/* ── Inventar produto (item fora do catálogo) ── */}
              {!invAberto ? (
                <button type="button" onClick={() => setInvAberto(true)}
                  style={{ width: '100%', padding: '9px 0', borderRadius: 8, marginBottom: 8, cursor: 'pointer',
                    border: '1.5px dashed var(--primary)', background: 'rgba(124,58,237,.06)', color: 'var(--primary)', fontSize: 14.5, fontWeight: 700 }}>
                  ➕ Inventar produto
                </button>
              ) : (
                <div style={{ border: '1.5px solid var(--primary)', borderRadius: 10, padding: 12, marginBottom: 10, background: 'rgba(124,58,237,.05)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)' }}>➕ Inventar produto</span>
                    <button type="button" onClick={() => { setInvAberto(false); setInvNome(''); setInvPreco(''); setInvCatalogo(false); setInvCategoria('') }}
                      style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
                  </div>
                  <input value={invNome} onChange={e => setInvNome(e.target.value)} placeholder="Nome do produto"
                    style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }} />
                  {invNomeExiste && (
                    <div style={{ fontSize: 12, color: '#d97706', fontWeight: 700, marginTop: 5 }}>
                      ⚠️ Já existe um produto com esse nome.
                    </div>
                  )}
                  <input value={invPreco} onChange={e => setInvPreco(e.target.value)} type="number" step="0.01" min="0" inputMode="decimal" placeholder="Preço (ex: 12,00)"
                    style={{ width: '100%', marginTop: 8, padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }} />

                  {ehAdmin && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={invCatalogo} onChange={e => setInvCatalogo(e.target.checked)} style={{ width: 16, height: 16 }} />
                      Adicionar ao catálogo (fica salvo pras próximas vendas)
                    </label>
                  )}
                  {invCatalogo && ehAdmin && (
                    <>
                      <input list="cats-inv" value={invCategoria} onChange={e => setInvCategoria(e.target.value)} placeholder="Categoria (escolha ou digite uma nova)"
                        style={{ width: '100%', marginTop: 8, padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13, boxSizing: 'border-box' }} />
                      <datalist id="cats-inv">{categorias.map(c => <option key={c} value={c} />)}</datalist>
                    </>
                  )}

                  <button type="button" onClick={adicionarInventado} disabled={invSalvando}
                    style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 8, cursor: invSalvando ? 'wait' : 'pointer',
                      border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 13, fontWeight: 800, opacity: invSalvando ? .6 : 1 }}>
                    {invSalvando ? 'Salvando...' : (invCatalogo && ehAdmin ? 'Salvar no catálogo e adicionar' : 'Adicionar só nesta venda')}
                  </button>
                </div>
              )}

              <div style={{ position: 'relative', marginBottom: 8 }}>
                <input ref={buscaRef} value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar produto..."
                  style={{ width: '100%', padding: '10px 38px 10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', boxSizing: 'border-box', fontSize: 14.5 }} />
                {busca && (
                  <button type="button" title="Limpar" aria-label="Limpar busca"
                    onClick={() => { setBusca(''); if (buscaRef.current) buscaRef.current.focus() }}
                    style={{
                      position: 'absolute', top: '50%', right: 6, transform: 'translateY(-50%)',
                      width: 26, height: 26, borderRadius: 999, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: 'none', background: 'var(--border)', color: 'var(--text)', fontSize: 15, fontWeight: 800, lineHeight: 1,
                    }}>×</button>
                )}
              </div>
              {/* Sem busca e sem categoria escolhida: mostra as CATEGORIAS (como no cardápio). */}
              {!busca.trim() && !categoriaSel && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {categorias.map(cat => (
                    <button key={cat} type="button" onClick={() => setCategoriaSel(cat)}
                      style={{ padding: '12px 18px', borderRadius: 999, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 17.5, fontWeight: 700 }}>
                      {cat}
                    </button>
                  ))}
                  {categorias.length === 0 && <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Nenhuma categoria com produtos.</p>}
                </div>
              )}

              {/* Categoria escolhida (e sem busca): botão de voltar + produtos dela. */}
              {!busca.trim() && categoriaSel && (
                <button type="button" onClick={() => setCategoriaSel(null)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 8, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--primary)', fontSize: 14.5, fontWeight: 700 }}>
                  ← {categoriaSel}
                </button>
              )}

              {/* Produtos: quando há busca OU quando uma categoria está aberta. */}
              {(busca.trim() || categoriaSel) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {produtosFiltrados.map(p => (
                    <button key={p.produto_id} type="button" onClick={() => addItem(p)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, minHeight: 48, padding: '10px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', textAlign: 'left' }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 15.5, fontWeight: 600, lineHeight: 1.3 }}>{p.nome}</span>
                      <span style={{ flexShrink: 0, whiteSpace: 'nowrap', fontSize: 14.5, fontWeight: 700, color: 'var(--primary)' }}>+ {fmt(p.preco_venda)}</span>
                    </button>
                  ))}
                  {produtosFiltrados.length === 0 && <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Nenhum produto encontrado.</p>}
                </div>
              )}
            </div>

            {/* rodapé */}
            <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
              {comandaSel.status !== 'aguardando_conferencia' && rascunho.length > 0 && (
                <button type="button" onClick={enviarCozinha} disabled={enviando}
                  style={{ width: '100%', marginBottom: 12, padding: '12px 0', borderRadius: 10, border: 'none', cursor: enviando ? 'wait' : 'pointer',
                    background: '#16a34a', color: '#fff', fontWeight: 800, fontSize: 15, opacity: enviando ? 0.6 : 1 }}>
                  {enviando ? 'Enviando...' : `🍳 Enviar para a cozinha · ${rascunho.reduce((s, r) => s + r.quantidade, 0)} item(ns) · ${fmt(subtotalRascunho)}`}
                </button>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15.5, marginBottom: 4 }}>
                <span>Subtotal</span><strong>{fmt(subtotalSel)}</strong>
              </div>
              {comandaSel.status === 'aguardando_conferencia' ? (
                <div>
                  <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(59,130,246,.16)', color: '#2563eb', fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
                    🔵 Conta fechada pelo garçom — aguardando o ADM conferir o pagamento e liberar a mesa.
                  </div>
                  {ehAdmin ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={cancelarMesa}
                        style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                        Cancelar
                      </button>
                      {subtotalSel > 0 && (
                        <button type="button" onClick={abrirFechamento}
                          style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                          Revisar
                        </button>
                      )}
                      <button type="button" onClick={confirmarLiberarAdm} disabled={salvando}
                        className="btn btn-primary" style={{ flex: 1, marginTop: 0 }}>
                        {salvando ? 'Liberando...' : (subtotalSel <= 0 ? '✅ Liberar mesa (sem itens)' : '✅ Confirmar e liberar mesa')}
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
                      Aguardando o administrador liberar a mesa.
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={cancelarMesa}
                    style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                    Cancelar
                  </button>
                  <button type="button" onClick={abrirFechamento} disabled={subtotalSel <= 0}
                    className="btn btn-primary" style={{ flex: 1, marginTop: 0, opacity: subtotalSel <= 0 ? 0.5 : 1 }}>
                    {ehAdmin ? 'Fechar conta' : 'Fechar conta'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de fechamento ── */}
      {fechando && comandaSel && (
        <div onClick={() => setFechando(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 380, background: 'var(--bg)', borderRadius: 16, border: '1px solid var(--border)', padding: 20 }}>
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 14 }}>Fechar conta — {mesaSel.is_balcao ? 'Balcão' : `Mesa ${mesaSel.numero}`}</div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
              <span>Subtotal</span><span>{fmt(subtotalSel)}</span>
            </div>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14, padding: '4px 0', cursor: 'pointer' }}>
              <span>
                <input type="checkbox" checked={aplicarTaxa} onChange={e => setAplicarTaxa(e.target.checked)} style={{ marginRight: 8 }} />
                Taxa de serviço ({taxaPct}%)
              </span>
              <span>{fmt(taxaSel)}</span>
            </label>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 800, padding: '10px 0', borderTop: '1px dashed var(--border)', marginTop: 6 }}>
              <span>Total</span><span style={{ color: 'var(--primary)' }}>{fmt(totalSel)}</span>
            </div>

            {/* Modo: pagamento único × dividir */}
            <div style={{ display: 'flex', gap: 8, margin: '14px 0 10px' }}>
              {[['unico', 'Pagamento único'], ['dividir', 'Dividir conta']].map(([id, label]) => (
                <button key={id} type="button"
                  onClick={() => { setModoPag(id); if (id === 'dividir' && pagamentos.length === 0) dividirIgual(comandaSel.num_pessoas > 1 ? comandaSel.num_pessoas : 2) }}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                    border: `1.5px solid ${modoPag === id ? 'var(--primary)' : 'var(--border)'}`,
                    background: modoPag === id ? 'rgba(134,59,255,.1)' : 'transparent', color: 'var(--text)' }}>
                  {label}
                </button>
              ))}
            </div>

            {modoPag === 'unico' ? (
              <div style={{ display: 'flex', gap: 8 }}>
                {FORMAS.map(f => (
                  <button key={f.id} type="button" onClick={() => setForma(f.id)}
                    style={{ flex: 1, padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                      border: `1.5px solid ${forma === f.id ? 'var(--primary)' : 'var(--border)'}`,
                      background: forma === f.id ? 'rgba(134,59,255,.1)' : 'transparent', color: 'var(--text)' }}>
                    {f.label}
                  </button>
                ))}
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Pagamentos</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    rachar:
                    {[2, 3, 4].map(n => (
                      <button key={n} type="button" onClick={() => dividirIgual(n)}
                        style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>
                        {n}x
                      </button>
                    ))}
                  </span>
                </div>

                {pagamentos.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                    <select value={p.forma} onChange={e => updatePagamento(i, 'forma', e.target.value)}
                      style={{ padding: '8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }}>
                      {FORMAS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                    <input type="number" step="0.01" min="0" inputMode="decimal" value={p.valor}
                      onChange={e => updatePagamento(i, 'valor', e.target.value)} placeholder="0,00"
                      style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }} />
                    <button type="button" onClick={() => removePagamento(i)}
                      style={{ width: 30, height: 34, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)', fontSize: 16 }}>×</button>
                  </div>
                ))}

                <button type="button" onClick={addPagamento}
                  style={{ width: '100%', padding: '8px 0', borderRadius: 8, marginTop: 2, cursor: 'pointer', border: '1.5px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 13 }}>
                  + Adicionar pagamento
                </button>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 14, fontWeight: 800,
                  color: Math.abs(restante) < 0.05 ? 'var(--success)' : 'var(--danger)' }}>
                  <span>{Math.abs(restante) < 0.05 ? '✓ Fecha certinho' : restante > 0 ? 'Falta receber' : 'Passou'}</span>
                  <span>{fmt(Math.abs(restante))}</span>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setFechando(false)}
                  style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontWeight: 700 }}>
                  Voltar
                </button>
                <button type="button" onClick={imprimirConta} title="Imprimir conta"
                  style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontWeight: 700 }}>
                  🖨️ Conta
                </button>
              </div>
              <button type="button" onClick={confirmarFechamento} disabled={salvando || !podeReceber}
                className="btn btn-primary" style={{ width: '100%', marginTop: 0, opacity: (salvando || !podeReceber) ? 0.5 : 1 }}>
                {salvando ? 'Fechando...' : (ehAdmin ? `Receber ${fmt(totalSel)}` : `Fechar e enviar pro caixa · ${fmt(totalSel)}`)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const qtdBtn = {
  width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
  fontSize: 16, lineHeight: 1, flexShrink: 0,
}
