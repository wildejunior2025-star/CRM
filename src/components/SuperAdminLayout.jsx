import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'
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
  const [nomePlataforma, setNomePlataforma] = useState('CRM · Super Admin')

  function closeMenu() { setMenuOpen(false) }

  useEffect(() => {
    supabase
      .from('configuracoes_plataforma')
      .select('valor')
      .eq('chave', 'nome_plataforma')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.valor) setNomePlataforma(`${data.valor} · Admin`)
      })
  }, [])

  return (
    <div className="layout">
      {/* Top bar mobile */}
      <div className="mobile-topbar">
        <button className="mobile-menu-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
          <HamburgerIcon />
        </button>
        <span className="mobile-topbar-title">{nomePlataforma}</span>
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      {/* Overlay */}
      <div
        className={`sidebar-overlay${menuOpen ? ' visible' : ''}`}
        onClick={closeMenu}
      />

      {/* Sidebar / drawer */}
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="sidebar-title">{nomePlataforma}</div>
        <nav>
          <NavLink
            to="/super-admin"
            end
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Dashboard
          </NavLink>
          <NavLink
            to="/super-admin/empresas"
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
          <NavLink
            to="/super-admin/whatsapp"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            WhatsApp IA
          </NavLink>
          <NavLink
            to="/super-admin/mlm"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Rede MLM
          </NavLink>
          <NavLink
            to="/super-admin/rede-mapa"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Mapa da Rede
          </NavLink>
          <NavLink
            to="/super-admin/empresa-rede"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Rede de Lojas
          </NavLink>
          <NavLink
            to="/super-admin/pagamentos"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Pagamentos
          </NavLink>
          <NavLink
            to="/super-admin/financeiro"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Financeiro
          </NavLink>
          <NavLink
            to="/super-admin/despesas"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Despesas do sistema
          </NavLink>
          <NavLink
            to="/super-admin/videos"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Vídeos tutoriais
          </NavLink>
          <NavLink
            to="/super-admin/config"
            className={({ isActive }) => isActive ? 'sidebar-link active' : 'sidebar-link'}
            onClick={closeMenu}
          >
            Configurações
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
