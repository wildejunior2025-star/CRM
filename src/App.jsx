import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import PortalLayout from './components/PortalLayout'
import Login from './pages/Login'
import Cadastro from './pages/Cadastro'
import Dashboard from './pages/Dashboard'
import Clientes from './pages/Clientes'
import Produtos from './pages/Produtos'
import Estoque from './pages/Estoque'
import Vendas from './pages/Vendas'
import Caixa from './pages/Caixa'
import Financeiro from './pages/Financeiro'
import Relatorios from './pages/Relatorios'
import Usuarios from './pages/Usuarios'
import PortalCatalogo from './pages/PortalCatalogo'
import PortalPedidos from './pages/PortalPedidos'
import PortalFiado from './pages/PortalFiado'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/cadastro" element={<Cadastro />} />

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
              element={
                <ProtectedRoute roles={['admin']}>
                  <Produtos />
                </ProtectedRoute>
              }
            />
            <Route
              path="estoque"
              element={
                <ProtectedRoute roles={['admin']}>
                  <Estoque />
                </ProtectedRoute>
              }
            />
            <Route
              path="financeiro"
              element={
                <ProtectedRoute roles={['admin']}>
                  <Financeiro />
                </ProtectedRoute>
              }
            />
            <Route
              path="usuarios"
              element={
                <ProtectedRoute roles={['admin']}>
                  <Usuarios />
                </ProtectedRoute>
              }
            />
          </Route>

          <Route
            path="/portal"
            element={
              <ProtectedRoute roles={['cliente']}>
                <PortalLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<PortalCatalogo />} />
            <Route path="pedidos" element={<PortalPedidos />} />
            <Route path="fiado" element={<PortalFiado />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
