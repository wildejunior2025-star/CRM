import { useEffect, useState } from 'react'
import {
  serialSuportado, portaLembrada, escolherPorta, abrirPorta, fecharPorta, portaAberta,
  pulso, enviarBytes, lerConfigCatraca, salvarConfigCatraca,
} from '../../lib/catracaSerial'

// academia.fwcinter.com/catraca — descobrir e guardar como a catraca abre.
// Aberta no Chrome do PC em que a catraca está ligada (com o SCA FECHADO,
// senão ele segura a porta). Cada botão testa um jeito; o que destravar,
// a pessoa aperta "Foi esse!" e a recepção passa a usar.

const TESTES = [
  { id: 'dtr', nome: 'Sinal DTR', cfg: { tipo: 'pino', dtr: true, rts: false } },
  { id: 'rts', nome: 'Sinal RTS', cfg: { tipo: 'pino', dtr: false, rts: true } },
  { id: 'ambos', nome: 'DTR + RTS juntos', cfg: { tipo: 'pino', dtr: true, rts: true } },
]

export default function AcademiaCatraca() {
  const [porta, setPorta] = useState(null)
  const [baud, setBaud] = useState(9600)
  const [ms, setMs] = useState(3000)
  const [log, setLog] = useState([])
  const [ocupado, setOcupado] = useState(false)
  const [salva, setSalva] = useState(lerConfigCatraca)
  const [hex, setHex] = useState('')
  const [ultimo, setUltimo] = useState(null)

  const anotar = t => setLog(l => [`${new Date().toLocaleTimeString('pt-BR')} — ${t}`, ...l].slice(0, 30))

  useEffect(() => {
    if (!serialSuportado()) return
    portaLembrada().then(p => { if (p) setPorta(p) })
    return () => { fecharPorta() }
  }, [])

  async function conectar(p) {
    try {
      await abrirPorta(p, baud)
      setPorta(p)
      const info = p.getInfo?.() || {}
      anotar(`Porta aberta (${baud}). ${info.usbVendorId ? `USB ${info.usbVendorId.toString(16)}:${info.usbProductId?.toString(16)}` : ''}`)
    } catch (e) {
      anotar(`Não abriu: ${e.message}. O SCA está fechado?`)
    }
  }

  async function escolher() {
    try { await conectar(await escolherPorta()) } catch { anotar('Nenhuma porta escolhida.') }
  }

  async function testar(t) {
    setOcupado(true)
    try {
      if (!portaAberta()) await conectar(porta)
      anotar(`Testando ${t.nome} por ${ms / 1000}s...`)
      await pulso({ ...t.cfg, ms })
      anotar(`${t.nome} terminou. A catraca destravou?`)
      setUltimo({ ...t.cfg, ms, baudRate: baud, nome: t.nome })
    } catch (e) {
      anotar(`Erro: ${e.message}`)
    }
    setOcupado(false)
  }

  async function testarBytes() {
    const bytes = hex.trim().split(/[\s,]+/).filter(Boolean).map(x => parseInt(x, 16))
    if (!bytes.length || bytes.some(isNaN)) return anotar('Digite os bytes em hexa, ex: 01 4C 0D')
    setOcupado(true)
    try {
      if (!portaAberta()) await conectar(porta)
      await enviarBytes(bytes)
      anotar(`Enviado: ${hex}. A catraca destravou?`)
      setUltimo({ tipo: 'bytes', bytes, baudRate: baud, nome: `Bytes ${hex}` })
    } catch (e) {
      anotar(`Erro: ${e.message}`)
    }
    setOcupado(false)
  }

  function foiEsse() {
    salvarConfigCatraca(ultimo)
    setSalva(ultimo)
    anotar(`Guardado: a catraca abre com "${ultimo.nome}". A recepção já vai usar.`)
  }

  if (!serialSuportado()) {
    return (
      <div className="ac-card">
        <h2>Catraca</h2>
        <p className="ac-erro">Este navegador não fala com a catraca. Abra esta página no <b>Google Chrome do computador</b> onde o cabo da catraca está ligado.</p>
      </div>
    )
  }

  return (
    <div className="ac-card ac-form">
      <h2>Teste da catraca</h2>
      <p className="ac-muted">
        Antes de começar, <b>feche o SCA</b> (ele segura a porta da catraca). Depois escolha a porta
        (<b>USB Serial Port</b> / COM3) e teste um botão de cada vez, olhando a catraca.
      </p>

      {salva && (
        <div className="ac-aviso" style={{ color: 'var(--success)', background: 'var(--success-bg)' }}>
          Configuração guardada: <b>{salva.nome}</b>{salva.ms ? ` por ${salva.ms / 1000}s` : ''}.
        </div>
      )}

      <div className="ac-dupla">
        <label>Velocidade
          <select value={baud} onChange={e => setBaud(Number(e.target.value))} disabled={!!portaAberta()}>
            {[9600, 4800, 19200, 38400, 115200].map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label>Tempo destravada
          <select value={ms} onChange={e => setMs(Number(e.target.value))}>
            {[1000, 2000, 3000, 5000, 8000].map(v => <option key={v} value={v}>{v / 1000} segundos</option>)}
          </select>
        </label>
      </div>

      <div className="ac-form-botoes" style={{ justifyContent: 'flex-start' }}>
        <button className="btn btn-primary" onClick={escolher} disabled={ocupado}>
          {porta ? 'Trocar porta' : '1. Escolher a porta da catraca'}
        </button>
        {porta && <span className="ac-status ac-liberado" style={{ alignSelf: 'center' }}>Porta escolhida ✓</span>}
      </div>

      {porta && (
        <>
          <strong>2. Teste um de cada vez:</strong>
          <div className="ac-form-botoes" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {TESTES.map(t => (
              <button key={t.id} className="btn btn-secondary" onClick={() => testar(t)} disabled={ocupado}>{t.nome}</button>
            ))}
          </div>
          <details>
            <summary className="ac-muted">Avançado: mandar bytes</summary>
            <div className="ac-form-botoes" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
              <input value={hex} onChange={e => setHex(e.target.value)} placeholder="ex: 01 4C 0D" style={{ flex: 1 }} />
              <button className="btn btn-secondary" onClick={testarBytes} disabled={ocupado}>Enviar</button>
            </div>
          </details>
          {ultimo && (
            <button className="btn btn-primary" onClick={foiEsse} disabled={ocupado}>
              ✓ A catraca destravou com "{ultimo.nome}" — foi esse!
            </button>
          )}
        </>
      )}

      {log.length > 0 && (
        <div className="ac-card" style={{ fontFamily: 'monospace', fontSize: 13, maxHeight: 220, overflow: 'auto' }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}
