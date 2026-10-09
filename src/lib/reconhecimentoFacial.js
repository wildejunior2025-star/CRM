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

// 0,6 é o padrão do modelo. Começamos em 0,5 e em 08/10/2026 o sistema
// LIBEROU A PESSOA ERRADA: uma visitante bateu 0,481 com uma aluna. Os
// acertos de verdade medidos aqui ficaram entre 0,31 e 0,42. Daí 0,44:
// não reconhecer quem é aluno atrapalha; liberar quem não é, não pode.
export const LIMITE_MESMA_PESSOA = 0.44

// E não basta estar abaixo do limite: o segundo colocado (outro aluno) tem
// que ficar bem atrás. Quando dois alunos disputam de perto a leitura está
// ruim demais pra decidir, e aí é melhor não reconhecer ninguém.
export const MARGEM_MINIMA = 0.05

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

// Nenhum passo pode ficar pendurado pra sempre. Num iPhone antigo, em 4G
// ruim, o download emperrava e a tela ficava eternamente em "Baixando o
// reconhecimento" — sem dizer o que estava acontecendo nem dar saída.
function comPrazo(promessa, segundos, oQue) {
  return Promise.race([
    promessa,
    new Promise((_, rejeitar) => setTimeout(
      () => rejeitar(new Error(`Demorou demais ${oQue}. Internet fraca? Tente de novo, de preferência no Wi-Fi.`)),
      segundos * 1000)),
  ])
}

// Baixa a biblioteca e os 3 modelos (detector, pontos do rosto, reconhecimento).
// São uns 7 MB na primeira vez; depois o navegador guarda.
// `aviso` recebe o passo atual, pra tela mostrar que a coisa anda.
// Chamado de novo, devolve o mesmo carregamento.
export function carregarFaceApi(aviso = () => {}) {
  if (!carregando) {
    carregando = (async () => {
      if (!window.faceapi) {
        aviso('Baixando o programa (1 de 4)...')
        await comPrazo(carregarScript(`${BASE}/dist/face-api.js`), 40, 'baixando o programa')
      }
      const faceapi = window.faceapi
      if (!faceapi) throw new Error('O reconhecimento não carregou neste aparelho. Tente outro navegador.')

      aviso('Preparando o aparelho...')
      await comPrazo(faceapi.tf.ready(), 20, 'preparando o aparelho')
      // Aparelho velho às vezes não dá conta do WebGL e o programa trava
      // calado. Melhor cair pro modo lento do que não funcionar.
      if (!faceapi.tf.getBackend()) {
        try { await faceapi.tf.setBackend('cpu') } catch { /* segue */ }
      }

      const modelos = [
        ['Baixando o detector (2 de 4)...', faceapi.nets.tinyFaceDetector, 'baixando o detector'],
        ['Baixando os pontos do rosto (3 de 4)...', faceapi.nets.faceLandmark68Net, 'baixando os pontos do rosto'],
        ['Baixando o reconhecimento (4 de 4)...', faceapi.nets.faceRecognitionNet, 'baixando o reconhecimento'],
      ]
      // Um de cada vez: em internet fraca, três downloads juntos brigam
      // entre si e nenhum termina.
      //
      // E se um modelo empacar: os arquivos são pequenos (o maior tem
      // 356 KB) e o CDN responde em menos de um segundo, então travar aí não
      // é download — é o aparelho não dando conta de montar o modelo na
      // placa de vídeo. Aconteceu num iPhone antigo, que parava no 3 de 4.
      // Nesse caso trocamos pro modo lento (processador) e tentamos de novo:
      // fica mais devagar, mas funciona.
      let jaCaiuPraCpu = false
      for (const [texto, net, oQue] of modelos) {
        aviso(texto)
        try {
          await comPrazo(net.loadFromUri(`${BASE}/model`), 25, oQue)
        } catch (e) {
          if (jaCaiuPraCpu) throw e
          jaCaiuPraCpu = true
          aviso('Esse aparelho é mais lento. Mudando o jeito de carregar...')
          try { await faceapi.tf.setBackend('cpu'); await faceapi.tf.ready() } catch { throw e }
          aviso(texto)
          await comPrazo(net.loadFromUri(`${BASE}/model`), 60, oQue)
        }
      }
      return faceapi
    })().catch(e => { carregando = null; throw e })
  }
  return carregando
}

// Tamanho da imagem que o detector analisa. 416 acha a caixa do rosto com
// mais precisão que 320 (caixa melhor = pontos melhores = digital melhor),
// mas pesa. Em 08/10 subimos pra 416 e no computador da academia a leitura
// ficou lenta — então agora o próprio sistema desce pra 320 quando vê que o
// aparelho não dá conta. O tempo de cada leitura aparece no canto da tela.
const DETECTOR_LEVE = 320
const DETECTOR_BOM = 416
let tamanhoDetector = DETECTOR_BOM
export const detectorAtual = () => tamanhoDetector
export function aliviarDetector() {
  if (tamanhoDetector === DETECTOR_LEVE) return false
  tamanhoDetector = DETECTOR_LEVE
  return true
}
const opcoesDetector = () => new window.faceapi.TinyFaceDetectorOptions({ inputSize: tamanhoDetector, scoreThreshold: 0.5 })

// Só ACHA os rostos: caixas, sem pontos e sem digital. É a parte barata.
// Serve pra decidir se vale a pena pagar a parte cara — o descritor é uma
// rede neural rodando em cima do recorte do rosto, e é o que pesa.
export async function acharRostos(video) {
  const achados = await window.faceapi.detectAllFaces(video, opcoesDetector())
  if (!achados.length) return { quantos: 0, maior: null }
  const maior = achados.reduce((a, b) => (b.box.area > a.box.area ? b : a))
  return { quantos: achados.length, maior: maior.box }
}

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

// Daqui pra cima conta como "de lado": o cadastro recusa a amostra.
//
// A prova de vida (piscar ou virar o rosto antes de liberar) foi tirada em
// 08/10/2026 — a academia não tem o risco de alguém entrar mostrando a foto
// de outra pessoa no celular, e ela atrasava a entrada de todo mundo.
export const GIRO_LADO = 0.15

// Tela cheia de verdade (some a barra do navegador). No iPad é o webkit*.
// Tem que ser chamado direto no toque do botão.
//
// No CELULAR não pedimos: o Android joga um aviso grande ("arraste de cima pra
// sair da tela cheia") bem em cima dos botões de capturar (visto 07/10), e a
// tela já ocupa tudo de qualquer jeito.
export function entrarTelaCheia() {
  const toque = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  if (toque) return
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

// As leituras que ficam guardadas no aluno são SÓ as do cadastro. Até
// 08/10/2026 a recepção também "aprendia" sozinha: toda leitura reconhecida
// entre 0,30 e 0,48 era gravada na ficha. Isso envenenou um cadastro — a
// visitante que foi confundida com uma aluna teve o rosto dela gravado na
// ficha da aluna, e o erro se repetiria cada vez mais fácil. Foi tirado.
export const LEITURAS_CADASTRO = 4

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

// Quem é? Mede a leitura contra todos os descritores de todos os alunos.
// Só devolve alguém quando as duas coisas valem: a distância está abaixo do
// limite E o aluno seguinte está pelo menos MARGEM_MINIMA atrás. Devolve
// também a margem, que a recepção mostra no diagnóstico.
export function acharAluno(descritor, alunos) {
  let melhor = null      // { aluno, distancia }
  let segundo = Infinity // melhor distância de um aluno DIFERENTE do melhor
  for (const aluno of alunos) {
    let desta = Infinity
    for (const d of aluno.descritores || []) {
      const dist = distancia(descritor, d)
      if (dist < desta) desta = dist
    }
    if (desta === Infinity) continue
    if (!melhor || desta < melhor.distancia) {
      if (melhor) segundo = Math.min(segundo, melhor.distancia)
      melhor = { aluno, distancia: desta }
    } else {
      segundo = Math.min(segundo, desta)
    }
  }
  if (!melhor || melhor.distancia >= LIMITE_MESMA_PESSOA) return null
  const margem = segundo - melhor.distancia
  if (margem < MARGEM_MINIMA) return null
  return { ...melhor, margem }
}

// Qual câmera o cadastro usa neste aparelho. A de TRÁS do celular tem bem mais
// resolução, e quem tira a foto é a recepção, não o próprio aluno (07/10).
const CHAVE_CAMERA = 'academia_camera'
export function cameraPadrao() {
  try {
    const salva = localStorage.getItem(CHAVE_CAMERA)
    if (salva) return salva
  } catch { /* sem memória do navegador */ }
  // Aparelho de toque (celular/tablet) começa na de trás; PC só tem uma.
  const toque = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  return toque ? 'environment' : 'user'
}
export function guardarCamera(camera) {
  try { localStorage.setItem(CHAVE_CAMERA, camera) } catch { /* só não lembra */ }
}

// `leve`: resolução menor (640x480), pra aparelho fraco. A recepção NÃO usa
// mais (08/10): a digital do rosto é recortada da imagem de verdade, então
// imagem pequena = digital pobre = mais chance de confundir uma pessoa com
// outra. Com uma webcam ruim isso já é o gargalo; não dá pra piorar de graça.
// `camera`: 'user' (frente) ou 'environment' (trás).
export async function ligarCamera(video, { leve = false, camera = 'user' } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador não libera a câmera. No iPad, use o Safari.')
  }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: camera }, width: { ideal: leve ? 640 : 1280 }, height: { ideal: leve ? 480 : 960 } },
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

  // No iPhone o play() volta antes de existir imagem: por um tempo o vídeo
  // tem tamanho 0x0, e ler rosto aí não acha nada — a captura parecia "não
  // funcionar", sem erro nenhum. Espera o primeiro quadro de verdade.
  for (let i = 0; i < 100 && !video.videoWidth; i++) {
    await new Promise(r => setTimeout(r, 50))
  }
  if (!video.videoWidth) {
    throw new Error('A câmera abriu mas não veio imagem. Feche outros apps que usam a câmera e tente de novo.')
  }

  // Sem zoom (tirado a pedido em 19/09): a tela mostra exatamente o que a
  // câmera lê — nada de reconhecer quem aparece cortado. Só a câmera da FRENTE
  // é espelhada; a de trás mostra a cena como ela é.
  video.style.transform = camera === 'environment' ? 'none' : 'scaleX(-1)'
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
// Quantos dias o aluno ainda entra depois de vencer. Venceu hoje: laranja.
// Primeiro e segundo dia de atraso: laranja, ainda passa. Do terceiro em
// diante: vermelho e a catraca não abre.
export const CARENCIA_DIAS = 2

export function situacaoAluno(aluno) {
  if (!aluno.ativo) return { status: 'inativo', texto: 'Matrícula inativa' }
  // Cortesia não vence: dono, família, funcionário, parceria. Antes isso era
  // feito com um vencimento de mentira lá em 2040.
  if (aluno.cortesia) return { status: 'liberado', texto: 'Cortesia', cortesia: true }
  if (!aluno.vencimento) return { status: 'liberado', texto: 'Sem vencimento cadastrado' }
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const venc = new Date(aluno.vencimento + 'T00:00:00')
  const dias = Math.round((venc - hoje) / 86400000)
  if (dias < 0) {
    const atraso = -dias
    // Carência: venceu, mas ainda entra por CARENCIA_DIAS. Ninguém leva
    // barrada na catraca por um dia de atraso — a cobrança é da recepção,
    // não da roleta. Fica laranja esse tempo todo; depois trava.
    if (atraso <= CARENCIA_DIAS) {
      return {
        status: 'liberado',
        aviso: true,
        carencia: true,
        texto: `Vencida há ${atraso} dia${atraso === 1 ? '' : 's'} — carência`,
      }
    }
    return { status: 'vencido', texto: `Vencida há ${atraso} dias` }
  }
  if (dias === 0) return { status: 'liberado', texto: 'Vence hoje', aviso: true }
  if (dias <= 3) return { status: 'liberado', texto: `Vence em ${dias} dia${dias === 1 ? '' : 's'}`, aviso: true }
  return { status: 'liberado', texto: `Em dia até ${venc.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}` }
}
