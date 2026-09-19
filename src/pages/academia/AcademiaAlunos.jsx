import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import {
  carregarFaceApi, lerRosto, ligarCamera, desligarCamera, miniaturaDoRosto, situacaoAluno, acharAluno,
  entrarTelaCheia, sairTelaCheia,
} from '../../lib/reconhecimentoFacial'

// Quantas "digitais do rosto" o cadastro guarda. Mais de uma deixa o
// reconhecimento firme com o aluno de lado, de óculos, com luz diferente.
const AMOSTRAS = 4
// Quanto tem que virar a cabeça pra etapa "vire pro lado" contar.
const GIRO_LADO = 0.15
const GIRO_FRENTE = 0.08 // até aqui conta como "de frente"

function hojeMais(dias) {
  const d = new Date()
  d.setDate(d.getDate() + dias)
  return d.toISOString().slice(0, 10)
}

function somaMes(dataIso) {
  // Renovar: conta do vencimento atual se ainda está em dia, senão de hoje.
  const hoje = hojeMais(0)
  const base = dataIso && dataIso >= hoje ? dataIso : hoje
  const d = new Date(base + 'T00:00:00')
  d.setMonth(d.getMonth() + 1)
  return d.toISOString().slice(0, 10)
}

const VAZIO = { nome: '', telefone: '', plano: 'Mensal', valor: '', vencimento: '', ativo: true }

export default function AcademiaAlunos() {
  const { empresa } = useAuth()
  const [alunos, setAlunos] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [busca, setBusca] = useState('')
  const [editando, setEditando] = useState(null) // null | 'novo' | aluno

  async function carregar() {
    const { data, error } = await supabase
      .from('academia_alunos')
      .select('*')
      .eq('empresa_id', empresa.id)
      .order('nome')
    if (!error) setAlunos(data || [])
    setCarregando(false)
  }

  useEffect(() => { carregar() }, [empresa.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function renovar(aluno) {
    const novo = somaMes(aluno.vencimento)
    await supabase.from('academia_alunos').update({ vencimento: novo }).eq('id', aluno.id)
    carregar()
  }

  const filtrados = alunos.filter(a => a.nome.toLowerCase().includes(busca.toLowerCase()))
  const semRosto = alunos.filter(a => !a.descritores?.length).length

  if (editando) {
    return (
      <FormAluno
        aluno={editando === 'novo' ? null : editando}
        alunos={alunos}
        empresaId={empresa.id}
        onFechar={salvou => { setEditando(null); if (salvou) carregar() }}
      />
    )
  }

  return (
    <div>
      <div className="ac-linha-titulo">
        <h2>Alunos <span className="ac-muted">({alunos.length})</span></h2>
        <button className="btn btn-primary" onClick={() => setEditando('novo')}>+ Novo aluno</button>
      </div>
      {semRosto > 0 && (
        <div className="ac-aviso">{semRosto} aluno{semRosto > 1 ? 's' : ''} sem rosto cadastrado — a recepção não vai reconhecer.</div>
      )}
      <input className="ac-busca" placeholder="Buscar pelo nome" value={busca} onChange={e => setBusca(e.target.value)} />
      {carregando ? <p className="ac-muted">Carregando...</p> : filtrados.length === 0 ? (
        <p className="ac-muted">{alunos.length ? 'Ninguém com esse nome.' : 'Nenhum aluno ainda. Cadastre o primeiro.'}</p>
      ) : (
        <div className="ac-lista">
          {filtrados.map(a => {
            const s = situacaoAluno(a)
            return (
              <div key={a.id} className="ac-aluno">
                {a.foto ? <img src={a.foto} alt="" className="ac-foto" /> : <div className="ac-foto ac-foto-vazia">?</div>}
                <div className="ac-aluno-info">
                  <strong>{a.nome}</strong>
                  <span className="ac-muted">{[a.plano, a.valor ? `R$ ${Number(a.valor).toFixed(2).replace('.', ',')}` : null].filter(Boolean).join(' · ')}</span>
                  <span className={`ac-status ac-${s.status}${s.aviso ? ' ac-quase' : ''}`}>{s.texto}</span>
                  {!a.descritores?.length && <span className="ac-status ac-vencido">Sem rosto</span>}
                </div>
                <div className="ac-aluno-acoes">
                  <button className="btn btn-secondary btn-sm" onClick={() => renovar(a)} title="Soma 1 mês no vencimento">Renovar</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditando(a)}>Editar</button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FormAluno({ aluno, alunos, empresaId, onFechar }) {
  const [dados, setDados] = useState(() => aluno ? {
    nome: aluno.nome, telefone: aluno.telefone || '', plano: aluno.plano || '',
    valor: aluno.valor ?? '', vencimento: aluno.vencimento || '', ativo: aluno.ativo,
  } : { ...VAZIO, vencimento: hojeMais(30) })
  const [rosto, setRosto] = useState(null) // { descritores, foto } capturado agora
  const [consentiu, setConsentiu] = useState(!!aluno?.consentimento_em)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const [cameraAberta, setCameraAberta] = useState(false)

  const set = (k, v) => setDados(d => ({ ...d, [k]: v }))
  const fotoAtual = rosto?.foto || aluno?.foto

  async function salvar(e) {
    e.preventDefault()
    setErro(null)
    if (!dados.nome.trim()) return setErro('Coloque o nome.')
    if (rosto && !consentiu) return setErro('Marque que o aluno autorizou o uso do rosto.')
    setSalvando(true)
    const linha = {
      empresa_id: empresaId,
      nome: dados.nome.trim(),
      telefone: dados.telefone.trim() || null,
      plano: dados.plano.trim() || null,
      valor: dados.valor === '' ? null : Number(String(dados.valor).replace(',', '.')),
      vencimento: dados.vencimento || null,
      ativo: dados.ativo,
    }
    if (rosto) {
      linha.descritores = rosto.descritores
      linha.foto = rosto.foto
      linha.consentimento_em = aluno?.consentimento_em || new Date().toISOString()
    }
    const { error } = aluno
      ? await supabase.from('academia_alunos').update(linha).eq('id', aluno.id)
      : await supabase.from('academia_alunos').insert(linha)
    setSalvando(false)
    if (error) return setErro('Não salvou: ' + error.message)
    onFechar(true)
  }

  async function apagar() {
    if (!window.confirm(`Apagar ${aluno.nome}? Some o cadastro, o rosto e o histórico de entradas.`)) return
    await supabase.from('academia_alunos').delete().eq('id', aluno.id)
    onFechar(true)
  }

  return (
    <form className="ac-card ac-form" onSubmit={salvar}>
      <div className="ac-linha-titulo">
        <h2>{aluno ? 'Editar aluno' : 'Novo aluno'}</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onFechar(false)}>Voltar</button>
      </div>

      <div className="ac-form-grade">
        <div className="ac-form-rosto">
          {cameraAberta && (
            <CapturaRosto
              alunos={alunos.filter(a => a.id !== aluno?.id)}
              onPronto={r => { setRosto(r); setCameraAberta(false) }}
              onCancelar={() => setCameraAberta(false)}
            />
          )}
          <div className="ac-rosto-pronto">
            {fotoAtual ? <img src={fotoAtual} alt="" /> : <div className="ac-foto ac-foto-vazia grande">?</div>}
            {rosto && <span className="ac-status ac-liberado">Rosto capturado ✓</span>}
            <button type="button" className={`btn ${fotoAtual ? 'btn-secondary btn-sm' : 'btn-primary'}`} onClick={() => { entrarTelaCheia(); setCameraAberta(true) }}>
              {fotoAtual ? 'Tirar de novo' : '📷 Cadastrar rosto'}
            </button>
          </div>
        </div>

        <div className="ac-form-campos">
          <label>Nome
            <input value={dados.nome} onChange={e => set('nome', e.target.value)} required />
          </label>
          <label>WhatsApp
            <input inputMode="tel" value={dados.telefone} onChange={e => set('telefone', e.target.value)} placeholder="(84) 99999-9999" />
          </label>
          <div className="ac-dupla">
            <label>Plano
              <input value={dados.plano} onChange={e => set('plano', e.target.value)} placeholder="Mensal" />
            </label>
            <label>Valor (R$)
              <input inputMode="decimal" value={dados.valor} onChange={e => set('valor', e.target.value)} placeholder="89,90" />
            </label>
          </div>
          <label>Vence em
            <input type="date" value={dados.vencimento} onChange={e => set('vencimento', e.target.value)} />
          </label>
          {aluno && (
            <label className="ac-check">
              <input type="checkbox" checked={dados.ativo} onChange={e => set('ativo', e.target.checked)} />
              Matrícula ativa
            </label>
          )}
          {rosto && !aluno?.consentimento_em && (
            <label className="ac-check">
              <input type="checkbox" checked={consentiu} onChange={e => setConsentiu(e.target.checked)} />
              O aluno autorizou usar o rosto dele só pra liberar a entrada (LGPD).
            </label>
          )}
        </div>
      </div>

      {erro && <div className="ac-erro">{erro}</div>}
      <div className="ac-form-botoes">
        {aluno && <button type="button" className="btn btn-danger" onClick={apagar}>Apagar</button>}
        <button className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar'}</button>
      </div>
    </form>
  )
}

// Liga a câmera e guia a pessoa em 4 etapas (frente, um lado, outro lado,
// frente + piscar), guardando uma "digital do rosto" em cada.
function CapturaRosto({ alunos, onPronto, onCancelar }) {
  const videoRef = useRef(null)
  const [fase, setFase] = useState('carregando') // carregando | pronto | capturando | revisar | erro
  const [msg, setMsg] = useState('Preparando a câmera...')
  const [feitas, setFeitas] = useState(0)
  const [resultado, setResultado] = useState(null) // { descritores, foto } esperando o "ficou boa?"
  const capturaRef = useRef(0) // muda a cada captura; captura antiga que ainda estiver rodando para sozinha

  useEffect(() => {
    let stream = null
    let vivo = true
    ;(async () => {
      try {
        setMsg('Baixando o reconhecimento (só na primeira vez)...')
        await carregarFaceApi()
        if (!vivo) return
        stream = await ligarCamera(videoRef.current)
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
  }, [])

  // Cada etapa só passa quando a pessoa FEZ o que a tela pediu — conferido
  // pela posição do nariz (virar) e pelos olhos (piscar). Sem pular por tempo;
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

    // 4. De frente de novo + piscar (prova de que é gente, não foto)
    r = await esperarQue('Olhe de frente de novo', x => Math.abs(x.giro) < GIRO_FRENTE, 3)
    if (!r) return
    descritores.push(Array.from(r.descritor))
    const aberto = r.olhos
    const fechou = await esperarQue('Agora pisque os olhos', x => x.olhos < aberto * 0.75, 1)
    if (!fechou) return
    const abriu = await esperarQue('Agora pisque os olhos', x => x.olhos > aberto * 0.88, 1)
    if (!abriu) return
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
