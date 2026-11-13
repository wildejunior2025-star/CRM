import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import {
  carregarFaceApi, lerRosto, ligarCamera, desligarCamera, acharAluno, situacaoAluno,
  entrarTelaCheia, sairTelaCheia, rostoInteiroNaTela, aliviarDetector, detectorAtual, acharRostos,
  GIRO_LADO,
} from '../../lib/reconhecimentoFacial'
import { liberarCatraca, conectarCatraca, fecharPorta, serialSuportado } from '../../lib/catracaSerial'

// Tablet da recepção (academia.fwcinter.com/recepcao).
// A câmera fica ligada; quando reconhece um aluno mostra foto, nome e se está
// em dia, e anota a entrada. A catraca por enquanto abre no botão manual —
// quem está na recepção olha a tela e libera.

// 08/10/2026: o sistema liberou a pessoa errada (uma visitante bateu 0,481
// com uma aluna, com o limite em 0,5 e 2 leituras). Daí os números abaixo
// ficarem apertados — e o aprendizado automático, que gravava a leitura da
// catraca na ficha do aluno, foi tirado: era ele que gravava o rosto errado.
// Quantas leituras seguidas exigir antes de liberar. Era 3 pra todo mundo, e
// 3 leituras e o tempo que o aluno passa PARADO na frente da camera.
//
// Medido nos 2.890 acessos ja registrados: a distancia mediana e 0,348, e
// 57% das leituras ficam abaixo de 0,36. O unico caso de pessoa errada que
// ja aconteceu aqui bateu 0,481 — longe. Entao quem chega bem abaixo do
// limite, e com o segundo colocado bem atras, nao precisa de 3 provas:
//   ate 0,36 com margem folgada → 1 leitura  (reconhece andando)
//   ate 0,41                    → 2 leituras
//   ate 0,44 (o limite)         → 3 leituras
const CERTEZA_ALTA = 0.36        // abaixo disso, e com margem, uma leitura basta
const CERTEZA_BOA = 0.41         // abaixo disso, duas
const MARGEM_SEGURA = 0.08       // o segundo colocado tem que estar bem atras
const CONFIRMAR_LEITURAS = 3     // o caso mais apertado, encostado no limite
const LEITURA_LENTA_MS = 330      // acima disso o detector baixa pra nao deixar o aluno esperando
// De quanto em quanto tempo tenta religar a catraca sozinha. Eram 20 s, e
// nesses 20 s o aluno ficava parado na porta sem ninguem entender por que.
const RELIGAR_MS = 4000
const DESCONHECIDO_LEITURAS = 4  // rosto sem cadastro por 4 leituras → "não reconhecido"
const MOSTRAR_MS = 5000          // quanto tempo o cartão fica na tela
const NAO_REGISTRAR_DE_NOVO_MS = 3 * 60 * 1000 // mesma pessoa não conta 2 entradas em 3 min
const RECARREGAR_ALUNOS_MS = 60 * 1000

// Prova de vida (pedir pra virar o rosto antes de liberar) FOI TIRADA em
// 08/10, a pedido do dono: lá ninguém vai tentar entrar mostrando a foto de
// outra pessoa no celular, e o pedido atrasava a entrada de todo mundo.
// Reconheceu, libera.

export default function AcademiaRecepcao() {
  const { empresa } = useAuth()
  const videoRef = useRef(null)
  const alunosRef = useRef([])
  const [iniciado, setIniciado] = useState(false)
  const [estado, setEstado] = useState({ fase: 'parado', msg: '' })
  const [cartao, setCartao] = useState(null) // { aluno, situacao } | { desconhecido: true }
  const [ultimas, setUltimas] = useState([])
  const [qtdAlunos, setQtdAlunos] = useState(0)
  // Diagnóstico: quanto leva cada leitura neste aparelho e a última semelhança.
  const [diag, setDiag] = useState({})
  // Guardados em ref (e nao em estado) porque quem grava o acesso roda dentro
  // do laco da camera e nao enxerga o estado novo.
  const msRef = useRef(null)
  const motorRef = useRef(null)
  const [ajuste, setAjuste] = useState(null) // pedido pra centralizar o rosto
  // Catraca ligada neste PC: null = não usa (tablet), 'ok', 'abrindo' ou o texto do erro.
  // Tudo automático — a academia funciona sem ninguém na recepção.
  const [catraca, setCatracaEstado] = useState(null)
  // Tem computador com a tela "Porta" aberta e pronto? Null = ainda nao sei.
  const [portaLigada, setPortaLigadaEstado] = useState(null)
  const portaLigadaRef = useRef(null)
  const setPortaLigada = v => { portaLigadaRef.current = v; setPortaLigadaEstado(v) }
  const catracaRef = useRef(null)
  const setCatraca = v => { catracaRef.current = v; setCatracaEstado(v) }

  // Este aparelho fala direto com a catraca? Só o computador ligado nela fala.
  // Celular e tablet avisam o computador que está com a tela /porta aberta.
  const localRef = useRef(false)
  // Este computador JÁ conseguiu abrir a catraca alguma vez? Então ele é o da
  // catraca, e uma falha solta não muda isso — tem que insistir nele.
  const ehOComputadorDaCatraca = useRef(false)
  const abrindoRef = useRef(false)
  const canalPorta = useRef(null)

  // Religa a porta serial. Usada pelo laço automático, pelo botão da tela e
  // logo depois de uma falha — sem esperar a próxima rodada.
  const religandoRef = useRef(false)
  async function religarCatraca() {
    if (religandoRef.current || !serialSuportado()) return
    religandoRef.current = true
    setCatraca('religando')
    try {
      await fecharPorta()
      await conectarCatraca()
      localRef.current = true
      ehOComputadorDaCatraca.current = true
      setCatraca('ok')
    } catch (e) {
      setCatraca(e.message)
    } finally {
      religandoRef.current = false
    }
  }

  async function abrirCatraca(aluno) {
    // Pulso dura 3 s. Dois pedidos em cima do outro atrapalhavam o sinal e
    // derrubavam a porta — o segundo espera a próxima vez.
    if (abrindoRef.current) return
    if (!localRef.current) return avisarPorta(aluno)
    abrindoRef.current = true
    setCatraca('abrindo')
    try {
      await liberarCatraca()
      setCatraca('ok')
    } catch {
      // Porta caiu (cabo mexido, Windows dormiu): fecha, reabre e tenta de novo.
      try {
        await fecharPorta()
        await liberarCatraca()
        setCatraca('ok')
      } catch (e) {
        // Nem assim. Mostra o erro de VERDADE na tela e avisa o canal como
        // reserva. `localRef` cai só até o laço de reconexão consertar — antes
        // isso era definitivo e a catraca nunca mais abria neste computador,
        // enquanto a tela dizia "catraca pelo computador" como se tudo bem.
        localRef.current = false
        setCatraca(e.message || 'Não consegui abrir a catraca.')
        // Religa JA, sem esperar a proxima rodada do laço: era isso que
        // deixava o aluno parado na porta por 20 segundos.
        if (ehOComputadorDaCatraca.current) setTimeout(religarCatraca, 300)
        if (canalPorta.current) {
          canalPorta.current.send({
            type: 'broadcast', event: 'liberar',
            payload: { nome: aluno?.nome, aluno_id: aluno?.id },
          })
        }
      }
    } finally {
      abrindoRef.current = false
    }
  }

  // Aviso pro computador da catraca (tela /porta).
  function avisarPorta(aluno) {
    const canal = canalPorta.current
    if (!canal) return setCatraca('Sem ligação com o computador da catraca. Abra a tela "Porta" no computador.')
    setCatraca('abrindo')
    canal.send({ type: 'broadcast', event: 'liberar', payload: { nome: aluno?.nome, aluno_id: aluno?.id } })
      .then(() => {
        // Mandar o aviso dá "certo" mesmo quando não tem ninguém escutando.
        // Só diz que foi pro computador se o computador se anunciou.
        setCatraca(portaLigadaRef.current
          ? 'pc'
          : 'Ninguém com a tela "Porta" aberta no computador da catraca.')
      }, e => setCatraca('Não avisei o computador: ' + e.message))
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
    let tempos = []
    let resMostrada = false
    // Quando a triagem barata esta ligada. Comeca ligada: sala vazia.
    let triagem = true

    function liberarResultado(achado, leituras) {
      const situacao = situacaoAluno(achado.aluno)
      cartaoAtualId = achado.aluno.id
      // A catraca ANTES do desenho da tela: abrir e o que o aluno espera, e
      // montar o cartao com foto custa alguns quadros.
      if (situacao.status === 'liberado') abrirCatraca(achado.aluno)
      mostrar({ aluno: achado.aluno, situacao })
      bipe(situacao.carencia ? 'aviso' : situacao.status === 'liberado' ? 'ok' : 'nao')
      registrar(achado.aluno, situacao, achado, leituras)
    }

    function mostrar(c) {
      setCartao(c)
      cartaoAte = Date.now() + MOSTRAR_MS
      clearTimeout(timerCartao)
      timerCartao = setTimeout(() => setCartao(null), MOSTRAR_MS)
    }

    async function registrar(aluno, situacao, achado, leituras) {
      const agora = Date.now()
      if (agora - (vistosEm.get(aluno.id) || 0) < NAO_REGISTRAR_DE_NOVO_MS) return
      vistosEm.set(aluno.id, agora)
      setUltimas(u => [{ id: agora, nome: aluno.nome, foto: aluno.foto, status: situacao.status, hora: new Date() }, ...u].slice(0, 6))
      await supabase.from('academia_acessos').insert({
        empresa_id: empresa.id, aluno_id: aluno.id, resultado: situacao.status,
        distancia: Number(achado.distancia.toFixed(3)),
        // Guardado pra dar pra ajustar a velocidade sem ir ate a academia:
        // quanto o segundo colocado ficou atras, quanto tempo leva uma
        // leitura neste computador e se ele usa placa de video ou nao.
        margem: achado.margem != null && achado.margem !== Infinity ? Number(achado.margem.toFixed(3)) : null,
        ms: msRef.current || null,
        leituras,
        motor: motorRef.current || null,
      })
    }

    async function laco() {
      while (vivo) {
        const video = videoRef.current
        if (!video || video.readyState < 2) { await esperar(200); continue }
        // Quanto a webcam REALMENTE entrega. Pedimos 1280x960, mas câmera
        // velha costuma dar menos — e é esse número que limita tudo.
        if (!resMostrada) { resMostrada = true; setDiag(d => ({ ...d, res: `${video.videoWidth}x${video.videoHeight}` })) }

        // ETAPA BARATA: só procura a caixa do rosto, sem tirar a digital.
        // Serve pra quem está CHEGANDO — longe, de lado, meio fora do quadro.
        //
        // Mas ela só vale a pena nessa situação: achar o rosto custa o mesmo
        // nas duas etapas, então, com o aluno já na posição, fazer as duas é
        // procurar o rosto DUAS VEZES no mesmo quadro — era quase metade do
        // tempo que o aluno passava parado esperando. Agora a triagem só
        // acontece depois de um quadro em que o rosto apareceu mal
        // posicionado; no resto do tempo vai direto pra leitura.
        if (triagem) {
          const vistos = await acharRostos(video).catch(() => null)
          if (!vivo) break
          if (!vistos || !vistos.maior) {
            candidato = null; seguidas = 0; desconhecidas = 0
            triagem = false
            setAjuste(null)
            await esperar(250)
            continue
          }
          if (!rostoInteiroNaTela(vistos.maior, video)) {
            candidato = null; seguidas = 0
            setAjuste('Chegue mais perto, com o rosto no meio da tela')
            await esperar(40)
            continue
          }
        }

        // ETAPA CARA: agora sim vale a pena tirar a digital deste rosto.
        const t0 = performance.now()
        const r = await lerRosto(video).catch(() => null)
        if (!vivo) break
        tempos.push(performance.now() - t0)
        if (tempos.length >= 10) {
          const media = tempos.reduce((a, b) => a + b, 0) / tempos.length
          // Leitura passando de 1/3 de segundo é lenta pra quem está na porta:
          // o aluno fica esperando. Alivia o detector uma vez e segue.
          if (media > LEITURA_LENTA_MS) aliviarDetector()
          const motor = window.faceapi?.tf?.getBackend?.()
          msRef.current = Math.round(media)
          motorRef.current = motor ? `${motor} ${detectorAtual()}` : null
          setDiag(d => ({ ...d, ms: Math.round(media), detector: detectorAtual(), backend: motor }))
          tempos = []
        }
        // Sem rosto nenhum: volta pra triagem, que é o modo de sala vazia.
        if (!r) {
          candidato = null; seguidas = 0; desconhecidas = 0
          triagem = true
          setAjuste(null)
          await esperar(120)
          continue
        }
        // Rosto fora de posição (longe, na beirada): daqui pra frente a
        // triagem barata segura, até ele chegar na posição.
        if (!rostoInteiroNaTela(r.caixa, video)) {
          candidato = null; seguidas = 0
          triagem = true
          setAjuste('Chegue mais perto, com o rosto no meio da tela')
          await esperar(30)
          continue
        }
        triagem = false
        setAjuste(null)

        // Rosto virado nao vale como leitura. O cadastro ja recusa amostra de
        // lado pelo mesmo motivo: de lado a digital do rosto sai torta e pode
        // cair perto de qualquer um. Foi o que liberou a pessoa errada em
        // 13/11. Aqui nao zera o contador — so nao conta, e tenta de novo.
        if (Math.abs(r.giro) > GIRO_LADO) {
          setAjuste('Olhe pra câmera')
          await esperar(0)
          continue
        }

        const achado = acharAluno(r.descritor, alunosRef.current)
        if (achado) {
          setDiag(d => ({ ...d, dist: achado.distancia, margem: achado.margem }))
          desconhecidas = 0
          if (candidato === achado.aluno.id) seguidas++
          else { candidato = achado.aluno.id; seguidas = 1 }
          const jaNaTela = cartaoAtualId === achado.aluno.id && Date.now() < cartaoAte - 1000
          const precisa = achado.distancia < CERTEZA_ALTA && achado.margem >= MARGEM_SEGURA ? 1
            : achado.distancia < CERTEZA_BOA ? 2
              : CONFIRMAR_LEITURAS
          if (seguidas >= precisa && !jaNaTela) liberarResultado(achado, seguidas)
        } else {
          candidato = null; seguidas = 0
          desconhecidas++
          if (desconhecidas === DESCONHECIDO_LEITURAS && Date.now() > cartaoAte) {
            cartaoAtualId = null
            // Sem som aqui, de proposito. Rosto desconhecido e quase sempre
            // quem passou na frente da camera sem querer entrar: visita,
            // entregador, o proprio aluno de costas. O bipe grave de barrado
            // tocava a toa e assustava quem nem estava usando a catraca. O
            // aviso continua na tela, que e pra recepcao ver.
            mostrar({ desconhecido: true })
          }
        }
        // Já reconheceu alguém e está só confirmando? Emenda a próxima
        // leitura sem pausa — é esse pedaço que o aluno sente como demora.
        await esperar(candidato ? 0 : 60)
      }
    }

    ;(async () => {
      try {
        setEstado({ fase: 'carregando', msg: 'Baixando o reconhecimento...' })
        await Promise.all([
          carregarFaceApi(passo => vivo && setEstado({ fase: 'carregando', msg: passo })),
          carregarAlunos(),
        ])
        if (!vivo) return
        setEstado({ fase: 'carregando', msg: 'Ligando a câmera...' })
        stream = await ligarCamera(videoRef.current)
        if (!vivo) return desligarCamera(stream)
        try { wakeLock = await navigator.wakeLock?.request('screen') } catch { /* sem wake lock, segue */ }
        setEstado({ fase: 'rodando', msg: '' })
        // Liga SEMPRE no canal do computador da catraca (tela /porta): é por ele
        // que o celular manda abrir. O canal também é a reserva do próprio PC.
        const canal = supabase.channel(`catraca-${empresa.id}`, { config: { presence: {} } })
        // Tem um computador com a tela "Porta" aberta do outro lado? Sem
        // isso, o celular reconhece o aluno, manda o aviso pro vazio e diz
        // que deu tudo certo — e a catraca não abre. Agora a tela sabe.
        const verPorta = () => {
          const todos = Object.values(canal.presenceState() || {}).flat()
          setPortaLigada(todos.some(p => p.papel === 'porta' && p.pronto))
        }
        canal.on('presence', { event: 'sync' }, verPorta)
        canal.subscribe(st => {
          if (st === 'SUBSCRIBED') {
            canalPorta.current = canal
            if (!localRef.current) setCatraca('pc')
          } else if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && !localRef.current) {
            setCatraca('Sem ligação com o computador da catraca.')
          }
        })
        // Este aparelho é o computador ligado na catraca? Então abre direto.
        if (serialSuportado()) {
          conectarCatraca().then(
            () => { localRef.current = true; ehOComputadorDaCatraca.current = true; setCatraca('ok') },
            () => { localRef.current = false },
          )
        }
        laco()
      } catch (e) {
        setEstado({ fase: 'erro', msg: e.name === 'NotAllowedError' ? 'A câmera foi bloqueada. Libere nas permissões do Safari/Chrome e recarregue.' : e.message })
      }
    })()

    const recarga = setInterval(carregarAlunos, RECARREGAR_ALUNOS_MS)
    // Sem ninguém na recepção: se a catraca desconectou, tenta de novo sozinha.
    // Sem ninguém na recepção: se a catraca desconectou, tenta de novo sozinha.
    // Num computador que já abriu a catraca uma vez, QUALQUER estado diferente
    // de "ok" vale uma tentativa — inclusive o "pc", que parecia saudável mas
    // era a conversa com um computador que não existe (é este aqui).
    const reconecta = serialSuportado() ? setInterval(() => {
      if (abrindoRef.current || religandoRef.current) return
      const atual = catracaRef.current
      if (atual === 'ok' || atual === 'abrindo' || atual === 'religando') return
      if (!ehOComputadorDaCatraca.current) return
      religarCatraca()
    }, RELIGAR_MS) : null
    return () => {
      vivo = false
      clearInterval(recarga)
      clearInterval(reconecta)
      clearTimeout(timerCartao)
      desligarCamera(stream)
      wakeLock?.release?.().catch(() => {})
      if (canalPorta.current) { supabase.removeChannel(canalPorta.current); canalPorta.current = null }
      sairTelaCheia()
    }
  }, [iniciado, empresa.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
        <button className="btn btn-primary ac-rec-comecar" onClick={comecar}>Começar</button>
        {/* Dá pra conferir o volume da caixinha sem esperar um aluno chegar. */}
        <button type="button" className="btn btn-secondary" onClick={() => { destravarSom(); bipe('ok'); setTimeout(() => bipe('aviso'), 700); setTimeout(() => bipe('nao'), 1500) }}>
          🔊 Testar os 3 toques
        </button>
        <Link to="/" className="ac-rec-voltar">← Voltar pros alunos</Link>
      </div>
    )
  }

  return (
    <div className="ac-rec">
      {/* Saída SEMPRE à vista. Antes o "← Alunos" ficava no fim da barra
          lateral e, no celular, fora da tela: pra sair da Recepção a pessoa
          tinha que adivinhar que precisava rolar a tela pra baixo. */}
      <Link to="/" className="ac-rec-sair" title="Voltar para os alunos">← Alunos</Link>
      {/* Liberar na mão sem sair da recepção: visitante, aluno que o dono
          deixou entrar, rosto que não pegou. Antes era preciso voltar pros
          Alunos só pra apertar o botão lá de cima — com fila no balcão. */}
      <button type="button" className="ac-rec-abrir" onClick={() => abrirCatraca(null)}
        disabled={catraca === 'abrindo'}
        title="Soltar a catraca uma vez, sem reconhecer ninguém">
        {catraca === 'abrindo' ? '🔓 Abrindo...' : '🔓 Abrir catraca'}
      </button>
      <div className="ac-rec-video-caixa">
        <video ref={videoRef} className="ac-video" playsInline muted />
        {estado.fase !== 'rodando' && (
          <div className="ac-rec-overlay"><p className={estado.fase === 'erro' ? 'ac-erro' : ''}>{estado.msg}</p></div>
        )}
        {estado.fase === 'rodando' && !cartao && (
          <div className="ac-rec-dica">{ajuste || 'Olhe para a câmera'}</div>
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
        {catraca && !(catraca === 'pc' && portaLigada === false) && (
          <div className="ac-rec-catraca">
            <div className={['ok', 'pc', 'abrindo'].includes(catraca) ? 'ok' : 'erro'}>
              {catraca === 'ok' ? '● Catraca conectada'
                : catraca === 'pc' ? '● Catraca pelo computador'
                : catraca === 'abrindo' ? '● Abrindo a catraca...'
                : catraca === 'religando' ? '● Religando a catraca...' : `● ${catraca}`}
            </div>
            {/* A catraca cai sozinha de vez em quando (a serial do PC solta).
                Ela volta sozinha, mas antes isso levava até 20 segundos com o
                aluno parado na porta e ninguem entendendo o que era. Agora o
                conserto fica aqui na propria tela do reconhecimento. */}
            {!['ok', 'pc', 'abrindo'].includes(catraca) && (
              <>
                <button type="button" className="ac-rec-religar"
                  disabled={catraca === 'religando'}
                  onClick={religarCatraca}>
                  {catraca === 'religando' ? 'Religando...' : '🔌 Religar a catraca'}
                </button>
                <span className="ac-muted" style={{ fontSize: 12 }}>
                  A catraca desligou. Aperte aqui pra religar — ou espere uns
                  segundos, que ela religa sozinha. O rosto continua funcionando.
                </span>
              </>
            )}
          </div>
        )}
        {/* Este aparelho não fala com a catraca e não tem ninguém do outro
            lado: o aluno seria reconhecido e a catraca ficaria trancada. */}
        {catraca !== 'ok' && portaLigada === false && (
          <div className="ac-rec-catraca">
            <div className="erro">
              ⚠ A catraca não vai abrir<br />
              No computador da catraca, abra a tela <b>Porta</b> e deixe ela aberta.
            </div>
          </div>
        )}
        {diag.ms && (
          <div className="ac-rec-diag">
            leitura {diag.ms} ms · {diag.backend}{diag.detector ? ` · detector ${diag.detector}` : ''}{diag.res ? ` · câmera ${diag.res}` : ''}
            {diag.dist != null ? ` · distância ${diag.dist.toFixed(3)}` : ''}
            {diag.margem != null && diag.margem !== Infinity ? ` · margem ${diag.margem.toFixed(3)}` : ''}
          </div>
        )}
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
  // Na carência a catraca abre, mas o cartão fica laranja: o aluno vê que
  // está no fim do prazo sem precisar de ninguém avisando.
  const cor = situacao.carencia ? 'ac-rec-carencia' : ok ? 'ac-rec-ok' : 'ac-rec-bloqueado'
  return (
    <div className={`ac-rec-cartao ${cor}`}>
      {aluno.foto && <img src={aluno.foto} alt="" />}
      <h2>{aluno.nome.split(' ')[0]}</h2>
      <div className="ac-rec-resultado">
        {situacao.carencia ? '⚠️ PAGUE A MENSALIDADE'
          : ok ? '✅ LIBERADO'
            : '❌ ' + (situacao.status === 'inativo' ? 'INATIVO' : 'VENCIDO')}
      </div>
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
// O bipe é o aviso do aluno: a catraca fica longe da tela e ele não está
// olhando pro monitor. Antes era onda senoidal em volume 0,2 — em caixinha
// de PC sumia no barulho da academia. Agora é onda quadrada (atravessa muito
// melhor alto-falante pequeno), mais alta e mais longa.
//
// São TRÊS toques diferentes, pra dar pra saber o que aconteceu sem ler a
// tela — inclusive de longe, de dentro da academia:
//   'ok'    duas notas subindo, curtas        — em dia, pode entrar
//   'aviso' três notas repetidas no meio      — passou, mas está atrasado
//   'nao'   duas notas graves descendo, longas — barrado
function bipe(tipo) {
  if (!audioCtx) return
  // Aceita o true/false de antes, pra nada quebrar se sobrar chamada velha.
  const t = tipo === true ? 'ok' : tipo === false ? 'nao' : tipo
  const receita = {
    ok:    { notas: [880, 1320],      dur: 0.18, volume: 0.55 },
    aviso: { notas: [660, 660, 660],  dur: 0.14, volume: 0.6 },
    nao:   { notas: [300, 196],       dur: 0.30, volume: 0.55 },
  }[t] || { notas: [880, 1320], dur: 0.18, volume: 0.55 }

  try {
    receita.notas.forEach((f, i) => {
      const o = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      o.type = 'square'
      o.frequency.value = f
      o.connect(g); g.connect(audioCtx.destination)
      const quando = audioCtx.currentTime + i * receita.dur
      const fim = quando + receita.dur
      // Sobe e desce rápido pra não estalar no alto-falante.
      g.gain.setValueAtTime(0.0001, quando)
      g.gain.exponentialRampToValueAtTime(receita.volume, quando + 0.012)
      g.gain.setValueAtTime(receita.volume, fim - 0.05)
      g.gain.exponentialRampToValueAtTime(0.0001, fim - 0.01)
      o.start(quando); o.stop(fim)
    })
  } catch { /* sem som, segue */ }
}
