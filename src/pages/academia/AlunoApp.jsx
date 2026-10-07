import { lazy, Suspense, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { situacaoAluno } from '../../lib/reconhecimentoFacial'
import { dinheiro, dataBr } from '../../lib/academiaPagamento'
import './aluno.css'

// Área do ALUNO — mesmo endereço da academia, mas quem entra com perfil
// 'aluno' só vê o que é dele. Feita pro CELULAR: é onde ele vive.
//
// v1: quem ele é, se está em dia, as entradas dele e o cadastro do rosto.
// Treino e pagamento por PIX entram em seguida.

const AlunoRosto = lazy(() => import('./AlunoRosto'))

export default function AlunoApp() {
  const { profile, logout } = useAuth()
  const [aluno, setAluno] = useState(null)
  const [entradas, setEntradas] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [tela, setTela] = useState('inicio') // inicio | rosto

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
        .limit(30)
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
          <p>Sua conta ainda não está ligada à ficha de aluno. Fale com a recepção.</p>
          <button className="al-botao secundario" onClick={logout}>Sair</button>
        </div>
      </div>
    )
  }

  if (tela === 'rosto') {
    return (
      <Suspense fallback={<div className="al-centro">Abrindo a câmera...</div>}>
        <AlunoRosto aluno={aluno} onPronto={() => { setTela('inicio'); carregar() }} />
      </Suspense>
    )
  }

  const s = situacaoAluno(aluno)
  const emDia = s.status === 'liberado'
  const esteMes = entradas.filter(e => e.criado_em.slice(0, 7) === new Date().toISOString().slice(0, 7)).length
  const primeiroNome = aluno.nome.split(' ')[0]

  return (
    <div className="al-tela">
      <header className="al-topo">
        <div>
          <span className="al-ola">Olá,</span>
          <h1>{primeiroNome}</h1>
        </div>
        {aluno.foto
          ? <img className="al-foto" src={aluno.foto} alt="" />
          : <div className="al-foto al-foto-vazia" onClick={() => setTela('rosto')}>+</div>}
      </header>

      <section className={`al-situacao ${emDia ? 'ok' : 'devendo'}`}>
        <span className="al-rotulo">{emDia ? 'Mensalidade em dia' : 'Mensalidade vencida'}</span>
        <strong>{aluno.vencimento ? dataBr(aluno.vencimento) : '—'}</strong>
        <span className="al-sub">
          {emDia ? 'Você pode treinar' : 'Procure a recepção para renovar'}
          {aluno.valor ? ` · ${dinheiro(aluno.valor)}` : ''}
        </span>
      </section>

      {!aluno.descritores?.length && (
        <button className="al-aviso-rosto" onClick={() => setTela('rosto')}>
          <strong>Cadastre seu rosto</strong>
          <span>É assim que a catraca abre pra você. Leva 30 segundos.</span>
        </button>
      )}

      <section className="al-numeros">
        <div className="al-numero">
          <strong>{esteMes}</strong>
          <span>treinos este mês</span>
        </div>
        <div className="al-numero">
          <strong>{aluno.plano || '—'}</strong>
          <span>seu plano</span>
        </div>
      </section>

      <section className="al-bloco">
        <h2>Suas últimas entradas</h2>
        {entradas.length === 0 ? (
          <p className="al-vazio">Nenhuma entrada ainda. A primeira é quando você passar na catraca.</p>
        ) : (
          <ul className="al-entradas">
            {entradas.slice(0, 10).map((e, i) => {
              const d = new Date(e.criado_em)
              return (
                <li key={i}>
                  <span>{d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span>
                  <strong>{d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</strong>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="al-bloco al-embreve">
        <h2>Em breve</h2>
        <p>Seu treino do dia e o pagamento da mensalidade por aqui mesmo.</p>
      </section>

      <footer className="al-rodape">
        <button className="al-botao secundario" onClick={() => setTela('rosto')}>
          {aluno.descritores?.length ? 'Atualizar meu rosto' : 'Cadastrar meu rosto'}
        </button>
        <button className="al-botao texto" onClick={logout}>Sair</button>
      </footer>
    </div>
  )
}
