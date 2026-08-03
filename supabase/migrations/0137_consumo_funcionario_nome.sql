-- 0137_consumo_funcionario_nome.sql
-- O consumo agora aceita QUALQUER pessoa da loja (funcionário cadastrado OU usuário
-- do sistema — admin, o próprio dono etc.). Quem não está na tabela funcionarios
-- entra só pelo NOME (funcionario_id fica nulo, funcionario_nome guarda o nome).

DROP FUNCTION IF EXISTS public.registrar_consumo_funcionario(uuid, uuid, text, numeric, numeric, text);
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

  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.registrar_consumo_funcionario(uuid, uuid, text, numeric, numeric, text, text) TO authenticated;
