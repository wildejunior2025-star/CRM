import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuth } from './hooks/useAuth'

const PUBLIC_PREFIXES = ['/login', '/cadastro', '/reset-password', '/entrar', '/termos', '/privacidade', '/lojas', '/loja/', '/checkout', '/pedido/', '/cadastro-cliente', '/cadastro-admin', '/cadastro-vendedor', '/mesa/']

function HostnameRedirect() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { profile, loading } = useAuth()
  useEffect(() => {
    if (loading) return
    const h = window.location.hostname
    const isPublic = PUBLIC_PREFIXES.some(p => pathname.startsWith(p))
    if (isPublic) return
    const perfil = profile?.perfil

    // Vendedor só usa o gestor de pedidos (/painel), em qualquer domínio
    if (perfil === 'vendedor') {
      if (!pathname.startsWith('/painel') && pathname !== '/login') navigate('/painel', { replace: true })
      return
    }

    if (h === 'app.fwcinter.com') {
      // Domínio do app é exclusivo do cliente. Admin/vendedor de empresa que
      // caírem aqui (ex.: impersonação por magic link) usam o CRM nas rotas raiz;
      // super_admin vai para a área dele. Só o cliente (ou não logado) vai ao portal.
      if (perfil === 'admin' || perfil === 'vendedor' || perfil === 'garcom' || perfil === 'cozinheiro') return
      if (perfil === 'super_admin') {
        if (!pathname.startsWith('/super-admin')) navigate('/super-admin', { replace: true })
        return
      }
      if (!pathname.startsWith('/portal')) navigate('/portal', { replace: true })
    } else if (h === 'admin.fwcinter.com') {
      // Admin/vendedor impersonado não pode ser forçado para /super-admin (geraria loop):
      // usa o CRM da empresa nas rotas raiz.
      if (perfil === 'admin' || perfil === 'vendedor' || perfil === 'garcom' || perfil === 'cozinheiro') return
      if (perfil === 'cliente') {
        // Super admin "entrar como cliente": mantém no mesmo domínio (backup p/ voltar funciona por origem).
        if (localStorage.getItem('crm_superadmin_backup')) {
          if (!pathname.startsWith('/portal')) navigate('/portal', { replace: true })
          return
        }
        // Cliente de verdade pertence ao app, não ao painel admin → manda pro domínio do app.
        // (Antes ia pra /super-admin e entrava em loop com o ProtectedRoute → tela branca.)
        window.location.replace('https://app.fwcinter.com/portal')
        return
      }
      if (!pathname.startsWith('/super-admin') && pathname !== '/login') {
        navigate('/super-admin', { replace: true })
      }
    } else if (h === 'gestor.fwcinter.com' && !pathname.startsWith('/painel') && pathname !== '/login') {
      navigate('/painel', { replace: true })
    }
  }, [pathname, navigate, profile, loading])
  return null
}
import { AuthProvider } from './context/AuthContext'
import { BrandingProvider } from './context/BrandingContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import PortalLayout from './components/PortalLayout'
import SuperAdminLayout from './components/SuperAdminLayout'
import Login from './pages/Login'
import Cadastro from './pages/Cadastro'
import CadastroCliente from './pages/CadastroCliente'
import Dashboard from './pages/Dashboard'
import Clientes from './pages/Clientes'
import Produtos from './pages/Produtos'
import Estoque from './pages/Estoque'
import Vendas from './pages/Vendas'
import Caixa from './pages/Caixa'
import Financeiro from './pages/Financeiro'
import Relatorios from './pages/Relatorios'
import Usuarios from './pages/Usuarios'
import PortalHome from './pages/PortalHome'
import PortalLoja from './pages/PortalLoja'
import PortalPedidos from './pages/PortalPedidos'
import PortalPerfil from './pages/PortalPerfil'
import PortalFiado from './pages/PortalFiado'
import PortalIndicacoes from './pages/PortalIndicacoes'
import SuperAdminDashboard from './pages/SuperAdminDashboard'
import SuperAdminMLM from './pages/SuperAdminMLM'
import SuperAdminEmpresas from './pages/SuperAdminEmpresas'
import SuperAdminClientes from './pages/SuperAdminClientes'
import SuperAdminComissoes from './pages/SuperAdminComissoes'
import SuperAdminWhatsApp from './pages/SuperAdminWhatsApp'
import SuperAdminConfig from './pages/SuperAdminConfig'
import SuperAdminPagamentos from './pages/SuperAdminPagamentos'
import SuperAdminRedeMapa from './pages/SuperAdminRedeMapa'
import SuperAdminEmpresaRede from './pages/SuperAdminEmpresaRede'
import SuperAdminFinanceiro from './pages/SuperAdminFinanceiro'
import CadastroRef from './pages/CadastroRef'
import CadastroAdmin from './pages/CadastroAdmin'
import CadastroVendedor from './pages/CadastroVendedor'
import MinhaLoja from './pages/MinhaLoja'
import PedidosDelivery from './pages/PedidosDelivery'
import PainelPedidos from './pages/PainelPedidos'
import PainelEntregador from './pages/PainelEntregador'
import ResetPassword from './pages/ResetPassword'
import WhatsAppConfig from './pages/WhatsAppConfig'
import BotTeste from './pages/BotTeste'
import DeliveryLojas from './pages/DeliveryLojas'
import DeliveryLoja from './pages/DeliveryLoja'
import DeliveryCheckout from './pages/DeliveryCheckout'
import DeliveryPedido from './pages/DeliveryPedido'
import RaioEntrega from './pages/RaioEntrega'
import WhatsAppCreditos from './pages/WhatsAppCreditos'
import Termos from './pages/Termos'
import Privacidade from './pages/Privacidade'
import ServicoPresencial from './pages/ServicoPresencial'
import PresencialMesas from './pages/PresencialMesas'
import PresencialSalao from './pages/PresencialSalao'
import PresencialCozinha from './pages/PresencialCozinha'
import PresencialHistorico from './pages/PresencialHistorico'
import PresencialReservas from './pages/PresencialReservas'
import MesaCardapio from './pages/MesaCardapio'

export default function App() {
  // lojaonline.fwcinter.com — vitrine pública da loja (sem login).
  // lojaonline.fwcinter.com/{slug} abre o catálogo daquela loja.
  const isLojaOnline = typeof window !== 'undefined'
    && window.location.hostname === 'lojaonline.fwcinter.com'

  if (isLojaOnline) {
    return (
      <BrandingProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<DeliveryLojas />} />
            <Route path="/lojas" element={<DeliveryLojas />} />
            <Route path="/checkout" element={<DeliveryCheckout />} />
            <Route path="/pedido/:id" element={<DeliveryPedido />} />
            <Route path="/mesa/:token" element={<MesaCardapio />} />
            {/* Link antigo por id (ex: loja sem slug) — resolve por id no DeliveryLoja */}
            <Route path="/loja/:id" element={<DeliveryLoja />} />
            <Route path="/:slug" element={<DeliveryLoja />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
      </BrandingProvider>
    )
  }

  return (
    <BrandingProvider>
    <AuthProvider>
      <BrowserRouter>
        <HostnameRedirect />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/cadastro" element={<Cadastro />} />
          <Route path="/termos" element={<Termos />} />
          <Route path="/privacidade" element={<Privacidade />} />
          <Route path="/lojas" element={<DeliveryLojas />} />
          <Route path="/loja/:id" element={<DeliveryLoja />} />
          <Route path="/checkout" element={<DeliveryCheckout />} />
          <Route path="/pedido/:id" element={<DeliveryPedido />} />
          {/* Autoatendimento por QR da mesa (público, sem login) */}
          <Route path="/mesa/:token" element={<MesaCardapio />} />
          {/* Link de indicação unificado — pergunta "sou cliente ou loja" */}
          <Route path="/entrar" element={<CadastroRef />} />
          {/* Cadastro de cliente livre (sem empresa) */}
          <Route path="/cadastro-cliente" element={<CadastroCliente />} />
          {/* Cadastro de cliente via convite de empresa (link antigo ainda funciona) */}
          <Route path="/cadastro-cliente/:empresaId" element={<CadastroCliente />} />
          <Route path="/cadastro-admin/:empresaId" element={<CadastroAdmin />} />
          <Route path="/cadastro-vendedor/:empresaId" element={<CadastroVendedor />} />

          <Route
            element={
              <ProtectedRoute roles={['super_admin']}>
                <SuperAdminLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/super-admin" element={<SuperAdminDashboard />} />
            <Route path="/super-admin/empresas" element={<SuperAdminEmpresas />} />
            <Route path="/super-admin/clientes" element={<SuperAdminClientes />} />
            <Route path="/super-admin/comissoes" element={<SuperAdminComissoes />} />
            <Route path="/super-admin/whatsapp" element={<SuperAdminWhatsApp />} />
            <Route path="/super-admin/mlm" element={<SuperAdminMLM />} />
            <Route path="/super-admin/config" element={<SuperAdminConfig />} />
            <Route path="/super-admin/pagamentos" element={<SuperAdminPagamentos />} />
            <Route path="/super-admin/rede-mapa" element={<SuperAdminRedeMapa />} />
            <Route path="/super-admin/empresa-rede" element={<SuperAdminEmpresaRede />} />
            <Route path="/super-admin/financeiro" element={<SuperAdminFinanceiro />} />
          </Route>

          <Route
            element={
              <ProtectedRoute roles={['admin', 'garcom', 'cozinheiro']}>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<ProtectedRoute roles={['admin', 'vendedor']}><Dashboard /></ProtectedRoute>} />
            <Route path="clientes" element={<ProtectedRoute modulo="clientes"><Clientes /></ProtectedRoute>} />
            <Route path="vendas" element={<ProtectedRoute modulo="vendas"><Vendas /></ProtectedRoute>} />
            <Route path="caixa" element={<ProtectedRoute modulo="caixa"><Caixa /></ProtectedRoute>} />
            <Route path="relatorios" element={<ProtectedRoute modulo="relatorios"><Relatorios /></ProtectedRoute>} />
            <Route
              path="produtos"
              element={<ProtectedRoute roles={['admin']} modulo="produtos"><Produtos /></ProtectedRoute>}
            />
            <Route
              path="estoque"
              element={<ProtectedRoute roles={['admin']} modulo="estoque"><Estoque /></ProtectedRoute>}
            />
            <Route
              path="financeiro"
              element={<ProtectedRoute roles={['admin']} modulo="financeiro"><Financeiro /></ProtectedRoute>}
            />
            <Route
              path="minha-loja"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><MinhaLoja /></ProtectedRoute>}
            />
            <Route
              path="raio-entrega"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><RaioEntrega /></ProtectedRoute>}
            />
            <Route
              path="presencial"
              element={<ProtectedRoute roles={['admin']} modulo="presencial"><ServicoPresencial /></ProtectedRoute>}
            />
            <Route
              path="presencial/mesas"
              element={<ProtectedRoute roles={['admin']} modulo="presencial"><PresencialMesas /></ProtectedRoute>}
            />
            <Route
              path="presencial/salao"
              element={<ProtectedRoute roles={['admin', 'garcom']}><PresencialSalao /></ProtectedRoute>}
            />
            <Route
              path="presencial/cozinha"
              element={<ProtectedRoute roles={['admin', 'cozinheiro']}><PresencialCozinha /></ProtectedRoute>}
            />
            <Route
              path="presencial/historico"
              element={<ProtectedRoute roles={['admin']} modulo="presencial"><PresencialHistorico /></ProtectedRoute>}
            />
            <Route
              path="presencial/reservas"
              element={<ProtectedRoute roles={['admin', 'garcom']} modulo="presencial"><PresencialReservas /></ProtectedRoute>}
            />
            <Route
              path="pedidos-delivery"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><PedidosDelivery /></ProtectedRoute>}
            />
            <Route
              path="whatsapp"
              element={<ProtectedRoute roles={['admin', 'super_admin']} modulo="whatsapp"><WhatsAppConfig /></ProtectedRoute>}
            />
            <Route
              path="whatsapp-creditos"
              element={<ProtectedRoute roles={['admin']} modulo="whatsapp"><WhatsAppCreditos /></ProtectedRoute>}
            />
            <Route
              path="bot-teste"
              element={<ProtectedRoute roles={['admin', 'super_admin']} modulo="whatsapp"><BotTeste /></ProtectedRoute>}
            />
            <Route
              path="usuarios"
              element={<ProtectedRoute roles={['admin']} modulo="funcionarios"><Usuarios /></ProtectedRoute>}
            />
          </Route>

          {/* Gestor de pedidos — tela autônoma, sem sidebar (vendedor fica só aqui) */}
          <Route
            path="/painel"
            element={
              <ProtectedRoute roles={['admin', 'super_admin', 'vendedor']}>
                <PainelPedidos />
              </ProtectedRoute>
            }
          />

          {/* Tela do entregador — autônoma, mobile (entregador fica só aqui) */}
          <Route
            path="/entregas"
            element={
              <ProtectedRoute roles={['entregador', 'admin', 'super_admin']}>
                <PainelEntregador />
              </ProtectedRoute>
            }
          />

          <Route
            path="/portal"
            element={
              <ProtectedRoute>
                <PortalLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<PortalHome />} />
            <Route path="loja/:empresaId" element={<PortalLoja />} />
            <Route path="pedidos" element={<PortalPedidos />} />
            <Route path="perfil" element={<PortalPerfil />} />
            <Route path="fiado" element={<PortalFiado />} />
            <Route path="indicacoes" element={<PortalIndicacoes />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </BrandingProvider>
  )
}
