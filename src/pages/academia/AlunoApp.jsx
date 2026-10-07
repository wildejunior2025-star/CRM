import { lazy, Suspense, useEffect, useState } from 'react'
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

function Entradas({ entradas }) {
  if (entradas.length === 0) {
    return (
      <section className="al-bloco">
        <p className="al-vazio">Nenhuma entrada ainda. A primeira é quando você passar na catraca.</p>
      </section>
    )
  }
  return (
    <section className="al-bloco">
      <ul className="al-entradas">
        {entradas.map((e, i) => {
          const d = new Date(e.criado_em)
          return (
            <li key={i}>
              <span>{d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span>
              <strong>{d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</strong>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
