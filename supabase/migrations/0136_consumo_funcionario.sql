-- 0136_consumo_funcionario.sql
-- Lançar o que o funcionário consome (almoço, item do estoque) pra: (1) dar baixa no
-- estoque e (2) saber quanto se gasta de alimentação com a equipe. É um RELATÓRIO À
-- PARTE — NÃO entra no cálculo do lucro do dia. Valor do item do estoque = preço de
-- VENDA (editável); refeição/avulso = valor digitado na hora.

CREATE TABLE IF NOT EXISTS public.consumo_funcionario (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL DEFAULT current_empresa_id(),
  funcionario_id uuid REFERENCES public.funcionarios(id) ON DELETE SET NULL,
  funcionario_nome text,
  produto_id     uuid REFERENCES public.produtos(id) ON DELETE SET NULL,
  descricao      text NOT NULL,
  quantidade     numeric NOT NULL DEFAULT 1,
  valor_unitario numeric NOT NULL DEFAULT 0,
  valor_total    numeric NOT NULL DEFAULT 0,
  baixou_estoque boolean NOT NULL DEFAULT false,
  observacao     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.consumo_funcionario ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='consumo_funcionario' AND policyname='consumo_func_sel') THEN
    CREATE POLICY consumo_func_sel ON public.consumo_funcionario
      FOR SELECT TO authenticated USING (empresa_id = current_empresa_id());
  END IF;
END $$;

-- Registrar um consumo. Produto do catálogo dá baixa no estoque (se controla) e o
-- valor cai no preço de venda por padrão (mas aceita valor manual). Sem produto é
-- refeição/avulso (descrição + valor, sem estoque).
CREATE OR REPLACE FUNCTION public.registrar_consumo_funcionario(
  p_funcionario_id uuid,
  p_produto_id uuid,
  p_descricao text,
  p_quantidade numeric,
  p_valor_unitario numeric,
  p_observacao text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp    uuid := current_empresa_id();
  v_qtd    numeric := COALESCE(NULLIF(p_quantidade, 0), 1);
  v_desc   text := btrim(COALESCE(p_descricao, ''));
  v_unit   numeric;
  v_baixou boolean := false;
  v_fnome  text;
  v_pnome  text;
  v_pvenda numeric;
  v_ctrl   boolean;
  v_id     uuid;
BEGIN
  IF v_qtd <= 0 THEN RAISE EXCEPTION 'Quantidade inválida.'; END IF;

  IF p_funcionario_id IS NOT NULL THEN
    SELECT nome INTO v_fnome FROM funcionarios WHERE id = p_funcionario_id AND empresa_id = v_emp;
  END IF;

  IF p_produto_id IS NOT NULL THEN
    SELECT nome, preco_venda, COALESCE(controla_estoque, true)
      INTO v_pnome, v_pvenda, v_ctrl
      FROM produtos WHERE id = p_produto_id AND empresa_id = v_emp;
    IF v_pnome IS NULL THEN RAISE EXCEPTION 'Produto não encontrado.'; END IF;
    IF v_desc = '' THEN v_desc := v_pnome; END IF;
    v_unit := COALESCE(p_valor_unitario, v_pvenda, 0);
    IF v_ctrl THEN
      INSERT INTO estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
      VALUES (p_produto_id, 'saida', v_qtd, 'consumo_funcionario',
              'Consumo funcionário' || CASE WHEN v_fnome IS NOT NULL THEN ' · ' || v_fnome ELSE '' END);
      v_baixou := true;
    END IF;
  ELSE
    IF v_desc = '' THEN RAISE EXCEPTION 'Descreva o item (ex.: Almoço).'; END IF;
    v_unit := COALESCE(p_valor_unitario, 0);
  END IF;

  INSERT INTO consumo_funcionario
    (empresa_id, funcionario_id, funcionario_nome, produto_id, descricao, quantidade, valor_unitario, valor_total, baixou_estoque, observacao)
  VALUES
    (v_emp, p_funcionario_id, v_fnome, p_produto_id, v_desc, v_qtd, v_unit, ROUND(v_unit * v_qtd, 2), v_baixou, NULLIF(btrim(COALESCE(p_observacao,'')), ''))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.registrar_consumo_funcionario(uuid, uuid, text, numeric, numeric, text) TO authenticated;

-- Excluir um consumo. Se deu baixa no estoque, ESTORNA (devolve a quantidade).
CREATE OR REPLACE FUNCTION public.excluir_consumo_funcionario(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp uuid := current_empresa_id();
  v_c   consumo_funcionario%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM consumo_funcionario WHERE id = p_id AND empresa_id = v_emp;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'Lançamento não encontrado.'; END IF;

  IF v_c.baixou_estoque AND v_c.produto_id IS NOT NULL THEN
    INSERT INTO estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
    VALUES (v_c.produto_id, 'entrada', v_c.quantidade, 'estorno_consumo_funcionario', 'Estorno consumo funcionário');
  END IF;

  DELETE FROM consumo_funcionario WHERE id = p_id AND empresa_id = v_emp;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.excluir_consumo_funcionario(uuid) TO authenticated;
