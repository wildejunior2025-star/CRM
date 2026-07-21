import { useState, useEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { getEnderecoAtivo } from '../utils/enderecoPortal'
import { registrarPedido } from '../lib/meusPedidos'
import 'leaflet/dist/leaflet.css'
import './DeliveryCheckout.css'

// Cliente lembrado no aparelho (Opção A — login sem senha)
const LS_CLIENTE = 'lojaonline_cliente'

const ESTADOS_BR = [
  { uf: 'AC', nome: 'Acre' },
  { uf: 'AL', nome: 'Alagoas' },
  { uf: 'AP', nome: 'Amapá' },
  { uf: 'AM', nome: 'Amazonas' },
  { uf: 'BA', nome: 'Bahia' },
  { uf: 'CE', nome: 'Ceará' },
  { uf: 'DF', nome: 'Distrito Federal' },
  { uf: 'ES', nome: 'Espírito Santo' },
  { uf: 'GO', nome: 'Goiás' },
  { uf: 'MA', nome: 'Maranhão' },
  { uf: 'MT', nome: 'Mato Grosso' },
  { uf: 'MS', nome: 'Mato Grosso do Sul' },
  { uf: 'MG', nome: 'Minas Gerais' },
  { uf: 'PA', nome: 'Pará' },
  { uf: 'PB', nome: 'Paraíba' },
  { uf: 'PR', nome: 'Paraná' },
  { uf: 'PE', nome: 'Pernambuco' },
  { uf: 'PI', nome: 'Piauí' },
  { uf: 'RJ', nome: 'Rio de Janeiro' },
  { uf: 'RN', nome: 'Rio Grande do Norte' },
  { uf: 'RS', nome: 'Rio Grande do Sul' },
  { uf: 'RO', nome: 'Rondônia' },
  { uf: 'RR', nome: 'Roraima' },
  { uf: 'SC', nome: 'Santa Catarina' },
  { uf: 'SP', nome: 'São Paulo' },
  { uf: 'SE', nome: 'Sergipe' },
  { uf: 'TO', nome: 'Tocantins' },
]

function IconArrowLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

function IconPix() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 7 10 10M17 7 7 17" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

function IconMoney() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  )
}

function IconCard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function fmt(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTelefone(val) {
  const digits = val.replace(/\D/g, '').slice(0, 11)
  if (digits.length <= 2) return digits
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
}

// ── Taxa de entrega por distância (mesma regra do gestor/bot) ────────────────
// Normaliza bairro pra casar cliente <-> config (mesma regra da tela Raio de Entrega).
function normBairro(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/^bairro\s+/, '').replace(/\s+/g, ' ')
}
function acharBairroCfg(lista, bairroCliente) {
  if (!Array.isArray(lista) || !bairroCliente) return null
  const n = normBairro(bairroCliente)
  return lista.find(b => normBairro(b.bairro) === n) || null
}
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function calcTaxaKm(faixas, distKm) {
  const arr = Array.isArray(faixas) ? [...faixas].sort((a, b) => a.km - b.km) : []
  if (!arr.length) return null
  const faixa = arr.find(f => distKm <= Number(f.km)) ?? arr[arr.length - 1]
  return Number(faixa.taxa) || 0
}
async function geocodeEndereco({ rua, numero, bairro, cidade, estado, cep } = {}) {
  const uf = estado || ''
  const cepLimpo = String(cep || '').replace(/\D/g, '')
  // 1) Busca ESTRUTURADA com o CEP — bem mais precisa que a busca por texto
  //    (ajuda em endereços que a busca livre erra, tipo em São Gonçalo/RN).
  if (cepLimpo.length === 8) {
    try {
      const params = new URLSearchParams({
        street: [numero, rua].filter(Boolean).join(' '),
        city: cidade || '', state: uf, postalcode: cepLimpo,
        country: 'Brazil', format: 'json', limit: '1',
      })
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'User-Agent': 'CRM-FWC/1.0' } })
      const d = await res.json()
      if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
    } catch { /* cai no fallback */ }
  }
  // 2) Fallback: busca livre por texto (com o CEP junto quando tiver)
  try {
    const q = [rua, numero, bairro, cidade, uf, cepLimpo].filter(s => s && String(s).trim()).join(', ')
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Brasil')}&format=json&limit=1`, { headers: { 'User-Agent': 'CRM-FWC/1.0' } })
    const d = await res.json()
    if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  } catch { /* ignora */ }
  return null
}
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`, { headers: { 'User-Agent': 'CRM-FWC/1.0' } })
    const d = await res.json()
    const a = d?.address ?? {}
    return {
      rua: a.road || a.pedestrian || a.footway || '',
      bairro: a.suburb || a.neighbourhood || a.village || a.quarter || '',
      cidade: a.city || a.town || a.municipality || a.county || '',
      estado: String(a['ISO3166-2-lvl4'] || '').split('-')[1] || '',
      cep: String(a.postcode || '').replace(/\D/g, ''),
    }
  } catch { return null }
}

// ── Modal do mapa: cliente arrasta o pino até a casa (ponto exato) ───────────
function MapaLocalizador({ storeLat, storeLng, raioKm, taxas, initial, endereco, onConfirm, onClose }) {
  const mapRef = useRef(null)
  const mapObj = useRef(null)
  const pinRef = useRef(null)
  const interagiu = useRef(false) // cliente já mexeu no pino (arrasto/clique/GPS)?
  const [coord, setCoord] = useState(initial || (storeLat ? { lat: Number(storeLat), lng: Number(storeLng) } : null))
  const [locLoading, setLocLoading] = useState(false)
  const [geoLoading, setGeoLoading] = useState(false)
  // O pino saiu do ponto inicial (loja)? Só deixa confirmar depois que o local
  // for definido de fato — pelo endereço geocodificado, por arrastar, clicar ou
  // GPS. Sem isso o cliente confirmava o pino parado em cima da loja.
  const [definido, setDefinido] = useState(!!initial)

  useEffect(() => {
    let cancelado = false
    async function init() {
      const L = (await import('leaflet')).default
      if (cancelado || !mapRef.current || mapObj.current) return
      const c = coord || { lat: Number(storeLat), lng: Number(storeLng) }
      const map = L.map(mapRef.current, { zoomControl: true }).setView([c.lat, c.lng], 15)
      mapObj.current = map
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
      if (storeLat && storeLng) {
        const lojaIcon = L.divIcon({ html: `<div style="width:32px;height:32px;background:#7c3aed;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:16px;">🏪</div>`, className: '', iconSize: [32, 32], iconAnchor: [16, 16] })
        L.marker([Number(storeLat), Number(storeLng)], { icon: lojaIcon, interactive: false }).addTo(map)
        if (raioKm) L.circle([Number(storeLat), Number(storeLng)], { radius: raioKm * 1000, color: '#7c3aed', weight: 1.5, fillColor: '#7c3aed', fillOpacity: 0.06 }).addTo(map)
      }
      const pinIcon = L.divIcon({ html: `<div style="width:34px;height:34px;background:#ef4444;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.4);"></div>`, className: '', iconSize: [34, 34], iconAnchor: [17, 32] })
      pinRef.current = L.marker([c.lat, c.lng], { icon: pinIcon, draggable: true }).addTo(map)
      pinRef.current.on('dragend', e => { interagiu.current = true; const { lat, lng } = e.target.getLatLng(); setCoord({ lat, lng }); setDefinido(true) })
      map.on('click', e => { interagiu.current = true; const { lat, lng } = e.latlng; pinRef.current.setLatLng([lat, lng]); setCoord({ lat, lng }); setDefinido(true) })

      // Sem ponto ainda? Tenta achar pelo endereço digitado (CEP/rua) e já leva o
      // pino pra lá — assim ele nasce perto da casa, não parado na loja.
      if (!initial && endereco && (endereco.rua || endereco.cep)) {
        setGeoLoading(true)
        geocodeEndereco(endereco).then(g => {
          setGeoLoading(false)
          // Se o cliente já arrastou enquanto isto carregava, não desmancha o que ele fez.
          if (cancelado || !g || !mapObj.current || interagiu.current) return
          pinRef.current.setLatLng([g.lat, g.lng])
          mapObj.current.setView([g.lat, g.lng], 16)
          setCoord({ lat: g.lat, lng: g.lng })
          setDefinido(true)
        }).catch(() => setGeoLoading(false))
      }
    }
    init()
    return () => { cancelado = true; if (mapObj.current) { mapObj.current.remove(); mapObj.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function usarMinhaLocalizacao() {
    if (!navigator.geolocation) return
    setLocLoading(true)
    navigator.geolocation.getCurrentPosition(
      pos => {
        interagiu.current = true
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setCoord(c); setLocLoading(false); setDefinido(true)
        if (pinRef.current) pinRef.current.setLatLng([c.lat, c.lng])
        if (mapObj.current) mapObj.current.setView([c.lat, c.lng], 17)
      },
      () => setLocLoading(false),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  const dist = coord && storeLat ? haversineKm(coord.lat, coord.lng, Number(storeLat), Number(storeLng)) : null
  const taxa = dist != null ? calcTaxaKm(taxas, dist) : null
  const foraRaio = dist != null && raioKm && dist > Number(raioKm)

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }} onClick={onClose}>
      <div style={{ width: '100%', maxWidth: 560, background: 'var(--surface,#16161f)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '92vh' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid var(--border,#2a2a3a)' }}>
          <strong style={{ fontSize: 15, color: 'var(--text,#fff)' }}>📍 Marque o ponto exato da entrega</strong>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted,#9aa)', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        <div ref={mapRef} style={{ width: '100%', height: '58vh', minHeight: 300 }} />
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border,#2a2a3a)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={usarMinhaLocalizacao} style={{ padding: '9px 14px', borderRadius: 10, border: '1.5px solid #7c3aed', background: 'rgba(124,58,237,.12)', color: '#a78bfa', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>
              {locLoading ? 'Localizando…' : '🎯 Usar minha localização'}
            </button>
            <div style={{ fontSize: 14, color: foraRaio ? '#f87171' : 'var(--text,#fff)', fontWeight: 600 }}>
              {geoLoading ? 'Procurando o endereço…'
                : !definido ? '👆 Arraste o pino até sua casa'
                : dist != null ? <>📏 {dist.toFixed(1)} km · <strong style={{ color: '#34d399' }}>Taxa {taxa != null ? `R$ ${fmt(taxa)}` : '—'}</strong>{foraRaio ? ' · ⚠️ fora do raio' : ''}</> : 'Arraste o pino até sua casa'}
            </div>
          </div>
          {/* Sem local definido = pino ainda parado na loja. Bloqueia pra não
              gravar o endereço da loja no lugar do endereço do cliente. */}
          <button type="button" onClick={() => coord && definido && onConfirm({ lat: coord.lat, lng: coord.lng, dist, taxa })} disabled={!coord || !definido}
            style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: (coord && definido) ? '#7c3aed' : '#4b3a7a', color: '#fff', fontWeight: 800, fontSize: 15, cursor: (coord && definido) ? 'pointer' : 'not-allowed' }}>
            {definido ? 'Confirmar este local' : 'Arraste o pino até sua casa'}
          </button>
        </div>
      </div>
    </div>
  )
}

const INITIAL_FORM = {
  nome: '',
  telefone: '',
  email: '',
  cep: '',
  rua: '',
  numero: '',
  complemento: '',
  estado: '',
  cidade: '',
  bairro: '',
  pagamento: 'dinheiro',
  troco: '',
  observacoes: '',
}

export default function DeliveryCheckout() {
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state

  // Rascunho salvo no navegador — se o cliente sair e voltar, não perde o que
  // digitou (e lembra os dados na próxima compra). Chave global (é o dado do
  // próprio cliente, serve pra qualquer loja).
  const [form, setForm]         = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem('fwc_checkout_draft') || 'null')
      return d?.form ? { ...INITIAL_FORM, ...d.form } : INITIAL_FORM
    } catch { return INITIAL_FORM }
  })
  const [tipo, setTipo]         = useState(() => {
    try {
      const d = JSON.parse(localStorage.getItem('fwc_checkout_draft') || 'null')
      return d?.tipo ?? 'entrega'
    } catch { return 'entrega' }
  }) // 'entrega' | 'retirada'
  const [lojaEndereco, setLojaEndereco] = useState(null)
  const [errors, setErrors]     = useState({})
  const [enviando, setEnviando] = useState(false)
  const [erroGlobal, setErroGlobal] = useState(null)
  const [cidades, setCidades]       = useState([])
  const [loadingCidades, setLoadingCidades] = useState(false)
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep, setErroCep]     = useState(null)
  // O que o ViaCEP devolveu pro último CEP válido — pra avisar se a rua/bairro
  // digitados não baterem (caso do endereço trocado na mão).
  const [cepInfo, setCepInfo] = useState(null) // { cep, rua, bairro }
  const [userId, setUserId]         = useState(null)
  const [reconhecido, setReconhecido] = useState(false) // cadastro achado pelo telefone
  const [reconfirmar, setReconfirmar] = useState(false) // só a minoria com endereço errado: obriga remarcar o pino uma vez
  const [coordCliente, setCoordCliente] = useState(null) // {lat,lng} do ponto de entrega
  const [mapaAberto, setMapaAberto]     = useState(false)
  const pinManualRef = useRef(false) // true quando o cliente marcou no mapa (não sobrescreve com geocode)

  // Salva o rascunho a cada mudança (sobrevive a sair/voltar da tela).
  useEffect(() => {
    try { localStorage.setItem('fwc_checkout_draft', JSON.stringify({ form, tipo })) } catch { /* ignore */ }
  }, [form, tipo])

  useEffect(() => {
    async function loadPerfil() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUserId(user.id)
      const [{ data: cliente }, { data: profile }] = await Promise.all([
        supabase.from('clientes')
          .select('nome, telefone, cep, endereco, numero, complemento, bairro, cidade')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase.from('profiles')
          .select('nome, telefone')
          .eq('id', user.id)
          .maybeSingle(),
      ])
      const d = cliente ?? profile
      const endLocal = getEnderecoAtivo()
      if (d || endLocal) {
        setForm(prev => ({
          ...prev,
          nome:        d?.nome        || prev.nome,
          telefone:    d?.telefone    ? fmtTelefone(d.telefone) : prev.telefone,
          cep:         d?.cep         || endLocal?.cep         || prev.cep,
          rua:         d?.endereco    || endLocal?.endereco    || prev.rua,
          numero:      d?.numero      || endLocal?.numero      || prev.numero,
          complemento: d?.complemento || endLocal?.complemento || prev.complemento,
          bairro:      d?.bairro      || endLocal?.bairro      || prev.bairro,
          cidade:      d?.cidade      || endLocal?.cidade      || prev.cidade,
        }))
      }
    }
    loadPerfil()
  }, [])

  // Endereço da loja — mostrado quando o cliente escolhe Retirada
  useEffect(() => {
    if (!state?.empresaId) return
    supabase.from('empresas')
      .select('endereco, bairro, cidade, estado, latitude, longitude, taxas_entrega_km, taxas_entrega_bairro, raio_entrega_km, pedido_minimo')
      .eq('id', state.empresaId)
      .maybeSingle()
      .then(({ data }) => setLojaEndereco(data ?? null))
  }, [state?.empresaId])

  // Opção A — pré-preenche com o cliente lembrado neste aparelho
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_CLIENTE) || 'null')
      if (saved && typeof saved === 'object') {
        setForm(prev => ({
          ...prev,
          nome:        prev.nome        || saved.nome        || '',
          telefone:    prev.telefone    || (saved.telefone ? fmtTelefone(saved.telefone) : ''),
          email:       prev.email       || saved.email       || '',
          cep:         prev.cep         || saved.cep         || '',
          rua:         prev.rua         || saved.rua         || '',
          numero:      prev.numero      || saved.numero      || '',
          complemento: prev.complemento || saved.complemento || '',
          estado:      prev.estado      || saved.estado      || '',
          cidade:      prev.cidade      || saved.cidade      || '',
          bairro:      prev.bairro      || saved.bairro      || '',
        }))
        if (saved.estado) carregarCidades(saved.estado, saved.cidade)
      }
    } catch { /* ignora */ }
  }, [])

  // Reconhece o cliente pelo telefone (recuperar em outro aparelho, sem senha)
  const reconhecidoRef = useRef(false)
  useEffect(() => {
    const empId = state?.empresaId
    const tel = form.telefone.replace(/\D/g, '')
    if (!empId || tel.length < 10 || reconhecidoRef.current) return
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc('buscar_cliente_loja', { p_empresa_id: empId, p_telefone: tel })
      if (!data) return
      reconhecidoRef.current = true
      setReconhecido(true)
      setReconfirmar(!!data.reconfirmar_endereco) // marcado no banco → força remarcar o mapa
      setForm(prev => ({
        ...prev,
        nome:        prev.nome.trim()        ? prev.nome        : (data.nome || ''),
        email:       prev.email.trim()       ? prev.email       : (data.email || ''),
        cep:         prev.cep.trim()         ? prev.cep         : (data.cep || ''),
        rua:         prev.rua.trim()         ? prev.rua         : (data.endereco || ''),
        numero:      prev.numero.trim()      ? prev.numero      : (data.numero || ''),
        complemento: prev.complemento.trim() ? prev.complemento : (data.complemento || ''),
        estado:      prev.estado             ? prev.estado      : (data.estado || ''),
        cidade:      prev.cidade             ? prev.cidade      : (data.cidade || ''),
        bairro:      prev.bairro.trim()      ? prev.bairro      : (data.bairro || ''),
      }))
      if (data.estado) carregarCidades(data.estado, data.cidade)
    }, 700)
    return () => clearTimeout(t)
  }, [form.telefone, state])

  // Geocodifica o endereço (debounced) pra estimar a taxa por distância mesmo sem
  // abrir o mapa. Se o cliente já marcou o ponto no mapa, não sobrescreve.
  useEffect(() => {
    if (tipo !== 'entrega' || pinManualRef.current || !state?.empresaId) return
    const rua = form.rua.trim(), cidade = form.cidade
    if (!rua || !cidade) return
    const t = setTimeout(async () => {
      const c = await geocodeEndereco({ rua, numero: form.numero, bairro: form.bairro, cidade, estado: form.estado, cep: form.cep })
      if (c && !pinManualRef.current) setCoordCliente(c)
    }, 900)
    return () => clearTimeout(t)
  }, [form.rua, form.numero, form.bairro, form.cidade, form.estado, form.cep, tipo, state])

  if (!state?.itens?.length) {
    return <Navigate to="/lojas" replace />
  }

  const { empresaId, empresaNome, itens, subtotal, taxaEntrega } = state
  // Taxa por distância (faixas por km da loja) a partir do ponto do cliente;
  // se não der pra calcular, cai na taxa fixa passada pela loja.
  const temFaixas = Array.isArray(lojaEndereco?.taxas_entrega_km) && lojaEndereco.taxas_entrega_km.length > 0
  // BAIRRO primeiro: se o bairro do cliente estiver configurado, ele manda (taxa fixa ou bloqueio).
  const cfgBairro = acharBairroCfg(lojaEndereco?.taxas_entrega_bairro, form.bairro)
  const bairroBloqueado = tipo === 'entrega' && !!cfgBairro && cfgBairro.entrega === false
  const bairroTaxaFixa = !!cfgBairro && cfgBairro.entrega !== false
  const taxaCalculada = (() => {
    if (tipo === 'retirada') return 0
    // 1) taxa fixa do bairro (ignora o km)
    if (bairroTaxaFixa) return Number(cfgBairro.taxa) || 0
    // 2) km (fallback pros bairros não configurados)
    if (coordCliente && lojaEndereco?.latitude && lojaEndereco?.longitude && temFaixas) {
      const dist = haversineKm(coordCliente.lat, coordCliente.lng, Number(lojaEndereco.latitude), Number(lojaEndereco.longitude))
      const t = calcTaxaKm(lojaEndereco.taxas_entrega_km, dist)
      if (t != null) return t
    }
    return taxaEntrega
  })()
  // Precisa marcar o ponto pra saber a taxa? (só quando é por km — bairro com taxa fixa não precisa)
  const taxaPendente = tipo === 'entrega' && temFaixas && !coordCliente && !bairroTaxaFixa && !bairroBloqueado

  // A rua/bairro digitados batem com o CEP? Se o cliente trocou na mão pra um
  // endereço de outro bairro (caso do pedido torto), avisa — sem bloquear.
  const cepDivergente = (() => {
    if (!cepInfo || tipo !== 'entrega') return null
    const tipoLogr = /^(r|rua|av|avenida|tv|travessa|al|alameda|pc|praca|rod|rodovia|estr|estrada)\.?\s+/
    const soNome = s => normBairro(s).replace(tipoLogr, '')
    const casa = (a, b) => { const x = soNome(a), y = soNome(b); return !x || !y || x.includes(y) || y.includes(x) }
    const bairroBate = !cepInfo.bairro || !form.bairro.trim() || casa(form.bairro, cepInfo.bairro)
    const ruaBate = !cepInfo.rua || !form.rua.trim() || casa(form.rua, cepInfo.rua)
    if (bairroBate && ruaBate) return null
    return { rua: cepInfo.rua, bairro: cepInfo.bairro }
  })()
  const taxaAplicada = taxaCalculada
  const total = subtotal + taxaAplicada

  // Pedido mínimo (só entrega, conta o subtotal dos produtos — sem a taxa)
  const pedidoMinimo = Number(lojaEndereco?.pedido_minimo ?? 0)
  const faltaMinimo = tipo === 'entrega' && pedidoMinimo > 0 && subtotal < pedidoMinimo
  const faltamParaMinimo = faltaMinimo ? (pedidoMinimo - subtotal) : 0

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }))
  }

  // Cliente confirmou o ponto no mapa: fixa o pino, calcula a taxa e preenche o endereço
  function confirmarMapa({ lat, lng }) {
    pinManualRef.current = true
    setCoordCliente({ lat, lng })
    setMapaAberto(false)
    reverseGeocode(lat, lng).then(a => {
      if (!a) return
      const cepFmt = a.cep && a.cep.length === 8 ? `${a.cep.slice(0, 5)}-${a.cep.slice(5)}` : ''
      setForm(prev => ({
        ...prev,
        rua:    a.rua    || prev.rua,
        bairro: a.bairro || prev.bairro,
        cidade: a.cidade || prev.cidade,
        estado: a.estado || prev.estado,
        cep:    prev.cep || cepFmt,
      }))
      if (a.estado && a.estado !== form.estado) carregarCidades(a.estado, a.cidade || '')
    })
  }

  async function carregarCidades(uf, cidadeParaSelecionar = '') {
    setLoadingCidades(true)
    try {
      const res = await fetch(
        `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`
      )
      const data = await res.json()
      const lista = data.map(c => c.nome)
      setCidades(lista)
      if (cidadeParaSelecionar) {
        const match = lista.find(c => c.toLowerCase() === cidadeParaSelecionar.toLowerCase())
        if (match) set('cidade', match)
      }
    } catch {
      setCidades([])
    } finally {
      setLoadingCidades(false)
    }
  }

  function handleCepChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    const fmt2 = v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v
    set('cep', fmt2)
    setErroCep(null)
    if (v.length === 8) buscarCep(v)
  }

  async function buscarCep(numeros) {
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${numeros}/json/`)
      const data = await res.json()
      if (data.erro) { setErroCep('CEP não encontrado.'); setCepInfo(null); return }
      set('rua', data.logradouro || '')
      set('bairro', data.bairro || '')
      setCepInfo({ cep: numeros, rua: data.logradouro || '', bairro: data.bairro || '' })
      if (data.uf) {
        set('estado', data.uf)
        await carregarCidades(data.uf, data.localidade || '')
      }
    } catch {
      setErroCep('Erro ao buscar CEP.')
    } finally {
      setBuscandoCep(false)
    }
  }

  async function handleEstadoChange(uf) {
    set('estado', uf)
    set('cidade', '')
    setCidades([])
    if (uf) await carregarCidades(uf)
  }

  function validate() {
    const e = {}
    if (!form.nome.trim()) e.nome = 'Nome obrigatório'
    if (form.telefone.replace(/\D/g, '').length < 10) e.telefone = 'Telefone inválido'
    if (tipo === 'entrega') {
      if (!form.rua.trim()) e.rua = 'Rua obrigatória'
      if (!form.numero.trim()) e.numero = 'Número obrigatório'
      if (!form.estado) e.estado = 'Estado obrigatório'
      if (!form.cidade) e.cidade = 'Cidade obrigatória'
      if (!form.bairro.trim()) e.bairro = 'Bairro obrigatório'
    }
    if (form.pagamento === 'dinheiro' && form.troco) {
      const val = parseFloat(form.troco.replace(',', '.'))
      if (isNaN(val) || val < total) e.troco = `Valor deve ser maior que R$ ${fmt(total)}`
    }
    return e
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setErroGlobal(null)

    const errs = validate()
    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      setTimeout(() => {
        document.querySelector('[data-field-error]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 50)
      return
    }

    // Toda entrega precisa do ponto no mapa. Antes só era exigido quando a taxa
    // era por km; com taxa por bairro o cliente fechava sem marcar, e o entregador
    // ficava sem coordenada pra abrir no GPS (caso do pedido com endereço torto).
    // Só exige se a loja tem coordenada (senão o botão do mapa nem aparece e o
    // cliente ficaria travado sem como marcar).
    const lojaTemMapa = !!(lojaEndereco?.latitude && lojaEndereco?.longitude)
    // Cliente marcado pra reconfirmar (endereço estava errado) precisa marcar o pino
    // MANUALMENTE — a coordenada que o geocode acha sozinho não vale pra ele. Pros
    // demais clientes a condição extra é falsa, então o fluxo continua idêntico.
    const precisaPino = !coordCliente || (reconfirmar && !pinManualRef.current)
    if (tipo === 'entrega' && lojaTemMapa && precisaPino) {
      setErroGlobal(reconfirmar
        ? 'Pra confirmar seu endereço, toque em "Marcar meu local no mapa" e aponte onde você mora.'
        : 'Toque em "Marcar meu local no mapa" pra o entregador achar seu endereço.')
      setMapaAberto(true)
      return
    }

    // Pedido mínimo para entrega
    if (faltaMinimo) {
      setErroGlobal(`Pedido mínimo para entrega é R$ ${fmt(pedidoMinimo)}. Faltam R$ ${fmt(faltamParaMinimo)} em produtos (ou escolha Retirada).`)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    // Bairro bloqueado (não entregamos)
    if (bairroBloqueado) {
      setErroGlobal('Poxa, ainda não entregamos no seu bairro 😔. Você pode escolher Retirada, se disponível.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    setEnviando(true)

    // Cria/atualiza o cliente da loja (sem login, identificado pelo telefone)
    let clienteId = null
    try {
      const { data: cid } = await supabase.rpc('upsert_cliente_loja', {
        p_empresa_id:  empresaId,
        p_nome:        form.nome.trim(),
        p_telefone:    form.telefone,
        p_email:       form.email.trim(),
        p_cep:         form.cep,
        p_endereco:    form.rua.trim(),
        p_numero:      form.numero.trim(),
        p_complemento: form.complemento.trim(),
        p_bairro:      form.bairro.trim(),
        p_cidade:      form.cidade,
        p_estado:      form.estado,
      })
      clienteId = cid ?? null
    } catch { /* não bloqueia o pedido */ }

    const itensPedido = itens.map(i => ({
      produto_id:    i.id,
      // Dobra as escolhas no nome (aparece no painel/cupom) + guarda estruturado
      nome:          i.complementos?.length
        ? `${i.nome} (${i.complementos.map(c => c.nome).join(', ')})`
        : i.nome,
      quantidade:    i.quantidade,
      preco_unitario: i.preco,
      subtotal:      i.quantidade * i.preco,
      complementos:  i.complementos ?? [],
    }))

    function lembrarCliente() {
      try {
        localStorage.removeItem(`sacola_${empresaId}`)
        localStorage.setItem(LS_CLIENTE, JSON.stringify({
          nome: form.nome.trim(), telefone: form.telefone, email: form.email.trim(),
          cep: form.cep, rua: form.rua.trim(), numero: form.numero.trim(),
          complemento: form.complemento.trim(), estado: form.estado, cidade: form.cidade, bairro: form.bairro.trim(),
        }))
      } catch { /* ok */ }
    }

    // ── PIX: gera o QR pelo create-pix-payment (cai na conta da loja, se conectada) ──
    if (form.pagamento === 'pix') {
      const pedidoPix = {
        empresa_id:   empresaId,
        empresa_nome: empresaNome,
        user_id:      userId ?? null,
        cliente_id:   clienteId,
        cliente_nome: form.nome.trim(),
        cliente_telefone: form.telefone,
        payer_email:  form.email.trim() || `${form.telefone.replace(/\D/g, '')}@lojaonline.app`,
        itens:        itensPedido,
        subtotal,
        taxa_entrega: taxaAplicada,
        total,
        tipo_entrega: tipo,
        endereco_rua:         tipo === 'entrega' ? form.rua.trim() : null,
        endereco_numero:      tipo === 'entrega' ? form.numero.trim() : null,
        endereco_complemento: tipo === 'entrega' ? (form.complemento.trim() || null) : null,
        endereco_bairro:      tipo === 'entrega' ? form.bairro.trim() : null,
        endereco_cidade:      tipo === 'entrega' ? form.cidade : null,
        endereco_estado:      tipo === 'entrega' ? form.estado : null,
        // O CEP ia só pro cadastro do cliente e sumia do pedido — o entregador
        // ficava sem ele pra conferir endereço torto.
        endereco_cep:         tipo === 'entrega' ? (form.cep.trim() || null) : null,
        observacoes:  form.observacoes.trim() || null,
      }
      let pixData = null, pixErr = null
      try {
        const res = await supabase.functions.invoke('create-pix-payment', { body: { pedido: pedidoPix } })
        pixData = res.data; pixErr = res.error
      } catch (err) { pixErr = err }
      setEnviando(false)
      if (pixErr || !pixData?.order_id || pixData?.error) {
        setErroGlobal(pixData?.error || 'Não consegui gerar o PIX agora. Tente dinheiro/cartão ou tente de novo.')
        return
      }
      lembrarCliente()
      registrarPedido(pixData.order_id, empresaId)
      navigate(`/pedido/${pixData.order_id}`, { replace: true })
      return
    }

    // ── Dinheiro / Cartão: insere o pedido direto ──
    const { data, error } = await supabase
      .from('pedidos_delivery')
      .insert({
        empresa_id:           empresaId,
        user_id:              userId ?? null,
        cliente_id:           clienteId,
        cliente_nome:         form.nome.trim(),
        cliente_telefone:     form.telefone,
        endereco_rua:         tipo === 'entrega' ? form.rua.trim() : null,
        endereco_numero:      tipo === 'entrega' ? form.numero.trim() : null,
        endereco_complemento: tipo === 'entrega' ? (form.complemento.trim() || null) : null,
        endereco_estado:      tipo === 'entrega' ? form.estado : null,
        endereco_cidade:      tipo === 'entrega' ? form.cidade : null,
        endereco_bairro:      tipo === 'entrega' ? form.bairro.trim() : null,
        endereco_cep:         tipo === 'entrega' ? (form.cep.trim() || null) : null,
        tipo_entrega:         tipo,
        origem: window.Capacitor?.isNativePlatform?.() ? 'app' : 'cardapio',
        itens: itensPedido,
        subtotal,
        taxa_entrega:   taxaAplicada,
        total,
        forma_pagamento: form.pagamento,
        troco_para: form.pagamento === 'dinheiro' && form.troco
          ? Math.round(parseFloat(form.troco.replace(',', '.')) * 100) / 100
          : null,
        observacoes: form.observacoes.trim() || null,
      })
      .select('id')
      .single()

    setEnviando(false)

    if (error) { setErroGlobal(error.message); return }

    lembrarCliente()
    registrarPedido(data.id, empresaId)
    navigate(`/pedido/${data.id}`, { replace: true })
  }

  return (
    <div className="dco-root">
      <header className="dco-header">
        <div className="dco-header-inner">
          <button className="dco-back-btn" onClick={() => navigate(-1)} aria-label="Voltar">
            <IconArrowLeft />
          </button>
          <span className="dco-logo">FWC</span>
          <span className="dco-header-divider" />
          <div>
            <span className="dco-header-title">Checkout</span>
            {empresaNome && <span className="dco-header-sub">{empresaNome}</span>}
          </div>
        </div>
      </header>

      <main className="dco-main">
        <form className="dco-form" onSubmit={handleSubmit} noValidate>
          <div className="dco-layout">
            <div className="dco-col-form">

              {/* Seus dados */}
              <section className="dco-section">
                <h2 className="dco-section-title">Seus dados</h2>
                <div className="dco-field-group">
                  {/* Telefone primeiro: se já é cliente, preenche o resto sozinho */}
                  <Field label="Telefone" required hint="Já pediu aqui? A gente preenche o resto pelo seu número" error={errors.telefone}>
                    <input
                      className={`dco-input${errors.telefone ? ' dco-input--error' : ''}`}
                      placeholder="(11) 99999-9999"
                      value={form.telefone}
                      onChange={e => set('telefone', fmtTelefone(e.target.value))}
                      inputMode="tel"
                      autoFocus
                      data-field-error={errors.telefone ? true : undefined}
                    />
                  </Field>
                  {reconhecido && (
                    <div style={{
                      margin: '-4px 0 4px', padding: '9px 12px', borderRadius: 10,
                      background: 'rgba(16,185,129,.12)', border: '1px solid rgba(16,185,129,.35)',
                      color: '#34d399', fontSize: 13.5, fontWeight: 600,
                    }}>
                      ✓ Encontramos seu cadastro! Confira os dados abaixo.
                    </div>
                  )}
                  <Field label="Nome completo" required error={errors.nome}>
                    <input
                      className={`dco-input${errors.nome ? ' dco-input--error' : ''}`}
                      placeholder="João da Silva"
                      value={form.nome}
                      onChange={e => set('nome', e.target.value)}
                      data-field-error={errors.nome ? true : undefined}
                    />
                  </Field>
                  <Field label="E-mail" hint="Opcional">
                    <input
                      className="dco-input"
                      type="email"
                      placeholder="voce@email.com"
                      value={form.email}
                      onChange={e => set('email', e.target.value)}
                      inputMode="email"
                    />
                  </Field>
                </div>
              </section>

              {/* Tipo: entrega ou retirada */}
              <section className="dco-section">
                <h2 className="dco-section-title">Como você quer receber?</h2>
                <div className="dco-payment-row">
                  <button type="button"
                    className={`dco-pay-btn${tipo === 'entrega' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => setTipo('entrega')}>
                    <span>🛵 Entrega</span>
                    {tipo === 'entrega' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                  <button type="button"
                    className={`dco-pay-btn${tipo === 'retirada' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => setTipo('retirada')}>
                    <span>🏬 Retirar na loja</span>
                    {tipo === 'retirada' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                </div>
                {tipo === 'retirada' && (
                  <div style={{
                    marginTop: 12, padding: '12px 14px', borderRadius: 10,
                    background: 'rgba(124,58,237,.1)', border: '1px solid rgba(124,58,237,.3)',
                    fontSize: 13.5, color: 'var(--text, #fff)', lineHeight: 1.5,
                  }}>
                    <strong>Você vai retirar na loja</strong> — sem taxa de entrega.
                    {lojaEndereco && (lojaEndereco.endereco || lojaEndereco.cidade) && (
                      <div style={{ marginTop: 4, opacity: .85 }}>
                        📍 {[lojaEndereco.endereco, lojaEndereco.bairro, lojaEndereco.cidade].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Endereço (só na entrega) */}
              {tipo === 'entrega' && (
              <section className="dco-section">
                <h2 className="dco-section-title">Endereço de entrega</h2>
                <div className="dco-field-group">

                  {/* CEP — opcional, preenche automático */}
                  <Field label="CEP" hint="Opcional — preenche o endereço automaticamente">
                    <div style={{ position: 'relative' }}>
                      <input
                        className="dco-input"
                        placeholder="00000-000"
                        value={form.cep}
                        onChange={handleCepChange}
                        inputMode="numeric"
                        maxLength={9}
                      />
                      {buscandoCep && (
                        <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--text-muted, #888)' }}>
                          Buscando...
                        </span>
                      )}
                    </div>
                    {erroCep && <span className="dco-field-error">{erroCep}</span>}
                  </Field>

                  {/* Rua */}
                  <Field label="Rua / Av." required error={errors.rua}>
                    <input
                      className={`dco-input${errors.rua ? ' dco-input--error' : ''}`}
                      placeholder="Rua das Flores"
                      value={form.rua}
                      onChange={e => set('rua', e.target.value)}
                      data-field-error={errors.rua ? true : undefined}
                    />
                  </Field>

                  {/* Número + Complemento */}
                  <div className="dco-row">
                    <Field label="Número" required error={errors.numero}>
                      <input
                        className={`dco-input${errors.numero ? ' dco-input--error' : ''}`}
                        placeholder="123"
                        value={form.numero}
                        onChange={e => set('numero', e.target.value)}
                        data-field-error={errors.numero ? true : undefined}
                      />
                    </Field>
                    <Field label="Complemento" hint="opcional">
                      <input
                        className="dco-input"
                        placeholder="Apto 4"
                        value={form.complemento}
                        onChange={e => set('complemento', e.target.value)}
                      />
                    </Field>
                  </div>

                  {/* Estado */}
                  <Field label="Estado" required error={errors.estado}>
                    <select
                      className={`dco-input dco-select${errors.estado ? ' dco-input--error' : ''}`}
                      value={form.estado}
                      onChange={e => handleEstadoChange(e.target.value)}
                      data-field-error={errors.estado ? true : undefined}
                    >
                      <option value="">Selecione o estado</option>
                      {ESTADOS_BR.map(({ uf, nome }) => (
                        <option key={uf} value={uf}>{nome} ({uf})</option>
                      ))}
                    </select>
                  </Field>

                  {/* Cidade */}
                  <Field label="Cidade" required error={errors.cidade}>
                    <select
                      className={`dco-input dco-select${errors.cidade ? ' dco-input--error' : ''}`}
                      value={form.cidade}
                      onChange={e => set('cidade', e.target.value)}
                      disabled={!form.estado || loadingCidades}
                      data-field-error={errors.cidade ? true : undefined}
                    >
                      <option value="">
                        {loadingCidades ? 'Carregando...' : form.estado ? 'Selecione a cidade' : 'Selecione o estado primeiro'}
                      </option>
                      {cidades.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>

                  {/* Bairro */}
                  <Field label="Bairro" required error={errors.bairro}>
                    <input
                      className={`dco-input${errors.bairro ? ' dco-input--error' : ''}`}
                      placeholder="Centro"
                      value={form.bairro}
                      onChange={e => set('bairro', e.target.value)}
                      data-field-error={errors.bairro ? true : undefined}
                    />
                  </Field>

                  {/* Aviso quando a rua/bairro não batem com o CEP digitado */}
                  {cepDivergente && (
                    <div style={{ marginTop: -4, marginBottom: 4, padding: '9px 11px', borderRadius: 10,
                      border: '1px solid #eab308', background: 'rgba(234,179,8,.1)', fontSize: 12.5, color: '#a16207', lineHeight: 1.4 }}>
                      ⚠️ Esse CEP é de{cepDivergente.rua ? ` ${cepDivergente.rua},` : ''}
                      {cepDivergente.bairro ? ` bairro ${cepDivergente.bairro}` : ''}. Confere se o endereço está certo.
                    </div>
                  )}

                  {/* Localizador no mapa — ponto exato pra taxa certinha */}
                  {lojaEndereco?.latitude && lojaEndereco?.longitude && (
                    <div style={{ marginTop: 4 }}>
                      <button type="button" onClick={() => setMapaAberto(true)}
                        style={{ width: '100%', padding: '12px', borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                          border: `1.5px solid ${coordCliente ? '#16a34a' : '#7c3aed'}`,
                          background: coordCliente ? 'rgba(16,185,129,.12)' : 'rgba(124,58,237,.12)',
                          color: coordCliente ? '#34d399' : '#a78bfa' }}>
                        {coordCliente ? '✓ Local marcado no mapa — toque para ajustar' : '📍 Marcar meu local no mapa (obrigatório)'}
                      </button>
                      {temFaixas && (
                        <div style={{ marginTop: 6, fontSize: 12.5, color: taxaPendente ? '#eab308' : 'var(--text-muted,#9aa)' }}>
                          {taxaPendente
                            ? '⚠️ Marque seu local no mapa pra calcular a taxa de entrega certinha.'
                            : `📏 Entrega calculada pela distância: R$ ${fmt(taxaAplicada)}`}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              </section>
              )}

              {/* Pagamento */}
              <section className="dco-section">
                <h2 className="dco-section-title">Pagamento</h2>
                <div className="dco-payment-row">
                  <button type="button"
                    className={`dco-pay-btn${form.pagamento === 'pix' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => set('pagamento', 'pix')}>
                    <IconPix />
                    <span>Pix</span>
                    {form.pagamento === 'pix' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                  <button type="button"
                    className={`dco-pay-btn${form.pagamento === 'dinheiro' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => set('pagamento', 'dinheiro')}>
                    <IconMoney />
                    <span>Dinheiro</span>
                    {form.pagamento === 'dinheiro' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                  <button type="button"
                    className={`dco-pay-btn${form.pagamento === 'cartao' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => set('pagamento', 'cartao')}>
                    <IconCard />
                    <span>Cartão</span>
                    {form.pagamento === 'cartao' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                </div>
                {form.pagamento === 'dinheiro' && (
                  <Field label="Troco para R$" error={errors.troco}>
                    <input
                      className={`dco-input dco-input--troco${errors.troco ? ' dco-input--error' : ''}`}
                      placeholder={`Ex: ${fmt(Math.ceil(total / 10) * 10)}`}
                      value={form.troco}
                      onChange={e => set('troco', e.target.value)}
                      inputMode="decimal"
                    />
                  </Field>
                )}
              </section>

              {/* Observações */}
              <section className="dco-section">
                <h2 className="dco-section-title">Observações <span className="dco-optional">(opcional)</span></h2>
                <textarea
                  className="dco-textarea"
                  placeholder="Alguma observação sobre o pedido ou entrega..."
                  rows={3}
                  value={form.observacoes}
                  onChange={e => set('observacoes', e.target.value)}
                />
              </section>
            </div>

            <div className="dco-col-aside">
              <div className="dco-resumo">
                <h2 className="dco-section-title">Resumo do pedido</h2>
                <div className="dco-resumo-itens">
                  {itens.map(item => (
                    <div key={item.key ?? item.id} className="dco-resumo-item">
                      <span className="dco-resumo-item-qty">{item.quantidade}x</span>
                      <span className="dco-resumo-item-nome">
                        {item.nome}
                        {item.complementos?.length > 0 && (
                          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted, #888)', fontWeight: 400 }}>
                            {item.complementos.map(c => `${Number(c.qtd ?? 1)}× ${c.nome}`).join(', ')}
                          </span>
                        )}
                      </span>
                      <span className="dco-resumo-item-sub">R$ {fmt(item.quantidade * item.preco)}</span>
                    </div>
                  ))}
                </div>
                <div className="dco-resumo-totais">
                  <div className="dco-resumo-linha">
                    <span>Subtotal</span>
                    <span>R$ {fmt(subtotal)}</span>
                  </div>
                  <div className="dco-resumo-linha">
                    <span>{tipo === 'retirada' ? 'Retirada na loja' : 'Taxa de entrega'}</span>
                    <span>{tipo === 'retirada' ? 'Grátis' : taxaPendente ? 'a calcular' : taxaAplicada === 0 ? 'Grátis' : `R$ ${fmt(taxaAplicada)}`}</span>
                  </div>
                  <div className="dco-resumo-linha dco-resumo-total">
                    <span>Total</span>
                    <strong>{taxaPendente ? `R$ ${fmt(subtotal)}+` : `R$ ${fmt(total)}`}</strong>
                  </div>
                </div>

                {faltaMinimo && (
                  <div className="dco-erro-global" style={{ background: 'rgba(217,119,6,.12)', border: '1px solid #d97706', color: '#d97706' }}>
                    Pedido mínimo p/ entrega: <strong>R$ {fmt(pedidoMinimo)}</strong> · faltam <strong>R$ {fmt(faltamParaMinimo)}</strong> em produtos.
                  </div>
                )}

                {bairroBloqueado && (
                  <div className="dco-erro-global" style={{ background: 'rgba(220,38,38,.12)', border: '1px solid #dc2626', color: '#dc2626' }}>
                    😔 Ainda não entregamos no bairro <strong>{form.bairro}</strong>. Se quiser, escolha <strong>Retirada</strong>.
                  </div>
                )}

                {erroGlobal && <div className="dco-erro-global">{erroGlobal}</div>}

                <button type="submit" className="dco-btn-submit" disabled={enviando || faltaMinimo || bairroBloqueado}>
                  {enviando ? <><span className="dco-spinner" />Enviando pedido...</>
                    : bairroBloqueado ? 'Não entregamos no seu bairro'
                    : faltaMinimo ? `Faltam R$ ${fmt(faltamParaMinimo)} p/ o mínimo` : 'Fazer pedido'}
                </button>
              </div>
            </div>
          </div>

          {erroGlobal && <div className="dco-erro-global dco-erro-mobile">{erroGlobal}</div>}

          <div className="dco-submit-mobile">
            <button type="submit" className="dco-btn-submit" disabled={enviando || faltaMinimo}>
              {enviando
                ? <><span className="dco-spinner" />Enviando pedido...</>
                : faltaMinimo
                ? `Faltam R$ ${fmt(faltamParaMinimo)} p/ o mínimo`
                : `Fazer pedido · R$ ${fmt(total)}`}
            </button>
          </div>
        </form>
      </main>

      {mapaAberto && (
        <MapaLocalizador
          storeLat={lojaEndereco?.latitude}
          storeLng={lojaEndereco?.longitude}
          raioKm={lojaEndereco?.raio_entrega_km}
          taxas={lojaEndereco?.taxas_entrega_km}
          initial={coordCliente}
          endereco={{ rua: form.rua, numero: form.numero, bairro: form.bairro, cidade: form.cidade, estado: form.estado, cep: form.cep }}
          onConfirm={confirmarMapa}
          onClose={() => setMapaAberto(false)}
        />
      )}
    </div>
  )
}

function Field({ label, required, error, hint, children }) {
  return (
    <label className="dco-field">
      <span className="dco-label">
        {label}
        {required && <span className="dco-required">*</span>}
        {hint && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted, #888)', marginLeft: 4 }}>({hint})</span>}
      </span>
      {children}
      {error && <span className="dco-field-error" data-field-error>{error}</span>}
    </label>
  )
}
