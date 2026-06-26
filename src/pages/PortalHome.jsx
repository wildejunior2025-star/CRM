import { useEffect, useState, useCallback } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useBranding } from '../context/BrandingContext'
import ModalEndereco from '../components/ModalEndereco'
import {
  getEnderecoAtivo,
  salvarEnderecoAtivo, adicionarAoHistorico,
} from '../utils/enderecoPortal'
import './PortalHome.css'

// ── Ícones ──────────────────────────────────────────────────────────────────
function IconLoja({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>
  )
}

function IconMapPin({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 6-8 13-8 13s-8-7-8-13a8 8 0 0 1 16 0Z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}

function IconChevronDown({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  )
}

// ── Helpers de display ───────────────────────────────────────────────────────
function linhaEndereco1(end) {
  if (!end) return null
  const partes = [end.endereco, end.numero].filter(Boolean)
  return partes.join(', ') || end.cep || null
}

function linhaEndereco2(end) {
  if (!end) return null
  const partes = [end.bairro, end.cidade].filter(Boolean)
  return partes.join(', ') || null
}

// ── Geolocalização ───────────────────────────────────────────────────────────
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

// ── Helpers de loja ──────────────────────────────────────────────────────────
const HEARTBEAT_TTL_MS = 2 * 60 * 1000

function lojaOnline(emp) {
  if (!emp.aceita_delivery || !emp.delivery_ativo) return false
  if (!emp.last_heartbeat_at) return false
  return Date.now() - new Date(emp.last_heartbeat_at).getTime() < HEARTBEAT_TTL_MS
}

function StatusPill({ emp }) {
  if (!emp.aceita_delivery) return null
  if (lojaOnline(emp)) return <span className="ph-pill pill-open">Aberta</span>
  return <span className="ph-pill pill-closed">Fechada</span>
}

function CardSkeleton() {
  return (
    <div className="ph-card ph-card--skeleton" aria-hidden="true">
      <div className="ph-card-logo ph-skeleton-box" />
      <div className="ph-card-body">
        <div className="ph-skeleton-line" style={{ width: '60%', height: 14, marginBottom: 8 }} />
        <div className="ph-skeleton-line" style={{ width: '85%', height: 12, marginBottom: 4 }} />
        <div className="ph-skeleton-line" style={{ width: '50%', height: 12, marginBottom: 12 }} />
        <div className="ph-skeleton-line" style={{ width: 52, height: 18, borderRadius: 99 }} />
      </div>
    </div>
  )
}

// ── Modal completar cadastro (Google login sem telefone/endereço) ─────────────
function ModalCompletarCadastro({ onSalvo }) {
  const [telefone, setTelefone] = useState('')
  const [cep, setCep]           = useState('')
  const [endereco, setEndereco] = useState('')
  const [numero, setNumero]     = useState('')
  const [bairro, setBairro]     = useState('')
  const [cidade, setCidade]     = useState('')
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro]         = useState(null)

  async function buscarCep(v) {
    if (v.length < 8) return
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${v}/json/`)
      const d = await res.json()
      if (!d.erro) {
        setEndereco(d.logradouro || '')
        setBairro(d.bairro || '')
        setCidade(d.localidade || '')
      }
    } catch { /* ignora */ }
    setBuscandoCep(false)
  }

  function handleCep(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    setCep(v.length > 5 ? `${v.slice(0,5)}-${v.slice(5)}` : v)
    if (v.length === 8) buscarCep(v)
  }

  async function handleSalvar() {
    if (!telefone.trim()) { setErro('WhatsApp é obrigatório.'); return }
    if (!cidade.trim())   { setErro('Informe pelo menos a cidade.'); return }
    setSalvando(true)
    setErro(null)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setErro('Sessão expirada. Faça login novamente.'); setSalvando(false); return }

    const tel = telefone.replace(/\D/g, '')
    // Atualiza ou insere na tabela clientes
    const { data: existente } = await supabase.from('clientes').select('id').eq('user_id', user.id).maybeSingle()
    if (existente) {
      await supabase.from('clientes').update({ telefone: tel, cep, endereco, numero, bairro, cidade }).eq('user_id', user.id)
    } else {
      await supabase.from('clientes').insert({ user_id: user.id, email: user.email, nome: user.user_metadata?.full_name || user.email, telefone: tel, cep, endereco, numero, bairro, cidade, tipo: 'pf', condicao_pagamento: 'a_vista', limite_credito: 0, desconto_percentual: 0, desconto_minimo_pedido: 0 })
    }
    // Atualiza telefone no profile
    await supabase.from('profiles').update({ telefone: tel }).eq('id', user.id)

    const end = { cep, endereco, numero, bairro, cidade }
    salvarEnderecoAtivo(end)
    adicionarAoHistorico(end)
    onSalvo(end)
    setSalvando(false)
  }

  return (
    <div className="pp-modal-overlay">
      <div className="pp-modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <p className="pp-modal-titulo">Complete seu cadastro</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Para fazer pedidos precisamos do seu WhatsApp e endereço de entrega.
        </p>

        <div className="pp-modal-field">
          <label className="pp-modal-label">WhatsApp *</label>
          <input className="pp-modal-textarea" style={{ height: 'auto', padding: '10px 12px' }}
            type="tel" placeholder="(84) 99999-9999"
            value={telefone} onChange={e => setTelefone(e.target.value)} />
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">CEP {buscandoCep && <span style={{ fontWeight: 400, fontSize: 11 }}>Buscando...</span>}</label>
          <input className="pp-modal-textarea" style={{ height: 'auto', padding: '10px 12px' }}
            type="text" placeholder="00000-000" value={cep} onChange={handleCep} inputMode="numeric" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <div className="pp-modal-field">
            <label className="pp-modal-label">Rua / Av.</label>
            <input className="pp-modal-textarea" style={{ height: 'auto', padding: '10px 12px' }}
              type="text" placeholder="Rua das Flores" value={endereco} onChange={e => setEndereco(e.target.value)} />
          </div>
          <div className="pp-modal-field" style={{ width: 80 }}>
            <label className="pp-modal-label">Nº</label>
            <input className="pp-modal-textarea" style={{ height: 'auto', padding: '10px 12px' }}
              type="text" placeholder="123" value={numero} onChange={e => setNumero(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div className="pp-modal-field">
            <label className="pp-modal-label">Bairro</label>
            <input className="pp-modal-textarea" style={{ height: 'auto', padding: '10px 12px' }}
              type="text" placeholder="Centro" value={bairro} onChange={e => setBairro(e.target.value)} />
          </div>
          <div className="pp-modal-field">
            <label className="pp-modal-label">Cidade *</label>
            <input className="pp-modal-textarea" style={{ height: 'auto', padding: '10px 12px' }}
              type="text" placeholder="São Paulo" value={cidade} onChange={e => setCidade(e.target.value)} />
          </div>
        </div>

        {erro && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }}>{erro}</p>}

        <div className="pp-modal-actions" style={{ marginTop: 8 }}>
          <button type="button" className="pp-modal-btn-danger"
            style={{ background: 'var(--primary)', borderColor: 'var(--primary)', flex: 1 }}
            disabled={salvando} onClick={handleSalvar}>
            {salvando ? 'Salvando...' : 'Salvar e continuar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function PortalHome() {
  const [empresas, setEmpresas] = useState([])
  const [loading, setLoading]   = useState(true)
  const [busca, setBusca]       = useState('')
  const [showEnderecoModal, setShowEnderecoModal] = useState(false)
  const [enderecoAtivo, setEnderecoAtivo] = useState(() => getEnderecoAtivo())
  const [coordsCliente, setCoordsCliente] = useState(null)
  const navigate = useNavigate()
  const { empresaParceira, loadingBranding } = useBranding()

  const handleSalvo = useCallback((end) => {
    setEnderecoAtivo(end)
  }, [])

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('empresas')
        .select('id, nome, email_contato, status, created_at, banner_url, logo_url, descricao, delivery_ativo, aceita_delivery, last_heartbeat_at, latitude, longitude, raio_entrega_km')
        .in('status', ['trial', 'ativo', 'atrasado'])
        .eq('aceita_delivery', true)
        .order('nome')
      setEmpresas(data ?? [])
      setLoading(false)

      // Se já tem endereço ativo (localStorage), o filtro por raio é resolvido
      // pelo efeito de geocodificação abaixo. Senão, puxa do cadastro do cliente.
      if (getEnderecoAtivo()) return

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Cliente do app (portal) guarda o endereço em profiles; cliente vinculado
      // a uma loja guarda em clientes. Tenta profiles primeiro, depois clientes.
      const { data: prof } = await supabase
        .from('profiles')
        .select('cep, cidade, endereco, numero, bairro')
        .eq('id', user.id)
        .maybeSingle()

      let src = (prof?.cep || prof?.cidade || prof?.endereco) ? prof : null
      if (!src) {
        const { data: cli } = await supabase
          .from('clientes')
          .select('cep, cidade, endereco, numero, bairro')
          .eq('user_id', user.id)
          .maybeSingle()
        if (cli?.cep || cli?.cidade || cli?.endereco) src = cli
      }

      if (src) {
        const end = {
          cep:      src.cep      || '',
          endereco: src.endereco || '',
          numero:   src.numero   || '',
          bairro:   src.bairro   || '',
          cidade:   src.cidade   || '',
        }
        salvarEnderecoAtivo(end)
        adicionarAoHistorico(end)
        setEnderecoAtivo(end)
      }
    }
    load()
  }, [])

  // Geocodifica o endereço ativo do cliente para o filtro por raio.
  // Reativo: roda no 1º carregamento e sempre que o cliente troca de endereço.
  useEffect(() => {
    if (!enderecoAtivo) { setCoordsCliente(null); return }
    const endStr = [enderecoAtivo.endereco, enderecoAtivo.numero, enderecoAtivo.bairro, enderecoAtivo.cidade]
      .filter(Boolean).join(', ')
    if (!endStr) { setCoordsCliente(null); return }
    let cancelado = false
    geocodificar(endStr).then(coords => { if (!cancelado && coords) setCoordsCliente(coords) })
    return () => { cancelado = true }
  }, [enderecoAtivo])

  if (!loadingBranding && empresaParceira) {
    return <Navigate to={`/portal/loja/${empresaParceira.id}`} replace />
  }

  const filtradas = empresas.filter(e => {
    // Filtro por nome
    if (busca.trim() && !e.nome.toLowerCase().includes(busca.trim().toLowerCase())) return false
    // Filtro por raio — só aplica se cliente e loja têm coordenadas
    if (coordsCliente && e.latitude && e.longitude && e.raio_entrega_km) {
      const dist = haversineKm(coordsCliente.lat, coordsCliente.lng, Number(e.latitude), Number(e.longitude))
      if (dist > Number(e.raio_entrega_km)) return false
    }
    return true
  })

  return (
    <div className="ph-root">
      {showEnderecoModal && (
        <ModalEndereco
          onClose={() => setShowEnderecoModal(false)}
          onSalvo={handleSalvo}
        />
      )}

      {/* Busca */}
      <div className="ph-search-wrap">
        <span className="ph-search-icon"><IconSearch /></span>
        <input
          className="ph-search"
          placeholder="Buscar loja..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
        />
      </div>

      <h2 className="ph-section-title">Lojas</h2>

      {loading && (
        <div className="ph-grid">
          {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      )}

      {!loading && filtradas.length === 0 && (
        <div className="ph-empty">
          <span className="ph-empty-icon"><IconLoja size={32} /></span>
          <p className="ph-empty-title">
            {busca.trim() ? 'Nenhuma loja encontrada' : 'Nenhuma loja disponível'}
          </p>
          {busca.trim() && (
            <p className="ph-empty-sub">Tente outro termo de busca.</p>
          )}
        </div>
      )}

      {!loading && filtradas.length > 0 && (
        <div className="ph-grid">
          {filtradas.map(emp => {
            const fechada = emp.aceita_delivery && !lojaOnline(emp)
            return (
              <button
                key={emp.id}
                className={`ph-card${fechada ? ' ph-card--fechada' : ''}`}
                onClick={() => navigate(`/portal/loja/${emp.id}`)}
              >
                <div className="ph-card-logo">
                  {emp.logo_url
                    ? <img src={emp.logo_url} alt={emp.nome} className="ph-card-logo-img" />
                    : (
                      <div className="ph-card-logo-placeholder">
                        <IconLoja size={28} />
                      </div>
                    )
                  }
                  {fechada && <span className="ph-fechada-overlay">Fechada</span>}
                </div>
                <div className="ph-card-body">
                  <p className="ph-card-nome">{emp.nome}</p>
                  {emp.descricao && <p className="ph-card-desc">{emp.descricao}</p>}
                  <StatusPill emp={emp} />
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
