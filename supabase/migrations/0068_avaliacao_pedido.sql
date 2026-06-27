-- =========================================================
-- 0068: Avaliação do pedido de delivery pelo cliente
-- =========================================================
-- Depois de "entregue", o cliente pode dar uma nota (1-5) e um comentário
-- na própria página de acompanhamento (sem login). Como o acesso é anônimo,
-- a gravação passa por um RPC SECURITY DEFINER que só mexe nos campos da
-- avaliação e só em pedido já entregue.
-- =========================================================

ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS avaliacao_nota       smallint,
  ADD COLUMN IF NOT EXISTS avaliacao_comentario text,
  ADD COLUMN IF NOT EXISTS avaliacao_at         timestamptz;

CREATE OR REPLACE FUNCTION avaliar_pedido(
  p_pedido_id  uuid,
  p_nota       int,
  p_comentario text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_nota IS NULL OR p_nota < 1 OR p_nota > 5 THEN
    RAISE EXCEPTION 'Nota inválida (use de 1 a 5).';
  END IF;

  UPDATE pedidos_delivery
     SET avaliacao_nota       = p_nota,
         avaliacao_comentario = NULLIF(btrim(COALESCE(p_comentario, '')), ''),
         avaliacao_at         = now()
   WHERE id = p_pedido_id
     AND status = 'entregue';
END;
$$;

GRANT EXECUTE ON FUNCTION avaliar_pedido(uuid, int, text) TO anon, authenticated;
