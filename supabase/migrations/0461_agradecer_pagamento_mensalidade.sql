-- 0461 — Agradecimento automático quando a mensalidade é paga (20/11/2026, pedido do Wilde)
--
-- A cobrança vira 'paga' por vários caminhos (PIX do link, cartão da assinatura, baixa à mão no Super ADM), então o
-- aviso é gatilho na própria cobrança e dispara só na virada. Quem manda é a edge `mensalidade` (action agradecer),
-- só pra loja com zap_auto ligado, uma vez por cobrança. O aviso nunca pode travar a baixa do pagamento.

create or replace function public.agradecer_pagamento_mensalidade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_token text;
begin
  select valor into v_token from config_global where chave = 'aviso_fwc_token';
  if coalesce(v_token, '') = '' then return new; end if;
  perform net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/mensalidade?token=' || v_token,
    body := jsonb_build_object('action', 'agradecer', 'cobranca_id', new.id),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists trg_agradecer_pagamento on public.mensalidade_cobrancas;
create trigger trg_agradecer_pagamento
  after update of status on public.mensalidade_cobrancas
  for each row
  when (new.status = 'paga' and old.status is distinct from 'paga')
  execute function public.agradecer_pagamento_mensalidade();
