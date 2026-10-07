import { useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import './academia.css'
import BotaoAbrirCatraca from './BotaoAbrirCatraca'

// academia.fwcinter.com — sistema da academia (mig 0276).
//   /           → alunos (cadastro com foto do rosto)
//   /pagamentos → mensalidades recebidas, fechamento do dia e do mês
//   /recepcao   → tablet da recepção: câmera reconhece e mostra se está em dia
//   /catraca    → descobre qual sinal destrava a catraca. FORA do menu: é de
//                 instalação, uma vez só; reconectar é na tela Porta.
//   /porta      → PC só abre a catraca quando o celular reconhece (câmera melhor)
//   /importar   → traz os alunos do sistema antigo (.json do backup). FORA do
//                 menu: é ferramenta nossa, de uma vez só; chega pelo endereço.
// Quem entra como ALUNO não vê nada disso: cai na área dele (AlunoApp), do
// mesmo jeito que o garçom cai no salão.

const AcademiaAlunos = lazy(() => import('./AcademiaAlunos'))
const AcademiaRecepcao = lazy(() => import('./AcademiaRecepcao'))
const AcademiaCatraca = lazy(() => import('./AcademiaCatraca'))
const AcademiaPorta = lazy(() => import('./AcademiaPorta'))
const AcademiaImportar = lazy(() => import('./AcademiaImportar'))
const AcademiaPagamentos = lazy(() => import('./AcademiaPagamentos'))
const AlunoApp = lazy(() => import('./AlunoApp'))

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
    // Aluno digita só a matrícula; o e-mail dele é interno.
    const digitado = email.trim()
    const usuario = digitado.includes('@') ? digitado : `${digitado}@aluno.fwcinter.com`
    const { error } = await login(usuario, senha)
    setEnviando(false)
    if (error) setErro('Matrícula/e-mail ou senha errados.')
  }

  return (
    <div className="ac-centro">
      <form className="ac-card ac-login" onSubmit={entrar}>
        <div className="ac-logo">🏋️</div>
        <h1>Academia</h1>
        <p className="ac-muted">Aluno: entre com a sua matrícula.</p>
        <label>E-mail ou matrícula
          <input autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
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
        <NavLink to="/pagamentos">Pagamentos</NavLink>
        <NavLink to="/recepcao">Recepção</NavLink>
        <NavLink to="/porta">Porta</NavLink>
      </nav>
      <BotaoAbrirCatraca />
      <button className="btn btn-secondary btn-sm" onClick={logout}>Sair</button>
    </header>
  )
}

function Portaria() {
  const { session, profile, empresa, loading, profileLoading } = useAuth()
  if (loading || (session && profileLoading && !profile)) return <Carregando />
  if (!session) return <EntrarAcademia />
  // Aluno: só a área dele, no mesmo endereço.
  if (profile?.perfil === 'aluno') {
    return (
      <Suspense fallback={<Carregando />}>
        <AlunoApp />
      </Suspense>
    )
  }
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
            <Route path="/pagamentos" element={<AcademiaPagamentos />} />
            <Route path="/catraca" element={<AcademiaCatraca />} />
            <Route path="/porta" element={<AcademiaPorta />} />
            <Route path="/importar" element={<AcademiaImportar />} />
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
