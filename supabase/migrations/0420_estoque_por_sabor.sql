-- Estoque por sabor (opção de complemento).
--
-- Nasceu na CDBom: o "Picolé Cremoso" tem 4 sabores e cada sabor acaba num
-- dia diferente. O estoque do produto não diz qual sabor falta, e a pausa
-- do produto inteiro tira do cardápio sabores que ainda têm.
--
-- Agora a opção pode controlar estoque sozinha:
--   * a venda (pedidos_delivery) baixa o sabor escolhido;
--   * zerou → a opção fica indisponível (some do cardápio, robô e +Vender);
--   * entrou mercadoria → volta sozinha. Pausa feita à mão não é desfeita.
-- Liga por opção (controla_estoque); loja que não liga não muda nada.

ALTER TABLE complemento_opcoes
  ADD COLUMN IF NOT EXISTS controla_estoque boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pausado_por_estoque boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS complemento_estoque_movimentos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  opcao_id    uuid NOT NULL REFERENCES complemento_opcoes(id) ON DELETE CASCADE,
  tipo        text NOT NULL CHECK (tipo IN ('entrada', 'saida', 'ajuste')),
  quantidade  numeric NOT NULL,
  motivo      text,
  observacao  text,
  pedido_id   uuid,
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS complemento_estoque_mov_opcao_idx ON complemento_estoque_movimentos (opcao_id);
CREATE INDEX IF NOT EXISTS complemento_estoque_mov_pedido_idx ON complemento_estoque_movimentos (pedido_id) WHERE pedido_id IS NOT NULL;

ALTER TABLE complemento_estoque_movimentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Loja le estoque de sabor" ON complemento_estoque_movimentos;
CREATE POLICY "Loja le estoque de sabor" ON complemento_estoque_movimentos
  FOR SELECT TO authenticated
  USING (empresa_id = (SELECT current_empresa_id()) OR (SELECT current_perfil()) = 'super_admin');

DROP POLICY IF EXISTS "Loja lanca estoque de sabor" ON complemento_estoque_movimentos;
CREATE POLICY "Loja lanca estoque de sabor" ON complemento_estoque_movimentos
  FOR INSERT TO authenticated
  WITH CHECK (
    (empresa_id = (SELECT current_empresa_id()) OR (SELECT current_perfil()) = 'super_admin')
    -- vendedor só dá entrada; ajuste e saída manual são do dono
    AND (tipo = 'entrada' OR (SELECT current_perfil()) IN ('admin', 'super_admin'))
    AND pedido_id IS NULL
  );

CREATE OR REPLACE FUNCTION public.complemento_saldo(p_opcao uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(CASE tipo WHEN 'saida' THEN -quantidade ELSE quantidade END), 0)
    FROM complemento_estoque_movimentos WHERE opcao_id = p_opcao
$function$;

-- Zerou → pausa; voltou a ter → despausa (só o que o estoque pausou).
CREATE OR REPLACE FUNCTION public.trg_complemento_estoque_pausa()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o       record;
  v_saldo numeric;
BEGIN
  SELECT id, disponivel, controla_estoque, pausado_por_estoque INTO o
    FROM complemento_opcoes WHERE id = NEW.opcao_id;
  IF NOT FOUND OR NOT o.controla_estoque THEN RETURN NULL; END IF;

  v_saldo := complemento_saldo(NEW.opcao_id);
  IF v_saldo <= 0 THEN
    IF COALESCE(o.disponivel, true) THEN
      UPDATE complemento_opcoes SET disponivel = false, pausado_por_estoque = true WHERE id = o.id;
    END IF;
  ELSIF o.pausado_por_estoque THEN
    UPDATE complemento_opcoes SET disponivel = true, pausado_por_estoque = false WHERE id = o.id;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_complemento_estoque_pausa ON complemento_estoque_movimentos;
CREATE TRIGGER trg_complemento_estoque_pausa AFTER INSERT ON complemento_estoque_movimentos
  FOR EACH ROW EXECUTE FUNCTION trg_complemento_estoque_pausa();

-- Quanto de cada sabor o pedido pede agora.
-- A opção vem pelo opcaoId; o robô às vezes manda só o nome, então cai pro
-- nome dentro dos grupos do produto do item. Complemento "absoluto" (grupo
-- por quantidade: 5× Coco num pedido de 25 picolés) já é o total; o comum
-- é por unidade e multiplica pela quantidade do item.
CREATE OR REPLACE FUNCTION public.complemento_exigido_pedido_delivery(p_pedido pedidos_delivery)
 RETURNS TABLE(opcao_id uuid, quantidade numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH itens AS (
    SELECT it,
           COALESCE((it->>'quantidade')::numeric, (it->>'qtd')::numeric, 1) AS qtd_item,
           CASE WHEN COALESCE(it->>'produto_id', '') ~
                     '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (it->>'produto_id')::uuid END AS produto_id
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_pedido.itens) = 'array'
                   AND COALESCE(p_pedido.status, '') NOT IN ('cancelado', 'aguardando_pagamento')
                  THEN p_pedido.itens ELSE '[]'::jsonb END) AS it
  ),
  comps AS (
    SELECT i.produto_id, i.qtd_item, c
      FROM itens i,
           jsonb_array_elements(CASE WHEN jsonb_typeof(i.it->'complementos') = 'array'
                                     THEN i.it->'complementos' ELSE '[]'::jsonb END) AS c
  ),
  resolvido AS (
    SELECT
      COALESCE(
        (SELECT o.id FROM complemento_opcoes o
          WHERE COALESCE(c->>'opcaoId', '') ~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            AND o.id = (c->>'opcaoId')::uuid),
        (SELECT o.id FROM produto_complemento_grupos pg
           JOIN complemento_opcoes o ON o.grupo_id = pg.grupo_id
          WHERE pg.produto_id = comps.produto_id
            AND o.controla_estoque
            AND lower(unaccent(btrim(o.nome))) = lower(unaccent(btrim(COALESCE(c->>'nome', ''))))
          ORDER BY (o.grupo_id::text = COALESCE(c->>'grupoId', '')) DESC
          LIMIT 1)
      ) AS oid,
      CASE WHEN COALESCE((c->>'absoluto')::boolean, false)
           THEN COALESCE((c->>'qtd')::numeric, 1)
           ELSE COALESCE((c->>'qtd')::numeric, 1) * qtd_item END AS qtd
    FROM comps
  )
  SELECT r.oid, SUM(r.qtd)
    FROM resolvido r
    JOIN complemento_opcoes o ON o.id = r.oid AND o.controla_estoque
    JOIN complemento_grupos g ON g.id = o.grupo_id AND g.empresa_id = p_pedido.empresa_id
   WHERE r.qtd > 0
   GROUP BY r.oid;
$function$;

-- Acerta o estoque dos sabores com o pedido como ele está agora
-- (mesma ideia do sincronizar_estoque_pedido_delivery: exigido − já lançado).
CREATE OR REPLACE FUNCTION public.sincronizar_sabores_pedido_delivery(p_pedido pedidos_delivery)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_linha record;
BEGIN
  IF p_pedido.empresa_id IS NULL THEN RETURN; END IF;

  -- Pedido de antes do estoque por sabor existir não mexe no saldo de hoje.
  IF p_pedido.created_at < '2026-10-28 17:55:00-03'::timestamptz
     AND NOT EXISTS (SELECT 1 FROM complemento_estoque_movimentos WHERE pedido_id = p_pedido.id)
  THEN RETURN; END IF;

  FOR v_linha IN
    WITH exigido AS (
      SELECT e.opcao_id, e.quantidade FROM complemento_exigido_pedido_delivery(p_pedido) e
    ),
    movimentado AS (
      SELECT m.opcao_id,
             SUM(CASE WHEN m.tipo = 'saida' THEN m.quantidade ELSE -m.quantidade END) AS qtd
        FROM complemento_estoque_movimentos m
       WHERE m.pedido_id = p_pedido.id
       GROUP BY m.opcao_id
    )
    SELECT COALESCE(e.opcao_id, m.opcao_id) AS opcao_id,
           COALESCE(e.quantidade, 0) - COALESCE(m.qtd, 0) AS delta
      FROM exigido e
      FULL JOIN movimentado m ON m.opcao_id = e.opcao_id
  LOOP
    CONTINUE WHEN v_linha.opcao_id IS NULL OR v_linha.delta = 0;
    INSERT INTO complemento_estoque_movimentos (empresa_id, opcao_id, tipo, quantidade, motivo, observacao, pedido_id, created_by)
    VALUES (p_pedido.empresa_id, v_linha.opcao_id,
            CASE WHEN v_linha.delta > 0 THEN 'saida' ELSE 'entrada' END,
            ABS(v_linha.delta),
            CASE WHEN v_linha.delta > 0 THEN 'venda' ELSE 'devolucao' END,
            CASE WHEN v_linha.delta > 0 THEN 'Delivery' ELSE 'Estorno delivery' END
              || COALESCE(' #' || p_pedido.numero_pedido::text, ''),
            p_pedido.id, NULL);
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_pedido_delivery_estoque()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM sincronizar_estoque_pedido_delivery(NEW);
  PERFORM sincronizar_mp_pedido_delivery(NEW);
  -- Estoque de sabor nunca pode travar um pedido.
  BEGIN
    PERFORM sincronizar_sabores_pedido_delivery(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'estoque por sabor falhou no pedido %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.sincronizar_sabores_pedido_delivery(pedidos_delivery) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complemento_exigido_pedido_delivery(pedidos_delivery) FROM PUBLIC, anon;
