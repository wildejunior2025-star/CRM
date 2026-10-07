import { lazy, Suspense, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { situacaoAluno } from '../../lib/reconhecimentoFacial'
import { dinheiro, dataBr } from '../../lib/academiaPagamento'
import './aluno.css'

// Área do ALUNO — mesmo endereço da academia, só que quem entra com perfil
// 'aluno' vê apenas o que é dele. Feita pro CELULAR.
//
// A tela inicial fica LIMPA de propósito (pedido do usuário em 07/10): só o
// que ele quer saber chegando na academia. O resto — foto, dados, senha e o
// histórico de entradas — mora no Perfil, que abre tocando na foto.

const AlunoRosto = lazy(() => import('./AlunoRosto'))
const AlunoPerfil = lazy(() => import('./AlunoPerfil'))

export default function AlunoApp() {
  const { profile, logout } = useAuth()
  const [aluno, setAluno] = useState(null)
  const [entradas, setEntradas] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [tela, setTela] = useState('inicio') // inicio | perfil | rosto

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

  if (tela === 'rosto') {
    return (
      <Suspense fallback={<div className="al-centro">Abrindo a câmera...</div>}>
        <AlunoRosto aluno={aluno} onPronto={() => { setTela('perfil'); carregar() }} />
      </Suspense>
    )
  }

  if (tela === 'perfil') {
    return (
      <Suspense fallback={<div className="al-centro">Carregando...</div>}>
        <AlunoPerfil
          aluno={aluno}
          entradas={entradas}
          onVoltar={() => { setTela('inicio'); carregar() }}
          onTrocarFoto={() => setTela('rosto')}
        />
      </Suspense>
    )
  }

  const s = situacaoAluno(aluno)
  const emDia = s.status === 'liberado'
  const mesAtual = new Date().toISOString().slice(0, 7)
  const esteMes = entradas.filter(e => e.criado_em.slice(0, 7) === mesAtual).length

  return (
    <div className="al-tela">
      <header className="al-topo">
        <div>
          <span className="al-ola">Olá,</span>
          <h1>{aluno.nome.split(' ')[0]}</h1>
        </div>
        <button className="al-foto-botao" onClick={() => setTela('perfil')} title="Meu perfil">
          {aluno.foto
            ? <img className="al-foto" src={aluno.foto} alt="Meu perfil" />
            : <span className="al-foto al-foto-vazia">+</span>}
        </button>
      </header>

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

      <section className="al-treinos">
        <strong>{esteMes}</strong>
        <span>{esteMes === 1 ? 'treino este mês' : 'treinos este mês'}</span>
      </section>
    </div>
  )
}
