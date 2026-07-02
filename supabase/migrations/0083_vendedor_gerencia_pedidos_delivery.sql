-- =========================================================
-- 0083: Vendedor (atendente da loja) enxerga/gerencia os pedidos no Gestor
-- =========================================================
-- G2 — o /painel (Gestor de Pedidos) abria VAZIO pro vendedor porque não havia
-- policy de RLS pra ele em pedidos_delivery (só admin/super_admin/cozinheiro/
-- entregador/cliente tinham). Aqui damos ao vendedor os mesmos poderes do admin,
-- restritos à empresa dele: ver, criar (balcão/PDV), aceitar e avançar pedidos.
-- =========================================================

DROP POLICY IF EXISTS "Vendedor gerencia pedidos da propria empresa" ON pedidos_delivery;
CREATE POLICY "Vendedor gerencia pedidos da propria empresa"
  ON pedidos_delivery FOR ALL
  TO authenticated
  USING (current_perfil() = 'vendedor' AND empresa_id = current_empresa_id())
  WITH CHECK (current_perfil() = 'vendedor' AND empresa_id = current_empresa_id());
