// ============================================================================
// Pontes do app FWC Gestor (Android).
//
// O app do gestor é uma casca que abre gestor.fwcinter.com ao vivo — por isso
// toda mudança do site chega no app sem passar pela Play. Só que a WebView do
// Android não tem duas coisas que o Chrome tem e que o gestor usa:
//   - navigator.bluetooth → a impressora Bluetooth do celular morria no app
//   - navigator.wakeLock  → a tela apagava e a impressora parava de imprimir
//
// Em vez de reescrever imprimirBluetooth.js e o Salão, aqui a gente monta as
// duas "de mentira" em cima dos plugins nativos (BluetoothLe e KeepAwake), com
// as mesmas peças que o código já usa. No Chrome nada muda: só instala dentro
// do app, e só o que o navegador não tiver de verdade.
// ============================================================================

const plugin = (nome) => {
  const cap = typeof window !== 'undefined' ? window.Capacitor : null
  return (cap?.isNativePlatform?.() && cap.Plugins?.[nome]) || null
}

export const ehAppNativo = () => !!window.Capacitor?.isNativePlatform?.()

export function instalarPontesDoApp() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  if (!ehAppNativo()) return
  instalarBluetoothNativo()
  instalarTelaAcesaNativa()
}

// Mesmo formato do Screen Wake Lock do Chrome: request('screen') devolve uma
// trava com release() e o evento 'release'.
function instalarTelaAcesaNativa() {
  if ('wakeLock' in navigator) return
  const ka = plugin('KeepAwake')
  if (!ka) return
  const wakeLock = {
    async request() {
      await ka.keepAwake()
      const ouvintes = []
      const trava = {
        released: false,
        type: 'screen',
        addEventListener(tipo, fn) { if (tipo === 'release') ouvintes.push(fn) },
        async release() {
          if (trava.released) return
          trava.released = true
          await ka.allowSleep().catch(() => {})
          ouvintes.forEach(fn => { try { fn() } catch { /* ok */ } })
        },
      }
      return trava
    },
  }
  try {
    Object.defineProperty(navigator, 'wakeLock', { value: wakeLock, configurable: true })
  } catch { /* segue sem */ }
}

const LS_DEV = 'bt_printer_id' // o mesmo que imprimirBluetooth.js grava

// O plugin nativo só aceita texto: os bytes vão como hex ("1b40…").
const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

function instalarBluetoothNativo() {
  if (navigator.bluetooth) return
  const ble = plugin('BluetoothLe')
  if (!ble) return

  // initialize pede a permissão de Bluetooth do Android. neverForLocation: a
  // impressora não precisa da localização do celular.
  let pronto = null
  const iniciar = () => (pronto ||= ble.initialize({ androidNeverForLocation: true })
    .catch(e => { pronto = null; throw e }))

  const aparelhos = new Map()

  function aparelho(id, nome) {
    const ja = aparelhos.get(id)
    if (ja) { if (nome) ja.name = nome; return ja }

    const ouvintes = []
    let ouvindoQueda = false

    const caracteristica = (servico, c) => {
      const base = { deviceId: id, service: servico, characteristic: c.uuid }
      return {
        uuid: c.uuid,
        properties: c.properties || {},
        writeValueWithoutResponse: (bytes) => ble.writeWithoutResponse({ ...base, value: hex(bytes) }),
        writeValue: (bytes) => ble.write({ ...base, value: hex(bytes) }),
      }
    }

    const servidor = {
      async getPrimaryServices() {
        const { services = [] } = await ble.getServices({ deviceId: id })
        return services.map(s => ({
          uuid: s.uuid,
          getCharacteristics: async () => (s.characteristics || []).map(c => caracteristica(s.uuid, c)),
        }))
      },
    }

    const dev = {
      id,
      name: nome || null,
      addEventListener(tipo, fn) { if (tipo === 'gattserverdisconnected') ouvintes.push(fn) },
      gatt: {
        connected: false,
        async connect() {
          await iniciar()
          if (!ouvindoQueda) {
            ouvindoQueda = true
            await ble.addListener(`disconnected|${id}`, () => {
              dev.gatt.connected = false
              ouvintes.forEach(fn => { try { fn() } catch { /* ok */ } })
            })
          }
          await ble.connect({ deviceId: id, timeout: 10000 })
          dev.gatt.connected = true
          return servidor
        },
        disconnect() {
          dev.gatt.connected = false
          ble.disconnect({ deviceId: id }).catch(() => {})
        },
      },
    }
    aparelhos.set(id, dev)
    return dev
  }

  const bluetooth = {
    // Abre a lista nativa de aparelhos por perto (o mesmo papel do seletor do Chrome).
    async requestDevice() {
      await iniciar()
      const d = await ble.requestDevice({})
      return aparelho(d.deviceId, d.name)
    },
    // No Android dá pra religar direto pelo endereço — não precisa da lista de
    // "sites autorizados" do Chrome. Devolve o último aparelho usado.
    async getDevices() {
      let salvo = null
      try { salvo = localStorage.getItem(LS_DEV) } catch { /* ok */ }
      const ids = new Set([...aparelhos.keys(), ...(salvo ? [salvo] : [])])
      return [...ids].map(id => aparelho(id))
    },
  }

  try {
    Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true })
  } catch { /* navegador não deixou — segue sem */ }
}
