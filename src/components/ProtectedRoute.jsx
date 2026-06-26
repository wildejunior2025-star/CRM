import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function ProtectedRoute({ children, roles }) {
  const { session, profile, loading, profileLoading } = useAuth()
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
    else if (profile?.perfil === 'admin' || profile?.perfil === 'vendedor') home = '/'
    else if (profile?.perfil === 'garcom') home = '/presencial/salao'
    else if (profile?.perfil === 'cozinheiro') home = '/presencial/cozinha'
    return <Navigate to={home} replace />
  }

  return children
}
