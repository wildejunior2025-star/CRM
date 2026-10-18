// Rota da loja até a entrega + distância em linha reta, pra conferir os km nas telas de acerto
// do motoboy (o cálculo da taxa usa a linha reta; a rota abre o mapa pra ver os km pela rua).

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const rad = g => (g * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

/** { url, km }: url do Google Maps (origem = loja, destino = ponto da entrega ou o endereço) e km em linha reta. */
export function infoRota(empresa, pedido) {
  const lat = num(pedido?.endereco_lat)
  const lng = num(pedido?.endereco_lng)
  const lojaLat = num(empresa?.latitude)
  const lojaLng = num(empresa?.longitude)

  const destino = lat != null && lng != null
    ? `${lat},${lng}`
    : [pedido?.endereco_rua, pedido?.endereco_numero, pedido?.endereco_bairro, pedido?.endereco_cidade, empresa?.estado, 'Brasil']
        .filter(s => s && String(s).trim()).join(', ')

  if (!destino) return { url: null, km: null }

  const origem = lojaLat != null && lojaLng != null ? `${lojaLat},${lojaLng}` : ''
  const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destino)}`
    + `${origem ? `&origin=${encodeURIComponent(origem)}` : ''}&travelmode=driving`
  const km = lat != null && lng != null && lojaLat != null && lojaLng != null
    ? haversineKm(lojaLat, lojaLng, lat, lng)
    : null
  return { url, km }
}

// Duas casas de propósito: a tabela de taxa corta em 1, 2, 3 km, e "2,0 km" escondia um 2,04 que já paga a faixa seguinte.
export const textoKm = km => (km == null ? '' : `${km.toFixed(2).replace('.', ',')} km`)
