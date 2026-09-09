-- =========================================================
-- 0249: estoque do pedido acerta pela DIFERENÇA, não por "já lancei"
-- =========================================================
-- A 0155 resolvia o caso simples: pedido nasce, baixa; pedido cancela, devolve.
-- Ela decide isso com uma trava de idempotência boba — se já existe movimento
-- com a observação daquele pedido, não faz mais nada. E os gatilhos só escutam
-- o STATUS. Resultado: mexer nos ITENS de um pedido é invisível pro estoque.
--
-- Dois furos abertos, os dois já valendo hoje na edição de pedido do balcão
-- (o botão "Editar" do gestor):
--
--   1. item ACRESCENTADO num pedido que já baixou nunca sai do estoque. A trava
--      de idempotência vê o movimento antigo e desiste na primeira linha.
--   2. no cancelamento, o estorno percorre os itens de AGORA e devolve tudo --
--      inclusive o item que foi acrescentado e nunca saiu. O saldo INFLA: entra
--      no estoque mercadoria que nunca existiu.
--
-- O jeito certo não é perguntar "já lancei?" e sim "quanto falta?". Para cada
-- produto: quanto este pedido já movimentou (saídas menos entradas) contra
-- quanto ele exige agora. Move só o saldo.
--
-- Isso conserta os dois furos de uma vez e ainda ganha de graça:
--   * item removido devolve ao estoque sozinho;
--   * quantidade alterada (de 5 pra 8) move só as 3;
--   * reprocessar o mesmo pedido não duplica nada -- a diferença dá zero;
--   * cancelar devolve exatamente o que saiu, nem que os itens tenham mudado.
--
-- É pré-requisito da alteração de pedido pelo cliente (adicionar/remover com a
-- loja aceitando): sem isto, cada adição fura o estoque em silêncio.
--
-- Continua valendo tudo da 0155: produto sem controla_estoque não move, loja
-- com estoque_ativo = false não grava (trigger da 0126), pedido em
-- 'aguardando_pagamento' não baixa (o PIX pode nunca cair) e item do iFood
-- casa pelo NOME exato quando não vem produto_id.
-- =========================================================

-- Quanto de cada produto o pedido EXIGE agora, olhando o status.
--
-- Consulta pura, sem tabela temporária: esta função roda dentro de trigger, e
-- temp table em chamada aninhada dá conflito de nome no meio de um INSERT.
CREATE OR REPLACE FUNCTION public.estoque_exigido_pedido_delivery(p_pedido pedidos_delivery)
RETURNS TABLE (produto_id uuid, quantidade numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH linhas AS (
    -- Cancelado ou esperando o PIX cair: exige zero. É isto que faz o estorno
    -- acontecer sem precisar de um caminho separado -- a diferença fica
    -- negativa e o saldo volta pro estoque sozinho.
    SELECT it
      FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(p_pedido.itens) = 'array'
                AND COALESCE(p_pedido.status, '') NOT IN ('cancelado', 'aguardando_pagamento')
               THEN p_pedido.itens
               ELSE '[]'::jsonb
             END
           ) AS it
  ),
  resolvido AS (
    SELECT
      COALESCE(
        -- 1) id do produto, quando o pedido manda
        CASE
          WHEN COALESCE(it->>'produto_id', '') ~
               '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (it->>'produto_id')::uuid
        END,
        -- 2) senão, nome exato do catálogo da loja (é o caso do iFood, que
        --    manda só o nome -- e o catálogo de lá sai daqui, então bate)
        (SELECT p.id FROM produtos p
          WHERE p.empresa_id = p_pedido.empresa_id
            AND btrim(COALESCE(it->>'nome', '')) <> ''
            AND lower(unaccent(btrim(p.nome))) = lower(unaccent(btrim(it->>'nome')))
          LIMIT 1)
      ) AS pid,
      COALESCE((it->>'quantidade')::numeric, (it->>'qtd')::numeric, 1) AS qtd
    FROM linhas
  )
  -- O MESMO produto aparece em linhas diferentes (sabores diferentes da
  -- quentinha, o mesmo refri montado de dois jeitos). Somar aqui é o que faz a
  -- diferença bater com a realidade lá na frente.
  SELECT r.pid, SUM(r.qtd)
    FROM resolvido r
   WHERE r.pid IS NOT NULL
     AND r.qtd > 0
     -- Produto de outra loja ou sem controle de estoque: não entra na conta.
     AND EXISTS (
       SELECT 1 FROM produtos p
        WHERE p.id = r.pid AND p.empresa_id = p_pedido.empresa_id
          AND COALESCE(p.controla_estoque, true) = true
     )
   GROUP BY r.pid;
$$;

-- Acerta o estoque do pedido: move só a diferença entre o que ele exige agora
-- e o que ele já movimentou.
CREATE OR REPLACE FUNCTION public.sincronizar_estoque_pedido_delivery(p_pedido pedidos_delivery)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_marca text;
  v_linha record;
BEGIN
  IF p_pedido.empresa_id IS NULL THEN RETURN; END IF;

  -- O id do pedido no fim da observação é o que amarra o movimento ao pedido.
  -- É por ele que a conta do "já movimentado" acha o que saiu antes -- inclusive
  -- o que a 0155 lançou, então pedido antigo continua batendo.
  v_marca := '%' || p_pedido.id::text;

  -- TRAVA DE CORTE: pedido antigo que NUNCA movimentou nada não passa a
  -- movimentar agora.
  --
  -- Sem isto, ligar este gatilho fazia venda velha cair no saldo de hoje: nos
  -- 45 dias antes da correção havia 5 pedidos assim na Marajó -- refrigerante
  -- de julho cujo produto só passou a controlar estoque em agosto. Encostar
  -- neles (mudar status, editar item) baixaria hoje uma saída de julho.
  --
  -- Pedido que já movimentou não cai aqui e segue sendo acertado normalmente,
  -- que é o caso de todo pedido do dia.
  IF p_pedido.created_at < '2026-09-09 00:00:00-03'::timestamptz
     AND NOT EXISTS (
       SELECT 1 FROM estoque_movimentos m
        WHERE m.empresa_id = p_pedido.empresa_id AND m.observacao LIKE v_marca
     )
  THEN RETURN; END IF;

  FOR v_linha IN
    WITH exigido AS (
      SELECT e.produto_id, e.quantidade
        FROM estoque_exigido_pedido_delivery(p_pedido) e
    ),
    movimentado AS (
      SELECT m.produto_id,
             SUM(CASE WHEN m.tipo = 'saida' THEN m.quantidade ELSE -m.quantidade END) AS qtd
        FROM estoque_movimentos m
       WHERE m.empresa_id = p_pedido.empresa_id
         AND m.observacao LIKE v_marca
       GROUP BY m.produto_id
    )
    -- FULL JOIN: o produto que sumiu dos itens (removido, ou pedido cancelado)
    -- não está mais em `exigido`, mas está em `movimentado` -- e é justamente
    -- ele que precisa voltar pro estoque.
    SELECT COALESCE(e.produto_id, m.produto_id) AS produto_id,
           COALESCE(e.quantidade, 0) - COALESCE(m.qtd, 0) AS delta
      FROM exigido e
      FULL JOIN movimentado m ON m.produto_id = e.produto_id
  LOOP
    CONTINUE WHEN v_linha.produto_id IS NULL OR v_linha.delta = 0;

    INSERT INTO estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)
    VALUES (
      p_pedido.empresa_id,
      v_linha.produto_id,
      CASE WHEN v_linha.delta > 0 THEN 'saida' ELSE 'entrada' END,
      ABS(v_linha.delta),
      CASE WHEN v_linha.delta > 0 THEN 'venda' ELSE 'devolucao' END,
      CASE WHEN v_linha.delta > 0 THEN 'Delivery' ELSE 'Estorno delivery' END
        || COALESCE(' #' || p_pedido.numero_pedido::text, '')
        || ' · ' || p_pedido.id::text
    );
  END LOOP;
END;
$$;

-- Um gatilho só, para INSERT e para UPDATE de status OU de itens.
-- A 0155 tinha dois, e nenhum escutava os itens.
CREATE OR REPLACE FUNCTION public.trg_pedido_delivery_estoque()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM sincronizar_estoque_pedido_delivery(NEW);
  RETURN NULL;   -- AFTER trigger
END;
$$;

DROP TRIGGER IF EXISTS trg_pedido_delivery_estoque_ins ON pedidos_delivery;
CREATE TRIGGER trg_pedido_delivery_estoque_ins
  AFTER INSERT ON pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.trg_pedido_delivery_estoque();

DROP TRIGGER IF EXISTS trg_pedido_delivery_estoque_upd ON pedidos_delivery;
CREATE TRIGGER trg_pedido_delivery_estoque_upd
  AFTER UPDATE OF status, itens ON pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.trg_pedido_delivery_estoque();

-- A função da 0155 fica no banco, mas ninguém mais chama: deixá-la de pé evita
-- quebrar qualquer chamada solta que exista por aí, e a nova não depende dela.
COMMENT ON FUNCTION public.mover_estoque_pedido_delivery(pedidos_delivery, boolean)
  IS 'Obsoleta desde a 0249 - use sincronizar_estoque_pedido_delivery(), que acerta pela diferenca.';
