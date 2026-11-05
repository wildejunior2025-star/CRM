// Os dois sons do gestor, de propósito bem diferentes um do outro.
//
// PEDIDO NOVO é a CAMPAINHA de telefone antigo: dois martelos batendo rápido no
// sino ("trin-trin-trin"). Alto e insistente — é venda chegando, e o balcão
// está de costas pro computador.
//
// CHAMADO DE ATENDENTE (cliente no WhatsApp pedindo uma pessoa) são três bipes
// curtos e agudos ("tu-tu-tu").
//
// Até 14/09/2026 era o contrário; a troca foi pedido da loja.
let _ctx = null

// iPhone (Safari e o app): três travas que deixavam o "triririn" mudo.
//  1) O contexto de áudio nasce SUSPENSO e só destrava com um gesto de toque que
//     termine (touchend/pointerup/click). `touchstart` NÃO conta no iOS.
//  2) O botão lateral de silencioso do iPhone cala o Web Audio — a menos que a
//     sessão de áudio seja "playback" (navigator.audioSession, iOS 16.4+).
//  3) O destrave era instalado só na primeira vez que o som tocava, tarde demais.
// Por isso o contexto agora nasce já no carregamento, com o destrave pendurado
// em qualquer toque, pra valer pelo resto da sessão.
function ctxAudio() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)()
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback' } catch { /* sem suporte */ }
    const soltar = () => {
      try { if (_ctx.state !== 'running') _ctx.resume() } catch { /* ignora */ }
      // Um sopro mudo de 1 amostra: é o que o iOS exige pra considerar liberado.
      try {
        const b = _ctx.createBuffer(1, 1, 22050)
        const src = _ctx.createBufferSource()
        src.buffer = b; src.connect(_ctx.destination); src.start(0)
      } catch { /* ignora */ }
    }
    ;['touchend', 'pointerup', 'click', 'keydown'].forEach(ev =>
      document.addEventListener(ev, soltar, { passive: true }))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { try { _ctx.resume() } catch { /* ignora */ } }
    })
  }
  return _ctx
}

// O painel chama isto na abertura: cria o contexto e deixa o destrave pronto.
export function prepararSom() { try { ctxAudio() } catch { /* sem Web Audio */ } }

// true = o aparelho ainda não liberou o som (precisa de um toque na tela).
export function somBloqueado() {
  try { return !!_ctx && _ctx.state !== 'running' } catch { return false }
}

const TOQUE_S = 0.85   // duração de cada "trinnn"
const PAUSA_S = 0.28   // respiro entre um toque e outro
const BATIDAS = 26     // batidas do martelo por segundo — é o que faz o "trin"

// Campainha ("triririn"). `toques` × 1,13 s — o loop do pedido novo repete a
// cada 3 s, então ele usa 2 toques pra um não atropelar o outro.
export function tocarCampainha(toques = 3) {
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

    for (let i = 0; i < toques; i++) {
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

// Três bipes curtos e agudos (880 Hz) — "tu-tu-tu".
export function tocarBipes() {
  try {
    const ctx = ctxAudio()
    if (ctx.state === 'suspended') ctx.resume()
    ;[0, 0.18, 0.36].forEach(offset => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.setValueAtTime(880, ctx.currentTime + offset)
      gain.gain.setValueAtTime(0.28, ctx.currentTime + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.14)
      osc.start(ctx.currentTime + offset)
      osc.stop(ctx.currentTime + offset + 0.14)
    })
  } catch {
    // Web Audio não disponível — o aviso visual fica.
  }
}

export const tocarPedidoNovo = () => tocarCampainha(2)
export const tocarChamado = tocarBipes
