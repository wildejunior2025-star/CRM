// Som do CHAMADO DE ATENDENTE — de propósito diferente do som de pedido novo.
//
// Pedido novo são três bipes curtos e agudos (880 Hz). O chamado é uma
// CAMPAINHA de telefone antigo: dois martelos batendo rápido no sino
// ("trin-trin-trin"), três toques com respiro entre eles. Alto e insistente —
// tem gente parada no WhatsApp esperando alguém responder, e o balcão está de
// costas pro computador.
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

const TOQUE_S = 0.85   // duração de cada "trinnn"
const PAUSA_S = 0.28   // respiro entre um toque e outro
const TOQUES  = 3
const BATIDAS = 26     // batidas do martelo por segundo — é o que faz o "trin"

export function tocarChamado() {
  try {
    const ctx = ctxAudio()
    if (ctx.state === 'suspended') ctx.resume()

    // Um limitador na saída: o sino é alto, mas não pode estourar o alto-falante.
    const limite = ctx.createDynamicsCompressor()
    limite.threshold.setValueAtTime(-8, ctx.currentTime)
    limite.ratio.setValueAtTime(12, ctx.currentTime)
    const mestre = ctx.createGain()
    mestre.gain.setValueAtTime(0.9, ctx.currentTime)
    mestre.connect(limite)
    limite.connect(ctx.destination)

    for (let i = 0; i < TOQUES; i++) {
      const t0 = ctx.currentTime + i * (TOQUE_S + PAUSA_S)
      const t1 = t0 + TOQUE_S

      // Envelope do toque inteiro (abre rápido, fecha rápido).
      const env = ctx.createGain()
      env.gain.setValueAtTime(0, t0)
      env.gain.linearRampToValueAtTime(1, t0 + 0.015)
      env.gain.setValueAtTime(1, t1 - 0.05)
      env.gain.linearRampToValueAtTime(0, t1)
      env.connect(mestre)

      // O martelo: um LFO quadrado picota o som e vira "trin-trin-trin".
      const picote = ctx.createGain()
      picote.gain.setValueAtTime(0.45, t0)
      picote.connect(env)
      const lfo = ctx.createOscillator()
      lfo.type = 'square'
      lfo.frequency.setValueAtTime(BATIDAS, t0)
      const lfoGanho = ctx.createGain()
      lfoGanho.gain.setValueAtTime(0.45, t0)
      lfo.connect(lfoGanho)
      lfoGanho.connect(picote.gain)
      lfo.start(t0)
      lfo.stop(t1)

      // Duas notas juntas, como os dois sinos da campainha.
      ;[1050, 1400].forEach(hz => {
        const osc = ctx.createOscillator()
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(hz, t0)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.5, t0)
        osc.connect(g)
        g.connect(picote)
        osc.start(t0)
        osc.stop(t1)
      })
    }
  } catch {
    // Sem Web Audio (navegador antigo, aba sem permissão): o aviso visual fica.
  }
}
