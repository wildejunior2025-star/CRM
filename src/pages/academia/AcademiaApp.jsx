import { useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import './academia.css'

// academia.fwcinter.com — sistema da academia (mig 0276).
//   /           → alunos (cadastro com foto do rosto)
//   /recepcao   → tablet da recepção: câmera reconhece e mostra se está em dia
// Por enquanto só o dono (admin da empresa) entra. Instrutor e aluno vêm depois.

const AcademiaAlunos = lazy(() => import('./AcademiaAlunos'))
const AcademiaRecepcao = lazy(() => import('./AcademiaRecepcao'))

function Carregando() {
  return <div className="ac-centro ac-muted">Carregando...</div>
}

function EntrarAcademia() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState(null)
  const [enviando, setEnviando] = useState(false)

  async function entrar(e) {
    e.preventDefault()
    setEnviando(true)
    setErro(null)
    const { error } = await login(email.trim(), senha)
    setEnviando(false)
    if (error) setErro('E-mail ou senha errados.')
  }

  return (
    <div className="ac-centro">
      <form className="ac-card ac-login" onSubmit={entrar}>
        <div className="ac-logo">🏋️</div>
        <h1>Academia</h1>
        <p className="ac-muted">Entre com a conta do dono da academia.</p>
        <label>E-mail
          <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
        </label>
        <label>Senha
          <input type="password" autoComplete="current-password" value={senha} onChange={e => setSenha(e.target.value)} required />
        </label>
        {erro && <div className="ac-erro">{erro}</div>}
        <button className="btn btn-primary" disabled={enviando}>{enviando ? 'Entrando...' : 'Entrar'}</button>
      </form>
    </div>
  )
}

function Topo() {
  const { empresa, logout } = useAuth()
  return (
    <header className="ac-topo">
      <strong className="ac-nome-empresa">{empresa?.nome || 'Academia'}</strong>
      <nav>
        <NavLink to="/" end>Alunos</NavLink>
        <NavLink to="/recepcao">Recepção</NavLink>
      </nav>
      <button className="btn btn-secondary btn-sm" onClick={logout}>Sair</button>
    </header>
  )
}

function Portaria() {
  const { session, profile, empresa, loading, profileLoading } = useAuth()
  if (loading || (session && profileLoading && !profile)) return <Carregando />
  if (!session) return <EntrarAcademia />
  const podeEntrar = profile && ['admin', 'super_admin'].includes(profile.perfil) && empresa
  if (!podeEntrar) {
    return (
      <div className="ac-centro">
        <div className="ac-card ac-login">
          <h1>Sem acesso</h1>
          <p className="ac-muted">Esta conta não é de dono de academia.</p>
          <LogoutBotao />
        </div>
      </div>
    )
  }
  return (
    <Suspense fallback={<Carregando />}>
      <Routes>
        <Route path="/recepcao" element={<AcademiaRecepcao />} />
        <Route path="*" element={<><Topo /><main className="ac-main">
          <Routes>
            <Route path="/" element={<AcademiaAlunos />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main></>} />
      </Routes>
    </Suspense>
  )
}

function LogoutBotao() {
  const { logout } = useAuth()
  return <button className="btn btn-secondary" onClick={logout}>Sair</button>
}

export default function AcademiaApp() {
  return (
    <BrowserRouter>
      <Portaria />
    </BrowserRouter>
  )
}
