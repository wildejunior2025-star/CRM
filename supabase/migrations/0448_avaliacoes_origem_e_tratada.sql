-- =========================================================
-- 0448: Tela "Avaliações" do gestor — origem da nota e "já falei com o cliente"
-- =========================================================
-- A nota já é gravada em pedidos_delivery (mig 0068) por dois caminhos: o cliente
-- na página do pedido (RPC avaliar_pedido) e o robô do WhatsApp (gravarAvaliacao).
-- Faltava saber DE ONDE veio e quem já tratou a nota baixa.
--
--   avaliacao_origem      'pagina' | 'whatsapp'
--   avaliacao_tratada_at  quando a loja marcou "já falei com o cliente"
--   avaliacao_tratada_por quem marcou (profiles.id / auth.uid())
--
-- Leitura e escrita pelo gestor usam as policies que o admin já tem em
-- pedidos_delivery ("Admin gerencia pedidos da propria empresa"): nada novo aqui.
-- =========================================================

ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS avaliacao_origem      text,
  ADD COLUMN IF NOT EXISTS avaliacao_tratada_at  timestamptz,
  ADD COLUMN IF NOT EXISTS avaliacao_tratada_por uuid;

ALTER TABLE pedidos_delivery
  DROP CONSTRAINT IF EXISTS pedidos_delivery_avaliacao_origem_chk;
ALTER TABLE pedidos_delivery
  ADD CONSTRAINT pedidos_delivery_avaliacao_origem_chk
  CHECK (avaliacao_origem IS NULL OR avaliacao_origem IN ('pagina', 'whatsapp'));

-- A página do pedido grava pela RPC: agora ela carimba a origem.
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
         avaliacao_at         = now(),
         avaliacao_origem     = 'pagina'
   WHERE id = p_pedido_id
     AND status = 'entregue';
END;
$$;

-- CREATE OR REPLACE mantém os GRANTs, mas repetir não custa nada.
GRANT EXECUTE ON FUNCTION avaliar_pedido(uuid, int, text) TO anon, authenticated;

-- Notas que já existem. Antes de 05/11/2026 o robô nem lia a resposta, então só
-- podem ter vindo da página. Depois disso, é do WhatsApp quando há uma mensagem
-- do cliente só com a nota (1 a 5) no minuto anterior à gravação.
-- Os gatilhos de pedidos_delivery (cashback, indicação, aviso do iFood) rodam em
-- QUALQUER update. Este só carimba uma coluna de rótulo em pedido já entregue:
-- desliga os gatilhos de usuário na transação, pra não reprocessar nada. O
-- ALTER segura a tabela até o fim da migration, então nenhum pedido novo
-- passa sem gatilho no meio. (Conferido antes: os 20 estavam todos ligados.)
ALTER TABLE pedidos_delivery DISABLE TRIGGER USER;

UPDATE pedidos_delivery p
   SET avaliacao_origem = CASE
     WHEN p.avaliacao_at >= '2026-11-05 15:00:00+00'
      AND EXISTS (
        SELECT 1 FROM whatsapp_conversas c
         WHERE c.empresa_id = p.empresa_id
           AND c.role = 'user'
           AND right(regexp_replace(c.phone, '\D', '', 'g'), 8)
             = right(regexp_replace(COALESCE(p.cliente_telefone, ''), '\D', '', 'g'), 8)
           AND c.created_at BETWEEN p.avaliacao_at - interval '1 minute' AND p.avaliacao_at
           AND c.content ~ '^\s*[1-5]'
      ) THEN 'whatsapp'
     ELSE 'pagina' END
 WHERE p.avaliacao_nota IS NOT NULL
   AND p.avaliacao_origem IS NULL;

ALTER TABLE pedidos_delivery ENABLE TRIGGER USER;

-- A tela lista por loja e por data da avaliação.
CREATE INDEX IF NOT EXISTS pedidos_delivery_avaliacao_idx
  ON pedidos_delivery (empresa_id, avaliacao_at DESC)
  WHERE avaliacao_nota IS NOT NULL;
