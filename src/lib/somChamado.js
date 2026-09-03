// Som do CHAMADO DE ATENDENTE — de propósito diferente do som de pedido novo.
//
// Pedido novo são três bipes curtos e agudos (880 Hz). Se o chamado tocasse
// igual, quem está no balcão correria pra impressora e não pra conversa. Este
// aqui é uma campainha de duas notas, grave e mais demorada — soa como
// "alguém te chamando", não como "saiu pedido".
let _ctx = null

function ctxAudio() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)()
    // O navegador só deixa tocar depois de um gesto do usuário. Como o chamado
    // chega sozinho, o desbloqueio fica pendurado em qualquer clique.
    const soltar = () => { if (_ctx.state === 'suspended') _ctx.resume() }
    document.addEventListener('click', soltar)
    document.addEventListener('keydown', soltar)
    document.addEventListener('touchstart', soltar)
  }
  return _ctx
}

export function tocarChamado() {
  try {
    const ctx = ctxAudio()
    if (ctx.state === 'suspended') ctx.resume()
    // Ding-dong, duas vezes.
    const notas = [
      { hz: 660, em: 0 },
      { hz: 495, em: 0.30 },
      { hz: 660, em: 0.75 },
      { hz: 495, em: 1.05 },
    ]
    notas.forEach(({ hz, em }) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.setValueAtTime(hz, ctx.currentTime + em)
      gain.gain.setValueAtTime(0.30, ctx.currentTime + em)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + em + 0.28)
      osc.start(ctx.currentTime + em)
      osc.stop(ctx.currentTime + em + 0.28)
    })
  } catch {
    // Sem Web Audio (navegador antigo, aba sem permissão): o aviso visual fica.
  }
}
