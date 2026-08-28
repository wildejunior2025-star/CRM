import { useState } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useBranding } from '../context/BrandingContext'
import { supabase } from '../lib/supabaseClient'
import { pareceQuedaDeRede, mensagemDeQueda } from '../lib/diagnosticoConexao'
import ThemeToggle from '../components/ThemeToggle'
import { logoFwcIcone as logoFwc, isPortalDomain } from '../lib/logoFwc'
import './Login.css'

// Botão "Entrar com Google" oculto por enquanto — religar trocando para true.
const MOSTRAR_GOOGLE = false

export default function Login() {
  const { session, login, loading: authLoading } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { empresaParceira, plataformaLogoUrl } = useBranding()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const tipoParam = searchParams.get('tipo') // ?tipo= explícito na URL
  // Cada subdomínio abre direto na área certa, sem a tela de escolha:
  //   app.fwcinter.com    → cliente (portal/app)
  //   portal.fwcinter.com → empresa (CRM das lojas)
  //   admin.fwcinter.com  → empresa (super admin entra pela mesma porta; o perfil decide)
  const HOST_TIPO = {
    'app.fwcinter.com': 'cliente',
    'portal.fwcinter.com': 'empresa',
    'admin.fwcinter.com': 'empresa',
    'gestor.fwcinter.com': 'gestor', // Painel de Pedidos em domínio próprio
    'entregas.fwcinter.com': 'entregador', // Tela do entregador em domínio próprio
  }
  const tipo = tipoParam || HOST_TIPO[window.location.hostname] || null

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const [modoRecuperar, setModoRecuperar] = useState(false)
  const [recuperarEmail, setRecuperarEmail] = useState('')
  const [recuperarLoading, setRecuperarLoading] = useState(false)
  const [recuperarEnviado, setRecuperarEnviado] = useState(false)
  const [recuperarErro, setRecuperarErro] = useState(null)

  async function handleRecuperar(e) {
    e.preventDefault()
    setRecuperarLoading(true)
    setRecuperarErro(null)

    let recEmail = recuperarEmail.trim()
    if (!recEmail.includes('@')) {
      const { data: found } = await supabase.rpc('get_email_by_username', { p_username: recEmail.toLowerCase() })
      if (!found) {
        setRecuperarErro('Apelido não encontrado. Tente com seu e-mail.')
        setRecuperarLoading(false)
        return
      }
      recEmail = found
    }

    const { error } = await supabase.auth.resetPasswordForEmail(recEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setRecuperarLoading(false)
    if (error) { setRecuperarErro(error.message); return }
    setRecuperarEnviado(true)
  }

  if (authLoading) {
    return (
      <div className="auth-loading">
        <span className="auth-loading-spinner" aria-hidden="true" />
        <span>Carregando...</span>
      </div>
    )
  }

  if (session) {
    if (tipo === 'cliente') return <Navigate to="/portal" replace />
    if (tipo === 'gestor')  return <Navigate to="/painel" replace />
    if (tipo === 'entregador') return <Navigate to="/entregas" replace />
    const from = location.state?.from?.pathname ?? '/'
    return <Navigate to={from} replace />
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    let loginEmail = email.trim()

    // Se não parece email, trata como apelido e busca o email real
    if (!loginEmail.includes('@')) {
      const { data: foundEmail, error: rpcErr } = await supabase.rpc('get_email_by_username', {
        p_username: loginEmail.toLowerCase()
      })
      if (rpcErr || !foundEmail) {
        // Servidor fora do ar não é apelido errado. Acusar a pessoa de digitar
        // errado quando o pedido nem chegou ao servidor faz ela repetir o login
        // dez vezes procurando um erro que não existe.
        setError(pareceQuedaDeRede(rpcErr)
          ? await mensagemDeQueda()
          : 'Apelido não encontrado. Verifique ou use seu e-mail.')
        setLoading(false)
        return
      }
      loginEmail = foundEmail
    }

    const { error } = await login(loginEmail, password)

    // "Failed to fetch" não quer dizer nada pra quem está na loja: troca pela
    // explicação de quem é a culpa (a internet daqui ou o servidor).
    if (error) setError(pareceQuedaDeRede(error) ? await mensagemDeQueda() : error.message)
    setLoading(false)
  }

  async function handleGoogleLogin() {
    const redirectTo = window.location.origin + (tipo === 'cliente' || empresaParceira ? '/portal' : '/')
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
  }

  const brandLogo = empresaParceira?.logo_url ? (
    <img
      src={empresaParceira.logo_url}
      alt={empresaParceira.nome}
      style={{ height: 48, width: 48, objectFit: 'contain', borderRadius: 10 }}
    />
  ) : (
    <img
      src={isPortalDomain ? logoFwc : (plataformaLogoUrl || logoFwc)}
      alt="FWC Inter"
      style={{ height: 48, width: 48, objectFit: 'contain', borderRadius: 10 }}
    />
  )

  // Tela de escolha — só exibida quando não há ?tipo= e não é domínio exclusivo de loja
  if (!tipo && !empresaParceira) {
    return (
      <div className="login-page">
        <div className="login-theme-toggle">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>

        <div className="login-card">
          <div className="login-brand">
            {brandLogo}
            <div>
              <h1>FWC Inter</h1>
              <p className="login-subtitle">Como você quer entrar?</p>
            </div>
          </div>

          <div className="login-tipo-botoes">
            <Link to="/login?tipo=cliente" className="login-tipo-btn login-tipo-cliente">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
              <div>
                <strong>Área do Cliente</strong>
                <span>Acompanhe pedidos e fiado</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Link>

            <Link to="/login?tipo=empresa" className="login-tipo-btn login-tipo-empresa">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="7" width="20" height="15" rx="2" />
                <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                <line x1="12" y1="12" x2="12" y2="12.01" />
                <path d="M8 12h.01M16 12h.01" />
              </svg>
              <div>
                <strong>Área da Empresa</strong>
                <span>Sistema de gestão</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Link>

            <Link to="/login?tipo=gestor" className="login-tipo-btn login-tipo-gestor">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                <rect x="9" y="3" width="6" height="4" rx="1"/>
                <path d="M9 12h6M9 16h4"/>
              </svg>
              <div>
                <strong>Gestor de Pedidos</strong>
                <span>Receber e gerenciar pedidos</span>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Link>
          </div>

          <div className="login-separador">
            <span>Não tem conta?</span>
          </div>

          <div className="login-cadastro-btns">
            <Link to="/cadastro" className="login-cadastro-btn">
              <span className="login-cadastro-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" />
                  <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
                </svg>
              </span>
              <span>
                <strong>Quero ser empresa</strong>
                <small>Cadastrar no CRM</small>
              </span>
            </Link>
            <Link to="/cadastro-cliente" className="login-cadastro-btn">
              <span className="login-cadastro-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                </svg>
              </span>
              <span>
                <strong>Quero ser cliente</strong>
                <small>Criar conta grátis</small>
              </span>
            </Link>
          </div>
        </div>

        <p className="login-footer">FWC Inter &middot; Acesso restrito</p>
      </div>
    )
  }

  // Formulário de login — exibido quando há ?tipo= ou em domínio exclusivo de loja
  const isCliente = tipo === 'cliente' || !!empresaParceira
  const cardClass = `login-card${isCliente ? ' login-card-cliente' : ''}`
  const titulo = empresaParceira?.nome
    ? empresaParceira.nome
    : isCliente
      ? 'Área do Cliente'
      : tipo === 'gestor'
        ? 'Gestor de Pedidos'
        : tipo === 'entregador'
          ? 'Área do Entregador'
          : 'Área da Empresa'
  const subtitulo = 'Entre com seu apelido ou e-mail'

  return (
    <div className="login-page">
      <div className="login-theme-toggle">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      <div className={cardClass}>
        {/* Botão voltar — só aparece quando veio da tela de escolha (?tipo=), não em subdomínio dedicado */}
        {tipoParam && !empresaParceira && (
          <Link to="/login" className="login-back-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Voltar
          </Link>
        )}

        <div className="login-brand">
          {brandLogo}
          <div>
            <h1>{titulo}</h1>
            <p className="login-subtitle">{subtitulo}</p>
          </div>
        </div>

        {modoRecuperar ? (
          <form className="login-form" onSubmit={handleRecuperar}>
            <p className="login-recuperar-info">
              Digite seu apelido ou e-mail e enviaremos um link para redefinir sua senha.
            </p>
            <div className="form-field">
              <label htmlFor="rec-email">Apelido ou e-mail</label>
              <input
                id="rec-email"
                type="text"
                placeholder="apelido ou voce@exemplo.com"
                value={recuperarEmail}
                onChange={e => setRecuperarEmail(e.target.value)}
                autoComplete="username email"
                required
              />
            </div>

            {recuperarErro && (
              <div className="login-error" role="alert">
                <span>{recuperarErro}</span>
              </div>
            )}

            {recuperarEnviado ? (
              <div className="login-error" role="status" style={{ background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success)' }}>
                Link enviado! Verifique sua caixa de entrada (e o spam).
              </div>
            ) : (
              <button type="submit" className="btn btn-primary login-submit" disabled={recuperarLoading}>
                {recuperarLoading ? <><span className="login-spinner" aria-hidden="true" />Enviando...</> : 'Enviar link'}
              </button>
            )}

            <button type="button" className="login-back-btn" style={{ alignSelf: 'center', marginTop: 4 }} onClick={() => { setModoRecuperar(false); setRecuperarEnviado(false); setRecuperarErro(null) }}>
              ← Voltar ao login
            </button>
          </form>
        ) : (
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="form-field">
              <label htmlFor="email">Apelido ou e-mail</label>
              <input
                id="email"
                type="text"
                placeholder="apelido ou voce@exemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username email"
                required
              />
            </div>

            <div className="form-field">
              <label htmlFor="password">
                <span>Senha</span>
                <button type="button" className="login-esqueci" onClick={() => { setModoRecuperar(true); setRecuperarEmail(email) }}>
                  Esqueci minha senha
                </button>
              </label>
              <div className="login-password-wrapper">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                      <path d="M2 2l20 20" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="login-error" role="alert">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <button type="submit" className="btn btn-primary login-submit" disabled={loading}>
              {loading ? (
                <><span className="login-spinner" aria-hidden="true" />Entrando...</>
              ) : 'Entrar'}
            </button>

            {MOSTRAR_GOOGLE && (
              <>
                <div className="login-ou">
                  <span>ou</span>
                </div>

                <button type="button" className="login-google-btn" onClick={handleGoogleLogin}>
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  Entrar com Google
                </button>
              </>
            )}
          </form>
        )}

        {empresaParceira ? (
          /* Domínio exclusivo de loja → só cria conta de cliente */
          <p className="login-footer">
            Ainda não tem conta? <Link to="/cadastro-cliente">Criar conta</Link>
          </p>
        ) : (
          <div className="login-footer" style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {tipo === 'empresa' && (
              <span>Quer cadastrar sua empresa? <Link to="/cadastro">Criar conta da empresa</Link></span>
            )}
            {tipo === 'cliente' && (
              <span>Ainda não tem conta? <Link to="/cadastro-cliente">Criar conta grátis</Link></span>
            )}
            {/* "Escolher outro tipo" só faz sentido quando veio da tela de escolha (?tipo=), não nos subdomínios dedicados */}
            {tipoParam && (
              <Link to="/login">Escolher outro tipo de acesso</Link>
            )}
          </div>
        )}
      </div>

      <p className="login-footer">FWC Inter &middot; Acesso restrito</p>
    </div>
  )
}
