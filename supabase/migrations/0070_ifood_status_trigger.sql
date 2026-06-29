-- =========================================================
-- Migration 0070 - Sincronização de status do iFood via trigger
-- =========================================================
-- Antes, a devolução de status pro iFood era disparada só pelo /painel
-- (gestor). Quando o entregador avançava o pedido pelo app dele (ou o
-- auto-conclusão de 6h rodava), o iFood não era avisado.
--
-- Este trigger centraliza a sincronização: sempre que o status de um
-- pedido com origem='ifood' muda, chama a edge function ifood-integration
-- (ação status), que mapeia pro endpoint certo (confirm/dispatch/
-- readyToPickup/cancel). Cobre TODOS os caminhos, sem duplicar lógica no
-- front. (O front não chama mais a edge function diretamente.)
-- =========================================================

create or replace function notify_ifood_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.origem = 'ifood'
     and NEW.ifood_order_id is not null
     and NEW.status is distinct from OLD.status then
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
  return NEW;
end;
$$;

drop trigger if exists trg_notify_ifood_status on pedidos_delivery;
create trigger trg_notify_ifood_status
  after update on pedidos_delivery
  for each row execute function notify_ifood_status();
