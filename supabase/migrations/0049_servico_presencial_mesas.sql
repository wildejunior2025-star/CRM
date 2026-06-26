-- =========================================================
-- 0049: Serviço presencial — config na empresa + tabela de mesas
-- =========================================================
-- Primeira entrega do módulo de atendimento presencial (mesas/comandas).
--  • empresas.presencial_ativo  → liga/desliga o módulo para a loja
--  • empresas.taxa_servico_pct   → taxa de serviço (ex.: 10%)
--  • tabela mesas                → cadastro das mesas do salão
-- =========================================================

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS presencial_ativo  boolean NOT NULL DEFAULT false;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS taxa_servico_pct  numeric NOT NULL DEFAULT 10;

CREATE TABLE IF NOT EXISTS mesas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  numero      integer NOT NULL,
  nome        text,
  capacidade  integer NOT NULL DEFAULT 4,
  status      text NOT NULL DEFAULT 'livre',  -- livre | ocupada | conta | reservada
  ativa       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_mesas_empresa ON mesas(empresa_id);

ALTER TABLE mesas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mesas_admin_all ON mesas;
CREATE POLICY mesas_admin_all ON mesas
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));
