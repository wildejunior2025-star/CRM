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

/**
 * Abre o popup e resolve com { code, phone_number_id, waba_id }.
 *
 * @param onCodigo  chamado assim que o código chega — inclusive DEPOIS do
 *   tempo limite. Sem isso, uma conexão que demorou (a loja lendo a tela,
 *   procurando o QR no celular) era jogada fora justamente quando dava certo.
 */
export async function conectarWhatsAppCloud({ onCodigo } = {}) {
  if (!CONFIG_ID) {
    throw new Error('Conexão via Meta ainda não liberada (config_id ausente). Fale com o suporte.')
  }
  const FB = await carregarSDK()

  return new Promise((resolve, reject) => {
    let sessionInfo = null
    let pronto = false
    let desistiu = false

    // O popup às vezes termina numa página em branco e nunca fecha: a Meta
    // registra a conexão do lado dela (o número já aparece plugado no celular),
    // mas o aviso de volta pro navegador se perde e o FB.login nunca chama.
    // Sem isto a tela ficava em "Conectando..." pra sempre, sem dizer nada.
    //
    // Só que desistir aqui NÃO pode significar largar o código: quem estoura o
    // tempo é justamente quem está com dificuldade, e o código costuma chegar
    // logo depois. Por isso a gente avisa a loja mas continua ouvindo — quando
    // chegar, `onCodigo` conclui a conexão do mesmo jeito.
    const limite = setTimeout(() => {
      if (pronto) return
      desistiu = true
      reject(new Error(
        'A janela da Meta está demorando. Pode terminar por ela mesmo assim — '
        + 'se você concluir, a conexão entra sozinha aqui. Se ela ficou em branco, '
        + 'feche-a e clique em Conectar de novo.'
      ))
    }, 15 * 60 * 1000)

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
      pronto = true
      clearTimeout(limite)
      window.removeEventListener('message', onMessage)
    }

    window.addEventListener('message', onMessage)

    FB.login((response) => {
      const code = response?.authResponse?.code
      cleanup()
      if (!code) {
        if (desistiu) return
        return reject(new Error('Você não concluiu a conexão. Tente de novo.'))
      }
      // Os IDs vêm por um evento separado do popup e às vezes se perdem no
      // caminho. Com o `code` na mão o backend descobre a WABA e o número
      // sozinho (pelo próprio token), então não vale barrar a loja por isso.
      const dados = {
        code,
        phone_number_id: sessionInfo?.phone_number_id ?? null,
        waba_id: sessionInfo?.waba_id ?? null,
      }
      // Chegou depois do tempo limite: a promessa já foi recusada, então quem
      // conclui é o callback — do contrário a loja teria feito tudo à toa.
      if (desistiu) return onCodigo?.(dados)
      resolve(dados)
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
