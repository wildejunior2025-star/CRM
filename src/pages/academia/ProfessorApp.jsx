import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { situacaoAluno } from '../../lib/reconhecimentoFacial'
import './aluno.css'

// Área do PROFESSOR — mesmo endereço, no celular, com a mesma cara da área do
// aluno (ele anda pela academia com o telefone na mão, do lado do aluno).
//
// Diferença: ele vê TODOS os alunos da academia e monta o treino de cada um.

const ProfessorTreino = lazy(() => import('./ProfessorTreino'))

export default function ProfessorApp() {
  const { profile, logout } = useAuth()
  const [alunos, setAlunos] = useState([])
  const [busca, setBusca] = useState('')
  const [carregando, setCarregando] = useState(true)
  const [aluno, setAluno] = useState(null)
  const [gaveta, setGaveta] = useState(false)

  const carregar = useCallback(async () => {
    const { data } = await supabase
      .from('academia_alunos')
      .select('id, nome, matricula, foto, plano, vencimento, ativo, objetivo, diabetes, hipertensao, cardiopata, saude_outra')
      .eq('empresa_id', profile.empresa_id)
      .order('nome')
    setAlunos(data || [])
    setCarregando(false)
  }, [profile.empresa_id])

  useEffect(() => { carregar() }, [carregar])

  if (aluno) {
    return (
      <Suspense fallback={<div className="al-centro">Carregando...</div>}>
        <ProfessorTreino aluno={aluno} onVoltar={() => setAluno(null)} />
      </Suspense>
    )
  }

  const termo = busca.trim().toLowerCase()
  const lista = alunos.filter(a =>
    a.nome.toLowerCase().includes(termo) || String(a.matricula || '').includes(termo))

  return (
    <div className="al-tela">
      <header className="al-topo">
        <button className="al-menu-botao" onClick={() => setGaveta(true)} aria-label="Menu">⋯</button>
        <div className="al-titulo">
          <span className="al-ola">Professor</span>
          <h1>Alunos</h1>
        </div>
      </header>

      {gaveta && (
        <div className="al-gaveta-fundo" onClick={() => setGaveta(false)}>
          <nav className="al-gaveta" onClick={e => e.stopPropagation()}>
            <div className="al-gaveta-topo">
              <span className="al-foto al-foto-vazia">🏋️</span>
              <div><strong>{profile.nome}</strong><span className="al-tag ok">Professor</span></div>
            </div>
            <button className="al-gaveta-item ativo">
              <span className="al-gaveta-icone">👥</span>
              <span className="al-gaveta-texto"><strong>Alunos</strong><small>Montar e ver treinos</small></span>
            </button>
            <button className="al-gaveta-item sair" onClick={logout}>
              <span className="al-gaveta-icone">↪</span>
              <span className="al-gaveta-texto"><strong>Sair da conta</strong></span>
            </button>
          </nav>
        </div>
      )}

      <input
        className="al-busca" inputMode="search" placeholder="Buscar pelo nome ou matrícula"
        value={busca} onChange={e => setBusca(e.target.value)}
      />

      {carregando ? <p className="al-vazio">Carregando...</p> : (
        <ul className="al-alunos">
          {lista.slice(0, 60).map(a => {
            const s = situacaoAluno(a)
            return (
              <li key={a.id}>
                <button onClick={() => setAluno(a)}>
                  {a.foto
                    ? <img className="al-foto" src={a.foto} alt="" />
                    : <span className="al-foto al-foto-vazia">?</span>}
                  <span className="al-aluno-nome">
                    <strong>{a.nome}</strong>
                    <small>{a.matricula ? `nº ${a.matricula}` : ''}{a.objetivo ? ` · ${a.objetivo}` : ''}</small>
                  </span>
                  <span className={`al-tag ${s.status === 'liberado' ? 'ok' : 'devendo'}`}>
                    {s.status === 'liberado' ? 'Em dia' : 'Vencida'}
                  </span>
                </button>
              </li>
            )
          })}
          {lista.length > 60 && <li className="al-vazio">Mostrando 60 de {lista.length}. Use a busca.</li>}
          {lista.length === 0 && <li className="al-vazio">Ninguém com esse nome.</li>}
        </ul>
      )}
    </div>
  )
}
