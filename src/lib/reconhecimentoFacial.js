// Reconhecimento facial da academia (mig 0276).
//
// Usa o face-api (fork mantido do @vladmandic), carregado do CDN só quando a
// tela de câmera abre — não pesa no resto do sistema. Roda tudo no aparelho
// (tablet/iPad): a foto nunca sai dele, só vai pro banco o "descritor", uma
// lista de 128 números que resume o rosto.
//
// Reconhecer = comparar o descritor de quem está na câmera com os dos alunos
// cadastrados. Distância menor que LIMITE_MESMA_PESSOA = mesma pessoa.

const VERSAO = '1.7.15'
const BASE = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${VERSAO}`

// 0,6 é o padrão do modelo; 0,5 erra menos por outra pessoa, que é o erro
// que custa caro aqui (liberar quem está devendo).
export const LIMITE_MESMA_PESSOA = 0.5

let carregando = null

function carregarScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = resolve
    s.onerror = () => reject(new Error('Não consegui baixar o reconhecimento facial. Confira a internet.'))
    document.head.appendChild(s)
  })
}

// Baixa a biblioteca e os 3 modelos (detector, pontos do rosto, reconhecimento).
// Chamado de novo, devolve o mesmo carregamento.
export function carregarFaceApi() {
  if (!carregando) {
    carregando = (async () => {
      if (!window.faceapi) await carregarScript(`${BASE}/dist/face-api.js`)
      const faceapi = window.faceapi
      await faceapi.tf.ready()
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(`${BASE}/model`),
        faceapi.nets.faceLandmark68Net.loadFromUri(`${BASE}/model`),
        faceapi.nets.faceRecognitionNet.loadFromUri(`${BASE}/model`),
      ])
      return faceapi
    })().catch(e => { carregando = null; throw e })
  }
  return carregando
}

const opcoesDetector = () => new window.faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })

// Acha o maior rosto no vídeo e devolve { descritor, caixa } ou null.
export async function lerRosto(video) {
  const faceapi = window.faceapi
  const achados = await faceapi
    .detectAllFaces(video, opcoesDetector())
    .withFaceLandmarks()
    .withFaceDescriptors()
  if (!achados.length) return null
  const maior = achados.reduce((a, b) => (b.detection.box.area > a.detection.box.area ? b : a))
  return {
    descritor: maior.descriptor,
    caixa: maior.detection.box,
    quantos: achados.length,
    olhos: aberturaDosOlhos(maior.landmarks.positions),
    giro: giroDaCabeca(maior.landmarks.positions),
  }
}

// Quanto a cabeça está virada pro lado: 0 = de frente; passa de ±0,12 quando
// a pessoa vira de verdade. O sinal diz o lado. Mede a ponta do nariz (30)
// contra o meio dos cantos de fora dos olhos (36 e 45).
function giroDaCabeca(p) {
  const meio = (p[36].x + p[45].x) / 2
  const largura = Math.abs(p[45].x - p[36].x) || 1
  return (p[30].x - meio) / largura
}

// Leitura rápida dos pontos do rosto (sem a digital, que é o que pesa):
// olhos e giro da cabeça, pra prova de vida com muitas leituras por segundo.
//
// Prova de vida: VIRAR O ROSTO é o que funciona. Foto no celular, mesmo
// girando o aparelho, não muda o nariz em relação aos olhos. Piscar ficou
// como extra — o modelo de 68 pontos desenha o olho meio aberto mesmo
// fechado, e no iPad a piscada não era vista (teste de 19/09/2026).
export const GIRO_LADO = 0.15
export async function lerOlhos(video) {
  const r = await window.faceapi
    .detectSingleFace(video, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
    .withFaceLandmarks()
  if (!r) return null
  const p = r.landmarks.positions
  return { olhos: aberturaDosOlhos(p), giro: giroDaCabeca(p), caixa: r.detection.box }
}

// Detector de piscada: compara cada leitura com o olho mais aberto das
// últimas leituras (cada pessoa tem um tamanho de olho). Caiu pra menos de
// 80% = fechou; voltou pra mais de 90% depois de fechar = piscou.
export function criarDetectorPiscada() {
  const hist = []
  let fechou = false
  return olhos => {
    hist.push(olhos)
    if (hist.length > 20) hist.shift()
    const aberto = Math.max(...hist)
    if (hist.length < 3) return false
    if (olhos < aberto * 0.8) fechou = true
    else if (fechou && olhos > aberto * 0.9) return true
    return false
  }
}

// Quanto os olhos estão abertos (média dos dois). Olho aberto fica por volta
// de 0,25–0,35; piscando cai pra perto de 0,1. Serve pra prova de vida:
// foto no celular não pisca. Pontos 36–41 e 42–47 do modelo de 68 pontos.
function aberturaDosOlhos(p) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  const olho = i => (d(p[i + 1], p[i + 5]) + d(p[i + 2], p[i + 4])) / (2 * d(p[i], p[i + 3]))
  return (olho(36) + olho(42)) / 2
}

// Tela cheia de verdade (some a barra do navegador). No iPad é o webkit*.
// Tem que ser chamado direto no toque do botão.
export function entrarTelaCheia() {
  const el = document.documentElement
  try {
    const p = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)
    p?.catch?.(() => {})
  } catch { /* aparelho sem tela cheia: segue normal */ }
}
export function sairTelaCheia() {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const p = (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
      p?.catch?.(() => {})
    }
  } catch { /* ignora */ }
}

function distancia(a, b) {
  let soma = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    soma += d * d
  }
  return Math.sqrt(soma)
}

// Compara com todos os alunos e devolve o mais parecido abaixo do limite.
// Cada aluno pode ter vários descritores (fotos do cadastro); vale o melhor.
// Aprender com a câmera da catraca: junta a leitura de agora às do cadastro.
// Guarda as 4 do cadastro + as 8 mais recentes aprendidas (a mais velha sai).
export const LEITURAS_CADASTRO = 4
export const LEITURAS_APRENDIDAS = 8
export function juntarLeitura(descritores, nova) {
  const cadastro = descritores.slice(0, LEITURAS_CADASTRO)
  const aprendidas = [...descritores.slice(LEITURAS_CADASTRO), Array.from(nova)].slice(-LEITURAS_APRENDIDAS)
  return [...cadastro, ...aprendidas]
}

// O rosto está INTEIRO na parte da imagem que aparece na tela? A tela recorta
// o vídeo pra preencher o espaço (object-fit: cover), então a câmera enxerga
// mais do que aparece: sem isto, reconhecia gente com meio rosto fora da tela
// — e meio rosto dá leitura ruim. Também exige um tamanho mínimo de rosto.
export function rostoInteiroNaTela(caixa, video) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const W = video.clientWidth || vw
  const H = video.clientHeight || vh
  if (!vw || !vh) return false
  const escala = Math.max(W / vw, H / vh) * Number(video.dataset.zoom || 1)
  const visivelW = W / escala
  const visivelH = H / escala
  const margemX = (vw - visivelW) / 2 + visivelW * 0.02
  const margemY = (vh - visivelH) / 2 + visivelH * 0.02
  const dentro = caixa.x >= margemX && caixa.y >= margemY
    && caixa.x + caixa.width <= vw - margemX && caixa.y + caixa.height <= vh - margemY
  const grande = caixa.width >= visivelW * 0.14
  return dentro && grande
}

export function acharAluno(descritor, alunos) {
  let melhor = null
  for (const aluno of alunos) {
    for (const d of aluno.descritores || []) {
      const dist = distancia(descritor, d)
      if (dist < LIMITE_MESMA_PESSOA && (!melhor || dist < melhor.distancia)) {
        melhor = { aluno, distancia: dist }
      }
    }
  }
  return melhor
}

// `leve`: resolução menor (640x480). A recepção usa — o reconhecimento reduz a
// imagem de qualquer jeito, e em PC antigo a imagem grande só deixa lento.
export async function ligarCamera(video, { leve = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador não libera a câmera. No iPad, use o Safari.')
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: leve ? 640 : 1280 }, height: { ideal: leve ? 480 : 960 } },
      audio: false,
    })
  } catch {
    // Webcam USB de PC às vezes não aceita os pedidos acima: tenta qualquer câmera.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    } catch (e2) {
      if (e2.name === 'NotFoundError') throw new Error('Nenhuma câmera encontrada. Confira se a webcam está ligada no USB e aparece no Windows; depois feche e abra o Chrome.', { cause: e2 })
      if (e2.name === 'NotReadableError') throw new Error('A câmera está sendo usada por outro programa. Feche o outro programa e recarregue.', { cause: e2 })
      throw e2
    }
  }
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  video.muted = true
  await video.play()

  // Sem zoom (tirado a pedido em 19/09): a tela mostra exatamente o que a
  // câmera lê — nada de reconhecer quem aparece cortado.
  video.style.transform = 'scaleX(-1)'
  video.dataset.zoom = '1'
  return stream
}

export function desligarCamera(stream) {
  stream?.getTracks().forEach(t => t.stop())
}

// Miniatura quadrada do rosto (pra recepção conferir quem é). JPEG pequeno,
// cabe direto no cadastro.
export function miniaturaDoRosto(video, caixa, lado = 160) {
  const canvas = document.createElement('canvas')
  canvas.width = lado
  canvas.height = lado
  const margem = Math.max(caixa.width, caixa.height) * 0.35
  const tam = Math.max(caixa.width, caixa.height) + margem * 2
  const cx = caixa.x + caixa.width / 2
  const cy = caixa.y + caixa.height / 2
  canvas.getContext('2d').drawImage(video, cx - tam / 2, cy - tam / 2, tam, tam, 0, 0, lado, lado)
  return canvas.toDataURL('image/jpeg', 0.8)
}

// Situação da mensalidade pelo vencimento (data 'AAAA-MM-DD').
export function situacaoAluno(aluno) {
  if (!aluno.ativo) return { status: 'inativo', texto: 'Matrícula inativa' }
  if (!aluno.vencimento) return { status: 'liberado', texto: 'Sem vencimento cadastrado' }
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const venc = new Date(aluno.vencimento + 'T00:00:00')
  const dias = Math.round((venc - hoje) / 86400000)
  if (dias < 0) {
    return { status: 'vencido', texto: `Mensalidade vencida há ${-dias} dia${dias === -1 ? '' : 's'}` }
  }
  if (dias === 0) return { status: 'liberado', texto: 'Mensalidade vence HOJE', aviso: true }
  if (dias <= 3) return { status: 'liberado', texto: `Mensalidade vence em ${dias} dia${dias === 1 ? '' : 's'}`, aviso: true }
  return { status: 'liberado', texto: `Em dia até ${venc.toLocaleDateString('pt-BR')}` }
}
