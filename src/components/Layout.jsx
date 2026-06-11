import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import ThemeToggle from './ThemeToggle'
import './Layout.css'

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/vendas', label: 'Vendas' },
  { to: '/clientes', label: 'Clientes' },
  { to: '/produtos', label: 'Produtos' },
  { to: '/estoque', label: 'Estoque' },
]

export default function Layout() {
  const { theme, toggleTheme } = useTheme()

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
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
