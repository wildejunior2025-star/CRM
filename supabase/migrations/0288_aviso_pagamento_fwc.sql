-- Aviso no WhatsApp do dono quando uma loja paga a FWC: mensalidade aprovada
-- (mensalidade_pagamentos.status -> 'aprovado') ou crédito do robô pago
-- (ia_saldo_pagamentos.status -> 'pago').
--
-- É gatilho, não código na edge: o pagamento é confirmado por vários caminhos
-- (webhook do MP, conferência do cron, cartão da assinatura) e todos passam por
-- essa mudança de status. Dispara só na virada, então aviso repetido do MP não
-- manda duas vezes. Quem entrega é a edge aviso-fwc-entrada (mig 0287), pro
-- config_global.aviso_fwc_destino.

create or replace function public.avisar_pagamento_fwc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
  v_loja  text;
  v_texto text;
begin
  select valor into v_token from config_global where chave = 'aviso_fwc_token';
  if coalesce(v_token, '') = '' then return new; end if;
  select nome into v_loja from empresas where id = new.empresa_id;

  if tg_table_name = 'mensalidade_pagamentos' then
    v_texto := '💰 *Pagamento recebido — mensalidade*' || chr(10) || chr(10)
      || '*' || coalesce(v_loja, 'Loja') || '*' || chr(10)
      || 'Valor: R$ ' || replace(to_char(new.valor, 'FM999990D00'), '.', ',')
      || ' · ' || case new.forma when 'pix' then 'PIX' when 'cartao' then 'Cartão' else coalesce(new.forma, '') end;
  else
    v_texto := '💰 *Pagamento recebido — crédito do robô*' || chr(10) || chr(10)
      || '*' || coalesce(v_loja, 'Loja') || '*' || chr(10)
      || 'Valor: R$ ' || replace(to_char(new.valor_reais, 'FM999990D00'), '.', ',');
  end if;

  perform net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/aviso-fwc-entrada?token=' || v_token,
    body := jsonb_build_object('aviso', v_texto),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
  return new;
exception when others then
  -- O aviso é bônus: nunca pode travar a confirmação do pagamento.
  return new;
end $$;

drop trigger if exists trg_aviso_pagamento_mensalidade on public.mensalidade_pagamentos;
create trigger trg_aviso_pagamento_mensalidade
  after update of status on public.mensalidade_pagamentos
  for each row
  when (new.status = 'aprovado' and old.status is distinct from 'aprovado')
  execute function public.avisar_pagamento_fwc();

drop trigger if exists trg_aviso_pagamento_ia on public.ia_saldo_pagamentos;
create trigger trg_aviso_pagamento_ia
  after update of status on public.ia_saldo_pagamentos
  for each row
  when (new.status = 'pago' and old.status is distinct from 'pago')
  execute function public.avisar_pagamento_fwc();
