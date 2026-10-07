import { useEffect, useRef, useState } from 'react'
import {
  carregarFaceApi, lerRosto, ligarCamera, desligarCamera, miniaturaDoRosto, acharAluno,
  sairTelaCheia, GIRO_LADO, cameraPadrao, guardarCamera,
} from '../../lib/reconhecimentoFacial'

// Captura do rosto em 4 etapas (frente, um lado, o outro, frente de novo).
// Usada tanto pela recepção cadastrando o aluno quanto pelo próprio aluno no
// celular dele. Só avança quando a pessoa FAZ o que a tela pede.

const AMOSTRAS = 4
const GIRO_FRENTE = 0.08 // até aqui conta como "de frente"

export default // Liga a câmera e guia a pessoa em 4 etapas (frente, um lado, outro lado,
// frente de novo), guardando uma "digital do rosto" em cada.
function CapturaRosto({ alunos, onPronto, onCancelar }) {
  const videoRef = useRef(null)
  const [fase, setFase] = useState('carregando') // carregando | pronto | capturando | revisar | erro
  const [msg, setMsg] = useState('Preparando a câmera...')
  const [feitas, setFeitas] = useState(0)
  const [resultado, setResultado] = useState(null) // { descritores, foto } esperando o "ficou boa?"
  // Câmera de TRÁS por padrão no celular: resolução melhor e quem tira a foto
  // é a recepção, não o aluno.
  const [camera, setCamera] = useState(cameraPadrao)
  const capturaRef = useRef(0) // muda a cada captura; captura antiga que ainda estiver rodando para sozinha

  useEffect(() => {
    let stream = null
    let vivo = true
    ;(async () => {
      try {
        setMsg('Baixando o reconhecimento (só na primeira vez)...')
        await carregarFaceApi()
        if (!vivo) return
        stream = await ligarCamera(videoRef.current, { camera })
        if (!vivo) return desligarCamera(stream)
        setFase('pronto')
        setMsg('Rosto de frente, bem iluminado. Aperte Capturar.')
      } catch (e) {
        setFase('erro')
        setMsg(e.name === 'NotAllowedError' ? 'A câmera foi bloqueada. Libere nas permissões do navegador.' : e.message)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- é um contador, não um nó
    return () => { vivo = false; capturaRef.current++; desligarCamera(stream); sairTelaCheia() }
  }, [camera])

  // Cada etapa só passa quando a pessoa FEZ o que a tela pediu — conferido
  // pela posição do nariz em relação aos olhos. Sem pular por tempo;
  // quem desistir aperta Cancelar.
  async function capturar() {
    setFase('capturando')
    const minha = ++capturaRef.current
    const cancelou = () => capturaRef.current !== minha
    const descritores = []
    let foto
    let ladoVirado = 0
    const ok = async texto => { setMsg(`✓ ${texto}`); setFeitas(descritores.length); await esperar(900) }

    // Espera uma leitura que cumpra `condicao` por `seguidas` vezes seguidas.
    async function esperarQue(dica, condicao, seguidas = 2) {
      let n = 0
      setMsg(dica)
      while (!cancelou()) {
        const r = await lerRosto(videoRef.current).catch(() => null)
        if (cancelou()) return null
        if (!r) { setMsg(`${dica} — não estou vendo o rosto`); n = 0; await esperar(120); continue }
        if (r.quantos > 1) { setMsg('Tem mais de uma pessoa na câmera.'); n = 0; await esperar(300); continue }
        setMsg(dica)
        if (condicao(r)) { if (++n >= seguidas) return r } else n = 0
        await esperar(80)
      }
      return null
    }

    // 1. De frente
    let r = await esperarQue('Olhe de frente pra câmera', x => Math.abs(x.giro) < GIRO_FRENTE, 3)
    if (!r) return
    foto = miniaturaDoRosto(videoRef.current, r.caixa, 280)
    descritores.push(Array.from(r.descritor))
    await ok('Muito bem!')

    // 2. Vira pra um lado
    r = await esperarQue('Vire o rosto devagar pra um lado', x => Math.abs(x.giro) > GIRO_LADO)
    if (!r) return
    ladoVirado = Math.sign(r.giro)
    descritores.push(Array.from(r.descritor))
    await ok('Isso!')

    // 3. Vira pro outro lado
    r = await esperarQue('Agora vire pro outro lado', x => Math.sign(x.giro) === -ladoVirado && Math.abs(x.giro) > GIRO_LADO)
    if (!r) return
    descritores.push(Array.from(r.descritor))
    await ok('Perfeito!')

    // 4. De frente de novo
    r = await esperarQue('Olhe de frente de novo', x => Math.abs(x.giro) < GIRO_FRENTE, 3)
    if (!r) return
    descritores.push(Array.from(r.descritor))
    await ok('Pronto!')
    // Já é outro aluno? Evita cadastrar a mesma pessoa duas vezes.
    const repetido = acharAluno(descritores[0], alunos)
    if (repetido && !window.confirm(`Esse rosto parece com ${repetido.aluno.nome}, que já está cadastrado. Salvar assim mesmo?`)) {
      setFase('pronto')
      setFeitas(0)
      setMsg('Capture de novo ou volte.')
      return
    }
    // Antes de usar, mostra a foto grande e pergunta se ficou boa.
    setResultado({ descritores, foto })
    setFase('revisar')
  }

  function tirarDeNovo() {
    setResultado(null)
    setFeitas(0)
    setFase('pronto')
    setMsg('Rosto de frente, bem iluminado. Aperte Capturar.')
  }

  // Tela cheia por cima de tudo: no tablet a câmera pequena no canto do
  // formulário não dava pra enquadrar direito.
  return (
    <div className="ac-captura-tela">
      <div className="ac-captura-video">
        <video ref={videoRef} className="ac-video" playsInline muted />
        {fase !== 'revisar' && <div className="ac-guia-rosto" />}
        {fase !== 'revisar' && <div className={`ac-captura-msg${fase === 'erro' ? ' erro' : ''}`}>{msg}</div>}
        {fase === 'capturando' && (
          <div className="ac-captura-progresso"><div style={{ width: `${(feitas / AMOSTRAS) * 100}%` }} /></div>
        )}
        {fase === 'revisar' && resultado && (
          <div className="ac-captura-revisar">
            <img src={resultado.foto} alt="" />
            <h2>Ficou boa?</h2>
            <p>O rosto tem que estar nítido, de frente e sem sombra forte.</p>
          </div>
        )}
      </div>
      <div className="ac-captura-botoes">
        {fase === 'revisar' ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={tirarDeNovo}>Tirar de novo</button>
            <button type="button" className="btn btn-primary" onClick={() => onPronto(resultado)}>Ficou boa ✓</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" onClick={() => {
              // No meio da captura, Cancelar só para e volta pro começo.
              if (fase === 'capturando') { capturaRef.current++; tirarDeNovo() } else onCancelar()
            }}>{fase === 'capturando' ? 'Parar' : 'Cancelar'}</button>
            <button type="button" className="btn btn-secondary ac-botao-camera" title="Trocar entre a câmera da frente e a de trás"
              disabled={fase === 'capturando'}
              onClick={() => {
                const nova = camera === 'environment' ? 'user' : 'environment'
                guardarCamera(nova)
                setCamera(nova)
              }}>🔄 {camera === 'environment' ? 'Trás' : 'Frente'}</button>
            <button type="button" className="btn btn-primary" onClick={capturar} disabled={fase !== 'pronto'}>
              {fase === 'capturando' ? 'Capturando...' : '📷 Capturar rosto'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}


function esperar(ms) { return new Promise(r => setTimeout(r, ms)) }
