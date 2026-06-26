import { useEffect, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'

// Carrega o Leaflet sob demanda (mesmo padrão da tela Raio de Entrega da loja)
let L = null
const CENTRO_BR = { lat: -14.235, lng: -51.925 } // fallback: centro do Brasil

const overlay = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(2px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
}
const card = {
  width: '100%', maxWidth: 440, background: 'var(--card-bg, var(--bg))',
  borderRadius: 16, border: '1px solid var(--border)', overflow: 'hidden',
  boxShadow: '0 20px 60px rgba(0,0,0,.4)', display: 'flex', flexDirection: 'column',
}
const header = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '16px 18px 8px',
}
const closeBtn = {
  background: 'none', border: 'none', color: 'var(--text-muted)',
  fontSize: 26, lineHeight: 1, cursor: 'pointer', padding: 0,
}
const mapStyle = { width: '100%', height: 320, background: 'var(--border)' }
const loadingStyle = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
  justifyContent: 'center', color: 'var(--text-muted)', fontSize: 14,
  background: 'var(--card-bg, var(--bg))',
}
const footer = { display: 'flex', gap: 10, padding: 16 }

export default function ModalMapaEndereco({ enderecoTexto, onConfirmar, onFechar, onPular }) {
  const mapRef    = useRef(null)
  const mapObjRef = useRef(null)
  const markerRef = useRef(null)
  const coordsRef = useRef(null)
  const [centro, setCentro]         = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [aviso, setAviso]           = useState(null)

  // 1) Geocodifica o endereço digitado para centralizar o mapa
  useEffect(() => {
    let ativo = true
    ;(async () => {
      try {
        const q = encodeURIComponent(`${enderecoTexto}, Brasil`)
        const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
          headers: { 'User-Agent': 'CRM-FWC/1.0' },
        })
        const data = await res.json()
        if (!ativo) return
        if (data?.[0]) {
          setCentro({ lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) })
        } else {
          setAviso('Não achamos o endereço exato. Arraste o pino até a sua casa.')
          setCentro(CENTRO_BR)
        }
      } catch {
        if (!ativo) return
        setAviso('Não deu pra localizar sozinho. Arraste o pino até a sua casa.')
        setCentro(CENTRO_BR)
      } finally {
        if (ativo) setCarregando(false)
      }
    })()
    return () => { ativo = false }
  }, [enderecoTexto])

  // 2) Inicializa o mapa quando o centro é definido (uma única vez)
  useEffect(() => {
    if (!centro || !mapRef.current || mapObjRef.current) return
    let cancelado = false
    ;(async () => {
      if (!L) L = (await import('leaflet')).default
      if (cancelado || !mapRef.current || mapObjRef.current) return

      const zoom = centro === CENTRO_BR ? 4 : 17
      const map = L.map(mapRef.current, { zoomControl: true }).setView([centro.lat, centro.lng], zoom)
      mapObjRef.current = map

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)

      const icon = L.divIcon({
        html: '<div style="width:30px;height:30px;background:#863bff;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.4);"></div>',
        className: '', iconSize: [30, 30], iconAnchor: [15, 30],
      })
      markerRef.current = L.marker([centro.lat, centro.lng], { icon, draggable: true }).addTo(map)
      coordsRef.current = { lat: centro.lat, lng: centro.lng }

      markerRef.current.on('dragend', e => { coordsRef.current = e.target.getLatLng() })
      map.on('click', e => { markerRef.current.setLatLng(e.latlng); coordsRef.current = e.latlng })

      // O mapa nasce dentro de um modal — recalcula o tamanho após abrir
      setTimeout(() => { if (!cancelado && mapObjRef.current) mapObjRef.current.invalidateSize() }, 200)
    })()
    return () => {
      cancelado = true
      if (mapObjRef.current) { mapObjRef.current.remove(); mapObjRef.current = null }
    }
  }, [centro])

  function confirmar() {
    const c = coordsRef.current
    if (c) onConfirmar(Number(Number(c.lat).toFixed(7)), Number(Number(c.lng).toFixed(7)))
  }

  return (
    <div style={overlay} onClick={onFechar}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={header}>
          <strong style={{ fontSize: 16, color: 'var(--text)' }}>Onde fica sua casa?</strong>
          <button type="button" onClick={onFechar} style={closeBtn} aria-label="Fechar">×</button>
        </div>
        <p style={{ margin: '0 18px 10px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Arraste o pino (ou toque no mapa) para marcar o ponto exato da entrega.
        </p>
        {aviso && (
          <p style={{ margin: '0 18px 10px', fontSize: 12, color: 'var(--danger)' }}>{aviso}</p>
        )}

        <div style={{ position: 'relative' }}>
          <div ref={mapRef} style={mapStyle} />
          {carregando && <div style={loadingStyle}>Carregando mapa…</div>}
        </div>

        <div style={footer}>
          <button type="button" className="btn" onClick={onFechar}
            style={{ flex: '0 0 auto', padding: '0 16px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>
            Voltar
          </button>
          <button type="button" className="btn btn-primary" onClick={confirmar}
            disabled={carregando} style={{ flex: 1, marginTop: 0 }}>
            Confirmar localização
          </button>
        </div>

        {onPular && (
          <button type="button" onClick={onPular}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', padding: '0 0 14px' }}>
            Pular por enquanto
          </button>
        )}
      </div>
    </div>
  )
}
