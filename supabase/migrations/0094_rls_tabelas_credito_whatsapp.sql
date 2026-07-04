-- Fecha o vazamento: as tabelas de crédito estavam com RLS DESLIGADO, então
-- qualquer usuário autenticado lia o crédito de todas as lojas. Liga o RLS e
-- deixa: Super Admin vê/gerencia tudo; cada loja vê só o dela. As edge functions
-- (service_role) e as RPCs SECURITY DEFINER ignoram RLS, então nada de escrita quebra.

-- ── whatsapp_credito_historico ──────────────────────────────────────────────
ALTER TABLE public.whatsapp_credito_historico ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin gerencia historico credito"
  ON public.whatsapp_credito_historico
  FOR ALL USING (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

CREATE POLICY "Loja ve seu historico credito"
  ON public.whatsapp_credito_historico
  FOR SELECT USING (empresa_id = current_empresa_id());

-- ── whatsapp_credito_pagamentos ─────────────────────────────────────────────
ALTER TABLE public.whatsapp_credito_pagamentos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin gerencia pagamentos credito"
  ON public.whatsapp_credito_pagamentos
  FOR ALL USING (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

CREATE POLICY "Loja ve seus pagamentos credito"
  ON public.whatsapp_credito_pagamentos
  FOR SELECT USING (empresa_id = current_empresa_id());

-- ── whatsapp_creditos_log (já tinha policies equivalentes, mas RLS estava off) ─
ALTER TABLE public.whatsapp_creditos_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin gerencia log creditos"
  ON public.whatsapp_creditos_log
  FOR ALL USING (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

CREATE POLICY "Loja ve seu log creditos"
  ON public.whatsapp_creditos_log
  FOR SELECT USING (empresa_id = current_empresa_id());
