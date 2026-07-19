-- =========================================================
-- 0112: Custos imprevistos do dia (Financeiro → Despesas & Lucro)
-- =========================================================
-- Gastos não planejados do dia: pedido cancelado cujo produto não deu pra
-- aproveitar, algo que caiu/quebrou, uma compra de emergência etc. Entra no
-- lucro do dia e vai pro snapshot quando o dia é fechado (aí a lista limpa).
-- =========================================================

CREATE TABLE IF NOT EXISTS custos_imprevistos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  data        date NOT NULL DEFAULT current_date,
  descricao   text NOT NULL,
  valor       numeric NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custos_imprevistos_empresa ON custos_imprevistos(empresa_id, data);

ALTER TABLE custos_imprevistos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custos_imprevistos_empresa_all ON custos_imprevistos;
CREATE POLICY custos_imprevistos_empresa_all ON custos_imprevistos
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- Snapshot no fechamento do dia
ALTER TABLE public.historico_dia ADD COLUMN IF NOT EXISTS custo_imprevisto numeric NOT NULL DEFAULT 0;
ALTER TABLE public.historico_dia ADD COLUMN IF NOT EXISTS imprevistos      jsonb   NOT NULL DEFAULT '[]';
