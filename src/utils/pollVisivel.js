// Consulta periódica que alivia o banco quando ninguém está olhando.
//
// Aba visível: roda a cada `visivelMs`. Aba escondida (celular com tela apagada,
// outra aba na frente): roda a cada `ocultoMs`, bem mais devagar. Quando a pessoa
// volta pra aba, atualiza NA HORA — ela nunca vê dado velho ao olhar.
// Devolve a função que desliga tudo (use no cleanup do useEffect).
export function pollVisivel(fn, visivelMs = 8000, ocultoMs = 30000) {
  let timer = null
  let parado = false

  const rodar = async () => {
    try { await fn() } catch { /* a próxima volta tenta de novo */ }
  }

  const agendar = () => {
    if (parado) return
    clearTimeout(timer)
    const espera = document.visibilityState === 'hidden' ? ocultoMs : visivelMs
    timer = setTimeout(async () => { await rodar(); agendar() }, espera)
  }

  const aoMudarVisibilidade = () => {
    if (document.visibilityState === 'visible') { rodar(); agendar() }
  }

  document.addEventListener('visibilitychange', aoMudarVisibilidade)
  agendar()

  return () => {
    parado = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', aoMudarVisibilidade)
  }
}
