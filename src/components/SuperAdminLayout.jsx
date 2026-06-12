import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from './ThemeToggle'
import './Layout.css'

function HamburgerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

export default function SuperAdminLayout() {
  const { theme, toggleTheme } = useTheme()
  const { user, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  function closeMenu() { setMenuOpen(false) }

  return (
    <div className="layout">
      {/* Top bar mobile */}
      <div className="mobile-topbar">
        <button className="mobile-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
          <HamburgerIcon />
        </button>
        <span className="mobile-topbar-title">CRM · Super Admin</span>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      {/* Overlay */}
      <div
        className={`sidebar-overlay${menuOpen ? ' visible' : ''}`}
        onClick={closeMenu}
      />

      {/* Sidebar / drawer */}
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-title">Depósito CRM · Admin</div>
        <nav>
          <NavLink
            to="/super-admin"
            end
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Empresas
          </NavLink>
          <NavLink
            to="/super-admin/clientes"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Clientes
          </NavLink>
          <NavLink
            to="/super-admin/comissoes"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Comissões
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
