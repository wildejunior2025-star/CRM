-- =========================================================
-- Migration 0074 - Espelhamento de status iFood -> painel (anti-eco)
-- =========================================================
-- Agora o poll espelha TODOS os status do iFood no nosso painel (CFM->confirmado,
-- RTP->pronto, DSP->saiu_entrega, CON->entregue, CAN->cancelado). Assim, se o
-- lojista aceitar/despachar direto no app do iFood, o painel acompanha sozinho.
--
-- Pra isso não virar loop (o trigger devolve status pro iFood), adicionamos um
-- guard ANTI-ECO: se o novo status JÁ corresponde ao ifood_status (ou seja, a
-- mudança veio do iFood), o trigger NÃO devolve. Só devolve quando o painel
-- está à frente do que o iFood reportou (ação nascida do nosso lado).
-- =========================================================

create or replace function notify_ifood_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ja_sincronizado boolean;
begin
  if NEW.origem = 'ifood'
     and NEW.ifood_order_id is not null
     and NEW.status is distinct from OLD.status then

    ja_sincronizado := (
         (NEW.status = 'confirmado'   and upper(coalesce(NEW.ifood_status,'')) in ('CFM','CONFIRMED','CONFIRMADO'))
      or (NEW.status = 'pronto'       and upper(coalesce(NEW.ifood_status,'')) in ('RTP','READYTOPICKUP','READY_TO_PICKUP','PRONTO'))
      or (NEW.status = 'saiu_entrega' and upper(coalesce(NEW.ifood_status,'')) in ('DSP','DISPATCHED','SAIU_ENTREGA'))
      or (NEW.status = 'entregue'     and upper(coalesce(NEW.ifood_status,'')) in ('CON','CONCLUDED','ENTREGUE'))
      or (NEW.status = 'cancelado'    and upper(coalesce(NEW.ifood_status,'')) in ('CAN','CANCELLED','CANCELLATION_REQUESTED','CANCELADO'))
    );

    if not ja_sincronizado then
      perform net.http_post(
        url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := jsonb_build_object(
          'acao', 'status',
          'pedido_id', NEW.id,
          'novo_status', NEW.status
        )
      );
    end if;
  end if;
  return NEW;
end;
$$;
