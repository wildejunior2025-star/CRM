-- =========================================================
-- 0113: Mesa "Balcão" padrão (protegida) — balcão vende pelo sistema de mesas
-- =========================================================
-- A loja de balcão passa a vender por uma mesa fixa chamada "Balcão" no Salão.
-- Assim a venda de balcão usa o MESMO fluxo das mesas (fechar_conta_presencial),
-- que já registra venda + pagamento e cai no Caixa quando há caixa aberto.
-- A mesa Balcão não pode ser excluída (trigger).
-- =========================================================

ALTER TABLE mesas ADD COLUMN IF NOT EXISTS is_balcao boolean NOT NULL DEFAULT false;

-- Cria a mesa Balcão pra cada empresa que já usa mesas (e ainda não tem uma)
INSERT INTO mesas (empresa_id, numero, nome, capacidade, is_balcao, ativa)
SELECT DISTINCT m.empresa_id, 0, 'Balcão', 1, true, true
FROM mesas m
WHERE NOT EXISTS (SELECT 1 FROM mesas b WHERE b.empresa_id = m.empresa_id AND b.is_balcao = true);

-- Impede excluir a mesa Balcão (defesa no banco, além da UI)
CREATE OR REPLACE FUNCTION public.impedir_excluir_balcao()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_balcao THEN
    RAISE EXCEPTION 'A mesa Balcão não pode ser excluída.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_impedir_excluir_balcao ON mesas;
CREATE TRIGGER trg_impedir_excluir_balcao
  BEFORE DELETE ON mesas
  FOR EACH ROW EXECUTE FUNCTION impedir_excluir_balcao();
