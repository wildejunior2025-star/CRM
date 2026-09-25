// "TypeError: Failed to fetch" NA CARA DA ATENDENTE.
//
// Esse erro é do navegador, não do sistema: quer dizer que a requisição nem
// saiu do aparelho — Wi-Fi caiu, cabo solto, roteador fora. Mas na tela ele
// aparecia em inglês, com "TypeError" na frente, e a atendente parava o
// atendimento achando que o sistema tinha quebrado (Estação do Sabor, 25/09).
//
// Aqui a mesma falha vira um recado que diz o que aconteceu e o que fazer.

/** A falha foi de rede (não chegou no servidor)? */
export function ehFalhaDeRede(erro) {
  const msg = String(erro?.message ?? erro ?? '').toLowerCase()
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  return msg.includes('failed to fetch')      // Chrome
    || msg.includes('load failed')            // Safari
    || msg.includes('networkerror')           // Firefox
    || msg.includes('network request failed') // app/webview
    || msg.includes('err_internet_disconnected')
}

/**
 * Recado pra mostrar no lugar do erro cru.
 * `oQue` completa a frase: "não deu pra abrir a comanda".
 */
export function recadoDeErro(erro, oQue = 'salvar') {
  if (ehFalhaDeRede(erro)) {
    return `📶 Sem internet neste aparelho — não deu pra ${oQue}.\n\n`
      + 'Confira o Wi-Fi ou o cabo e tente de novo. Nada do que já estava na tela se perdeu.'
  }
  return `Erro ao ${oQue}: ${erro?.message ?? erro}`
}
