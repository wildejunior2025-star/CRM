-- Migration: fix_rls_pedidos_delivery_insert
-- Problema: a policy "Cliente cria pedido delivery" exige current_perfil() = 'cliente',
-- bloqueando usuários autenticados do catálogo que não têm linha na tabela profiles
-- (ou cujo perfil é diferente de 'cliente').
-- O catálogo delivery aceita qualquer usuário autenticado — não há vínculo obrigatório
-- com a tabela profiles para fazer um pedido.

-- 1. Remove a policy restritiva anterior
DROP POLICY IF EXISTS "Cliente cria pedido delivery" ON pedidos_delivery;

-- 2. Cria policy ampla: qualquer autenticado pode inserir
--    O campo empresa_id é preenchido pelo frontend com o ID da loja escolhida,
--    e o RLS de SELECT/UPDATE continua restrito a admin/cliente correto.
CREATE POLICY "Cliente catalogo insere pedido"
ON pedidos_delivery
FOR INSERT
TO authenticated
WITH CHECK (true);

-- 3. Garante que pedidos_delivery_seq também permite INSERT/UPDATE para authenticated.
--    A função next_numero_pedido() é SECURITY DEFINER, mas o Postgres ainda verifica
--    RLS da sessão chamante em alguns cenários; policy permissiva elimina o risco.
CREATE POLICY "Seq pedido delivery para autenticado"
ON pedidos_delivery_seq
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);
