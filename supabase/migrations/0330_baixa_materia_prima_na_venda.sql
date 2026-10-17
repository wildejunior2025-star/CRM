-- =========================================================
-- 0330: venda dá baixa na MATÉRIA-PRIMA (hambúrguer, carne, queijo...) pela ficha
-- =========================================================
-- O saldo da matéria-prima (mig 0140) só mexia quando alguém lançava à mão. Agora,
-- na ficha técnica que estiver com "baixa_estoque" ligada, cada venda do produto
-- desconta da matéria-prima o que a receita manda.
--
-- Liga POR FICHA, de propósito: lojas que já têm ficha só pra calcular custo
-- (CDBom, Estação do Sabor) não passam a ter saldo mexendo sozinho.
--
-- Cobre:
--   * pedidos_delivery (Loja Online, balcão da "Nova venda", robô, iFood): acerta
--     pela DIFERENÇA, igual ao estoque de produto (mig 0249) — cancelar devolve,
--     editar item acerta, reprocessar não duplica.
--   * venda_itens (comanda de salão/mesa, na hora de fechar a conta).
--
-- Devolução entra como tipo 'ajuste' (positivo), não 'entrada': a aba "Compras"
-- lista as entradas como compra, e estorno de venda não é compra.
-- =========================================================

ALTER TABLE public.fichas_tecnicas
  ADD COLUMN IF NOT EXISTS baixa_estoque boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS baixa_desde   timestamptz;

COMMENT ON COLUMN public.fichas_tecnicas.baixa_estoque IS
  'true = cada venda do produto desta ficha desconta as matérias-primas dela do estoque (mig 0330).';
COMMENT ON COLUMN public.fichas_tecnicas.baixa_desde IS
  'Vendas anteriores a este momento não dão baixa (nasce quando a baixa é ligada).';

-- Fator pra levar a unidade da receita até a base (g, ml ou un).
CREATE OR REPLACE FUNCTION public.mp_fator_unidade(p_un text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(btrim(coalesce(p_un, '')))
           WHEN 'kg' THEN 1000 WHEN 'l' THEN 1000 ELSE 1 END
$$;

-- O que UMA venda de p_qtd unidades do produto consome de cada matéria-prima,
-- já na unidade em que a matéria-prima está cadastrada.
CREATE OR REPLACE FUNCTION public.mp_consumo_do_produto(p_produto uuid, p_qtd numeric, p_quando timestamptz)
RETURNS TABLE (materia_prima_id uuid, quantidade numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT i.materia_prima_id,
         SUM(
           i.quantidade * mp_fator_unidade(i.unidade) / mp_fator_unidade(mp.unidade)
           * p_qtd
           / GREATEST(
               CASE WHEN f.peso_porcao > 0 AND f.rendimento > 0
                    THEN (f.rendimento * mp_fator_unidade(f.unid_rendimento))
                       / (f.peso_porcao * mp_fator_unidade(f.unid_porcao))
                    ELSE 1 END,
               0.0001)
         )
    FROM fichas_tecnicas f
    JOIN ficha_itens i       ON i.ficha_id = f.id AND i.materia_prima_id IS NOT NULL
    JOIN materias_primas mp  ON mp.id = i.materia_prima_id
   WHERE f.produto_id = p_produto
     AND f.baixa_estoque = true
     AND (f.baixa_desde IS NULL OR f.baixa_desde <= p_quando)
   GROUP BY i.materia_prima_id
$$;

-- Quanto de cada matéria-prima o pedido exige AGORA (cancelado/aguardando PIX = zero).
CREATE OR REPLACE FUNCTION public.mp_exigida_pedido_delivery(p_pedido pedidos_delivery)
RETURNS TABLE (materia_prima_id uuid, quantidade numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH linhas AS (
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
        CASE
          WHEN COALESCE(it->>'produto_id', '') ~
               '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          THEN (it->>'produto_id')::uuid
        END,
        (SELECT p.id FROM produtos p
          WHERE p.empresa_id = p_pedido.empresa_id
            AND btrim(COALESCE(it->>'nome', '')) <> ''
            AND lower(unaccent(btrim(p.nome))) = lower(unaccent(btrim(it->>'nome')))
          LIMIT 1)
      ) AS pid,
      COALESCE((it->>'quantidade')::numeric, (it->>'qtd')::numeric, 1) AS qtd
    FROM linhas
  ),
  por_produto AS (
    SELECT r.pid, SUM(r.qtd) AS qtd
      FROM resolvido r
     WHERE r.pid IS NOT NULL AND r.qtd > 0
       AND EXISTS (SELECT 1 FROM produtos p WHERE p.id = r.pid AND p.empresa_id = p_pedido.empresa_id)
     GROUP BY r.pid
  )
  SELECT c.materia_prima_id, SUM(c.quantidade)
    FROM por_produto pp
    CROSS JOIN LATERAL mp_consumo_do_produto(pp.pid, pp.qtd, p_pedido.created_at) c
   GROUP BY c.materia_prima_id
$$;

CREATE OR REPLACE FUNCTION public.sincronizar_mp_pedido_delivery(p_pedido pedidos_delivery)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_marca text;
  v_linha record;
BEGIN
  IF p_pedido.empresa_id IS NULL THEN RETURN; END IF;
  v_marca := '%' || p_pedido.id::text;

  FOR v_linha IN
    WITH exigido AS (
      SELECT e.materia_prima_id, e.quantidade FROM mp_exigida_pedido_delivery(p_pedido) e
    ),
    movimentado AS (
      SELECT m.materia_prima_id,
             SUM(CASE WHEN m.tipo = 'saida' THEN m.quantidade
                      WHEN m.tipo = 'ajuste' THEN -m.quantidade ELSE 0 END) AS qtd
        FROM materia_prima_movimentos m
       WHERE m.empresa_id = p_pedido.empresa_id AND m.observacao LIKE v_marca
       GROUP BY m.materia_prima_id
    )
    SELECT COALESCE(e.materia_prima_id, m.materia_prima_id) AS materia_prima_id,
           COALESCE(e.quantidade, 0) - COALESCE(m.qtd, 0) AS delta
      FROM exigido e
      FULL JOIN movimentado m ON m.materia_prima_id = e.materia_prima_id
  LOOP
    CONTINUE WHEN v_linha.materia_prima_id IS NULL OR abs(v_linha.delta) < 0.0001;

    INSERT INTO materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao)
    VALUES (
      p_pedido.empresa_id, v_linha.materia_prima_id,
      CASE WHEN v_linha.delta > 0 THEN 'saida' ELSE 'ajuste' END,
      ABS(v_linha.delta),
      CASE WHEN v_linha.delta > 0 THEN 'Venda' ELSE 'Estorno de venda' END
        || COALESCE(' #' || p_pedido.numero_pedido::text, '')
        || ' · ' || p_pedido.id::text
    );
  END LOOP;
END;
$$;

-- O gatilho do estoque de produto (0249) passa a cuidar dos dois.
CREATE OR REPLACE FUNCTION public.trg_pedido_delivery_estoque()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  PERFORM sincronizar_estoque_pedido_delivery(NEW);
  PERFORM sincronizar_mp_pedido_delivery(NEW);
  RETURN NULL;   -- AFTER trigger
END;
$$;

-- Salão / mesa: a conta fechada gera venda_itens; cada linha dá a baixa uma vez.
CREATE OR REPLACE FUNCTION public.trg_venda_item_mp()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_linha record;
BEGIN
  IF NEW.produto_id IS NULL OR NEW.empresa_id IS NULL OR COALESCE(NEW.quantidade, 0) <= 0 THEN
    RETURN NULL;
  END IF;
  FOR v_linha IN SELECT * FROM mp_consumo_do_produto(NEW.produto_id::uuid, NEW.quantidade::numeric, now())
  LOOP
    INSERT INTO materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao)
    VALUES (NEW.empresa_id, v_linha.materia_prima_id, 'saida', v_linha.quantidade,
            'Venda no salão · ' || NEW.venda_id::text);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_venda_item_mp ON public.venda_itens;
CREATE TRIGGER trg_venda_item_mp
  AFTER INSERT ON public.venda_itens
  FOR EACH ROW EXECUTE FUNCTION public.trg_venda_item_mp();
