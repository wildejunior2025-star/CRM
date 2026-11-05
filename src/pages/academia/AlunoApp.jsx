import { Fragment, lazy, Suspense, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { situacaoAluno } from '../../lib/reconhecimentoFacial'
import { dinheiro, dataBr } from '../../lib/academiaPagamento'
import './aluno.css'

// Área do ALUNO — mesmo endereço da academia, só que quem entra com perfil
// 'aluno' vê apenas o que é dele. Feita pro CELULAR.
//
// A tela inicial fica LIMPA: só o que ele quer saber chegando na academia.
// O resto abre numa GAVETA LATERAL (como o menu do CRM), e cada função nova
// vira só mais um botão lá dentro.

const AlunoRosto = lazy(() => import('./AlunoRosto'))
const AlunoPerfil = lazy(() => import('./AlunoPerfil'))
const AlunoTermos = lazy(() => import('./AlunoTermos'))
const AlunoFicha = lazy(() => import('./AlunoFicha'))
const AlunoTreinos = lazy(() => import('./AlunoTreinos'))

const MENU = [
  { id: 'perfil', nome: 'Perfil', icone: '👤', detalhe: 'Foto, dados e senha' },
  { id: 'entradas', nome: 'Minhas entradas', icone: '🚪', detalhe: 'Quando você treinou' },
  { id: 'ficha', nome: 'Minha ficha', icone: '📏', detalhe: 'Medidas e evolução' },
  { id: 'treinos', nome: 'Meus treinos', icone: '🏋️', detalhe: 'O treino do dia' },
  { id: 'falar', nome: 'Falar com a academia', icone: '💬', detalhe: 'Pelo WhatsApp' },
]

export default function AlunoApp() {
  const { profile, empresa, logout } = useAuth()
  const [aluno, setAluno] = useState(null)
  const [entradas, setEntradas] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [tela, setTela] = useState('inicio') // inicio | perfil | entradas | treinos | rosto
  const [gaveta, setGaveta] = useState(false)

  async function carregar() {
    const { data } = await supabase
      .from('academia_alunos')
      .select('*')
      .eq('profile_id', profile.id)
      .maybeSingle()
    setAluno(data || null)
    if (data) {
      const { data: acessos } = await supabase
        .from('academia_acessos')
        .select('criado_em, resultado')
        .eq('aluno_id', data.id)
        .order('criado_em', { ascending: false })
        .limit(60)
      setEntradas(acessos || [])
    }
    setCarregando(false)
  }

  useEffect(() => { carregar() }, [profile.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Marca que este aluno abriu o app hoje. Serve pra responder, daqui a
  // alguns meses, quantos alunos realmente usam — sem isso, cobrar pelo app
  // seria chute. Uma linha por aluno por dia; se falhar, não atrapalha nada.
  useEffect(() => {
    supabase.rpc('academia_marcar_uso').then(() => {}, () => {})
  }, [profile.id])

  function abrir(id) {
    setGaveta(false)
    // Falar com a academia abre o WhatsApp dela, com a mensagem começada.
    if (id === 'falar') {
      const fone = String(empresa?.telefone_contato || '').replace(/\D/g, '')
      if (!fone) { setTela('semWhats'); return }
      const texto = encodeURIComponent(`Oi! Aqui é ${aluno?.nome?.split(' ')[0] || 'um aluno'}, da academia.`)
      window.open(`https://wa.me/55${fone.replace(/^55/, '')}?text=${texto}`, '_blank')
      return
    }
    setTela(id)
  }

  if (carregando) return <div className="al-centro">Carregando...</div>

  if (!aluno) {
    return (
      <div className="al-centro">
        <div className="al-cartao">
          <h1>Quase lá</h1>
          <p>Sua conta ainda não está ligada à sua ficha de aluno. Fale com a recepção.</p>
          <button className="al-botao secundario" onClick={logout}>Sair</button>
        </div>
      </div>
    )
  }

  // Primeiro acesso: o próprio aluno aceita o uso do rosto (LGPD).
  if (!aluno.consentimento_em) {
    return (
      <Suspense fallback={<div className="al-centro">Carregando...</div>}>
        <AlunoTermos aluno={aluno} onAceitou={carregar} />
      </Suspense>
    )
  }

  if (tela === 'rosto') {
    return (
      <Suspense fallback={<div className="al-centro">Abrindo a câmera...</div>}>
        <AlunoRosto aluno={aluno} onPronto={() => { setTela('perfil'); carregar() }} />
      </Suspense>
    )
  }

  const s = situacaoAluno(aluno)
  const emDia = s.status === 'liberado'
  const titulo = MENU.find(m => m.id === tela)?.nome

  return (
    <div className="al-tela">
      <header className="al-topo">
        <button className="al-menu-botao" onClick={() => setGaveta(true)} aria-label="Abrir menu">⋯</button>
        <div className="al-titulo">
          {tela === 'inicio' ? (
            <>
              <span className="al-ola">Olá,</span>
              <h1>{aluno.nome.split(' ')[0]}</h1>
            </>
          ) : (
            <h1>{titulo}</h1>
          )}
        </div>
        <button className="al-foto-botao" onClick={() => setGaveta(true)} title="Menu">
          {aluno.foto
            ? <img className="al-foto" src={aluno.foto} alt="" />
            : <span className="al-foto al-foto-vazia">+</span>}
        </button>
      </header>

      {gaveta && (
        <div className="al-gaveta-fundo" onClick={() => setGaveta(false)}>
          <nav className="al-gaveta" onClick={e => e.stopPropagation()}>
            <div className="al-gaveta-topo">
              {aluno.foto
                ? <img className="al-foto" src={aluno.foto} alt="" />
                : <span className="al-foto al-foto-vazia">+</span>}
              <div>
                <strong>{aluno.nome.split(' ').slice(0, 2).join(' ')}</strong>
                <span className={emDia ? 'al-tag ok' : 'al-tag devendo'}>
                  {emDia ? 'Em dia' : 'Vencida'}
                </span>
              </div>
            </div>

            {tela !== 'inicio' && (
              <button className="al-gaveta-item" onClick={() => abrir('inicio')}>
                <span className="al-gaveta-icone">🏠</span>
                <span className="al-gaveta-texto"><strong>Início</strong></span>
              </button>
            )}
            {MENU.map(m => (
              <button
                key={m.id}
                className={`al-gaveta-item${tela === m.id ? ' ativo' : ''}`}
                onClick={() => abrir(m.id)}
              >
                <span className="al-gaveta-icone">{m.icone}</span>
                <span className="al-gaveta-texto">
                  <strong>{m.nome}</strong>
                  <small>{m.detalhe}</small>
                </span>
              </button>
            ))}

            <button className="al-gaveta-item sair" onClick={logout}>
              <span className="al-gaveta-icone">↪</span>
              <span className="al-gaveta-texto"><strong>Sair da conta</strong></span>
            </button>
          </nav>
        </div>
      )}

      {tela === 'inicio' && (
        <>
          <section className={`al-situacao ${emDia ? 'ok' : 'devendo'}`}>
            <span className="al-rotulo">{emDia ? 'Mensalidade em dia' : 'Mensalidade vencida'}</span>
            <strong>{aluno.vencimento ? dataBr(aluno.vencimento) : '—'}</strong>
            <span className="al-sub">
              {emDia ? 'Pode treinar' : 'Procure a recepção'}
              {aluno.valor ? ` · ${dinheiro(aluno.valor)}` : ''}
            </span>
          </section>

          {!aluno.descritores?.length && (
            <button className="al-aviso-rosto" onClick={() => setTela('rosto')}>
              <strong>Cadastre seu rosto</strong>
              <span>É assim que a catraca abre pra você.</span>
            </button>
          )}
        </>
      )}

      {tela === 'perfil' && (
        <Suspense fallback={<p className="al-vazio">Carregando...</p>}>
          <AlunoPerfil
            aluno={aluno}
            onSalvou={carregar}
            onTrocarFoto={() => setTela('rosto')}
          />
        </Suspense>
      )}

      {tela === 'entradas' && <Entradas entradas={entradas} />}

      {tela === 'semWhats' && (
        <section className="al-bloco">
          <p className="al-texto">A academia ainda não cadastrou o WhatsApp dela. Fale na recepção.</p>
        </section>
      )}

      {tela === 'ficha' && (
        <Suspense fallback={<p className="al-vazio">Carregando...</p>}>
          <AlunoFicha aluno={aluno} />
        </Suspense>
      )}

      {tela === 'treinos' && (
        <Suspense fallback={<p className="al-vazio">Carregando...</p>}>
          <AlunoTreinos aluno={aluno} />
        </Suspense>
      )}
    </div>
  )
}

// Uma linha por DIA, não por leitura da catraca.
//
// A catraca grava toda leitura: quem passa e volta, ou a recepção que lê duas
// vezes, virava três "entradas" às 17:00, 17:01 e 17:02 — a lista parecia
// bagunça e não respondia o que o aluno quer saber ("quantas vezes eu fui?").
// Aqui as leituras coladas (menos de 2 h de diferença) viram UMA ida; o dia
// com manhã e tarde continua mostrando as duas.
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

const JUNTAR_MS = 2 * 60 * 60 * 1000

function porDia(entradas) {
  const dias = []
  // Vem do banco do mais novo pro mais velho. Percorre ao CONTRÁRIO pra que a
  // primeira leitura de cada ida seja a da chegada: quem passou 08:31 e 08:45
  // chegou 08:31, e é essa hora que o aluno reconhece.
  for (const e of [...entradas].reverse()) {
    const d = new Date(e.criado_em)
    const chave = d.toDateString()
    let dia = dias.find(x => x.chave === chave)
    if (!dia) { dia = { chave, data: d, idas: [] }; dias.push(dia) }
    const ultima = dia.idas[dia.idas.length - 1]
    if (!ultima || Math.abs(ultima - d) > JUNTAR_MS) dia.idas.push(d)
  }
  dias.reverse() // de volta pro mais novo em cima
  // O cabeçalho do mês já sai daqui pronto: só o primeiro dia de cada mês
  // carrega o título.
  let mesAnterior = null
  for (const dia of dias) {
    const mes = `${MESES[dia.data.getMonth()]} ${dia.data.getFullYear()}`
    dia.cabecalho = mes === mesAnterior ? null : mes
    mesAnterior = mes
  }
  return dias
}

function quandoFoi(d) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
  const dia = new Date(d); dia.setHours(0, 0, 0, 0)
  const faltam = Math.round((hoje - dia) / 86400000)
  if (faltam === 0) return 'hoje'
  if (faltam === 1) return 'ontem'
  if (faltam < 7) return `há ${faltam} dias`
  if (faltam < 14) return 'semana passada'
  return `há ${Math.floor(faltam / 7)} semanas`
}

function Entradas({ entradas }) {
  if (entradas.length === 0) {
    return (
      <section className="al-bloco">
        <p className="al-vazio">Nenhuma entrada ainda. A primeira é quando você passar na catraca.</p>
      </section>
    )
  }

  const dias = porDia(entradas)
  const agora = new Date()
  const noMes = dias.filter(d => d.data.getMonth() === agora.getMonth()
    && d.data.getFullYear() === agora.getFullYear()).length
  // Semana começando no domingo, igual ao calendário do celular.
  const domingo = new Date(agora)
  domingo.setDate(agora.getDate() - agora.getDay())
  domingo.setHours(0, 0, 0, 0)
  const naSemana = dias.filter(d => d.data >= domingo).length

  return (
    <section className="al-bloco">
      <div className="al-resumo">
        <div><strong>{noMes}</strong><small>{noMes === 1 ? 'dia este mês' : 'dias este mês'}</small></div>
        <div><strong>{naSemana}</strong><small>{naSemana === 1 ? 'dia esta semana' : 'dias esta semana'}</small></div>
      </div>
      <p className="al-ultima-vez">
        Última vez: <b>{quandoFoi(dias[0].data)}</b>, às{' '}
        {dias[0].idas[0].toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
      </p>

      <ul className="al-entradas">
        {dias.map(dia => {
          const semana = dia.data.toLocaleDateString('pt-BR', { weekday: 'long' }).replace('-feira', '')
          return (
            <Fragment key={dia.chave}>
              {dia.cabecalho && <li className="al-mes">{dia.cabecalho}</li>}
              <li>
                <span className="al-dia">
                  <strong>{String(dia.data.getDate()).padStart(2, '0')}</strong>
                  <small>{semana}</small>
                </span>
                <span className="al-horas">
                  {dia.idas.map(h => h.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })).join('  ·  ')}
                </span>
              </li>
            </Fragment>
          )
        })}
      </ul>
    </section>
  )
}
