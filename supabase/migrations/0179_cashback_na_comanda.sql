-- Gastar o crédito na mesa e no link do cliente (Fase 3).
--
-- Cobre os dois de uma vez porque são a mesma coisa por baixo: o pedido pelo
-- link do cliente vira comanda de balcão, e quem fecha as duas é o
-- `fechar_conta_presencial`.
--
-- O CRÉDITO É UMA FORMA DE PAGAMENTO, chamada `cashback`. Não é gambiarra: é o
-- mesmo tratamento que o fiado já tem — entra na venda, mas não é dinheiro que
-- caiu na gaveta. A diferença é o destino: fiado vira "a receber", cashback
-- vira despesa da loja.
--
-- POR QUE A VENDA CONTINUA CHEIA: conta de R$ 100 com R$ 10 de crédito gera
-- venda de R$ 100, não de R$ 90. O lucro dá igual dos dois jeitos, mas
-- registrando R$ 90 o custo do programa ficaria invisível e no fim do mês
-- ninguém saberia dizer se valeu a pena. Assim a loja vê o faturamento
-- verdadeiro de um lado e quanto o programa custou do outro.
--
-- O caixa se acerta sozinho: `cashback` é forma própria, então não soma em
-- dinheiro, PIX nem cartão — que é de onde sai o esperado da gaveta.

-- ── 1) O fechamento aceita cashback ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fechar_conta_presencial(p_comanda_id uuid, p_pagamentos jsonb, p_aplicar_taxa boolean DEFAULT true, p_cliente_id uuid DEFAULT NULL::uuid)
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
  v_dono     uuid;
  v_venda    uuid;
  v_vfiado   uuid;
  v_item     comanda_itens%ROWTYPE;
  v_garcom   text;
  v_obs      text;
  v_pag      jsonb;
  v_soma     numeric := 0;
  v_fiado    numeric := 0;
  v_cashback numeric := 0;    -- crédito da loja usado nesta conta
  v_saldo    numeric := 0;
  v_pago     numeric := 0;
  v_n        integer;
  v_sem      integer;
  v_dev      record;
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

  SELECT COUNT(*) INTO v_sem
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'valor' IS NULL OR BTRIM(x->>'valor') = '';

  IF v_sem > 1 THEN
    RAISE EXCEPTION 'Só uma linha do pagamento pode ficar sem valor (ela vira o resto da conta).';
  END IF;

  IF v_sem = 1 THEN
    SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_soma
    FROM jsonb_array_elements(p_pagamentos) x
    WHERE x->>'valor' IS NOT NULL AND BTRIM(x->>'valor') <> '';

    SELECT jsonb_agg(
             CASE WHEN x->>'valor' IS NULL OR BTRIM(x->>'valor') = ''
                  THEN x || jsonb_build_object('valor', ROUND(v_total - v_soma, 2))
                  ELSE x END)
    INTO p_pagamentos
    FROM jsonb_array_elements(p_pagamentos) x;
  END IF;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_soma
  FROM jsonb_array_elements(p_pagamentos) x;
  IF ABS(v_soma - v_total) > 0.05 THEN
    RAISE EXCEPTION 'A conta mudou depois que ela foi fechada: o pagamento lançado soma R$ % e a conta agora está R$ %. Abra a mesa e feche de novo com o valor certo.',
      TO_CHAR(v_soma, 'FM999999990.00'), TO_CHAR(v_total, 'FM999999990.00');
  END IF;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_fiado
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'forma' = 'fiado';

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_cashback
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'forma' = 'cashback';

  v_dono := COALESCE(p_cliente_id, v_com.cliente_id);

  -- ── Travas do crédito ────────────────────────────────────────────────
  IF v_cashback > 0 THEN
    -- Crédito é de alguém. Sem cliente na conta não há de quem descontar, e o
    -- valor sumiria do caixa sem dono — a loja pagaria sem saber pra quem.
    IF v_dono IS NULL THEN
      RAISE EXCEPTION 'Para usar o crédito é preciso ligar o cliente à comanda.';
    END IF;

    -- O saldo é conferido AQUI, não na tela: a tela é do garçom e pode estar
    -- desatualizada, e o mesmo cliente pode ter gasto noutra mesa no meio.
    v_saldo := fidelidade_saldo_de(v_emp, v_dono);
    IF v_cashback > v_saldo + 0.005 THEN
      RAISE EXCEPTION 'Crédito insuficiente: o cliente tem R$ % e a conta usou R$ %.',
        TO_CHAR(v_saldo, 'FM999999990.00'), TO_CHAR(v_cashback, 'FM999999990.00');
    END IF;

    -- Nunca cobre a conta inteira: a loja precisa receber alguma coisa, e conta
    -- fechada sem nenhum dinheiro confunde o caixa e o fechamento do dia.
    IF v_cashback >= v_total - 0.005 THEN
      RAISE EXCEPTION 'O crédito não pode cobrir a conta inteira.';
    END IF;
  END IF;

  -- Parte "recebida" = total − fiado. O cashback FICA aqui de propósito: é ele
  -- que mantém a venda cheia (R$ 100 e não R$ 90) e o custo visível à parte.
  v_pago := ROUND(v_total - v_fiado, 2);
  IF v_pago < 0 THEN v_pago := 0; END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_pagamentos) x
    WHERE x->>'forma' = 'fiado'
      AND (x->>'valor')::numeric > 0
      AND COALESCE(NULLIF(x->>'cliente_id','')::uuid, v_dono) IS NULL
  ) THEN
    RAISE EXCEPTION 'Para fechar no fiado é preciso escolher o cliente.';
  END IF;

  SELECT nome INTO v_garcom FROM profiles WHERE id = v_com.garcom_id;
  v_obs := 'Presencial · ' || rotulo_comanda(v_com)
           || CASE WHEN v_garcom IS NOT NULL THEN ' · Garçom: ' || v_garcom ELSE '' END;

  IF v_dono IS NOT NULL THEN
    SELECT id INTO v_cliente FROM clientes WHERE id = v_dono AND empresa_id = v_emp;
    IF v_cliente IS NULL THEN RAISE EXCEPTION 'Cliente não encontrado nesta empresa.'; END IF;
  ELSE
    SELECT id INTO v_cliente FROM clientes
    WHERE empresa_id = v_emp AND nome = 'Consumidor (Mesa)' LIMIT 1;
    IF v_cliente IS NULL THEN
      INSERT INTO clientes (empresa_id, nome) VALUES (v_emp, 'Consumidor (Mesa)')
      RETURNING id INTO v_cliente;
    END IF;
  END IF;

  IF v_pago > 0.005 THEN
    INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes, comanda_id)
    VALUES (v_cliente, 'a_vista', 'entregue', v_pago,
            v_obs || CASE WHEN v_fiado > 0 THEN ' · parte recebida' ELSE '' END,
            p_comanda_id)
    RETURNING id INTO v_venda;
  END IF;

  FOR v_dev IN
    SELECT COALESCE(NULLIF(x->>'cliente_id','')::uuid, v_dono) AS cliente_id,
           ROUND(SUM((x->>'valor')::numeric), 2)               AS valor
    FROM jsonb_array_elements(p_pagamentos) x
    WHERE x->>'forma' = 'fiado' AND (x->>'valor')::numeric > 0
    GROUP BY 1
  LOOP
    PERFORM 1 FROM clientes WHERE id = v_dev.cliente_id AND empresa_id = v_emp;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cliente do fiado não encontrado nesta empresa.'; END IF;

    INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes, comanda_id)
    VALUES (v_dev.cliente_id, 'fiado', 'entregue', v_dev.valor,
            v_obs || ' · Fiado: R$ ' || TO_CHAR(v_dev.valor, 'FM999999990.00'),
            p_comanda_id)
    RETURNING id INTO v_vfiado;

    IF v_venda IS NULL THEN v_venda := v_vfiado; END IF;
  END LOOP;

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
    -- 'fiado' NÃO vira linha de pagamento: é a ausência dela que faz o saldo devedor
    -- aparecer em clientes_saldo_fiado. Quando o cliente pagar, o recebimento é
    -- lançado no Portal Fiado e abate o saldo.
    IF (v_pag->>'valor')::numeric > 0 AND (v_pag->>'forma') <> 'fiado' THEN
      INSERT INTO pagamentos (venda_id, cliente_id, forma_pagamento, valor, observacao)
      VALUES (v_venda, v_cliente,
              -- 'cashback' entrou na lista: sem isso ele cairia no ELSE e seria
              -- gravado como DINHEIRO, inflando o esperado da gaveta todo dia.
              CASE WHEN (v_pag->>'forma') IN ('dinheiro','pix','cartao','credito','debito','transferencia','cashback')
                   THEN v_pag->>'forma' ELSE 'dinheiro' END,
              (v_pag->>'valor')::numeric, v_obs);
    END IF;
  END LOOP;

  -- Baixa no saldo do cliente. Depois das vendas pra o extrato dele apontar pra
  -- venda certa — é por aí que a loja confere de onde saiu o desconto.
  IF v_cashback > 0 THEN
    PERFORM fidelidade_debitar(v_emp, v_dono, v_cashback,
              'Desconto na ' || rotulo_comanda(v_com), v_venda, NULL);
  END IF;

  v_n := jsonb_array_length(p_pagamentos);
  UPDATE comandas SET status = 'fechada', subtotal = v_subtotal, taxa_servico = v_taxa,
         total = v_total,
         forma_pagamento = CASE WHEN v_n > 1 THEN 'dividido' ELSE p_pagamentos->0->>'forma' END,
         fechada_at = now(),
         venda_id = v_venda,
         cliente_id = COALESCE(p_cliente_id, v_com.cliente_id)
  WHERE id = p_comanda_id;

  IF v_com.mesa_id IS NOT NULL THEN
    UPDATE mesas SET status = 'livre' WHERE id = v_com.mesa_id;
  END IF;

  RETURN v_venda;
END;
$function$;

-- ── 2) O caixa passa a enxergar o cashback ───────────────────────────────────
-- Só acrescenta a coluna no fim; o resto da view é igual à 0173. Ela NÃO entra
-- em `recebimentos_cartao` nem em dinheiro/PIX de propósito: é isso que mantém
-- o esperado da gaveta certo sem tocar em nenhuma conta existente.
CREATE OR REPLACE VIEW public.caixa_resumo AS
 SELECT c.id AS caixa_id,
    COALESCE(ve.vendas_a_vista, 0::numeric) AS vendas_a_vista,
    COALESCE(ve.vendas_fiado, 0::numeric) AS vendas_fiado,
    COALESCE(ve.vendas_boleto, 0::numeric) AS vendas_boleto,
    COALESCE(pg.recebimentos_dinheiro, 0::numeric) AS recebimentos_dinheiro,
    COALESCE(pg.recebimentos_pix, 0::numeric) AS recebimentos_pix,
    COALESCE(pg.recebimentos_transferencia, 0::numeric) AS recebimentos_transferencia,
    COALESCE(pg.recebimentos_cartao, 0::numeric) AS recebimentos_cartao,
    COALESCE(mv.total_sangrias, 0::numeric) AS total_sangrias,
    COALESCE(mv.total_suprimentos, 0::numeric) AS total_suprimentos,
    COALESCE(mv.total_sangrias_dinheiro, 0::numeric) AS total_sangrias_dinheiro,
    COALESCE(mv.total_sangrias_pix, 0::numeric) AS total_sangrias_pix,
    COALESCE(mv.total_suprimentos_dinheiro, 0::numeric) AS total_suprimentos_dinheiro,
    COALESCE(mv.total_suprimentos_pix, 0::numeric) AS total_suprimentos_pix,
    COALESCE(pg.recebimentos_fiado, 0::numeric) AS recebimentos_fiado,
    COALESCE(pg.recebimentos_fiado_dinheiro, 0::numeric) AS recebimentos_fiado_dinheiro,
    COALESCE(pg.recebimentos_fiado_pix, 0::numeric) AS recebimentos_fiado_pix,
    COALESCE(pg.recebimentos_fiado_cartao, 0::numeric) AS recebimentos_fiado_cartao,
    COALESCE(pg.recebimentos_fiado_transferencia, 0::numeric) AS recebimentos_fiado_transferencia,
    COALESCE(pg.recebimentos_credito, 0::numeric) AS recebimentos_credito,
    COALESCE(pg.recebimentos_debito, 0::numeric) AS recebimentos_debito,
    COALESCE(pg.recebimentos_cartao_generico, 0::numeric) AS recebimentos_cartao_generico,
    COALESCE(pg.recebimentos_fiado_credito, 0::numeric) AS recebimentos_fiado_credito,
    COALESCE(pg.recebimentos_fiado_debito, 0::numeric) AS recebimentos_fiado_debito,
    COALESCE(mv.total_sangrias_cartao, 0::numeric) AS total_sangrias_cartao,
    COALESCE(mv.total_suprimentos_cartao, 0::numeric) AS total_suprimentos_cartao,
    COALESCE(pg.recebimentos_cashback, 0::numeric) AS recebimentos_cashback
   FROM caixas c
     LEFT JOIN LATERAL ( SELECT sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'a_vista'::text AND vendas.status <> 'cancelado'::text) AS vendas_a_vista,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'fiado'::text AND vendas.status <> 'cancelado'::text) AS vendas_fiado,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento ~~ 'boleto%'::text AND vendas.status <> 'cancelado'::text) AS vendas_boleto
           FROM vendas
          WHERE vendas.caixa_id = c.id) ve ON true
     LEFT JOIN LATERAL ( SELECT sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_pix,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_transferencia,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text])) AS recebimentos_cartao,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_credito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_debito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cartao'::text) AS recebimentos_cartao_generico,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cashback'::text) AS recebimentos_cashback,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text) AS recebimentos_fiado,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_fiado_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_fiado_pix,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND (pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text]))) AS recebimentos_fiado_cartao,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_fiado_credito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_fiado_debito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_fiado_transferencia
           FROM pagamentos
          WHERE pagamentos.caixa_id = c.id) pg ON true
     LEFT JOIN LATERAL ( SELECT sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text) AS total_sangrias,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text) AS total_suprimentos,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_sangrias_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'pix'::text) AS total_sangrias_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_sangrias_cartao,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_suprimentos_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'pix'::text) AS total_suprimentos_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_suprimentos_cartao
           FROM caixa_movimentos
          WHERE caixa_movimentos.caixa_id = c.id) mv ON true
  WHERE c.empresa_id = current_empresa_id();

-- ── 3) Saldo do cliente pra tela do garçom ───────────────────────────────────
-- O `fidelidade_saldo` da 0174 serve, mas esta devolve junto se o programa está
-- ligado — assim a comanda faz uma chamada só e não precisa saber das regras.
CREATE OR REPLACE FUNCTION public.cashback_do_cliente(p_cliente_id uuid)
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_emp uuid := current_empresa_id();
  v_cfg fidelidade_config%ROWTYPE;
BEGIN
  IF p_cliente_id IS NULL THEN RETURN json_build_object('ativo', false, 'saldo', 0); END IF;
  SELECT * INTO v_cfg FROM fidelidade_config WHERE empresa_id = v_emp;
  IF v_cfg.empresa_id IS NULL OR NOT v_cfg.ativo THEN
    RETURN json_build_object('ativo', false, 'saldo', 0);
  END IF;
  RETURN json_build_object('ativo', true, 'saldo', fidelidade_saldo_de(v_emp, p_cliente_id));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cashback_do_cliente(uuid) TO authenticated;
