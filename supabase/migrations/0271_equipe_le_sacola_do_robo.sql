-- =========================================================
-- Migration 0271 - Equipe da loja lê a sacola que o robô está montando
-- =========================================================
-- O gestor de pedidos mostra ao vivo a sacola do robô (whatsapp_carrinho) na
-- sacola do atendente e no "Fechar" — se o robô travar, quem assume só
-- finaliza. A leitura era só do admin; o gestor é usado pelo vendedor, que
-- ficava com a sacola vazia. Só LEITURA: quem grava o carrinho é o robô.
-- =========================================================

drop policy if exists "Equipe le carrinho do robo" on whatsapp_carrinho;
create policy "Equipe le carrinho do robo" on whatsapp_carrinho
  for select to authenticated
  using (empresa_id = current_empresa_id() and current_perfil() in ('admin', 'vendedor', 'garcom'));
