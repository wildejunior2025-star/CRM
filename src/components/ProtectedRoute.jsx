import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { moduloAtivo, moduloBloqueado } from '../lib/modulos'
import { homeDoPerfil } from '../lib/homeDoPerfil'

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
    return <Navigate to={homeDoPerfil(profile?.perfil)} replace />
  }

  // Bloqueado pelo plano → tela de upgrade (não é erro, é oferta).
  // Vale também pra quem digita a URL na mão: o cadeado do menu sozinho não
  // segura ninguém, o bloqueio de verdade é aqui.
  if (modulo && moduloBloqueado(empresa, modulo)) {
    return <Navigate to={`/upgrade?mod=${modulo}`} replace />
  }

  // Funcionalidade oculta para esta loja pelo Super Admin → fora, sem alarde.
  if (modulo && !moduloAtivo(empresa, modulo)) {
    return <Navigate to="/" replace />
  }

  return children
}
