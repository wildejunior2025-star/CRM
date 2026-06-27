import { useState } from 'react'
import { NavLink, useLocation, useNavigate, useMatch } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../hooks/useAuth'
import { moduloAtivo } from '../lib/modulos'
import ThemeToggle from './ThemeToggle'
import SubscriptionGate from './SubscriptionGate'
import InstallPWA from './InstallPWA'
import NotificationBell from './NotificationBell'
import './Layout.css'

// `mod` liga o item a uma funcionalidade que o Super Admin pode desligar por loja
// (ver src/lib/modulos.js). Itens sem `mod` (Dashboard) ficam sempre visíveis.
const links = [
  { group: 'Operações' },
  { to: '/', label: 'Dashboard', end: true, roles: ['admin'] },
  { to: '/vendas', label: 'Vendas', roles: ['admin', 'vendedor'], mod: 'vendas' },
  { to: '/caixa', label: 'Caixa', roles: ['admin', 'vendedor'], mod: 'caixa' },
  { to: '/clientes', label: 'Clientes', roles: ['admin'], mod: 'clientes' },
  { to: '/usuarios', label: 'Funcionários', roles: ['admin'], mod: 'funcionarios' },
  {
    to: '/presencial', label: 'Serviço Presencial', roles: ['admin'], mod: 'presencial',
    children: [
      { to: '/presencial/salao', label: 'Salão', roles: ['admin'] },
      { to: '/presencial/cozinha', label: 'Cozinha (KDS)', roles: ['admin'] },
      { to: '/presencial/historico', label: 'Histórico', roles: ['admin'] },
      { to: '/presencial/mesas', label: 'Mesas', roles: ['admin'] },
    ],
  },
  // Garçom vê o Salão; a Cozinha é só do cozinheiro (vendedor só usa o /painel)
  { to: '/presencial/salao', label: 'Salão', roles: ['garcom'], mod: 'presencial' },
  { to: '/presencial/cozinha', label: 'Cozinha (KDS)', roles: ['cozinheiro'], mod: 'presencial' },

  { group: 'Catálogo' },
  { to: '/produtos', label: 'Catálogo', roles: ['admin'], mod: 'produtos' },
  { to: '/estoque', label: 'Estoque', roles: ['admin'], mod: 'estoque' },

  { group: 'Delivery' },
  {
    to: '/minha-loja', label: 'Minha Loja', roles: ['admin'], mod: 'delivery',
    children: [
      { to: '/raio-entrega', label: 'Raio de Entrega', roles: ['admin'] },
    ],
  },
  { to: '/pedidos-delivery', label: 'Pedidos Delivery', roles: ['admin'], mod: 'delivery' },

  { group: 'Automação' },
  { to: '/whatsapp', label: 'WhatsApp', roles: ['admin', 'super_admin'], mod: 'whatsapp' },
  { to: '/whatsapp-creditos', label: 'Créditos Bot', roles: ['admin'], mod: 'whatsapp' },
  { to: '/bot-teste', label: 'Teste Bot', roles: ['admin', 'super_admin'], mod: 'whatsapp' },

  { group: 'Financeiro' },
  { to: '/financeiro', label: 'Financeiro', roles: ['admin'], mod: 'financeiro' },
  { to: '/relatorios', label: 'Relatórios', roles: ['admin'], mod: 'relatorios' },
]

function ChevronDown({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  )
}

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
  const [expandidos, setExpandidos] = useState(() => new Set(['/minha-loja', '/presencial']))

  function toggleExpandido(to) {
    setExpandidos(prev => {
      const next = new Set(prev)
      next.has(to) ? next.delete(to) : next.add(to)
      return next
    })
  }

  const temBackupSuperAdmin = !!localStorage.getItem('crm_superadmin_backup')

  async function handleVoltarSuperAdmin() {
    const ok = await voltarSuperAdmin()
    if (ok) navigate('/super-admin')
  }

  // Filtra por papel do usuário E por funcionalidade ligada/desligada da loja.
  const porPerfilEModulo = links.filter(
    (link) => link.group || (link.roles?.includes(profile?.perfil) && moduloAtivo(empresa, link.mod))
  )
  // Remove cabeçalhos de grupo que ficaram sem nenhum item visível abaixo.
  const visibleLinks = porPerfilEModulo.filter((link, i) => {
    if (!link.group) return true
    const proximo = porPerfilEModulo[i + 1]
    return !!proximo && !proximo.group
  })

  function closeMenu() { setMenuOpen(false) }

  return (
    <div className="layout">
      {temBackupSuperAdmin && (
        <button className="impersonate-fab" onClick={handleVoltarSuperAdmin} title="Voltar ao Super Admin">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
          <span>Admin</span>
        </button>
      )}

      {/* Top bar — só visível no mobile */}
      <div className="mobile-topbar">
        <button className="mobile-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
          <HamburgerIcon />
        </button>
        <span className="mobile-topbar-title">{empresa?.nome || 'CRM'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <NotificationBell />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
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
          {visibleLinks.map((link, i) =>
            link.group ? (
              <span key={`g-${i}`} className="sidebar-group-label">{link.group}</span>
            ) : link.children ? (
              <div key={link.to}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <NavLink
                    to={link.to}
                    end={link.end}
                    className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
                    onClick={closeMenu}
                    style={{ flex: 1 }}
                  >
                    {link.label}
                  </NavLink>
                  <button
                    type="button"
                    onClick={() => toggleExpandido(link.to)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', padding: '6px 8px',
                      borderRadius: 6, display: 'flex', alignItems: 'center',
                      transition: 'transform 150ms',
                      transform: expandidos.has(link.to) ? 'rotate(0deg)' : 'rotate(-90deg)',
                    }}
                    aria-label="Expandir"
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
                {expandidos.has(link.to) && (
                  <div style={{ paddingLeft: 12 }}>
                    {link.children
                      .filter(c => c.roles?.includes(profile?.perfil))
                      .map(child => (
                        <NavLink
                          key={child.to}
                          to={child.to}
                          className={({ isActive }) => isActive ? 'sidebar-link sidebar-sublink active' : 'sidebar-link sidebar-sublink'}
                          onClick={closeMenu}
                        >
                          <span style={{ marginRight: 6, opacity: 0.5, fontSize: 10 }}>└</span>
                          {child.label}
                        </NavLink>
                      ))
                    }
                  </div>
                )}
              </div>
            ) : (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
                onClick={closeMenu}
              >
                {link.label}
              </NavLink>
            )
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-notif-row">
            <NotificationBell />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
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
        </div>
      </aside>

      <main className="content">
        <SubscriptionGate />
      </main>

      <InstallPWA />
    </div>
  )
}
