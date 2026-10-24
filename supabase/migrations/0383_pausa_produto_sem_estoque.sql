-- 0383 — Produto com estoque controlado que zera fica PAUSADO, e o saldo não fica negativo
--
-- Pedido do Agv (24/10/2026): "os produtos com estoque ativado e que chegarem a 0
-- ficam pausados, não pode ficar negativo".
--
-- Ligado POR LOJA (empresas.pausa_sem_estoque, desligado por padrão) e só vale
-- pra produto que a loja DE FATO controla: já teve uma entrada de estoque.
--
-- Por que "já teve entrada": no Agv 87 dos 88 produtos estão com
-- controla_estoque ligado, mas a maioria é prato (self-service, refeições,
-- suco) sem nenhuma entrada lançada — saldo 0 desde sempre. Pausar tudo que
-- está em 0 tiraria o almoço inteiro do ar. Bebida e picolé, que têm entrada,
-- entram na regra.
--
-- Não conta como entrada a devolução (estorno de pedido cancelado): senão um
-- prato vendido e cancelado viraria "controlado" e pausaria.
--
-- O que acontece:
--   1. Saída/ajuste negativo que passaria do saldo é CORTADO no que sobrou (e
--      some se não sobrou nada). Não bloqueia a venda: fechar conta de mesa ou
--      atualizar pedido com item já consumido não pode dar erro.
--   2. Saldo chegou a 0 → produto pausado (ativo=false) e marcado como pausado
--      PELO ESTOQUE.
--   3. Entrou estoque de novo → só volta sozinho o que foi pausado pelo estoque.
--      Quem o dono pausou na mão continua pausado.

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS pausa_sem_estoque boolean NOT NULL DEFAULT false;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS pausado_por_estoque boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION estoque_saldo_produto(p_produto uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(SUM(CASE tipo
                        WHEN 'entrada' THEN quantidade
                        WHEN 'saida'   THEN -quantidade
                        WHEN 'ajuste'  THEN quantidade
                        ELSE 0 END), 0)
    FROM estoque_movimentos WHERE produto_id = p_produto
$$;

CREATE OR REPLACE FUNCTION produto_estoque_gerenciado(p_produto uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM estoque_movimentos
     WHERE produto_id = p_produto
       AND ((tipo = 'entrada' AND COALESCE(motivo, '') <> 'devolucao')
            OR (tipo = 'ajuste' AND quantidade > 0))
  )
$$;

-- 1) Antes de gravar: o saldo não passa de zero.
CREATE OR REPLACE FUNCTION trg_estoque_sem_negativo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_emp   uuid;
  v_flag  boolean;
  v_p     record;
  v_saldo numeric;
BEGIN
  IF NEW.tipo NOT IN ('saida', 'ajuste') THEN RETURN NEW; END IF;

  v_emp := COALESCE(NEW.empresa_id, (SELECT empresa_id FROM produtos WHERE id = NEW.produto_id));
  SELECT pausa_sem_estoque INTO v_flag FROM empresas WHERE id = v_emp;
  IF NOT COALESCE(v_flag, false) THEN RETURN NEW; END IF;

  SELECT controla_estoque, vendido_por_peso INTO v_p FROM produtos WHERE id = NEW.produto_id;
  IF NOT FOUND OR NOT COALESCE(v_p.controla_estoque, false) OR COALESCE(v_p.vendido_por_peso, false) THEN
    RETURN NEW;
  END IF;
  IF NOT produto_estoque_gerenciado(NEW.produto_id) THEN RETURN NEW; END IF;

  v_saldo := estoque_saldo_produto(NEW.produto_id);

  IF NEW.tipo = 'saida' AND NEW.quantidade > v_saldo THEN
    IF v_saldo <= 0 THEN RETURN NULL; END IF;
    NEW.quantidade := v_saldo;
  ELSIF NEW.tipo = 'ajuste' AND NEW.quantidade < 0 AND v_saldo + NEW.quantidade < 0 THEN
    IF v_saldo <= 0 THEN RETURN NULL; END IF;
    NEW.quantidade := -v_saldo;
  ELSE
    RETURN NEW;
  END IF;

  -- o valor acompanha a quantidade que de fato saiu
  IF NEW.custo_unit IS NOT NULL AND NEW.valor_total IS NOT NULL THEN
    NEW.valor_total := NEW.custo_unit * abs(NEW.quantidade);
  END IF;
  RETURN NEW;
END;
$$;

-- 2) Depois de gravar: zerou pausa, voltou estoque reativa (só o que o estoque pausou).
CREATE OR REPLACE FUNCTION trg_pausa_sem_estoque()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_flag  boolean;
  p       record;
  v_saldo numeric;
BEGIN
  SELECT pausa_sem_estoque INTO v_flag FROM empresas
   WHERE id = COALESCE(NEW.empresa_id, (SELECT empresa_id FROM produtos WHERE id = NEW.produto_id));
  IF NOT COALESCE(v_flag, false) THEN RETURN NULL; END IF;

  SELECT id, ativo, controla_estoque, vendido_por_peso, pausado_por_estoque INTO p
    FROM produtos WHERE id = NEW.produto_id;
  IF NOT FOUND OR NOT COALESCE(p.controla_estoque, false) OR COALESCE(p.vendido_por_peso, false) THEN
    RETURN NULL;
  END IF;

  v_saldo := estoque_saldo_produto(NEW.produto_id);

  IF v_saldo <= 0 THEN
    IF p.ativo AND produto_estoque_gerenciado(NEW.produto_id) THEN
      UPDATE produtos SET ativo = false, pausado_por_estoque = true WHERE id = p.id;
    END IF;
  ELSIF p.pausado_por_estoque THEN
    UPDATE produtos SET ativo = true, pausado_por_estoque = false WHERE id = p.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sem_estoque_negativo ON estoque_movimentos;
CREATE TRIGGER trg_sem_estoque_negativo
  BEFORE INSERT ON estoque_movimentos
  FOR EACH ROW EXECUTE FUNCTION trg_estoque_sem_negativo();

DROP TRIGGER IF EXISTS trg_pausa_sem_estoque ON estoque_movimentos;
CREATE TRIGGER trg_pausa_sem_estoque
  AFTER INSERT ON estoque_movimentos
  FOR EACH ROW EXECUTE FUNCTION trg_pausa_sem_estoque();

-- Varredura: lojas com a regra ligada pausam o que já está zerado (rodar de novo
-- depois de ligar a regra numa loja: SELECT pausar_zerados_da_loja('<empresa>')).
CREATE OR REPLACE FUNCTION pausar_zerados_da_loja(p_empresa uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_n integer := 0;
  r   record;
BEGIN
  FOR r IN
    SELECT id FROM produtos
     WHERE empresa_id = p_empresa AND ativo AND controla_estoque
       AND NOT COALESCE(vendido_por_peso, false)
  LOOP
    IF produto_estoque_gerenciado(r.id) AND estoque_saldo_produto(r.id) <= 0 THEN
      UPDATE produtos SET ativo = false, pausado_por_estoque = true WHERE id = r.id;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;
