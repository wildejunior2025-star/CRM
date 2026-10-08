-- Envio automático do link de pagamento pelo WhatsApp da FWC (só lojas ligadas).
-- zap_auto liga por loja; zap_telefone é o número que recebe o link.
ALTER TABLE public.mensalidade_config
  ADD COLUMN IF NOT EXISTS zap_auto boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zap_telefone text;

-- Todo dia às 9h de Fortaleza (12h UTC): manda o link das lojas ligadas que
-- tenham cobrança vencida ainda sem aviso.
SELECT cron.unschedule('mensalidade-link-whatsapp')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mensalidade-link-whatsapp');
SELECT cron.schedule('mensalidade-link-whatsapp', '0 12 * * *', $$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/mensalidade',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "cron_link"}'::jsonb
  )
$$);
