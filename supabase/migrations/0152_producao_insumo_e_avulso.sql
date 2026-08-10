-- =========================================================
-- 0152: lançar produção do dia sem depender de ficha técnica
-- =========================================================
-- O "Custo de produção do dia" só aceitava item que tivesse ficha técnica.
-- Só que tem coisa que não tem receita nenhuma — batata doce cozida, salada,
-- um saco de carvão — e a loja ficava sem como lançar (Wilde, 10/08/2026).
--
-- Agora a linha pode vir de três lugares:
--   ficha_id         → receita cadastrada (como já era)
--   materia_prima_id → insumo direto do estoque (batata doce), custo do cadastro
--   os dois nulos    → item avulso, digitado na hora com o valor gasto
-- O custo continua saindo de custo_unit × (qtd_feita − qtd_sobrou), então nada
-- muda no fechamento do dia nem no histórico.
-- =========================================================

ALTER TABLE producao_diaria
  ADD COLUMN IF NOT EXISTS materia_prima_id uuid REFERENCES materias_primas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_producao_diaria_mp ON producao_diaria(materia_prima_id);

-- Uma linha vem de UMA origem só (ou de nenhuma, quando é avulsa).
ALTER TABLE producao_diaria DROP CONSTRAINT IF EXISTS producao_diaria_origem_ck;
ALTER TABLE producao_diaria ADD CONSTRAINT producao_diaria_origem_ck
  CHECK (num_nonnulls(ficha_id, materia_prima_id) <= 1);
