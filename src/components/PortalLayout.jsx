import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useBranding } from '../context/BrandingContext'
import SubscriptionGate from './SubscriptionGate'
import InstallPWA from './InstallPWA'
import './PortalLayout.css'

export default function PortalLayout() {
  const { theme, toggleTheme } = useTheme()
  const { empresaParceira } = useBranding()
  const location = useLocation()

  // Nav dinâmica: no domínio exclusivo da loja, "Lojas" vira "Catálogo" e aponta pro catálogo dela
  const navLinks = empresaParceira
    ? [
        { to: `/portal/loja/${empresaParceira.id}`, label: 'Catálogo', end: false, Icon: IconLojas },
        { to: '/portal/pedidos', label: 'Pedidos', end: false, Icon: IconPedidos },
      ]
    : [
        { to: '/portal', label: 'Lojas', end: true, Icon: IconLojas },
        { to: '/portal/pedidos', label: 'Pedidos', end: false, Icon: IconPedidos },
      ]

  const pageTitle = empresaParceira
    ? (location.pathname.includes('/pedidos') ? 'Meus pedidos' : empresaParceira.nome)
    : (location.pathname === '/portal' ? 'Escolha uma loja'
      : location.pathname.includes('/pedidos') ? 'Meus pedidos' : 'Loja')

  return (
    <div className="portal-root">
      <header className="portal-header">
        <div className="portal-header-brand">
          {empresaParceira?.logo_url ? (
            <img
              src={empresaParceira.logo_url}
              alt={empresaParceira.nome}
              style={{ height: 32, width: 32, objectFit: 'contain', borderRadius: 6 }}
            />
          ) : (
            <span className="portal-header-logo" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <path d="M16 10a4 4 0 0 1-8 0"/>
              </svg>
            </span>
          )}
          <span className="portal-header-title">{pageTitle}</span>
        </div>
        <button className="portal-theme-btn" onClick={toggleTheme} aria-label="Alternar tema">
          {theme === 'dark'
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          }
        </button>
      </header>

      <main className="portal-content">
        <SubscriptionGate />
      </main>

      <nav className="portal-bottom-nav">
        {navLinks.map(({ to, label, end, Icon }) => (
          <NavLink
            key={label}
            to={to}
            end={end}
            className={({ isActive }) => `portal-nav-item${isActive ? ' active' : ''}`}
          >
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <InstallPWA />
    </div>
  )
}

function IconLojas() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  )
}

function IconPedidos() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  )
}
