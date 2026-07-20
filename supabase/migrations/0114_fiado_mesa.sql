-- Fiado na mesa/balcão.
--
-- Antes: fechar_conta_presencial SEMPRE gravava a venda como 'a_vista' e SEMPRE
-- inseria um pagamento do valor cheio, trocando qualquer forma desconhecida por
-- 'dinheiro'. Um botão "Fiado" na tela cairia nesse ELSE e a mesa fecharia como
-- dinheiro recebido: a dívida sumia e o caixa inflava.
--
-- O saldo devedor sai da view clientes_saldo_fiado:
--   Σ vendas (forma_pagamento <> 'a_vista')  −  Σ pagamentos
-- Ou seja: fiado é venda registrada SEM linha em `pagamentos`. É isso que a função
-- passa a fazer quando a forma é 'fiado'.
--
-- Também ganha p_cliente_id: sem ele a dívida cairia no cliente genérico
-- "Consumidor (Mesa)", misturando todo mundo num saldo só, sem nome pra cobrar.
-- Continua opcional — mesa paga (sem fiado) segue usando o genérico, como hoje.

-- Dropa a versão de 3 args ANTES de criar a de 4. Sem isso as duas coexistiriam e
-- a chamada com 3 argumentos ficaria ambígua ("function is not unique"), derrubando
-- o fechamento de mesa. Compatibilidade fica por conta do DEFAULT: o PostgREST
-- chama por nome de parâmetro, então telas antigas (sem p_cliente_id) continuam
-- resolvendo pra esta função, com o cliente vindo NULL.
DROP FUNCTION IF EXISTS public.fechar_conta_presencial(uuid, jsonb, boolean);

CREATE OR REPLACE FUNCTION public.fechar_conta_presencial(
  p_comanda_id uuid,
  p_pagamentos jsonb,
  p_aplicar_taxa boolean DEFAULT true,
  p_cliente_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_fiado    numeric := 0;
  v_n        integer;
BEGIN
  SELECT * INTO v_com FROM comandas
  WHERE id = p_comanda_id AND empresa_id = v_emp AND status IN ('aberta','aguardando_conferencia');
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

  -- A soma continua tendo que bater com o total. O que muda é que a parte 'fiado'
  -- conta como "coberta" mesmo sem dinheiro entrar — permitindo o fiado parcial
  -- (paga R$ 10 em dinheiro e deixa R$ 12 no fiado).
  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_soma
  FROM jsonb_array_elements(p_pagamentos) x;
  IF ABS(v_soma - v_total) > 0.05 THEN
    RAISE EXCEPTION 'A soma dos pagamentos (R$ %) não confere com o total (R$ %).', v_soma, v_total;
  END IF;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_fiado
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'forma' = 'fiado';

  -- Fiado exige cliente de verdade: no genérico a dívida não teria dono.
  IF v_fiado > 0 AND p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Para fechar no fiado é preciso escolher o cliente.';
  END IF;

  SELECT nome INTO v_garcom FROM profiles WHERE id = v_com.garcom_id;
  v_obs := 'Presencial · Mesa ' || COALESCE(v_com.numero_mesa::text, '-')
           || CASE WHEN v_garcom IS NOT NULL THEN ' · Garçom: ' || v_garcom ELSE '' END;

  IF p_cliente_id IS NOT NULL THEN
    -- confere que o cliente é desta empresa (a função é SECURITY DEFINER)
    SELECT id INTO v_cliente FROM clientes WHERE id = p_cliente_id AND empresa_id = v_emp;
    IF v_cliente IS NULL THEN RAISE EXCEPTION 'Cliente não encontrado nesta empresa.'; END IF;
  ELSE
    SELECT id INTO v_cliente FROM clientes
    WHERE empresa_id = v_emp AND nome = 'Consumidor (Mesa)' LIMIT 1;
    IF v_cliente IS NULL THEN
      INSERT INTO clientes (empresa_id, nome) VALUES (v_emp, 'Consumidor (Mesa)')
      RETURNING id INTO v_cliente;
    END IF;
  END IF;

  -- Tem fiado → a venda sai como 'fiado' e entra no saldo devedor do cliente.
  INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes)
  VALUES (v_cliente,
          CASE WHEN v_fiado > 0 THEN 'fiado' ELSE 'a_vista' END,
          'entregue', v_total,
          v_obs || CASE WHEN v_fiado > 0 THEN ' · Fiado: R$ ' || TO_CHAR(v_fiado, 'FM999999990.00') ELSE '' END)
  RETURNING id INTO v_venda;

  FOR v_item IN
    SELECT * FROM comanda_itens WHERE comanda_id = p_comanda_id AND produto_id IS NOT NULL
  LOOP
    INSERT INTO venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (v_venda, v_item.produto_id::uuid, v_item.quantidade, v_item.preco_unitario,
            v_item.preco_unitario * v_item.quantidade);
    IF EXISTS (SELECT 1 FROM produtos WHERE id = v_item.produto_id::uuid AND COALESCE(controla_estoque, true) = true) THEN
      INSERT INTO estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
      VALUES (v_item.produto_id::uuid, 'saida', v_item.quantidade, 'venda', v_obs);
    END IF;
  END LOOP;

  FOR v_pag IN SELECT * FROM jsonb_array_elements(p_pagamentos)
  LOOP
    -- 'fiado' NÃO vira linha de pagamento: é exatamente a ausência dela que faz
    -- o saldo devedor aparecer em clientes_saldo_fiado. Quando o cliente pagar,
    -- o recebimento é lançado no Portal Fiado e abate o saldo.
    IF (v_pag->>'valor')::numeric > 0 AND (v_pag->>'forma') <> 'fiado' THEN
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
$function$;

-- O DROP acima levou junto as permissões da função antiga; devolve as mesmas
-- (era: authenticated + service_role).
--
-- O REVOKE vem primeiro e é obrigatório: função recém-criada nasce com EXECUTE
-- para PUBLIC (e portanto para o anon do Supabase). Sem isso, um anônimo poderia
-- chamar uma função SECURITY DEFINER que escreve em vendas/pagamentos/estoque.
-- Na prática ele não passaria do primeiro RAISE (current_empresa_id() é nulo sem
-- login), mas o certo é não expor a superfície.
REVOKE ALL ON FUNCTION public.fechar_conta_presencial(uuid, jsonb, boolean, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fechar_conta_presencial(uuid, jsonb, boolean, uuid)
  TO authenticated, service_role;
