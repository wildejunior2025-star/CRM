-- =========================================================
-- 0050: Comandas e itens do serviço presencial
-- =========================================================
-- comandas       → uma comanda aberta por mesa (ou balcão)
-- comanda_itens  → itens lançados na comanda (status p/ a cozinha/KDS)
-- RLS por empresa (mesmo padrão de mesas).
-- =========================================================

CREATE TABLE IF NOT EXISTS comandas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  mesa_id       uuid REFERENCES mesas(id) ON DELETE SET NULL,
  numero_mesa   integer,
  status        text NOT NULL DEFAULT 'aberta',   -- aberta | fechada | cancelada
  num_pessoas   integer NOT NULL DEFAULT 1,
  garcom_id     uuid,
  observacoes   text,
  subtotal      numeric NOT NULL DEFAULT 0,
  taxa_servico  numeric NOT NULL DEFAULT 0,
  total         numeric NOT NULL DEFAULT 0,
  forma_pagamento text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  fechada_at    timestamptz
);

CREATE TABLE IF NOT EXISTS comanda_itens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  comanda_id     uuid NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  produto_id     text,
  nome           text NOT NULL,
  preco_unitario numeric NOT NULL DEFAULT 0,
  quantidade     integer NOT NULL DEFAULT 1,
  observacao     text,
  status         text NOT NULL DEFAULT 'pendente',  -- pendente | pronto | entregue
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comandas_empresa ON comandas(empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_comanda_itens_comanda ON comanda_itens(comanda_id);
CREATE INDEX IF NOT EXISTS idx_comanda_itens_kds ON comanda_itens(empresa_id, status);

ALTER TABLE comandas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE comanda_itens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comandas_admin_all ON comandas;
CREATE POLICY comandas_admin_all ON comandas
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS comanda_itens_admin_all ON comanda_itens;
CREATE POLICY comanda_itens_admin_all ON comanda_itens
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- Realtime: salão e cozinha atualizam ao vivo entre dispositivos
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE mesas;         EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE comandas;      EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE comanda_itens; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
