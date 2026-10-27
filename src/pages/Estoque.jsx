import { useEffect, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import LancarNotaIA from '../components/LancarNotaIA'
import '../components/Page.css'

function ItemSearch({ items, value, onChange, placeholder = 'Buscar...' }) {
  const [busca, setBusca] = useState('')
  const [aberto, setAberto] = useState(false)
  const selecionado = items.find((i) => i.id === value)
  const filtrados = busca.trim()
    ? items.filter((i) => i.nome.toLowerCase().includes(busca.toLowerCase())).slice(0, 12)
    : items.slice(0, 12)
  function handleSelect(id) { onChange(id); setBusca(''); setAberto(false) }
  const displayValue = aberto ? busca : (selecionado?.nome ?? '')
  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        placeholder={placeholder}
        value={displayValue}
        onChange={(e) => { setBusca(e.target.value); setAberto(true) }}
        onFocus={() => { setBusca(''); setAberto(true) }}
        onBlur={() => setTimeout(() => setAberto(false), 150)}
        autoComplete="off"
        style={{ width: '100%' }}
      />
      {aberto && filtrados.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
          background: 'var(--surface, #fff)', border: '1px solid var(--border)',
          borderRadius: 6, zIndex: 200, maxHeight: 220, overflowY: 'auto',
          boxShadow: '0 4px 16px rgba(0,0,0,.15)',
        }}>
          {filtrados.map((i) => (
            <div key={i.id} onMouseDown={() => handleSelect(i.id)} style={{
              padding: '8px 12px', cursor: 'pointer', fontSize: 14,
              color: 'var(--text)', borderBottom: '1px solid var(--border)',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover,rgba(0,0,0,.05))'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {i.nome}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// Figurinha da categoria do CATÁLOGO (o nome é livre em cada loja, então vai pelo jeitão do nome).
const FIGURA_PRODUTO = [
  [/retorn|ks\b|vasilhame/, '🍾'], [/cervej|chopp/, '🍺'], [/vinho|destil|dose|whisk|vodka|cacha/, '🍷'],
  [/suco/, '🧃'], [/agua|bebida|refri/, '🥤'], [/picol|sorvet|acai|gelad/, '🍦'], [/chocolat|bombom/, '🍫'],
  [/confeit|bala|chiclet|halls/, '🍬'], [/doce|sobremesa|pudim/, '🍮'], [/salgad|snack|biscoit|bolach/, '🥨'],
  [/cigarr|tabac|seda/, '🚬'], [/embalag|descart/, '📦'], [/limpez|higien/, '🧴'], [/gas\b|carvao/, '🔥'],
  [/carne|frios|acougue/, '🥩'], [/padaria|pao/, '🍞'], [/mercearia|mercad/, '🛒'],
]
const iconeProduto = (cat) => {
  const n = String(cat || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  return FIGURA_PRODUTO.find(([re]) => re.test(n))?.[1] || '📦'
}

const MOTIVOS_PADRAO = {
  entrada: ['compra', 'devolucao', 'bonificacao', 'ajuste_inventario'],
  saida: ['venda', 'perda', 'vencimento', 'consumo', 'brinde', 'ajuste_inventario'],
  // "Ajuste" não tinha motivo nenhum: a lista só ia até saída, então o campo
  // abria vazio. Aqui o motivo responde "por que a contagem não bateu".
  ajuste: ['ajuste_inventario', 'quebra', 'perda', 'erro_de_lancamento', 'sobra'],
}

export default function Estoque({ embutido = false }) {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  // Vendedor só dá entrada e baixa de imprevisto (hambúrguer caiu no chão) — a política
  // "Vendedor lanca entrada e perda" do banco já recusa o resto; a tela só oferece isso.
  const dono = profile?.perfil === 'admin'
  // Loja que não conta estoque (restaurante, lanchonete): desligado, nenhum
  // movimento é gravado (trigger da migration 0126) e a tela some daqui.
  const [usaEstoque, setUsaEstoque] = useState(true)
  // Zerou, sai do cardápio? (empresas.pausa_sem_estoque). Cada loja escolhe: tem quem prefira vender no
  // negativo e acertar depois. Ligado, o produto pausa sozinho no zero e só volta quando entra mercadoria.
  const [pausaZerado, setPausaZerado] = useState(false)
  const [salvandoPausa, setSalvandoPausa] = useState(false)
  const [salvandoUso, setSalvandoUso] = useState(false)
  const [saldo, setSaldo] = useState([])
  const [produtos, setProdutos] = useState([])
  const [clientes, setClientes] = useState([])
  const [cascoSaldo, setCascoSaldo] = useState([])
  const [custos, setCustos] = useState({})          // produto_id -> preco_custo (pro valor parado)
  const [catAberta, setCatAberta] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [showMovModal, setShowMovModal] = useState(false)
  const [movForm, setMovForm] = useState({
    produto_id: '',
    tipo: 'entrada',
    quantidade: '',
    motivo: 'compra',
    observacao: '',
  })
  const [savingMov, setSavingMov] = useState(false)

  const [showCascoModal, setShowCascoModal] = useState(false)
  const [cascoForm, setCascoForm] = useState({
    cliente_id: '',
    produto_id: '',
    tipo: 'entrega',
    quantidade: '',
    observacao: '',
  })
  const [savingCasco, setSavingCasco] = useState(false)

  const [motivos, setMotivos] = useState(MOTIVOS_PADRAO)
  const [showMotivosModal, setShowMotivosModal] = useState(false)
  const [filtroEstoque, setFiltroEstoque] = useState('todos') // todos | baixo | zerado
  // Buscar pelo nome e filtrar por categoria (pedido do usuário, 24/10/2026):
  // com 51 itens no celular — onde a coluna Categoria nem aparece — achar um
  // produto era rolar a lista inteira com o dedo.
  const [buscaEstoque, setBuscaEstoque] = useState('')
  const [motivoTab, setMotivoTab] = useState('entrada')
  const [novoMotivo, setNovoMotivo] = useState('')
  const [savingMotivo, setSavingMotivo] = useState(false)

  async function loadMotivos() {
    const { data } = await supabase.from('motivos_estoque').select('tipo, nome').order('nome')
    if (data && data.length > 0) {
      // A tabela só guarda motivo de entrada/saída; o de ajuste é fixo, então
      // preserva o padrão em vez de trocar o objeto inteiro e zerar a lista.
      setMotivos({
        entrada: data.filter(m => m.tipo === 'entrada').map(m => m.nome),
        saida: data.filter(m => m.tipo === 'saida').map(m => m.nome),
        ajuste: MOTIVOS_PADRAO.ajuste,
      })
    }
  }

  async function handleAddMotivo() {
    const nome = novoMotivo.trim().toLowerCase()
    if (!nome) return
    setSavingMotivo(true)
    await supabase.rpc('add_motivo_estoque', { p_tipo: motivoTab, p_nome: nome })
    setNovoMotivo('')
    await loadMotivos()
    setSavingMotivo(false)
  }

  async function handleDeleteMotivo(tipo, nome) {
    await supabase.from('motivos_estoque').delete().eq('tipo', tipo).eq('nome', nome)
    await loadMotivos()
  }

  async function carregarUsoEstoque() {
    if (!empresaId) return
    const { data } = await supabase.from('empresas').select('estoque_ativo, pausa_sem_estoque').eq('id', empresaId).single()
    if (data) { setUsaEstoque(data.estoque_ativo ?? true); setPausaZerado(!!data.pausa_sem_estoque) }
  }

  async function alternarUsoEstoque() {
    if (!empresaId || salvandoUso) return
    const novo = !usaEstoque
    setSalvandoUso(true)
    const { error: err } = await supabase.from('empresas').update({ estoque_ativo: novo }).eq('id', empresaId)
    setSalvandoUso(false)
    if (err) { setError(err.message); return }
    setUsaEstoque(novo)
    setError(null)
    if (novo) loadAll()
  }

  async function alternarPausaZerado() {
    if (!empresaId || salvandoPausa) return
    const novo = !pausaZerado
    if (!window.confirm(novo
      ? 'Pausar produto quando o estoque zerar?\n\nO que chegar a zero sai do cardápio sozinho (balcão, mesa, app, Loja Online e iFood) e só volta quando entrar mercadoria.'
      : 'Vender mesmo com estoque zerado?\n\nO estoque pode ficar negativo. Os produtos que estão pausados por falta de estoque voltam a vender agora.')) return
    setSalvandoPausa(true)
    const { error: err } = await supabase.from('empresas').update({ pausa_sem_estoque: novo }).eq('id', empresaId)
    // Desligou: quem estava fora do cardápio SÓ por estoque volta a vender.
    if (!err && !novo) {
      await supabase.from('produtos').update({ ativo: true, disponivel_delivery: true, pausado_por_estoque: false })
        .eq('empresa_id', empresaId).eq('pausado_por_estoque', true)
    }
    setSalvandoPausa(false)
    if (err) { setError(err.message); return }
    setPausaZerado(novo)
    loadAll()
  }

  async function loadAll() {
    setLoading(true)
    setError(null)

    const [saldoRes, produtosRes, clientesRes, cascoRes, custoRes] = await Promise.all([
      // fetchAll: loja grande passa de 1000 linhas e o resto sumia da tela sem aviso.
      fetchAll(() => supabase.from('estoque_saldo').select('*').order('nome').order('produto_id')),
      supabase
        .from('produtos')
        .select('id, nome, controla_casco')
        .eq('ativo', true)
        .order('nome'),
      supabase.from('clientes').select('id, nome').eq('ativo', true).order('nome'),
      supabase.from('casco_saldo').select('*').order('cliente_nome'),
      empresaId
        ? fetchAll(() => supabase.from('produtos').select('id, preco_custo').eq('empresa_id', empresaId).eq('controla_estoque', true).order('id'))
        : Promise.resolve({ data: [] }),
    ])

    const firstError =
      saldoRes.error || produtosRes.error || clientesRes.error || cascoRes.error
    if (firstError) setError(firstError.message)

    setSaldo(saldoRes.data ?? [])
    setProdutos(produtosRes.data ?? [])
    setClientes(clientesRes.data ?? [])
    setCascoSaldo((cascoRes.data ?? []).filter((c) => c.saldo_cascos !== 0))
    setCustos(Object.fromEntries((custoRes.data ?? []).map((p) => [p.id, p.preco_custo])))

    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    loadMotivos()
  }, [empresaId])

  useEffect(() => { carregarUsoEstoque() }, [empresaId])

  function openMovModal() {
    setMovForm({
      produto_id: produtos[0]?.id ?? '',
      tipo: 'entrada',
      quantidade: '',
      motivo: 'compra',
      observacao: '',
      valor_pago: '',
    })
    setShowMovModal(true)
  }

  // Preço por unidade da entrada que está sendo digitada (pago ÷ quantidade).
  const movUnitEstoque = (() => {
    const qtd = Number(String(movForm.quantidade ?? '').replace(',', '.'))
    const pago = Number(String(movForm.valor_pago ?? '').replace(',', '.'))
    return qtd > 0 && pago > 0 ? pago / qtd : null
  })()

  function handleMovChange(e) {
    const { name, value } = e.target
    setMovForm((prev) => {
      const next = { ...prev, [name]: value }
      if (name === 'tipo') {
        next.motivo = !dono && value === 'saida' ? 'imprevisto' : (motivos[value] ?? MOTIVOS_PADRAO[value] ?? [])[0] ?? ''
      }
      return next
    })
  }

  // Saldo que a tela mostra hoje pro produto escolhido (base do ajuste).
  function saldoDoProduto(produtoId) {
    const linha = saldo.find((s) => s.produto_id === produtoId)
    return Number(linha?.quantidade_atual ?? 0)
  }

  // "Saldo por produto" só lista quem tem o CONTROLE DE ESTOQUE ligado no catálogo.
  // Produto sem controle (self-service, prato na hora) não faz sentido aparecer aqui.
  const saldoControlado = saldo.filter((s) => s.controla_estoque !== false)

  // Situação de cada produto, numa regra só — a tabela e o filtro leem daqui,
  // senão um dia a etiqueta diz uma coisa e o filtro mostra outra.
  const situacaoDe = (s) => {
    if (Number(s.quantidade_atual) <= 0) return 'zerado'
    if (Number(s.estoque_minimo) > 0 && Number(s.quantidade_atual) <= Number(s.estoque_minimo)) return 'baixo'
    return 'ok'
  }
  const nZerado = saldoControlado.filter((s) => situacaoDe(s) === 'zerado').length
  const nBaixo = saldoControlado.filter((s) => situacaoDe(s) === 'baixo').length

  // Sem acento e sem caixa: quem digita "agua" tem que achar "Água com Gás".
  const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const termoEstoque = semAcento(buscaEstoque).trim()

  const saldoFiltrado = saldoControlado.filter((s) => {
    if (filtroEstoque !== 'todos' && situacaoDe(s) !== filtroEstoque) return false
    // A busca olha o nome E a categoria: digitar "cerveja" acha o que está
    // naquela prateleira, mesmo sem saber o nome exato da marca.
    if (termoEstoque && !semAcento(`${s.nome} ${s.categoria ?? ''}`).includes(termoEstoque)) return false
    return true
  })

  // Cartões por categoria, igual às matérias-primas (pedido do Wilde, 27/10/2026): subtotal em R$ (saldo ×
  // custo), % do estoque e quantos estão baixos/zerados. O total parado fica em cima.
  const custoDe = (id) => Number(custos[id] || 0)
  const valorDe = (s) => Math.max(0, Number(s.quantidade_atual || 0)) * custoDe(s.produto_id)
  const totalProdutos = saldoControlado.reduce((t, s) => t + valorDe(s), 0)
  const gruposProdutos = (() => {
    const mapa = new Map()
    for (const s of saldoFiltrado) {
      const cat = s.categoria && s.categoria !== 'outros' ? s.categoria : 'Sem categoria'
      if (!mapa.has(cat)) mapa.set(cat, { cat, itens: [], total: 0, alerta: 0 })
      const g = mapa.get(cat)
      g.itens.push(s)
      g.total += valorDe(s)
      if (situacaoDe(s) !== 'ok') g.alerta++
    }
    return [...mapa.values()].sort((a, b) => b.total - a.total || a.cat.localeCompare(b.cat, 'pt-BR'))
  })()

  async function handleMovSubmit(e) {
    e.preventDefault()
    setSavingMov(true)
    setError(null)

    // Ajuste é contagem, não soma: o dono digita o que TEM na prateleira e a
    // gente grava só a diferença. Antes o "ajuste" entrava somando igualzinho a
    // uma entrada — quem contava 10 e digitava 10 ficava com 20.
    let linha
    if (movForm.tipo === 'ajuste') {
      const contado = Number(movForm.quantidade)
      const diferenca = contado - saldoDoProduto(movForm.produto_id)
      if (diferenca === 0) {
        setSavingMov(false)
        setShowMovModal(false)
        return
      }
      linha = {
        produto_id: movForm.produto_id,
        tipo: diferenca > 0 ? 'entrada' : 'saida',
        quantidade: Math.abs(diferenca),
        motivo: movForm.motivo || 'ajuste_inventario',
        observacao: movForm.observacao || `Ajuste de inventário: contado ${contado}`,
      }
    } else {
      linha = {
        produto_id: movForm.produto_id,
        tipo: movForm.tipo,
        quantidade: Number(movForm.quantidade),
        motivo: movForm.motivo,
        observacao: movForm.observacao || null,
        custo_unit: movUnitEstoque,
        valor_total: movUnitEstoque != null ? Number(String(movForm.valor_pago).replace(',', '.')) : null,
      }
    }

    const { error } = await supabase.from('estoque_movimentos').insert(linha)

    setSavingMov(false)

    if (error) {
      setError(error.message)
      return
    }

    setShowMovModal(false)
    loadAll()
  }

  function openCascoModal() {
    setCascoForm({
      cliente_id: clientes[0]?.id ?? '',
      produto_id: produtos.find((p) => p.controla_casco)?.id ?? '',
      tipo: 'entrega',
      quantidade: '',
      observacao: '',
    })
    setShowCascoModal(true)
  }

  function handleCascoChange(e) {
    const { name, value } = e.target
    setCascoForm((prev) => ({ ...prev, [name]: value }))
  }

  async function handleCascoSubmit(e) {
    e.preventDefault()
    setSavingCasco(true)
    setError(null)

    const { error } = await supabase.from('casco_movimentos').insert({
      cliente_id: cascoForm.cliente_id,
      produto_id: cascoForm.produto_id,
      tipo: cascoForm.tipo,
      quantidade: Number(cascoForm.quantidade),
      observacao: cascoForm.observacao || null,
    })

    setSavingCasco(false)

    if (error) {
      setError(error.message)
      return
    }

    setShowCascoModal(false)
    loadAll()
  }

  const produtosComCasco = produtos.filter((p) => p.controla_casco)
  // Casco (vasilhame que volta) é coisa de distribuidora de bebida: o cliente
  // leva a garrafa e devolve depois. Restaurante não tem isso, e a seção só
  // ocupava espaço. Só aparece pra quem marcou "controla casco" em algum
  // produto — ou pra quem ainda tem casco pendente de antes.
  const usaCasco = produtosComCasco.length > 0 || cascoSaldo.length > 0

  return (
    <div>
      <div className="page-header" style={embutido ? { justifyContent: 'flex-end' } : undefined}>
        {!embutido && <h1>Estoque</h1>}
        {/* `flexWrap`: o .page-header ja quebra linha, mas esta caixa nao quebrava
            - ela segurava os quatro botoes numa fileira so e ESTICAVA a pagina.
            No celular dava pra rolar a tela inteira pro lado e cair num vazio,
            com a tabela ficando pra tras (16/10/2026). */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {dono && (
            <button
              className={`btn ${usaEstoque ? 'btn-secondary' : 'btn-primary'}`}
              onClick={alternarUsoEstoque}
              disabled={salvandoUso}
              title={usaEstoque
                ? 'Desligar o controle de estoque desta loja'
                : 'Voltar a controlar estoque nesta loja'}
            >
              {salvandoUso ? 'Salvando...' : usaEstoque ? '🚫 Não trabalho com estoque' : '📦 Voltar a usar estoque'}
            </button>
          )}
          {usaEstoque && (
            <>
              {dono && (
                <>
                  <button className="btn btn-secondary" onClick={alternarPausaZerado} disabled={salvandoPausa}
                    title={pausaZerado ? 'Hoje: zerou, sai do cardápio. Clique pra deixar vender no negativo.' : 'Hoje: vende mesmo zerado (fica negativo). Clique pra pausar no zero.'}>
                    {salvandoPausa ? 'Salvando...' : pausaZerado ? '⏸ Zerou, pausa: SIM' : '➖ Zerou, pausa: NÃO'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setShowMotivosModal(true)}>
                    Motivos
                  </button>
                </>
              )}
              {usaCasco && (
                <button className="btn btn-secondary" onClick={openCascoModal}>
                  + Movimento de casco
                </button>
              )}
              {/* Dentro do Estoque a nota se lança na aba "Lançar compra" (a única porta com valor). */}
              {!embutido && <LancarNotaIA empresaId={empresaId} onDone={loadAll} />}
              <button className="btn btn-primary" onClick={openMovModal}>
                + Movimento de estoque
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* Loja sem estoque: nada de tabela zerada e "estoque baixo" em tudo. */}
      {!usaEstoque && (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>🚫📦</div>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>
            Esta loja não trabalha com estoque
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 auto', maxWidth: 460 }}>
            As vendas não descontam mais nada e você não recebe alerta de estoque baixo.
            Os produtos continuam normais no cardápio e no gestor — só o controle de quantidade
            fica desligado. É só clicar em <strong>Voltar a usar estoque</strong> pra ligar de novo.
          </p>
        </div>
      )}

      {usaEstoque && (<>
      <div className="card" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', border: '2px solid var(--primary)', backgroundImage: 'linear-gradient(rgba(124,58,237,.08), rgba(124,58,237,.08))' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: 1 }}>💰 Total parado em produtos</span>
        <strong style={{ fontSize: 24, color: 'var(--primary)' }}>{brl(totalProdutos)}</strong>
      </div>
      {/* Filtro: numa conveniência a lista passa de cem itens e o dono abre a
          tela pra saber UMA coisa — o que precisa comprar hoje. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {[
          { id: 'todos', rotulo: 'Todos', n: saldoControlado.length, cor: 'var(--primary)' },
          { id: 'baixo', rotulo: 'Estoque baixo', n: nBaixo, cor: '#d97706' },
          { id: 'zerado', rotulo: 'Sem estoque', n: nZerado, cor: '#dc2626' },
        ].map((f) => {
          const ativo = filtroEstoque === f.id
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFiltroEstoque(f.id)}
              style={{
                padding: '7px 12px', borderRadius: 999, cursor: 'pointer',
                fontSize: 13, fontWeight: 700, border: '1.5px solid',
                borderColor: ativo ? f.cor : 'var(--border)',
                background: ativo ? f.cor : 'transparent',
                color: ativo ? '#fff' : 'var(--text-muted)',
              }}
            >
              {f.rotulo} ({f.n})
            </button>
          )
        })}
      </div>
      {/* Buscar e filtrar por categoria. No celular a coluna Categoria some da
          tabela, então sem isto o dono rolava 51 linhas pra achar um item. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          type="search"
          value={buscaEstoque}
          onChange={(e) => setBuscaEstoque(e.target.value)}
          placeholder="🔎 Buscar produto..."
          aria-label="Buscar produto no estoque"
          style={{
            flex: '1 1 180px', minWidth: 0, padding: '9px 12px', borderRadius: 10,
            border: '1.5px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontSize: 14,
          }}
        />
      </div>
      {termoEstoque && (
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '-4px 0 10px' }}>
          Mostrando <strong>{saldoFiltrado.length}</strong> de {saldoControlado.length} produtos.{' '}
          <button type="button" onClick={() => setBuscaEstoque('')}
            style={{ border: 0, background: 'transparent', color: 'var(--primary)', cursor: 'pointer', font: 'inherit', fontWeight: 700, padding: 0 }}>
            limpar
          </button>
        </p>
      )}
      <div style={{ marginBottom: 24 }}>
        {loading ? (
          <div className="card empty-state">Carregando...</div>
        ) : saldoControlado.length === 0 ? (
          <div className="card empty-state">Nenhum produto com controle de estoque. Ligue o "Controla estoque" no produto (Catálogo) pra ele aparecer aqui.</div>
        ) : gruposProdutos.length === 0 ? (
          <div className="card empty-state">
            {termoEstoque
              ? `Nenhum produto com "${buscaEstoque.trim()}".`
              : filtroEstoque === 'baixo'
                ? 'Nenhum produto no mínimo. Está tudo abastecido.'
                : 'Nenhum produto zerado.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {gruposProdutos.map((g) => {
              // Buscando ou filtrando = abre tudo que achou; senão respeita o toque dele.
              const aberto = !!termoEstoque || filtroEstoque !== 'todos' || catAberta.has(g.cat)
              const pct = totalProdutos > 0 ? Math.round((g.total / totalProdutos) * 100) : 0
              return (
                <div key={g.cat} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <button type="button" aria-expanded={aberto}
                    onClick={() => setCatAberta((s) => { const n = new Set(s); n.has(g.cat) ? n.delete(g.cat) : n.add(g.cat); return n })}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px', border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontSize: 24 }}>{iconeProduto(g.cat)}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 800, fontSize: 15 }}>{g.cat}</span>
                      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-muted)' }}>
                        {g.itens.length} {g.itens.length === 1 ? 'item' : 'itens'}
                        {g.alerta > 0 && <b style={{ color: 'var(--danger, #dc2626)', marginLeft: 8 }}>⚠️ {g.alerta} pra repor</b>}
                      </span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <strong style={{ display: 'block', fontSize: 17 }}>{brl(g.total)}</strong>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{pct}% do estoque</span>
                    </span>
                    <span style={{ fontSize: 14, color: 'var(--text-muted)', width: 14 }}>{aberto ? '▾' : '▸'}</span>
                  </button>
                  {aberto && (
                    <div style={{ borderTop: '1px solid var(--border)' }}>
                      {g.itens.map((s) => {
                        const sit = situacaoDe(s)
                        const qtd = Number(s.quantidade_atual || 0)
                        const custo = custoDe(s.produto_id)
                        return (
                          <div key={s.produto_id} style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)',
                            ...(sit === 'zerado' ? { background: 'rgba(220,38,38,.05)', boxShadow: 'inset 3px 0 0 #dc2626' } : sit === 'baixo' ? { boxShadow: 'inset 3px 0 0 #f59e0b' } : {}) }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
                              <span style={{ fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>{s.nome}</span>
                              <strong style={{ whiteSpace: 'nowrap' }}>{custo > 0 ? brl(valorDe(s)) : '—'}</strong>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 3, fontSize: 13.5 }}>
                              <span style={{ fontWeight: 700, color: qtd < 0 ? 'var(--danger)' : 'var(--text)' }}>{qtd.toLocaleString('pt-BR')} un</span>
                              <span style={{ color: 'var(--text-muted)' }}>
                                {custo > 0 ? `· ${brl(custo)} / un` : <span style={{ color: '#b45309' }}>· sem custo</span>}
                                {Number(s.estoque_minimo) > 0 && ` · mín. ${s.estoque_minimo}`}
                              </span>
                              {sit !== 'ok' && (
                                <span style={{ padding: '2px 7px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
                                  background: sit === 'zerado' ? 'rgba(220,38,38,.12)' : 'rgba(245,158,11,.15)', color: sit === 'zerado' ? 'var(--danger, #dc2626)' : '#b45309' }}>
                                  {sit === 'zerado' ? '⚠️ sem estoque' : '⚠️ baixo'}
                                </span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      </>)}

      {usaEstoque && usaCasco && (<>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>
        Vasilhame (casco) pendente com clientes
      </h2>
      <div className="data-table tabela-estoque">
        {loading ? (
          <div className="empty-state">Carregando...</div>
        ) : cascoSaldo.length === 0 ? (
          <div className="empty-state">Nenhum casco pendente.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Produto</th>
                <th>Saldo de cascos</th>
              </tr>
            </thead>
            <tbody>
              {cascoSaldo.map((c) => (
                <tr key={`${c.cliente_id}-${c.produto_id}`}>
                  <td>{c.cliente_nome}</td>
                  <td>{c.produto_nome}</td>
                  <td>
                    <span
                      className={`badge ${
                        c.saldo_cascos > 0 ? 'badge-warning' : 'badge-success'
                      }`}
                    >
                      {c.saldo_cascos}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </>)}

      {showMovModal && (
        <div className="modal-overlay" onClick={() => setShowMovModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Novo movimento de estoque</h2>
            <form onSubmit={handleMovSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Produto</label>
                  <ItemSearch
                    items={produtos}
                    value={movForm.produto_id}
                    onChange={(id) => setMovForm((p) => ({ ...p, produto_id: id }))}
                    placeholder="Buscar produto..."
                  />
                </div>

                <div className="form-field">
                  <label>Tipo</label>
                  <select name="tipo" value={movForm.tipo} onChange={handleMovChange}>
                    <option value="entrada">Entrada</option>
                    <option value="saida">{dono ? 'Saída' : 'Saída por imprevisto'}</option>
                    {dono && <option value="ajuste">Ajuste</option>}
                  </select>
                </div>

                <div className="form-field">
                  <label>Motivo</label>
                  {!dono && movForm.tipo === 'saida' ? (
                    <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                      ⚠️ Imprevisto: caiu no chão, quebrou, estragou. Escreva o que foi na observação.
                    </span>
                  ) : (
                    <select
                      name="motivo"
                      value={movForm.motivo}
                      onChange={handleMovChange}
                    >
                      {(motivos[movForm.tipo] ?? MOTIVOS_PADRAO[movForm.tipo] ?? []).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="form-field">
                  <label>
                    {movForm.tipo === 'ajuste' ? 'Quantidade contada' : 'Quantidade'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    name="quantidade"
                    value={movForm.quantidade}
                    onChange={handleMovChange}
                    required
                  />
                  {movForm.tipo === 'ajuste' && movForm.produto_id && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Digite quanto tem de verdade na prateleira. O sistema tem{' '}
                      <strong>{saldoDoProduto(movForm.produto_id)}</strong> e grava só a diferença.
                    </span>
                  )}
                </div>

                {/* Compra: o valor pago fica gravado na linha, pro histórico de
                    compras saber quanto se gastou no dia. */}
                {movForm.tipo === 'entrada' && (
                  <div className="form-field">
                    <label>Quanto pagou no total (R$) — opcional</label>
                    <input
                      inputMode="decimal"
                      name="valor_pago"
                      placeholder="Ex.: 120,00"
                      value={movForm.valor_pago}
                      onChange={handleMovChange}
                    />
                    {movUnitEstoque != null && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Sai a <strong>R$ {movUnitEstoque.toFixed(2)}</strong> a unidade.
                      </span>
                    )}
                  </div>
                )}

                <div className="form-field full">
                  <label>Observação</label>
                  <input
                    name="observacao"
                    value={movForm.observacao}
                    onChange={handleMovChange}
                  />
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowMovModal(false)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingMov}>
                  {savingMov ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showMotivosModal && (
        <div className="modal-overlay" onClick={() => setShowMotivosModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h2>Motivos de movimentação</h2>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {['entrada', 'saida'].map(t => (
                <button
                  key={t}
                  className={`btn btn-sm ${motivoTab === t ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => { setMotivoTab(t); setNovoMotivo('') }}
                >
                  {t === 'entrada' ? 'Entrada' : 'Saída'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <input
                value={novoMotivo}
                onChange={(e) => setNovoMotivo(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddMotivo())}
                placeholder={`Novo motivo de ${motivoTab === 'entrada' ? 'entrada' : 'saída'}...`}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary btn-sm" onClick={handleAddMotivo} disabled={savingMotivo || !novoMotivo.trim()}>
                + Adicionar
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(motivos[motivoTab] ?? []).map((m) => (
                <div key={m} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-hover, rgba(0,0,0,.04))', borderRadius: 6 }}>
                  <span style={{ fontSize: 14 }}>{m}</span>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteMotivo(motivoTab, m)}>
                    Remover
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowMotivosModal(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}

      {showCascoModal && (
        <div className="modal-overlay" onClick={() => setShowCascoModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Novo movimento de casco</h2>
            <form onSubmit={handleCascoSubmit}>
              <div className="form-grid">
                <div className="form-field full">
                  <label>Cliente</label>
                  <select
                    name="cliente_id"
                    value={cascoForm.cliente_id}
                    onChange={handleCascoChange}
                    required
                  >
                    {clientes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field full">
                  <label>Produto (com controle de casco)</label>
                  <select
                    name="produto_id"
                    value={cascoForm.produto_id}
                    onChange={handleCascoChange}
                    required
                  >
                    {produtosComCasco.length === 0 && (
                      <option value="">Nenhum produto com controle de casco</option>
                    )}
                    {produtosComCasco.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-field">
                  <label>Tipo</label>
                  <select
                    name="tipo"
                    value={cascoForm.tipo}
                    onChange={handleCascoChange}
                  >
                    <option value="entrega">Entrega ao cliente</option>
                    <option value="devolucao">Devolução do cliente</option>
                  </select>
                </div>

                <div className="form-field">
                  <label>Quantidade</label>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    name="quantidade"
                    value={cascoForm.quantidade}
                    onChange={handleCascoChange}
                    required
                  />
                </div>

                <div className="form-field full">
                  <label>Observação</label>
                  <input
                    name="observacao"
                    value={cascoForm.observacao}
                    onChange={handleCascoChange}
                  />
                </div>
              </div>

              {error && <p className="error-text">{error}</p>}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCascoModal(false)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={savingCasco || produtosComCasco.length === 0}
                >
                  {savingCasco ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
