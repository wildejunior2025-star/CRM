import { useEffect, useState, lazy, Suspense } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabaseClient'
import './ligacoes.css'

// /ligacoes — telemarketing da FWC (mig 0292). Bloco isolado: não usa profile nem
// o resto do sistema. Quem entra:
//   super_admin            → painel do dono (visitas, leads, atendentes, importar)
//   linha em tm_atendentes → tela de ligação da atendente
// Qualquer outra conta vê "sem acesso".

const TelaLigacao = lazy(() => import('./TelaLigacao'))
const AdminLigacoes = lazy(() => import('./AdminLigacoes'))

function Carregando() {
  return <div className="lg-centro-tela lg-muted">Carregando...</div>
}

function Entrar() {
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
    <div className="lg-centro-tela">
      <form className="lg-card lg-login" onSubmit={entrar}>
        <div className="lg-logo">📞</div>
        <h1>Ligações FWC</h1>
        <p className="lg-muted">Entre com o e-mail e a senha que o Wilde passou pra você.</p>
        <label>E-mail
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>Senha
          <input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required />
        </label>
        {erro && <div className="lg-erro">{erro}</div>}
        <button className="btn btn-primary" disabled={enviando}>{enviando ? 'Entrando...' : 'Entrar'}</button>
      </form>
    </div>
  )
}

export default function LigacoesApp() {
  const { session, profile, loading, profileLoading, logout } = useAuth()
  // Guarda de QUEM é a resposta: se outra conta entrar no mesmo aparelho, a
  // resposta da anterior não vale.
  const [achado, setAchado] = useState(null) // { id, dados } — dados null = não é atendente

  const userId = session?.user?.id
  const souAdmin = profile?.perfil === 'super_admin'
  const atendente = achado && achado.id === userId ? achado.dados : undefined // undefined = procurando

  useEffect(() => {
    if (!userId || souAdmin) return
    let ativo = true
    supabase.from('tm_atendentes').select('nome, ativo').eq('user_id', userId).maybeSingle()
      .then(({ data }) => { if (ativo) setAchado({ id: userId, dados: data?.ativo ? data : null }) })
    return () => { ativo = false }
  }, [userId, souAdmin])

  // Atendente não tem profile: o AuthContext religa o profileLoading a cada
  // evento de sessão (o aparelho voltando de outro app, por exemplo). Se a tela
  // desmontasse a cada vez, ela piscaria e perderia o que foi preenchido. Depois
  // que a conta já foi reconhecida, esses eventos não derrubam mais a tela.
  const emAtualizacao = session && profileLoading && !profile && atendente === undefined
  if (loading || emAtualizacao) return <Carregando />
  if (!session) return <Entrar />

  if (souAdmin) {
    return <Suspense fallback={<Carregando />}><AdminLigacoes onSair={logout} /></Suspense>
  }
  if (atendente === undefined) return <Carregando />
  if (atendente === null) {
    return (
      <div className="lg-centro-tela">
        <div className="lg-card lg-login">
          <h1>Sem acesso</h1>
          <p className="lg-muted">Essa conta não é de atendente. Fale com o Wilde.</p>
          <button className="btn btn-secondary" onClick={logout}>Sair</button>
        </div>
      </div>
    )
  }
  return <Suspense fallback={<Carregando />}><TelaLigacao nome={atendente.nome} onSair={logout} /></Suspense>
}
