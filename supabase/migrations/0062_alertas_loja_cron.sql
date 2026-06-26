-- =========================================================
-- 0062: Cron de alertas da loja (edge function alertas-loja)
-- =========================================================
-- Às 08h de Brasília (11:00 UTC) chama a edge function alertas-loja, que
-- avisa cada loja (telefone_contato) via WhatsApp sobre itens no/abaixo
-- do estoque mínimo. Também tem botão de teste na Dashboard.
-- =========================================================
DO $$ BEGIN
  PERFORM cron.unschedule('alertas-loja-diario');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'alertas-loja-diario',
  '0 11 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/alertas-loja',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  ) AS request_id
  $cron$
);
