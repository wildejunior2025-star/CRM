import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from './ThemeToggle'
import './Layout.css'

const links = [
  { to: '/portal', label: 'Catálogo', end: true },
  { to: '/portal/pedidos', label: 'Meus pedidos' },
  { to: '/portal/fiado', label: 'Meu fiado' },
]

export default function PortalLayout() {
  const { theme, toggleTheme } = useTheme()
  const { user, profile, logout } = useAuth()

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-title">Depósito CRM</div>
        <nav>
          {links.map((link) => (
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
                {profile?.nome || user.email}
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
        <Outlet />
      </main>
    </div>
  )
}
