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
  return { descritor: maior.descriptor, caixa: maior.detection.box, quantos: achados.length }
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

// Liga a câmera da frente no <video>. Devolve o stream pra desligar depois.
export async function ligarCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador não libera a câmera. No iPad, use o Safari.')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  })
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  video.muted = true
  await video.play()
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
