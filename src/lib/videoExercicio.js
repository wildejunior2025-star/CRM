// O vídeo de "como faz" o exercício.
//
// O professor pode prender um link certo no exercício (botão 🎥). Quando não
// prendeu — que é o caso de quase todos —, cai numa busca pronta no YouTube
// em vez de ficar sem nada. Link de busca não quebra com o tempo, que é o
// problema de guardar vídeo.
//
// Pede SHORTS: quem está olhando é um celular na mão, e short é vertical —
// enche a tela, sem tarja preta em cima e embaixo.
export function buscaNoYoutube(nome) {
  const busca = encodeURIComponent(`${nome} execução correta academia #shorts`)
  return `https://www.youtube.com/results?search_query=${busca}`
}

// O link que vale pra este exercício: o que o professor prendeu, ou a busca.
export const linkDoVideo = (nome, prendido) => prendido || buscaNoYoutube(nome)
