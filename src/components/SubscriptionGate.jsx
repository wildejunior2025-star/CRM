import { Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import './SubscriptionGate.css'

export default function SubscriptionGate() {
  const { profile, empresa } = useAuth()

  if (profile?.perfil === 'super_admin') {
    return <Outlet />
  }

  if (!empresa) {
    return (
      <div className="subscription-block">
        <h1>Conta sem empresa vinculada</h1>
        <p>Sua conta ainda não está vinculada a uma empresa neste sistema.</p>
        <p>Entre em contato com o administrador para liberar o acesso.</p>
      </div>
    )
  }

  if (empresa.status === 'suspenso' || empresa.status === 'cancelado') {
    return (
      <div className="subscription-block">
        <h1>Assinatura {empresa.status === 'suspenso' ? 'suspensa' : 'cancelada'}</h1>
        <p>O acesso de <strong>{empresa.nome}</strong> está bloqueado.</p>
        <p>Entre em contato com o suporte para regularizar a assinatura.</p>
      </div>
    )
  }

  return (
    <>
      {empresa.status === 'atrasado' && (
        <div className="subscription-banner">
          A assinatura de <strong>{empresa.nome}</strong> está atrasada. Regularize o pagamento para evitar a suspensão do acesso.
        </div>
      )}
      <Outlet />
    </>
  )
}
