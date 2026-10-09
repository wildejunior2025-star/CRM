import { useEffect, useRef, useState } from 'react'
import {
  carregarFaceApi, lerRosto, ligarCamera, desligarCamera, miniaturaDoRosto, acharAluno,
  sairTelaCheia, GIRO_LADO, cameraPadrao, guardarCamera,
} from '../../lib/reconhecimentoFacial'

// Captura do rosto numa tacada: enquadra de frente e aperta Capturar.
//
// Antes a tela pedia pra virar o rosto pra um lado e pro outro. Isso existia
// pra o aluno se cadastrar sozinho no celular dele. Quem cadastra é a
// recepção, com a câmera de trás apontada pro aluno — pedir pra virar só
// atrasava a fila. Agora pega as amostras de frente mesmo, uma atrás da
// outra, e o aluno nem percebe.

const AMOSTRAS = 4
const PAUSA = 150 // ms entre uma amostra e a outra, pra não pegar o mesmo quadro

export default function CapturaRosto({ alunos, onPronto, onCancelar }) {
  const videoRef = useRef(null)
  const [fase, setFase] = useState('carregando') // carregando | pronto | capturando | revisar | erro
  const [msg, setMsg] = useState('Preparando a câmera...')
  const [feitas, setFeitas] = useState(0)
  const [resultado, setResultado] = useState(null) // { descritores, foto } esperando o "ficou boa?"
  // Câmera de TRÁS por padrão no celular: resolução melhor e quem tira a foto
  // é a recepção, não o aluno.
  const [camera, setCamera] = useState(cameraPadrao)
  const [diag, setDiag] = useState('')   // por que a captura nao anda
  const [tentativa, setTentativa] = useState(0) // "Tentar de novo" sem recarregar a pagina
  const capturaRef = useRef(0) // muda a cada captura; captura antiga que ainda estiver rodando para sozinha

  useEffect(() => {
    let stream = null
    let vivo = true
    ;(async () => {
      try {
        setFase('carregando')
        setMsg('Baixando o reconhecimento (só na primeira vez)...')
        await carregarFaceApi(passo => { if (vivo) setMsg(passo) })
        if (!vivo) return
        stream = await ligarCamera(videoRef.current, { camera })
        if (!vivo) return desligarCamera(stream)
        setFase('pronto')
        setMsg('Enquadre o rosto do aluno de frente e aperte Capturar.')
      } catch (e) {
        setFase('erro')
        setMsg(e.name === 'NotAllowedError' ? 'A câmera foi bloqueada. Libere nas permissões do navegador.' : e.message)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- é um contador, não um nó
    return () => { vivo = false; capturaRef.current++; desligarCamera(stream); sairTelaCheia() }
  }, [camera, tentativa])

  // Pega AMOSTRAS leituras boas de frente. Não pula por tempo: se o rosto
  // sair do enquadramento ela espera ali, e quem desistir aperta Parar.
  async function capturar() {
    setFase('capturando')
    setFeitas(0)
    const minha = ++capturaRef.current
    const cancelou = () => capturaRef.current !== minha
    const descritores = []
    let foto
    let voltas = 0   // so pra saber se empacou

    while (descritores.length < AMOSTRAS && !cancelou()) {
      voltas++
      const t0 = performance.now()
      let falha = null
      const r = await lerRosto(videoRef.current).catch(e => { falha = e; return null })
      if (cancelou()) return
      // Linha de diagnóstico: quando a captura não anda, é ela que diz por quê.
      const v = videoRef.current
      if (descritores.length === 0 && voltas > 25) setDiag([
        `${Math.round(performance.now() - t0)} ms`,
        window.faceapi?.tf?.getBackend?.() || '?',
        v ? `${v.videoWidth}x${v.videoHeight}` : 'sem vídeo',
        r ? `rosto ${Math.round(r.caixa.width)}px · giro ${r.giro.toFixed(2)}` : 'sem rosto',
        falha ? `ERRO: ${falha.message}` : '',
      ].filter(Boolean).join(' · '))
      if (!r) { setMsg('Não estou vendo o rosto — aproxime a câmera'); await esperar(120); continue }
      if (r.quantos > 1) { setMsg('Tem mais de uma pessoa na câmera'); await esperar(300); continue }
      // Rosto muito de lado não serve de digital: pede pra endireitar.
      if (Math.abs(r.giro) >= GIRO_LADO) { setMsg('Rosto de frente pra câmera'); await esperar(120); continue }

      if (!foto) foto = miniaturaDoRosto(videoRef.current, r.caixa, 280)
      descritores.push(Array.from(r.descritor))
      setFeitas(descritores.length)
      setMsg('Segure assim...')
      await esperar(PAUSA)
    }
    if (cancelou()) return

    // Já é outro aluno? Evita cadastrar a mesma pessoa duas vezes.
    const repetido = acharAluno(descritores[0], alunos)
    if (repetido && !window.confirm(`Esse rosto parece com ${repetido.aluno.nome}, que já está cadastrado. Salvar assim mesmo?`)) {
      tirarDeNovo()
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
    setMsg('Enquadre o rosto do aluno de frente e aperte Capturar.')
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
        {fase === 'capturando' && diag && <div className="ac-captura-diag">{diag}</div>}
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
            {fase === 'erro' ? (
              <button type="button" className="btn btn-primary" onClick={() => setTentativa(n => n + 1)}>
                Tentar de novo
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={capturar} disabled={fase !== 'pronto'}>
                {fase === 'capturando' ? 'Capturando...' : '📷 Capturar rosto'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}


function esperar(ms) { return new Promise(r => setTimeout(r, ms)) }
