import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import 'leaflet/dist/leaflet.css'

// CONFIRMAR O PONTO DA ENTREGA (mig 0238) — a tela que o cliente abre pelo link
// que a loja mandou no chat.
//
// Só o mapa. Sem login, sem cardápio, sem carrinho: o cliente arrasta o pino
// até a porta da casa dele e aperta um botão. É a única pessoa no mundo que
// sabe onde ele mora — e, até agora, a única que nunca via o ponto.
//
// O pino nasce onde o gestor achou pelo endereço digitado. Quando o buscador
// erra (é ele que erra, não o cliente), o cliente vê o erro na hora, porque o
// mapa está na cara dele. Quando acerta, é um toque em "É aqui" e acabou.

const CENTRO_BR = { lat: -14.235, lng: -51.925 }

// Mesmo buscador do checkout: estruturado com CEP primeiro (bem mais preciso),
// texto livre depois.
async function geocodificar({ rua, numero, bairro, cidade, estado, cep }) {
  const uf = estado || ''
  const cepLimpo = String(cep || '').replace(/\D/g, '')
  const pega = async (url) => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'CRM-FWC/1.0' } })
      const d = await r.json()
      if (d?.[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
    } catch { /* sem rede, sem ponto — o cliente marca na mão */ }
    return null
  }
  if (cepLimpo.length === 8) {
    const p = new URLSearchParams({
      street: [numero, rua].filter(Boolean).join(' '),
      city: cidade || '', state: uf, postalcode: cepLimpo,
      country: 'Brazil', format: 'json', limit: '1',
    })
    const c = await pega(`https://nominatim.openstreetmap.org/search?${p}`)
    if (c) return c
  }
  const q = [rua, numero, bairro, cidade, uf].filter(Boolean).join(', ')
  return pega(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Brasil')}&format=json&limit=1`)
}

const cores = {
  fundo: '#0f1115', card: '#191c23', borda: '#2a2f3a',
  texto: '#f3f4f6', fraco: '#9aa1ad', roxo: '#863bff', verde: '#16a34a',
}

const tela = {
  minHeight: '100dvh', background: cores.fundo, color: cores.texto,
  display: 'flex', flexDirection: 'column',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
}

export default function ConfirmarLocal() {
  const { token } = useParams()
  const mapRef = useRef(null)
  const mapObj = useRef(null)
  const pinRef = useRef(null)
  const coordRef = useRef(null)
  const mexeu = useRef(false)

  const [info, setInfo]       = useState(null)
  const [erro, setErro]       = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [centro, setCentro]   = useState(null)
  const [salvando, setSalvando] = useState(false)
  const [pronto, setPronto]   = useState(false)   // salvou
  const [aviso, setAviso]     = useState(null)
  const [gps, setGps]         = useState(false)

  // ── 1. Abre o link e descobre onde o pino começa ───────────────────────────
  useEffect(() => {
    let vivo = true
    ;(async () => {
      const { data, error } = await supabase.rpc('abrir_pin_link', { p_token: token })
      if (!vivo) return
      if (error || !data?.ok) {
        setErro(data?.erro || error?.message || 'Não conseguimos abrir este link.')
        setCarregando(false)
        return
      }
      setInfo(data)
      if (data.lat != null && data.lng != null) {
        setCentro({ lat: Number(data.lat), lng: Number(data.lng) })
        setCarregando(false)
        return
      }
      // O gestor não mandou ponto: procura aqui mesmo, pelo endereço.
      const c = await geocodificar(data)
      if (!vivo) return
      if (c) {
        setCentro(c)
      } else if (data.loja_lat != null) {
        // Sem achar o endereço, começa na loja — perto o bastante pro cliente
        // se reconhecer no mapa e arrastar até em casa.
        setAviso('Não achamos o endereço no mapa. Arraste o pino até a sua casa.')
        setCentro({ lat: Number(data.loja_lat), lng: Number(data.loja_lng) })
      } else {
        setAviso('Não achamos o endereço no mapa. Aproxime e marque a sua casa.')
        setCentro(CENTRO_BR)
      }
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [token])

  // ── 2. Desenha o mapa ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!centro || !mapRef.current || mapObj.current || pronto) return
    let cancelado = false
    ;(async () => {
      const L = (await import('leaflet')).default
      if (cancelado || !mapRef.current || mapObj.current) return
      const zoom = centro === CENTRO_BR ? 4 : 18
      const map = L.map(mapRef.current, { zoomControl: true }).setView([centro.lat, centro.lng], zoom)
      mapObj.current = map
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap', maxZoom: 19,
      }).addTo(map)

      if (info?.loja_lat != null) {
        const lojaIcon = L.divIcon({
          html: '<div style="width:30px;height:30px;background:#863bff;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:15px">🏪</div>',
          className: '', iconSize: [30, 30], iconAnchor: [15, 15],
        })
        L.marker([Number(info.loja_lat), Number(info.loja_lng)], { icon: lojaIcon, interactive: false }).addTo(map)
      }

      const icon = L.divIcon({
        html: '<div style="width:34px;height:34px;background:#ef4444;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 3px 10px rgba(0,0,0,.45)"></div>',
        className: '', iconSize: [34, 34], iconAnchor: [17, 32],
      })
      pinRef.current = L.marker([centro.lat, centro.lng], { icon, draggable: true }).addTo(map)
      coordRef.current = { lat: centro.lat, lng: centro.lng }

      pinRef.current.on('dragend', e => { mexeu.current = true; coordRef.current = e.target.getLatLng() })
      map.on('click', e => { mexeu.current = true; pinRef.current.setLatLng(e.latlng); coordRef.current = e.latlng })

      setTimeout(() => { if (!cancelado && mapObj.current) mapObj.current.invalidateSize() }, 200)
    })()
    return () => {
      cancelado = true
      if (mapObj.current) { mapObj.current.remove(); mapObj.current = null }
    }
  }, [centro, info, pronto])

  function usarMinhaLocalizacao() {
    if (!navigator.geolocation) { setAviso('Seu celular não deixou pegar a localização.'); return }
    setGps(true)
    navigator.geolocation.getCurrentPosition(
      pos => {
        setGps(false)
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        mexeu.current = true
        coordRef.current = c
        if (pinRef.current) pinRef.current.setLatLng([c.lat, c.lng])
        if (mapObj.current) mapObj.current.setView([c.lat, c.lng], 18)
      },
      () => { setGps(false); setAviso('Não deu pra pegar sua localização. Arraste o pino mesmo.') },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  async function confirmar() {
    const c = coordRef.current
    if (!c) return
    setSalvando(true); setAviso(null)
    const { data, error } = await supabase.rpc('confirmar_pin_link', {
      p_token: token,
      p_lat: Number(Number(c.lat).toFixed(7)),
      p_lng: Number(Number(c.lng).toFixed(7)),
    })
    setSalvando(false)
    if (error || !data?.ok) {
      setAviso(data?.erro || error?.message || 'Não deu pra salvar. Tente de novo.')
      return
    }
    setPronto(true)
  }

  const enderecoLinha = info
    ? [ [info.rua, info.numero].filter(Boolean).join(', '), info.bairro, info.cidade ]
        .filter(Boolean).join(' • ')
    : ''

  // ── Salvou ─────────────────────────────────────────────────────────────────
  if (pronto) {
    return (
      <div style={{ ...tela, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 56, marginBottom: 12 }}>✅</div>
        <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Ponto confirmado!</h1>
        <p style={{ color: cores.fraco, fontSize: 15, lineHeight: 1.6, maxWidth: 340, margin: 0 }}>
          O entregador de <strong style={{ color: cores.texto }}>{info?.loja_nome || 'a loja'}</strong> vai
          direto no ponto que você marcou. Pode fechar esta página. 👍
        </p>
      </div>
    )
  }

  // ── Link inválido ──────────────────────────────────────────────────────────
  if (erro) {
    return (
      <div style={{ ...tela, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🔗</div>
        <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Link indisponível</h1>
        <p style={{ color: cores.fraco, fontSize: 15, maxWidth: 320, margin: 0 }}>{erro}</p>
      </div>
    )
  }

  return (
    <div style={tela}>
      <div style={{ padding: '18px 18px 12px' }}>
        <h1 style={{ fontSize: 19, margin: '0 0 4px' }}>Onde fica a sua casa?</h1>
        <p style={{ color: cores.fraco, fontSize: 14, margin: 0, lineHeight: 1.5 }}>
          Arraste o pino (ou toque no mapa) até a porta da sua casa. É esse ponto
          que o entregador vai seguir.
        </p>
        {enderecoLinha && (
          <div style={{
            marginTop: 12, padding: '10px 12px', background: cores.card,
            border: `1px solid ${cores.borda}`, borderRadius: 10,
            fontSize: 13.5, color: cores.fraco,
          }}>
            📍 {enderecoLinha}
          </div>
        )}
        {aviso && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#fca5a5' }}>{aviso}</div>
        )}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 320 }}>
        <div ref={mapRef} style={{ position: 'absolute', inset: 0, background: cores.card }} />
        {carregando && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: cores.fraco, fontSize: 14, background: cores.card,
          }}>
            Carregando o mapa…
          </div>
        )}
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button
          type="button" onClick={usarMinhaLocalizacao} disabled={carregando || gps}
          style={{
            padding: '12px 14px', borderRadius: 10, border: `1px solid ${cores.borda}`,
            background: 'transparent', color: cores.texto, fontSize: 14.5,
            cursor: 'pointer', fontWeight: 500,
          }}
        >
          {gps ? 'Buscando…' : '🎯 Estou em casa agora — usar minha localização'}
        </button>
        <button
          type="button" onClick={confirmar} disabled={carregando || salvando}
          style={{
            padding: '15px 14px', borderRadius: 10, border: 'none',
            background: cores.verde, color: '#fff', fontSize: 16, fontWeight: 700,
            cursor: 'pointer', opacity: carregando || salvando ? 0.6 : 1,
          }}
        >
          {salvando ? 'Salvando…' : 'É aqui — confirmar'}
        </button>
      </div>
    </div>
  )
}
