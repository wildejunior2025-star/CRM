import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import 'leaflet/dist/leaflet.css'
import './RaioEntrega.css'

let L = null

// Normaliza nome de bairro pra agrupar/casar (tira acento, minúsculo, "bairro " do começo).
function normBairro(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/^bairro\s+/, '').replace(/\s+/g, ' ')
}


export default function RaioEntrega() {
  const { profile, refreshProfile } = useAuth()

  // Mapa
  const mapRef    = useRef(null)
  const mapObjRef = useRef(null)
  const circleRef = useRef(null)
  const ringsRef  = useRef([])
  const markerRef = useRef(null)

  // Dados
  const [empresaId, setEmpresaId] = useState(null)
  const [latitude,  setLatitude]  = useState(null)
  const [longitude, setLongitude] = useState(null)

  // Endereço
  const [cep,       setCep]       = useState('')
  const [rua,       setRua]       = useState('')
  const [numero,    setNumero]    = useState('')
  const [bairro,    setBairro]    = useState('')
  const [cidade,    setCidade]    = useState('')
  const [estado,    setEstado]    = useState('')
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep,   setErroCep]   = useState(null)

  // Delivery
  const [aceitaDelivery,  setAceitaDelivery]  = useState(false)
  const [taxaEntrega,     setTaxaEntrega]     = useState(0)
  const [pedidoMinimo,    setPedidoMinimo]    = useState(0)
  const [usarTaxasPorKm,  setUsarTaxasPorKm]  = useState(false)
  const [taxasKm,         setTaxasKm]         = useState([])  // [{km, taxa}]
  const [tempoMin,        setTempoMin]        = useState(30)
  const [tempoMax,        setTempoMax]        = useState(60)
  const [categoria,       setCategoria]       = useState('')
  const [raio, setRaio] = useState(10)
  const [sugestoesBairro, setSugestoesBairro] = useState([]) // bairros dentro do raio (OpenStreetMap)

  // Puxa os bairros das cidades DENTRO do raio de entrega (via OpenStreetMap/Overpass).
  // Genérico: funciona pra qualquer cidade — sem cadastrar lista fixa. Debounce pra
  // não bombardear a API quando o dono ajusta o raio no mapa.
  useEffect(() => {
    if (!latitude || !longitude) { setSugestoesBairro([]); return }
    let cancel = false
    const metros = Math.round(Math.max(1, Number(raio) || 5) * 1000)
    const q = `[out:json][timeout:20];node(around:${metros},${latitude},${longitude})["place"~"^(suburb|neighbourhood|quarter|borough)$"]["name"];out tags 600;`
    const t = setTimeout(() => {
      // POST (o GET retorna 406 no Overpass). Traz os bairros das cidades no raio.
      fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      })
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (cancel || !d) return
          const seen = new Set(); const out = []
          for (const el of (d.elements || [])) {
            const nm = el.tags?.name
            if (!nm) continue
            const n = normBairro(nm)
            if (n && !seen.has(n)) { seen.add(n); out.push(nm) }
          }
          out.sort((a, b) => a.localeCompare(b, 'pt-BR'))
          setSugestoesBairro(out)
        })
        .catch(() => { /* sem sugestões — dá pra digitar livre mesmo assim */ })
    }, 700)
    return () => { cancel = true; clearTimeout(t) }
  }, [latitude, longitude, raio])
  const [taxasBairro, setTaxasBairro] = useState([]) // [{bairro, norm, modo:'km'|'taxa'|'bloqueio', taxa, tempo, total}]
  const [novoBairro, setNovoBairro] = useState('')
  const [bairroOpen, setBairroOpen] = useState(false) // dropdown de sugestões de bairro

  // Adiciona um bairro à lista (sugestão ou digitado). Ignora acento pra não duplicar.
  function adicionarBairro(nome) {
    const b = (nome || '').trim(); if (!b) return
    const n = normBairro(b)
    setNovoBairro(''); setBairroOpen(false)
    if (taxasBairro.some(x => x.norm === n)) return
    setTaxasBairro(prev => [{ bairro: b, norm: n, modo: 'taxa', taxa: '', tempo: '', total: 0 }, ...prev])
  }

  // UI
  const [geocodando, setGeocodando] = useState(false)
  const [salvando,   setSalvando]   = useState(false)
  const [msg, setMsg] = useState(null)

  // ── Rascunho automático + botão flutuante ─────────────────────
  // Guarda o que o usuário mexeu (mesmo sem salvar) e restaura ao voltar.
  const draftKey = profile?.empresa_id ? `re-draft-${profile.empresa_id}` : null
  const baselineRef = useRef('') // estado salvo (pra saber se há alteração)
  const [temAlteracao, setTemAlteracao] = useState(false)

  function normSnap(o) {
    return JSON.stringify({
      aceitaDelivery: !!o.aceitaDelivery,
      taxaEntrega: String(o.taxaEntrega ?? ''),
      pedidoMinimo: String(o.pedidoMinimo ?? ''),
      usarTaxasPorKm: !!o.usarTaxasPorKm,
      taxasKm: (o.taxasKm ?? []).map(f => ({ km: Number(f.km) || 0, taxa: Number(f.taxa) || 0, tempo: (f.tempo == null || f.tempo === '') ? null : Number(f.tempo) })),
      tempoMin: String(o.tempoMin ?? ''),
      tempoMax: String(o.tempoMax ?? ''),
      categoria: o.categoria ?? '',
      raio: String(o.raio ?? ''),
      cep: o.cep ?? '', rua: o.rua ?? '', numero: o.numero ?? '',
      bairro: o.bairro ?? '', cidade: o.cidade ?? '', estado: o.estado ?? '',
    })
  }
  function snapshotAtual() {
    return normSnap({ aceitaDelivery, taxaEntrega, pedidoMinimo, usarTaxasPorKm, taxasKm, tempoMin, tempoMax, categoria, raio, cep, rua, numero, bairro, cidade, estado })
  }
  function descartarAlteracoes() {
    if (!baselineRef.current) return
    if (!window.confirm('Descartar as alterações não salvas e voltar ao que estava salvo?')) return
    const b = JSON.parse(baselineRef.current)
    setAceitaDelivery(!!b.aceitaDelivery); setTaxaEntrega(b.taxaEntrega); setPedidoMinimo(b.pedidoMinimo)
    setUsarTaxasPorKm(!!b.usarTaxasPorKm); setTaxasKm(Array.isArray(b.taxasKm) ? b.taxasKm : [])
    setTempoMin(b.tempoMin); setTempoMax(b.tempoMax); setCategoria(b.categoria); setRaio(b.raio)
    setCep(b.cep); setRua(b.rua); setNumero(b.numero); setBairro(b.bairro); setCidade(b.cidade); setEstado(b.estado)
    if (draftKey) { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
    setTemAlteracao(false)
  }

  // ── Carrega dados ──────────────────────────────────────────────
  useEffect(() => {
    if (!profile?.empresa_id) return
    supabase
      .from('empresas')
      .select('id, aceita_delivery, taxa_entrega, pedido_minimo, taxas_entrega_km, tempo_entrega_min, tempo_entrega_max, cep, endereco, numero, bairro, cidade, estado, categoria_delivery, raio_entrega_km, latitude, longitude')
      .eq('id', profile.empresa_id)
      .single()
      .then(({ data }) => {
        if (!data) return
        setEmpresaId(data.id)
        setAceitaDelivery(data.aceita_delivery ?? false)
        setTaxaEntrega(data.taxa_entrega ?? 0)
        setPedidoMinimo(data.pedido_minimo ?? 0)
        setTempoMin(data.tempo_entrega_min ?? 30)
        setTempoMax(data.tempo_entrega_max ?? 60)
        const cepNum = (data.cep ?? '').replace(/\D/g, '')
        const cepFmt = cepNum.length > 5 ? `${cepNum.slice(0, 5)}-${cepNum.slice(5)}` : cepNum
        setCep(cepFmt)
        setRua(data.endereco ?? '')
        setNumero(data.numero ?? '')
        setBairro(data.bairro ?? '')
        setCidade(data.cidade ?? '')
        setEstado(data.estado ?? '')
        setCategoria(data.categoria_delivery ?? '')
        setRaio(data.raio_entrega_km ?? 10)
        const faixas = Array.isArray(data.taxas_entrega_km) ? data.taxas_entrega_km : []
        setTaxasKm(faixas)
        setUsarTaxasPorKm(faixas.length > 0)
        setLatitude(data.latitude ? Number(data.latitude) : null)
        setLongitude(data.longitude ? Number(data.longitude) : null)

        // Baseline = valores salvos (referência pra detectar alteração).
        baselineRef.current = normSnap({
          aceitaDelivery: data.aceita_delivery ?? false,
          taxaEntrega: data.taxa_entrega ?? 0,
          pedidoMinimo: data.pedido_minimo ?? 0,
          usarTaxasPorKm: faixas.length > 0,
          taxasKm: faixas,
          tempoMin: data.tempo_entrega_min ?? 30,
          tempoMax: data.tempo_entrega_max ?? 60,
          categoria: data.categoria_delivery ?? '',
          raio: data.raio_entrega_km ?? 10,
          cep: cepFmt, rua: data.endereco ?? '', numero: data.numero ?? '',
          bairro: data.bairro ?? '', cidade: data.cidade ?? '', estado: data.estado ?? '',
        })
        // Restaura o que o usuário mexeu e não salvou (rascunho no navegador).
        try {
          const raw = draftKey && localStorage.getItem(draftKey)
          if (raw && raw !== baselineRef.current) {
            const d = JSON.parse(raw)
            setAceitaDelivery(!!d.aceitaDelivery); setTaxaEntrega(d.taxaEntrega ?? 0); setPedidoMinimo(d.pedidoMinimo ?? 0)
            setUsarTaxasPorKm(!!d.usarTaxasPorKm); setTaxasKm(Array.isArray(d.taxasKm) ? d.taxasKm : [])
            setTempoMin(d.tempoMin ?? 30); setTempoMax(d.tempoMax ?? 60); setCategoria(d.categoria ?? ''); setRaio(d.raio ?? 10)
            setCep(d.cep ?? cepFmt); setRua(d.rua ?? ''); setNumero(d.numero ?? '')
            setBairro(d.bairro ?? ''); setCidade(d.cidade ?? ''); setEstado(d.estado ?? '')
            setMsg({ type: 'success', text: '↩️ Restauramos as alterações que você não tinha salvo. Revise e clique em Salvar.' })
          }
        } catch { /* ignore */ }
      })
  }, [profile?.empresa_id])

  // Detecta alteração vs. o salvo e guarda o rascunho no navegador.
  useEffect(() => {
    if (!baselineRef.current) return
    const snap = snapshotAtual()
    const mudou = snap !== baselineRef.current
    setTemAlteracao(mudou)
    if (draftKey) {
      try { mudou ? localStorage.setItem(draftKey, snap) : localStorage.removeItem(draftKey) } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aceitaDelivery, taxaEntrega, pedidoMinimo, usarTaxasPorKm, taxasKm, tempoMin, tempoMax, categoria, raio, cep, rua, numero, bairro, cidade, estado])

  // ── Carrega bairros: config salva + sugestões dos pedidos passados ──
  useEffect(() => {
    if (!profile?.empresa_id) return
    let vivo = true
    ;(async () => {
      const [{ data: emp }, { data: peds }] = await Promise.all([
        supabase.from('empresas').select('taxas_entrega_bairro').eq('id', profile.empresa_id).single(),
        supabase.from('pedidos_delivery').select('endereco_bairro').eq('empresa_id', profile.empresa_id).not('endereco_bairro', 'is', null).limit(3000),
      ])
      if (!vivo) return
      const salvos = Array.isArray(emp?.taxas_entrega_bairro) ? emp.taxas_entrega_bairro : []
      const cfg = new Map()
      for (const s of salvos) {
        const n = normBairro(s.bairro)
        cfg.set(n, { bairro: s.bairro, norm: n, modo: s.entrega === false ? 'bloqueio' : 'taxa', taxa: s.taxa ?? '', tempo: s.tempo ?? '', total: 0 })
      }
      const cont = new Map()
      for (const p of (peds || [])) {
        const b = (p.endereco_bairro || '').trim()
        const n = normBairro(b)
        if (!n) continue
        const cur = cont.get(n) || { grafias: new Map(), total: 0 }
        cur.grafias.set(b, (cur.grafias.get(b) || 0) + 1); cur.total++
        cont.set(n, cur)
      }
      const lista = []
      const vistos = new Set()
      for (const [n, info] of [...cont.entries()].sort((a, b) => b[1].total - a[1].total)) {
        const display = [...info.grafias.entries()].sort((a, b) => b[1] - a[1])[0][0]
        if (cfg.has(n)) lista.push({ ...cfg.get(n), bairro: cfg.get(n).bairro || display, total: info.total })
        else lista.push({ bairro: display, norm: n, modo: 'km', taxa: '', tempo: '', total: info.total })
        vistos.add(n)
      }
      for (const [n, c] of cfg) if (!vistos.has(n)) lista.push(c)
      setTaxasBairro(lista)
    })()
    return () => { vivo = false }
  }, [profile?.empresa_id])

  // ── Inicializa mapa (só uma vez quando tiver coords) ──────────
  useEffect(() => {
    if (!latitude || !longitude || !mapRef.current) return
    if (mapObjRef.current) return  // já inicializado — atualizações via moverPino()

    async function initMap() {
      if (!L) L = (await import('leaflet')).default

      const map = L.map(mapRef.current, { zoomControl: true }).setView([latitude, longitude], zoomParaRaio(raio))
      mapObjRef.current = map

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map)

      circleRef.current = L.circle([latitude, longitude], {
        radius: raio * 1000,
        color: '#ef4444', weight: 2.5,
        fillColor: '#ef4444', fillOpacity: 0.15,
      }).addTo(map)

      ringsRef.current = [0.25, 0.5, 0.75].map(f =>
        L.circle([latitude, longitude], {
          radius: raio * 1000 * f,
          color: '#888', weight: 1,
          dashArray: '6 10', fillOpacity: 0, interactive: false,
        }).addTo(map)
      )

      const icon = L.divIcon({
        html: `<div style="width:44px;height:44px;background:#2563eb;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:22px;">🏪</div>`,
        className: '', iconSize: [44, 44], iconAnchor: [22, 22],
      })
      markerRef.current = L.marker([latitude, longitude], { icon, draggable: true }).addTo(map)

      // Arrastar: círculos seguem o pino em tempo real
      markerRef.current.on('drag', (e) => {
        const { lat, lng } = e.target.getLatLng()
        circleRef.current?.setLatLng([lat, lng])
        ringsRef.current.forEach(r => r.setLatLng([lat, lng]))
      })

      // Soltar: salva nova posição no estado (sem recriar o mapa)
      markerRef.current.on('dragend', (e) => {
        const { lat, lng } = e.target.getLatLng()
        setLatitude(lat)
        setLongitude(lng)
      })
    }

    initMap()
    return () => { if (mapObjRef.current) { mapObjRef.current.remove(); mapObjRef.current = null } }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latitude, longitude])

  // ── Atualiza círculos quando raio muda ─────────────────────────
  useEffect(() => {
    if (!mapObjRef.current || !latitude) return
    const raioM = raio * 1000
    circleRef.current?.setRadius(raioM)
    ringsRef.current.forEach((r, i) => r.setRadius(raioM * [0.25, 0.5, 0.75][i]))
    mapObjRef.current.setZoom(zoomParaRaio(raio))
  }, [raio, latitude])

  function zoomParaRaio(km) {
    if (km <= 2) return 14; if (km <= 5) return 13
    if (km <= 10) return 12; if (km <= 20) return 11
    if (km <= 40) return 10; return 9
  }

  // ── CEP ───────────────────────────────────────────────────────
  function handleCepChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    setCep(v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v)
    setErroCep(null)
    if (v.length === 8) buscarCep(v)
  }

  async function buscarCep(nums) {
    setBuscandoCep(true); setErroCep(null)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${nums}/json/`)
      const d = await res.json()
      if (d.erro) { setErroCep('CEP não encontrado.'); return }
      if (d.logradouro) setRua(d.logradouro)
      if (d.bairro) setBairro(d.bairro)
      if (d.localidade) setCidade(d.localidade)
      if (d.uf) setEstado(d.uf)
    } catch { setErroCep('Erro ao buscar CEP.') }
    finally { setBuscandoCep(false) }
  }

  // ── Geocodifica e move pino no mapa ───────────────────────────
  async function geocodificarEndereco() {
    if (!cidade) { setMsg({ type: 'error', text: 'Preencha pelo menos a cidade.' }); return }
    setGeocodando(true); setMsg(null)
    try {
      const partes = [rua, numero, bairro, cidade, estado, 'Brasil'].filter(Boolean)
      const q = encodeURIComponent(partes.join(', '))
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
        headers: { 'User-Agent': 'CRM-FWC/1.0' }
      })
      const data = await res.json()
      if (!data?.[0]) { setMsg({ type: 'error', text: 'Endereço não encontrado. Tente ser mais específico.' }); return }

      const lat = parseFloat(data[0].lat)
      const lng = parseFloat(data[0].lon)

      if (mapObjRef.current && markerRef.current) {
        // Mapa já existe: move pino e círculos sem recriar
        markerRef.current.setLatLng([lat, lng])
        circleRef.current?.setLatLng([lat, lng])
        ringsRef.current.forEach(r => r.setLatLng([lat, lng]))
        mapObjRef.current.setView([lat, lng], zoomParaRaio(raio))
      }

      // Atualiza estado DEPOIS de mover no mapa (não vai recriar pois guard `if mapObjRef.current return`)
      setLatitude(lat); setLongitude(lng)
      setMsg({ type: 'success', text: 'Localização atualizada. Arraste o pino para ajuste fino.' })
    } catch { setMsg({ type: 'error', text: 'Erro ao buscar localização.' }) }
    finally { setGeocodando(false) }
  }

  // ── Salva tudo ────────────────────────────────────────────────
  async function handleSalvar(e) {
    e.preventDefault()
    if (!empresaId) return
    setSalvando(true); setMsg(null)

    const { error } = await supabase.from('empresas').update({
      aceita_delivery:      aceitaDelivery,
      taxa_entrega:         usarTaxasPorKm ? 0 : (parseFloat(taxaEntrega) || 0),
      pedido_minimo:        parseFloat(pedidoMinimo) || 0,
      taxas_entrega_km:     usarTaxasPorKm
        ? [...taxasKm].sort((a, b) => a.km - b.km)
        : [],
      tempo_entrega_min:    parseInt(tempoMin) || 30,
      tempo_entrega_max:    parseInt(tempoMax) || 60,
      cep:                  cep.replace(/\D/g, '') || null,
      endereco:             rua || null,
      numero:               numero || null,
      bairro:               bairro || null,
      cidade:               cidade || null,
      estado:               estado || null,
      categoria_delivery:   categoria || null,
      raio_entrega_km:      parseFloat(raio) || 10,
      latitude:             latitude || null,
      longitude:            longitude || null,
      taxas_entrega_bairro: taxasBairro
        .filter(b => b.modo === 'taxa' || b.modo === 'bloqueio')
        .map(b => ({ bairro: b.bairro, entrega: b.modo !== 'bloqueio', taxa: b.modo === 'taxa' ? (parseFloat(b.taxa) || 0) : 0, tempo: b.modo === 'taxa' ? (parseInt(b.tempo) || null) : null })),
    }).eq('id', empresaId)

    setSalvando(false)
    if (error) {
      console.error('Erro ao salvar:', error)
      setMsg({ type: 'error', text: `Erro: ${error.message}` })
      return
    }
    await refreshProfile()
    // Passa a ser o novo "salvo": some o botão flutuante e limpa o rascunho.
    baselineRef.current = snapshotAtual()
    setTemAlteracao(false)
    if (draftKey) { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
    setMsg({ type: 'success', text: 'Configurações salvas com sucesso.' })
    setTimeout(() => setMsg(null), 3000)
  }

  const temCoordenadas = !!(latitude && longitude)

  return (
    <form onSubmit={handleSalvar}>
      <div className="re-page">

        {/* ── Cabeçalho ── */}
        <div className="re-header">
          <h1>Raio de Entrega</h1>
          <p>Configure o endereço, raio e as opções de delivery da sua loja.</p>
        </div>

        {/* ── Mapa ── */}
        <div className="re-map-wrapper">
          {temCoordenadas
            ? <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
            : (
              <div className="re-map-empty">
                <div className="re-map-empty-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                    <circle cx="12" cy="9" r="2.5"/>
                  </svg>
                </div>
                <p className="re-map-empty-title">Localização não configurada</p>
                <p className="re-map-empty-sub">Preencha o endereço abaixo e clique em &ldquo;Localizar no mapa&rdquo;.</p>
              </div>
            )
          }
        </div>

        {/* ── Endereço ── */}
        <div className="card">
          <h2 className="re-card-title">Endereço da loja</h2>

          <div className="re-addr-grid">

            {/* CEP */}
            <div className="form-field re-addr-cep">
              <label>CEP</label>
              <div className="re-cep-wrap">
                <input
                  type="text" value={cep} onChange={handleCepChange}
                  placeholder="00000-000" maxLength={9} inputMode="numeric"
                  style={buscandoCep ? { paddingRight: 36 } : undefined}
                />
                {buscandoCep && <span className="re-cep-spinner" />}
              </div>
              {erroCep && <span className="re-err">{erroCep}</span>}
            </div>

            {/* Rua + Número */}
            <div className="re-addr-rua-num">
              <div className="form-field">
                <label>Rua / Av.</label>
                <input type="text" value={rua} onChange={e => setRua(e.target.value)} placeholder="Av. Nascimento de Castro" />
              </div>
              <div className="form-field">
                <label>Número</label>
                <input type="text" value={numero} onChange={e => setNumero(e.target.value)} placeholder="1234" />
              </div>
            </div>

            {/* Bairro / Cidade / Estado */}
            <div className="re-addr-row3">
              <div className="form-field">
                <label>Bairro</label>
                <input type="text" value={bairro} onChange={e => setBairro(e.target.value)} placeholder="Centro" />
              </div>
              <div className="form-field">
                <label>Cidade</label>
                <input type="text" value={cidade} onChange={e => setCidade(e.target.value)} placeholder="Natal" />
              </div>
              <div className="form-field">
                <label>UF</label>
                <input
                  type="text" value={estado}
                  onChange={e => setEstado(e.target.value.toUpperCase())}
                  maxLength={2} style={{ textTransform: 'uppercase' }}
                  placeholder="RN"
                />
              </div>
            </div>

          </div>

          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 16 }}
            onClick={geocodificarEndereco}
            disabled={geocodando || !cidade}
          >
            {geocodando ? 'Buscando...' : 'Localizar no mapa'}
          </button>
        </div>

        {/* ── Raio de entrega ── */}
        <div className="card">
          <h2 className="re-card-title">Raio de entrega</h2>

          <div className="re-raio-row">
            <div className="re-raio-slider-wrap">
              <input
                type="range" min={1} max={50} step={0.5}
                value={raio} onChange={e => setRaio(Number(e.target.value))}
              />
              <div className="re-raio-input-row">
                <input
                  type="number" min={1} max={100} step={0.5}
                  value={raio} onChange={e => setRaio(Number(e.target.value))}
                  className="form-input re-raio-number"
                />
                <span className="re-raio-unit">km</span>
              </div>
            </div>

            <div className="re-raio-badge">
              <div className="re-raio-badge-num">{raio}</div>
              <div className="re-raio-badge-label">km</div>
            </div>
          </div>

          <p className="re-raio-hint">
            Clientes a mais de <strong>{raio} km</strong> não veem sua loja no app e não conseguem pedir entrega.
          </p>
        </div>

        {/* ── Configurações de Delivery ── */}
        <div className="card">

          {/* Toggle ativar/desativar */}
          <div className="re-toggle-row">
            <div>
              <div className="re-toggle-label">Ativar delivery para esta loja</div>
              <div className="re-toggle-sub">Permite que clientes façam pedidos de delivery</div>
            </div>
            <div className="re-toggle-controls">
              <span className={`re-status-badge ${aceitaDelivery ? 'active' : 'inactive'}`}>
                {aceitaDelivery ? 'Ativo' : 'Inativo'}
              </span>
              <button
                type="button"
                className={`re-switch ${aceitaDelivery ? 'on' : 'off'}`}
                onClick={() => setAceitaDelivery(v => !v)}
                aria-label="Ativar delivery"
              >
                <span className="re-switch-thumb" />
              </button>
            </div>
          </div>

          {aceitaDelivery && (
            <div className="re-delivery-body">
              <div className="form-grid">

                {/* Modo de taxa */}
                <div className="form-field full">
                  <div className="re-taxa-mode">
                    <button
                      type="button"
                      className={`re-taxa-btn${!usarTaxasPorKm ? ' selected' : ''}`}
                      onClick={() => setUsarTaxasPorKm(false)}
                    >
                      Taxa fixa
                    </button>
                    <button
                      type="button"
                      className={`re-taxa-btn${usarTaxasPorKm ? ' selected' : ''}`}
                      onClick={() => {
                        setUsarTaxasPorKm(true)
                        // Gera uma faixa a cada 500 m (0,5 km) até o raio.
                        if (taxasKm.length === 0) {
                          const passo = 0.5
                          const n = Math.max(1, Math.round((parseFloat(raio) || 10) / passo))
                          const faixasAuto = Array.from({ length: n }, (_, i) => {
                            const km = +((i + 1) * passo).toFixed(1)
                            return { km, taxa: 0, tempo: Math.round(km * 5) }
                          })
                          setTaxasKm(faixasAuto)
                        }
                      }}
                    >
                      Por km (faixas)
                    </button>
                  </div>
                </div>

                {/* Taxa fixa */}
                {!usarTaxasPorKm && (
                  <div className="form-field">
                    <label>Taxa de entrega (R$)</label>
                    <input
                      type="number" step="0.01" min="0"
                      value={taxaEntrega}
                      onChange={e => setTaxaEntrega(e.target.value)}
                    />
                  </div>
                )}

                {/* Faixas por km */}
                {usarTaxasPorKm && (
                  <div className="form-field full">
                    <span className="re-faixas-label">Faixas de entrega por distância</span>
                    <div className="re-faixas-table">

                      {/* Cabeçalho */}
                      <div className="re-faixas-header">
                        <span className="re-faixas-col-label">Até (km)</span>
                        <span className="re-faixas-col-label">Taxa (R$)</span>
                        <span className="re-faixas-col-label">Tempo (min)</span>
                        <span />
                      </div>

                      {/* Linhas */}
                      {taxasKm.map((faixa, i) => (
                        <div key={i} className="re-faixas-row">
                          <input
                            type="number" min="0.5" step="0.5"
                            value={faixa.km}
                            onChange={e => {
                              const next = [...taxasKm]
                              next[i] = { ...next[i], km: Number(e.target.value) }
                              setTaxasKm(next)
                            }}
                            className="form-input"
                            placeholder="0.5"
                          />
                          <input
                            type="number" min="0" step="0.50"
                            value={faixa.taxa}
                            onChange={e => {
                              const next = [...taxasKm]
                              next[i] = { ...next[i], taxa: Number(e.target.value) }
                              setTaxasKm(next)
                            }}
                            className="form-input"
                            placeholder="5.00"
                          />
                          <input
                            type="number" min="1" step="1"
                            value={faixa.tempo ?? ''}
                            onChange={e => {
                              const next = [...taxasKm]
                              next[i] = { ...next[i], tempo: Number(e.target.value) }
                              setTaxasKm(next)
                            }}
                            className="form-input"
                            placeholder="30"
                          />
                          <button
                            type="button"
                            className="re-faixas-remove"
                            onClick={() => setTaxasKm(taxasKm.filter((_, j) => j !== i))}
                            aria-label="Remover faixa"
                          >
                            ×
                          </button>
                        </div>
                      ))}

                      <button
                        type="button"
                        className="re-faixas-add"
                        onClick={() => {
                          const raioMax = parseFloat(raio) || 10
                          const nextKm = taxasKm.length === 0
                            ? 0.5
                            : +Math.min((taxasKm.at(-1)?.km ?? 0) + 0.5, raioMax).toFixed(1)
                          setTaxasKm([...taxasKm, { km: nextKm, taxa: 0, tempo: Math.round(nextKm * 5) }])
                        }}
                      >
                        + Adicionar faixa
                      </button>

                      <p className="re-faixas-hint">
                        Cada faixa define a taxa e o tempo estimado para aquela distância. A faixa mais próxima é aplicada automaticamente no pedido. Pode usar de <b>500 em 500 m</b> (0,5 · 1 · 1,5 · 2 km…).
                      </p>
                    </div>
                  </div>
                )}

                {/* Pedido mínimo (só entrega) */}
                <div className="form-field">
                  <label>Pedido mínimo p/ entrega (R$)</label>
                  <input
                    type="number" step="0.01" min="0"
                    value={pedidoMinimo}
                    onChange={e => setPedidoMinimo(e.target.value)}
                    placeholder="0 = sem mínimo"
                  />
                </div>

                {/* Tempo de entrega */}
                <div className="form-field">
                  <label>Tempo de entrega (min)</label>
                  <div className="re-tempo-row">
                    <span className="re-tempo-label">De</span>
                    <input
                      type="number" min="0"
                      value={tempoMin}
                      onChange={e => setTempoMin(e.target.value)}
                      className="re-tempo-input"
                    />
                    <span className="re-tempo-label">a</span>
                    <input
                      type="number" min="0"
                      value={tempoMax}
                      onChange={e => setTempoMax(e.target.value)}
                      className="re-tempo-input"
                    />
                    <span className="re-tempo-label">min</span>
                  </div>
                </div>

                {/* Categoria */}
                <div className="form-field">
                  <label>Categoria</label>
                  <select value={categoria} onChange={e => setCategoria(e.target.value)}>
                    <option value="">Selecionar...</option>
                    <option value="bebidas">Bebidas</option>
                    <option value="mercado">Mercado</option>
                    <option value="farmacia">Farmácia</option>
                    <option value="pet shop">Pet shop</option>
                    <option value="eletronicos">Eletrônicos</option>
                    <option value="roupas">Roupas</option>
                    <option value="geral">Geral</option>
                  </select>
                </div>

              </div>
            </div>
          )}
        </div>

        {/* ── Taxa por bairro (opcional) ── */}
        {aceitaDelivery && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <h2 className="re-card-title">🏘️ Taxa por bairro (opcional)</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 14px' }}>
            Puxei os bairros dos seus pedidos. Pra cada um: <b>cobrar taxa fixa</b>, <b>não entregar</b>, ou deixar no <b>cálculo por km</b> (padrão). Bairro fora da lista usa o km.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
              <input value={novoBairro}
                onChange={e => { setNovoBairro(e.target.value); setBairroOpen(true) }}
                onFocus={() => setBairroOpen(true)}
                onBlur={() => setTimeout(() => setBairroOpen(false), 150)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); adicionarBairro(novoBairro) } }}
                placeholder="Buscar/adicionar bairro (ex.: potengi)..." autoComplete="off"
                style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', boxSizing: 'border-box' }} />
              {bairroOpen && (() => {
                const q = normBairro(novoBairro)
                const jaTem = new Set(taxasBairro.map(x => x.norm))
                const sug = sugestoesBairro.filter(b => !jaTem.has(normBairro(b)) && (!q || normBairro(b).includes(q))).slice(0, 40)
                if (sug.length === 0) return null
                return (
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
                    maxHeight: 260, overflowY: 'auto', background: 'var(--surface, #fff)',
                    border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 28px rgba(0,0,0,.18)', padding: 4,
                  }}>
                    {sug.map(b => (
                      <div key={b} onMouseDown={() => adicionarBairro(b)}
                        style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-hover, rgba(0,0,0,.05))'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        {b}
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => adicionarBairro(novoBairro)}>+ Adicionar</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {taxasBairro.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Carregando bairros…</p>}
            {taxasBairro.map((b, i) => (
              <div key={b.norm} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ flex: 1, minWidth: 130 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{b.bairro}</div>
                  {b.total > 0 && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{b.total} pedido{b.total === 1 ? '' : 's'}</div>}
                </div>
                <select value={b.modo}
                  onChange={e => { const v = e.target.value; setTaxasBairro(prev => prev.map((x, j) => j === i ? { ...x, modo: v } : x)) }}
                  style={{ padding: '7px 8px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }}>
                  <option value="km">Usar km (padrão)</option>
                  <option value="taxa">Cobrar taxa fixa</option>
                  <option value="bloqueio">🚫 Não entrego</option>
                </select>
                {b.modo === 'taxa' && (
                  <>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>R$</span>
                    <input type="number" step="0.01" min="0" value={b.taxa} placeholder="taxa"
                      onChange={e => { const v = e.target.value; setTaxasBairro(prev => prev.map((x, j) => j === i ? { ...x, taxa: v } : x)) }}
                      style={{ width: 80, padding: '7px 8px', borderRadius: 8, border: '1px solid var(--border)' }} />
                    <input type="number" min="0" value={b.tempo} placeholder="min"
                      onChange={e => { const v = e.target.value; setTaxasBairro(prev => prev.map((x, j) => j === i ? { ...x, tempo: v } : x)) }}
                      style={{ width: 68, padding: '7px 8px', borderRadius: 8, border: '1px solid var(--border)' }} />
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>min</span>
                  </>
                )}
                {b.modo === 'bloqueio' && <span style={{ fontSize: 13, fontWeight: 700, color: '#dc2626' }}>Cliente não consegue pedir</span>}
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            ⚠️ O cálculo por bairro entra no ar na próxima etapa. Por enquanto você pode cadastrar; ainda vale o km.
          </p>
        </div>
        )}

        {/* ── Feedback ── */}
        {msg && (
          <div className={`re-msg ${msg.type}`}>
            {msg.text}
          </div>
        )}

        {/* ── Ação principal ── */}
        <div>
          <button type="submit" className="btn btn-primary" disabled={salvando}>
            {salvando ? 'Salvando...' : 'Salvar configurações'}
          </button>
        </div>

        {/* Espaço pra barra flutuante não cobrir o botão de baixo */}
        {temAlteracao && <div style={{ height: 76 }} />}

      </div>

      {/* Barra Salvar flutuante — aparece sempre que há alteração não salva */}
      {temAlteracao && (
        <div style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1000,
          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '12px 16px', background: 'var(--surface, #16161f)',
          borderTop: '1px solid var(--border, #2a2a3a)', boxShadow: '0 -4px 24px rgba(0,0,0,.28)',
        }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Você tem alterações não salvas</span>
          <button type="button" onClick={descartarAlteracoes} disabled={salvando} style={{
            padding: '9px 16px', borderRadius: 9, border: '1px solid var(--border, #2a2a3a)',
            background: 'transparent', color: 'var(--text)', fontWeight: 600, cursor: 'pointer',
          }}>Descartar</button>
          <button type="submit" className="btn btn-primary" disabled={salvando} style={{ padding: '9px 22px' }}>
            {salvando ? 'Salvando...' : '💾 Salvar'}
          </button>
        </div>
      )}
    </form>
  )
}
