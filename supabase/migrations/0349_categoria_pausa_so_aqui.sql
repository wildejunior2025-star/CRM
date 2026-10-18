-- Categoria em que PAUSAR AQUI NÃO PAUSA NO IFOOD.
--
-- O espelho (migs 0207/0208) replica a pausa pro iFood em todo produto que tem
-- ifood_item_id, e é isso que a loja quer na maioria dos casos: acabou o
-- ingrediente, some dos dois cardápios de uma vez.
--
-- Só que O Braseiro tem categorias que existem nos dois lugares com regras
-- diferentes (o Happy Hour vale no salão em certo horário, mas no iFood roda
-- o dia todo). Nessas, pausar aqui tem que ser pausa só daqui.
--
-- A chave fica na CATEGORIA, não no produto: é decisão de cardápio, e ninguém
-- vai marcar produto por produto em categoria de vinte itens.
--
-- Sem tela ainda: a coluna nasce false em todo mundo, então o comportamento
-- continua idêntico ao de antes. Hoje a loja resolve na mão (pausa aqui e
-- despausa no portal do iFood, que não volta pra cá). O dia que isso cansar,
-- é só ligar a chave na tela de Categorias.
alter table public.categorias
  add column if not exists pausa_so_aqui boolean not null default false;

comment on column public.categorias.pausa_so_aqui is
  'true = pausar/despausar produto desta categoria NAO espelha no iFood (migs 0207/0208). Cardapio dos dois lados com regras diferentes.';

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

  -- Categoria marcada como "pausa só aqui": o iFood segue a vida dele.
  IF EXISTS (
    SELECT 1 FROM categorias c
     WHERE c.empresa_id = NEW.empresa_id
       AND c.nome = NEW.categoria
       AND c.pausa_so_aqui
  ) THEN
    RETURN NEW;
  END IF;

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
