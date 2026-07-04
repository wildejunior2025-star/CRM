import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import 'leaflet/dist/leaflet.css'
import './RaioEntrega.css'

let L = null

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
  const [usarTaxasPorKm,  setUsarTaxasPorKm]  = useState(false)
  const [taxasKm,         setTaxasKm]         = useState([])  // [{km, taxa}]
  const [tempoMin,        setTempoMin]        = useState(30)
  const [tempoMax,        setTempoMax]        = useState(60)
  const [categoria,       setCategoria]       = useState('')
  const [raio, setRaio] = useState(10)

  // UI
  const [geocodando, setGeocodando] = useState(false)
  const [salvando,   setSalvando]   = useState(false)
  const [msg, setMsg] = useState(null)

  // ── Carrega dados ──────────────────────────────────────────────
  useEffect(() => {
    if (!profile?.empresa_id) return
    supabase
      .from('empresas')
      .select('id, aceita_delivery, taxa_entrega, taxas_entrega_km, tempo_entrega_min, tempo_entrega_max, cep, endereco, numero, bairro, cidade, estado, categoria_delivery, raio_entrega_km, latitude, longitude')
      .eq('id', profile.empresa_id)
      .single()
      .then(({ data }) => {
        if (!data) return
        setEmpresaId(data.id)
        setAceitaDelivery(data.aceita_delivery ?? false)
        setTaxaEntrega(data.taxa_entrega ?? 0)
        setTempoMin(data.tempo_entrega_min ?? 30)
        setTempoMax(data.tempo_entrega_max ?? 60)
        const cepNum = (data.cep ?? '').replace(/\D/g, '')
        setCep(cepNum.length > 5 ? `${cepNum.slice(0, 5)}-${cepNum.slice(5)}` : cepNum)
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
      })
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
    }).eq('id', empresaId)

    setSalvando(false)
    if (error) {
      console.error('Erro ao salvar:', error)
      setMsg({ type: 'error', text: `Erro: ${error.message}` })
      return
    }
    await refreshProfile()
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
                        // Gera uma faixa por km do 1 até o raio (sobrescreve sempre que não tinha faixas)
                        if (taxasKm.length === 0) {
                          const faixasAuto = Array.from({ length: Math.max(1, Math.round(raio)) }, (_, i) => ({
                            km: i + 1,
                            taxa: 0,
                            tempo: (i + 1) * 5,
                          }))
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
                            type="number" min="1" step="1"
                            value={faixa.km}
                            onChange={e => {
                              const next = [...taxasKm]
                              next[i] = { ...next[i], km: Number(e.target.value) }
                              setTaxasKm(next)
                            }}
                            className="form-input"
                            placeholder="2"
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
                          const nextKm = taxasKm.length === 0
                            ? raio
                            : Math.min((taxasKm.at(-1)?.km ?? 0) + 1, raio)
                          setTaxasKm([...taxasKm, { km: nextKm, taxa: 0, tempo: nextKm * 5 }])
                        }}
                      >
                        + Adicionar faixa
                      </button>

                      <p className="re-faixas-hint">
                        Cada faixa define a taxa e o tempo estimado para aquela distância. A faixa mais próxima é aplicada automaticamente no pedido.
                      </p>
                    </div>
                  </div>
                )}

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

      </div>
    </form>
  )
}
