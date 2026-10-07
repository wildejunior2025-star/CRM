import { useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabaseClient'
import TecladoPin from './TecladoPin'
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

// Entrada da academia. O ALUNO digita só o telefone e depois os 4 números
// no teclado — as bolinhas lembram sozinhas que a senha tem 4 dígitos. Quem é
// da academia (dono, recepção) entra pelo e-mail, no "Sou da academia".
function EntrarAcademia() {
  const { login } = useAuth()
  const [modo, setModo] = useState('telefone') // telefone | senha | academia
  const [telefone, setTelefone] = useState('')
  const [contaEmail, setContaEmail] = useState('')
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState(null)
  const [enviando, setEnviando] = useState(false)

  // Passo 1: telefone → acha a conta do aluno.
  async function procurar(e) {
    e.preventDefault()
    const digitos = telefone.replace(/\D/g, '')
    if (digitos.length < 8) return setErro('Digite o telefone com DDD.')
    setEnviando(true)
    setErro(null)
    const { data } = await supabase.rpc('academia_email_do_aluno', { p_busca: digitos })
    setEnviando(false)
    if (!data) {
      setErro('Não achei esse telefone. Confira com a recepção.')
      return
    }
    setContaEmail(data)
    setModo('senha')
  }

  // Passo 2: os 4 números.
  async function entrarComPin(pin) {
    setEnviando(true)
    setErro(null)
    const { error } = await login(contaEmail, pin)
    setEnviando(false)
    // Nada de afirmar "são os 4 últimos do celular": quem já trocou a senha
    // acha que o sistema perdeu a dele (visto com o usuário em 08/10).
    if (error) setErro('Senha errada. Se você esqueceu, a recepção redefine pra você.')
  }

  async function entrarAcademia(e) {
    e.preventDefault()
    setEnviando(true)
    setErro(null)
    const { error } = await login(email.trim(), senha)
    setEnviando(false)
    if (error) setErro('E-mail ou senha errados.')
  }

  if (modo === 'senha') {
    return (
      <TecladoPin
        titulo="Sua senha"
        subtitulo="4 números"
        erro={erro}
        carregando={enviando}
        onCompleto={entrarComPin}
        onVoltar={() => { setModo('telefone'); setErro(null) }}
      />
    )
  }

  if (modo === 'academia') {
    return (
      <div className="ac-centro">
        <form className="ac-card ac-login" onSubmit={entrarAcademia}>
          <div className="ac-logo">🏋️</div>
          <h1>Academia</h1>
          <p className="ac-muted">Entre com a conta da academia.</p>
          <label>E-mail
            <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
          </label>
          <label>Senha
            <input type="password" autoComplete="current-password" value={senha} onChange={e => setSenha(e.target.value)} required />
          </label>
          {erro && <div className="ac-erro">{erro}</div>}
          <button className="btn btn-primary" disabled={enviando}>{enviando ? 'Entrando...' : 'Entrar'}</button>
          <button type="button" className="ac-link" onClick={() => { setModo('telefone'); setErro(null) }}>
            Sou aluno
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="ac-centro">
      <form className="ac-card ac-login" onSubmit={procurar}>
        <div className="ac-logo">🏋️</div>
        <h1>Academia</h1>
        <p className="ac-muted">Digite o seu telefone pra entrar.</p>
        <label>Telefone
          <input
            inputMode="tel" autoComplete="tel" autoFocus placeholder="(84) 99999-9999"
            value={telefone} onChange={e => setTelefone(e.target.value)} required
          />
        </label>
        {erro && <div className="ac-erro">{erro}</div>}
        <button className="btn btn-primary" disabled={enviando}>{enviando ? 'Procurando...' : 'Entrar'}</button>
        <button type="button" className="ac-link" onClick={() => { setModo('academia'); setErro(null) }}>
          Sou da academia
        </button>
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
