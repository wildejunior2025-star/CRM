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

// Tabela inicial de faixas: de 500 em 500 m até o raio, todas com a mesma taxa.
// É o que a loja vê quando ainda não montou a tabela dela — quem cobra um valor
// só para toda a área simplesmente deixa o mesmo número em todas as linhas.
function faixasPadrao(raio, taxa) {
  const passo = 0.5
  const r = Number(raio) || 10
  const t = Number(taxa) || 0
  const n = Math.max(1, Math.round(r / passo))
  return Array.from({ length: n }, (_, i) => {
    const km = +((i + 1) * passo).toFixed(1)
    return { km, taxa: t, tempo: Math.round(km * 5) }
  })
}


export default function RaioEntrega() {
  const { profile, refreshProfile } = useAuth()

  // Mapa
  const mapRef    = useRef(null)
  const mapObjRef = useRef(null)
  const circleRef = useRef(null)
  const ringsRef  = useRef([])
  const gradeRef  = useRef(null)   // { passo_m, celulas: [[lat,lng,km]] } — mapa pela rua
  const gradeLayerRef = useRef(null)
  const gradeCanvasRef = useRef(null) // um só desenhista: criar um por redesenho empilhava canvas
  const markerRef = useRef(null)
  const raioVal   = useRef(10)    // espelho do estado, pra funções do mapa lerem o valor de agora
  const taxasVal  = useRef([])
  const pelaRuaVal = useRef(false)
  const fatorVal = useRef(1)
  const anelTimer = useRef(null)

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
  // Retirada na loja: liga por padrão. Vale só pra loja online e portal —
  // o bot do WhatsApp, o balcão, as mesas e o iFood não olham isso.
  const [aceitaRetirada,  setAceitaRetirada]  = useState(true)
  const [aceitaEntrega,   setAceitaEntrega]   = useState(true)
  const [pelaRua,         setPelaRua]         = useState(false) // taxa pelo caminho da moto (Google)
  const [fatorRua,        setFatorRua]        = useState('1')   // km da rua ÷ fator na tabela (texto do campo)
  const [gradeStatus,     setGradeStatus]     = useState(null)  // null | 'carregando' | 'ok' | 'erro'
  const [destaqueKm,      setDestaqueKm]      = useState(null)  // faixa com o mouse em cima
  const [mapaPronto,      setMapaPronto]      = useState(false)
  const [taxaEntrega,     setTaxaEntrega]     = useState(0)
  const [pedidoMinimo,    setPedidoMinimo]    = useState(0)
  const [taxasKm,         setTaxasKm]         = useState([])  // [{km, taxa}]
  const [tempoMin,        setTempoMin]        = useState(30)
  const [tempoMax,        setTempoMax]        = useState(60)
  const [categoria,       setCategoria]       = useState('')
  const [raio, setRaio] = useState(10)
  const [sugestoesBairro, setSugestoesBairro] = useState([]) // bairros dentro do raio (OpenStreetMap)
  const raioSyncTimer = useRef(null) // debounce pra faixas acompanharem o raio
  raioVal.current = raio
  taxasVal.current = taxasKm
  pelaRuaVal.current = pelaRua
  fatorVal.current = Math.max(1, Number(String(fatorRua).replace(',', '.')) || 1)

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

  // Muda o raio E faz as faixas por km acompanharem: ao AUMENTAR, cria uma faixa
  // no novo raio (copiando a última taxa/tempo); ao DIMINUIR, apaga as faixas que
  // ficaram fora do raio. Só roda quando o DONO mexe (não no carregamento) e com
  // debounce pra não bagunçar enquanto arrasta o slider.
  function mudarRaio(novo) {
    const r = Number(novo) || 0
    setRaio(r)
    clearTimeout(raioSyncTimer.current)
    raioSyncTimer.current = setTimeout(() => {
      setTaxasKm(prev => {
        if (!prev.length || r <= 0) return prev
        let next = prev.filter(f => Number(f.km) <= r + 0.001)         // apaga faixas além do raio
        const ultima = next.length ? Number(next.at(-1).km) : 0
        if (ultima < r - 0.001) {                                       // garante faixa no raio
          const base = next.at(-1) || prev.at(-1) || { taxa: 0, tempo: null }
          next = [...next, { km: r, taxa: base.taxa ?? 0, tempo: base.tempo ?? null }]
        }
        const igual = next.length === prev.length && next.every((f, i) => Number(f.km) === Number(prev[i].km))
        return igual ? prev : next
      })
    }, 400)
  }
  const [taxasBairro, setTaxasBairro] = useState([]) // [{bairro, norm, modo:'km'|'taxa'|'bloqueio', taxa, tempo, total}]
  const [bairrosOcultos, setBairrosOcultos] = useState([]) // norms que a loja tirou da lista
  const [novoBairro, setNovoBairro] = useState('')
  const [bairroOpen, setBairroOpen] = useState(false) // dropdown de sugestões de bairro
  // Filtro da lista: com 30+ bairros, rolar tudo pra achar um é o que tornava
  // esta tela insuportável. 'todos' | 'taxa' | 'km' | 'bloqueio'
  const [filtroBairro, setFiltroBairro] = useState('todos')

  // Formato que o checkout e o bot leem. Um só lugar pra não divergir do salvar.
  const paraTaxasSalvas = (lista) => lista
    .filter(b => b.modo === 'taxa' || b.modo === 'bloqueio')
    .map(b => ({ bairro: b.bairro, entrega: b.modo !== 'bloqueio', taxa: b.modo === 'taxa' ? (parseFloat(b.taxa) || 0) : 0, tempo: b.modo === 'taxa' ? (parseInt(b.tempo) || null) : null }))

  // Adiciona um bairro à lista (sugestão ou digitado). Ignora acento pra não duplicar.
  function adicionarBairro(nome) {
    const b = (nome || '').trim(); if (!b) return
    const n = normBairro(b)
    setNovoBairro(''); setBairroOpen(false)
    if (taxasBairro.some(x => x.norm === n)) return
    setTaxasBairro(prev => [{ bairro: b, norm: n, modo: 'taxa', taxa: '', tempo: '', total: 0 }, ...prev])
    // Se estava escondido, adicionar de novo desfaz o esconder.
    if (bairrosOcultos.includes(n)) salvarOcultos(bairrosOcultos.filter(x => x !== n))
  }

  // Esconder grava na hora (não espera o "Salvar configurações"): é uma ação de
  // limpeza da lista, não uma configuração de entrega.
  async function salvarOcultos(novos, taxasTambem) {
    setBairrosOcultos(novos)
    if (!profile?.empresa_id) return
    const patch = { bairros_ocultos: novos }
    if (taxasTambem) patch.taxas_entrega_bairro = taxasTambem
    await supabase.from('empresas').update(patch).eq('id', profile.empresa_id)
  }

  function esconderBairro(b) {
    const restantes = taxasBairro.filter(x => x.norm !== b.norm)
    setTaxasBairro(restantes)
    // Bairro que tinha taxa/bloqueio configurado precisa sair também da config
    // que o checkout lê — senão sumia da tela mas continuava cobrando.
    const tinhaConfig = b.modo === 'taxa' || b.modo === 'bloqueio'
    salvarOcultos([...new Set([...bairrosOcultos, b.norm])], tinhaConfig ? paraTaxasSalvas(restantes) : null)
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
      aceitaRetirada: o.aceitaRetirada !== false,
      aceitaEntrega:  o.aceitaEntrega  !== false,
      pelaRua: !!o.pelaRua,
      fatorRua: String(o.fatorRua ?? '1').replace(',', '.'),
      taxaEntrega: String(o.taxaEntrega ?? ''),
      pedidoMinimo: String(o.pedidoMinimo ?? ''),
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
    return normSnap({ aceitaDelivery, aceitaRetirada, aceitaEntrega, pelaRua, fatorRua, taxaEntrega, pedidoMinimo, taxasKm, tempoMin, tempoMax, categoria, raio, cep, rua, numero, bairro, cidade, estado })
  }
  function descartarAlteracoes() {
    if (!baselineRef.current) return
    if (!window.confirm('Descartar as alterações não salvas e voltar ao que estava salvo?')) return
    const b = JSON.parse(baselineRef.current)
    setAceitaDelivery(!!b.aceitaDelivery); setAceitaRetirada(b.aceitaRetirada !== false)
    setAceitaEntrega(b.aceitaEntrega !== false); setPelaRua(!!b.pelaRua); setFatorRua(b.fatorRua ?? '1')
    setTaxaEntrega(b.taxaEntrega); setPedidoMinimo(b.pedidoMinimo)
    setTaxasKm(Array.isArray(b.taxasKm) ? b.taxasKm : [])
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
      .select('id, aceita_delivery, aceita_retirada, taxa_entrega, pedido_minimo, aceita_entrega, taxas_entrega_km, tempo_entrega_min, tempo_entrega_max, cep, endereco, numero, bairro, cidade, estado, categoria_delivery, raio_entrega_km, latitude, longitude, taxa_pela_rua, fator_rua')
      .eq('id', profile.empresa_id)
      .single()
      .then(({ data }) => {
        if (!data) return
        setEmpresaId(data.id)
        setAceitaDelivery(data.aceita_delivery ?? false)
        setAceitaRetirada(data.aceita_retirada !== false)
        setAceitaEntrega(data.aceita_entrega !== false)
        setPelaRua(!!data.taxa_pela_rua)
        setFatorRua(String(data.fator_rua ?? 1))
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
        // A cobrança é sempre por faixa de distância. Loja que ainda estava na
        // taxa fixa antiga chega aqui com a tabela vazia: monta as faixas de 500
        // em 500 m até o raio, todas com a taxa que ela já cobrava. A conta sai
        // igual à de antes, e agora dá pra mexer km a km.
        const faixas = Array.isArray(data.taxas_entrega_km) && data.taxas_entrega_km.length
          ? data.taxas_entrega_km
          : faixasPadrao(data.raio_entrega_km ?? 10, data.taxa_entrega ?? 0)
        setTaxasKm(faixas)
        // AQUI ESTAVA O BUG DO MAPA (02/09/2026): sobrou um `setUsarTaxasPorKm`
        // do tempo da taxa fixa (removido no commit c8eee86). O estado não
        // existe mais, então a linha estourava ReferenceError no meio do
        // `.then()` — e como ninguém pega o erro, as DUAS linhas de baixo nunca
        // rodavam. Resultado: endereço aparecia (setado antes) e a coordenada
        // não, então toda visita começava em "Localização não configurada" e o
        // salvar apagava o pino do banco.
        setLatitude(data.latitude ? Number(data.latitude) : null)
        setLongitude(data.longitude ? Number(data.longitude) : null)

        // Baseline = valores salvos (referência pra detectar alteração).
        baselineRef.current = normSnap({
          aceitaDelivery: data.aceita_delivery ?? false,
          aceitaRetirada: data.aceita_retirada !== false,
          aceitaEntrega:  data.aceita_entrega  !== false,
          pelaRua: !!data.taxa_pela_rua,
          fatorRua: String(data.fator_rua ?? 1),
          taxaEntrega: data.taxa_entrega ?? 0,
          pedidoMinimo: data.pedido_minimo ?? 0,
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
            setAceitaDelivery(!!d.aceitaDelivery); setAceitaRetirada(d.aceitaRetirada !== false)
            setAceitaEntrega(d.aceitaEntrega !== false); setPelaRua(!!d.pelaRua); setFatorRua(d.fatorRua ?? String(data.fator_rua ?? 1))
            setTaxaEntrega(d.taxaEntrega ?? 0); setPedidoMinimo(d.pedidoMinimo ?? 0)
            setTaxasKm(Array.isArray(d.taxasKm) ? d.taxasKm : [])
            setTempoMin(d.tempoMin ?? 30); setTempoMax(d.tempoMax ?? 60); setCategoria(d.categoria ?? ''); setRaio(d.raio ?? 10)
            setCep(d.cep ?? cepFmt); setRua(d.rua ?? ''); setNumero(d.numero ?? '')
            setBairro(d.bairro ?? ''); setCidade(d.cidade ?? ''); setEstado(d.estado ?? '')
            setMsg({ type: 'success', text: '↩️ Restauramos as alterações que você não tinha salvo. Revise e clique em Salvar.' })
          }
        } catch { /* ignore */ }
      })
      // Sem isto, qualquer erro no meio da carga morre calado e a tela abre pela
      // metade — foi assim que o mapa sumiu por semanas sem ninguém ver erro.
      .catch(err => {
        console.error('[raio-entrega] falhou ao carregar a loja:', err)
        setMsg({ type: 'error', text: 'Não deu pra carregar tudo desta tela. Recarregue antes de salvar.' })
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
  }, [aceitaDelivery, aceitaRetirada, aceitaEntrega, pelaRua, fatorRua, taxaEntrega, pedidoMinimo, taxasKm, tempoMin, tempoMax, categoria, raio, cep, rua, numero, bairro, cidade, estado])

  // ── Carrega bairros: config salva + sugestões dos pedidos passados ──
  useEffect(() => {
    if (!profile?.empresa_id) return
    let vivo = true
    ;(async () => {
      const [{ data: emp }, { data: peds }] = await Promise.all([
        supabase.from('empresas').select('taxas_entrega_bairro, bairros_ocultos').eq('id', profile.empresa_id).single(),
        supabase.from('pedidos_delivery').select('endereco_bairro').eq('empresa_id', profile.empresa_id).not('endereco_bairro', 'is', null).limit(3000),
      ])
      if (!vivo) return
      const salvos = Array.isArray(emp?.taxas_entrega_bairro) ? emp.taxas_entrega_bairro : []
      const ocultos = Array.isArray(emp?.bairros_ocultos) ? emp.bairros_ocultos : []
      setBairrosOcultos(ocultos)
      const escondido = new Set(ocultos)
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
        if (escondido.has(n)) continue
        const display = [...info.grafias.entries()].sort((a, b) => b[1] - a[1])[0][0]
        if (cfg.has(n)) lista.push({ ...cfg.get(n), bairro: cfg.get(n).bairro || display, total: info.total })
        else lista.push({ bairro: display, norm: n, modo: 'km', taxa: '', tempo: '', total: info.total })
        vistos.add(n)
      }
      for (const [n, c] of cfg) if (!vistos.has(n) && !escondido.has(n)) lista.push(c)
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

      // Contorno do raio total (vermelho). O preenchimento agora vem das faixas de 500 m.
      circleRef.current = L.circle([latitude, longitude], {
        radius: raio * 1000,
        color: '#ef4444', weight: 3,
        fillOpacity: 0, interactive: false,
      }).addTo(map)

      desenharAneis(latitude, longitude)
      setMapaPronto(true)

      const icon = L.divIcon({
        html: `<div style="width:44px;height:44px;background:#2563eb;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:22px;">🏪</div>`,
        className: '', iconSize: [44, 44], iconAnchor: [22, 22],
      })
      markerRef.current = L.marker([latitude, longitude], { icon, draggable: true }).addTo(map)

      // Arrastar: círculos seguem o pino em tempo real
      markerRef.current.on('drag', (e) => {
        const { lat, lng } = e.target.getLatLng()
        circleRef.current?.setLatLng([lat, lng])
        // Faixas são polígonos: refaz de leve enquanto arrasta (a cada ~80 ms).
        if (!anelTimer.current) {
          anelTimer.current = setTimeout(() => { anelTimer.current = null; desenharAneis(lat, lng) }, 80)
        }
      })

      // Clicou no mapa: diz a quantos km da loja é aquele ponto e em que faixa cai.
      // É pra conferir uma entrega: clica no endereço e vê se o raio e a taxa batem.
      map.on('click', async (e) => {
        const ponto = markerRef.current?.getLatLng()
        if (!ponto) return
        const km = map.distance(ponto, e.latlng) / 1000
        const popup = L.popup({ closeButton: false })
          .setLatLng(e.latlng)
          .setContent(pelaRuaVal.current ? `${textoDoPonto(km, null)}<br><i>Calculando o caminho da moto…</i>` : textoDoPonto(km))
          .openOn(map)
        if (!pelaRuaVal.current) return
        // Loja que cobra pela rua: o círculo não diz a taxa. Pergunta ao Google
        // o caminho de moto até o ponto clicado (ponto repetido sai do cache).
        const { data } = await supabase.functions.invoke('geocodificar-google', {
          body: { acao: 'rota', origem_lat: ponto.lat, origem_lng: ponto.lng, lat: e.latlng.lat, lng: e.latlng.lng },
        }).catch(() => ({ data: null }))
        if (!popup.isOpen()) return
        popup.setContent(textoDoPonto(km, data?.ok ? data.km : undefined))
      })

      // Soltar: salva nova posição no estado (sem recriar o mapa)
      markerRef.current.on('dragend', (e) => {
        const { lat, lng } = e.target.getLatLng()
        setLatitude(lat)
        setLongitude(lng)
      })
    }

    initMap()
    return () => { if (mapObjRef.current) { mapObjRef.current.remove(); mapObjRef.current = null; gradeLayerRef.current = null; gradeCanvasRef.current = null; setMapaPronto(false) } }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latitude, longitude])

  // ── Atualiza círculos quando raio muda ─────────────────────────
  useEffect(() => {
    if (!mapObjRef.current || !latitude) return
    const raioM = raio * 1000
    circleRef.current?.setRadius(raioM)
    const ponto = markerRef.current?.getLatLng()
    desenharAneis(ponto?.lat ?? latitude, ponto?.lng ?? longitude)
    mapObjRef.current.setZoom(zoomParaRaio(raio))
  }, [raio, latitude])

  // Mudou a tabela de taxas: as etiquetas das faixas mostram o valor novo.
  useEffect(() => {
    if (!mapObjRef.current || !latitude) return
    const ponto = markerRef.current?.getLatLng()
    desenharAneis(ponto?.lat ?? latitude, ponto?.lng ?? longitude)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxasKm, pelaRua])

  // ── Mapa pela rua (igual ao iFood) ───────────────────────────
  // Com a chave ligada, a área em volta da loja vira quadradinhos com os km de
  // moto até a loja. O servidor calcula uma vez e guarda; aqui só desenha.
  // Pintado de leve = onde a moto chega dentro do raio. Mouse numa faixa =
  // pinta forte até aquela faixa.
  useEffect(() => {
    if (!pelaRua || !empresaId || !latitude) return
    let vivo = true
    setGradeStatus('carregando')
    supabase.functions.invoke('geocodificar-google', { body: { acao: 'grade' } })
      .then(({ data }) => {
        if (!vivo) return
        if (!data?.ok) { setGradeStatus('erro'); return }
        gradeRef.current = data
        setGradeStatus('ok')
      })
      .catch(() => { if (vivo) setGradeStatus('erro') })
    return () => { vivo = false }
  // A grade é a do ponto SALVO da loja; arrastar o pino sem salvar não refaz.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pelaRua, empresaId, raio])

  useEffect(() => {
    const map = mapObjRef.current
    if (!map || !L) return
    if (gradeLayerRef.current) { map.removeLayer(gradeLayerRef.current); gradeLayerRef.current = null }
    const g = gradeRef.current
    const ponto = markerRef.current?.getLatLng()
    desenharAneis(ponto?.lat ?? latitude, ponto?.lng ?? longitude)
    const comGrade = pelaRua && !!g && gradeStatus === 'ok'
    // O círculo vermelho é o raio em linha reta: com a grade vira só contorno de referência.
    circleRef.current?.setStyle({ dashArray: comGrade ? '6 8' : null, weight: comGrade ? 1.5 : 3 })
    if (!comGrade) return
    const lat0 = g.origem?.[0] ?? latitude
    const dLat = g.passo_m / 111320 / 2
    const dLng = g.passo_m / (111320 * Math.cos(lat0 * Math.PI / 180)) / 2
    const raioAgora = Number(raio) || 10
    if (!gradeCanvasRef.current) gradeCanvasRef.current = L.canvas({ padding: 0.2 })
    const renderer = gradeCanvasRef.current
    const camada = L.layerGroup()
    for (const [la, ln, km] of g.celulas) {
      if (km > raioAgora) continue
      const forte = destaqueKm != null && meiaFaixa(km / fatorVal.current) <= destaqueKm
      L.rectangle([[la - dLat, ln - dLng], [la + dLat, ln + dLng]], {
        renderer, stroke: false, interactive: false,
        fillColor: forte ? '#a21caf' : '#c026d3',
        fillOpacity: forte ? 0.55 : (destaqueKm != null ? 0.15 : 0.3),
      }).addTo(camada)
    }
    camada.addTo(map)
    gradeLayerRef.current = camada
    markerRef.current?.setZIndexOffset(1000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gradeStatus, destaqueKm, pelaRua, raio, mapaPronto, fatorRua])

  // ── Faixas de 500 m, cada uma de uma cor ──────────────────────
  // Serve pra conferir as entregas: a cor diz em que "anel" o endereço caiu.
  // Polígonos com buraco no meio (não círculos empilhados), senão o centro
  // ficaria escuro e as cores se misturariam.
  function pontosDoCirculo(lat, lng, rM, n = 72) {
    const pts = []
    const kLng = 111320 * Math.cos(lat * Math.PI / 180)
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI
      pts.push([lat + (rM * Math.cos(a)) / 111320, lng + (rM * Math.sin(a)) / kLng])
    }
    return pts
  }
  // Meia faixa mais perto (2,7 → 2,5 ; 2,8 → 3), igual ao link e ao banco.
  const meiaFaixa = km => Math.round(Number(km) * 2) / 2
  function taxaAteKm(km) {
    const faixas = [...(taxasVal.current || [])]
      .map(f => ({ km: Number(f.km), taxa: Number(f.taxa) }))
      .filter(f => Number.isFinite(f.km) && Number.isFinite(f.taxa))
      .sort((a, b) => a.km - b.km)
    return faixas.find(f => meiaFaixa(km) <= f.km + 1e-9) ?? null
  }
  const kmTxt = km => (km % 1 === 0 ? String(km) : km.toFixed(1).replace('.', ',')) + ' km'
  // kmRua: undefined = loja em linha reta (ou o Google falhou); null = ainda calculando.
  function textoDoPonto(km, kmRua) {
    const r = raioVal.current
    if (pelaRuaVal.current && kmRua !== undefined) {
      const reta = `${km.toFixed(2).replace('.', ',')} km em linha reta`
      if (km > r) return `${reta}<br><span style="color:#dc2626">Fora do raio de ${kmTxt(r)}</span>`
      if (kmRua == null) return reta
      // Mesma régua do link: nunca cobra abaixo da reta.
      const rua = Math.max(kmRua, km)
      const cobrado = Math.max(kmRua / fatorVal.current, km)
      const f = taxaAteKm(cobrado) ?? [...(taxasVal.current || [])].map(x => ({ km: Number(x.km), taxa: Number(x.taxa) })).sort((a, b) => b.km - a.km)[0]
      return `${reta}<br><b>${rua.toFixed(2).replace('.', ',')} km pela rua</b> (caminho da moto)`
        + (fatorVal.current > 1 ? `<br>Na tabela: ${cobrado.toFixed(2).replace('.', ',')} km (rua ÷ ${String(fatorVal.current).replace('.', ',')})` : '')
        + (f ? `<br>Taxa: <b>R$ ${f.taxa.toFixed(2).replace('.', ',')}</b>` : '')
    }
    const f = taxaAteKm(km)
    const dist = `<b>${km.toFixed(2).replace('.', ',')} km</b> da loja`
    if (km > r) return `${dist}<br><span style="color:#dc2626">Fora do raio de ${kmTxt(r)}</span>`
    const faixa = Math.ceil(km / 0.5 - 1e-9) * 0.5
    return `${dist}<br>Anel de ${kmTxt(Math.max(0, faixa - 0.5))} a ${kmTxt(faixa)}`
      + (f ? `<br>Taxa: <b>R$ ${f.taxa.toFixed(2).replace('.', ',')}</b> (faixa até ${kmTxt(f.km)})` : '')
  }
  function desenharAneis(lat, lng) {
    const map = mapObjRef.current
    if (!map || !L) return
    ringsRef.current.forEach(l => map.removeLayer(l))
    ringsRef.current = []
    // Pela rua com o mapa da grade pronto: os anéis da linha reta saem de cena.
    if (pelaRuaVal.current && gradeRef.current) return
    const raioM = raioVal.current * 1000
    const passo = 500
    const total = Math.ceil(raioM / passo)
    // Poucas etiquetas quando o raio é grande, pra não encher o mapa de texto.
    const cada = raioVal.current <= 6 ? 1 : raioVal.current <= 12 ? 2 : 4
    for (let i = 1; i <= total; i++) {
      const rIn = (i - 1) * passo
      const rOut = Math.min(i * passo, raioM)
      if (rOut <= rIn) break
      const cor = `hsl(${(i * 47) % 360}, 72%, 46%)`
      const aneis = [pontosDoCirculo(lat, lng, rOut)]
      if (rIn > 0) aneis.push(pontosDoCirculo(lat, lng, rIn).reverse())
      const f = taxaAteKm(rOut / 1000)
      // Pela rua, o anel é só referência de linha reta: fica apagado e
      // tracejado pra ninguém ler a taxa nele.
      const ref = pelaRuaVal.current
      const poly = L.polygon(aneis, {
        color: cor, weight: ref ? 1 : 1.5, fillColor: cor, fillOpacity: ref ? 0.06 : 0.3,
        dashArray: ref ? '4 6' : null,
      }).bindTooltip(
        `${kmTxt(rIn / 1000)} a ${kmTxt(rOut / 1000)}` + (ref ? ' em linha reta · clique pra ver pela rua' : f ? ` · R$ ${f.taxa.toFixed(2).replace('.', ',')}` : ''),
        { sticky: true })
      poly.addTo(map)
      ringsRef.current.push(poly)
      if (!ref && (i % cada === 0 || i === total)) {
        const rot = L.marker([lat + rOut / 111320, lng], {
          interactive: false, keyboard: false,
          icon: L.divIcon({
            className: '',
            html: `<span style="display:inline-block;transform:translate(-50%,-50%);background:#fff;color:${cor};border:1.5px solid ${cor};border-radius:10px;padding:0 5px;font:700 11px/16px system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3)">${kmTxt(rOut / 1000)}${f ? ' · R$ ' + f.taxa : ''}</span>`,
            iconSize: [0, 0],
          }),
        }).addTo(map)
        ringsRef.current.push(rot)
      }
    }
    // O pino da loja fica por cima das faixas.
    markerRef.current?.setZIndexOffset(1000)
  }

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
  // `silencioso` é a busca automática da abertura: não fala nada quando dá
  // certo (a loja não pediu) e não reclama quando dá errado.
  async function geocodificarEndereco(silencioso = false) {
    if (!cidade) {
      if (!silencioso) setMsg({ type: 'error', text: 'Preencha pelo menos a cidade.' })
      return
    }
    setGeocodando(true)
    if (!silencioso) setMsg(null)
    try {
      const partes = [rua, numero, bairro, cidade, estado, 'Brasil'].filter(Boolean)
      const q = encodeURIComponent(partes.join(', '))
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
        headers: { 'User-Agent': 'CRM-FWC/1.0' }
      })
      const data = await res.json()
      if (!data?.[0]) {
        if (!silencioso) setMsg({ type: 'error', text: 'Endereço não encontrado. Tente ser mais específico.' })
        return
      }

      const lat = parseFloat(data[0].lat)
      const lng = parseFloat(data[0].lon)

      if (mapObjRef.current && markerRef.current) {
        // Mapa já existe: move pino e círculos sem recriar
        markerRef.current.setLatLng([lat, lng])
        circleRef.current?.setLatLng([lat, lng])
        desenharAneis(lat, lng)
        mapObjRef.current.setView([lat, lng], zoomParaRaio(raio))
      }

      // Atualiza estado DEPOIS de mover no mapa (não vai recriar pois guard `if mapObjRef.current return`)
      setLatitude(lat); setLongitude(lng)
      if (!silencioso) setMsg({ type: 'success', text: 'Localização atualizada. Arraste o pino para ajuste fino.' })
    } catch {
      if (!silencioso) setMsg({ type: 'error', text: 'Erro ao buscar localização.' })
    }
    finally { setGeocodando(false) }
  }

  // Abriu a tela com endereço preenchido e sem pino? Localiza sozinho.
  //
  // Antes, toda visita começava em "Localização não configurada" e obrigava o
  // lojista a clicar em Localizar no mapa de novo — e quem mexia em outra coisa
  // e salvava sem clicar deixava a loja SEM coordenada (ver o update acima).
  // Roda uma vez por visita e em silêncio: se a busca falhar, a tela fica como
  // estava e o botão continua ali.
  const autoLocalizouRef = useRef(false)
  useEffect(() => {
    if (autoLocalizouRef.current || !empresaId) return
    if (latitude && longitude) { autoLocalizouRef.current = true; return }
    if (!cidade || !(rua || bairro)) return
    autoLocalizouRef.current = true
    geocodificarEndereco(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresaId, latitude, longitude, cidade, rua, bairro])

  // ── Salva tudo ────────────────────────────────────────────────
  async function handleSalvar(e) {
    e.preventDefault()
    if (!empresaId) return
    setSalvando(true); setMsg(null)

    // O que está na tela é texto (ver os inputs das faixas); vira número aqui.
    const faixasOrdenadas = taxasKm
      .map(f => ({
        km: Number(f.km) || 0,
        taxa: Number(f.taxa) || 0,
        tempo: (f.tempo === '' || f.tempo == null) ? null : (Number(f.tempo) || 0),
      }))
      .sort((a, b) => a.km - b.km)
    // taxa_entrega não é mais "a taxa da loja": vira o piso ("a partir de"), pra
    // quem ainda lê esse campo (robô do WhatsApp, telas antigas) não concluir que
    // a entrega é de graça quando a distância não pôde ser calculada.
    const taxaPiso = faixasOrdenadas.length
      ? Math.min(...faixasOrdenadas.map(f => Number(f.taxa) || 0))
      : (parseFloat(taxaEntrega) || 0)

    const { error } = await supabase.from('empresas').update({
      aceita_delivery:      aceitaDelivery,
      aceita_retirada:      aceitaRetirada,
      aceita_entrega:       aceitaEntrega,
      taxa_pela_rua:        pelaRua,
      fator_rua:            Math.min(3, Math.max(1, Number(String(fatorRua).replace(',', '.')) || 1)),
      taxa_entrega:         taxaPiso,
      pedido_minimo:        parseFloat(pedidoMinimo) || 0,
      taxas_entrega_km:     faixasOrdenadas,
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
      // Coordenada só entra no update quando existe. Com `latitude || null` o
      // salvamento APAGAVA o pino sempre que a tela abria sem ele — e loja sem
      // coordenada não calcula taxa por km: todo pedido saía com a taxa errada
      // (ou de graça) sem ninguém entender por quê.
      ...(latitude && longitude ? { latitude, longitude } : {}),
      taxas_entrega_bairro: paraTaxasSalvas(taxasBairro),
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

        {/* Duas colunas no PC (mapa/endereço | raio/delivery) e uma só no
            celular. No monitor a coluna da direita rolava sozinha enquanto
            metade da tela ficava vazia. */}
        <div className="re-colunas">
        <div className="re-coluna">

        {/* ── Mapa ── */}
        <div className="re-map-wrapper">
          {temCoordenadas
            ? <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
                {pelaRua && (
                  <div style={{ position: 'absolute', left: 54, top: 10, zIndex: 500, background: '#fff', color: '#4a044e', border: '1px solid #e9d5ff', borderRadius: 8, padding: '5px 9px', font: '600 12px/1.35 system-ui,sans-serif', boxShadow: '0 1px 4px rgba(0,0,0,.2)', maxWidth: 260 }}>
                    {gradeStatus === 'carregando' ? '⏳ Montando o mapa pela rua… (só demora da primeira vez)'
                      : gradeStatus === 'erro' ? 'Não deu pra montar o mapa pela rua agora. Clique num ponto pra ver os km.'
                      : destaqueKm != null
                        ? <>Faixa até <b>{String(destaqueKm).replace('.', ',')} km</b>{fatorVal.current > 1 ? <> = até {(destaqueKm * fatorVal.current).toFixed(1).replace('.', ',')} km pela rua</> : ' pela rua'}{(() => { const f = taxaAteKm(destaqueKm); return f ? <> · R$ {f.taxa.toFixed(2).replace('.', ',')}</> : null })()}</>
                        : <>🛵 Pintado = onde a moto chega em até <b>{String(raio).replace('.', ',')} km</b> pela rua. Passe o mouse numa faixa →</>}
                  </div>
                )}
              </div>
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
            onClick={() => geocodificarEndereco(false)}
            disabled={geocodando || !cidade}
          >
            {geocodando ? 'Buscando...' : 'Localizar no mapa'}
          </button>
        </div>

        {/* ── Raio de entrega ── */}
        {/* Fica junto do mapa: mexeu no raio, vê o círculo mudar na hora. */}
        <div className="card">
          <h2 className="re-card-title">Raio de entrega</h2>

          <div className="re-raio-row">
            <div className="re-raio-slider-wrap">
              <input
                type="range" min={1} max={50} step={0.5}
                value={raio} onChange={e => mudarRaio(Number(e.target.value))}
              />
              <div className="re-raio-input-row">
                <input
                  type="number" min={1} max={100} step={0.5}
                  value={raio} onChange={e => mudarRaio(Number(e.target.value))}
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

        </div>{/* fim da coluna esquerda */}
        <div className="re-coluna">

        {/* ── Configurações de Delivery ── */}
        <div className="card">

          {/* A chave-mestra do link da loja — e o nome dela enganava.
              Chamava-se "Ativar delivery", então quem só faz retirada deixava
              desligado achando que era sobre entregar em casa, e o link da loja
              não abria pra ninguém: "Loja não encontrada". Aconteceu com o dono
              do sistema montando uma loja de conveniência (23/09). Se ele
              travou, o lojista novo desiste.
              Quem manda em ENTREGAR é o toggle de baixo; este manda em RECEBER
              PEDIDO. O aviso vermelho aparece desligado porque, sem ele, a loja
              some do ar sem dizer por quê. */}
          <div className="re-toggle-row">
            <div>
              <div className="re-toggle-label">Receber pedidos pelo link da loja</div>
              <div className="re-toggle-sub">
                Liga a Loja Online. <strong>Deixe ligado mesmo se você só faz retirada</strong> —
                quem decide se entrega em casa é a opção abaixo.
              </div>
              {!aceitaDelivery && (
                <div style={{
                  marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.45,
                  background: 'rgba(220,38,38,.10)', border: '1px solid rgba(220,38,38,.35)', color: '#dc2626',
                }}>
                  Desligado, o link da sua loja mostra <strong>“Loja não encontrada”</strong> e ninguém
                  consegue pedir — nem pra retirar no balcão.
                </div>
              )}
            </div>
            <div className="re-toggle-controls">
              <span className={`re-status-badge ${aceitaDelivery ? 'active' : 'inactive'}`}>
                {aceitaDelivery ? 'Ativo' : 'Inativo'}
              </span>
              <button
                type="button"
                className={`re-switch ${aceitaDelivery ? 'on' : 'off'}`}
                onClick={() => setAceitaDelivery(v => !v)}
                aria-label="Receber pedidos pelo link da loja"
                aria-pressed={aceitaDelivery}
              >
                <span className="re-switch-thumb" />
              </button>
            </div>
          </div>

          {/* Entrega — o contrário do de baixo. Bar que só atende no balcão
              desliga aqui e o cardápio online passa a oferecer só retirada. */}
          <div className="re-toggle-row" style={{ borderTop: '1px solid var(--border)' }}>
            <div>
              <div className="re-toggle-label">Fazer entrega</div>
              <div className="re-toggle-sub">
                {aceitaEntrega
                  ? 'O cliente pode pedir pra receber em casa.'
                  : 'Só retirada — a opção “Entrega” some do cardápio online e ninguém pede pra receber em casa.'}
                <br />
                <span style={{ opacity: .75 }}>Vale para a loja online e o portal. Não muda o WhatsApp, o balcão, as mesas nem o iFood.</span>
              </div>
            </div>
            <div className="re-toggle-controls">
              <span className={`re-status-badge ${aceitaEntrega ? 'active' : 'inactive'}`}>
                {aceitaEntrega ? 'Ativo' : 'Inativo'}
              </span>
              <button
                type="button"
                className={`re-switch ${aceitaEntrega ? 'on' : 'off'}`}
                onClick={() => setAceitaEntrega(v => !v)}
                aria-label="Fazer entrega"
                aria-pressed={aceitaEntrega}
              >
                <span className="re-switch-thumb" />
              </button>
            </div>
          </div>

          {/* Retirada na loja — vale só pra loja online e portal do cliente.
              O bot do WhatsApp, o balcão, as mesas e o iFood seguem oferecendo
              retirada normalmente. */}
          <div className="re-toggle-row" style={{ borderTop: '1px solid var(--border)' }}>
            <div>
              <div className="re-toggle-label">Permitir retirada na loja</div>
              <div className="re-toggle-sub">
                {aceitaRetirada
                  ? 'O cliente pode escolher entre entrega e retirar na loja.'
                  : 'Só entrega — a opção “Retirar na loja” some do cardápio online.'}
                <br />
                <span style={{ opacity: .75 }}>Vale para a loja online e o portal. Não muda o WhatsApp, o balcão, as mesas nem o iFood.</span>
              </div>
            </div>
            <div className="re-toggle-controls">
              <span className={`re-status-badge ${aceitaRetirada ? 'active' : 'inactive'}`}>
                {aceitaRetirada ? 'Ativo' : 'Inativo'}
              </span>
              <button
                type="button"
                className={`re-switch ${aceitaRetirada ? 'on' : 'off'}`}
                onClick={() => setAceitaRetirada(v => !v)}
                aria-label="Permitir retirada na loja"
                aria-pressed={aceitaRetirada}
              >
                <span className="re-switch-thumb" />
              </button>
            </div>
          </div>

          {/* Taxa pelo caminho da moto (28/10/2026). Pela rua dá em média
              1,3x a 1,5x a linha reta: com as mesmas faixas, a taxa sobe. */}
          <div className="re-toggle-row" style={{ borderTop: '1px solid var(--border)' }}>
            <div>
              <div className="re-toggle-label">Cobrar pelo caminho da moto (km real)</div>
              <div className="re-toggle-sub">
                {pelaRua
                  ? 'A taxa sai dos km que a moto anda pela rua (Google), não da linha reta. Os círculos do mapa viram só referência: clique num ponto pra ver os km pela rua e a taxa.'
                  : 'Hoje a taxa sai da distância em linha reta (os círculos do mapa).'}
                <br />
                <span style={{ opacity: .75 }}>Pela rua a distância costuma ser 30% a 50% maior que a reta. Revise as faixas antes de ligar. Vale para a loja online e o app.</span>
              </div>
            </div>
            <div className="re-toggle-controls">
              <span className={`re-status-badge ${pelaRua ? 'active' : 'inactive'}`}>
                {pelaRua ? 'Ativo' : 'Inativo'}
              </span>
              <button
                type="button"
                className={`re-switch ${pelaRua ? 'on' : 'off'}`}
                onClick={() => setPelaRua(v => !v)}
                aria-label="Cobrar pelo caminho da moto"
                aria-pressed={pelaRua}
              >
                <span className="re-switch-thumb" />
              </button>
            </div>
          </div>

          {aceitaDelivery && (
            <div className="re-delivery-body">
              <div className="form-grid">

                {/* Faixas de entrega por distância (única forma de cobrar) */}
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
                        <div key={i} className="re-faixas-row"
                          onMouseEnter={() => setDestaqueKm(Number(faixa.km) || null)}
                          onMouseLeave={() => setDestaqueKm(null)}
                          onFocus={() => setDestaqueKm(Number(faixa.km) || null)}
                          onBlur={() => setDestaqueKm(null)}>
                          {/* Os três campos guardam o TEXTO digitado, não o número.
                              Guardando número, digitar 23 em cima do 0 deixava "023"
                              preso na tela: pro React "023" == 23, então ele não
                              repintava o campo. Vira número só na hora de salvar. */}
                          <input
                            type="number" min="0.5" step="0.5"
                            value={faixa.km ?? ''}
                            onChange={e => {
                              const next = [...taxasKm]
                              next[i] = { ...next[i], km: e.target.value }
                              setTaxasKm(next)
                            }}
                            onFocus={e => e.target.select()}
                            className="form-input"
                            placeholder="0.5"
                          />
                          <input
                            type="number" min="0" step="0.50"
                            value={faixa.taxa ?? ''}
                            onChange={e => {
                              const next = [...taxasKm]
                              next[i] = { ...next[i], taxa: e.target.value }
                              setTaxasKm(next)
                            }}
                            onFocus={e => e.target.select()}
                            className="form-input"
                            placeholder="5.00"
                          />
                          <input
                            type="number" min="1" step="1"
                            value={faixa.tempo ?? ''}
                            onChange={e => {
                              const next = [...taxasKm]
                              next[i] = { ...next[i], tempo: e.target.value }
                              setTaxasKm(next)
                            }}
                            onFocus={e => e.target.select()}
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
                            : +Math.min((Number(taxasKm.at(-1)?.km) || 0) + 0.5, raioMax).toFixed(1)
                          // Taxa nasce VAZIA: o zero que ninguém digitou só
                          // atrapalha na hora de escrever o valor por cima.
                          setTaxasKm([...taxasKm, { km: nextKm, taxa: '', tempo: Math.round(nextKm * 5) }])
                        }}
                      >
                        + Adicionar faixa
                      </button>

                      <p className="re-faixas-hint">
                        Cada faixa define a taxa e o tempo estimado para aquela distância. A faixa mais próxima é aplicada automaticamente no pedido. Pode usar de <b>500 em 500 m</b> (0,5 · 1 · 1,5 · 2 km…). Cobra o mesmo valor para toda a área? Basta repetir a mesma taxa em todas as linhas.
                      </p>
                    </div>
                </div>

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

        </div>{/* fim da coluna do meio */}
        <div className="re-coluna re-coluna-bairros">

        {/* ── Taxa por bairro (opcional) ── */}
        {aceitaDelivery && (
        <div style={{ background: 'var(--surface, #fff)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <h2 className="re-card-title">🏘️ Taxa por bairro (opcional)</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 14px' }}>
            Puxei os bairros dos seus pedidos. Escolha o que fazer com cada um — e use a busca
            pra achar um bairro na lista ou cadastrar um que ainda não apareceu.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
              <input value={novoBairro}
                onChange={e => { setNovoBairro(e.target.value); setBairroOpen(true) }}
                onFocus={() => setBairroOpen(true)}
                onBlur={() => setTimeout(() => setBairroOpen(false), 150)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); adicionarBairro(novoBairro) } }}
                placeholder="Buscar na lista ou cadastrar um bairro (ex.: potengi)…" autoComplete="off"
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
          {(() => {
            // A busca de cima serve pras duas coisas: filtrar a lista que já
            // existe e oferecer o "+ Adicionar" quando o bairro é novo.
            const q = normBairro(novoBairro)
            const conta = {
              todos: taxasBairro.length,
              taxa: taxasBairro.filter(b => b.modo === 'taxa').length,
              km: taxasBairro.filter(b => b.modo === 'km').length,
              bloqueio: taxasBairro.filter(b => b.modo === 'bloqueio').length,
            }
            const visiveis = taxasBairro
              .map((b, i) => ({ b, i }))
              .filter(({ b }) => (filtroBairro === 'todos' || b.modo === filtroBairro)
                && (!q || normBairro(b.bairro).includes(q)))
            const mudar = (i, patch) => setTaxasBairro(prev => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)))
            return (
              <>
                <div className="re-bairro-resumo">
                  {[['todos', 'Todos', conta.todos],
                    ['taxa', '💰 Taxa fixa', conta.taxa],
                    ['km', '📏 Pelo km', conta.km],
                    ['bloqueio', '🚫 Não entrego', conta.bloqueio]].map(([id, rot, n]) => (
                    <button key={id} type="button"
                      className={`re-bairro-chip${filtroBairro === id ? ' ativo' : ''}`}
                      onClick={() => setFiltroBairro(id)}>
                      {rot} <b>{n}</b>
                    </button>
                  ))}
                </div>

                <div className="re-bairro-lista">
                  {taxasBairro.length === 0 && (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>Carregando bairros…</p>
                  )}
                  {taxasBairro.length > 0 && visiveis.length === 0 && (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                      {q ? <>Nenhum bairro da lista com “{novoBairro}”. Use o <b>+ Adicionar</b> pra criar.</>
                         : 'Nenhum bairro nesse filtro.'}
                    </p>
                  )}
                  {visiveis.map(({ b, i }) => (
                    <div key={b.norm} className={`re-bairro-row modo-${b.modo}`}>
                      <div className="re-bairro-nome">
                        <strong title={b.bairro}>{b.bairro}</strong>
                        {b.total > 0 && <span>{b.total} pedido{b.total === 1 ? '' : 's'}</span>}
                      </div>

                      <select value={b.modo} onChange={e => mudar(i, { modo: e.target.value })}>
                        <option value="km">Pelo km (padrão)</option>
                        <option value="taxa">Taxa fixa</option>
                        <option value="bloqueio">Não entrego</option>
                      </select>

                      {b.modo === 'taxa' ? (
                        <>
                          <label className="re-bairro-campo" title="Taxa de entrega deste bairro">
                            <em>R$</em>
                            <input type="number" step="0.01" min="0" value={b.taxa} placeholder="0,00"
                              onChange={e => mudar(i, { taxa: e.target.value })} />
                          </label>
                          <label className="re-bairro-campo sufixo" title="Tempo de entrega deste bairro (opcional)">
                            <input type="number" min="0" value={b.tempo} placeholder="—"
                              onChange={e => mudar(i, { tempo: e.target.value })} />
                            <em>min</em>
                          </label>
                        </>
                      ) : (
                        <span className="re-bairro-vazio">
                          {b.modo === 'bloqueio' ? 'o cliente não consegue pedir' : 'usa a tabela por distância'}
                        </span>
                      )}

                      <button type="button" className="re-bairro-x"
                        onClick={() => esconderBairro(b)}
                        title={`Tirar "${b.bairro}" da lista`}
                        aria-label={`Tirar ${b.bairro} da lista`}>×</button>
                    </div>
                  ))}
                </div>
              </>
            )
          })()}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            A taxa do bairro <b>manda</b> na tabela por km: quem está aqui como “Taxa fixa” paga esse valor,
            e só quem não está na lista cai na distância. Vale no cardápio online, no balcão e nos robôs.
          </p>
        </div>
        )}

        </div>{/* fim da coluna direita */}
        </div>{/* fim das colunas */}


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
