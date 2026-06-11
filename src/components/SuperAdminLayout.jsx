import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from './ThemeToggle'
import './Layout.css'

export default function SuperAdminLayout() {
  const { theme, toggleTheme } = useTheme()
  const { user, logout } = useAuth()

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-title">Depósito CRM · Admin</div>
        <nav>
          <NavLink
            to="/super-admin"
            end
            className={({ isActive }) =>
              isActive ? 'sidebar-link active' : 'sidebar-link'
            }
          >
            Empresas
          </NavLink>
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
        <Outlet />
      </main>
    </div>
  )
}
