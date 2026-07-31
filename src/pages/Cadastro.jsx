import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { formatCnpj, cnpjValido } from '../lib/cnpj'
import ThemeToggle from '../components/ThemeToggle'
import './Login.css'

export default function Cadastro() {
  const { session, signup } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()

  const [nomeEmpresa, setNomeEmpresa] = useState('')
  const [cnpj, setCnpj] = useState('')
  const [nome, setNome] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [loading, setLoading] = useState(false)
  const [aceitouTermos, setAceitouTermos] = useState(false)

  if (session) {
    return <Navigate to="/" replace />
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!aceitouTermos) {
      setError('Você precisa ler e aceitar os Termos de Uso e a Política de Privacidade para continuar.')
      return
    }

    if (!cnpjValido(cnpj)) {
      setError('Informe um CNPJ válido — é ele que identifica sua loja nas integrações (iFood, nota fiscal).')
      return
    }

    if (password !== confirmPassword) {
      setError('As senhas não conferem.')
      return
    }

    if (password.length < 6) {
      setError('A senha precisa ter pelo menos 6 caracteres.')
      return
    }

    setLoading(true)
    const { error } = await signup(email, password, {
      nome,
      tipo_cadastro: 'empresa',
      nome_empresa: nomeEmpresa,
      cnpj: cnpj.replace(/\D/g, ''),
    })
    setLoading(false)

    if (error) {
      const msg = error.message ?? ''
      if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already been registered')) {
        setError('Este e-mail já tem uma conta. Faça login ou recupere sua senha clicando em "Esqueci minha senha" na tela de login.')
      } else {
        setError(msg)
      }
      return
    }

    setSuccess('Cadastro realizado! Você já pode entrar com seu e-mail e senha.')
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
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 2h8" />
              <path d="M9 2v6.5a2 2 0 0 1-.4 1.2L4.6 16a3 3 0 0 0 2.4 5h10a3 3 0 0 0 2.4-5l-4-6.3A2 2 0 0 1 15 8.5V2" />
              <path d="M6 14h12" />
            </svg>
          </span>
          <div>
            <h1>Depósito CRM</h1>
            <p className="login-subtitle">Cadastre sua empresa e comece grátis</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="nome-empresa">Nome da empresa</label>
            <input
              id="nome-empresa"
              type="text"
              placeholder="Ex: Depósito Boa Vista"
              value={nomeEmpresa}
              onChange={(e) => setNomeEmpresa(e.target.value)}
              autoComplete="organization"
              required
            />
          </div>

          <div className="form-field">
            <label htmlFor="cnpj">CNPJ</label>
            <input
              id="cnpj"
              type="text"
              placeholder="00.000.000/0000-00"
              value={cnpj}
              onChange={(e) => setCnpj(formatCnpj(e.target.value))}
              maxLength={18}
              inputMode="numeric"
              required
            />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              É o CNPJ da loja. Usamos ele pra ligar sua loja ao iFood e pra emitir nota.
            </span>
          </div>

          <div className="form-field">
            <label htmlFor="nome">Seu nome</label>
            <input
              id="nome"
              type="text"
              placeholder="Seu nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              autoComplete="name"
              required
            />
          </div>

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
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          <div className="form-field">
            <label htmlFor="confirm-password">Confirmar senha</label>
            <input
              id="confirm-password"
              type="password"
              placeholder="••••••••"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          {error && (
            <div className="login-error" role="alert">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="login-error" role="status" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
              <span>{success}</span>
            </div>
          )}

          {/* Bloco de termos */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '4px 0' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <a
                href="/termos"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--input-bg)', color: 'var(--text)',
                  fontSize: 13, fontWeight: 600, textDecoration: 'none', cursor: 'pointer',
                }}
              >
                📄 Termos de Uso
              </a>
              <a
                href="/privacidade"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--input-bg)', color: 'var(--text)',
                  fontSize: 13, fontWeight: 600, textDecoration: 'none', cursor: 'pointer',
                }}
              >
                🔒 Privacidade
              </a>
            </div>
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '12px 14px', borderRadius: 8,
              border: `1.5px solid ${aceitouTermos ? 'var(--primary)' : 'var(--border)'}`,
              background: aceitouTermos ? 'var(--primary-bg, #f5f0ff)' : 'var(--input-bg)',
              cursor: 'pointer', transition: 'all 0.15s',
            }}>
              <input
                type="checkbox"
                checked={aceitouTermos}
                onChange={e => { setAceitouTermos(e.target.checked); setError(null) }}
                style={{ marginTop: 2, accentColor: 'var(--primary)', width: 16, height: 16, flexShrink: 0, cursor: 'pointer' }}
              />
              <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text)' }}>
                Li e concordo com os <strong>Termos de Uso</strong> e a <strong>Política de Privacidade</strong> da plataforma FWC Inter.
              </span>
            </label>
          </div>

          <button type="submit" className="btn btn-primary login-submit" disabled={loading || !aceitouTermos}
            style={{ opacity: !aceitouTermos ? 0.5 : 1 }}>
            {loading ? (
              <>
                <span className="login-spinner" aria-hidden="true" />
                Cadastrando...
              </>
            ) : (
              'Criar empresa'
            )}
          </button>
        </form>

        <p className="login-footer">
          Já tem uma conta? <Link to="/login">Entrar</Link>
        </p>
      </div>

      <p className="login-footer">Depósito CRM &middot; Cadastro de empresas</p>
    </div>
  )
}
