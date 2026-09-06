import { useState, useEffect, useMemo, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { registrarIndicacao } from '../lib/indicacao'
import { getEnderecoAtivo } from '../utils/enderecoPortal'
import { registrarPedido } from '../lib/meusPedidos'
import { iniciarCheckout } from '../lib/tracking'
import { marcarEtapa, anotarContato } from '../lib/funil'
import { formasAtivas, repassePct } from '../lib/constants'
import { carregarExcecoes, abertaAgora } from '../lib/feriados'
import { diasParaAgendar, paraISO, rotuloAgendado } from '../lib/agendamento'
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
// Abreviações que a loja escreve de um jeito e o cliente de outro. Sem isto,
// "Nossa Sra. da Apresentação" (como a loja cadastrou) não casa com "Nossa
// Senhora da Apresentação" (como o cliente digita) e o pedido sai sem taxa.
const ABREV_BAIRRO = {
  sra: 'senhora', sr: 'senhor', sto: 'santo', sta: 'santa',
  n: 'nossa', na: 'nossa', jd: 'jardim', pq: 'parque',
  vl: 'vila', cj: 'conjunto', res: 'residencial', pres: 'presidente',
}
function normBairro(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/^bairro\s+/, '')
    .replace(/\./g, ' ')            // "sra." → "sra "
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(p => ABREV_BAIRRO[p] ?? p)
    .join(' ')
    .trim()
}
function acharBairroCfg(lista, bairroCliente) {
  if (!Array.isArray(lista) || !bairroCliente) return null
  const n = normBairro(bairroCliente)
  return lista.find(b => normBairro(b.bairro) === n) || null
}
// Chave do endereço — tem que dar a MESMA string que a chave_endereco() do banco
// (mig 0160), senão o pino salvo nunca casaria com o endereço da tela.
// O BAIRRO fica de fora de propósito (mig 0162): é o campo que o cliente escreve
// diferente a cada pedido ("Potengi" e "Panatis _1" pra mesma casa), e uma
// digitação nova descartaria o pino certo. Rua + número + cidade já identifica a
// casa, porque a chave só decide se o pino DAQUELE cliente ainda serve.
function chaveEndereco({ rua, numero, cidade } = {}) {
  const junto = [rua, numero, cidade]
    .map(v => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ')
  return junto
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // tira acento, igual ao unaccent
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim() || null
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
// O Nominatim é gratuito e limita 1 consulta por segundo — ele engasga e às
// vezes simplesmente não responde. Sem tempo limite, a promessa fica pendurada
// e o cliente termina o pedido sem ponto nenhum (foi assim que pedido saiu com
// frete zero). 5s é mais que suficiente quando o serviço está de pé.
async function buscarJson(url, ms = 5000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'CRM-FWC/1.0' }, signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

// Quantas palavras do que o cliente digitou aparecem no nome da rua. Serve pra
// duas coisas: ordenar a lista pelo que ele realmente escreveu, e saber se
// alguma rua casou INTEIRA — porque o ViaCEP casa pedaço, e pedaço engana.
function pontosDaRua(nomeRua, termo) {
  const limpa = (t) => String(t ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const alvo = limpa(nomeRua)
  const palavras = limpa(termo).split(' ').filter(w => w.length >= 3)
  if (!palavras.length) return 0
  return palavras.filter(w => alvo.includes(w)).length
}
function ruaCasouInteira(nomeRua, termo) {
  const limpa = (t) => String(t ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const palavras = limpa(termo).split(' ').filter(w => w.length >= 3)
  return palavras.length > 0 && pontosDaRua(nomeRua, termo) === palavras.length
}

// Busca a rua no ESTADO INTEIRO. O ViaCEP não sabe fazer isso — ele exige
// UF + cidade + rua, e por isso a busca do checkout só enxergava a cidade da
// loja. O OpenStreetMap aceita UF + rua e devolve em que cidade e bairro ela
// fica, que é exatamente a pergunta de quem mora na cidade vizinha.
//
// É a ÚLTIMA camada de propósito: o ViaCEP é a fonte oficial e traz o CEP
// certo; o OSM entra quando ele não tem resposta, e aí uma rua achada com o
// bairro e a cidade certos vale muito mais que uma lista vazia.
async function buscarRuaNoEstado(uf, termo) {
  if (!uf || !termo || termo.length < 3) return []
  const params = new URLSearchParams({
    street: termo, state: uf, country: 'Brazil',
    format: 'json', addressdetails: '1', limit: '8',
  })
  const d = await buscarJson(`https://nominatim.openstreetmap.org/search?${params}`, 6000)
  if (!Array.isArray(d)) return []
  return d.map(x => {
    const a = x.address ?? {}
    return {
      logradouro: a.road ?? a.pedestrian ?? a.footway ?? '',
      bairro:     a.suburb ?? a.neighbourhood ?? a.city_district ?? '',
      localidade: a.city ?? a.town ?? a.municipality ?? a.village ?? '',
      uf,
      cep:        String(a.postcode ?? '').replace(/[^0-9]/g, ''),
    }
  }).filter(r => r.logradouro && r.localidade)
}

async function geocodeEndereco({ rua, numero, bairro, cidade, estado, cep } = {}) {
  const uf = estado || ''
  const cepLimpo = String(cep || '').replace(/\D/g, '')
  // 1) Busca ESTRUTURADA com o CEP — bem mais precisa que a busca por texto
  //    (ajuda em endereços que a busca livre erra, tipo em São Gonçalo/RN).
  if (cepLimpo.length === 8) {
    const params = new URLSearchParams({
      street: [numero, rua].filter(Boolean).join(' '),
      city: cidade || '', state: uf, postalcode: cepLimpo,
      country: 'Brazil', format: 'json', limit: '1',
    })
    const d = await buscarJson(`https://nominatim.openstreetmap.org/search?${params}`)
    if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  }
  // 2) Fallback: busca livre por texto (com o CEP junto quando tiver)
  {
    const q = [rua, numero, bairro, cidade, uf, cepLimpo].filter(s => s && String(s).trim()).join(', ')
    const d = await buscarJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Brasil')}&format=json&limit=1`)
    if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  }
  // 3) O Nominatim limita 1 consulta por segundo e devolve vazio quando está
  //    apertado. Uma repetida depois de 1,2s costuma passar — e é a diferença
  //    entre calcular a taxa e obrigar o cliente a abrir o mapa.
  await new Promise(r => setTimeout(r, 1200))
  {
    const q = [rua, numero, bairro, cidade, uf].filter(s => s && String(s).trim()).join(', ')
    const d = await buscarJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Brasil')}&format=json&limit=1`)
    if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  }
  return null
}
// Centro aproximado do bairro digitado — só pra CONFERIR se o pino não caiu
// num bairro totalmente diferente (geocode errado da rua, GPS fora do lugar).
// Não influencia a taxa; serve só pro aviso "pino longe do bairro".
async function geocodeBairro({ bairro, cidade, estado } = {}) {
  if (!bairro) return null
  try {
    const q = [bairro, cidade, estado, 'Brasil'].filter(s => s && String(s).trim()).join(', ')
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`, { headers: { 'User-Agent': 'CRM-FWC/1.0' } })
    const d = await res.json()
    if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  } catch { /* ignora — sem centro do bairro, simplesmente não avisa */ }
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

// ── Mapa: cliente arrasta o pino até a casa (ponto exato) ────────────────────
//
// Dois modos, o MESMO componente:
//   * embutido — vive dentro do formulário, sempre visível. Mapa escondido atrás
//     de botão quase ninguém abre, e quem não abre manda o entregador pro ponto
//     que o buscador chutou. Aberto na cara, o cliente vê o erro sozinho.
//   * modal — tela cheia, pro ajuste fino (arrastar num mapa pequeno, dentro de
//     uma página que rola, é briga de dedo).
function MapaLocalizador({ storeLat, storeLng, raioKm, taxas, initial, endereco, exigeManual, embutido, onChange, onAmpliar, onConfirm, onClose }) {
  const mapRef = useRef(null)
  const mapObj = useRef(null)
  const pinRef = useRef(null)
  const interagiu = useRef(false) // cliente já mexeu no pino (arrasto/clique/GPS)?
  // Mesma informação do ref, mas em estado: o botão de confirmar precisa
  // re-renderizar quando o cliente finalmente mexe no pino.
  const [mexeu, setMexeu] = useState(false)
  const marcarMexeu = () => { interagiu.current = true; setMexeu(true) }
  // Enquanto o Leaflet não chega, mapObj guarda a string 'montando' pra segurar
  // o lugar (ver o init). Quem for MEXER no mapa passa por aqui.
  const mapaPronto = () => (mapObj.current && mapObj.current !== 'montando' ? mapObj.current : null)
  const [coord, setCoord] = useState(initial || (storeLat ? { lat: Number(storeLat), lng: Number(storeLng) } : null))
  const [locLoading, setLocLoading] = useState(false)
  const [geoLoading, setGeoLoading] = useState(false)
  // O pino saiu do ponto inicial (loja)? Só deixa confirmar depois que o local
  // for definido de fato — pelo endereço geocodificado, por arrastar, clicar ou
  // GPS. Sem isso o cliente confirmava o pino parado em cima da loja.
  const [definido, setDefinido] = useState(!!initial)
  const [bairroCentro, setBairroCentro] = useState(null) // centro aprox. do bairro digitado

  // Acha o centro do bairro que o cliente informou (uma vez), só p/ conferência.
  useEffect(() => {
    let cancelado = false
    if (!endereco?.bairro) return
    geocodeBairro(endereco).then(g => { if (!cancelado) setBairroCentro(g) })
    return () => { cancelado = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endereco?.bairro, endereco?.cidade, endereco?.estado])

  useEffect(() => {
    let cancelado = false
    async function init() {
      // Marca o lugar ANTES do await: o import é assíncrono e duas passadas
      // rápidas montariam dois mapas no mesmo div — dois tile layers, dois
      // rodapés do Leaflet e as peças fora do lugar.
      if (mapObj.current) return
      mapObj.current = 'montando'
      const L = (await import('leaflet')).default
      if (cancelado || !mapRef.current) { mapObj.current = null; return }
      const c = coord || { lat: Number(storeLat), lng: Number(storeLng) }
      // No mapa embutido do celular o arrasto do MAPA fica desligado: com ele
      // ligado o dedo que tentava rolar a página ficava preso arrastando o mapa.
      // O pino continua arrastável e o toque no mapa move o pino — pra
      // reposicionar o mapa inteiro tem o botão de ampliar.
      const travarPan = embutido && L.Browser.mobile
      const map = L.map(mapRef.current, {
        zoomControl: !embutido,
        dragging: !travarPan,
        scrollWheelZoom: !embutido,
        touchZoom: !travarPan,
      }).setView([c.lat, c.lng], 15)
      mapObj.current = map
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
      if (storeLat && storeLng) {
        const lojaIcon = L.divIcon({ html: `<div style="width:32px;height:32px;background:#7c3aed;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:16px;">🏪</div>`, className: '', iconSize: [32, 32], iconAnchor: [16, 16] })
        L.marker([Number(storeLat), Number(storeLng)], { icon: lojaIcon, interactive: false }).addTo(map)
        if (raioKm) L.circle([Number(storeLat), Number(storeLng)], { radius: raioKm * 1000, color: '#7c3aed', weight: 1.5, fillColor: '#7c3aed', fillOpacity: 0.06 }).addTo(map)
      }
      const pinIcon = L.divIcon({ html: `<div style="width:34px;height:34px;background:#ef4444;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.4);"></div>`, className: '', iconSize: [34, 34], iconAnchor: [17, 32] })
      pinRef.current = L.marker([c.lat, c.lng], { icon: pinIcon, draggable: true }).addTo(map)
      pinRef.current.on('dragend', e => { marcarMexeu(); const { lat, lng } = e.target.getLatLng(); setCoord({ lat, lng }); setDefinido(true) })
      map.on('click', e => { marcarMexeu(); const { lat, lng } = e.latlng; pinRef.current.setLatLng([lat, lng]); setCoord({ lat, lng }); setDefinido(true) })

      // O Leaflet corta os quadradinhos pro tamanho que o div TINHA na hora de
      // montar. O modal abre com o tamanho ainda assentando, então sem isto o
      // mapa nasce desenhado pra outra medida e vaza pra fora da janela.
      const ajustar = () => { try { map.invalidateSize() } catch { /* já foi removido */ } }
      setTimeout(ajustar, 60)
      setTimeout(ajustar, 300)
      window.addEventListener('resize', ajustar)
      map.__ajustar = ajustar

      // Sem ponto ainda? Tenta achar pelo endereço digitado (CEP/rua) e já leva o
      // pino pra lá — assim ele nasce perto da casa, não parado na loja.
      // No embutido quem procura é o formulário (ele já geocodifica conforme a
      // pessoa digita); aqui só seguimos o ponto que ele achar.
      if (!embutido && !initial && endereco && (endereco.rua || endereco.cep)) {
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
    return () => {
      cancelado = true
      const m = mapObj.current
      mapObj.current = null
      if (m && m !== 'montando') {
        if (m.__ajustar) window.removeEventListener('resize', m.__ajustar)
        m.remove()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Embutido: segue o ponto que o formulário achou pelo endereço digitado ──
  // Enquanto o cliente não põe o dedo no pino, ele acompanha o que o buscador
  // devolve a cada linha do endereço. Depois que a pessoa arrasta, o mapa é
  // dela: nada de buscador reescrevendo o acerto feito à mão.
  useEffect(() => {
    // Sem `interagiu` aqui de propósito: quem decide se o buscador pode mexer no
    // pino é o FORMULÁRIO (ele só manda ponto novo quando o pino não é manual).
    // Com a trava dupla, confirmar no mapa grande mudava o ponto de verdade e o
    // mapa pequeno continuava mostrando a distância antiga — duas telas, dois
    // números, e o cliente sem saber qual valia.
    if (!embutido || !initial) return
    if (coord && Math.abs(coord.lat - initial.lat) < 1e-7 && Math.abs(coord.lng - initial.lng) < 1e-7) return
    setCoord({ lat: initial.lat, lng: initial.lng })
    setDefinido(true)
    if (pinRef.current) pinRef.current.setLatLng([initial.lat, initial.lng])
    if (mapaPronto()) mapaPronto().setView([initial.lat, initial.lng], 16)
  }, [embutido, initial?.lat, initial?.lng]) // eslint-disable-line react-hooks/exhaustive-deps

  // O formulário derrubou o pino (mudou rua/número/bairro/cidade)? O mapa
  // solta o dele também. Sem isto o mapa ficava dono de uma coordenada que o
  // pedido não tinha mais — dois pinos diferentes, duas taxas diferentes, e a
  // que ia pro pedido era a invisível.
  useEffect(() => {
    if (!embutido || initial) return
    interagiu.current = false
    setMexeu(false)
    setDefinido(false)
    if (storeLat && storeLng) {
      const c = { lat: Number(storeLat), lng: Number(storeLng) }
      setCoord(c)
      if (pinRef.current) pinRef.current.setLatLng([c.lat, c.lng])
      if (mapaPronto()) mapaPronto().setView([c.lat, c.lng], 15)
    }
  }, [embutido, initial, storeLat, storeLng])

  // Embutido não tem botão "confirmar": cada arrasto já vale como escolha.
  useEffect(() => {
    if (!embutido || !coord || !definido) return
    onChange?.({ lat: coord.lat, lng: coord.lng, manual: interagiu.current })
  }, [embutido, coord, definido]) // eslint-disable-line react-hooks/exhaustive-deps

  function usarMinhaLocalizacao() {
    if (!navigator.geolocation) return
    setLocLoading(true)
    navigator.geolocation.getCurrentPosition(
      pos => {
        marcarMexeu()
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setCoord(c); setLocLoading(false); setDefinido(true)
        if (pinRef.current) pinRef.current.setLatLng([c.lat, c.lng])
        if (mapaPronto()) mapaPronto().setView([c.lat, c.lng], 17)
      },
      () => setLocLoading(false),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  const dist = coord && storeLat ? haversineKm(coord.lat, coord.lng, Number(storeLat), Number(storeLng)) : null
  const taxa = dist != null ? calcTaxaKm(taxas, dist) : null
  const foraRaio = dist != null && raioKm && dist > Number(raioKm)
  // Pino caiu longe do bairro digitado? (protege contra geocode/GPS errado que
  // infla a taxa). 3,5 km é folgado pra não reclamar de bairro grande.
  const distBairro = coord && bairroCentro ? haversineKm(coord.lat, coord.lng, bairroCentro.lat, bairroCentro.lng) : null
  const pinLongeDoBairro = definido && distBairro != null && distBairro > 3.5
  // Pode confirmar? Precisa de ponto definido — e, pra quem está reconfirmando,
  // o ponto tem que ter saído do dedo dele, não do buscador.
  const liberado = !!coord && definido && (!exigeManual || mexeu)

  const linhaDistancia = geoLoading ? 'Procurando o endereço…'
    : !definido ? '👆 Arraste o pino até sua casa'
    : dist != null ? <>📏 {dist.toFixed(1)} km · <strong style={{ color: '#34d399' }}>Taxa {taxa != null ? `R$ ${fmt(taxa)}` : '—'}</strong>{foraRaio ? ' · ⚠️ fora do raio' : ''}</>
    : 'Arraste o pino até sua casa'

  const avisoBairro = pinLongeDoBairro && (
    <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#fbbf24', background: 'rgba(251,191,36,.12)', border: '1px solid rgba(251,191,36,.4)', borderRadius: 8, padding: '9px 11px' }}>
      ⚠️ Esse ponto está a <strong>{distBairro?.toFixed(1)} km</strong> do bairro <strong>{endereco?.bairro}</strong> que você informou. Confira se o pino está mesmo na sua casa — se estiver no lugar errado, a taxa de entrega sai errada.
    </div>
  )

  if (embutido) {
    return (
      {/* `position: relative` + `zIndex: 0` prendem o Leaflet aqui dentro. Ele
          desenha as camadas dele em z-index 400 e os controles em 1000, soltos
          no documento — sem esta caixa, o mapa embutido subia POR CIMA do modal
          do "Ampliar" e os dois mapas ficavam um sobre o outro. */}
      <div style={{ border: `1.5px solid ${mexeu ? '#16a34a' : 'var(--border,#2a2a3a)'}`, borderRadius: 12, overflow: 'hidden', background: 'var(--surface,#16161f)', position: 'relative', zIndex: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 12px' }}>
          <strong style={{ fontSize: 13.5, color: 'var(--text,#fff)' }}>📍 Onde o entregador vai chegar</strong>
          <button type="button" onClick={onAmpliar}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #7c3aed', background: 'rgba(124,58,237,.12)', color: '#a78bfa', fontWeight: 700, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            ⛶ Ampliar
          </button>
        </div>
        <div ref={mapRef} style={{ width: '100%', height: 220 }} />
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-muted,#9aa)' }}>
            Confira se o pino está na sua casa. Está no lugar errado? <strong style={{ color: 'var(--text,#fff)' }}>Arraste ele</strong> ou toque no ponto certo.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={usarMinhaLocalizacao}
              style={{ padding: '8px 12px', borderRadius: 9, border: '1.5px solid #7c3aed', background: 'rgba(124,58,237,.12)', color: '#a78bfa', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }}>
              {locLoading ? 'Localizando…' : '🎯 Usar minha localização'}
            </button>
            <div style={{ fontSize: 13, color: foraRaio ? '#f87171' : 'var(--text,#fff)', fontWeight: 600 }}>{linhaDistancia}</div>
          </div>
          {avisoBairro}
          {exigeManual && !mexeu && (
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#a78bfa', background: 'rgba(124,58,237,.12)', border: '1px solid rgba(124,58,237,.4)', borderRadius: 8, padding: '9px 11px' }}>
              📍 <strong>Arraste o pino até a sua casa.</strong> O ponto que o mapa achou sozinho já errou o seu endereço antes — por isso precisamos que você aponte.
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 }} onClick={onClose}>
      <div style={{ width: '100%', maxWidth: 560, background: 'var(--surface,#16161f)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '92vh' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: '1px solid var(--border,#2a2a3a)' }}>
          <strong style={{ fontSize: 15, color: 'var(--text,#fff)' }}>📍 Marque o ponto exato da entrega</strong>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted,#9aa)', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>
        {/* `flex` + `minHeight` pequenos: o modal tem teto de 92vh e embaixo do
            mapa ainda vêm botão, distância e avisos. Com altura fixa de 58vh a
            soma passava do teto, o `overflow: hidden` do modal cortava o mapa
            no meio e o rodapé do Leaflet aparecia fora do lugar. */}
        <div ref={mapRef} style={{ width: '100%', height: '58vh', minHeight: 220, flex: '1 1 auto' }} />
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border,#2a2a3a)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={usarMinhaLocalizacao} style={{ padding: '9px 14px', borderRadius: 10, border: '1.5px solid #7c3aed', background: 'rgba(124,58,237,.12)', color: '#a78bfa', fontWeight: 700, fontSize: 13.5, cursor: 'pointer' }}>
              {locLoading ? 'Localizando…' : '🎯 Usar minha localização'}
            </button>
            <div style={{ fontSize: 14, color: foraRaio ? '#f87171' : 'var(--text,#fff)', fontWeight: 600 }}>{linhaDistancia}</div>
          </div>
          {avisoBairro}
          {/* Sem local definido = pino ainda parado na loja. Bloqueia pra não
              gravar o endereço da loja no lugar do endereço do cliente.
              `exigeManual` é o cliente marcado pra reconfirmar: pra ele o pino
              do buscador não serve, tem que apontar a casa com o dedo. */}
          {exigeManual && !mexeu && (
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#a78bfa', background: 'rgba(124,58,237,.12)', border: '1px solid rgba(124,58,237,.4)', borderRadius: 8, padding: '9px 11px' }}>
              📍 <strong>Arraste o pino até a sua casa.</strong> O ponto que o mapa achou sozinho já errou o seu endereço antes — por isso precisamos que você aponte.
            </div>
          )}
          <button type="button" onClick={() => liberado && onConfirm({ lat: coord.lat, lng: coord.lng, dist, taxa, manual: interagiu.current })} disabled={!liberado}
            style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', background: liberado ? '#7c3aed' : '#4b3a7a', color: '#fff', fontWeight: 800, fontSize: 15, cursor: liberado ? 'pointer' : 'not-allowed' }}>
            {!definido ? 'Arraste o pino até sua casa'
              : (exigeManual && !mexeu) ? 'Arraste o pino até sua casa'
              : 'Confirmar este local'}
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
  // A lista do IBGE não veio: o campo vira texto livre em vez de virar parede.
  const [cidadeLivre, setCidadeLivre] = useState(false)
  const [loadingCidades, setLoadingCidades] = useState(false)
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep, setErroCep]     = useState(null)
  // Busca de RUA pelo nome (ViaCEP ao contrário: UF + cidade + rua devolve os
  // endereços com CEP). É a porta de entrada agora — cliente que não sabe o CEP
  // travava logo na primeira linha do formulário e ia embora.
  const [ruaSugestoes, setRuaSugestoes] = useState([])
  const [ruaBuscando, setRuaBuscando] = useState(false)
  const [ruaAberta, setRuaAberta] = useState(false)
  // Procurou e não achou. A busca de rua roda numa cidade só — a que o cliente
  // escolheu ou, enquanto ele não escolhe, a da LOJA. Quem mora na cidade
  // vizinha digitava a rua certa e não via a rua dele na lista, sem nenhuma
  // explicação: uma cliente da CDBom (São Gonçalo) procurou a rua dela, que é
  // em Natal, e ficou presa aí. Guardar o "não achei" é o que deixa a tela
  // dizer isso em voz alta, e oferecer as duas saídas.
  const [ruaNaoAchou, setRuaNaoAchou] = useState(false)
  // Cidades em que a loja JÁ entregou (mig 0241). Loja de divisa atende as
  // duas: a CDBom fica em São Gonçalo do Amarante e metade da freguesia é de
  // Natal. Sem isto a busca de rua olhava só a cidade da loja.
  const [cidadesLoja, setCidadesLoja] = useState([])
  // O que o ViaCEP devolveu pro último CEP válido — pra avisar se a rua/bairro
  // digitados não baterem (caso do endereço trocado na mão).
  const [cepInfo, setCepInfo] = useState(null) // { cep, rua, bairro }
  const [userId, setUserId]         = useState(null)
  const [reconhecido, setReconhecido] = useState(false) // cadastro achado pelo telefone
  const [reconfirmar, setReconfirmar] = useState(false) // só a minoria com endereço errado: obriga remarcar o pino uma vez
  const [coordCliente, setCoordCliente] = useState(null) // {lat,lng} do ponto de entrega
  const [mapaAberto, setMapaAberto]     = useState(false)
  const pinManualRef = useRef(false) // true quando o cliente marcou no mapa (não sobrescreve com geocode)
  const reverseTimer = useRef(null)  // espera o dedo parar antes de perguntar a rua do pino
  // Espelho do formulário pra ler DE FORA do render (o reverse do pino roda
  // 900ms depois, num timeout).
  const formRef = useRef(null)
  useEffect(() => { formRef.current = form })
  const [enderecoDoPino, setEnderecoDoPino] = useState(null) // { rua, bairro } que o pino trouxe

  // Taxa que está na tela do cliente, pro registro do funil. É ref porque o
  // efeito que anota o contato roda aqui em cima e a taxa só é calculada lá
  // embaixo (depois do `return` de sacola vazia, onde não cabe outro hook).
  const taxaFunilRef = useRef(null)
  // Pino que o cliente já apontou em pedido anterior, vindo do cadastro dele.
  // {lat, lng, ref} — `ref` é o endereço a que ele pertence (mig 0160).
  const [pinSalvo, setPinSalvo] = useState(null)

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

  // Degrau 3 do funil: chegou na tela de endereço/pagamento. Quem para aqui
  // montou a sacola e desistiu na hora de se identificar ou de ver o frete —
  // é outro problema, e outra conversa com o lojista.
  //
  // Efeito próprio, e não junto com o de baixo, pra marcar UMA vez ao entrar:
  // o valor da sacola não pode fazer isso disparar de novo.
  useEffect(() => {
    if (state?.empresaId) marcarEtapa(state.empresaId, 'endereco', state?.subtotal ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.empresaId])

  // Telefone que veio no link do WhatsApp: preenche o campo e deixa o
  // reconhecimento (buscar_cliente_loja) fazer o resto — nome, endereço e o
  // pino que ele já apontou. É o que faz o link da resposta automática valer a
  // pena: ele abre com tudo pronto em vez de um formulário em branco.
  const telefoneDoLinkRef = useRef(false)
  useEffect(() => {
    if (telefoneDoLinkRef.current) return
    const tel = String(state?.telefone ?? '').replace(/\D/g, '')
    if (tel.length < 10) return
    // O telefone do link MANDA sobre o cliente lembrado no aparelho: quem clicou
    // veio do WhatsApp dele, e o celular pode ter o cadastro de outra pessoa da
    // casa salvo de um pedido anterior.
    if (form.telefone.replace(/\D/g, '') === tel) { telefoneDoLinkRef.current = true; return }
    telefoneDoLinkRef.current = true
    setForm(prev => ({ ...prev, telefone: fmtTelefone(tel) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.telefone, form.telefone])

  // Nome, telefone, CEP e TAXA de quem CHEGOU no cadastro — inclusive de quem
  // não termina. É o que diz se as cinco visitas que travaram no endereço são
  // cinco pessoas ou uma tentando cinco vezes, se elas moram fora do raio e —
  // com a taxa — se o que assustou foi o frete: sacola de R$ 14 com R$ 10 de
  // entrega é outra conversa.
  //
  // Espera 2s parado pra não mandar uma letra por vez enquanto ele digita.
  useEffect(() => {
    if (!state?.empresaId) return
    const nome = form.nome?.trim()
    const telefone = form.telefone?.replace(/\D/g, '')
    const cep = form.cep?.replace(/\D/g, '')
    // Telefone e CEP só valem inteiros: meio telefone não serve pra ninguém.
    const t = setTimeout(() => anotarContato(state.empresaId, {
      nome: nome && nome.length >= 2 ? nome : null,
      telefone: telefone && telefone.length >= 10 ? telefone : null,
      cep: cep && cep.length === 8 ? cep : null,
      taxa: taxaFunilRef.current,
    }), 2000)
    return () => clearTimeout(t)
    // bairro/pino/tipo entram nas dependências porque são eles que mudam a taxa.
  }, [state?.empresaId, form.nome, form.telefone, form.cep, form.bairro, tipo, coordCliente, lojaEndereco])

  // Endereço da loja — mostrado quando o cliente escolhe Retirada
  useEffect(() => {
    if (!state?.empresaId) return
    supabase.from('empresas')
      .select('endereco, numero, telefone_contato, bairro, cidade, estado, latitude, longitude, delivery_ativo, taxas_entrega_km, taxas_entrega_bairro, raio_entrega_km, pedido_minimo, aceita_retirada, aceita_entrega, formas_pagamento, chave_pix, pix_nome, horarios_funcionamento, feriados_fecha, agendamento_ativo, agendamento_dias, agendamento_antecedencia_min, agendamento_faixas, repasse_credito_pct, repasse_debito_pct, repasse_cartao_pct')
      .eq('id', state.empresaId)
      .maybeSingle()
      .then(({ data }) => setLojaEndereco(data ?? null))
  }, [state?.empresaId])

  // ── Pedido agendado (mig 0222) ───────────────────────────────
  // Dia e hora saem da MESMA regra que diz se a loja está aberta: grade da
  // semana + feriado + dia marcado na mão. Sem isso o cliente agendaria pra uma
  // segunda-feira que a loja não abre.
  const [excecoes, setExcecoes] = useState({})
  const [quando, setQuando] = useState('agora')   // 'agora' | 'agendado'
  const [agDia, setAgDia] = useState('')
  const [agHora, setAgHora] = useState('')       // começo da janela ('HH:MM')
  // Relógio de meio em meio minuto. Fica aqui em cima porque tudo que é de
  // horário depende dele — e dependência de efeito é lida no render: declarado
  // depois, o checkout abria em branco com "Cannot access before initialization".
  const [tiqueRelogio, setTiqueRelogio] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTiqueRelogio(t => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  // Vagas por dia/janela, vindas da RPC agendamento_vagas (mig 0225).
  const [vagas, setVagas] = useState({})

  useEffect(() => {
    if (!state?.empresaId) return
    let vivo = true
    carregarExcecoes(supabase, state.empresaId).then(e => { if (vivo) setExcecoes(e) })
    return () => { vivo = false }
  }, [state?.empresaId])

  // Quantas vagas sobraram em cada janela dos próximos dias. Vem por RPC: o
  // visitante anônimo não pode ler a tabela de pedidos, e aqui ele recebe só a
  // contagem. Recarrega ao abrir e a cada tique do relógio (alguém pode ter
  // fechado um pedido enquanto ele preenchia o endereço).
  useEffect(() => {
    if (!state?.empresaId || !lojaEndereco?.agendamento_ativo) return
    const nDias = Math.max(0, Number(lojaEndereco?.agendamento_dias ?? 2))
    const hoje = new Date()
    let vivo = true
    ;(async () => {
      const acc = {}
      for (let i = 0; i <= nDias; i++) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + i)
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const { data } = await supabase.rpc('agendamento_vagas', { p_empresa: state.empresaId, p_data: ymd })
        acc[ymd] = Object.fromEntries((data ?? []).map(r => [r.inicio, { usados: r.usados, limite: r.limite }]))
      }
      if (vivo) setVagas(acc)
    })()
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.empresaId, lojaEndereco?.agendamento_ativo, lojaEndereco?.agendamento_dias, tiqueRelogio])

  const agendaLigada = !!lojaEndereco?.agendamento_ativo

  // A loja está aberta AGORA — recalculado de meio em meio minuto, aqui dentro.
  //
  // Antes valia só o que a vitrine tinha dito quando o cliente clicou em
  // finalizar. Quem abriu o cardápio 11h50 e demorou pra fechar o pedido
  // passava reto: o pedido #1003 da CD Bom entrou 12h02 com a loja fechada
  // desde meio-dia (02/09/2026).
  const lojaAbertaAgora = useMemo(() => {
    // Config ainda não chegou: vale o que a vitrine disse (não dá pra travar
    // ninguém por causa de uma consulta lenta).
    if (!lojaEndereco) return state?.lojaAberta !== false
    if (lojaEndereco.delivery_ativo === false) return false
    return abertaAgora({
      grade: lojaEndereco.horarios_funcionamento,
      excecoes,
      fechaFeriado: !!lojaEndereco.feriados_fecha,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lojaEndereco, excecoes, tiqueRelogio, state?.lojaAberta])
  const lojaEstavaAberta = lojaAbertaAgora
  const diasAgenda = useMemo(() => (
    agendaLigada
      ? diasParaAgendar({
          grade: lojaEndereco?.horarios_funcionamento,
          excecoes,
          fechaFeriado: !!lojaEndereco?.feriados_fecha,
          dias: Number(lojaEndereco?.agendamento_dias ?? 2),
          antecedencia: Number(lojaEndereco?.agendamento_antecedencia_min ?? 60),
          faixas: lojaEndereco?.agendamento_faixas,
          vagas,
        })
      : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [agendaLigada, lojaEndereco, excecoes, vagas, tiqueRelogio])

  // Loja fechada só tem um caminho: agendar. Já deixa o primeiro horário livre
  // escolhido — a maioria quer o mais cedo possível.
  useEffect(() => {
    if (!agendaLigada) { setQuando('agora'); return }
    if (!lojaEstavaAberta) setQuando('agendado')
  }, [agendaLigada, lojaEstavaAberta])

  // Já deixa escolhida a primeira janela LIVRE — a maioria quer o quanto antes,
  // e cair numa esgotada só pra descobrir no fim seria armadilha.
  useEffect(() => {
    if (quando !== 'agendado' || !diasAgenda.length) return
    const dia = diasAgenda.find(d => d.ymd === agDia) ?? diasAgenda[0]
    const livre = dia.faixas.find(f => !f.cheia) ?? dia.faixas[0]
    if (dia.ymd !== agDia) { setAgDia(dia.ymd); setAgHora(livre?.i ?? ''); return }
    const atual = dia.faixas.find(f => f.i === agHora)
    if (!atual || atual.cheia) setAgHora(livre?.i ?? '')
  }, [quando, diasAgenda, agDia, agHora])

  const faixasDoDia = diasAgenda.find(d => d.ymd === agDia)?.faixas ?? []
  const faixaEscolhida = faixasDoDia.find(f => f.i === agHora && !f.cheia) ?? null
  const agendadoPara = (quando === 'agendado' && agDia && faixaEscolhida) ? paraISO(agDia, faixaEscolhida.i) : null
  const agendadoAte = (quando === 'agendado' && agDia && faixaEscolhida) ? paraISO(agDia, faixaEscolhida.f) : null

  // A loja pode desligar "Retirar na loja" nas configurações (Raio de entrega).
  // Enquanto os dados não chegaram, deixa aparecer — assim o botão não pisca
  // pra quem tem retirada ligada, que é a maioria.
  const permiteRetirada = lojaEndereco ? lojaEndereco.aceita_retirada !== false : true
  // Bar que so atende no balcao: desliga a entrega e o cardapio online passa
  // a oferecer so retirada. Nao mexe em WhatsApp, balcao, mesas nem iFood.
  const permiteEntrega  = lojaEndereco ? lojaEndereco.aceita_entrega  !== false : true

  // Formas de pagamento ligadas pela loja (Minha Loja → Pagamento).
  const formasLoja = formasAtivas(lojaEndereco)
  // Se a loja desligou a forma que estava escolhida (ou salva no rascunho),
  // troca pela primeira ativa — senão o cliente fecharia com um meio recusado.
  useEffect(() => {
    if (!lojaEndereco) return
    if (!formasLoja.includes(form.pagamento)) set('pagamento', formasLoja[0])
  }, [lojaEndereco, form.pagamento]) // eslint-disable-line react-hooks/exhaustive-deps

  // Se a loja desligou a retirada e o cliente tinha um rascunho salvo com ela
  // escolhida, volta pra entrega — senão ele fecharia um pedido inválido.
  useEffect(() => {
    if (!permiteRetirada && tipo === 'retirada') setTipo('entrega')
    // E o contrário: loja que não entrega força a retirada, senão o cliente
    // chegaria no fim com um pedido de entrega que a loja não faz.
    if (!permiteEntrega && tipo === 'entrega') setTipo('retirada')
  }, [permiteRetirada, permiteEntrega, tipo])

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

  // Crédito da loja pelo telefone (mig 0178). Mesma deixa do reconhecimento
  // abaixo: assim que o telefone fica completo, pergunta quanto ele tem.
  // Mesmo tema que o catálogo grava. Sem isto o cliente escolhia claro na
  // vitrine, ia pagar e a tela virava preta — com o nome do produto escuro
  // sobre escuro, ilegível.
  const tema = (() => {
    try { return localStorage.getItem('dloja-tema') || 'claro' } catch { return 'claro' }
  })()

  const [saldoCashback, setSaldoCashback] = useState(0)
  const [usarCashback, setUsarCashback]   = useState(true)
  useEffect(() => {
    const empId = state?.empresaId
    const tel = form.telefone.replace(/\D/g, '')
    if (!empId || tel.length < 10) { setSaldoCashback(0); return }
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc('cashback_por_telefone', {
        p_empresa_id: empId, p_telefone: tel,
      })
      setSaldoCashback(Number(data ?? 0))
    }, 700)
    return () => clearTimeout(t)
  }, [form.telefone, state])

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
      // Pino que ESTE cliente já apontou no mapa (mig 0160). Só o manual volta:
      // ponto que o buscador chutou não é confiável pra calcular taxa — foi ele
      // que cobrou R$ 8 de quem morava a 500 m. Quem aplica é o efeito abaixo,
      // depois de conferir que o endereço na tela é o mesmo do pino.
      if (data.endereco_pin_manual && data.endereco_lat != null && data.endereco_lng != null) {
        setPinSalvo({ lat: Number(data.endereco_lat), lng: Number(data.endereco_lng), ref: data.endereco_pin_ref || null })
      }
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

  // Reaproveita o pino que o cliente já apontou, desde que o endereço na tela
  // ainda seja o mesmo a que aquele pino pertence. É isto que impede o buscador
  // de mapa de reescrever, a cada pedido, um acerto que o cliente já fez à mão.
  useEffect(() => {
    if (!pinSalvo || tipo !== 'entrega') return
    if (chaveEndereco(form) !== pinSalvo.ref) return
    if (coordCliente && pinManualRef.current) return
    pinManualRef.current = true
    setCoordCliente({ lat: pinSalvo.lat, lng: pinSalvo.lng })
  }, [pinSalvo, form.rua, form.numero, form.bairro, form.cidade, tipo, coordCliente]) // eslint-disable-line react-hooks/exhaustive-deps

  // Geocodifica o endereço (debounced) pra estimar a taxa por distância mesmo sem
  // abrir o mapa. Se o cliente já marcou o ponto no mapa, não sobrescreve.
  useEffect(() => {
    if (tipo !== 'entrega' || pinManualRef.current || !state?.empresaId) return
    const rua = form.rua.trim(), cidade = form.cidade
    if (!rua || !cidade) return
    // SÓ depois do número. Sem ele o buscador devolve um ponto no meio da rua —
    // e o cliente, vendo um pino já posto no mapa, confirma sem mexer. Era daí
    // que saía a taxa errada. Mapa vazio pedindo o número é melhor que pino
    // errado que parece certo.
    if (!form.numero.trim()) return
    const t = setTimeout(async () => {
      const c = await geocodeEndereco({ rua, numero: form.numero, bairro: form.bairro, cidade, estado: form.estado, cep: form.cep })
      if (c && !pinManualRef.current) setCoordCliente(c)
    }, 900)
    return () => clearTimeout(t)
  }, [form.rua, form.numero, form.bairro, form.cidade, form.estado, form.cep, tipo, state])

  // Busca as ruas da cidade pelo nome (ViaCEP ao contrário). A cidade/UF vem do
  // que o cliente escolheu ou, se ainda não escolheu, da PRÓPRIA LOJA — que é
  // onde mora a maioria de quem pede. Assim ele digita a rua já na primeira
  // linha, sem precisar preencher estado e cidade antes.
  useEffect(() => {
    if (tipo !== 'entrega') return
    const termo = form.rua.trim()
    const uf = (form.estado || lojaEndereco?.estado || '').trim()
    const cid = (form.cidade || lojaEndereco?.cidade || '').trim()
    if (termo.length < 3 || !uf || cid.length < 3) { setRuaSugestoes([]); setRuaNaoAchou(false); return }
    let vivo = true
    setRuaBuscando(true)
    const t = setTimeout(async () => {
      try {
        const buscar = async (q, cidadeAlvo = cid) => {
          if (!q || q.length < 3 || !cidadeAlvo) return []
          try {
            const r = await fetch(`https://viacep.com.br/ws/${uf}/${encodeURIComponent(cidadeAlvo)}/${encodeURIComponent(q)}/json/`)
            const j = await r.json()
            return Array.isArray(j) ? j : []
          } catch { return [] }
        }
        // A busca do ViaCEP é literal: ela procura o texto INTEIRO dentro do
        // nome oficial. "Rua Eliane Barros" não acha "Rua Doutora Eliane
        // Barros" — o "Doutora" no meio quebra. Então:
        //   1) tira o tipo do logradouro (Rua, Av., Travessa...), que o cliente
        //      escreve e o cadastro guarda de outro jeito;
        //   2) não achando, tenta a maior palavra do que ele digitou, que é a
        //      que identifica a rua ("barros", "eliane").
        const semTipo = termo
          .replace(/^(r|rua|av|avn|avenida|trav|travessa|al|alameda|pc|praca|praça|rod|rodovia|estr|estrada|beco|conj|conjunto|lot|loteamento|vl|vila)\.?\s+/i, '')
          .trim()
        const maior = semTipo.split(/\s+/).filter(w => w.length >= 4).sort((x, y) => y.length - x.length)[0]
        // Procura primeiro na cidade em jogo; não achando, nas outras em que a
        // loja já entregou. A lista mostra o bairro e a cidade de cada rua, e
        // escolher uma delas já preenche a cidade certa no formulário — que é
        // como a cliente de Natal acha a rua dela numa loja de São Gonçalo.
        const cidadesParaTentar = [cid, ...cidadesLoja.filter(c => c && c !== cid)].slice(0, 3)
        // Procura em TODAS as cidades e JUNTA. Parar na primeira que devolvesse
        // alguma coisa era o furo: o ViaCEP casa pedaço de nome, então
        // "sebastiana" achava "Sebastiana Benevides" em São Gonçalo, a busca
        // dava por encerrada e nunca chegava em Natal — onde fica a "Sebastiana
        // Andrade" que a cliente tinha acabado de digitar.
        const listas = await Promise.all(cidadesParaTentar.map(c => buscar(semTipo || termo, c)))
        let d = listas.flat()
        if (!d.length && maior) {
          const listas2 = await Promise.all(cidadesParaTentar.map(c => buscar(maior, c)))
          d = listas2.flat()
        }
        // O ESTADO INTEIRO entra sempre que NENHUMA rua casou com tudo o que ele
        // escreveu — não só quando a lista está vazia. Uma lista com a rua
        // errada dentro é pior que uma lista vazia: parece resposta.
        if (!d.some(x => ruaCasouInteira(x.logradouro, semTipo || termo))) {
          const doEstado = await buscarRuaNoEstado(uf, semTipo || termo)
          d = [...d, ...doEstado]
        }
        if (!vivo) return
        // Sem repetir a mesma rua em CEPs diferentes: numa avenida longa o
        // ViaCEP devolve dezenas de linhas iguais e a lista vira ruído.
        const vistas = new Set()
        const lista = (Array.isArray(d) ? d : []).filter(x => {
          const k = `${x.logradouro}|${x.bairro}`
          if (vistas.has(k)) return false
          vistas.add(k)
          return !!x.logradouro
        })
        // O que ele escreveu vem primeiro. Sem isto a rua certa de Natal
        // aparecia embaixo da rua parecida de São Gonçalo, e ninguém rola uma
        // lista de sugestão até o fim.
        lista.sort((a, b) => pontosDaRua(b.logradouro, semTipo || termo) - pontosDaRua(a.logradouro, semTipo || termo))
        setRuaSugestoes(lista.slice(0, 8))
        setRuaNaoAchou(lista.length === 0)
      } catch { if (vivo) { setRuaSugestoes([]); setRuaNaoAchou(true) } }
      finally { if (vivo) setRuaBuscando(false) }
    }, 500)
    return () => { vivo = false; clearTimeout(t); setRuaBuscando(false) }
  }, [form.rua, form.estado, form.cidade, lojaEndereco, tipo, cidadesLoja])

  // As cidades que a loja já atendeu — carregadas uma vez, usadas como segunda
  // tentativa da busca de rua.
  useEffect(() => {
    const empId = state?.empresaId
    if (!empId) return
    let vivo = true
    supabase.rpc('cidades_que_a_loja_atende', { p_empresa_id: empId })
      .then(({ data }) => { if (vivo && Array.isArray(data)) setCidadesLoja(data) })
    return () => { vivo = false }
  }, [state?.empresaId])

  // Chegar no checkout já é sinal de intenção de compra (funil da Meta).
  // As tags já foram carregadas na vitrine — aqui só dispara o evento.
  useEffect(() => {
    if (!state?.itens?.length) return
    iniciarCheckout(state.itens, Number(state.subtotal ?? 0) + Number(state.taxaEntrega ?? 0))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // A taxa NÃO PODE sair no chute. Quando o cálculo não fecha, o código caía em
  // `taxaEntrega` (a taxa fixa da loja) — e loja que cobra por km deixa esse
  // campo em 0, então o pedido saía DE GRAÇA sem ninguém perceber. Aconteceu 4x
  // na Zebu em 30 dias.
  //
  // Dois jeitos de não fechar:
  //   1. a config da loja não carregou (rede falhou) → não dá pra saber a taxa;
  //   2. cobra por km e o endereço ainda não virou ponto no mapa.
  // Nos dois casos é melhor segurar o botão do que entregar grátis.
  const configNaoCarregou = tipo === 'entrega' && lojaEndereco === null
  const taxaIndefinida = !bairroBloqueado && (configNaoCarregou || taxaPendente)

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
  const totalBruto = subtotal + taxaAplicada
  // O que vai pro funil: só a taxa que o cliente realmente viu. Enquanto ela
  // está indefinida (ou o bairro nem é atendido) o número seria chute, e chute
  // no relatório é pior que campo vazio.
  taxaFunilRef.current = (taxaIndefinida || bairroBloqueado) ? null : taxaAplicada

  // Crédito da loja (mig 0178). O saldo aparece pelo telefone porque no
  // checkout da loja online nao existe login: o cliente so e criado no momento
  // do envio, e o telefone e a unica chave que ja esta na tela.
  //
  // Nunca cobre a conta inteira - a loja precisa receber alguma coisa, e pedido
  // de R$ 0 quebra o PIX. O servidor recusa tambem, isto aqui e so pra tela nao
  // oferecer o que vai ser negado.
  const cashbackMax = Math.max(0, Math.round((totalBruto - 0.01) * 100) / 100)
  const cashbackUsado = usarCashback ? Math.min(saldoCashback, cashbackMax) : 0
  // Acréscimo da forma de pagamento (mig 0223). Incide sobre o que vai passar na
  // maquineta de verdade — ou seja, depois do cashback abatido. Loja que não
  // cobra tem 0 e nada muda.
  // Enquanto a entrega está "a calcular", o acréscimo sai só sobre o que já é
  // certo: mostrar 5% de um total que a tela nem exibe ainda parecia conta
  // errada. Marcado o endereço, os dois números sobem juntos.
  const baseCartao = Math.max(0, Math.round(
    ((subtotal + (taxaIndefinida ? 0 : taxaAplicada)) - cashbackUsado) * 100) / 100)
  const acrescimoPagamento = Math.round(baseCartao * repassePct(lojaEndereco, form.pagamento)) / 100
  const total = Math.round((baseCartao + acrescimoPagamento) * 100) / 100

  // Pedido mínimo (só entrega, conta o subtotal dos produtos — sem a taxa)
  const pedidoMinimo = Number(lojaEndereco?.pedido_minimo ?? 0)
  const faltaMinimo = tipo === 'entrega' && pedidoMinimo > 0 && subtotal < pedidoMinimo
  const faltamParaMinimo = faltaMinimo ? (pedidoMinimo - subtotal) : 0

  // Campos que definem ONDE o pino está. Mexeu num deles, o pino que estava
  // valendo não vale mais — senão o cliente muda de casa (ou corrige o número)
  // e continua pagando a taxa do endereço velho.
  const CAMPOS_DO_PINO = ['rua', 'numero', 'bairro', 'cidade', 'estado', 'cep']

  function set(field, value) {
    // Só invalida em mudança de verdade: carregarCidades reescreve a mesma
    // cidade ao voltar do cadastro e derrubaria o pino recuperado à toa.
    if (CAMPOS_DO_PINO.includes(field) && form[field] !== value) {
      setCoordCliente(null)
      pinManualRef.current = false
    }
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }))
  }

  // Cliente confirmou o ponto no mapa: fixa o pino, calcula a taxa e preenche o endereço.
  // `manual` diz se o ponto saiu do DEDO do cliente ou se ele só confirmou o que
  // o buscador de mapa tinha chutado — só o primeiro é bom o bastante pra virar
  // o pino oficial do cadastro dele (mig 0160).
  // Mapa embutido: cada arrasto já vale, sem botão de confirmar.
  // QUEM MANDA NO ENDEREÇO É O PINO.
  //
  // Dava pra digitar a rua certa, arrastar o pino pra porta da loja e pagar a
  // taxa mínima: a conta é pela distância do pino, mas o papel saía com a rua
  // digitada. Marajó #298 (06/09/2026): endereço na Pajuçara, pino a 50 m da
  // pizzaria, R$ 3,00 numa entrega de R$ 6,00.
  //
  // Agora, mexeu no pino, o endereço passa a ser o DAQUELE ponto. Quem tentar
  // baratear arrastando o pino pra perto da loja recebe o pedido com a rua da
  // loja escrita — e é pra lá que o motoboy vai. No uso honesto não muda nada:
  // o máximo que acontece é ajustar o pino dentro da própria rua.
  const mesmaRua = (a, b) => String(a ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    === String(b ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  function enderecoPeloPino(lat, lng) {
    clearTimeout(reverseTimer.current)
    // Espera o dedo parar: o arrasto dispara a cada movimento e o Nominatim
    // aceita 1 consulta por segundo.
    reverseTimer.current = setTimeout(async () => {
      const a = await reverseGeocode(lat, lng)
      // Mapa sem resposta (ou sem rua no ponto) NÃO apaga o que a pessoa
      // escreveu — endereço em branco é pedido perdido.
      if (!a?.rua) return
      const cepFmt = a.cep && a.cep.length === 8 ? `${a.cep.slice(0, 5)}-${a.cep.slice(5)}` : ''
      // A decisão é tomada AQUI, e não dentro do setForm: o React só executa a
      // função do setState na hora de renderizar, então a variável que marcava
      // "mudou" ainda era falsa quando eu ia usá-la — e o aviso na tela nunca
      // aparecia, mesmo com o endereço já trocado. Trocar o endereço de alguém
      // sem avisar é o oposto do que isto veio fazer.
      const atual = formRef.current ?? {}
      if (mesmaRua(atual.rua, a.rua)) return   // ajustou dentro da mesma rua: nada a fazer
      // SÓ REESCREVE SE MUDOU DE BAIRRO.
      //
      // Testado em 06/09/2026: dois pontos a 45 METROS de distância, perto de
      // uma esquina, voltaram ruas diferentes ("Avenida das Fronteiras" e
      // "Rua dos Coqueiros"). Reescrever a cada ajuste fino trocaria a rua
      // certa de quem mora na esquina — o motoboy iria pra rua errada, que é
      // pior que a taxa errada.
      //
      // O bairro é grosso o bastante pra não errar num ajuste de metros, e é
      // exatamente ele que denuncia a trapaça: quem digita Pajuçara e joga o
      // pino na porta da loja cai em Nossa Senhora da Apresentação.
      // Sem bairro no ponto (ou sem bairro digitado) não dá pra comparar:
      // fica o que a pessoa escreveu.
      const bairroDigitado = String(atual.bairro ?? '').trim()
      if (bairroDigitado && (!a.bairro || mesmaRua(bairroDigitado, a.bairro))) return

      setForm(prev => ({
        ...prev,
        rua:    a.rua,
        bairro: a.bairro || prev.bairro,
        cidade: a.cidade || prev.cidade,
        estado: a.estado || prev.estado,
        // O número é da casa, e GPS não sabe número: fica o que a pessoa pôs.
        cep:    cepFmt || prev.cep,
      }))
      setEnderecoDoPino({ rua: a.rua, bairro: a.bairro || '' })
      if (a.estado && a.estado !== atual.estado) carregarCidades(a.estado, a.cidade || '')
    }, 900)
  }

  function pontoDoMapa({ lat, lng, manual }) {
    if (manual) pinManualRef.current = true
    setCoordCliente(prev =>
      prev && Math.abs(prev.lat - lat) < 1e-7 && Math.abs(prev.lng - lng) < 1e-7
        ? prev
        : { lat, lng })
    // Só quando foi a PESSOA que mexeu. O pino que o buscador põe sozinho já
    // veio do endereço digitado — reescrever ali seria o mapa discutindo com
    // ele mesmo.
    if (manual) enderecoPeloPino(lat, lng)
  }

  function confirmarMapa({ lat, lng, manual }) {
    pinManualRef.current = !!manual
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
      if (a.rua && !mesmaRua(form.rua, a.rua)) setEnderecoDoPino({ rua: a.rua, bairro: a.bairro || '' })
      if (a.estado && a.estado !== form.estado) carregarCidades(a.estado, a.cidade || '')
    })
  }

  // A lista de cidades vem do IBGE. Quando ele engasga — e engasga — o
  // `catch` deixava a lista VAZIA: o cliente ficava com um campo obrigatório
  // que não abre, sem retentativa, sem aviso e sem saída. Aconteceu com um
  // cliente da CDBom em 05/09/2026: endereço todo preenchido, mapa com o pino
  // no lugar, e o pedido travado no "Selecione a cidade".
  //
  // Agora são três camadas: a lista guardada do último acesso (o cliente de uma
  // loja é quase sempre do mesmo estado), três tentativas com tempo limite, e —
  // se ainda assim não vier — o campo vira texto livre pra pessoa digitar.
  async function carregarCidades(uf, cidadeParaSelecionar = '') {
    setLoadingCidades(true)
    const chaveCache = `dco-cidades-${uf}`
    try {
      let lista = []
      try {
        const guardado = JSON.parse(localStorage.getItem(chaveCache) || 'null')
        if (Array.isArray(guardado) && guardado.length) { lista = guardado; setCidades(guardado) }
      } catch { /* cache torto: ignora e busca */ }

      for (let tentativa = 1; tentativa <= 3 && !lista.length; tentativa++) {
        const data = await buscarJson(
          `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`,
          6000,
        )
        if (Array.isArray(data) && data.length) lista = data.map(c => c.nome)
        else if (tentativa < 3) await new Promise(r => setTimeout(r, 800))
      }
      setCidades(lista)
      setCidadeLivre(!lista.length)
      if (lista.length) {
        try { localStorage.setItem(chaveCache, JSON.stringify(lista)) } catch { /* sem espaço: tudo bem */ }
      }
      if (cidadeParaSelecionar && !lista.length) {
        // Sem lista, a cidade que o CEP (ou a rua escolhida) disse é a melhor
        // informação que existe. Escrever ela é sempre melhor que deixar o
        // campo vazio esperando uma lista que não vem.
        setForm(prev => (prev.cidade ? prev : { ...prev, cidade: cidadeParaSelecionar }))
        setErrors(prev => (prev.cidade ? { ...prev, cidade: null } : prev))
      }
      if (cidadeParaSelecionar && lista.length) {
        const match = lista.find(c => c.toLowerCase() === cidadeParaSelecionar.toLowerCase())
        // setForm direto, NÃO o set(): isto é preenchimento automático (cadastro
        // do cliente, CEP, ponto do mapa), não o cliente trocando de cidade — se
        // passasse pelo set() derrubaria o pino que acabou de ser marcado.
        if (match) {
          setForm(prev => (prev.cidade === match ? prev : { ...prev, cidade: match }))
          setErrors(prev => (prev.cidade ? { ...prev, cidade: null } : prev))
        }
      }
    } catch {
      setCidades([])
      setCidadeLivre(true)
    } finally {
      setLoadingCidades(false)
    }
  }


  // Escolheu a rua na lista: preenche bairro, CEP, cidade e estado de uma vez.
  function escolherRua(r) {
    const cepNum = String(r.cep ?? '').replace(/\D/g, '')
    setForm(prev => ({
      ...prev,
      rua: r.logradouro || prev.rua,
      bairro: r.bairro || prev.bairro,
      cep: cepNum.length === 8 ? `${cepNum.slice(0, 5)}-${cepNum.slice(5)}` : prev.cep,
      cidade: prev.cidade || r.localidade || '',
      estado: prev.estado || r.uf || '',
    }))
    setRuaSugestoes([])
    setRuaAberta(false)
    // A lista de cidades é carregada pelo IBGE quando o cliente troca o estado
    // no seletor. Aqui o estado foi preenchido por baixo, então é preciso pedir
    // a lista na mão — senão a cidade fica escolhida no formulário e o seletor
    // aparece vazio, como se ele tivesse esquecido de preencher.
    const uf = r.uf || form.estado || lojaEndereco?.estado
    const cid = r.localidade || form.cidade || lojaEndereco?.cidade
    if (uf) carregarCidades(uf, cid)
    // Foi o cliente que escolheu: o pino pode ser recalculado por este endereço.
    //
    // E o pino VELHO cai junto. Escolher a rua pela lista mexia no endereço sem
    // passar pelo `set()`, então a coordenada da casa anterior continuava
    // valendo: o mapa mostrava um lugar e a taxa era cobrada de outro. Foi o
    // que apareceu no teste de 06/09/2026 — endereço em São Gonçalo do
    // Amarante, pino em Potengi, R$ 3,00 escrito no mapa e R$ 4,00 no resumo
    // do pedido.
    pinManualRef.current = false
    setCoordCliente(null)
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
    setCidadeLivre(false)
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
        ? 'Pra confirmar seu endereço, arraste o pino do mapa até onde você mora.'
        : 'Arraste o pino do mapa até a sua casa pra o entregador achar o endereço.')
      setMapaAberto(true)
      return
    }

    // Agendamento: sem dia e hora escolhidos o pedido não sai. Loja fechada é o
    // caso que mais importa — ali não existe "pra agora", e deixar passar criaria
    // um pedido pra uma cozinha que só abre daqui a quatro horas.
    if (agendaLigada && quando === 'agendado' && !agendadoPara) {
      setErroGlobal('Escolha o dia e o horário do seu pedido.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (agendaLigada && !lojaAbertaAgora && !agendadoPara) {
      setErroGlobal('A loja está fechada agora — escolha um horário pra agendar seu pedido.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    // Loja fechada e sem agendamento: o pedido não entra. É a última trava —
    // o cliente pode ter aberto o cardápio ainda no horário e fechado depois.
    if (!agendaLigada && !lojaAbertaAgora && !agendadoPara) {
      setErroGlobal('A loja fechou agora e não está mais recebendo pedidos. Volte no próximo horário de funcionamento.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    // Pedido mínimo para entrega
    if (faltaMinimo) {
      setErroGlobal(`Pedido mínimo para entrega é R$ ${fmt(pedidoMinimo)}. Faltam R$ ${fmt(faltamParaMinimo)} em produtos${permiteRetirada ? ' (ou escolha Retirada)' : ''}.`)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    // Bairro bloqueado (não entregamos)
    if (bairroBloqueado) {
      setErroGlobal(permiteRetirada
        ? 'Poxa, ainda não entregamos no seu bairro 😔. Você pode escolher Retirada, se disponível.'
        : 'Poxa, ainda não entregamos no seu bairro 😔.')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    // Última trava antes de gravar: pedido NUNCA sai com taxa chutada. O botão
    // já fica desabilitado, mas Enter no formulário passa por cima dele.
    if (taxaIndefinida) {
      setErroGlobal(configNaoCarregou
        ? 'Ainda estou calculando a taxa de entrega. Aguarde um instante ou recarregue a página.'
        : 'Marque seu endereço no mapa pra eu calcular a taxa de entrega.')
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
        // Guarda o ponto no cadastro pro próximo pedido não geocodificar de novo.
        // `p_pin_manual` separa o que o cliente apontou do que o buscador chutou:
        // o banco só deixa o chute entrar quando não há pino apontado (mig 0160).
        p_lat:         tipo === 'entrega' ? (coordCliente?.lat ?? null) : null,
        p_lng:         tipo === 'entrega' ? (coordCliente?.lng ?? null) : null,
        p_pin_manual:  tipo === 'entrega' && !!coordCliente && pinManualRef.current,
      })
      clienteId = cid ?? null
    } catch { /* não bloqueia o pedido */ }

    // Chegou pelo link de alguém? Amarra o vínculo (mig 0176). O crédito dos
    // dois só cai quando ESTE pedido for entregue.
    await registrarIndicacao(clienteId)

    const itensPedido = itens.map(i => ({
      produto_id:    i.id,
      // Dobra as escolhas no nome (aparece no painel/cupom) + guarda estruturado.
      // No atacado a quantidade de cada sabor entra junto: "Dadá (500× Leite
      // condensado, 100× Uva)" — sem isso a comanda diria só quais sabores,
      // e quem monta não saberia quanto separar de cada um.
      nome:          i.complementos?.length
        ? `${i.nome} (${i.complementos.map(c =>
            c?.absoluto ? `${Number(c.qtd) || 1}× ${c.nome}` : c.nome).join(', ')})`
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
        cashback_usado: cashbackUsado,
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
        // COORDENADA do ponto de entrega (geocodificada ou pino no mapa). Já era
        // calculada pra taxa por km e jogada fora; o motoqueiro ficava dependendo
        // do Maps adivinhar o texto — e endereço torto derrubava a rota inteira.
        endereco_lat:         tipo === 'entrega' ? (coordCliente?.lat ?? null) : null,
        endereco_lng:         tipo === 'entrega' ? (coordCliente?.lng ?? null) : null,
        observacoes:  form.observacoes.trim() || null,
        // Hora combinada. No PIX o cliente paga AGORA e a comida sai na hora
        // marcada — quem agenda já garantiu o lugar dele.
        agendado_para: agendadoPara,
        agendado_ate: agendadoAte,
        acrescimo: acrescimoPagamento,
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
        // Coordenada do ponto de entrega — ver comentário no payload do PIX.
        endereco_lat:         tipo === 'entrega' ? (coordCliente?.lat ?? null) : null,
        endereco_lng:         tipo === 'entrega' ? (coordCliente?.lng ?? null) : null,
        tipo_entrega:         tipo,
        origem: window.Capacitor?.isNativePlatform?.() ? 'app' : 'cardapio',
        itens: itensPedido,
        subtotal,
        taxa_entrega:   taxaAplicada,
        cashback_usado: cashbackUsado,
        total,
        forma_pagamento: form.pagamento,
        troco_para: form.pagamento === 'dinheiro' && form.troco
          ? Math.round(parseFloat(form.troco.replace(',', '.')) * 100) / 100
          : null,
        observacoes: form.observacoes.trim() || null,
        agendado_para: agendadoPara,
        agendado_ate: agendadoAte,
        acrescimo: acrescimoPagamento,
      })
      .select('id')
      .single()

    setEnviando(false)

    if (error) { setErroGlobal(error.message); return }

    lembrarCliente()
    // Degrau 4: fechou. Quem chega aqui saiu do funil pela porta certa.
    marcarEtapa(empresaId, 'pedido', state?.subtotal ?? null)
    registrarPedido(data.id, empresaId)
    navigate(`/pedido/${data.id}`, { replace: true })
  }

  return (
    <div className="dco-root" data-tema={tema}>
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

              {/* Tipo: entrega ou retirada.
                  Loja que desligou a retirada nas configurações só mostra entrega.
                  Loja que desligou a ENTREGA (bar que só atende no balcão) some
                  com os dois botões — não há o que escolher — mas a seção fica,
                  porque é dentro dela que aparece o endereço pra retirar. */}
              {(permiteRetirada || permiteEntrega) && (
              <section className="dco-section">
                <h2 className="dco-section-title">
                  {permiteEntrega ? 'Como você quer receber?' : 'Retirada na loja'}
                </h2>
                {permiteRetirada && permiteEntrega && (
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
                )}
                {tipo === 'retirada' && (
                  <div style={{
                    marginTop: 12, padding: '12px 14px', borderRadius: 10,
                    background: 'rgba(124,58,237,.1)', border: '1px solid rgba(124,58,237,.3)',
                    fontSize: 13.5, color: 'var(--text, #fff)', lineHeight: 1.5,
                  }}>
                    <strong>Você vai retirar na loja</strong> — sem taxa de entrega.
                    {lojaEndereco && (lojaEndereco.endereco || lojaEndereco.cidade) && (
                      <div style={{ marginTop: 4, opacity: .85 }}>
                        {/* Com o NÚMERO: "Rua Santo Antônio, Golandim" manda o
                            cliente pra rua toda e ele liga pra loja perguntar. */}
                        📍 {[
                          [lojaEndereco.endereco, lojaEndereco.numero].filter(Boolean).join(', '),
                          lojaEndereco.bairro,
                          lojaEndereco.cidade,
                        ].filter(Boolean).join(' — ')}
                      </div>
                    )}
                  </div>
                )}
              </section>
              )}

              {/* Quando o cliente quer — só aparece na loja que ligou o
                  agendamento. Fechada, "pra agora" nem existe: o único caminho
                  é escolher dia e hora dentro da grade da loja. */}
              {agendaLigada && (
              <section className="dco-section">
                <h2 className="dco-section-title">Quando você quer?</h2>
                {lojaEstavaAberta && (
                  <div className="dco-payment-row">
                    <button type="button"
                      className={`dco-pay-btn${quando === 'agora' ? ' dco-pay-btn--active' : ''}`}
                      onClick={() => setQuando('agora')}>
                      <span>⚡ Assim que possível</span>
                      {quando === 'agora' && <span className="dco-pay-check"><IconCheck /></span>}
                    </button>
                    <button type="button"
                      className={`dco-pay-btn${quando === 'agendado' ? ' dco-pay-btn--active' : ''}`}
                      onClick={() => setQuando('agendado')}
                      disabled={!diasAgenda.length}>
                      <span>🗓️ Agendar</span>
                      {quando === 'agendado' && <span className="dco-pay-check"><IconCheck /></span>}
                    </button>
                  </div>
                )}
                {quando === 'agendado' && (
                  diasAgenda.length === 0 ? (
                    <p style={{ fontSize: 13.5, color: 'var(--dl-text-muted, #9aa0b5)', margin: '10px 0 0' }}>
                      Não tem horário livre pra agendar agora. Tente mais tarde.
                    </p>
                  ) : (
                    <div style={{ marginTop: 12 }}>
                      <label className="dco-label">Dia</label>
                      <div className="dco-ag-chips">
                        {diasAgenda.map(d => (
                          <button key={d.ymd} type="button"
                            className={`dco-ag-chip${agDia === d.ymd ? ' dco-ag-chip--active' : ''}`}
                            onClick={() => { setAgDia(d.ymd); setAgHora(d.horarios[0]) }}>
                            {d.rotulo}
                          </button>
                        ))}
                      </div>
                      <label className="dco-label" style={{ marginTop: 12 }}>Horário da entrega</label>
                      <div className="dco-ag-chips">
                        {faixasDoDia.map(f => (
                          <button key={f.i} type="button"
                            className={`dco-ag-chip${agHora === f.i && !f.cheia ? ' dco-ag-chip--active' : ''}`}
                            onClick={() => !f.cheia && setAgHora(f.i)}
                            disabled={f.cheia}
                            title={f.cheia ? 'Esgotado pra esse dia' : undefined}
                            style={f.cheia ? { opacity: .45, cursor: 'not-allowed', textDecoration: 'line-through' } : undefined}>
                            {f.rotulo}{f.cheia ? ' · esgotado' : ''}
                          </button>
                        ))}
                      </div>
                      {agendadoPara && (
                        <div style={{
                          marginTop: 12, padding: '12px 14px', borderRadius: 10,
                          background: 'rgba(124,58,237,.1)', border: '1px solid rgba(124,58,237,.3)',
                          fontSize: 13.5, lineHeight: 1.5,
                        }}>
                          🗓️ Seu pedido fica agendado para <strong>{rotuloAgendado(agendadoPara, { comData: true, ate: agendadoAte })}</strong>
                          {tipo === 'entrega' ? ' — é a janela em que a loja entrega.' : ' — é a janela pra retirar.'}
                        </div>
                      )}
                      {faixasDoDia.length > 0 && faixasDoDia.every(f => f.cheia) && (
                        <p style={{ fontSize: 13, color: '#eab308', margin: '10px 0 0' }}>
                          Todos os horários desse dia já encheram. Escolha outro dia.
                        </p>
                      )}
                    </div>
                  )
                )}
              </section>
              )}

              {/* Endereço (só na entrega) */}
              {tipo === 'entrega' && (
              <section className="dco-section">
                <h2 className="dco-section-title">Endereço de entrega</h2>
                <div className="dco-field-group">

                  {/* Rua — agora é a PORTA DE ENTRADA do endereço, com busca
                      pelo nome. O CEP desceu pro fim: quem não sabia travava
                      logo na primeira linha e ia embora. */}
                  <Field label="Rua / Av." required error={errors.rua}
                    hint="digite o nome e escolha na lista">
                    <div style={{ position: 'relative' }}>
                      <input
                        className={`dco-input${errors.rua ? ' dco-input--error' : ''}`}
                        placeholder="Ex: Santo Antônio"
                        value={form.rua}
                        onChange={e => { set('rua', e.target.value); setRuaAberta(true) }}
                        onFocus={() => setRuaAberta(true)}
                        autoComplete="off"
                        data-field-error={errors.rua ? true : undefined}
                      />
                      {ruaBuscando && (
                        <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--text-muted, #888)' }}>
                          Buscando...
                        </span>
                      )}
                      {ruaNaoAchou && !ruaBuscando && form.rua.trim().length >= 3 && (
                        <div style={{
                          marginTop: 8, padding: '10px 12px', borderRadius: 10,
                          background: 'rgba(234,179,8,.10)', border: '1px solid rgba(234,179,8,.45)',
                        }}>
                          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text, #222)' }}>
                            Procurei em <strong>{form.estado || lojaEndereco?.estado}</strong> inteiro
                            {' '}e não achei essa rua. Confere o nome, ou informe o CEP aqui
                            {' '}que eu preencho tudo:
                          </div>
                          <input
                            className="dco-input"
                            style={{ marginTop: 8 }}
                            placeholder="CEP: 00000-000"
                            value={form.cep}
                            onChange={handleCepChange}
                            inputMode="numeric"
                            maxLength={9}
                          />
                          {erroCep && <span className="dco-field-error">{erroCep}</span>}
                          <div style={{ fontSize: 11.5, marginTop: 6, color: 'var(--text-muted, #888)' }}>
                            Pode escrever o nome da rua à mão também — só confira o bairro e a cidade.
                          </div>
                        </div>
                      )}

                      {ruaAberta && ruaSugestoes.length > 0 && (
                        <>
                          {/* Toque fora fecha a lista. */}
                          <div onClick={() => setRuaAberta(false)}
                            style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                          <div className="dco-rua-lista">
                            {ruaSugestoes.map(r => (
                              <button key={`${r.cep}-${r.logradouro}`} type="button"
                                onClick={() => escolherRua(r)}>
                                <strong>{r.logradouro}</strong>
                                <span>{[r.bairro, r.localidade].filter(Boolean).join(' · ')}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    {/* Rua que o cadastro dos Correios não tem (loteamento novo,
                        nome popular) existe muito no interior. Sem este aviso o
                        cliente acha que o sistema recusou o endereço dele. */}
                    {tipo === 'entrega' && !ruaBuscando && form.rua.trim().length >= 4 && ruaSugestoes.length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--dco-muted)', marginTop: 4, display: 'block', lineHeight: 1.45 }}>
                        Não achou na lista? Escreva o nome do jeito que você conhece e siga —
                        o que vale pra entrega é o <strong>pino no mapa</strong>, ali embaixo.
                      </span>
                    )}
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

                  {/* Cidade — lista quando o IBGE responde, campo de texto quando não */}
                  <Field label="Cidade" required error={errors.cidade}>
                    {cidadeLivre && !loadingCidades ? (
                      <>
                        <input
                          className={`dco-input${errors.cidade ? ' dco-input--error' : ''}`}
                          placeholder="Digite a sua cidade"
                          value={form.cidade}
                          onChange={e => set('cidade', e.target.value)}
                          disabled={!form.estado}
                          data-field-error={errors.cidade ? true : undefined}
                        />
                        <button
                          type="button"
                          onClick={() => form.estado && carregarCidades(form.estado, form.cidade)}
                          style={{
                            marginTop: 6, background: 'none', border: 'none', padding: 0,
                            color: '#7c3aed', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                            textDecoration: 'underline',
                          }}
                        >
                          Tentar carregar a lista de cidades de novo
                        </button>
                      </>
                    ) : (
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
                        {/* Cidade que veio do CEP mas não está na lista: sem
                            esta opção o seletor mostrava "Selecione a cidade"
                            com o formulário já preenchido — parecia em branco. */}
                        {form.cidade && !cidades.includes(form.cidade) && (
                          <option value={form.cidade}>{form.cidade}</option>
                        )}
                        {cidades.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    )}
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

                  {/* CEP — atalho pra quem sabe, não porta de entrada. */}
                  <Field label="CEP" hint="opcional — se souber, preenche tudo de uma vez">
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

                  {/* Aviso quando a rua/bairro não batem com o CEP digitado */}
                  {cepDivergente && (
                    <div style={{ marginTop: -4, marginBottom: 4, padding: '9px 11px', borderRadius: 10,
                      border: '1px solid #eab308', background: 'rgba(234,179,8,.1)', fontSize: 12.5, color: '#a16207', lineHeight: 1.4 }}>
                      ⚠️ Esse CEP é de{cepDivergente.rua ? ` ${cepDivergente.rua},` : ''}
                      {cepDivergente.bairro ? ` bairro ${cepDivergente.bairro}` : ''}. Confere se o endereço está certo.
                    </div>
                  )}

                  {/* Localizador no mapa — ponto exato pra taxa certinha.
                      Fica ABERTO, não atrás de botão: mapa que precisa de clique
                      pra aparecer ninguém abre, e o entregador acaba indo pro
                      ponto que o buscador chutou. */}
                  {lojaEndereco?.latitude && lojaEndereco?.longitude && (
                    <div style={{ marginTop: 4 }}>
                      <MapaLocalizador
                        embutido
                        storeLat={lojaEndereco.latitude}
                        storeLng={lojaEndereco.longitude}
                        raioKm={lojaEndereco.raio_entrega_km}
                        taxas={lojaEndereco.taxas_entrega_km}
                        initial={coordCliente}
                        endereco={{ rua: form.rua, numero: form.numero, bairro: form.bairro, cidade: form.cidade, estado: form.estado, cep: form.cep }}
                        exigeManual={reconfirmar}
                        onChange={pontoDoMapa}
                        onAmpliar={() => setMapaAberto(true)}
                      />
                      {/* O endereço mudou junto com o pino: a pessoa PRECISA
                          ver, senão o pedido sai numa rua que ela não escreveu
                          e ela só descobre quando o motoboy não chega. */}
                      {enderecoDoPino && (
                        <div style={{ marginTop: 6, fontSize: 12.5, color: '#eab308', lineHeight: 1.5 }}>
                          📍 Endereço atualizado pelo pino: <strong>{enderecoDoPino.rua}</strong>
                          {enderecoDoPino.bairro ? `, ${enderecoDoPino.bairro}` : ''}.
                          {' '}A entrega vai para onde o pino está — se não for aí, arraste até a sua casa.
                        </div>
                      )}
                      {!form.numero.trim() && (
                        <div style={{ marginTop: 6, fontSize: 12.5, color: '#eab308' }}>
                          ✏️ Digite o <strong>número da casa</strong> — é com ele que o mapa acha o ponto certo.
                        </div>
                      )}
                      {temFaixas && form.numero.trim() && (
                        <div style={{ marginTop: 6, fontSize: 12.5, color: taxaPendente ? '#eab308' : 'var(--text-muted,#9aa)' }}>
                          {taxaPendente
                            ? '⚠️ Confira o pino no mapa — é ele que define a taxa de entrega.'
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
                {/* Só as formas que a loja aceita (Minha Loja → Pagamento) */}
                <div className="dco-payment-row">
                  {formasLoja.includes('pix') && (
                    <button type="button"
                      className={`dco-pay-btn${form.pagamento === 'pix' ? ' dco-pay-btn--active' : ''}`}
                      onClick={() => set('pagamento', 'pix')}>
                      <IconPix />
                      <span>Pix</span>
                      {form.pagamento === 'pix' && <span className="dco-pay-check"><IconCheck /></span>}
                    </button>
                  )}
                  {formasLoja.includes('pix_entrega') && (
                    <button type="button"
                      className={`dco-pay-btn${form.pagamento === 'pix_entrega' ? ' dco-pay-btn--active' : ''}`}
                      onClick={() => set('pagamento', 'pix_entrega')}>
                      <IconPix />
                      <span>Pix na entrega</span>
                      {form.pagamento === 'pix_entrega' && <span className="dco-pay-check"><IconCheck /></span>}
                    </button>
                  )}
                  {formasLoja.includes('dinheiro') && (
                    <button type="button"
                      className={`dco-pay-btn${form.pagamento === 'dinheiro' ? ' dco-pay-btn--active' : ''}`}
                      onClick={() => set('pagamento', 'dinheiro')}>
                      <IconMoney />
                      <span>Dinheiro</span>
                      {form.pagamento === 'dinheiro' && <span className="dco-pay-check"><IconCheck /></span>}
                    </button>
                  )}
                  {/* Crédito e débito separados (mig 0223): cada um pode ter um
                      acréscimo próprio, que é o que a loja já cobra no balcão.
                      A loja que não separa continua com o "Cartão" de sempre. */}
                  {['credito', 'debito', 'cartao'].filter(f => formasLoja.includes(f)).map(f => {
                    const rotulo = f === 'credito' ? 'Crédito' : f === 'debito' ? 'Débito' : 'Cartão'
                    const pct = repassePct(lojaEndereco, f)
                    return (
                      <button key={f} type="button"
                        className={`dco-pay-btn${form.pagamento === f ? ' dco-pay-btn--active' : ''}`}
                        onClick={() => set('pagamento', f)}>
                        <IconCard />
                        <span>
                          {rotulo}
                          {pct > 0 && (
                            <span style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: .8 }}>
                              +{String(pct).replace('.', ',')}%
                            </span>
                          )}
                        </span>
                        {form.pagamento === f && <span className="dco-pay-check"><IconCheck /></span>}
                      </button>
                    )
                  })}
                </div>
                {acrescimoPagamento > 0 && (
                  <div style={{
                    marginTop: 10, padding: '10px 12px', borderRadius: 10,
                    background: 'rgba(234,179,8,.10)', border: '1px solid rgba(234,179,8,.35)',
                    fontSize: 13, lineHeight: 1.5,
                  }}>
                    Nesta forma a loja cobra <strong>+{String(repassePct(lojaEndereco, form.pagamento)).replace('.', ',')}%</strong>
                    {' '}(<strong>R$ {fmt(acrescimoPagamento)}</strong>), que é a taxa da maquineta. Já está no total.
                  </div>
                )}
                {/* PIX na entrega: nada é cobrado agora — o cliente paga na chave
                    da loja. Mostra a chave já aqui pra ele saber pra quem vai
                    pagar, e pede o comprovante no WhatsApp: é assim que a loja
                    sabe que o pagamento saiu antes de separar o pedido. */}
                {form.pagamento === 'pix_entrega' && (
                  <div style={{
                    marginTop: 10, padding: '10px 12px', borderRadius: 10,
                    background: 'rgba(0,180,216,.10)', border: '1px solid rgba(0,180,216,.35)',
                    fontSize: 13, lineHeight: 1.5, color: 'var(--text,#e6e6f0)',
                  }}>
                    Mande o comprovante no <strong>WhatsApp</strong> para concluir o pedido.
                    {lojaEndereco?.chave_pix && (
                      <div style={{ marginTop: 6 }}>
                        Chave PIX: <strong style={{ wordBreak: 'break-all' }}>{lojaEndereco.chave_pix}</strong>
                        {lojaEndereco.pix_nome ? ` — ${lojaEndereco.pix_nome}` : ''}
                      </div>
                    )}
                  </div>
                )}
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
                {saldoCashback > 0 && (
                  <button
                    type="button"
                    onClick={() => setUsarCashback(v => !v)}
                    style={{
                      width: '100%', textAlign: 'left', cursor: 'pointer', marginBottom: 12,
                      padding: '12px 14px', borderRadius: 10,
                      border: `1px solid ${usarCashback ? '#16a34a' : 'var(--border, #334155)'}`,
                      background: usarCashback ? 'rgba(22,163,74,.10)' : 'transparent',
                      display: 'flex', alignItems: 'center', gap: 11,
                    }}
                  >
                    <span style={{
                      width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                      border: `2px solid ${usarCashback ? '#16a34a' : '#64748b'}`,
                      background: usarCashback ? '#16a34a' : 'transparent',
                      color: '#fff', fontSize: 13, lineHeight: '17px', textAlign: 'center', fontWeight: 800,
                    }}>{usarCashback ? '✓' : ''}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 700, fontSize: 14 }}>
                        Usar meu crédito · R$ {fmt(saldoCashback)}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, opacity: .75, marginTop: 1 }}>
                        {cashbackUsado < saldoCashback && usarCashback
                          ? `Dá pra usar R$ ${fmt(cashbackUsado)} neste pedido; o resto fica guardado.`
                          : 'Desconta agora do total deste pedido.'}
                      </span>
                    </span>
                  </button>
                )}

                <div className="dco-resumo-totais">
                  <div className="dco-resumo-linha">
                    <span>Subtotal</span>
                    <span>R$ {fmt(subtotal)}</span>
                  </div>
                  <div className="dco-resumo-linha">
                    <span>{tipo === 'retirada' ? 'Retirada na loja' : 'Taxa de entrega'}</span>
                    <span>{tipo === 'retirada' ? 'Grátis' : taxaPendente ? 'a calcular' : taxaAplicada === 0 ? 'Grátis' : `R$ ${fmt(taxaAplicada)}`}</span>
                  </div>
                  {cashbackUsado > 0 && (
                    <div className="dco-resumo-linha" style={{ color: '#16a34a' }}>
                      <span>Seu crédito</span>
                      <span>− R$ {fmt(cashbackUsado)}</span>
                    </div>
                  )}
                  {acrescimoPagamento > 0 && (
                    <div className="dco-resumo-linha">
                      <span>Taxa do cartão ({String(repassePct(lojaEndereco, form.pagamento)).replace('.', ',')}%)</span>
                      <span>R$ {fmt(acrescimoPagamento)}</span>
                    </div>
                  )}
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

                {taxaIndefinida && (
                  <div className="dco-erro-global" style={{ background: 'rgba(234,179,8,.12)', border: '1px solid #eab308', color: '#eab308' }}>
                    {configNaoCarregou
                      ? '⏳ Carregando a taxa de entrega... se demorar, recarregue a página.'
                      : <>📍 Falta marcar seu endereço no mapa pra calcular a taxa de entrega. Toque em <strong>“Marcar no mapa”</strong> acima.</>}
                  </div>
                )}

                {erroGlobal && <div className="dco-erro-global">{erroGlobal}</div>}

                <button type="submit" className="dco-btn-submit" disabled={enviando || faltaMinimo || bairroBloqueado || taxaIndefinida}>
                  {enviando ? <><span className="dco-spinner" />Enviando pedido...</>
                    : bairroBloqueado ? 'Não entregamos no seu bairro'
                    : configNaoCarregou ? 'Calculando a entrega...'
                    : taxaPendente ? 'Marque seu endereço no mapa'
                    : faltaMinimo ? `Faltam R$ ${fmt(faltamParaMinimo)} p/ o mínimo` : 'Fazer pedido'}
                </button>
              </div>
            </div>
          </div>

          {erroGlobal && <div className="dco-erro-global dco-erro-mobile">{erroGlobal}</div>}

          {/* Botão do celular — é por onde quase todo pedido sai. Tem que travar
              pelos MESMOS motivos do botão do desktop; antes ele nem olhava o
              bairro bloqueado. */}
          <div className="dco-submit-mobile">
            {taxaIndefinida && (
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#eab308', textAlign: 'center', marginBottom: 8 }}>
                {configNaoCarregou
                  ? '⏳ Carregando a taxa de entrega...'
                  : '📍 Marque seu endereço no mapa pra calcular a entrega'}
              </div>
            )}
            <button type="submit" className="dco-btn-submit"
              disabled={enviando || faltaMinimo || bairroBloqueado || taxaIndefinida}>
              {enviando
                ? <><span className="dco-spinner" />Enviando pedido...</>
                : bairroBloqueado
                ? 'Não entregamos no seu bairro'
                : configNaoCarregou
                ? 'Calculando a entrega...'
                : taxaPendente
                ? 'Marque seu endereço no mapa'
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
          exigeManual={reconfirmar}
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
