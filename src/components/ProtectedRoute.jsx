import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function ProtectedRoute({ children, roles }) {
  const { session, profile, loading } = useAuth()
  const location = useLocation()

  if (loading || (session && !profile)) {
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

  if (roles && !roles.includes(profile.perfil)) {
    const home = profile.perfil === 'cliente' ? '/portal' : '/'
    return <Navigate to={home} replace />
  }

  return children
}
