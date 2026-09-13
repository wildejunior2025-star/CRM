-- =========================================================
-- Migration 0266 - "Lojas com bot" conta só robô ligado de verdade
-- =========================================================
-- O Dashboard do Super ADM mostrava 6 lojas com bot: contava toda loja
-- ativa/trial com crédito, mesmo com o robô desligado. Em 13/09/2026 só 2
-- respondiam (CDBom com IA, Zebu com o robô do link). Agora conta a conexão do
-- WhatsApp ativa com a IA ou o robô do link ligado.
-- =========================================================
CREATE OR REPLACE FUNCTION public.capacidade_sistema()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  resultado json;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND perfil = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT json_build_object(
    'bot_conversas_ativas', (
      SELECT count(DISTINCT phone) FROM whatsapp_conversas
      WHERE created_at > now() - interval '10 minutes'
    ),
    'ia_por_minuto', (
      SELECT count(*) FROM whatsapp_conversas
      WHERE role = 'assistant' AND created_at > now() - interval '1 minute'
    ),
    'lojas_bot_ativo', (
      SELECT count(*) FROM whatsapp_config w
        JOIN empresas e ON e.id = w.empresa_id
       WHERE w.ativo
         AND (w.ia_ativo OR w.resposta_link_ativo)
         AND e.status IN ('ativo', 'trial', 'atrasado')
    ),
    'banco_mb', (
      SELECT round(pg_database_size(current_database()) / 1024.0 / 1024.0)
    )
  ) INTO resultado;

  RETURN resultado;
END;
$function$;
