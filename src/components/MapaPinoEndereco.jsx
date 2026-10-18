import { useEffect, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'

// Mapa com um pino que o cliente arrasta até a casa (ou toca no ponto certo).
// `centro` é onde o mapa abre; quando ele muda (a busca da rua terminou) e o cliente
// ainda não mexeu, o pino acompanha. Depois que ele mexe, o mapa é dele.
export default function MapaPinoEndereco({ centro, onMover }) {
  const divRef = useRef(null)
  const mapRef = useRef(null)
  const pinRef = useRef(null)
  const mexeuRef = useRef(false)
  const [gpsCarregando, setGpsCarregando] = useState(false)
  const [gpsErro, setGpsErro] = useState('')

  useEffect(() => {
    let cancelado = false
    async function init() {
      // Marca o lugar ANTES do await: duas passadas rápidas montariam dois mapas no mesmo div.
      if (mapRef.current) return
      mapRef.current = 'montando'
      const L = (await import('leaflet')).default
      if (cancelado || !divRef.current) { mapRef.current = null; return }
      const c = centro ?? { lat: -5.79, lng: -35.21 }
      const map = L.map(divRef.current, { zoomControl: true }).setView([c.lat, c.lng], centro ? 17 : 13)
      mapRef.current = map
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
      const icone = L.divIcon({
        html: '<div style="width:34px;height:34px;background:#ef4444;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.4);"></div>',
        className: '', iconSize: [34, 34], iconAnchor: [17, 32],
      })
      pinRef.current = L.marker([c.lat, c.lng], { icon: icone, draggable: true }).addTo(map)
      pinRef.current.on('dragend', e => {
        mexeuRef.current = true
        const { lat, lng } = e.target.getLatLng()
        onMover?.({ lat, lng }, true)
      })
      map.on('click', e => {
        mexeuRef.current = true
        const { lat, lng } = e.latlng
        pinRef.current.setLatLng([lat, lng])
        onMover?.({ lat, lng }, true)
      })
      // O modal abre com o tamanho ainda assentando: sem isto o mapa nasce desenhado pra outra medida.
      const ajustar = () => { try { map.invalidateSize() } catch { /* já removido */ } }
      setTimeout(ajustar, 60)
      setTimeout(ajustar, 300)
      window.addEventListener('resize', ajustar)
      map.__ajustar = ajustar
    }
    init()
    return () => {
      cancelado = true
      const m = mapRef.current
      mapRef.current = null
      if (m && m !== 'montando') {
        if (m.__ajustar) window.removeEventListener('resize', m.__ajustar)
        m.remove()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A busca da rua terminou depois do mapa abrir: leva o pino pra lá (se ele ainda não mexeu).
  useEffect(() => {
    const m = mapRef.current
    if (!centro || !m || m === 'montando' || mexeuRef.current) return
    pinRef.current?.setLatLng([centro.lat, centro.lng])
    m.setView([centro.lat, centro.lng], 17)
  }, [centro])

  function usarMinhaLocalizacao() {
    if (!navigator.geolocation) { setGpsErro('Seu aparelho não permite localização.'); return }
    setGpsErro('')
    setGpsCarregando(true)
    navigator.geolocation.getCurrentPosition(
      pos => {
        setGpsCarregando(false)
        const m = mapRef.current
        if (!m || m === 'montando') return
        mexeuRef.current = true
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        pinRef.current.setLatLng([c.lat, c.lng])
        m.setView([c.lat, c.lng], 18)
        onMover?.(c, true)
      },
      () => { setGpsCarregando(false); setGpsErro('Não consegui pegar sua localização. Toque no mapa no ponto da sua casa.') },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  return (
    <div>
      {/* position:relative + z-index:0 prendem as camadas do Leaflet aqui dentro do modal */}
      <div className="ph-end-mapa" ref={divRef} />
      <button type="button" className="ph-end-gps" onClick={usarMinhaLocalizacao} disabled={gpsCarregando}>
        {gpsCarregando ? 'Buscando sua localização...' : '📍 Usar minha localização'}
      </button>
      {gpsErro && <p className="ph-modal-field-error" style={{ marginTop: 6 }}>{gpsErro}</p>}
    </div>
  )
}
