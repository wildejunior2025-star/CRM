import { useState } from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useBranding } from '../context/BrandingContext'
import { supabase } from '../lib/supabaseClient'
import ThemeToggle from '../components/ThemeToggle'
import './Login.css'

export default function Login() {
  const { session, login } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { empresaParceira } = useBranding()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const tipo = searchParams.get('tipo') // null | 'cliente' | 'empresa'

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
    const { error } = await supabase.auth.resetPasswordForEmail(recuperarEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setRecuperarLoading(false)
    if (error) { setRecuperarErro(error.message); return }
    setRecuperarEnviado(true)
  }

  if (session) {
    const from = location.state?.from?.pathname ?? '/'
    return <Navigate to={from} replace />
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await login(email, password)

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    if (tipo) {
      const { data: { session: s } } = await supabase.auth.getSession()
      if (s) {
        const { data: prof } = await supabase
          .from('profiles')
          .select('perfil')
          .eq('id', s.user.id)
          .maybeSingle()

        if (prof) {
          if (tipo === 'cliente' && prof.perfil !== 'cliente') {
            await supabase.auth.signOut()
            setError('Este e-mail pertence a uma conta de empresa. Use a "Área da Empresa" para entrar.')
            setLoading(false)
            return
          }
          if (tipo === 'empresa' && prof.perfil === 'cliente') {
            await supabase.auth.signOut()
            setError('Este e-mail pertence a uma conta de cliente. Use a "Área do Cliente" para entrar.')
            setLoading(false)
            return
          }
        }
      }
    }

    setLoading(false)
  }

  const brandLogo = empresaParceira?.logo_url ? (
    <img
      src={empresaParceira.logo_url}
      alt={empresaParceira.nome}
      style={{ height: 48, width: 48, objectFit: 'contain', borderRadius: 10 }}
    />
  ) : (
    <span className="login-logo" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2h8" />
        <path d="M9 2v6.5a2 2 0 0 1-.4 1.2L4.6 16a3 3 0 0 0 2.4 5h10a3 3 0 0 0 2.4-5l-4-6.3A2 2 0 0 1 15 8.5V2" />
        <path d="M6 14h12" />
      </svg>
    </span>
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
              <h1>Depósito CRM</h1>
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

        <p className="login-footer">Depósito CRM &middot; Acesso restrito</p>
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
      : 'Área da Empresa'
  const subtitulo = isCliente
    ? 'Entre com seu e-mail e senha'
    : 'Entre com seu e-mail e senha'

  return (
    <div className="login-page">
      <div className="login-theme-toggle">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      <div className={cardClass}>
        {/* Botão voltar — só aparece quando veio de ?tipo= (não em domínio de loja) */}
        {tipo && !empresaParceira && (
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
              Digite seu e-mail e enviaremos um link para redefinir sua senha.
            </p>
            <div className="form-field">
              <label htmlFor="rec-email">E-mail</label>
              <input
                id="rec-email"
                type="email"
                placeholder="voce@exemplo.com"
                value={recuperarEmail}
                onChange={e => setRecuperarEmail(e.target.value)}
                autoComplete="email"
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
              <label htmlFor="email">E-mail</label>
              <input
                id="email"
                type="email"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
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
          </form>
        )}

        {empresaParceira ? (
          /* Domínio exclusivo de loja → só cria conta de cliente */
          <p className="login-footer">
            Ainda não tem conta? <Link to="/cadastro-cliente">Criar conta</Link>
          </p>
        ) : (
          /* Veio de ?tipo= → link de volta para escolha */
          <p className="login-footer" style={{ textAlign: 'center' }}>
            <Link to="/login">Escolher outro tipo de acesso</Link>
          </p>
        )}
      </div>

      <p className="login-footer">Depósito CRM &middot; Acesso restrito</p>
    </div>
  )
}
