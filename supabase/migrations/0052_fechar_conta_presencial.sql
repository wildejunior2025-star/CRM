-- =========================================================
-- 0052: Fechar conta presencial → baixa de estoque + caixa
-- =========================================================
-- Ao fechar a comanda no Salão, esta RPC (SECURITY DEFINER) faz tudo
-- atômico, reaproveitando o fluxo do CRM:
--   • cria uma VENDA à vista (entra em vendas_a_vista do caixa)
--   • cria os VENDA_ITENS e dá baixa no estoque (estoque_movimentos 'saida')
--   • registra o PAGAMENTO na forma escolhida (recebimentos do caixa)
--   • fecha a comanda e libera a mesa
-- empresa_id e caixa_id são preenchidos pelos defaults current_empresa_id()
-- / current_caixa_id(). Sem caixa aberto, a venda é registrada sem caixa.
-- As tabelas financeiras exigem cliente_id, então usamos um cliente
-- genérico "Consumidor (Mesa)" criado uma vez por empresa.
-- =========================================================

CREATE OR REPLACE FUNCTION public.fechar_conta_presencial(
  p_comanda_id uuid,
  p_forma text,
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
  v_forma_pg text;
  v_garcom   text;
  v_obs      text;
BEGIN
  SELECT * INTO v_com FROM comandas
  WHERE id = p_comanda_id AND empresa_id = v_emp AND status = 'aberta';
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Comanda não encontrada ou já fechada.'; END IF;

  SELECT COALESCE(taxa_servico_pct, 10) INTO v_taxa_pct FROM empresas WHERE id = v_emp;

  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_subtotal
  FROM comanda_itens WHERE comanda_id = p_comanda_id;
  IF v_subtotal <= 0 THEN RAISE EXCEPTION 'Comanda sem itens.'; END IF;

  v_taxa  := CASE WHEN p_aplicar_taxa THEN ROUND(v_subtotal * v_taxa_pct / 100.0, 2) ELSE 0 END;
  v_total := v_subtotal + v_taxa;

  -- Garçom que atendeu a mesa (rastreabilidade na venda/estoque/recebimento)
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

  v_forma_pg := CASE WHEN p_forma IN ('dinheiro','pix','cartao','transferencia') THEN p_forma ELSE 'dinheiro' END;
  INSERT INTO pagamentos (cliente_id, forma_pagamento, valor, observacao)
  VALUES (v_cliente, v_forma_pg, v_total, v_obs);

  UPDATE comandas SET status = 'fechada', subtotal = v_subtotal, taxa_servico = v_taxa,
         total = v_total, forma_pagamento = p_forma, fechada_at = now()
  WHERE id = p_comanda_id;

  IF v_com.mesa_id IS NOT NULL THEN
    UPDATE mesas SET status = 'livre' WHERE id = v_com.mesa_id;
  END IF;

  RETURN v_venda;
END;
$$;

REVOKE EXECUTE ON FUNCTION fechar_conta_presencial(uuid,text,boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION fechar_conta_presencial(uuid,text,boolean) TO authenticated;
