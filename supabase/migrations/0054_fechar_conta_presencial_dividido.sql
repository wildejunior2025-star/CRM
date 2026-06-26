-- =========================================================
-- 0054: Fechar conta presencial com MÚLTIPLOS pagamentos (dividir)
-- =========================================================
-- Substitui a assinatura (uuid,text,boolean) por (uuid,jsonb,boolean).
-- p_pagamentos é uma lista [{ "forma": "pix", "valor": 17.58 }, ...].
-- A soma dos pagamentos precisa bater com o total (tolerância de 5 centavos).
-- Gera 1 venda + 1 pagamento por forma → o Caixa mostra cada recebimento
-- na forma certa (ex.: parte PIX, parte dinheiro). comanda.forma_pagamento
-- vira 'dividido' quando há mais de um pagamento.
-- =========================================================

DROP FUNCTION IF EXISTS public.fechar_conta_presencial(uuid, text, boolean);

CREATE OR REPLACE FUNCTION public.fechar_conta_presencial(
  p_comanda_id  uuid,
  p_pagamentos  jsonb,
  p_aplicar_taxa boolean DEFAULT true
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp      uuid := current_empresa_id();
  v_com      comandas%ROWTYPE;
  v_taxa_pct numeric;
  v_subtotal numeric := 0;
  v_taxa     numeric := 0;
  v_total    numeric := 0;
  v_cliente  uuid;
  v_venda    uuid;
  v_item     comanda_itens%ROWTYPE;
  v_garcom   text;
  v_obs      text;
  v_pag      jsonb;
  v_soma     numeric := 0;
  v_n        integer;
BEGIN
  SELECT * INTO v_com FROM comandas
  WHERE id = p_comanda_id AND empresa_id = v_emp AND status = 'aberta';
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Comanda não encontrada ou já fechada.'; END IF;

  IF p_pagamentos IS NULL OR jsonb_array_length(p_pagamentos) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma forma de pagamento.';
  END IF;

  SELECT COALESCE(taxa_servico_pct, 10) INTO v_taxa_pct FROM empresas WHERE id = v_emp;

  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_subtotal
  FROM comanda_itens WHERE comanda_id = p_comanda_id;
  IF v_subtotal <= 0 THEN RAISE EXCEPTION 'Comanda sem itens.'; END IF;

  v_taxa  := CASE WHEN p_aplicar_taxa THEN ROUND(v_subtotal * v_taxa_pct / 100.0, 2) ELSE 0 END;
  v_total := v_subtotal + v_taxa;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_soma
  FROM jsonb_array_elements(p_pagamentos) x;
  IF ABS(v_soma - v_total) > 0.05 THEN
    RAISE EXCEPTION 'A soma dos pagamentos (R$ %) não confere com o total (R$ %).', v_soma, v_total;
  END IF;

  SELECT nome INTO v_garcom FROM profiles WHERE id = v_com.garcom_id;
  v_obs := 'Presencial · Mesa ' || COALESCE(v_com.numero_mesa::text, '-')
           || CASE WHEN v_garcom IS NOT NULL THEN ' · Garçom: ' || v_garcom ELSE '' END;

  SELECT id INTO v_cliente FROM clientes
  WHERE empresa_id = v_emp AND nome = 'Consumidor (Mesa)' LIMIT 1;
  IF v_cliente IS NULL THEN
    INSERT INTO clientes (empresa_id, nome) VALUES (v_emp, 'Consumidor (Mesa)')
    RETURNING id INTO v_cliente;
  END IF;

  INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes)
  VALUES (v_cliente, 'a_vista', 'entregue', v_total, v_obs)
  RETURNING id INTO v_venda;

  FOR v_item IN
    SELECT * FROM comanda_itens WHERE comanda_id = p_comanda_id AND produto_id IS NOT NULL
  LOOP
    INSERT INTO venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (v_venda, v_item.produto_id::uuid, v_item.quantidade, v_item.preco_unitario,
            v_item.preco_unitario * v_item.quantidade);
    INSERT INTO estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
    VALUES (v_item.produto_id::uuid, 'saida', v_item.quantidade, 'venda', v_obs);
  END LOOP;

  FOR v_pag IN SELECT * FROM jsonb_array_elements(p_pagamentos)
  LOOP
    IF (v_pag->>'valor')::numeric > 0 THEN
      INSERT INTO pagamentos (cliente_id, forma_pagamento, valor, observacao)
      VALUES (v_cliente,
              CASE WHEN (v_pag->>'forma') IN ('dinheiro','pix','cartao','transferencia')
                   THEN v_pag->>'forma' ELSE 'dinheiro' END,
              (v_pag->>'valor')::numeric, v_obs);
    END IF;
  END LOOP;

  v_n := jsonb_array_length(p_pagamentos);
  UPDATE comandas SET status = 'fechada', subtotal = v_subtotal, taxa_servico = v_taxa,
         total = v_total,
         forma_pagamento = CASE WHEN v_n > 1 THEN 'dividido' ELSE p_pagamentos->0->>'forma' END,
         fechada_at = now()
  WHERE id = p_comanda_id;

  IF v_com.mesa_id IS NOT NULL THEN
    UPDATE mesas SET status = 'livre' WHERE id = v_com.mesa_id;
  END IF;

  RETURN v_venda;
END;
$$;

REVOKE EXECUTE ON FUNCTION fechar_conta_presencial(uuid,jsonb,boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION fechar_conta_presencial(uuid,jsonb,boolean) TO authenticated;
