import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../hooks/useAuth'
import ThemeToggle from './ThemeToggle'
import SubscriptionGate from './SubscriptionGate'
import InstallPWA from './InstallPWA'
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

function HamburgerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  )
}

export default function Layout() {
  const { theme, toggleTheme } = useTheme()
  const { user, profile, empresa, logout, voltarSuperAdmin } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  const temBackupSuperAdmin = !!localStorage.getItem('crm_superadmin_backup')

  async function handleVoltarSuperAdmin() {
    const ok = await voltarSuperAdmin()
    if (ok) navigate('/super-admin')
  }

  const visibleLinks = links.filter((link) => link.roles.includes(profile?.perfil))

  function closeMenu() { setMenuOpen(false) }

  return (
    <div className={`layout${temBackupSuperAdmin ? ' layout-has-banner' : ''}`}>
      {/* Banner de impersonação — position fixed, não afeta o flex layout */}
      {temBackupSuperAdmin && (
        <div className="impersonate-banner">
          <span>Visualizando: <strong>{empresa?.nome ?? 'empresa'}</strong></span>
          <button onClick={handleVoltarSuperAdmin}>← Voltar ao Super Admin</button>
        </div>
      )}

      {/* Top bar — só visível no mobile */}
      <div className="mobile-topbar">
        <button className="mobile-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
          <HamburgerIcon />
        </button>
        <span className="mobile-topbar-title">{empresa?.nome || 'CRM'}</span>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      {/* Overlay escuro */}
      <div
        className={`sidebar-overlay${menuOpen ? ' visible' : ''}`}
        onClick={closeMenu}
      />

      {/* Sidebar / drawer */}
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-title">{empresa?.nome || 'CRM'}</div>
        <nav>
          {visibleLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
              onClick={closeMenu}
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

      <InstallPWA />
    </div>
  )
}
