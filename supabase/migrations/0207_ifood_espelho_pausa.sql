-- Espelho de pausa entre o nosso catálogo e o iFood.
--
-- O caso real: acabou o frango às 12h30. Hoje o lojista pausa no CRM e precisa
-- lembrar de pausar no iFood também — quando esquece, entra pedido do que não
-- tem, e o pedido cancelado por falta de item pesa na nota da loja no iFood.
--
-- Só dá pra espelhar quando se sabe QUAL produto daqui é QUAL item de lá. Esse
-- par nasce confiável em duas situações: quando fomos nós que publicamos o item
-- (Cardápio iFood → Enviar da minha loja) e quando importamos o cardápio de lá.
-- Casar por nome depois seria adivinhação — e adivinhar errado pausa o prato
-- errado no meio do almoço. Por isso o vínculo fica gravado, e produto sem
-- vínculo simplesmente não espelha.
--
-- Um sentido só: daqui pro iFood. O iFood não avisa quando alguém pausa lá (o
-- polling traz pedidos, não mudanças de cardápio), então o contrário exigiria
-- varrer o cardápio de tempos em tempos — fica pra quando fizer falta. O que
-- muda lá aparece quando a tela do Cardápio iFood é aberta.

alter table produtos add column if not exists ifood_item_id text;
alter table produtos add column if not exists ifood_product_id text;

comment on column produtos.ifood_item_id is
  'Item correspondente no iFood. Preenchido ao publicar (catalogo_enviar_loja) ou importar o cardápio. Sem ele o produto não espelha a pausa.';

create index if not exists idx_produtos_ifood_item
  on produtos (empresa_id, ifood_item_id)
  where ifood_item_id is not null;

create or replace function fn_ifood_espelha_pausa()
returns trigger
language plpgsql
-- security definer pra ler a chave em config_global (RLS de super_admin) — é o
-- mesmo motivo do gatilho de aviso de pedido, ver 0206.
security definer
set search_path = public
as $$
DECLARE
  auth_key TEXT;
BEGIN
  -- Sem vínculo não há o que espelhar.
  IF NEW.ifood_item_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.disponivel_delivery IS NOT DISTINCT FROM OLD.disponivel_delivery THEN RETURN NEW; END IF;
  -- Loja com iFood desligado não leva chamada à toa.
  IF NOT EXISTS (SELECT 1 FROM ifood_config WHERE empresa_id = NEW.empresa_id AND ativo) THEN
    RETURN NEW;
  END IF;

  SELECT valor INTO auth_key FROM config_global WHERE chave = 'edge_auth_key' LIMIT 1;
  IF COALESCE(auth_key, '') = '' THEN
    RAISE WARNING '[ifood] sem edge_auth_key — pausa do produto % nao espelhou no iFood', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || auth_key
    ),
    body    := jsonb_build_object(
      'acao',       'catalogo_pausar',
      'empresa_id', NEW.empresa_id,
      'item_id',    NEW.ifood_item_id,
      -- disponivel_delivery false (ou nulo) = pausado dos dois lados
      'pausar',     NEW.disponivel_delivery IS NOT TRUE
    )
  );
  RETURN NEW;
END;
$$;

drop trigger if exists trg_ifood_espelha_pausa on produtos;
create trigger trg_ifood_espelha_pausa
  after update of disponivel_delivery on produtos
  for each row execute function fn_ifood_espelha_pausa();
