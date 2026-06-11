import { NavLink } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from './ThemeToggle'
import SubscriptionGate from './SubscriptionGate'
import './Layout.css'

const links = [
  { to: '/', label: 'Dashboard', end: true, roles: ['admin', 'vendedor'] },
  { to: '/vendas', label: 'Vendas', roles: ['admin', 'vendedor'] },
  { to: '/caixa', label: 'Caixa', roles: ['admin', 'vendedor'] },
  { to: '/financeiro', label: 'Financeiro', roles: ['admin'] },
  { to: '/relatorios', label: 'Relatórios', roles: ['admin', 'vendedor'] },
  { to: '/clientes', label: 'Clientes', roles: ['admin', 'vendedor'] },
  { to: '/produtos', label: 'Produtos', roles: ['admin'] },
  { to: '/estoque', label: 'Estoque', roles: ['admin'] },
  { to: '/usuarios', label: 'Usuários', roles: ['admin'] },
]

export default function Layout() {
  const { theme, toggleTheme } = useTheme()
  const { user, profile, logout } = useAuth()

  const visibleLinks = links.filter((link) => link.roles.includes(profile?.perfil))

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-title">Depósito CRM</div>
        <nav>
          {visibleLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                isActive ? 'sidebar-link active' : 'sidebar-link'
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {user && (
            <div className="sidebar-user">
              <span className="sidebar-user-email" title={user.email}>
                {user.email}
              </span>
              <button type="button" className="btn btn-secondary btn-sm sidebar-logout" onClick={logout}>
                Sair
              </button>
            </div>
          )}
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </aside>
      <main className="content">
        <SubscriptionGate />
      </main>
    </div>
  )
}
