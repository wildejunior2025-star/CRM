import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { cobraPeloMaior } from '../lib/complementos'
import { capturarIndicacao, registrarIndicacao } from '../lib/indicacao'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../context/BrandingContext'
import { getEnderecoAtivo } from '../utils/enderecoPortal'
import { formasAtivas, repassePct } from '../lib/constants'
import './PortalLoja.css'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'

// A janela de escolher sabores, borda e outros complementos é a MESMA da Loja Online (um
// pizza "monte a sua" só existe por ela). Carrega sob demanda pra não pesar a vitrine.
const OptionsModal = lazy(() => import('./DeliveryLoja').then(m => ({ default: m.OptionsModal })))

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function geocodificar(endereco) {
  try {
    const q = encodeURIComponent(`${endereco}, Brasil`)
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { 'User-Agent': 'CRM-FWC/1.0' }
    })
    const data = await res.json()
    if (data?.[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  } catch { /* ignora */ }
  return null
}

// ── Tela de pagamento PIX ─────────────────────────────────────
function PixScreen({ pixData, onConcluido }) {
  const EXPIRA_MS = 30 * 60 * 1000
  const [copiado, setCopiado] = useState(false)
  const [pago, setPago] = useState(false)
  const [restante, setRestante] = useState(
    Math.max(0, EXPIRA_MS - (Date.now() - new Date(pixData.expires_at).getTime() + EXPIRA_MS))
  )

  // Timer de expiração
  useEffect(() => {
    if (restante <= 0) return
    const id = setTimeout(() => setRestante(t => Math.max(0, t - 1000)), 1000)
    return () => clearTimeout(id)
  }, [restante])

  // Realtime: quando pedido for pago (status → aguardando), mostra sucesso
  useEffect(() => {
    const ch = supabase
      .channel(`pix_order_${pixData.order_id}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'pedidos_delivery',
        filter: `id=eq.${pixData.order_id}`,
      }, payload => {
        if (payload.new.status === 'aguardando') setPago(true)
      })
      .subscribe()
    // Polling de fallback a cada 5s
    const poll = setInterval(async () => {
      const { data } = await supabase
        .from('pedidos_delivery').select('status').eq('id', pixData.order_id).single()
      if (data?.status === 'aguardando') { setPago(true); clearInterval(poll) }
    }, 5000)
    return () => { supabase.removeChannel(ch); clearInterval(poll) }
  }, [pixData.order_id])

  function copiar() {
    navigator.clipboard.writeText(pixData.qr_code).then(() => {
      setCopiado(true)
      setTimeout(() => setCopiado(false), 3000)
    })
  }

  const m = String(Math.floor(restante / 60000)).padStart(2, '0')
  const s = String(Math.floor((restante % 60000) / 1000)).padStart(2, '0')

  if (pago) return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 200,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 24, gap: 16, textAlign: 'center',
    }}>
      <div style={{ fontSize: 64 }}>✅</div>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Pagamento confirmado!</h2>
      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 15 }}>
        Seu pedido foi enviado para a loja. Aguarde a confirmação.
      </p>
      <button className="loja-btn-confirmar" style={{ marginTop: 8 }} onClick={onConcluido}>
        Ver meus pedidos
      </button>
    </div>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 200,
      display: 'flex', flexDirection: 'column', overflowY: 'auto',
    }}>
      <div style={{ maxWidth: 420, margin: '0 auto', width: '100%', padding: '28px 20px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800 }}>Pague via Pix</h2>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14 }}>
            Escaneie o QR code ou copie o código
          </p>
        </div>

        {/* QR Code */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ padding: 12, background: '#fff', borderRadius: 16, display: 'inline-block' }}>
            <img
              src={`data:image/png;base64,${pixData.qr_code_base64}`}
              alt="QR Code PIX"
              style={{ width: 220, height: 220, display: 'block' }}
            />
          </div>
        </div>

        {/* Timer */}
        <div style={{ textAlign: 'center' }}>
          <span style={{
            fontSize: 13, color: restante < 5 * 60 * 1000 ? '#ef4444' : 'var(--text-muted)',
            fontWeight: 600,
          }}>
            {restante > 0 ? `Expira em ${m}:${s}` : 'QR Code expirado — refaça o pedido'}
          </span>
        </div>

        {/* Copia e Cola */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
            Pix Copia e Cola
          </p>
          <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-all', lineHeight: 1.5 }}>
            {pixData.qr_code.slice(0, 60)}…
          </p>
          <button
            className="loja-btn-confirmar"
            style={{ margin: 0, background: copiado ? '#16a34a' : undefined }}
            onClick={copiar}
          >
            {copiado ? '✓ Código copiado!' : 'Copiar código Pix'}
          </button>
        </div>

        {/* Aguardando */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
          background: 'rgba(59,130,246,.08)', border: '1px solid rgba(59,130,246,.2)',
          borderRadius: 10, fontSize: 13, color: '#2563eb',
        }}>
          <span style={{
            width: 14, height: 14, border: '2px solid #93c5fd', borderTopColor: '#2563eb',
            borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0,
          }} />
          Aguardando confirmação do pagamento...
        </div>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
          Após pagar, aguarde alguns segundos. Você será redirecionado automaticamente.
        </p>
      </div>
    </div>
  )
}

export default function PortalLoja() {
  const categoriasOcultas = useRef(new Set())
  // Quantos itens já vieram do servidor (inclui os de categoria oculta, que não vão pra tela).
  const [lidos, setLidos] = useState(0)
  const { empresaId } = useParams()
  const navigate = useNavigate()
  useAuth()
  const { empresaParceira } = useBranding()
  const dominioExclusivo = !!empresaParceira

  const SACOLA_KEY = `sacola_portal_${empresaId}`

  const [empresa, setEmpresa] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [catOrdem, setCatOrdem] = useState({}) // { nomeCategoria: ordem do cardápio }
  const [totalProdutos, setTotalProdutos] = useState(0)
  const [carregandoMais, setCarregandoMais] = useState(false)
  const [carrinho, setCarrinho] = useState(() => {
    try {
      const saved = localStorage.getItem(`sacola_portal_${empresaId}`)
      return saved ? JSON.parse(saved) : {}
    } catch { return {} /* localStorage indisponível */ }
  })
  // Itens MONTADOS (pizza com sabores e borda...): cada combinação escolhida é uma linha, com o
  // preço já fechado e os complementos. Os produtos simples seguem em `carrinho` (id → quantidade).
  const COMBOS_KEY = `combos_portal_${empresaId}`
  const [combos, setCombos] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`combos_portal_${empresaId}`) || '{}') || {} } catch { return {} }
  })
  const [complementosPorProduto, setComplementosPorProduto] = useState({}) // { produto_id: grupos[] }
  const [optProduto, setOptProduto] = useState(null) // produto aberto na janela de escolha
  const [complementosFalhou, setComplementosFalhou] = useState(false)
  // Categoria que está na tela agora (só destaque na barra; tocar nela rola até lá, não filtra)
  const [categoriaAtiva, setCategoriaAtiva] = useState('')
  const barraCatRef = useRef(null)
  const [busca, setBusca] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [enviando, setEnviando] = useState(false)
  const [carrinhoAberto, setCarrinhoAberto] = useState(false)
  const [checkoutAberto, setCheckoutAberto] = useState(false)
  const [clienteProfile, setClienteProfile] = useState(null)
  const [form, setForm] = useState({
    nome: '', telefone: '', cep: '', rua: '', numero: '',
    complemento: '', bairro: '', cidade: '',
    forma: 'pix', troco: '', obs: '',
    tipo_entrega: 'entrega',
  })
  // A loja pode desligar "Retirar na loja" nas configurações (Raio de entrega).
  // Enquanto a empresa não carregou, deixa aparecer — a maioria tem ligado.
  const permiteRetirada = empresa ? empresa.aceita_retirada !== false : true
  // Loja só de retirada (Branka, Lá em Casa, O Braseiro...) não oferece entrega.
  const permiteEntrega = empresa ? empresa.aceita_entrega !== false : true
  useEffect(() => {
    if (!permiteRetirada && form.tipo_entrega === 'retirada') {
      setForm(p => ({ ...p, tipo_entrega: 'entrega' }))
    } else if (!permiteEntrega && permiteRetirada && form.tipo_entrega === 'entrega') {
      setForm(p => ({ ...p, tipo_entrega: 'retirada' }))
    }
  }, [permiteRetirada, permiteEntrega, form.tipo_entrega])

  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep, setErroCep] = useState(null)
  const [pixData, setPixData] = useState(null)
  const [taxaCalculada, setTaxaCalculada]   = useState(null)  // null = ainda não calculada por km
  const [pinCliente, setPinCliente]         = useState(null)  // { lat, lng, rua }: ponto da casa marcado no mapa
  const [tempoCalculado, setTempoCalculado] = useState(null)  // tempo estimado pela faixa

  // Saldo de pontos (desconto nas compras)
  const [saldoPontos, setSaldoPontos] = useState(0)
  const [valorPonto, setValorPonto]   = useState(0.02)
  const [minResgate, setMinResgate]   = useState(100)
  const [usarSaldo, setUsarSaldo]     = useState(false)

  /* ── Chegou por indicação? Guarda quem mandou (mig 0176) ── */
  useEffect(() => { capturarIndicacao() }, [])

  /* ── Persistir carrinho no localStorage ── */
  useEffect(() => {
    try {
      if (Object.keys(carrinho).length === 0) {
        localStorage.removeItem(SACOLA_KEY)
      } else {
        localStorage.setItem(SACOLA_KEY, JSON.stringify(carrinho))
      }
      window.dispatchEvent(new CustomEvent('carrinho-portal-changed'))
    } catch { /* localStorage indisponível (modo privado restrito) */ }
  }, [carrinho, SACOLA_KEY])

  /* ── Persistir os itens montados ── */
  useEffect(() => {
    try {
      if (Object.keys(combos).length === 0) {
        localStorage.removeItem(COMBOS_KEY)
      } else {
        localStorage.setItem(COMBOS_KEY, JSON.stringify(combos))
      }
      window.dispatchEvent(new CustomEvent('carrinho-portal-changed'))
    } catch { /* localStorage indisponível */ }
  }, [combos, COMBOS_KEY])

  /* ── Item montado de produto que saiu do cardápio some da sacola (só depois de ler tudo) ── */
  useEffect(() => {
    if (produtos.length === 0 || lidos < totalProdutos) return
    const ids = new Set(produtos.map(p => String(p.produto_id)))
    setCombos(prev => {
      const limpo = {}
      for (const [k, c] of Object.entries(prev)) if (ids.has(String(c.id))) limpo[k] = c
      return Object.keys(limpo).length === Object.keys(prev).length ? prev : limpo
    })
  }, [produtos, lidos, totalProdutos])

  /* ── Sanitizar carrinho após produtos carregarem (remove IDs obsoletos) ── */
  useEffect(() => {
    if (produtos.length === 0) return
    const idsValidos = new Set(produtos.map(p => String(p.produto_id)))
    setCarrinho(prev => {
      const limpo = {}
      for (const [id, qtd] of Object.entries(prev)) {
        if (idsValidos.has(String(id))) limpo[id] = qtd
      }
      return limpo
    })
  }, [produtos])

  useEffect(() => {
    if (!empresaId) return
    async function load() {
      setLoading(true)
      // Aceita tanto slug (ex: "deposito-da-gaby") quanto UUID
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(empresaId)
      const baseQuery = supabase
        .from('empresas')
        .select('id, nome, slug, banner_url, logo_url, descricao, taxa_entrega, taxas_entrega_km, tempo_entrega_min, tempo_entrega_max, aceita_delivery, aceita_entrega, aceita_retirada, delivery_ativo, last_heartbeat_at, cidade, latitude, longitude, raio_entrega_km, formas_pagamento, repasse_credito_pct, repasse_debito_pct, repasse_cartao_pct')
      const empRes = await (isUuid ? baseQuery.eq('id', empresaId) : baseQuery.eq('slug', empresaId)).maybeSingle()
      if (empRes.error) { setError(empRes.error.message); setLoading(false); return }
      const resolvedId = empRes.data?.id ?? empresaId
      const prodRes = await supabase
        .from('estoque_catalogo').select('*', { count: 'exact' })
        .eq('empresa_id', resolvedId).order('categoria').order('ordem', { nullsFirst: false }).order('nome').range(0, 199)
      if (prodRes.error) setError(prodRes.error.message)
      // Categoria "só no salão" (mig 0328) não aparece pro cliente. A ordem das
      // categorias é a que o dono montou no cardápio (igual à Loja Online).
      const { data: catsLoja } = await supabase
        .from('categorias').select('nome, ordem, oculta_online').eq('empresa_id', resolvedId)
      categoriasOcultas.current = new Set((catsLoja ?? []).filter(c => c.oculta_online).map(c => c.nome))
      const ordemMap = {}
      for (const c of (catsLoja ?? [])) ordemMap[c.nome] = c.ordem ?? 999
      setCatOrdem(ordemMap)
      setEmpresa(empRes.data ?? null)
      setLidos((prodRes.data ?? []).length)
      // vende_app: o produto escolhe se aparece no app do cliente (mig 0384).
      setProdutos((prodRes.data ?? []).filter(p => !categoriasOcultas.current.has(p.categoria) && p.disponivel_delivery !== false && p.vende_app !== false))
      setTotalProdutos(prodRes.count ?? 0)

      // Complementos (sabores, bordas...): mesma consulta da Loja Online. Só chegam pro cliente
      // logado depois da mig 0347. Se a leitura FALHAR, o produto "monte a sua" ficaria sem grupos
      // e entraria na sacola a R$ 0,00 — por isso falha com aviso em vez de seguir calado.
      const vinc = await fetchAll(() => supabase
        .from('produto_complemento_grupos')
        .select('produto_id, ordem, min_override, max_override, complemento_grupos!inner(id, nome, min, max, disponivel, regra_preco, modo_quantidade, complemento_opcoes(id, nome, descricao, preco_adicional, ordem, disponivel))')
        .eq('complemento_grupos.empresa_id', resolvedId)
        .order('produto_id'))
      if (vinc.error) {
        setComplementosFalhou(true)
        setError('Não consegui carregar as opções do cardápio. Feche e abra a loja de novo.')
      } else {
        setComplementosFalhou(false)
        // Opção "opt-out" (Sem X / Não quero) serve pra recusar a categoria.
        const soSemOpcao = nome => /^\s*sem\s|n[ãa]o\s*quero/i.test(String(nome || ''))
        const porProduto = {}
        for (const v of (vinc.data ?? [])) {
          const g = v.complemento_grupos
          if (!g || g.disponivel === false) continue // grupo pausado some da loja
          const opcoes = (g.complemento_opcoes ?? [])
            .filter(o => o.disponivel !== false)
            .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
          // Grupo que sobrou só com "Sem/Não quero" (nenhuma opção real) não aparece.
          if (!opcoes.some(o => !soSemOpcao(o.nome))) continue
          ;(porProduto[v.produto_id] ??= []).push({
            id: g.id, nome: g.nome, min: v.min_override ?? g.min ?? 0, max: v.max_override ?? g.max ?? 1,
            regra_preco: g.regra_preco ?? 'somar', ordem: v.ordem ?? 0, opcoes,
            modo_quantidade: g.modo_quantidade === true,
          })
        }
        for (const k of Object.keys(porProduto)) porProduto[k].sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
        setComplementosPorProduto(porProduto)
      }
      setLoading(false)
    }
    load()
  }, [empresaId])

  // Botão "Sacola" do menu de baixo: abre a sacola daqui. Se o cliente estava em
  // outra tela, o menu navega pra cá já pedindo pra abrir (location.state).
  const location = useLocation()
  useEffect(() => {
    if (location.state?.abrirSacola) {
      setCarrinhoAberto(true)
      navigate(location.pathname, { replace: true, state: null })
    }
    const abrir = () => setCarrinhoAberto(true)
    window.addEventListener('abrir-sacola-portal', abrir)
    return () => window.removeEventListener('abrir-sacola-portal', abrir)
  }, [location.state, location.pathname, navigate])

  // "Aberta/fechada" depende do sinal de vida da loja (heartbeat, vale 2 min). A tela
  // lia isso uma vez só: quem saía do app e voltava via a loja "fechada" até reabrir.
  // Agora relê ao voltar pro app e a cada 30s enquanto a tela está aberta.
  useEffect(() => {
    const id = empresa?.id
    if (!id) return
    async function atualizarStatus() {
      if (document.visibilityState === 'hidden') return
      const { data } = await supabase.from('empresas')
        .select('aceita_delivery, aceita_retirada, delivery_ativo, last_heartbeat_at')
        .eq('id', id).maybeSingle()
      if (data) setEmpresa(prev => (prev ? { ...prev, ...data } : prev))
    }
    document.addEventListener('visibilitychange', atualizarStatus)
    window.addEventListener('focus', atualizarStatus)
    const timer = setInterval(atualizarStatus, 30000)
    return () => {
      document.removeEventListener('visibilitychange', atualizarStatus)
      window.removeEventListener('focus', atualizarStatus)
      clearInterval(timer)
    }
  }, [empresa?.id])

  // A forma marcada tem que existir na loja: senão cai na primeira que ela aceita.
  useEffect(() => {
    if (!empresa) return
    const ligadas = formasAtivas(empresa)
    setForm(p => {
      if (ligadas.includes(p.forma)) return p
      const preferida = ['pix', 'pix_entrega', 'dinheiro', 'credito', 'debito', 'cartao'].find(f => ligadas.includes(f))
      return { ...p, forma: preferida ?? ligadas[0] }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresa?.id, JSON.stringify(empresa?.formas_pagamento ?? null)])

  useEffect(() => {
    async function loadCliente() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const [{ data: cliente }, { data: profile }, { data: saldo }, { data: cfgs }] = await Promise.all([
        supabase.from('clientes')
          .select('id, nome, telefone, cep, endereco, numero, complemento, bairro, cidade')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase.from('profiles')
          .select('nome, telefone, cep, endereco, numero, complemento, bairro, cidade, estado, latitude, longitude')
          .eq('id', user.id)
          .maybeSingle(),
        supabase.from('saldo_pontos').select('pontos').eq('profile_id', user.id).maybeSingle(),
        supabase.from('configuracoes_plataforma').select('chave, valor')
          .in('chave', ['valor_resgate_ponto', 'pontos_minimo_resgate']),
      ])
      setSaldoPontos(Number(saldo?.pontos ?? 0))
      const vrp = cfgs?.find(c => c.chave === 'valor_resgate_ponto')?.valor
      const pmr = cfgs?.find(c => c.chave === 'pontos_minimo_resgate')?.valor
      if (vrp != null) setValorPonto(Number(vrp) || 0.02)
      if (pmr != null) setMinResgate(Number(pmr) || 100)
      if (cliente) setClienteProfile(cliente)
      const d = cliente ?? profile
      const endLocal = getEnderecoAtivo()
      // Ponto da casa marcado no mapa (aparelho ou perfil), preso à rua em que foi marcado
      {
        const lat = Number(endLocal?.latitude ?? profile?.latitude)
        const lng = Number(endLocal?.longitude ?? profile?.longitude)
        if (Number.isFinite(lat) && Number.isFinite(lng) && (endLocal?.latitude != null || profile?.latitude != null)) {
          setPinCliente({ lat, lng, rua: endLocal?.latitude != null ? endLocal?.endereco : (d?.endereco ?? profile?.endereco) })
        }
      }
      if (d || endLocal) {
        setForm(p => ({
          ...p,
          nome:        d?.nome        ?? '',
          telefone:    d?.telefone    ?? '',
          cep:         d?.cep         || endLocal?.cep         || '',
          rua:         d?.endereco    || endLocal?.endereco    || '',
          numero:      d?.numero      || endLocal?.numero      || '',
          complemento: d?.complemento || endLocal?.complemento || '',
          bairro:      d?.bairro      || endLocal?.bairro      || '',
          cidade:      d?.cidade      || endLocal?.cidade      || '',
        }))
      }
    }
    loadCliente()
  }, [])

  /* ── Online check ── */
  function lojaOnline(emp) {
    if (!emp?.aceita_delivery || !emp?.delivery_ativo) return false
    if (!emp?.last_heartbeat_at) return false
    return Date.now() - new Date(emp.last_heartbeat_at).getTime() < 2 * 60 * 1000
  }
  const lojaFechada = empresa?.aceita_delivery && !lojaOnline(empresa)

  /* ── Carrinho ── */
  function addOne(id) {
    // Sem os complementos carregados, um produto "monte a sua" (preço 0) entraria de graça.
    if (complementosFalhou) {
      const prod = produtos.find(x => x.produto_id === id)
      if (prod && Number(prod.preco_venda) <= 0) return
    }
    setCarrinho(p => ({ ...p, [id]: (p[id] ?? 0) + 1 }))
  }
  function removeOne(id) {
    setCarrinho(p => {
      const n = { ...p }
      if ((n[id] ?? 0) <= 1) delete n[id]
      else n[id]--
      return n
    })
  }

  // ── Itens montados (pizza com sabores, borda...) ──
  const temComplementos = p => (complementosPorProduto[p.produto_id]?.length ?? 0) > 0
  const qtdMontadaDoProduto = id =>
    Object.values(combos).filter(c => String(c.id) === String(id)).reduce((s, c) => s + (Number(c.quantidade) || 0), 0)
  // O produto no formato que a janela de escolha (a da Loja Online) espera.
  const produtoParaJanela = p => ({
    id: p.produto_id, nome: p.nome, descricao: p.descricao, foto_url: p.foto_url, categoria: p.categoria,
    preco: Number(p.preco_venda), faixas_preco: p.faixas_preco ?? [], preco_promocional: p.preco_promocional ?? null,
    complementos: complementosPorProduto[p.produto_id] ?? [],
  })
  const abrirOpcoes = p => setOptProduto(produtoParaJanela(p))

  // Confirmou a montagem: vira uma linha da sacola. Mesma combinação soma na mesma linha.
  function addCombo(prod, selecoes, precoUnit, qtdItem = 1, observacao = '') {
    const key = selecoes.length
      ? `${prod.id}::${selecoes.map(s => `${s.opcaoId}x${s.qtd ?? 1}`).sort().join('-')}`
      : String(prod.id)
    setCombos(prev => ({
      ...prev,
      [key]: {
        key, id: prod.id, nome: prod.nome, preco: precoUnit, foto_url: prod.foto_url,
        complementos: selecoes.map(s => ({
          grupoId: s.grupoId, opcaoId: s.opcaoId,
          grupo: s.grupo, nome: s.nome, preco: s.preco, qtd: s.qtd ?? 1, absoluto: !!s.absoluto,
        })),
        quantidade: (prev[key]?.quantidade ?? 0) + (Number(qtdItem) || 1),
        observacao: String(observacao ?? '').trim() || prev[key]?.observacao || '',
      },
    }))
    setOptProduto(null)
  }
  function mudarCombo(key, delta) {
    setCombos(prev => {
      const c = prev[key]
      if (!c) return prev
      const q = (Number(c.quantidade) || 0) + delta
      const n = { ...prev }
      if (q <= 0) delete n[key]
      else n[key] = { ...c, quantidade: q }
      return n
    })
  }

  // "A partir de": preço base + as opções obrigatórias mais baratas (o `min` de cada grupo).
  // Sem isso o "monte a sua" (base R$ 0) apareceria como "R$ 0,00" no cardápio.
  const precoAPartirDe = p => {
    const grupos = complementosPorProduto[p.produto_id] ?? []
    const extra = grupos.reduce((s, g) => {
      const n = g.min ?? 0
      if (n <= 0) return s
      const precos = (g.opcoes ?? []).map(o => Number(o.preco_adicional || 0)).sort((a, b) => a - b)
      // Grupo que cobra pelo mais caro: pegar n opções baratas custa o preço de UMA.
      if (cobraPeloMaior(g)) return s + (precos[0] ?? 0)
      return s + precos.slice(0, n).reduce((a, b) => a + b, 0)
    }, 0)
    return Number(p.preco_venda) + extra
  }

  // Card do produto. Produto com complementos (pizza, quentinha...) NÃO entra direto: o "+" abre a
  // janela de escolher sabores/borda, e o "−" leva pra sacola, onde cada montagem é uma linha.
  const renderCard = p => {
    const montavel = temComplementos(p)
    return (
      <ProdutoCard
        key={p.produto_id}
        produto={p}
        qtd={montavel ? qtdMontadaDoProduto(p.produto_id) : (carrinho[p.produto_id] ?? 0)}
        onAdd={montavel ? () => abrirOpcoes(p) : addOne}
        onRemove={montavel ? () => setCarrinhoAberto(true) : removeOne}
        lojaFechada={lojaFechada}
        precoExibir={montavel ? precoAPartirDe(p) : Number(p.preco_venda)}
        aPartirDe={montavel}
      />
    )
  }

  // Cada linha da sacola: produto simples (preço do cadastro) ou item montado (preço fechado na montagem).
  const linhasSimples = Object.entries(carrinho)
    .map(([id, qtd]) => {
      const produto = produtos.find(p => p.produto_id === id)
      return produto ? { key: id, produto, qtd, precoUnit: Number(produto.preco_venda), complementos: null, observacao: '' } : null
    })
    .filter(Boolean)
  const linhasMontadas = Object.values(combos)
    .map(c => {
      const produto = produtos.find(p => String(p.produto_id) === String(c.id))
      return produto
        ? { key: c.key, produto, qtd: Number(c.quantidade) || 0, precoUnit: Number(c.preco) || 0,
            complementos: c.complementos ?? [], observacao: c.observacao ?? '', ehCombo: true }
        : null
    })
    .filter(Boolean)
  const itensCarrinho = [...linhasSimples, ...linhasMontadas]

  const totalItens = itensCarrinho.reduce((s, i) => s + i.qtd, 0)
  const totalValor = itensCarrinho.reduce((s, i) => s + i.qtd * i.precoUnit, 0)
  const temFaixasKm = Array.isArray(empresa?.taxas_entrega_km) && empresa.taxas_entrega_km.length > 0
  const taxa = taxaCalculada !== null ? taxaCalculada : (temFaixasKm ? null : Number(empresa?.taxa_entrega ?? 0))
  const totalComTaxa = totalValor + (taxa ?? 0)

  // ── Saldo de pontos como desconto (usa o máximo possível automaticamente) ──
  const baseDesconto    = Number.isFinite(totalComTaxa) ? totalComTaxa : totalValor
  const maxPtsPorValor  = Math.max(0, Math.floor((baseDesconto - 0.01) / (valorPonto || 0.02)))
  const pontosUsaveis   = Math.min(saldoPontos, maxPtsPorValor)
  const podeUsarSaldo   = pontosUsaveis >= minResgate
  const pontosUsados    = usarSaldo && podeUsarSaldo ? pontosUsaveis : 0
  const descontoPontos  = Math.round(pontosUsados * (valorPonto || 0.02) * 100) / 100
  // Formas de pagamento: as que a loja ligou em Minha Loja → Pagamento. O cartão pode
  // ter um acréscimo que a loja cobra do cliente (ex.: CDBom, 5% no crédito).
  const formasLoja      = formasAtivas(empresa)
  const pctRepasse      = repassePct(empresa, form.forma)
  const baseCartao      = Math.max(0, baseDesconto - descontoPontos)
  const acrescimoPag    = Math.round(baseCartao * pctRepasse) / 100
  const totalFinal      = Math.round((baseCartao + acrescimoPag) * 100) / 100

  /* ── Carregar mais produtos ── */
  async function carregarMais() {
    if (!empresa?.id) return
    setCarregandoMais(true)
    const { data } = await supabase
      .from('estoque_catalogo')
      .select('*')
      .eq('empresa_id', empresa.id)
      .order('categoria').order('ordem', { nullsFirst: false }).order('nome')
      .range(lidos, lidos + 199)
    setLidos(n => n + (data ?? []).length)
    setProdutos(prev => [...prev, ...(data ?? []).filter(p => !categoriasOcultas.current.has(p.categoria) && p.disponivel_delivery !== false && p.vende_app !== false)])
    setCarregandoMais(false)
  }

  /* ── Categorias ── */
  // Cardápio na ordem que o dono montou: categorias pela ordem delas, produtos pela
  // ordem manual dentro da categoria (quem nunca foi ordenado vai pro fim, por nome).
  const produtosOrdenados = useMemo(() => [...produtos].sort((a, b) =>
    ((catOrdem[a.categoria] ?? 999) - (catOrdem[b.categoria] ?? 999))
    || String(a.categoria ?? '').localeCompare(String(b.categoria ?? ''))
    || ((a.ordem ?? 9999) - (b.ordem ?? 9999))
    || String(a.nome).localeCompare(String(b.nome))), [produtos, catOrdem])
  const categorias = [...new Set(produtosOrdenados.map(p => p.categoria).filter(Boolean))]

  /* ── Filtro ── */
  const produtosFiltrados = useMemo(() => produtosOrdenados.filter(p => {
    const termo = busca.trim().toLowerCase()
    return !termo || p.nome?.toLowerCase().includes(termo) || p.descricao?.toLowerCase().includes(termo)
  }), [produtosOrdenados, busca])

  /* ── Agrupamento por categoria ──
     Uma passada só. Antes cada categoria varria a lista inteira (`filter` dentro
     do `map`), e isso rodava de novo a cada toque no + de um produto — no
     depósito, com centenas de itens na tela, a mão travava no carrinho. */
  const secoes = useMemo(() => {
    const porCat = new Map()
    for (const p of produtosFiltrados) {
      if (!p.categoria) continue
      const lista = porCat.get(p.categoria)
      if (lista) lista.push(p)
      else porCat.set(p.categoria, [p])
    }
    return [...porCat.entries()].map(([nome, produtos]) => ({ nome, produtos }))
  }, [produtosFiltrados])

  const semCategoria = useMemo(() => produtosFiltrados.filter(p => !p.categoria), [produtosFiltrados])

  /* ── Barra de categorias ──
     Fica fixa logo abaixo do cabeçalho, toca numa categoria e a tela rola até ela
     (o cardápio continua inteiro), e o destaque acompanha o que está na tela. */
  const irParaCategoria = useCallback((cat) => {
    setCategoriaAtiva(cat)
    const alvo = [...document.querySelectorAll('[data-secao]')].find(s => s.dataset.secao === cat)
    alvo?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  useEffect(() => {
    const raiz = document.documentElement
    // O cabeçalho no celular é mais alto que 56px (barra de status): mede o real,
    // senão a barra de categorias fica escondida atrás dele.
    function medir() {
      const cab = document.querySelector('.portal-header')
      const h = cab ? cab.getBoundingClientRect().height : 56
      const barra = barraCatRef.current?.parentElement
      const b = barra ? barra.getBoundingClientRect().height : 44
      raiz.style.setProperty('--loja-header-h', `${Math.round(h)}px`)
      raiz.style.setProperty('--loja-offset', `${Math.round(h + b + 6)}px`)
    }
    let quadro = 0
    function aoRolar() {
      cancelAnimationFrame(quadro)
      quadro = requestAnimationFrame(() => {
        const corte = (parseInt(getComputedStyle(raiz).getPropertyValue('--loja-offset'), 10) || 120) + 4
        const secs = document.querySelectorAll('[data-secao]')
        let atual = secs[0]?.dataset.secao ?? ''
        for (const s of secs) {
          if (s.getBoundingClientRect().top <= corte) atual = s.dataset.secao
          else break
        }
        setCategoriaAtiva(prev => (prev === atual ? prev : atual))
      })
    }
    medir()
    aoRolar()
    window.addEventListener('resize', medir)
    window.addEventListener('scroll', aoRolar, { passive: true })
    return () => {
      cancelAnimationFrame(quadro)
      window.removeEventListener('resize', medir)
      window.removeEventListener('scroll', aoRolar)
      raiz.style.removeProperty('--loja-header-h')
      raiz.style.removeProperty('--loja-offset')
    }
  }, [secoes.length])

  // Mantém o botão da categoria atual à vista dentro da barra (que rola pro lado)
  useEffect(() => {
    const barra = barraCatRef.current
    if (!barra || !categoriaAtiva) return
    const pill = [...barra.children].find(c => c.dataset.cat === categoriaAtiva)
    if (!pill) return
    const esq = barra.scrollLeft + pill.getBoundingClientRect().left - barra.getBoundingClientRect().left - 16
    barra.scrollTo({ left: esq, behavior: 'smooth' })
  }, [categoriaAtiva])

  /* ── CEP ── */
  function handleCepChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    const fmt = v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v
    setForm(p => ({ ...p, cep: fmt }))
    setErroCep(null)
    if (v.length === 8) buscarCep(v)
  }

  async function buscarCep(numeros) {
    setBuscandoCep(true)
    setErroCep(null)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${numeros}/json/`)
      const data = await res.json()
      if (data.erro) { setErroCep('CEP não encontrado.'); return }
      setForm(p => ({
        ...p,
        rua: [data.logradouro, data.bairro].filter(Boolean).join(', ') || p.rua,
        bairro: data.bairro || p.bairro,
        cidade: data.localidade || p.cidade,
      }))
    } catch {
      setErroCep('Erro ao buscar CEP.')
    } finally {
      setBuscandoCep(false)
    }
  }

  /* ── Taxa de entrega: ponto do cliente + conta do servidor ── */
  const mesmaRua = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

  // O ponto confirmado no mapa (cadastro do endereço) vale enquanto a rua não mudou;
  // senão procura o texto no mapa.
  async function pontoDoCliente() {
    const p = pinCliente
    if (p && mesmaRua(form.rua, p.rua)) return { lat: p.lat, lng: p.lng }
    const endStr = [form.rua, form.numero, form.bairro, form.cidade].filter(Boolean).join(', ')
    return endStr ? await geocodificar(endStr) : null
  }

  // Quanto ESTA loja cobra por esta entrega — a mesma função que o banco usa pra
  // recusar pedido com taxa errada. Assim a tela, o pedido e a trava dizem o mesmo
  // número (antes o app ignorava a tabela de bairros e calculava só por km).
  async function taxaDoServidor(coords) {
    if (!empresa?.id) return null
    const { data, error: e } = await supabase.rpc('taxa_entrega_esperada', {
      p_empresa: empresa.id,
      p_bairro:  form.bairro?.trim() || null,
      p_lat:     coords?.lat ?? null,
      p_lng:     coords?.lng ?? null,
    })
    if (e || data == null) return null
    return Number(data)
  }

  // Mostra a taxa certa no resumo assim que o endereço está preenchido, em vez de
  // só descobrir na hora de confirmar.
  useEffect(() => {
    if (!checkoutAberto || form.tipo_entrega !== 'entrega' || !empresa?.id) return
    if (!form.rua.trim() || !form.cidade.trim()) return
    let vivo = true
    const t = setTimeout(async () => {
      const v = await taxaDoServidor(await pontoDoCliente())
      if (vivo && v != null) setTaxaCalculada(v)
    }, 700)
    return () => { vivo = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutAberto, form.tipo_entrega, form.rua, form.numero, form.bairro, form.cidade, empresa?.id, pinCliente])

  /* ── Checkout ── */
  async function handleConfirmarPedido() {
    setError(null)
    // Para retirada, endereço não é obrigatório
    const precisaEndereco = form.tipo_entrega === 'entrega'
    if (!form.nome.trim() || !form.telefone.trim()) {
      setError('Preencha nome e WhatsApp.')
      return
    }
    if (precisaEndereco && (!form.rua.trim() || !form.cidade.trim())) {
      setError('Preencha rua e cidade para entrega.')
      return
    }

    // Valida raio e calcula a taxa. A taxa que vale é a do SERVIDOR (a mesma conta da
    // trava que recusa pedido com taxa errada): bairro cadastrado manda, senão a
    // tabela por km do ponto do cliente. Valor guardado em `taxaFinal` e NÃO no
    // estado: o estado só muda na próxima renderização e o pedido saía com taxa 0.
    let taxaFinal = taxa
    let coordsPedido = null
    if (precisaEndereco) {
      coordsPedido = await pontoDoCliente()
      const esperada = await taxaDoServidor(coordsPedido)
      if (esperada != null) taxaFinal = esperada

      if (coordsPedido && empresa?.latitude && empresa?.longitude) {
        const dist = haversineKm(coordsPedido.lat, coordsPedido.lng, Number(empresa.latitude), Number(empresa.longitude))

        // Bloqueia se fora do raio
        if (empresa.raio_entrega_km && dist > Number(empresa.raio_entrega_km)) {
          setError(`Infelizmente não entregamos no seu endereço ainda 😕 (${dist.toFixed(1)} km — raio máximo: ${empresa.raio_entrega_km} km)`)
          return
        }

        // Tempo (e, sem resposta do servidor, a taxa) pela faixa de km
        const faixas = Array.isArray(empresa.taxas_entrega_km) ? empresa.taxas_entrega_km : []
        if (faixas.length > 0) {
          const ordenadas = [...faixas].sort((a, b) => a.km - b.km)
          const faixa = ordenadas.find(f => dist <= Number(f.km)) ?? ordenadas[ordenadas.length - 1]
          if (esperada == null) taxaFinal = Number(faixa.taxa)
          if (faixa.tempo != null && faixa.tempo !== '') setTempoCalculado(Number(faixa.tempo))
        }
      }
      if (taxaFinal != null) setTaxaCalculada(taxaFinal)
    }

    setEnviando(true)

    // Garante registro em clientes via RPC SECURITY DEFINER (bypassa RLS)
    let clienteId = clienteProfile?.id ?? null
    let authUserId = null
    {
      const { data: { user } } = await supabase.auth.getUser()
      authUserId = user?.id ?? null
      if (!clienteId && user) {
        const { data } = await supabase.rpc('upsert_cliente_portal', {
          p_nome: form.nome.trim(),
          p_telefone: form.telefone.trim() || '',
          p_empresa_id: empresa?.id ?? empresaId,
        })
        clienteId = data ?? null
      }
    }

    // Chegou pelo link de alguém? Amarra o vínculo (mig 0176).
    await registrarIndicacao(clienteId)

    // Mesmo formato da Loja Online: o nome dobra as escolhas ("Pizza (Sabor A, Sabor B, Borda)")
    // pro painel e o cupom, e `complementos` guarda o estruturado.
    const itens = itensCarrinho.map(i => ({
      produto_id: i.produto.produto_id,
      nome: i.complementos?.length
        ? `${i.produto.nome} (${i.complementos.map(c => (c?.absoluto ? `${Number(c.qtd) || 1}× ${c.nome}` : c.nome)).join(', ')})`
        : i.produto.nome,
      quantidade: i.qtd,
      preco_unitario: i.precoUnit,
      subtotal: Math.round(i.qtd * i.precoUnit * 100) / 100,
      ...(i.ehCombo ? { complementos: i.complementos ?? [], observacao: (i.observacao ?? '').trim() || null } : {}),
    }))

    const isRetirada = form.tipo_entrega === 'retirada'

    // Total com a taxa JÁ calculada (taxaFinal) e o acréscimo do cartão, se a loja cobra.
    const baseFinal = Math.max(0, (isRetirada ? totalValor : totalValor + (taxaFinal ?? 0)) - descontoPontos)
    const acrescimoFinal = Math.round(baseFinal * repassePct(empresa, form.forma)) / 100

    const pedidoBase = {
      empresa_id:           empresa?.id ?? empresaId,
      origem:               'app',
      user_id:              authUserId,
      cliente_id:           clienteId,
      cliente_nome:         form.nome.trim(),
      cliente_telefone:     form.telefone.trim(),
      endereco_rua:         isRetirada ? null : form.rua.trim() || null,
      endereco_numero:      isRetirada ? null : form.numero.trim() || null,
      endereco_complemento: isRetirada ? null : form.complemento.trim() || null,
      endereco_bairro:      isRetirada ? null : form.bairro.trim() || null,
      endereco_cidade:      isRetirada ? null : form.cidade.trim() || null,
      itens,
      subtotal:             totalValor,
      // Ponto da casa: o servidor usa ele pra conferir a taxa (sem ele cai no piso da tabela)
      endereco_lat:         isRetirada ? null : (coordsPedido?.lat ?? null),
      endereco_lng:         isRetirada ? null : (coordsPedido?.lng ?? null),
      taxa_entrega:         isRetirada ? 0 : (taxaFinal ?? 0),
      desconto:             descontoPontos,
      pontos_usados:        pontosUsados,
      acrescimo:            acrescimoFinal,
      total:                Math.round((baseFinal + acrescimoFinal) * 100) / 100,
      forma_pagamento:      form.forma,
      troco_para:           form.forma === 'dinheiro' && form.troco ? Math.round(Number(form.troco) * 100) / 100 : null,
      observacoes:          form.obs.trim() || null,
      tipo_entrega:         form.tipo_entrega,
    }

    // ── PIX: chama edge function para gerar QR code ──────────
    if (form.forma === 'pix') {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-pix-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ pedido: { ...pedidoBase, payer_email: session?.user?.email } }),
      })
      const data = await res.json()
      setEnviando(false)
      if (!res.ok) { setError(data.error ?? 'Erro ao gerar PIX'); return }
      setCheckoutAberto(false)
      setPixData(data)
      return
    }

    // ── Dinheiro: inserção direta ─────────────────────────────
    const { error: insertError } = await supabase.from('pedidos_delivery').insert(pedidoBase)

    setEnviando(false)
    if (insertError) { setError(insertError.message); return }

    localStorage.removeItem(SACOLA_KEY)
    window.dispatchEvent(new CustomEvent('carrinho-portal-changed'))
    setCarrinho({})
    setCombos({})
    setCheckoutAberto(false)
    navigate('/portal/pedidos')
  }

  if (loading) return (
    <div className="loja-loading">
      <div className="loja-spinner" />
      <p>Carregando cardápio...</p>
    </div>
  )

  if (pixData) return (
    <PixScreen
      pixData={pixData}
      onConcluido={() => {
        localStorage.removeItem(SACOLA_KEY)
        window.dispatchEvent(new CustomEvent('carrinho-portal-changed'))
        setPixData(null)
        setCarrinho({})
        setCombos({})
        navigate('/portal/pedidos')
      }}
    />
  )

  return (
    <div className="loja-root">
      {/* ── Banner hero full-bleed ── */}
      <div className="loja-hero">
        {empresa?.banner_url
          ? <img className="loja-hero-img" src={empresa.banner_url} alt={empresa?.nome} />
          : <div className="loja-hero-placeholder" />
        }
        {!dominioExclusivo && (
          <button className="loja-back-btn" onClick={() => navigate('/portal')} aria-label="Voltar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
        )}
      </div>

      {/* ── Store identity ── */}
      <div className="loja-identity">
        <div className="loja-identity-logo">
          {empresa?.logo_url
            ? <img src={empresa.logo_url} alt={empresa?.nome} />
            : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
            )
          }
        </div>
        <div className="loja-identity-info">
          <h1 className="loja-identity-nome">{empresa?.nome ?? 'Loja'}</h1>
          {empresa?.aceita_delivery && empresa?.tempo_entrega_min ? (
            <span className="loja-identity-sub">
              Entrega · {empresa.tempo_entrega_min}–{empresa.tempo_entrega_max ?? empresa.tempo_entrega_min + 10} min
              {temFaixasKm ? ' · Taxa por distância' : taxa > 0 ? ` · R$ ${taxa.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : ' · Frete grátis'}
            </span>
          ) : (
            <span className="loja-identity-sub">Catálogo de produtos</span>
          )}
        </div>
      </div>

      {error && <div className="loja-aviso loja-aviso-erro">{error}</div>}

      {lojaFechada && (
        <div className="loja-aviso loja-aviso-fechada">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Loja fechada no momento. Em breve voltaremos!
        </div>
      )}

      {/* ── Busca ── */}
      <div className="loja-search-wrap">
        <svg className="loja-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          className="loja-search-input"
          type="search"
          placeholder="Buscar no cardápio..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
        />
        {busca && (
          <button className="loja-search-clear" onClick={() => setBusca('')} aria-label="Limpar busca">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      {/* ── Categorias pills sticky ── */}
      <div className="loja-categorias-sticky">
        <div className="loja-categorias" ref={barraCatRef}>
          {categorias.map(cat => (
            <button
              key={cat}
              data-cat={cat}
              className={`loja-cat-pill${categoriaAtiva === cat ? ' active' : ''}`}
              onClick={() => irParaCategoria(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* ── Conteúdo de produtos ── */}
      <div className="loja-catalogo">
        {produtosFiltrados.length === 0 ? (
          <div className="loja-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <p>Nenhum produto encontrado.</p>
            {busca && <span>Tente outro termo de busca.</span>}
          </div>
        ) : (
          <>
            {secoes.map(secao => (
              <section key={secao.nome} className="loja-secao" data-secao={secao.nome}>
                <h3 className="loja-secao-titulo">{secao.nome}</h3>
                <div className="loja-lista">
                  {secao.produtos.map(renderCard)}
                </div>
              </section>
            ))}

            {semCategoria.length > 0 && (
              <section className="loja-secao">
                <h3 className="loja-secao-titulo">Outros</h3>
                <div className="loja-lista">
                  {semCategoria.map(renderCard)}
                </div>
              </section>
            )}
          </>
        )}

        {lidos < totalProdutos && !busca && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <button
              className="btn btn-secondary"
              onClick={carregarMais}
              disabled={carregandoMais}
            >
              {carregandoMais ? 'Carregando...' : `Carregar mais (${totalProdutos - lidos} restantes)`}
            </button>
          </div>
        )}
      </div>

      {/* ── Escolher sabores, borda e outros complementos (a mesma janela da Loja Online) ── */}
      {optProduto && (
        // `dloja-root` traz as cores da janela; `display: contents` não cria caixa nenhuma na tela.
        <div
          className="dloja-root"
          data-tema={document.documentElement.getAttribute('data-theme') === 'dark' ? 'escuro' : 'claro'}
          style={{ display: 'contents', minHeight: 0, background: 'transparent' }}
        >
          <Suspense fallback={null}>
            <OptionsModal
              produto={optProduto}
              onClose={() => setOptProduto(null)}
              onConfirm={(selecoes, precoUnit, qtdItem, obs) => addCombo(optProduto, selecoes, precoUnit, qtdItem, obs)}
              lojaAberta={!lojaFechada}
            />
          </Suspense>
        </div>
      )}

      {/* ── Barra flutuante da sacola ── */}
      {totalItens > 0 && !lojaFechada && (
        <button className="loja-cart-bar" onClick={() => setCarrinhoAberto(true)}>
          <span className="loja-cart-badge">{totalItens}</span>
          <span className="loja-cart-label">Ver sacola</span>
          <span className="loja-cart-total">
            R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
          </span>
        </button>
      )}

      {/* ── Drawer da sacola ── */}
      {carrinhoAberto && (
        <div className="loja-drawer-overlay" onClick={() => setCarrinhoAberto(false)}>
          <div className="loja-drawer" onClick={e => e.stopPropagation()}>
            <div className="loja-drawer-handle" />
            <div className="loja-drawer-header">
              <h2>Sua sacola</h2>
              <button className="loja-drawer-close" onClick={() => setCarrinhoAberto(false)} aria-label="Fechar sacola">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="loja-drawer-itens">
              {itensCarrinho.map(i => (
                <div key={i.key} className="loja-drawer-item">
                  <div className="loja-drawer-item-info">
                    <span className="loja-drawer-item-nome">{i.produto.nome}</span>
                    {/* Item montado: mostra o que foi escolhido (sabores, borda...) */}
                    {i.ehCombo && i.complementos?.length > 0 && (
                      <span className="loja-drawer-item-sub" style={{ whiteSpace: 'normal', lineHeight: 1.35 }}>
                        {i.complementos.map(c => (c?.absoluto ? `${Number(c.qtd) || 1}× ${c.nome}` : c.nome)).join(', ')}
                      </span>
                    )}
                    {i.ehCombo && i.observacao && (
                      <span className="loja-drawer-item-sub" style={{ whiteSpace: 'normal' }}>📝 {i.observacao}</span>
                    )}
                    <span className="loja-drawer-item-sub">
                      R$ {i.precoUnit.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} cada
                    </span>
                  </div>
                  <div className="loja-qty-ctrl">
                    <button className="loja-qty-btn" onClick={() => (i.ehCombo ? mudarCombo(i.key, -1) : removeOne(i.produto.produto_id))}>−</button>
                    <span className="loja-qty-val">{i.qtd}</span>
                    <button
                      className="loja-qty-btn"
                      disabled={i.ehCombo && i.complementos?.some(c => c?.absoluto)}
                      onClick={() => (i.ehCombo ? mudarCombo(i.key, 1) : addOne(i.produto.produto_id))}
                    >+</button>
                  </div>
                  <span className="loja-drawer-item-total">
                    R$ {(i.qtd * i.precoUnit).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>

            <div className="loja-drawer-total">
              <span>Subtotal</span>
              <strong>R$ {totalValor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
            </div>

            <button
              className="loja-btn-confirmar"
              onClick={() => { setCarrinhoAberto(false); setCheckoutAberto(true) }}
            >
              Ir para pagamento
            </button>
          </div>
        </div>
      )}

      {/* ── Modal de checkout ── */}
      {checkoutAberto && (
        <div className="loja-drawer-overlay" onClick={() => setCheckoutAberto(false)}>
          <div className="loja-drawer loja-checkout" onClick={e => e.stopPropagation()}>
            <div className="loja-drawer-handle" />
            <div className="loja-drawer-header">
              <h2>Finalizar pedido</h2>
              <button className="loja-drawer-close" onClick={() => setCheckoutAberto(false)} aria-label="Fechar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <div className="loja-checkout-body">
              {/* Resumo */}
              <div className="loja-checkout-section">
                <h3>Resumo</h3>
                {itensCarrinho.map(i => (
                  <div key={i.key} className="loja-checkout-item">
                    <span>
                      {i.qtd}× {i.produto.nome}
                      {i.ehCombo && i.complementos?.length > 0 && (
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.35 }}>
                          {i.complementos.map(c => (c?.absoluto ? `${Number(c.qtd) || 1}× ${c.nome}` : c.nome)).join(', ')}
                        </span>
                      )}
                    </span>
                    <span>R$ {(i.qtd * i.precoUnit).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                  </div>
                ))}
                {form.tipo_entrega === 'entrega' && (
                  <div className="loja-checkout-item">
                    <span>Taxa de entrega</span>
                    <span style={{ color: taxa === null ? 'var(--text-muted)' : undefined }}>
                      {taxa === null
                        ? 'Calculado pelo endereço'
                        : taxa === 0 ? 'Grátis'
                        : `R$ ${taxa.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
                      }
                    </span>
                  </div>
                )}
                {form.tipo_entrega === 'entrega' && tempoCalculado !== null && (
                  <div className="loja-checkout-item">
                    <span>Tempo estimado</span>
                    <span>~{tempoCalculado} min</span>
                  </div>
                )}
                {acrescimoPag > 0 && (
                  <div className="loja-checkout-item">
                    <span>Acréscimo do cartão ({String(pctRepasse).replace('.', ',')}%)</span>
                    <span>R$ {acrescimoPag.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                  </div>
                )}
                <div className="loja-checkout-total">
                  <span>Total</span>
                  <strong>R$ {totalFinal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
                </div>

                {/* ── Usar saldo de pontos (destaque) ── */}
                {saldoPontos > 0 && podeUsarSaldo && (
                  <div
                    style={{
                      marginTop: 14, borderRadius: 16, overflow: 'hidden',
                      border: `2px solid ${usarSaldo ? 'var(--success)' : 'var(--primary)'}`,
                      background: usarSaldo
                        ? 'linear-gradient(135deg, rgba(34,197,94,.14), rgba(34,197,94,.05))'
                        : 'linear-gradient(135deg, rgba(134,59,255,.16), rgba(134,59,255,.05))',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setUsarSaldo(v => !v)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                        padding: '14px 16px', cursor: 'pointer', background: 'transparent',
                        border: 'none', textAlign: 'left',
                      }}
                    >
                      <span style={{ fontSize: 28, lineHeight: 1 }}>💰</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text)' }}>
                          Usar meu saldo de pontos
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                          Você tem <strong style={{ color: 'var(--text)' }}>{saldoPontos.toLocaleString('pt-BR')} pts</strong>
                          {' '}· economize até{' '}
                          <strong style={{ color: 'var(--success)' }}>
                            R$ {(pontosUsaveis * (valorPonto || 0.02)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                          </strong>
                        </div>
                      </div>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 48, height: 28, borderRadius: 999, flexShrink: 0, position: 'relative',
                          background: usarSaldo ? 'var(--success)' : 'rgba(255,255,255,.25)',
                          transition: 'background 150ms',
                        }}
                      >
                        <span style={{
                          position: 'absolute', top: 3, left: usarSaldo ? 23 : 3, width: 22, height: 22,
                          borderRadius: '50%', background: '#fff', transition: 'left 150ms',
                          boxShadow: '0 1px 3px rgba(0,0,0,.3)',
                        }} />
                      </span>
                    </button>

                    {usarSaldo && (
                      <div style={{ padding: '0 16px 14px' }}>
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          fontSize: 13, color: 'var(--text-muted)', padding: '8px 0',
                          borderTop: '1px dashed rgba(255,255,255,.18)',
                        }}>
                          <span>Desconto aplicado ({pontosUsados.toLocaleString('pt-BR')} pts)</span>
                          <strong style={{ color: 'var(--success)', fontSize: 15 }}>
                            − R$ {descontoPontos.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                          </strong>
                        </div>
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                        }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Você vai pagar</span>
                          <strong style={{ fontSize: 22, fontWeight: 800, color: 'var(--success)' }}>
                            R$ {totalFinal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                          </strong>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {saldoPontos > 0 && !podeUsarSaldo && (
                  <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                    💰 Você tem {saldoPontos.toLocaleString('pt-BR')} pts — junte {(minResgate - saldoPontos).toLocaleString('pt-BR')} pts (mínimo {minResgate.toLocaleString('pt-BR')}) para usar como desconto.
                  </p>
                )}
              </div>

              {/* Dados pessoais */}
              <div className="loja-checkout-section">
                <h3>Seus dados</h3>
                <label>Nome *
                  <input
                    value={form.nome}
                    onChange={e => setForm(p => ({ ...p, nome: e.target.value }))}
                    placeholder="Seu nome completo"
                    autoComplete="name"
                  />
                </label>
                <label>WhatsApp *
                  <input
                    value={form.telefone}
                    onChange={e => setForm(p => ({ ...p, telefone: e.target.value }))}
                    placeholder="(84) 99999-9999"
                    type="tel"
                    autoComplete="tel"
                  />
                </label>
              </div>

              {/* Tipo de pedido — só aparece quando a loja oferece os DOIS (entrega e retirada) */}
              {permiteRetirada && permiteEntrega && (
              <div className="loja-checkout-section">
                <h3>Tipo de pedido</h3>
                <div className="loja-checkout-payment-opts">
                  <button
                    type="button"
                    className={`loja-pay-opt${form.tipo_entrega === 'entrega' ? ' active' : ''}`}
                    onClick={() => setForm(p => ({ ...p, tipo_entrega: 'entrega' }))}
                  >
                    Entrega
                  </button>
                  <button
                    type="button"
                    className={`loja-pay-opt${form.tipo_entrega === 'retirada' ? ' active' : ''}`}
                    onClick={() => setForm(p => ({ ...p, tipo_entrega: 'retirada' }))}
                  >
                    Retirar na loja
                  </button>
                </div>
              </div>
              )}

              {/* Info de retirada */}
              {form.tipo_entrega === 'retirada' && (
              <div className="loja-checkout-section">
                <h3>Local de retirada</h3>
                <div style={{
                  background: 'var(--primary-bg)', border: '1px solid var(--primary)',
                  borderRadius: 10, padding: '12px 14px', fontSize: 14, lineHeight: 1.6,
                }}>
                  <strong>{empresa?.nome}</strong>
                  {empresa?.cidade && <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{empresa.cidade}</div>}
                  <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>
                    Retire no local após confirmação do pedido.
                  </div>
                </div>
              </div>
              )}

              {/* Endereço — só para entrega */}
              {form.tipo_entrega === 'entrega' && (
              <div className="loja-checkout-section">
                <h3>Endereço de entrega</h3>
                <label>CEP
                  <div style={{ position: 'relative' }}>
                    <input
                      value={form.cep}
                      onChange={handleCepChange}
                      placeholder="00000-000"
                      maxLength={9}
                      inputMode="numeric"
                      style={{ paddingRight: buscandoCep ? 36 : undefined }}
                    />
                    {buscandoCep && (
                      <span style={{
                        position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                        width: 14, height: 14, border: '2px solid var(--border)',
                        borderTopColor: 'var(--primary)', borderRadius: '50%',
                        animation: 'spin 0.7s linear infinite', display: 'inline-block',
                      }} />
                    )}
                  </div>
                  {erroCep && <span style={{ fontSize: 12, color: 'red', marginTop: 4, display: 'block' }}>{erroCep}</span>}
                </label>
                <label>Rua / Av. *
                  <input
                    value={form.rua}
                    onChange={e => setForm(p => ({ ...p, rua: e.target.value }))}
                    placeholder="Rua das Flores"
                    autoComplete="street-address"
                  />
                </label>
                <div className="loja-checkout-row">
                  <label style={{ flex: '0 0 100px' }}>Número
                    <input
                      value={form.numero}
                      onChange={e => setForm(p => ({ ...p, numero: e.target.value }))}
                      placeholder="123"
                    />
                  </label>
                  <label style={{ flex: 1 }}>Complemento
                    <input
                      value={form.complemento}
                      onChange={e => setForm(p => ({ ...p, complemento: e.target.value }))}
                      placeholder="Apto 4"
                    />
                  </label>
                </div>
                <div className="loja-checkout-row">
                  <label style={{ flex: 1 }}>Bairro
                    <input
                      value={form.bairro}
                      onChange={e => setForm(p => ({ ...p, bairro: e.target.value }))}
                      placeholder="Centro"
                    />
                  </label>
                  <label style={{ flex: 1 }}>Cidade *
                    <input
                      value={form.cidade}
                      onChange={e => setForm(p => ({ ...p, cidade: e.target.value }))}
                      placeholder="Mossoró"
                    />
                  </label>
                </div>
              </div>
              )}

              {/* Pagamento */}
              <div className="loja-checkout-section">
                <h3>Forma de pagamento</h3>
                <div className="loja-checkout-payment-opts">
                  {[
                    { value: 'pix',         label: 'PIX' },
                    { value: 'pix_entrega', label: 'PIX na entrega' },
                    { value: 'dinheiro',    label: 'Dinheiro' },
                    { value: 'credito',     label: 'Crédito' },
                    { value: 'debito',      label: 'Débito' },
                    { value: 'cartao',      label: 'Cartão' },
                  ].filter(f => formasLoja.includes(f.value)).map(f => {
                    const pct = repassePct(empresa, f.value)
                    return (
                      <button
                        key={f.value}
                        type="button"
                        className={`loja-pay-opt${form.forma === f.value ? ' active' : ''}`}
                        onClick={() => setForm(p => ({ ...p, forma: f.value }))}
                      >
                        {f.label}
                        {pct > 0 && (
                          <span style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: .8 }}>
                            +{String(pct).replace('.', ',')}%
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                {form.forma === 'pix_entrega' && (
                  <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Você paga por PIX na hora em que o pedido chegar, direto para a loja.
                  </p>
                )}
                {pctRepasse > 0 && (
                  <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Esta forma tem acréscimo de {String(pctRepasse).replace('.', ',')}% (taxa da maquineta). Já está no total.
                  </p>
                )}
                {form.forma === 'dinheiro' && (
                  <label>Troco para (opcional)
                    <input
                      value={form.troco}
                      onChange={e => setForm(p => ({ ...p, troco: e.target.value }))}
                      placeholder={`R$ ${Math.ceil(totalFinal + 10)},00`}
                      type="number"
                      step="0.01"
                      min={totalFinal}
                    />
                  </label>
                )}
              </div>

              {/* Observações */}
              <div className="loja-checkout-section">
                <label>Observações (opcional)
                  <textarea
                    value={form.obs}
                    onChange={e => setForm(p => ({ ...p, obs: e.target.value }))}
                    placeholder="Sem cebola, campainha não funciona..."
                    rows={2}
                  />
                </label>
              </div>

              {error && <div className="loja-aviso loja-aviso-erro">{error}</div>}

              <button
                className="loja-btn-confirmar"
                style={{ margin: 0 }}
                onClick={handleConfirmarPedido}
                disabled={enviando}
              >
                {enviando
                  ? <><span className="loja-btn-spinner" /> Enviando...</>
                  : 'Confirmar pedido'
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Card de produto horizontal (iFood style) ── */
function ProdutoCard({ produto: p, qtd, onAdd, onRemove, lojaFechada, precoExibir, aPartirDe = false }) {
  const indisponivel = p.disponivel_delivery === false
  const bloqueado = indisponivel || lojaFechada

  return (
    <div className={`loja-card${bloqueado ? ' indisponivel' : ''}`}>
      <div className="loja-card-info">
        <p className="loja-card-nome">{p.nome}</p>
        {p.descricao && <p className="loja-card-descricao">{p.descricao}</p>}
        {/* un./caixa escondido (13/10/2026): nao faz conta nenhuma no sistema e
            aqui enganava - "12 un." ao lado de um preco que e da unidade. */}
        <p className="loja-card-meta">{p.embalagem}</p>
        <p className="loja-card-preco">
          {aPartirDe && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>a partir de </span>}
          R$ {Number(precoExibir ?? p.preco_venda).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
        </p>
      </div>

      <div className="loja-card-img-wrap">
        {indisponivel && <span className="loja-card-off-badge">Indisponível</span>}

        {p.foto_url
          ? <img className="loja-card-img" src={p.foto_url} alt={p.nome} loading="lazy" />
          : (
            <div className="loja-card-img loja-card-img-placeholder">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </div>
          )
        }

        {qtd === 0
          ? (
            <button
              className="loja-add-btn"
              disabled={bloqueado}
              onClick={() => onAdd(p.produto_id)}
              aria-label={`Adicionar ${p.nome}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          )
          : (
            <div className="loja-qty-overlay">
              <button className="loja-qty-mini-btn" onClick={() => onRemove(p.produto_id)} aria-label="Remover um">−</button>
              <span className="loja-qty-mini-val">{qtd}</span>
              <button className="loja-qty-mini-btn" disabled={lojaFechada} onClick={() => onAdd(p.produto_id)} aria-label="Adicionar um">+</button>
            </div>
          )
        }
      </div>
    </div>
  )
}
