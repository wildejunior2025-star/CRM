import { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useBranding } from '../context/BrandingContext'
import InstallPWA from './InstallPWA'
import CompletarCadastro from './CompletarCadastro'
import { logoFwcIcone as logoIconeUrl, isPortalDomain } from '../lib/logoFwc'
import ModalEndereco from './ModalEndereco'
import { getEnderecoAtivo, LS_ATIVO } from '../utils/enderecoPortal'
import './PortalLayout.css'

function endLinha1(end) {
  if (!end) return null
  const partes = [end.endereco, end.numero].filter(Boolean)
  return partes.join(', ') || end.cep || null
}

function endLinha2(end) {
  if (!end) return null
  const partes = [end.bairro, end.cidade].filter(Boolean)
  return partes.join(', ') || null
}

export default function PortalLayout() {
  const { theme, toggleTheme } = useTheme()
  const { empresaParceira, plataformaLogoUrl } = useBranding()
  const logoSrc = isPortalDomain ? logoIconeUrl : (plataformaLogoUrl || logoIconeUrl)
  const { voltarSuperAdmin: voltarAuth, session, logout, profile, loading, user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  // Usuário que entrou pelo Google ganha só nome/e-mail (sem apelido, telefone,
  // endereço nem senha). Obriga a completar esses dados antes de usar o app.
  const veioDoGoogle =
    user?.app_metadata?.provider === 'google' ||
    (Array.isArray(user?.app_metadata?.providers) && user.app_metadata.providers.includes('google'))
  const precisaCompletarCadastro =
    !loading && !!session && veioDoGoogle && (
      // Login social novo ainda não tem profile (só é criado ao finalizar)
      !profile ||
      // Google antigo: tem profile de cliente, mas faltam dados obrigatórios
      (profile.perfil === 'cliente' &&
        (!profile.username || !profile.telefone || !profile.endereco || !profile.numero))
    )

  const [temBackupSuperAdmin, setTemBackupSuperAdmin] = useState(
    () => !!localStorage.getItem('crm_superadmin_backup')
  )
  const [clienteNome, setClienteNome] = useState(
    () => localStorage.getItem('crm_superadmin_cliente_nome') || 'cliente'
  )

  // Endereço ativo no header
  const [enderecoAtivo, setEnderecoAtivo] = useState(() => getEnderecoAtivo())
  const [showEnderecoModal, setShowEnderecoModal] = useState(false)

  // Carrinho do portal (lê todas as chaves sacola_portal_* do localStorage)
  const [totalCarrinho, setTotalCarrinho] = useState(0)
  const [lojaCarrinhoId, setLojaCarrinhoId] = useState(null)

  function lerCarrinhoLS() {
    let total = 0
    let lojaId = null
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('sacola_portal_')) {
        try {
          const obj = JSON.parse(localStorage.getItem(key) || '{}')
          const qtd = Object.values(obj).reduce((s, q) => s + Number(q), 0)
          if (qtd > 0) {
            total += qtd
            lojaId = key.replace('sacola_portal_', '')
          }
        } catch {} // eslint-disable-line no-empty
      }
    }
    setTotalCarrinho(total)
    setLojaCarrinhoId(lojaId)
  }

  useEffect(() => {
    lerCarrinhoLS()
    window.addEventListener('storage', lerCarrinhoLS)
    window.addEventListener('endereco-portal-changed', lerCarrinhoLS)
    window.addEventListener('carrinho-portal-changed', lerCarrinhoLS)
    return () => {
      window.removeEventListener('storage', lerCarrinhoLS)
      window.removeEventListener('endereco-portal-changed', lerCarrinhoLS)
      window.removeEventListener('carrinho-portal-changed', lerCarrinhoLS)
    }
  }, [])

  // Sincroniza quando o endereço muda na mesma aba (CustomEvent) ou em outra aba (storage)
  useEffect(() => {
    function atualizarEndereco(e) {
      // Evento nativo `storage` traz e.key; CustomEvent não — lemos direto do localStorage
      if (e instanceof StorageEvent) {
        if (e.key !== LS_ATIVO) return
        try { setEnderecoAtivo(JSON.parse(e.newValue)) } catch { setEnderecoAtivo(null) }
      } else {
        setEnderecoAtivo(getEnderecoAtivo())
      }
    }
    window.addEventListener('storage', atualizarEndereco)
    window.addEventListener('endereco-portal-changed', atualizarEndereco)
    return () => {
      window.removeEventListener('storage', atualizarEndereco)
      window.removeEventListener('endereco-portal-changed', atualizarEndereco)
    }
  }, [])

  useEffect(() => {
    setTemBackupSuperAdmin(!!localStorage.getItem('crm_superadmin_backup'))
    setClienteNome(localStorage.getItem('crm_superadmin_cliente_nome') || 'cliente')
  }, [session])

  async function handleVoltarSuperAdmin() {
    const ok = await voltarAuth()
    localStorage.removeItem('crm_superadmin_cliente_nome')
    setTemBackupSuperAdmin(false)
    if (ok) navigate('/super-admin/clientes')
  }

  // Nav dinâmica: no domínio exclusivo da loja, "Lojas" vira "Catálogo" e aponta pro catálogo dela
  const navLinks = empresaParceira
    ? [
        { to: `/portal/loja/${empresaParceira.id}`, label: 'Catálogo', end: false, Icon: IconLojas },
        { to: '/portal/pedidos', label: 'Pedidos', end: false, Icon: IconPedidos },
        { to: '/portal/indicacoes', label: 'Pontos', end: false, Icon: IconIndicar },
        { to: '/portal/perfil', label: 'Perfil', end: false, Icon: IconPerfil },
      ]
    : [
        { to: '/portal', label: 'Lojas', end: true, Icon: IconLojas },
        { to: '/portal/pedidos', label: 'Pedidos', end: false, Icon: IconPedidos },
        { to: '/portal/indicacoes', label: 'Pontos', end: false, Icon: IconIndicar },
        { to: '/portal/perfil', label: 'Perfil', end: false, Icon: IconPerfil },
      ]

  const pageTitle = empresaParceira
    ? (location.pathname.includes('/pedidos') ? 'Meus pedidos'
      : location.pathname.includes('/perfil') ? 'Meu perfil'
      : empresaParceira.nome)
    : (location.pathname.includes('/pedidos') ? 'Meus pedidos'
      : location.pathname.includes('/perfil') ? 'Meu perfil'
      : 'FWC Inter')

  // Portão: bloqueia o app até o usuário Google completar o cadastro
  if (precisaCompletarCadastro) {
    return <CompletarCadastro onConcluido={() => navigate('/portal', { replace: true })} />
  }

  return (
    <div className="portal-root">
      {/* Modal de endereço acessível de qualquer página */}
      {showEnderecoModal && (
        <ModalEndereco
          onClose={() => setShowEnderecoModal(false)}
          onSalvo={(end) => setEnderecoAtivo(end)}
        />
      )}

      {temBackupSuperAdmin && (
        <button className="impersonate-fab" onClick={handleVoltarSuperAdmin} title={`Voltar ao Super Admin (${clienteNome})`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
          <span>Admin</span>
        </button>
      )}
      <header className="portal-header">
        <div className="portal-header-brand">
          {empresaParceira?.logo_url ? (
            <>
              <img
                src={empresaParceira.logo_url}
                alt={empresaParceira.nome}
                style={{ height: 32, width: 32, objectFit: 'contain', borderRadius: 6 }}
              />
              <span className="portal-header-title">{pageTitle}</span>
            </>
          ) : (
            <>
              <img
                src={logoSrc}
                alt="FWC Inter"
                style={{ height: 44, width: 44, objectFit: 'contain', flexShrink: 0, borderRadius: 12 }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
                <span style={{
                  fontSize: 26, fontWeight: 900, letterSpacing: '-0.5px',
                  color: '#fff',
                }}>
                  FWC <span style={{ color: '#c4b5fd' }}>Inter</span>
                </span>
                {pageTitle !== 'FWC Inter' && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, marginTop: 1 }}>
                    {pageTitle}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        <div className="portal-header-actions">
          <button
            className="portal-header-addr"
            onClick={() => setShowEnderecoModal(true)}
            aria-label={enderecoAtivo ? 'Alterar endereço' : 'Adicionar endereço'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 10c0 6-8 13-8 13s-8-7-8-13a8 8 0 0 1 16 0Z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            <span className="portal-header-addr-text">
              {enderecoAtivo ? endLinha1(enderecoAtivo) : 'Endereço'}
            </span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <button className="portal-theme-btn" onClick={toggleTheme} aria-label="Alternar tema">
            {theme === 'dark'
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            }
          </button>
          <button className="portal-theme-btn" onClick={logout} aria-label="Sair da conta" title="Sair">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </header>

      <main className="portal-content">
        <Outlet />
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
        {totalCarrinho > 0 && (
          <button
            className="portal-nav-item portal-nav-sacola"
            onClick={() => lojaCarrinhoId && navigate(`/portal/loja/${lojaCarrinhoId}`)}
            aria-label="Sacola"
          >
            <span className="portal-nav-sacola-icon">
              <IconSacola />
              <span className="portal-nav-sacola-badge">
                {totalCarrinho > 9 ? '9+' : totalCarrinho}
              </span>
            </span>
            <span>Sacola</span>
          </button>
        )}
      </nav>

      <InstallPWA />
    </div>
  )
}

function IconSacola() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
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

function IconPerfil() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  )
}

function IconIndicar() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  )
}
