-- =========================================================
-- 0061: Cron do resumo diário no WhatsApp (edge function resumo-diario)
-- =========================================================
-- Às 22h de Brasília (01:00 UTC) chama a edge function resumo-diario, que
-- envia pra cada loja (telefone_contato) um resumo do dia via WhatsApp
-- (instância crmadmin). Também há um botão "Receber agora" na Dashboard.
-- =========================================================
DO $$ BEGIN
  PERFORM cron.unschedule('resumo-diario-loja');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'resumo-diario-loja',
  '0 1 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/resumo-diario',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id
  $cron$
);
