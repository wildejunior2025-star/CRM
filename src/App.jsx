import { BrowserRouter, Routes, Route } from 'react-router-dom'
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
import PortalFiado from './pages/PortalFiado'
import SuperAdminEmpresas from './pages/SuperAdminEmpresas'
import SuperAdminClientes from './pages/SuperAdminClientes'
import SuperAdminComissoes from './pages/SuperAdminComissoes'
import CadastroAdmin from './pages/CadastroAdmin'
import CadastroVendedor from './pages/CadastroVendedor'
import MinhaLoja from './pages/MinhaLoja'
import ResetPassword from './pages/ResetPassword'
import WhatsAppConfig from './pages/WhatsAppConfig'

export default function App() {
  return (
    <BrandingProvider>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/cadastro" element={<Cadastro />} />
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
            <Route path="/super-admin" element={<SuperAdminEmpresas />} />
            <Route path="/super-admin/clientes" element={<SuperAdminClientes />} />
            <Route path="/super-admin/comissoes" element={<SuperAdminComissoes />} />
          </Route>

          <Route
            element={
              <ProtectedRoute roles={['admin', 'vendedor']}>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="clientes" element={<Clientes />} />
            <Route path="vendas" element={<Vendas />} />
            <Route path="caixa" element={<Caixa />} />
            <Route path="relatorios" element={<Relatorios />} />
            <Route
              path="produtos"
              element={<ProtectedRoute roles={['admin']}><Produtos /></ProtectedRoute>}
            />
            <Route
              path="estoque"
              element={<ProtectedRoute roles={['admin']}><Estoque /></ProtectedRoute>}
            />
            <Route
              path="financeiro"
              element={<ProtectedRoute roles={['admin']}><Financeiro /></ProtectedRoute>}
            />
            <Route
              path="minha-loja"
              element={<ProtectedRoute roles={['admin']}><MinhaLoja /></ProtectedRoute>}
            />
            <Route
              path="whatsapp"
              element={<ProtectedRoute roles={['admin']}><WhatsAppConfig /></ProtectedRoute>}
            />
            <Route
              path="usuarios"
              element={<ProtectedRoute roles={['admin']}><Usuarios /></ProtectedRoute>}
            />
          </Route>

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
            <Route path="fiado" element={<PortalFiado />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </BrandingProvider>
  )
}
