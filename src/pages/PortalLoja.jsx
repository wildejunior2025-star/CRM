import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../context/BrandingContext'
import { getEnderecoAtivo } from '../utils/enderecoPortal'
import './PortalLoja.css'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'

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
      headers: { 'User-Agent': 'CRM-VendaMais/1.0' }
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
  const { empresaId } = useParams()
  const navigate = useNavigate()
  useAuth()
  const { empresaParceira } = useBranding()
  const dominioExclusivo = !!empresaParceira

  const SACOLA_KEY = `sacola_portal_${empresaId}`

  const [empresa, setEmpresa] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [totalProdutos, setTotalProdutos] = useState(0)
  const [carregandoMais, setCarregandoMais] = useState(false)
  const [carrinho, setCarrinho] = useState(() => {
    try {
      const saved = localStorage.getItem(`sacola_portal_${empresaId}`)
      return saved ? JSON.parse(saved) : {}
    } catch { return {} /* localStorage indisponível */ }
  })
  const [categoriaAtiva, setCategoriaAtiva] = useState('Todos')
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
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep, setErroCep] = useState(null)
  const [pixData, setPixData] = useState(null)
  const [taxaCalculada, setTaxaCalculada]   = useState(null)  // null = ainda não calculada por km
  const [tempoCalculado, setTempoCalculado] = useState(null)  // tempo estimado pela faixa

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
        .select('id, nome, slug, banner_url, logo_url, descricao, taxa_entrega, taxas_entrega_km, tempo_entrega_min, tempo_entrega_max, aceita_delivery, delivery_ativo, last_heartbeat_at, cidade, latitude, longitude, raio_entrega_km')
      const empRes = await (isUuid ? baseQuery.eq('id', empresaId) : baseQuery.eq('slug', empresaId)).maybeSingle()
      if (empRes.error) { setError(empRes.error.message); setLoading(false); return }
      const resolvedId = empRes.data?.id ?? empresaId
      const prodRes = await supabase
        .from('estoque_catalogo').select('*', { count: 'exact' })
        .eq('empresa_id', resolvedId).order('categoria').order('nome').range(0, 199)
      if (prodRes.error) setError(prodRes.error.message)
      setEmpresa(empRes.data ?? null)
      setProdutos(prodRes.data ?? [])
      setTotalProdutos(prodRes.count ?? 0)
      setLoading(false)
    }
    load()
  }, [empresaId])

  useEffect(() => {
    async function loadCliente() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const [{ data: cliente }, { data: profile }] = await Promise.all([
        supabase.from('clientes')
          .select('id, nome, telefone, cep, endereco, numero, complemento, bairro, cidade')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase.from('profiles')
          .select('nome, telefone')
          .eq('id', user.id)
          .maybeSingle(),
      ])
      if (cliente) setClienteProfile(cliente)
      const d = cliente ?? profile
      const endLocal = getEnderecoAtivo()
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
  function addOne(id) { setCarrinho(p => ({ ...p, [id]: (p[id] ?? 0) + 1 })) }
  function removeOne(id) {
    setCarrinho(p => {
      const n = { ...p }
      if ((n[id] ?? 0) <= 1) delete n[id]
      else n[id]--
      return n
    })
  }

  const itensCarrinho = Object.entries(carrinho)
    .map(([id, qtd]) => ({ produto: produtos.find(p => p.produto_id === id), qtd }))
    .filter(i => i.produto)

  const totalItens = itensCarrinho.reduce((s, i) => s + i.qtd, 0)
  const totalValor = itensCarrinho.reduce((s, i) => s + i.qtd * Number(i.produto.preco_venda), 0)
  const temFaixasKm = Array.isArray(empresa?.taxas_entrega_km) && empresa.taxas_entrega_km.length > 0
  const taxa = taxaCalculada !== null ? taxaCalculada : (temFaixasKm ? null : Number(empresa?.taxa_entrega ?? 0))
  const totalComTaxa = totalValor + (taxa ?? 0)

  /* ── Carregar mais produtos ── */
  async function carregarMais() {
    if (!empresa?.id) return
    setCarregandoMais(true)
    const { data } = await supabase
      .from('estoque_catalogo')
      .select('*')
      .eq('empresa_id', empresa.id)
      .order('categoria').order('nome')
      .range(produtos.length, produtos.length + 199)
    setProdutos(prev => [...prev, ...(data ?? [])])
    setCarregandoMais(false)
  }

  /* ── Categorias ── */
  const categorias = ['Todos', ...new Set(produtos.map(p => p.categoria).filter(Boolean))]

  /* ── Filtro ── */
  const produtosFiltrados = produtos.filter(p => {
    const matchCategoria = categoriaAtiva === 'Todos' || p.categoria === categoriaAtiva
    const termo = busca.trim().toLowerCase()
    const matchBusca = !termo || p.nome?.toLowerCase().includes(termo) || p.descricao?.toLowerCase().includes(termo)
    return matchCategoria && matchBusca
  })

  /* ── Agrupamento por categoria ── */
  const categoriasDeProdutos = categorias.filter(c => c !== 'Todos')
  const secoes = categoriaAtiva === 'Todos'
    ? categoriasDeProdutos
        .map(cat => ({ nome: cat, produtos: produtosFiltrados.filter(p => p.categoria === cat) }))
        .filter(s => s.produtos.length > 0)
    : [{ nome: categoriaAtiva, produtos: produtosFiltrados }].filter(s => s.produtos.length > 0)

  const semCategoria = produtosFiltrados.filter(p => !p.categoria)

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

    // Valida raio + calcula taxa por km se configurada
    if (precisaEndereco && empresa?.latitude && empresa?.longitude) {
      const endStr = [form.rua, form.numero, form.bairro, form.cidade].filter(Boolean).join(', ')
      const coords = await geocodificar(endStr)
      if (coords) {
        const dist = haversineKm(coords.lat, coords.lng, Number(empresa.latitude), Number(empresa.longitude))

        // Bloqueia se fora do raio
        if (empresa.raio_entrega_km && dist > Number(empresa.raio_entrega_km)) {
          setError(`Infelizmente não entregamos no seu endereço ainda 😕 (${dist.toFixed(1)} km — raio máximo: ${empresa.raio_entrega_km} km)`)
          return
        }

        // Calcula taxa por faixas de km se configurado
        const faixas = Array.isArray(empresa.taxas_entrega_km) ? empresa.taxas_entrega_km : []
        if (faixas.length > 0) {
          const ordenadas = [...faixas].sort((a, b) => a.km - b.km)
          const faixa = ordenadas.find(f => dist <= Number(f.km)) ?? ordenadas[ordenadas.length - 1]
          setTaxaCalculada(Number(faixa.taxa))
          if (faixa.tempo != null && faixa.tempo !== '') setTempoCalculado(Number(faixa.tempo))
        }
      }
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

    const itens = itensCarrinho.map(i => ({
      produto_id: i.produto.produto_id,
      nome: i.produto.nome,
      quantidade: i.qtd,
      preco_unitario: Number(i.produto.preco_venda),
      subtotal: i.qtd * Number(i.produto.preco_venda),
    }))

    const isRetirada = form.tipo_entrega === 'retirada'

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
      taxa_entrega:         isRetirada ? 0 : (taxa ?? 0),
      total:                isRetirada ? totalValor : totalValor + (taxa ?? 0),
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
        <div className="loja-categorias">
          {categorias.map(cat => (
            <button
              key={cat}
              className={`loja-cat-pill${categoriaAtiva === cat ? ' active' : ''}`}
              onClick={() => setCategoriaAtiva(cat)}
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
              <section key={secao.nome} className="loja-secao">
                <h3 className="loja-secao-titulo">{secao.nome}</h3>
                <div className="loja-lista">
                  {secao.produtos.map(p => (
                    <ProdutoCard
                      key={p.produto_id}
                      produto={p}
                      qtd={carrinho[p.produto_id] ?? 0}
                      onAdd={addOne}
                      onRemove={removeOne}
                      lojaFechada={lojaFechada}
                    />
                  ))}
                </div>
              </section>
            ))}

            {semCategoria.length > 0 && (
              <section className="loja-secao">
                <h3 className="loja-secao-titulo">Outros</h3>
                <div className="loja-lista">
                  {semCategoria.map(p => (
                    <ProdutoCard
                      key={p.produto_id}
                      produto={p}
                      qtd={carrinho[p.produto_id] ?? 0}
                      onAdd={addOne}
                      onRemove={removeOne}
                      lojaFechada={lojaFechada}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {produtos.length < totalProdutos && !busca && categoriaAtiva === 'Todos' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <button
              className="btn btn-secondary"
              onClick={carregarMais}
              disabled={carregandoMais}
            >
              {carregandoMais ? 'Carregando...' : `Carregar mais (${totalProdutos - produtos.length} restantes)`}
            </button>
          </div>
        )}
      </div>

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
              {itensCarrinho.map(({ produto, qtd }) => (
                <div key={produto.produto_id} className="loja-drawer-item">
                  <div className="loja-drawer-item-info">
                    <span className="loja-drawer-item-nome">{produto.nome}</span>
                    <span className="loja-drawer-item-sub">
                      R$ {Number(produto.preco_venda).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} cada
                    </span>
                  </div>
                  <div className="loja-qty-ctrl">
                    <button className="loja-qty-btn" onClick={() => removeOne(produto.produto_id)}>−</button>
                    <span className="loja-qty-val">{qtd}</span>
                    <button className="loja-qty-btn" onClick={() => addOne(produto.produto_id)}>+</button>
                  </div>
                  <span className="loja-drawer-item-total">
                    R$ {(qtd * Number(produto.preco_venda)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
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
                {itensCarrinho.map(({ produto, qtd }) => (
                  <div key={produto.produto_id} className="loja-checkout-item">
                    <span>{qtd}× {produto.nome}</span>
                    <span>R$ {(qtd * Number(produto.preco_venda)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
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
                <div className="loja-checkout-total">
                  <span>Total</span>
                  <strong>R$ {totalComTaxa.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
                </div>
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

              {/* Tipo de pedido */}
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
                  <button
                    type="button"
                    className={`loja-pay-opt${form.forma === 'pix' ? ' active' : ''}`}
                    onClick={() => setForm(p => ({ ...p, forma: 'pix' }))}
                  >
                    Pix
                  </button>
                  <button
                    type="button"
                    className={`loja-pay-opt${form.forma === 'dinheiro' ? ' active' : ''}`}
                    onClick={() => setForm(p => ({ ...p, forma: 'dinheiro' }))}
                  >
                    Dinheiro
                  </button>
                  <button
                    type="button"
                    className={`loja-pay-opt${form.forma === 'cartao' ? ' active' : ''}`}
                    onClick={() => setForm(p => ({ ...p, forma: 'cartao' }))}
                  >
                    Cartão
                  </button>
                </div>
                {form.forma === 'dinheiro' && (
                  <label>Troco para (opcional)
                    <input
                      value={form.troco}
                      onChange={e => setForm(p => ({ ...p, troco: e.target.value }))}
                      placeholder={`R$ ${Math.ceil(totalComTaxa + 10)},00`}
                      type="number"
                      step="0.01"
                      min={totalComTaxa}
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
function ProdutoCard({ produto: p, qtd, onAdd, onRemove, lojaFechada }) {
  const indisponivel = p.disponivel_delivery === false
  const bloqueado = indisponivel || lojaFechada

  return (
    <div className={`loja-card${bloqueado ? ' indisponivel' : ''}`}>
      <div className="loja-card-info">
        <p className="loja-card-nome">{p.nome}</p>
        {p.descricao && <p className="loja-card-descricao">{p.descricao}</p>}
        <p className="loja-card-meta">
          {[p.embalagem, p.unidades_por_caixa > 1 ? `${p.unidades_por_caixa} un.` : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="loja-card-preco">
          R$ {Number(p.preco_venda).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
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
