-- Excluir o produto aqui tira o item do iFood também.
--
-- Sem isso, apagar um produto do catálogo deixava o item vendendo no iFood sem
-- nada por trás: entra pedido de algo que não existe mais, e o cancelamento por
-- falta de item pesa na nota da loja.
--
-- O espelho segue a régua das duas ações daqui, cada uma com seu equivalente:
--   excluir  (definitivo)  -> exclui no iFood (definitivo lá também)
--   arquivar (reversível)  -> só pausa no iFood, pelo gatilho 0208 (ativo=false),
--                             porque desarquivar aqui precisa poder trazer de volta lá
--
-- Vale só pra produto com vínculo. Sem vínculo não há o que apagar do outro lado.

create or replace function fn_ifood_espelha_exclusao()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
DECLARE
  auth_key TEXT;
BEGIN
  IF OLD.ifood_item_id IS NULL OR OLD.ifood_product_id IS NULL THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM ifood_config WHERE empresa_id = OLD.empresa_id AND ativo) THEN
    RETURN OLD;
  END IF;

  SELECT valor INTO auth_key FROM config_global WHERE chave = 'edge_auth_key' LIMIT 1;
  IF COALESCE(auth_key, '') = '' THEN
    RAISE WARNING '[ifood] sem edge_auth_key — exclusao do produto % nao chegou no iFood', OLD.id;
    RETURN OLD;
  END IF;

  -- A edge precisa da categoria do item no iFood; ela não está no produto, então
  -- a própria função busca pelo product_id. Aqui manda o que temos.
  PERFORM net.http_post(
    url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || auth_key
    ),
    body    := jsonb_build_object(
      'acao',       'catalogo_excluir_por_produto',
      'empresa_id', OLD.empresa_id,
      'item_id',    OLD.ifood_item_id,
      'product_id', OLD.ifood_product_id
    )
  );
  RETURN OLD;
END;
$$;

drop trigger if exists trg_ifood_espelha_exclusao on produtos;
create trigger trg_ifood_espelha_exclusao
  after delete on produtos
  for each row execute function fn_ifood_espelha_exclusao();
