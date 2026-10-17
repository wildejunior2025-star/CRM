-- =========================================================
-- 0332: consumo de funcionário também dá baixa na MATÉRIA-PRIMA
-- =========================================================
-- O funcionário que come um hambúrguer da casa é uma saída "legítima" (como venda),
-- mas só descontava o estoque do PRODUTO (e só se ele controla estoque). Com a ficha
-- técnica ligada (mig 0330), o lanche também tem que tirar o hambúrguer do saldo.
-- Excluir o lançamento devolve o que saiu. O movimento leva o nome de quem consumiu
-- e o id do lançamento no fim da observação (é por ele que o estorno acha o que devolver).
-- =========================================================

CREATE OR REPLACE FUNCTION public.registrar_consumo_funcionario(
  p_funcionario_id uuid,
  p_produto_id uuid,
  p_descricao text,
  p_quantidade numeric,
  p_valor_unitario numeric,
  p_observacao text DEFAULT NULL::text,
  p_funcionario_nome text DEFAULT NULL::text)
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
  v_mp     record;
BEGIN
  IF v_qtd <= 0 THEN RAISE EXCEPTION 'Quantidade inválida.'; END IF;

  -- Nome de quem consumiu: do funcionário cadastrado; senão o nome que veio (usuário/adm).
  IF p_funcionario_id IS NOT NULL THEN
    SELECT nome INTO v_fnome FROM funcionarios WHERE id = p_funcionario_id AND empresa_id = v_emp;
  END IF;
  IF v_fnome IS NULL THEN v_fnome := NULLIF(btrim(COALESCE(p_funcionario_nome, '')), ''); END IF;

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

  -- Matérias-primas da ficha (hambúrguer etc.): só quem tem a baixa ligada na ficha.
  IF p_produto_id IS NOT NULL THEN
    FOR v_mp IN SELECT * FROM mp_consumo_do_produto(p_produto_id, v_qtd, now()) LOOP
      INSERT INTO materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, created_by)
      VALUES (v_emp, v_mp.materia_prima_id, 'saida', v_mp.quantidade,
              'Consumo funcionário' || COALESCE(' · ' || v_fnome, '') || ' · ' || v_id::text,
              auth.uid());
    END LOOP;
  END IF;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.excluir_consumo_funcionario(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_emp uuid := current_empresa_id();
  v_c   consumo_funcionario%ROWTYPE;
  v_mp  record;
BEGIN
  SELECT * INTO v_c FROM consumo_funcionario WHERE id = p_id AND empresa_id = v_emp;
  IF v_c.id IS NULL THEN RAISE EXCEPTION 'Lançamento não encontrado.'; END IF;

  IF v_c.baixou_estoque AND v_c.produto_id IS NOT NULL THEN
    INSERT INTO estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
    VALUES (v_c.produto_id, 'entrada', v_c.quantidade, 'estorno_consumo_funcionario', 'Estorno consumo funcionário');
  END IF;

  -- Devolve o insumo que o lançamento tirou (saída − o que já foi devolvido).
  FOR v_mp IN
    SELECT m.materia_prima_id,
           SUM(CASE WHEN m.tipo = 'saida' THEN m.quantidade WHEN m.tipo = 'ajuste' THEN -m.quantidade ELSE 0 END) AS qtd
      FROM materia_prima_movimentos m
     WHERE m.empresa_id = v_emp AND m.observacao LIKE '%' || p_id::text
     GROUP BY m.materia_prima_id
  LOOP
    CONTINUE WHEN v_mp.qtd IS NULL OR v_mp.qtd <= 0;
    INSERT INTO materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, created_by)
    VALUES (v_emp, v_mp.materia_prima_id, 'ajuste', v_mp.qtd,
            'Estorno consumo funcionário · ' || p_id::text, auth.uid());
  END LOOP;

  DELETE FROM consumo_funcionario WHERE id = p_id AND empresa_id = v_emp;
END;
$function$;
