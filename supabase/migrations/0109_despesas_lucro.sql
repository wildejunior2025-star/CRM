-- =========================================================
-- 0109: Despesas da loja, funcionários e produção diária
--       (Financeiro → Despesas & Lucro Real)
-- =========================================================
-- despesas_loja    → custos fixos/variáveis mensais (aluguel, energia, água,
--                    internet, gás...). valor = mensal.
-- funcionarios     → cada funcionário com salário mensal (custo de mão de obra).
-- producao_diaria  → "hoje fiz 10kg de feijão e sobrou 2" — puxa o custo por kg
--                    da ficha técnica e calcula o custo do dia.
-- empresas.dias_abertos_mes → pra dividir custo fixo/salário por dia.
-- RLS por empresa (mesmo padrão das outras tabelas).
-- =========================================================

CREATE TABLE IF NOT EXISTS despesas_loja (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  categoria   text NOT NULL DEFAULT 'outros',  -- aluguel|energia|agua|internet|gas|outros
  tipo        text NOT NULL DEFAULT 'fixo',     -- fixo|variavel
  valor       numeric NOT NULL DEFAULT 0,       -- valor MENSAL
  ativo       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS funcionarios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome           text NOT NULL,
  cargo          text,
  salario_mensal numeric NOT NULL DEFAULT 0,
  ativo          boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS producao_diaria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  data        date NOT NULL DEFAULT current_date,
  ficha_id    uuid REFERENCES fichas_tecnicas(id) ON DELETE SET NULL,
  nome        text NOT NULL,
  qtd_feita   numeric NOT NULL DEFAULT 0,
  qtd_sobrou  numeric NOT NULL DEFAULT 0,
  unidade     text NOT NULL DEFAULT 'kg',
  custo_unit  numeric NOT NULL DEFAULT 0,  -- custo por unidade base (snapshot da ficha)
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS dias_abertos_mes integer NOT NULL DEFAULT 26;

CREATE INDEX IF NOT EXISTS idx_despesas_loja_empresa   ON despesas_loja(empresa_id, ativo);
CREATE INDEX IF NOT EXISTS idx_funcionarios_empresa    ON funcionarios(empresa_id, ativo);
CREATE INDEX IF NOT EXISTS idx_producao_diaria_empresa ON producao_diaria(empresa_id, data);

ALTER TABLE despesas_loja   ENABLE ROW LEVEL SECURITY;
ALTER TABLE funcionarios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE producao_diaria ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS despesas_loja_empresa_all ON despesas_loja;
CREATE POLICY despesas_loja_empresa_all ON despesas_loja
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS funcionarios_empresa_all ON funcionarios;
CREATE POLICY funcionarios_empresa_all ON funcionarios
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS producao_diaria_empresa_all ON producao_diaria;
CREATE POLICY producao_diaria_empresa_all ON producao_diaria
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));
