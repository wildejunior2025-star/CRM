// Cadastro Incorporado (Embedded Signup) do WhatsApp Cloud API.
// Carrega o SDK do Facebook, abre o popup da Meta e devolve o que o backend
// precisa: { code, phone_number_id, waba_id }.
//
// O fluxo é meio torto de propósito: o popup manda os IDs (phone_number_id/
// waba_id) por um evento `message`, e o `code` vem no callback do FB.login.
// A gente junta os dois.

const APP_ID        = import.meta.env.VITE_WA_APP_ID || ''
const CONFIG_ID     = import.meta.env.VITE_WA_CONFIG_ID || ''
const GRAPH_VERSION = import.meta.env.VITE_WA_GRAPH_VERSION || 'v21.0'

// Coexistência: a loja continua usando o WhatsApp Business no celular dela e o
// robô roda no MESMO número — mesmas conversas, mesmos contatos. Sem isso o
// número sai do aparelho, que é a objeção nº 1 de quem já tem cliente no zap.
// Vazio (VITE_WA_FEATURE_TYPE=none) volta ao cadastro comum.
const FEATURE_TYPE = (() => {
  const v = import.meta.env.VITE_WA_FEATURE_TYPE
  if (v === 'none') return ''
  return v || 'whatsapp_business_app_onboarding'
})()

let sdkPromise = null

function carregarSDK() {
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB)
    if (!APP_ID) return reject(new Error('WhatsApp não configurado (VITE_WA_APP_ID ausente).'))

    window.fbAsyncInit = function () {
      window.FB.init({
        appId: APP_ID,
        autoLogAppEvents: true,
        xfbml: false,
        version: GRAPH_VERSION,
      })
      resolve(window.FB)
    }

    const s = document.createElement('script')
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    s.async = true
    s.defer = true
    s.crossOrigin = 'anonymous'
    s.onerror = () => reject(new Error('Falha ao carregar o SDK do Facebook.'))
    document.body.appendChild(s)
  })
  return sdkPromise
}

// Abre o popup e resolve com { code, phone_number_id, waba_id }.
export async function conectarWhatsAppCloud() {
  if (!CONFIG_ID) {
    throw new Error('Conexão via Meta ainda não liberada (config_id ausente). Fale com o suporte.')
  }
  const FB = await carregarSDK()

  return new Promise((resolve, reject) => {
    let sessionInfo = null

    function onMessage(event) {
      if (
        event.origin !== 'https://www.facebook.com' &&
        event.origin !== 'https://web.facebook.com'
      ) return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
            sessionInfo = {
              phone_number_id: data.data?.phone_number_id,
              waba_id: data.data?.waba_id,
            }
          } else if (data.event === 'CANCEL') {
            cleanup()
            reject(new Error('Conexão cancelada.'))
          }
        }
      } catch {
        // mensagens que não são JSON — ignora
      }
    }

    function cleanup() {
      window.removeEventListener('message', onMessage)
    }

    window.addEventListener('message', onMessage)

    FB.login((response) => {
      const code = response?.authResponse?.code
      cleanup()
      if (!code) {
        return reject(new Error('Você não concluiu a conexão. Tente de novo.'))
      }
      if (!sessionInfo?.phone_number_id || !sessionInfo?.waba_id) {
        return reject(new Error('A Meta não devolveu o número. Refaça a conexão até o final.'))
      }
      resolve({
        code,
        phone_number_id: sessionInfo.phone_number_id,
        waba_id: sessionInfo.waba_id,
      })
    }, {
      config_id: CONFIG_ID,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: FEATURE_TYPE,
        sessionInfoVersion: '3',
        version: 'v4',
      },
    })
  })
}
