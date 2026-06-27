-- =========================================================
-- 0065: Reservas e fila de espera (Serviço Presencial)
-- =========================================================
-- O4 — atendimento presencial mais completo:
--  • reservas      → cliente liga e agenda mesa (data/hora, nº pessoas,
--                    ocasião como aniversário, mesa preferida)
--  • fila_espera   → walk-in do dia: cliente chega sem mesa e entra na fila
-- WhatsApp fica pra depois (plugar junto com o bot). Sem coluna de cliente
-- vinculado por ora — nome/telefone digitados na hora, como no balcão.
-- =========================================================

CREATE TABLE IF NOT EXISTS reservas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_nome     text NOT NULL,
  cliente_telefone text,
  data_reserva     date NOT NULL,
  hora_reserva     time NOT NULL,
  num_pessoas      integer NOT NULL DEFAULT 2,
  mesa_id          uuid REFERENCES mesas(id) ON DELETE SET NULL,
  ocasiao          text,            -- ex: aniversario, comemoracao, normal
  observacoes      text,
  status           text NOT NULL DEFAULT 'pendente',
                   -- pendente | confirmada | cumprida | cancelada | nao_compareceu
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reservas_empresa_data ON reservas(empresa_id, data_reserva);

ALTER TABLE reservas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservas_empresa_all ON reservas;
CREATE POLICY reservas_empresa_all ON reservas
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));


CREATE TABLE IF NOT EXISTS fila_espera (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  cliente_nome     text NOT NULL,
  cliente_telefone text,
  num_pessoas      integer NOT NULL DEFAULT 2,
  observacoes      text,
  status           text NOT NULL DEFAULT 'aguardando',
                   -- aguardando | chamado | sentou | desistiu
  chamado_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fila_empresa_status ON fila_espera(empresa_id, status);

ALTER TABLE fila_espera ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fila_empresa_all ON fila_espera;
CREATE POLICY fila_empresa_all ON fila_espera
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));
