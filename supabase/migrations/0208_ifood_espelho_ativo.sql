-- O espelho de pausa (0207) só olhava `disponivel_delivery`, que é o campo que o
-- Painel mexe. Mas o botão "Pausar" da tela de Produtos mexe em `ativo` — então
-- pausar por lá não chegava no iFood, e o lojista não tem como saber que os dois
-- botões, que parecem a mesma coisa, tinham efeitos diferentes.
--
-- Agora os dois valem, e vale o mais restritivo: o item some do iFood se estiver
-- desligado em QUALQUER um dos dois. Só volta quando os dois estiverem ligados —
-- despausar no iFood um produto que continua inativo aqui seria vender o que a
-- loja já disse que não quer vender.

create or replace function fn_ifood_espelha_pausa()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
DECLARE
  auth_key TEXT;
  pausar_agora BOOLEAN;
  pausar_antes BOOLEAN;
BEGIN
  IF NEW.ifood_item_id IS NULL THEN RETURN NEW; END IF;

  pausar_agora := (NEW.ativo IS NOT TRUE) OR (NEW.disponivel_delivery IS NOT TRUE);
  pausar_antes := (OLD.ativo IS NOT TRUE) OR (OLD.disponivel_delivery IS NOT TRUE);
  -- Mudou algum dos dois campos mas o resultado é o mesmo? Não incomoda o iFood.
  IF pausar_agora IS NOT DISTINCT FROM pausar_antes THEN RETURN NEW; END IF;

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
      'pausar',     pausar_agora
    )
  );
  RETURN NEW;
END;
$$;

drop trigger if exists trg_ifood_espelha_pausa on produtos;
create trigger trg_ifood_espelha_pausa
  after update of disponivel_delivery, ativo on produtos
  for each row execute function fn_ifood_espelha_pausa();
