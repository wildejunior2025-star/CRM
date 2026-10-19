-- Segunda mensagem automática no WhatsApp da FWC.
--
-- 5 min depois do "Com quem eu falo?", se nem o lead nem o Wilde escreveram,
-- sai "Bom dia/Boa tarde/Boa noite! Como posso te ajudar hoje? Você já usa
-- algum sistema na sua loja?". Uma vez só, só entre 7h e 22h.
--   ultima_entrada_em: última mensagem que o lead mandou
--   followup_em:       quando a segunda mensagem saiu
-- O cron chama a aviso-fwc-entrada a cada minuto com {"action":"followup"}.

alter table public.aviso_fwc_entrada
  add column if not exists ultima_entrada_em timestamptz,
  add column if not exists followup_em timestamptz;

select cron.unschedule('aviso-fwc-followup')
where exists (select 1 from cron.job where jobname = 'aviso-fwc-followup');

select cron.schedule('aviso-fwc-followup', '* * * * *', $$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/aviso-fwc-entrada?token='
           || (select valor from public.config_global where chave = 'aviso_fwc_token'),
    body := '{"action":"followup"}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb
  )
$$);
