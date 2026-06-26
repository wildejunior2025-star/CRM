import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import ThemeToggle from '../components/ThemeToggle'
import './Login.css'

export default function CadastroAdmin() {
  const { empresaId } = useParams()
  const { session, signup } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()

  const [nome, setNome]               = useState('')
  const [email, setEmail]             = useState('')
  const [password, setPassword]       = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [telefone, setTelefone]       = useState('')
  const [cnpj, setCnpj]               = useState('')
  const [razaoSocial, setRazaoSocial] = useState('')
  const [endereco, setEndereco]       = useState('')
  const [error, setError]             = useState(null)
  const [success, setSuccess]         = useState(null)
  const [loading, setLoading]         = useState(false)

  if (session) return <Navigate to="/" replace />

  function formatCnpj(v) {
    return v.replace(/\D/g, '')
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2')
      .slice(0, 18)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (password !== confirmPassword) { setError('As senhas não conferem.'); return }
    if (password.length < 6) { setError('A senha precisa ter pelo menos 6 caracteres.'); return }

    setLoading(true)
    const { error } = await signup(email, password, {
      nome,
      tipo_cadastro: 'admin_empresa',
      empresa_id:    empresaId,
      telefone:      telefone || undefined,
      cnpj:          cnpj || undefined,
      razao_social:  razaoSocial || undefined,
      endereco:      endereco || undefined,
    })
    setLoading(false)

    if (error) { setError(error.message); return }

    setSuccess('Conta criada! Verifique seu e-mail para confirmar e poder entrar.')
    setTimeout(() => navigate('/login'), 2500)
  }

  return (
    <div className="login-page">
      <div className="login-theme-toggle">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      <div className="login-card">
        <div className="login-brand">
          <span className="login-logo" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2h8" />
              <path d="M9 2v6.5a2 2 0 0 1-.4 1.2L4.6 16a3 3 0 0 0 2.4 5h10a3 3 0 0 0 2.4-5l-4-6.3A2 2 0 0 1 15 8.5V2" />
              <path d="M6 14h12" />
            </svg>
          </span>
          <div>
            <h1>Depósito CRM</h1>
            <p className="login-subtitle">Criar conta de administrador</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '4px 0 8px' }}>
            Dados de acesso
          </div>

          <div className="form-field">
            <label htmlFor="nome">Seu nome</label>
            <input id="nome" type="text" placeholder="Seu nome completo" value={nome}
              onChange={e => setNome(e.target.value)} autoComplete="name" required />
          </div>

          <div className="form-field">
            <label htmlFor="email">E-mail</label>
            <input id="email" type="email" placeholder="voce@exemplo.com" value={email}
              onChange={e => setEmail(e.target.value)} autoComplete="email" required />
          </div>

          <div className="form-field">
            <label htmlFor="password">Senha</label>
            <input id="password" type="password" placeholder="••••••••" value={password}
              onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
          </div>

          <div className="form-field">
            <label htmlFor="confirm-password">Confirmar senha</label>
            <input id="confirm-password" type="password" placeholder="••••••••" value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '16px 0 8px' }}>
            Dados da empresa <span style={{ fontWeight: 400, textTransform: 'none' }}>(opcional)</span>
          </div>

          <div className="form-field">
            <label htmlFor="razao_social">Razão social</label>
            <input id="razao_social" type="text" placeholder="Nome jurídico da empresa" value={razaoSocial}
              onChange={e => setRazaoSocial(e.target.value)} />
          </div>

          <div className="form-field">
            <label htmlFor="cnpj">CNPJ</label>
            <input id="cnpj" type="text" placeholder="00.000.000/0000-00" value={cnpj}
              onChange={e => setCnpj(formatCnpj(e.target.value))} maxLength={18} />
          </div>

          <div className="form-field">
            <label htmlFor="telefone">Telefone / WhatsApp</label>
            <input id="telefone" type="tel" placeholder="(84) 99999-9999" value={telefone}
              onChange={e => setTelefone(e.target.value)} autoComplete="tel" />
          </div>

          <div className="form-field">
            <label htmlFor="endereco">Endereço da loja</label>
            <input id="endereco" type="text" placeholder="Rua, número, bairro, cidade" value={endereco}
              onChange={e => setEndereco(e.target.value)} />
          </div>

          {error && (
            <div className="login-error" role="alert">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="login-error" role="status" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
              <span>{success}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary login-submit" disabled={loading}>
            {loading ? (<><span className="login-spinner" aria-hidden="true" />Criando conta...</>) : 'Criar conta'}
          </button>
        </form>

        <p className="login-footer">
          Já tem uma conta? <Link to="/login">Entrar</Link>
        </p>
      </div>

      <p className="login-footer">Depósito CRM &middot; Acesso de administrador</p>
    </div>
  )
}
