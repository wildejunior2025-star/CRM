import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { moduloAtivo, moduloBloqueado } from '../lib/modulos'
import { homeDoPerfil } from '../lib/homeDoPerfil'
import CarregandoOuFalha from './CarregandoOuFalha'

export default function ProtectedRoute({ children, roles, modulo }) {
  const { session, profile, empresa, loading, profileLoading } = useAuth()
  const location = useLocation()

  // Espera a sessão e a 1ª busca do profile terminarem (sem travar para sempre
  // quando o usuário não tem profile — caso do login Google ainda não finalizado).
  // Este "Carregando..." era eterno: quando o servidor não responde, a busca da
  // sessão nunca volta e a tela roda pra sempre sem dizer nada (Supabase fora do
  // ar em 28/08/2026). Agora, passados 20s, ele descobre se é a internet daqui
  // ou o servidor, avisa, e volta sozinho quando der.
  if (loading || (session && profileLoading)) {
    return <CarregandoOuFalha />
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
