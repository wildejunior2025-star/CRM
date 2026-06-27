import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { moduloAtivo } from '../lib/modulos'

export default function ProtectedRoute({ children, roles, modulo }) {
  const { session, profile, empresa, loading, profileLoading } = useAuth()
  const location = useLocation()

  // Espera a sessão e a 1ª busca do profile terminarem (sem travar para sempre
  // quando o usuário não tem profile — caso do login Google ainda não finalizado).
  if (loading || (session && profileLoading)) {
    return (
      <div className="auth-loading">
        <span className="auth-loading-spinner" aria-hidden="true" />
        <span>Carregando...</span>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  // Rotas com papel exigido: usuário sem profile (Google não finalizado) não entra.
  if (roles && (!profile || !roles.includes(profile.perfil))) {
    let home = '/portal'
    if (profile?.perfil === 'super_admin') home = '/super-admin'
    else if (profile?.perfil === 'admin') home = '/'
    else if (profile?.perfil === 'vendedor') home = '/painel'
    else if (profile?.perfil === 'garcom') home = '/presencial/salao'
    else if (profile?.perfil === 'cozinheiro') home = '/presencial/cozinha'
    else if (profile?.perfil === 'entregador') home = '/entregas'
    return <Navigate to={home} replace />
  }

  // Funcionalidade desligada para esta loja pelo Super Admin → fora.
  if (modulo && !moduloAtivo(empresa, modulo)) {
    return <Navigate to="/" replace />
  }

  return children
}
