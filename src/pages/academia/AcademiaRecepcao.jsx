import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import {
  carregarFaceApi, lerRosto, ligarCamera, desligarCamera, acharAluno, situacaoAluno,
  entrarTelaCheia, sairTelaCheia, lerOlhos, criarDetectorPiscada, GIRO_LADO,
} from '../../lib/reconhecimentoFacial'
import { liberarCatraca } from '../../lib/catracaSerial'

// Tablet da recepção (academia.fwcinter.com/recepcao).
// A câmera fica ligada; quando reconhece um aluno mostra foto, nome e se está
// em dia, e anota a entrada. A catraca por enquanto abre no botão manual —
// quem está na recepção olha a tela e libera.

const CONFIRMAR_LEITURAS = 2     // mesma pessoa em 2 leituras seguidas antes de mostrar
const DESCONHECIDO_LEITURAS = 4  // rosto sem cadastro por 4 leituras → "não reconhecido"
const MOSTRAR_MS = 5000          // quanto tempo o cartão fica na tela
const NAO_REGISTRAR_DE_NOVO_MS = 3 * 60 * 1000 // mesma pessoa não conta 2 entradas em 3 min
const RECARREGAR_ALUNOS_MS = 60 * 1000
// Prova de vida: depois de reconhecer, pede pra virar o rosto. Vale se o
// giro MUDAR (foto parada não muda, nem uma foto já de lado). Piscar também
// conta quando o modelo consegue ver (criarDetectorPiscada).
const PISCAR_PRAZO_MS = 8000
const CHAVE_PISCAR = 'academia_exigir_piscar'

function lerExigirPiscar() {
  try { return localStorage.getItem(CHAVE_PISCAR) !== 'nao' } catch { return true }
}

export default function AcademiaRecepcao() {
  const { empresa } = useAuth()
  const videoRef = useRef(null)
  const alunosRef = useRef([])
  const [iniciado, setIniciado] = useState(false)
  const [estado, setEstado] = useState({ fase: 'parado', msg: '' })
  const [cartao, setCartao] = useState(null) // { aluno, situacao } | { desconhecido: true }
  const [ultimas, setUltimas] = useState([])
  const [qtdAlunos, setQtdAlunos] = useState(0)
  const [exigirPiscar, setExigirPiscar] = useState(lerExigirPiscar)
  const [pedindoPiscar, setPedindoPiscar] = useState(null) // { nome, demorou }

  function trocarPiscar(v) {
    setExigirPiscar(v)
    try { localStorage.setItem(CHAVE_PISCAR, v ? 'sim' : 'nao') } catch { /* só não lembra */ }
  }

  async function carregarAlunos() {
    const { data } = await supabase
      .from('academia_alunos')
      .select('id, nome, foto, plano, vencimento, ativo, descritores')
      .eq('empresa_id', empresa.id)
    alunosRef.current = (data || []).filter(a => a.descritores?.length)
    setQtdAlunos(alunosRef.current.length)
  }

  useEffect(() => {
    if (!iniciado) return
    let vivo = true
    let stream = null
    let wakeLock = null
    let timerCartao = null
    const vistosEm = new Map() // aluno_id → última entrada registrada
    let candidato = null
    let seguidas = 0
    let desconhecidas = 0
    let cartaoAte = 0
    let cartaoAtualId = null
    let semRosto = 0
    // Enquanto espera a prova de vida: { achado, inicio, piscou, giro0 }.
    // Nessa fase o laço só lê os pontos do rosto (rápido); a pessoa já foi
    // reconhecida antes de entrar aqui.
    let piscar = null

    function pedirPiscar(achado, demorou = false) {
      piscar = { achado, inicio: Date.now(), piscou: criarDetectorPiscada(), giro0: null }
      setPedindoPiscar({ nome: achado.aluno.nome.split(' ')[0], demorou })
    }

    function liberarResultado(achado) {
      piscar = null
      setPedindoPiscar(null)
      const situacao = situacaoAluno(achado.aluno)
      cartaoAtualId = achado.aluno.id
      mostrar({ aluno: achado.aluno, situacao })
      bipe(situacao.status === 'liberado')
      // PC com a catraca ligada (configurada em /catraca): abre sozinha.
      if (situacao.status === 'liberado') liberarCatraca().catch(() => {})
      registrar(achado.aluno, situacao, achado.distancia)
    }

    function mostrar(c) {
      setCartao(c)
      cartaoAte = Date.now() + MOSTRAR_MS
      clearTimeout(timerCartao)
      timerCartao = setTimeout(() => setCartao(null), MOSTRAR_MS)
    }

    async function registrar(aluno, situacao, distancia) {
      const agora = Date.now()
      if (agora - (vistosEm.get(aluno.id) || 0) < NAO_REGISTRAR_DE_NOVO_MS) return
      vistosEm.set(aluno.id, agora)
      setUltimas(u => [{ id: agora, nome: aluno.nome, foto: aluno.foto, status: situacao.status, hora: new Date() }, ...u].slice(0, 6))
      await supabase.from('academia_acessos').insert({
        empresa_id: empresa.id, aluno_id: aluno.id, resultado: situacao.status, distancia: Number(distancia.toFixed(3)),
      })
    }

    async function laco() {
      while (vivo) {
        const video = videoRef.current
        if (!video || video.readyState < 2) { await esperar(200); continue }

        // Fase da prova de vida: leitura rápida, sem pausa.
        if (piscar) {
          const o = await lerOlhos(video).catch(() => null)
          if (!vivo) break
          if (!o) {
            // Saiu da frente da câmera: cancela o pedido.
            if (++semRosto >= 15) { piscar = null; setPedindoPiscar(null) }
          } else {
            semRosto = 0
            if (piscar.giro0 === null) piscar.giro0 = o.giro
            // Virou o rosto de verdade (mexeu desde o pedido) ou piscou.
            const virou = Math.abs(o.giro) > GIRO_LADO && Math.abs(o.giro - piscar.giro0) > GIRO_LADO
            if (virou || piscar.piscou(o.olhos)) liberarResultado(piscar.achado)
            else if (Date.now() - piscar.inicio > PISCAR_PRAZO_MS) pedirPiscar(piscar.achado, true)
          }
          await esperar(0)
          continue
        }

        const r = await lerRosto(video).catch(() => null)
        if (!vivo) break
        if (!r) {
          candidato = null; seguidas = 0; desconhecidas = 0
          await esperar(250)
          continue
        }
        semRosto = 0
        const achado = acharAluno(r.descritor, alunosRef.current)
        if (achado) {
          desconhecidas = 0
          if (candidato === achado.aluno.id) seguidas++
          else { candidato = achado.aluno.id; seguidas = 1 }
          const jaNaTela = cartaoAtualId === achado.aluno.id && Date.now() < cartaoAte - 1000
          if (seguidas >= CONFIRMAR_LEITURAS && !jaNaTela) {
            // Prova de vida: antes de mostrar o resultado, a pessoa vira o rosto.
            if (exigirPiscar) pedirPiscar(achado)
            else liberarResultado(achado)
          }
        } else {
          candidato = null; seguidas = 0
          desconhecidas++
          if (desconhecidas === DESCONHECIDO_LEITURAS && Date.now() > cartaoAte) {
            cartaoAtualId = null
            mostrar({ desconhecido: true })
            bipe(false)
          }
        }
        await esperar(150)
      }
    }

    ;(async () => {
      try {
        setEstado({ fase: 'carregando', msg: 'Baixando o reconhecimento...' })
        await Promise.all([carregarFaceApi(), carregarAlunos()])
        if (!vivo) return
        setEstado({ fase: 'carregando', msg: 'Ligando a câmera...' })
        stream = await ligarCamera(videoRef.current)
        if (!vivo) return desligarCamera(stream)
        try { wakeLock = await navigator.wakeLock?.request('screen') } catch { /* sem wake lock, segue */ }
        setEstado({ fase: 'rodando', msg: '' })
        laco()
      } catch (e) {
        setEstado({ fase: 'erro', msg: e.name === 'NotAllowedError' ? 'A câmera foi bloqueada. Libere nas permissões do Safari/Chrome e recarregue.' : e.message })
      }
    })()

    const recarga = setInterval(carregarAlunos, RECARREGAR_ALUNOS_MS)
    return () => {
      vivo = false
      clearInterval(recarga)
      clearTimeout(timerCartao)
      desligarCamera(stream)
      wakeLock?.release?.().catch(() => {})
      sairTelaCheia()
    }
  }, [iniciado, empresa.id, exigirPiscar]) // eslint-disable-line react-hooks/exhaustive-deps

  function comecar() {
    destravarSom()
    entrarTelaCheia()
    setIniciado(true)
  }

  if (!iniciado) {
    return (
      <div className="ac-rec ac-rec-inicio">
        <div className="ac-logo">🏋️</div>
        <h1>{empresa?.nome}</h1>
        <p>Tela da recepção. Deixe o tablet de pé, com a câmera na altura do rosto.</p>
        <label className="ac-rec-opcao">
          <input type="checkbox" checked={exigirPiscar} onChange={e => trocarPiscar(e.target.checked)} />
          Pedir pra virar o rosto (não deixa passar com foto do aluno no celular)
        </label>
        <button className="btn btn-primary ac-rec-comecar" onClick={comecar}>Começar</button>
        <Link to="/" className="ac-rec-voltar">← Voltar pros alunos</Link>
      </div>
    )
  }

  return (
    <div className="ac-rec">
      <div className="ac-rec-video-caixa">
        <video ref={videoRef} className="ac-video" playsInline muted />
        {estado.fase !== 'rodando' && (
          <div className="ac-rec-overlay"><p className={estado.fase === 'erro' ? 'ac-erro' : ''}>{estado.msg}</p></div>
        )}
        {estado.fase === 'rodando' && !cartao && !pedindoPiscar && (
          <div className="ac-rec-dica">Olhe para a câmera</div>
        )}
        {estado.fase === 'rodando' && !cartao && pedindoPiscar && (
          <div className="ac-rec-piscar">
            <div className="ac-rec-piscar-olho">↔️</div>
            <strong>Olá, {pedindoPiscar.nome}!</strong>
            <span>{pedindoPiscar.demorou ? 'Vire o rosto devagar pro lado' : 'Vire o rosto pro lado'}</span>
          </div>
        )}
        {cartao && <CartaoAcesso cartao={cartao} />}
      </div>

      <aside className="ac-rec-lado">
        <div className="ac-rec-titulo">
          <strong>Últimas entradas</strong>
          <span className="ac-muted">{qtdAlunos} rosto{qtdAlunos === 1 ? '' : 's'}</span>
        </div>
        {ultimas.length === 0 && <p className="ac-muted">Ninguém ainda.</p>}
        {ultimas.map(u => (
          <div key={u.id} className="ac-rec-ultima">
            {u.foto ? <img src={u.foto} alt="" /> : <div className="ac-foto ac-foto-vazia">?</div>}
            <div>
              <div>{u.nome}</div>
              <small className={`ac-status ac-${u.status}`}>
                {u.hora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · {u.status === 'liberado' ? 'liberado' : u.status}
              </small>
            </div>
          </div>
        ))}
        <Link to="/" className="ac-rec-voltar">← Alunos</Link>
      </aside>
    </div>
  )
}

function CartaoAcesso({ cartao }) {
  if (cartao.desconhecido) {
    return (
      <div className="ac-rec-cartao ac-rec-desconhecido">
        <div className="ac-rec-icone">?</div>
        <h2>Não reconhecido</h2>
        <p>Procure a recepção</p>
      </div>
    )
  }
  const { aluno, situacao } = cartao
  const ok = situacao.status === 'liberado'
  return (
    <div className={`ac-rec-cartao ${ok ? 'ac-rec-ok' : 'ac-rec-bloqueado'}`}>
      {aluno.foto && <img src={aluno.foto} alt="" />}
      <h2>{aluno.nome.split(' ')[0]}</h2>
      <div className="ac-rec-resultado">{ok ? '✅ LIBERADO' : '❌ ' + (situacao.status === 'inativo' ? 'INATIVO' : 'VENCIDO')}</div>
      <p>{situacao.texto}</p>
    </div>
  )
}

function esperar(ms) { return new Promise(r => setTimeout(r, ms)) }

// Som: o iPad só toca depois de um toque na tela, por isso o botão Começar
// "destrava" o áudio.
let audioCtx = null
function destravarSom() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
    audioCtx.resume()
  } catch { audioCtx = null }
}
function bipe(ok) {
  if (!audioCtx) return
  try {
    const notas = ok ? [880, 1320] : [300, 220]
    notas.forEach((f, i) => {
      const o = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      o.frequency.value = f
      o.connect(g); g.connect(audioCtx.destination)
      const t = audioCtx.currentTime + i * 0.15
      g.gain.setValueAtTime(0.2, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
      o.start(t); o.stop(t + 0.15)
    })
  } catch { /* sem som, segue */ }
}
