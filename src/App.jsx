import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useEffect, lazy, Suspense } from 'react'
import { useAuth } from './hooks/useAuth'

/* ── Telas que só carregam quando alguém entra nelas ────────────────────
 * O sistema inteiro era UM arquivo de 2 MB: quem abria o gestor baixava
 * junto o cardápio do cliente, o checkout, o app do entregador, o portal e
 * o super admin — telas que ele nunca abre. No celular e em internet ruim
 * isso é a demora da abertura.
 *
 * Estas 30 estão marcadas com `lazy`: ficam num pedaço separado, buscado só
 * quando a rota é aberta. Todas são de OUTRO perfil (cliente, entregador,
 * super admin) ou de outro subdomínio, então nenhuma delas divide sessão com
 * o gestor. As telas do gestor continuam vindo juntas, como antes.
 *
 * De quebra: com o código em pedaços, mudar uma tela troca só o pedaço dela.
 * Antes qualquer mudança renomeava o arquivo único e TODO aparelho baixava
 * os 2 MB outra vez a cada deploy.
 */

// Enquanto o pedaço da tela chega. Fica no lugar do conteúdo, sem piscar a
// página inteira nem mexer no que já está desenhado em volta.
function TelaCarregando() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', padding: 24, color: 'var(--text-muted, #9aa0b5)', fontSize: 14 }}>
      Carregando...
    </div>
  )
}

const PUBLIC_PREFIXES = ['/login', '/cadastro', '/reset-password', '/entrar', '/termos', '/privacidade', '/excluir-conta', '/lojas', '/loja/', '/checkout', '/pedido/', '/cadastro-cliente', '/cadastro-admin', '/cadastro-vendedor', '/mesa/', '/c/']

// Domínios em que a raiz "/" mostra a landing de marketing (visitante deslogado).
// Nos subdomínios (app./admin./gestor./lojaonline.) a raiz mantém o fluxo antigo.
function isDominioLanding() {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'fwcinter.com' || h === 'www.fwcinter.com' || h === 'localhost' || h === '127.0.0.1'
}

// Element da raiz "/": deslogado no domínio principal → landing de vendas;
// caso contrário, comportamento atual (CRM protegido com Layout).
function LayoutOrLanding() {
  const { session, loading } = useAuth()
  const { pathname } = useLocation()
  const naRaiz = pathname === '/'
  if (naRaiz && isDominioLanding() && !loading && !session) {
    return <Landing />
  }
  return (
    <ProtectedRoute roles={['admin', 'garcom', 'cozinheiro']}>
      <Layout />
    </ProtectedRoute>
  )
}

function HostnameRedirect() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { profile, empresa, loading } = useAuth()
  useEffect(() => {
    if (loading) return
    const h = window.location.hostname
    const isPublic = PUBLIC_PREFIXES.some(p => pathname.startsWith(p))
    if (isPublic) return
    const perfil = profile?.perfil

    // Super admin SEM loja não usa o gestor (/painel é por loja): sai sozinho pro
    // painel dele. Se estiver impersonando uma loja (tem empresa), deixa usar.
    if (perfil === 'super_admin' && !empresa && pathname.startsWith('/painel')) {
      if (!pathname.startsWith('/super-admin')) navigate('/super-admin', { replace: true })
      return
    }

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
    } else if (h === 'gestor.fwcinter.com') {
      // Super admin sem loja fica no painel dele (pra escolher qual loja entrar);
      // o guard lá em cima já cuida. Os demais vão pro gestor de pedidos.
      if (perfil === 'super_admin' && !empresa) {
        if (!pathname.startsWith('/super-admin')) navigate('/super-admin', { replace: true })
      } else if (!pathname.startsWith('/painel') && pathname !== '/login') {
        navigate('/painel', { replace: true })
      }
    }
  }, [pathname, navigate, profile, empresa, loading])
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
import Upgrade from './pages/Upgrade'
const SuperAdminVideos = lazy(() => import('./pages/SuperAdminVideos'))
import Clientes from './pages/Clientes'
import Produtos from './pages/Produtos'
import CategoriasComplemento from './pages/CategoriasComplemento'
import FichaTecnica from './pages/FichaTecnica'
import Estoque from './pages/Estoque'
import Caixa from './pages/Caixa'
import Financeiro from './pages/Financeiro'
import Relatorios from './pages/Relatorios'
import Usuarios from './pages/Usuarios'
const PortalHome = lazy(() => import('./pages/PortalHome'))
const PortalLoja = lazy(() => import('./pages/PortalLoja'))
const PortalPedidos = lazy(() => import('./pages/PortalPedidos'))
const PortalPerfil = lazy(() => import('./pages/PortalPerfil'))
const PortalFiado = lazy(() => import('./pages/PortalFiado'))
const PortalIndicacoes = lazy(() => import('./pages/PortalIndicacoes'))
const SuperAdminDashboard = lazy(() => import('./pages/SuperAdminDashboard'))
const SuperAdminMLM = lazy(() => import('./pages/SuperAdminMLM'))
const SuperAdminEmpresas = lazy(() => import('./pages/SuperAdminEmpresas'))
const SuperAdminClientes = lazy(() => import('./pages/SuperAdminClientes'))
const SuperAdminComissoes = lazy(() => import('./pages/SuperAdminComissoes'))
const SuperAdminWhatsApp = lazy(() => import('./pages/SuperAdminWhatsApp'))
const SuperAdminConfig = lazy(() => import('./pages/SuperAdminConfig'))
const SuperAdminPagamentos = lazy(() => import('./pages/SuperAdminPagamentos'))
const SuperAdminRedeMapa = lazy(() => import('./pages/SuperAdminRedeMapa'))
const SuperAdminEmpresaRede = lazy(() => import('./pages/SuperAdminEmpresaRede'))
const SuperAdminFinanceiro = lazy(() => import('./pages/SuperAdminFinanceiro'))
const SuperAdminDespesas = lazy(() => import('./pages/SuperAdminDespesas'))
import CadastroRef from './pages/CadastroRef'
import CadastroAdmin from './pages/CadastroAdmin'
import CadastroVendedor from './pages/CadastroVendedor'
import MinhaLoja from './pages/MinhaLoja'
import PedidosDelivery from './pages/PedidosDelivery'
import PainelPedidos from './pages/PainelPedidos'
const PainelEntregador = lazy(() => import('./pages/PainelEntregador'))
import ResetPassword from './pages/ResetPassword'
import WhatsAppConfig from './pages/WhatsAppConfig'
import WhatsAppConversas from './pages/WhatsAppConversas'
import EntregadoresHistorico from './pages/EntregadoresHistorico'
import BotTeste from './pages/BotTeste'
const DeliveryLojas = lazy(() => import('./pages/DeliveryLojas'))
const DeliveryLoja = lazy(() => import('./pages/DeliveryLoja'))
const DeliveryCheckout = lazy(() => import('./pages/DeliveryCheckout'))
const DeliveryPedido = lazy(() => import('./pages/DeliveryPedido'))
const MeusPedidos = lazy(() => import('./pages/MeusPedidos'))
const LojaOnlineHome = lazy(() => import('./pages/LojaOnlineHome'))
import RaioEntrega from './pages/RaioEntrega'
import HorariosLoja from './pages/HorariosLoja'
import WhatsAppCreditos from './pages/WhatsAppCreditos'
import Termos from './pages/Termos'
import Privacidade from './pages/Privacidade'
import ExcluirConta from './pages/ExcluirConta'
import ServicoPresencial from './pages/ServicoPresencial'
import PresencialMesas from './pages/PresencialMesas'
import PresencialSalao from './pages/PresencialSalao'
import PresencialCozinha from './pages/PresencialCozinha'
import PresencialHistorico from './pages/PresencialHistorico'
import PresencialReservas from './pages/PresencialReservas'
const MesaCardapio = lazy(() => import('./pages/MesaCardapio'))
const ClienteLink = lazy(() => import('./pages/ClienteLink'))
const Landing = lazy(() => import('./pages/Landing'))
const TourSistema = lazy(() => import('./pages/TourSistema'))

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
          <Suspense fallback={<TelaCarregando />}>
          <Routes>
            {/* Sem marketplace: cada cliente só acessa a loja pelo link dela */}
            <Route path="/" element={<LojaOnlineHome />} />
            <Route path="/lojas" element={<LojaOnlineHome />} />
            <Route path="/checkout" element={<DeliveryCheckout />} />
            <Route path="/pedido/:id" element={<DeliveryPedido />} />
            <Route path="/meus-pedidos" element={<MeusPedidos />} />
            <Route path="/mesa/:token" element={<MesaCardapio />} />
            <Route path="/c/:token" element={<ClienteLink />} />
            {/* Link antigo por id (ex: loja sem slug) — resolve por id no DeliveryLoja */}
            <Route path="/loja/:id" element={<DeliveryLoja />} />
            <Route path="/:slug" element={<DeliveryLoja />} />
          </Routes>
          </Suspense>
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
        <Suspense fallback={<TelaCarregando />}>
          <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/cadastro" element={<Cadastro />} />
          <Route path="/termos" element={<Termos />} />
          <Route path="/ver/:sistema" element={<TourSistema />} />
          <Route path="/privacidade" element={<Privacidade />} />
          <Route path="/excluir-conta" element={<ExcluirConta />} />
          <Route path="/lojas" element={<DeliveryLojas />} />
          <Route path="/loja/:id" element={<DeliveryLoja />} />
          <Route path="/checkout" element={<DeliveryCheckout />} />
          <Route path="/pedido/:id" element={<DeliveryPedido />} />
          <Route path="/meus-pedidos" element={<MeusPedidos />} />
          {/* Autoatendimento por QR da mesa (público, sem login) */}
          <Route path="/mesa/:token" element={<MesaCardapio />} />
          {/* Link do cliente: pedido + conta do fiado, sem login (mig 0147) */}
          <Route path="/c/:token" element={<ClienteLink />} />
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
            <Route path="/super-admin/despesas" element={<SuperAdminDespesas />} />
            <Route path="/super-admin/videos" element={<SuperAdminVideos />} />
          </Route>

          <Route element={<LayoutOrLanding />}>
            <Route index element={<ProtectedRoute roles={['admin', 'vendedor']}><Dashboard /></ProtectedRoute>} />
            {/* Convite de upgrade — sem `modulo`, senão bloquearia a si mesma. */}
            <Route path="upgrade" element={<ProtectedRoute><Upgrade /></ProtectedRoute>} />
            <Route path="clientes" element={<ProtectedRoute modulo="clientes"><Clientes /></ProtectedRoute>} />
            {/* "Vendas física" saiu: as vendas presenciais são feitas por Mesa/Balcão
                (Serviço Presencial). Link antigo e atalho salvo caem no painel em
                vez de dar tela branca. */}
            <Route path="vendas" element={<Navigate to="/painel" replace />} />
            <Route path="caixa" element={<ProtectedRoute modulo="caixa"><Caixa /></ProtectedRoute>} />
            <Route path="relatorios" element={<ProtectedRoute modulo="relatorios"><Relatorios /></ProtectedRoute>} />
            <Route
              path="produtos"
              element={<ProtectedRoute roles={['admin']} modulo="produtos"><Produtos /></ProtectedRoute>}
            />
            <Route
              path="complementos"
              element={<ProtectedRoute roles={['admin']} modulo="produtos"><CategoriasComplemento /></ProtectedRoute>}
            />
            <Route
              path="ficha-tecnica"
              element={<ProtectedRoute roles={['admin']} modulo="produtos"><FichaTecnica /></ProtectedRoute>}
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
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><MinhaLoja secao="loja" /></ProtectedRoute>}
            />
            <Route
              path="loja-pagamento"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><MinhaLoja secao="pagamentos" /></ProtectedRoute>}
            />
            <Route
              path="loja-integracoes"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><MinhaLoja secao="integracoes" /></ProtectedRoute>}
            />
            <Route
              path="loja-fiscal"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><MinhaLoja secao="fiscal" /></ProtectedRoute>}
            />
            <Route
              path="loja-conta"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><MinhaLoja secao="conta" /></ProtectedRoute>}
            />
            <Route
              path="raio-entrega"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><RaioEntrega /></ProtectedRoute>}
            />
            <Route
              path="loja-horarios"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><HorariosLoja /></ProtectedRoute>}
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
              path="whatsapp-conversas"
              element={<ProtectedRoute roles={['admin']} modulo="whatsapp"><WhatsAppConversas /></ProtectedRoute>}
            />
            <Route
              path="entregadores"
              element={<ProtectedRoute roles={['admin']} modulo="delivery"><EntregadoresHistorico /></ProtectedRoute>}
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
          </Suspense>
      </BrowserRouter>
    </AuthProvider>
    </BrandingProvider>
  )
}
