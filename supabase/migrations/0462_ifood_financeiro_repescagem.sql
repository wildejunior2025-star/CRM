-- Repescagem do sync financeiro do iFood: além das 06:15 (09:15 UTC), roda às
-- 07:15 e 08:15 (Fortaleza). A função só pega loja que deu erro ou ficou de fora
-- (quem sincronizou ok nas últimas 20h é pulada). Motivo: o Zebu ficou 14–20/11
-- sem valores do iFood (limite do iFood + tempo acabando nas outras lojas).
do $$
declare j text;
begin
  foreach j in array array['ifood-financeiro-repescagem-1', 'ifood-financeiro-repescagem-2'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;

select cron.schedule('ifood-financeiro-repescagem-1', '15 10 * * *', $c$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"acao": "financeiro_sync"}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id
$c$);

select cron.schedule('ifood-financeiro-repescagem-2', '15 11 * * *', $c$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"acao": "financeiro_sync"}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id
$c$);
