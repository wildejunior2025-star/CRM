-- =========================================================
-- 0110: Histórico de despesas diárias (fechamento do dia)
-- =========================================================
-- Quando o dono "fecha o dia" no Financeiro → Despesas & Lucro, grava aqui um
-- resumo do dia (receita líquida, custos e lucro) e limpa a produção do dia.
-- Depois ele consulta na aba "Histórico de despesas diárias".
-- Um registro por dia (empresa_id, data) — refechar o mesmo dia atualiza.
-- =========================================================

CREATE TABLE IF NOT EXISTS historico_dia (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  data               date NOT NULL,
  receita_liquida    numeric NOT NULL DEFAULT 0,
  custo_fixo         numeric NOT NULL DEFAULT 0,   -- rateio do dia (mensal / dias abertos)
  custo_funcionarios numeric NOT NULL DEFAULT 0,   -- rateio do dia
  custo_producao     numeric NOT NULL DEFAULT 0,   -- produção lançada no dia
  lucro              numeric NOT NULL DEFAULT 0,
  itens              jsonb   NOT NULL DEFAULT '[]', -- snapshot da produção do dia
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, data)
);

CREATE INDEX IF NOT EXISTS idx_historico_dia_empresa ON historico_dia(empresa_id, data DESC);

ALTER TABLE historico_dia ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS historico_dia_empresa_all ON historico_dia;
CREATE POLICY historico_dia_empresa_all ON historico_dia
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));
