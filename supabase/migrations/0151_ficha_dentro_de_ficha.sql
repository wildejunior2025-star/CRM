-- =========================================================
-- 0151: ficha técnica DENTRO de ficha técnica (sub-receita)
-- =========================================================
-- A loja faz a massa uma vez e usa ela em vários produtos: a "Massa de coxinha"
-- é uma ficha, e a ficha da "Coxinha" gasta 50 g dessa massa. Antes só dava pra
-- pôr matéria-prima na linha, então a loja tinha que repetir farinha + água +
-- sal em toda receita (e refazer tudo quando o preço da farinha mudava).
--
-- Agora a linha da receita aponta pra UMA das duas coisas:
--   materia_prima_id → insumo comprado (farinha)
--   ficha_ref_id     → outra ficha usada como ingrediente (massa pronta)
-- O custo da sub-receita entra por unidade base dela (custo total ÷ rendimento).
--
-- ON DELETE RESTRICT: apagar uma ficha que é ingrediente de outra deixaria a
-- receita de cima com um buraco no custo — o app avisa quem está usando.
-- =========================================================

ALTER TABLE ficha_itens
  ADD COLUMN IF NOT EXISTS ficha_ref_id uuid REFERENCES fichas_tecnicas(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_ficha_itens_ficha_ref ON ficha_itens(ficha_ref_id);

-- Uma linha é insumo OU sub-receita, nunca as duas (nem aponta pra si mesma).
ALTER TABLE ficha_itens DROP CONSTRAINT IF EXISTS ficha_itens_origem_ck;
ALTER TABLE ficha_itens ADD CONSTRAINT ficha_itens_origem_ck
  CHECK (num_nonnulls(materia_prima_id, ficha_ref_id) <= 1 AND ficha_ref_id IS DISTINCT FROM ficha_id);
