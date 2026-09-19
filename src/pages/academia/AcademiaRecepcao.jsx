import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import {
  carregarFaceApi, lerRosto, ligarCamera, desligarCamera, acharAluno, situacaoAluno,
  entrarTelaCheia, sairTelaCheia,
} from '../../lib/reconhecimentoFacial'

// Tablet da recepção (academia.fwcinter.com/recepcao).
// A câmera fica ligada; quando reconhece um aluno mostra foto, nome e se está
// em dia, e anota a entrada. A catraca por enquanto abre no botão manual —
// quem está na recepção olha a tela e libera.

const CONFIRMAR_LEITURAS = 2     // mesma pessoa em 2 leituras seguidas antes de mostrar
const DESCONHECIDO_LEITURAS = 4  // rosto sem cadastro por 4 leituras → "não reconhecido"
const MOSTRAR_MS = 5000          // quanto tempo o cartão fica na tela
const NAO_REGISTRAR_DE_NOVO_MS = 3 * 60 * 1000 // mesma pessoa não conta 2 entradas em 3 min
const RECARREGAR_ALUNOS_MS = 60 * 1000
// Prova de vida (piscar): olho abaixo de 75% do aberto = fechou; volta acima
// de 88% = abriu. Uma foto mostrada no celular nunca faz isso.
const PISCOU_FECHADO = 0.75
const PISCOU_ABERTO = 0.88
const PISCAR_PRAZO_MS = 6000
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
    let piscar = null // { alunoId, inicio, base, fechou } enquanto espera a piscada

    // Olho aberto → fechado → aberto de novo = piscou. A "base" é o olho
    // aberto dessa pessoa (cada um tem um tamanho), medida enquanto espera.
    function provouVida(aluno, olhos) {
      const agora = Date.now()
      if (!piscar || piscar.alunoId !== aluno.id) {
        piscar = { alunoId: aluno.id, inicio: agora, base: olhos, fechou: false }
        setPedindoPiscar({ nome: aluno.nome.split(' ')[0], demorou: false })
        return false
      }
      if (!piscar.fechou) piscar.base = Math.max(piscar.base * 0.97, olhos)
      if (olhos < piscar.base * PISCOU_FECHADO) piscar.fechou = true
      else if (piscar.fechou && olhos > piscar.base * PISCOU_ABERTO) return true
      if (agora - piscar.inicio > PISCAR_PRAZO_MS) {
        // Não viu a piscada: pede de novo, mais devagar.
        piscar = { alunoId: aluno.id, inicio: agora, base: olhos, fechou: false }
        setPedindoPiscar({ nome: aluno.nome.split(' ')[0], demorou: true })
      }
      return false
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
        const r = await lerRosto(video).catch(() => null)
        if (!vivo) break
        if (!r) {
          candidato = null; seguidas = 0; desconhecidas = 0
          semRosto++
          // Saiu da frente da câmera: cancela o "pisque".
          if (piscar && semRosto >= 6) { piscar = null; setPedindoPiscar(null) }
          await esperar(piscar ? 40 : 250)
          continue
        }
        semRosto = 0
        const achado = acharAluno(r.descritor, alunosRef.current)
        // Com o olho fechado a leitura às vezes não bate com ninguém: durante
        // o "pisque", uma leitura dessas conta como a mesma pessoa.
        if (!achado && piscar && r.olhos < piscar.base * PISCOU_FECHADO) {
          piscar.fechou = true
          await esperar(40)
          continue
        }
        if (achado) {
          desconhecidas = 0
          if (candidato === achado.aluno.id) seguidas++
          else { candidato = achado.aluno.id; seguidas = 1 }
          const jaNaTela = cartaoAtualId === achado.aluno.id && Date.now() < cartaoAte - 1000
          if (seguidas >= CONFIRMAR_LEITURAS && !jaNaTela) {
            // Prova de vida: antes de mostrar o resultado, a pessoa pisca.
            if (exigirPiscar && !provouVida(achado.aluno, r.olhos)) {
              await esperar(40)
              continue
            }
            piscar = null
            setPedindoPiscar(null)
            const situacao = situacaoAluno(achado.aluno)
            cartaoAtualId = achado.aluno.id
            mostrar({ aluno: achado.aluno, situacao })
            bipe(situacao.status === 'liberado')
            registrar(achado.aluno, situacao, achado.distancia)
          }
        } else {
          candidato = null; seguidas = 0
          desconhecidas++
          if (desconhecidas === DESCONHECIDO_LEITURAS && Date.now() > cartaoAte) {
            piscar = null
            setPedindoPiscar(null)
            cartaoAtualId = null
            mostrar({ desconhecido: true })
            bipe(false)
          }
        }
        await esperar(piscar ? 40 : 150)
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
          Pedir pra piscar os olhos (não deixa passar com foto do aluno no celular)
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
            <div className="ac-rec-piscar-olho">👁️</div>
            <strong>Olá, {pedindoPiscar.nome}!</strong>
            <span>{pedindoPiscar.demorou ? 'Pisque devagar, olhando pra câmera' : 'Pisque os olhos'}</span>
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
