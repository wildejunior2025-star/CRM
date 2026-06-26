-- Migration 0036: número curto de pedido (4 dígitos) + coluna codigo_entrega
-- -------------------------------------------------------------------------
-- Problema: o id UUID era exibido truncado (8 chars hex), confuso para o
-- operador conferir pedido em voz/papel. Queremos um inteiro sequencial
-- por empresa que fique em 4 dígitos (1000–9999) e recomece do zero
-- quando ultrapassar 9999 usando MOD.
--
-- codigo_entrega: 4 dígitos numéricos que o entregador informa ao cliente
-- (ou o cliente apresenta na retirada) para confirmar recebimento.
-- Gerado no frontend ao mover para "saiu_entrega".
-- -------------------------------------------------------------------------

-- 1. Coluna numero_pedido: preenchida por trigger antes do INSERT
ALTER TABLE pedidos_delivery
  ADD COLUMN IF NOT EXISTS numero_pedido  int,
  ADD COLUMN IF NOT EXISTS codigo_entrega text;

-- 2. Sequence global de contador por empresa — usamos uma tabela auxiliar
--    pois o Postgres não suporta sequences por-row-value nativamente.
CREATE TABLE IF NOT EXISTS pedidos_delivery_seq (
  empresa_id  uuid  PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  ultimo_num  int   NOT NULL DEFAULT 999
);

-- RLS na tabela auxiliar — admin da empresa lê/escreve, anon nunca
ALTER TABLE pedidos_delivery_seq ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin gerencia seq da propria empresa"
  ON pedidos_delivery_seq FOR ALL
  TO authenticated
  USING (
    (current_perfil() = 'admin' AND empresa_id = current_empresa_id())
    OR current_perfil() = 'super_admin'
  )
  WITH CHECK (
    (current_perfil() = 'admin' AND empresa_id = current_empresa_id())
    OR current_perfil() = 'super_admin'
  );

-- 3. Função que retorna próximo número (1000–9999, cíclico)
CREATE OR REPLACE FUNCTION next_numero_pedido(p_empresa_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER   -- roda como owner para burlar RLS do anon no INSERT
AS $$
DECLARE
  v_proximo int;
BEGIN
  INSERT INTO pedidos_delivery_seq (empresa_id, ultimo_num)
    VALUES (p_empresa_id, 1000)
  ON CONFLICT (empresa_id) DO UPDATE
    SET ultimo_num = CASE
      WHEN pedidos_delivery_seq.ultimo_num >= 9999 THEN 1000
      ELSE pedidos_delivery_seq.ultimo_num + 1
    END
  RETURNING ultimo_num INTO v_proximo;

  RETURN v_proximo;
END;
$$;

-- 4. Trigger que preenche numero_pedido automaticamente no INSERT
CREATE OR REPLACE FUNCTION trg_set_numero_pedido()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  NEW.numero_pedido := next_numero_pedido(NEW.empresa_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pedidos_delivery_numero ON pedidos_delivery;
CREATE TRIGGER trg_pedidos_delivery_numero
  BEFORE INSERT ON pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION trg_set_numero_pedido();

-- 5. Backfill: gera número curto para pedidos já existentes (sem travar longo)
--    Faz por empresa para manter sequência sensata.
DO $$
DECLARE
  r record;
  v_num int := 1000;
BEGIN
  FOR r IN
    SELECT DISTINCT empresa_id FROM pedidos_delivery
    WHERE numero_pedido IS NULL
    ORDER BY empresa_id
  LOOP
    v_num := 1000;
    UPDATE pedidos_delivery
    SET numero_pedido = sub.rn + 999
    FROM (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY empresa_id ORDER BY created_at) AS rn
      FROM pedidos_delivery
      WHERE empresa_id = r.empresa_id AND numero_pedido IS NULL
    ) sub
    WHERE pedidos_delivery.id = sub.id;

    -- Registra o último número usado para a empresa
    INSERT INTO pedidos_delivery_seq (empresa_id, ultimo_num)
    SELECT r.empresa_id, COALESCE(MAX(numero_pedido), 999)
    FROM pedidos_delivery WHERE empresa_id = r.empresa_id
    ON CONFLICT (empresa_id) DO UPDATE
      SET ultimo_num = EXCLUDED.ultimo_num;
  END LOOP;
END;
$$;
