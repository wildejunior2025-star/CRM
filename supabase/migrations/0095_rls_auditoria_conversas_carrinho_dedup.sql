-- Auditoria de RLS (2026-07-04). Fecha vazamentos onde políticas "service_role
-- acesso total" foram criadas para {public} com qual=true — mas o service_role
-- IGNORA RLS de qualquer jeito, então essas políticas só serviam para (por engano)
-- liberar tudo a qualquer usuário logado. Troca por escopo por empresa.

-- ── whatsapp_notify_dedup: RLS estava DESLIGADO (tabela técnica; só as functions usam) ──
ALTER TABLE public.whatsapp_notify_dedup ENABLE ROW LEVEL SECURITY;
-- Sem policies de propósito: nenhum usuário autenticado precisa ler/escrever.
-- As edge functions usam service_role, que ignora RLS.

-- ── whatsapp_conversas: histórico de chat (telefone + conteúdo das mensagens) ──
DROP POLICY IF EXISTS "service_role acesso total" ON public.whatsapp_conversas;

CREATE POLICY "Super admin gerencia conversas"
  ON public.whatsapp_conversas
  FOR ALL USING (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

CREATE POLICY "Admin gerencia conversas da propria empresa"
  ON public.whatsapp_conversas
  FOR ALL USING (current_perfil() = 'admin' AND empresa_id = current_empresa_id())
  WITH CHECK (current_perfil() = 'admin' AND empresa_id = current_empresa_id());

-- ── whatsapp_carrinho: sacola em montagem (telefone, itens, endereço) ──
DROP POLICY IF EXISTS "service_role acesso total carrinho" ON public.whatsapp_carrinho;

CREATE POLICY "Super admin gerencia carrinho"
  ON public.whatsapp_carrinho
  FOR ALL USING (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

CREATE POLICY "Admin gerencia carrinho da propria empresa"
  ON public.whatsapp_carrinho
  FOR ALL USING (current_perfil() = 'admin' AND empresa_id = current_empresa_id())
  WITH CHECK (current_perfil() = 'admin' AND empresa_id = current_empresa_id());
