-- =========================================================
-- 0155: pedido do delivery também dá baixa no estoque
-- =========================================================
-- Só o presencial (mesa, comanda, balcão do salão) descontava estoque. Refri
-- vendido no delivery saía da geladeira e o sistema não via — o saldo ficava
-- errado e, desde a 0152, o custo de revenda do dia também (Wilde, 10/08/2026).
--
-- Agora um trigger no pedido faz a mesma coisa que o salão já fazia:
--   pedido criado    → saída, motivo 'venda'
--   pedido cancelado → entrada de volta, motivo 'devolucao'
--
-- Menos quando o pedido nasce em 'aguardando_pagamento' (PIX online): esse aí
-- pode nunca ser pago, e baixar na hora sumiria com refri que continua na
-- geladeira. Ele só desconta quando o pagamento entra e o status anda.
-- O estorno também só acontece se aquele pedido chegou a descontar algo.
--
-- Como o item acha o produto:
--   1. produto_id no item (cardápio, balcão e WhatsApp mandam)
--   2. senão, pelo NOME exato do catálogo, ignorando acento/maiúscula — é o
--      caso do iFood, que manda só o nome (o catálogo de lá sai daqui, então
--      o nome bate). Não achou nome exato, não movimenta nada: melhor não
--      mexer do que baixar do produto errado.
--
-- Continua valendo o que já existia: produto sem controla_estoque não move, e
-- loja com estoque_ativo = false não grava nada (trigger da 0126).
-- Idempotente: a observação carrega o id do pedido e nada é lançado duas vezes.
-- =========================================================

CREATE OR REPLACE FUNCTION public.mover_estoque_pedido_delivery(p_pedido pedidos_delivery, p_estorno boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item     jsonb;
  v_prod     uuid;
  v_qtd      numeric;
  v_nome     text;
  v_obs      text;
  v_uuid_re  text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF p_pedido.empresa_id IS NULL OR jsonb_typeof(p_pedido.itens) <> 'array' THEN RETURN; END IF;

  v_obs := CASE WHEN p_estorno THEN 'Estorno delivery' ELSE 'Delivery' END
           || COALESCE(' #' || p_pedido.numero_pedido::text, '') || ' · ' || p_pedido.id::text;

  -- Já lançado antes? (repique de trigger, reprocesso do iFood, clique duplo)
  IF EXISTS (SELECT 1 FROM estoque_movimentos WHERE observacao = v_obs) THEN RETURN; END IF;

  -- Estorno só devolve o que esse pedido tirou. Pedido que foi cancelado sem
  -- nunca ter descontado (PIX não pago) não pode virar entrada do nada.
  IF p_estorno AND NOT EXISTS (
    SELECT 1 FROM estoque_movimentos
     WHERE tipo = 'saida' AND observacao LIKE 'Delivery%' AND observacao LIKE '%' || p_pedido.id::text
  ) THEN RETURN; END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_pedido.itens)
  LOOP
    v_prod := NULL;
    v_qtd  := COALESCE((v_item->>'quantidade')::numeric, (v_item->>'qtd')::numeric, 1);
    IF v_qtd <= 0 THEN CONTINUE; END IF;

    -- 1) id do produto, quando o pedido manda
    IF COALESCE(v_item->>'produto_id', '') ~ v_uuid_re THEN
      v_prod := (v_item->>'produto_id')::uuid;
    END IF;

    -- 2) senão, nome exato do catálogo da loja (iFood)
    IF v_prod IS NULL THEN
      v_nome := lower(unaccent(btrim(COALESCE(v_item->>'nome', ''))));
      IF v_nome <> '' THEN
        SELECT id INTO v_prod FROM produtos
         WHERE empresa_id = p_pedido.empresa_id
           AND lower(unaccent(btrim(nome))) = v_nome
         LIMIT 1;
      END IF;
    END IF;

    IF v_prod IS NULL THEN CONTINUE; END IF;

    -- Produto de outra loja ou sem controle de estoque: não mexe.
    IF NOT EXISTS (
      SELECT 1 FROM produtos
       WHERE id = v_prod AND empresa_id = p_pedido.empresa_id
         AND COALESCE(controla_estoque, true) = true
    ) THEN CONTINUE; END IF;

    INSERT INTO estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)
    VALUES (p_pedido.empresa_id, v_prod,
            CASE WHEN p_estorno THEN 'entrada' ELSE 'saida' END,
            v_qtd,
            CASE WHEN p_estorno THEN 'devolucao' ELSE 'venda' END,
            v_obs);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_pedido_delivery_estoque()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Nasceu cancelado (não tira nada) ou esperando o PIX cair (ainda não é venda).
    IF COALESCE(NEW.status, '') NOT IN ('cancelado', 'aguardando_pagamento') THEN
      PERFORM mover_estoque_pedido_delivery(NEW, false);
    END IF;

  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'cancelado' THEN
      PERFORM mover_estoque_pedido_delivery(NEW, true);
    ELSIF COALESCE(OLD.status, '') = 'aguardando_pagamento' THEN
      -- PIX pago: agora sim virou venda de verdade e sai do estoque.
      PERFORM mover_estoque_pedido_delivery(NEW, false);
    END IF;
  END IF;
  RETURN NULL;   -- AFTER trigger
END;
$$;

DROP TRIGGER IF EXISTS trg_pedido_delivery_estoque_ins ON pedidos_delivery;
CREATE TRIGGER trg_pedido_delivery_estoque_ins
  AFTER INSERT ON pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.trg_pedido_delivery_estoque();

DROP TRIGGER IF EXISTS trg_pedido_delivery_estoque_upd ON pedidos_delivery;
CREATE TRIGGER trg_pedido_delivery_estoque_upd
  AFTER UPDATE OF status ON pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.trg_pedido_delivery_estoque();
